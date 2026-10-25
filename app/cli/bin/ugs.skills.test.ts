// @vitest-environment node
import { build } from 'esbuild';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let dir: string;
let binary: string;
let childEnv: NodeJS.ProcessEnv;
const exec = promisify(execFile);
const servers: Server[] = [];
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ugs-skills-bin-'));
  const home = join(dir, 'isolated-home'); await mkdir(home, { recursive: true });
  childEnv = {};
  for (const name of ['PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'ComSpec', 'COMSPEC', 'SYSTEMDRIVE', 'SystemDrive', 'TMP', 'TEMP', 'TMPDIR']) {
    if (process.env[name] !== undefined) childEnv[name] = process.env[name];
  }
  Object.assign(childEnv, { HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
    UGS_HOME: join(home, '.ultragamestudio'), CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'), NODE_OPTIONS: '--no-experimental-webstorage' });
  binary = join(dir, 'ugs.mjs');
  await build({ entryPoints: [resolve('cli/bin/ugs.ts')], outfile: binary, bundle: true, platform: 'node', format: 'esm', target: 'node20',
    packages: 'bundle', alias: { '@': resolve('src') }, banner: { js: "import { createRequire as createUgsRequire } from 'node:module'; const require = createUgsRequire(import.meta.url);" }, logLevel: 'silent' });
});
afterAll(async () => {
  for (const server of servers) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('bundled ugs skills dispatcher', () => {
  it('exposes Node skills list even with studio disabled and no node_modules beside the installed binary', async () => {
    const cwd = join(dir, 'workspace');
    const packageDir = join(cwd, '.ultragamestudio', 'skills', 'verify-work');
    await mkdir(packageDir, { recursive: true });
    await writeFile(join(packageDir, 'SKILL.md'), '---\nname: verify-work\ndescription: Use when verifying work.\n---\nActual full rule.\n');
    const { stdout } = await exec(process.execPath, [binary, '--json', 'skills', 'list', '--cwd', cwd], { cwd: dir, env: childEnv });
    const { stdout: help } = await exec(process.execPath, [binary, '--help'], { cwd: dir, env: childEnv });
    expect(help).toMatch(/^\s+skills(?:\s|\[)/m);
    expect(help).not.toMatch(/^\s+studio\s/m);
    expect(help).toContain('/studio');
    const result = JSON.parse(stdout);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].name).toBe('verify-work');
  });

  it('reviews a user lesson via explicit HTTP flags and reads the managed file from a new process', async () => {
    const cwd = join(dir, 'workspace-learn-http'); await mkdir(cwd, { recursive: true });
    const content = '---\nname: verify-outcomes\ndescription: Use when checking outcomes.\n---\nCheck real test results because a process ending does not prove success.\n';
    const payloads: Record<string, unknown>[] = [];
    const server = createServer((req, res) => {
      let body = ''; req.setEncoding('utf8'); req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const payload = JSON.parse(body); payloads.push(payload);
        const snapshot = JSON.parse(payload.messages[1].content);
        res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ version: 1, kind: 'propose',
          lesson: 'Check real test results because process termination is not a success verdict.',
          evidenceIds: snapshot.evidence.map((item: { evidenceId: string }) => item.evidenceId),
          operations: [{ action: 'create', name: 'verify-outcomes', content }] }) } }],
          usage: { prompt_tokens: 40, completion_tokens: 40 } }));
      });
    });
    servers.push(server); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('server');
    const { stdout } = await exec(process.execPath, [binary, '--json', 'learn', 'Check actual outcomes.', '--cwd', cwd,
      '--review-url', `http://127.0.0.1:${address.port}`, '--review-model', 'review-only', '--review-transport', 'openai-compatible'], { cwd: dir, env: childEnv });
    const reviewed = JSON.parse(stdout);
    expect(reviewed).toMatchObject({ status: 'reviewed', result: { status: 'awaiting_approval', operationsApplied: 0 } });
    expect(payloads).toHaveLength(1); expect(payloads[0]).not.toHaveProperty('tools');
    const file = join(cwd, '.ultragamestudio', 'skills', 'verify-outcomes', 'SKILL.md');
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    // @ts-expect-error Node-only backend module has no declaration file.
    const { createWorkspaceSkillService } = await import('../../../backend/src/workspace-skill-service.mjs');
    const origin = reviewed.result.origin;
    const service = createWorkspaceSkillService({ dir: cwd, hostId: origin.hostId, workspaceId: origin.workspaceId });
    expect(await service.request({ action: 'approve', origin, batchId: reviewed.result.batchId }))
      .toMatchObject({ status: 'applied', operationsApplied: 1 });
    expect(await readFile(file, 'utf8')).toBe(content);
    const listed = await exec(process.execPath, [binary, '--json', 'skills', 'list', '--cwd', cwd], { cwd: dir, env: childEnv });
    const catalog = JSON.parse(listed.stdout); expect(catalog.entries).toHaveLength(1);
    const viewed = await exec(process.execPath, [binary, '--json', 'skills', 'view', catalog.entries[0].skillId, '--cwd', cwd], { cwd: dir, env: childEnv });
    expect(JSON.parse(viewed.stdout)).toMatchObject({ content, fullRead: true,
      hash: createHash('sha256').update(await readFile(file)).digest('hex') });
    // Disk fsync/CAS and three fresh Windows processes exceed a unit-test budget.
    // This bounds only the integration harness; review HTTP deadlines stay intact.
  }, 20000);

  it('dispatches a persisted reviewer provider selection over Anthropic HTTP without accepting source CLI fallback', async () => {
    const cwd = join(dir, 'workspace-configured-review'); await mkdir(join(cwd, '.ugs'), { recursive: true });
    const content = '---\nname: independent-review\ndescription: Use when isolating background review.\n---\nDo not inherit ordinary coding-agent authority for review.\n';
    const payloads: Record<string, unknown>[] = [];
    const paths: string[] = [];
    const server = createServer((req, res) => {
      let body = ''; req.setEncoding('utf8'); req.on('data', (chunk) => { body += chunk; }); req.on('end', () => {
        paths.push(req.url ?? ''); const payload = JSON.parse(body); payloads.push(payload); const snapshot = JSON.parse(payload.messages[0].content);
        res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ version: 1, kind: 'propose', lesson: 'Do not inherit coding authority for review.',
          evidenceIds: snapshot.evidence.map((item: { evidenceId: string }) => item.evidenceId), operations: [{ action: 'create', name: 'independent-review', content }] }) }],
          stop_reason: 'end_turn', usage: { input_tokens: 40, output_tokens: 40 } }));
      });
    });
    servers.push(server); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('server');
    const configFile = join(cwd, '.ugs', 'config.json');
    await writeFile(configFile, JSON.stringify({ providers: { 'fixture-review': { transport: 'cli', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'source-default' } },
      skillLearning: { reviewSelection: { adapter: 'codex', providerId: 'fixture-review', modelClass: 'review-configured' }, reviewTransport: 'openai-compatible' } }));
    const before = await readFile(configFile);
    const argv = [binary, '--json', 'learn', 'Use independent completion-only review.', '--cwd', cwd,
      '--review-provider', 'fixture-review', '--review-model', 'review-exact', '--review-transport', 'anthropic'];
    let execution: { stdout: string; stderr: string };
    try { execution = await exec(process.execPath, argv, { cwd: dir, env: childEnv }); }
    catch (error) { execution = error as typeof execution; }
    expect(execution.stderr).not.toContain('unknown option');
    const reviewed = JSON.parse(execution.stdout);
    expect(reviewed).toMatchObject({ status: 'reviewed', result: { status: 'awaiting_approval', operationsApplied: 0 } });
    expect(paths).toEqual(['/v1/messages']); expect(payloads).toHaveLength(1); expect(payloads[0]).toMatchObject({ model: 'review-exact', stream: false });
    expect(Object.keys(payloads[0]).sort()).toEqual(['max_tokens', 'messages', 'model', 'stream', 'system']);
    const file = join(cwd, '.ultragamestudio', 'skills', 'independent-review', 'SKILL.md');
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    // @ts-expect-error Node-only backend module has no declaration file.
    const { createWorkspaceSkillService } = await import('../../../backend/src/workspace-skill-service.mjs');
    const origin = reviewed.result.origin;
    const service = createWorkspaceSkillService({ dir: cwd, hostId: origin.hostId, workspaceId: origin.workspaceId });
    expect(await service.request({ action: 'approve', origin, batchId: reviewed.result.batchId }))
      .toMatchObject({ status: 'applied', operationsApplied: 1 });
    expect(await readFile(file, 'utf8')).toBe(content);
    const listed = JSON.parse((await exec(process.execPath, [binary, '--json', 'skills', 'list', '--cwd', cwd], { cwd: dir, env: childEnv })).stdout);
    const fresh = JSON.parse((await exec(process.execPath, [binary, '--json', 'skills', 'view', listed.entries[0].skillId, '--cwd', cwd], { cwd: dir, env: childEnv })).stdout);
    expect(fresh).toMatchObject({ content, fullRead: true, hash: createHash('sha256').update(await readFile(file)).digest('hex') });
    expect(await readFile(configFile)).toEqual(before);
  }, 20000);

  it('dispatches studio reviewer flags through a fresh feature-enabled binary while ordinary coding remains a real CLI subprocess', async () => {
    const cwd = join(dir, 'workspace-studio-review'); await mkdir(join(cwd, '.ugs'), { recursive: true });
    const studioBinary = join(dir, 'ugs-studio.mjs');
    // Only this isolated test bundle enables the dormant product surface.
    await build({ entryPoints: [resolve('cli/bin/ugs.ts')], outfile: studioBinary, bundle: true, platform: 'node', format: 'esm', target: 'node20',
      packages: 'bundle', alias: { '@': resolve('src') }, banner: { js: "import { createRequire as createUgsRequire } from 'node:module'; const require = createUgsRequire(import.meta.url);" }, logLevel: 'silent',
      plugins: [{ name: 'fixture-enable-studio', setup(builder) {
        builder.onLoad({ filter: /[\\/]featureFlags\.ts$/ }, async (args) => ({
          contents: (await readFile(args.path, 'utf8')).replace('export const STUDIO_ENABLED = false;', 'export const STUDIO_ENABLED = true;'), loader: 'ts',
        }));
      } }] });
    const fixture = join(cwd, 'foreground.cjs');
    const spawnsFile = join(cwd, 'foreground-spawns.jsonl');
    await writeFile(fixture, `const fs=require('node:fs');const args=process.argv.slice(2);
if(args.includes('--help')){process.stdout.write('ordinary fixture without MCP attachment');process.exit(0);}
let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{prompt+=chunk;});process.stdin.on('end',()=>{
fs.appendFileSync(${JSON.stringify(spawnsFile)},JSON.stringify({args,prompt})+'\\n');
const result=prompt.includes('DYNAMIC_VERDICT')?JSON.stringify({pass:true,acceptedArtifact:'ordinary fixture answer',evidence:['fixture'],criteriaCoverage:[{criterion:'answer provided',met:true,evidence:'fixture'}],gaps:[]}):
prompt.includes('DYNAMIC_TASK_LEDGER')?JSON.stringify({tasks:[{id:'t1',title:'Inspect',owner:'worker',input:'task',deliverable:'answer',acceptance:'answer provided',evidenceRequired:'answer',status:'accepted',artifact:'answer',gaps:[]}]}):
prompt.includes('DYNAMIC_WORKER_RESULT')?JSON.stringify({taskId:'t1',status:'done',artifact:'ordinary fixture answer',evidence:['fixture'],gaps:[]}):'ordinary fixture answer';
process.stdout.write(JSON.stringify({type:'result',result})+'\\n');});`);
    const shim = join(cwd, process.platform === 'win32' ? 'foreground.cmd' : 'foreground');
    await writeFile(shim, process.platform === 'win32' ? `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`);
    if (process.platform !== 'win32') await chmod(shim, 0o755);
    const env = { ...childEnv, UGS_CLAUDE_PATH: shim, UGS_PROGRESS_EVENTS: '0' };
    const harness = join(cwd, 'harness.json');
    await writeFile(harness, JSON.stringify({ objective: 'ordinary foreground task', successCriteria: ['answer provided'], nonGoals: [],
      budget: { maxAgentCalls: 20, maxRounds: 1 }, strategies: ['fan-out-and-synthesize'], workerGroups: [{ id: 't1', title: 'Inspect',
        focus: 'inspect', deliverable: 'answer', acceptance: 'answer provided', evidenceRequired: 'answer' }], acceptanceRubric: ['answer provided'], stopCondition: 'answer provided' }));
    await writeFile(join(cwd, 'check.mjs'), "console.log('STUDIO PRODUCT CHECK PASSED');\n");
    const content = '---\nname: studio-independent-review\ndescription: Use when isolating studio review.\n---\nKeep HTTP review separate from the real foreground CLI.\n';
    const payloads: Record<string, unknown>[] = []; const paths: string[] = [];
    const server = createServer((req, res) => {
      let body = ''; req.setEncoding('utf8'); req.on('data', (chunk) => { body += chunk; }); req.on('end', () => {
        paths.push(req.url ?? ''); const payload = JSON.parse(body); payloads.push(payload); const snapshot = JSON.parse(payload.messages[0].content);
        res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
        if (String(payload.system).includes('语义比对器')) {
          res.end(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({
            candidateId: snapshot.candidates[0].id, similarity: 0.99,
          }) }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } }));
          return;
        }
        res.end(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ version: 1, kind: 'propose',
          lesson: 'Keep HTTP review separate from foreground CLI execution.', evidenceIds: snapshot.evidence.map((item: { evidenceId: string }) => item.evidenceId),
          operations: [{ action: 'create', name: 'studio-independent-review', content }] }) }], stop_reason: 'end_turn', usage: { input_tokens: 40, output_tokens: 40 } }));
      });
    });
    servers.push(server); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('server');
    const configFile = join(cwd, '.ugs', 'config.json');
    await writeFile(configFile, JSON.stringify({ providers: {
      'foreground-coding': { transport: 'cli', model: 'sonnet' },
      'fixture-review': { transport: 'cli', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'foreground/default-model' },
    }, skillLearning: { activityThreshold: 1 } }));
    const before = await readFile(configFile);
    const { createNodeSkillCandidateStore } = await import('../io/skill-candidate-store');
    await createNodeSkillCandidateStore(cwd).save({ version: 1, lastId: 'prior-studio-review', candidates: [{
      id: 'prior-studio-review', lesson: 'Keep HTTP review separate from foreground CLI execution.',
      context: 'Earlier verified task.', sources: [JSON.stringify(['prior-session', 'prior-turn'])], consecutive: 1, submitted: false,
    }] });
    const argv = [studioBinary, '--json', 'studio', 'ordinary foreground task', '--quiet', '--cwd', cwd, '--run-id', 'studio-product-review',
      '--from-harness', harness, '--adapter', 'claude-code', '--model', 'sonnet', '--provider', 'foreground-coding', '--max-retries', '0',
      '--concurrency', '1', '--verify-command', 'node check.mjs', '--review-adapter', 'codex', '--review-provider', 'fixture-review',
      '--review-model', 'review/studio-exact', '--review-transport', 'anthropic'];
    let execution: { stdout: string; stderr: string; code?: number };
    try { execution = await exec(process.execPath, argv, { cwd: dir, env }); } catch (error) { execution = error as typeof execution; }
    expect(execution.stderr).not.toContain('unknown option');
    const result = JSON.parse(execution.stdout);
    expect(result.skillLearning).toMatchObject({ status: 'reviewed', result: { status: 'awaiting_approval', operationsApplied: 0 } });
    expect(result.verification).toMatchObject({ passed: true, exitCode: 0, stdout: expect.stringContaining('STUDIO PRODUCT CHECK PASSED') });
    expect(paths).toEqual(['/v1/messages', '/v1/messages']); expect(payloads).toHaveLength(2);
    for (const payload of payloads) {
      expect(payload).toMatchObject({ model: 'review/studio-exact', stream: false });
      expect(Object.keys(payload).sort()).toEqual(['max_tokens', 'messages', 'model', 'stream', 'system']);
    }
    const reviewOrigin = result.skillLearning.result.origin;
    // @ts-expect-error Node-only backend module has no declaration file.
    const { createWorkspaceSkillService } = await import('../../../backend/src/workspace-skill-service.mjs');
    const service = createWorkspaceSkillService({ dir: cwd, hostId: reviewOrigin.hostId, workspaceId: reviewOrigin.workspaceId });
    expect(await service.request({ action: 'approve', origin: reviewOrigin, batchId: result.skillLearning.result.batchId }))
      .toMatchObject({ status: 'applied', operationsApplied: 1 });
    const spawns = (await readFile(spawnsFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(spawns.length).toBeGreaterThan(0);
    expect(spawns.filter((spawn) => spawn.args.includes('--model')).every((spawn) => spawn.args[spawn.args.indexOf('--model') + 1] === 'sonnet')).toBe(true);
    expect(spawns.filter((spawn) => !spawn.args.includes('--model')).every((spawn) => spawn.args.includes('--resume'))).toBe(true);
    expect(spawns.every((spawn) => !spawn.prompt.includes('You are an independent skill reviewer'))).toBe(true);
    const file = join(cwd, '.ultragamestudio', 'skills', 'studio-independent-review', 'SKILL.md'); const bytes = await readFile(file);
    expect(bytes.toString('utf8')).toBe(content); expect(await readFile(configFile)).toEqual(before);
    const listed = JSON.parse((await exec(process.execPath, [binary, '--json', 'skills', 'list', '--cwd', cwd], { cwd: dir, env: childEnv })).stdout);
    const fresh = JSON.parse((await exec(process.execPath, [binary, '--json', 'skills', 'view', listed.entries[0].skillId, '--cwd', cwd], { cwd: dir, env: childEnv })).stdout);
    expect(fresh).toMatchObject({ content, fullRead: true, hash: createHash('sha256').update(bytes).digest('hex') });
    const evidenceDir = process.env.UGS_REVIEW_ROUTE_EVIDENCE_DIR;
    if (evidenceDir) { await mkdir(evidenceDir, { recursive: true }); await writeFile(join(evidenceDir, 'studio-product-dispatch.json'), JSON.stringify({ argv,
      productFeatureEnabledInIsolatedBundleOnly: true, exitCode: execution.code ?? 0, paths, payloads, foregroundSpawns: spawns,
      verification: result.verification, outcome: result.skillLearning, configByteIdentical: (await readFile(configFile)).equals(before), freshRead: fresh }, null, 2)); }
  }, 30000);

  it('reads a trusted host rollback from a new bundled CLI process with exact restored bytes and hash', async () => {
    const cwd = join(dir, 'workspace-rollback'); await mkdir(cwd, { recursive: true });
    const origin = { hostId: 'node-cli', workspaceId: createHash('sha256').update(process.platform === 'win32' ? cwd.toLowerCase() : cwd).digest('hex'),
      sessionId: 'rollback-session', turnId: 'rollback-turn', runId: 'rollback-run' };
    // @ts-expect-error Node-only backend module has no declaration file.
    const { createWorkspaceSkillService } = await import('../../../backend/src/workspace-skill-service.mjs');
    const service = createWorkspaceSkillService({ dir: cwd, hostId: origin.hostId, workspaceId: origin.workspaceId });
    const evidence = [{ evidenceId: 'rollback-check', origin, occurredAt: 1, kind: 'verification', provenance: 'host-check',
      toolCallId: 'rollback-check', toolName: 'assert', status: 'success', exitCode: 0, summary: 'Host assertions executed.' }];
    const initial = '---\nname: verify-outcomes\ndescription: Use when checking outcomes.\n---\nRead actual outcomes.\n';
    expect(await service.request({ action: 'manage', origin, mode: 'auto-safe', evidence,
      proposal: { version: 1, kind: 'propose', lesson: 'Read actual outcomes.', evidenceIds: ['rollback-check'], operations: [{ action: 'create', name: 'verify-outcomes', content: initial }] } })).toMatchObject({ status: 'applied' });
    const skillId = (await service.request({ action: 'list', origin })).entries[0].skillId;
    // Only trusted host/user code may set policies and approve/rollback; none is a model tool.
    await service.request({ action: 'set_policy', origin, skillId, policy: { autoEditable: true } });
    const read = await service.request({ action: 'view', origin, skillId });
    const change = await service.request({ action: 'manage', origin, mode: 'auto-safe', evidence, proposal: { version: 1, kind: 'propose',
      lesson: 'Re-read current outcomes.', evidenceIds: ['rollback-check'], operations: [{ action: 'patch', skillId,
        oldString: 'Read actual outcomes.', newString: 'Re-read current outcomes.', readReceiptId: read.readReceiptId, expectedHash: read.hash }] } });
    // Replacing an existing rule requires owner approval even with verified evidence.
    expect(change).toMatchObject({ status: 'awaiting_approval', operationsApplied: 0 });
    const file = join(cwd, '.ultragamestudio', 'skills', 'verify-outcomes', 'SKILL.md');
    expect(await readFile(file, 'utf8')).toBe(initial);
    const pendingRead = JSON.parse((await exec(process.execPath, [binary, '--json', 'skills', 'view', skillId, '--cwd', cwd], { cwd: dir, env: childEnv })).stdout);
    expect(pendingRead).toMatchObject({ content: initial, fullRead: true, hash: read.hash });
    const approved = await service.request({ action: 'approve', origin, batchId: change.batchId });
    expect(approved).toMatchObject({ status: 'applied', operationsApplied: 1 });
    expect(await readFile(file, 'utf8')).toBe(initial.replace('Read actual outcomes.', 'Re-read current outcomes.'));
    const changed = JSON.parse((await exec(process.execPath, [binary, '--json', 'skills', 'view', skillId, '--cwd', cwd], { cwd: dir, env: childEnv })).stdout);
    expect(changed.hash).toBe(createHash('sha256').update(await readFile(file)).digest('hex'));
    expect(await service.request({ action: 'rollback', origin, rollbackId: approved.rollbackId })).toMatchObject({ status: 'applied', operationsApplied: 1 });
    expect(await readFile(file, 'utf8')).toBe(initial);
    const fresh = JSON.parse((await exec(process.execPath, [binary, '--json', 'skills', 'view', skillId, '--cwd', cwd], { cwd: dir, env: childEnv })).stdout);
    expect(fresh).toMatchObject({ content: initial, fullRead: true, hash: createHash('sha256').update(await readFile(file)).digest('hex') });
    expect(fresh.hash).not.toBe(changed.hash);
  }, 20000);

  it('exposes learn but returns explicit unavailable rather than a general CLI reviewer without a route', async () => {
    const cwd = join(dir, 'workspace-unavailable'); await mkdir(cwd, { recursive: true });
    let failure: { code?: number; stdout?: string } | undefined;
    try { await exec(process.execPath, [binary, '--json', 'learn', 'Verify actual outcomes.', '--cwd', cwd], { cwd: dir, env: childEnv }); }
    catch (error) { failure = error as typeof failure; }
    expect(failure?.code).toBe(4);
    expect(JSON.parse(failure?.stdout ?? '')).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('SKILL_REVIEW_UNAVAILABLE') });
  });
});
