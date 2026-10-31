import { afterEach, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import type { SkillCatalog, SkillOrigin, SkillReadResult } from '../runtime/skills/types';
import type { NodeSkillWorkflowOutcome } from '../../cli/io/skill-workflow';

// Config discovery is confined to this fixture, never a user's credentials.
const isolated = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (original) => ({ ...await original<typeof import('node:os')>(),
  homedir: () => { if (!isolated.home) throw new Error('Acceptance fixture home is not initialized'); return isolated.home; },
}));
import { resetFucConfigCache, type ResolvedRoute } from '../../cli/config/providers';
import { createNodeSkillWorkflow } from '../../cli/io/skill-workflow';
// @ts-expect-error The real Node filesystem service has no declaration file.
import { createWorkspaceSkillService } from '../../../backend/src/workspace-skill-service.mjs';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
  resetFucConfigCache();
});
const execute = promisify(execFile);

async function acceptance(route: ResolvedRoute) {
  const cwd = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'ugs-review-acceptance-'));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  isolated.home = join(cwd, 'isolated-home'); resetFucConfigCache();
  const base: SkillOrigin = { hostId: 'node-cli', workspaceId: 'acceptance-workspace',
    sessionId: 'acceptance-session', turnId: 'ordinary-1', runId: 'ordinary-run-1' };
  const service = createWorkspaceSkillService({ dir: cwd, hostId: base.hostId, workspaceId: base.workspaceId });
  await writeFile(join(cwd, 'check.cjs'),
    "require('node:assert').strictEqual(require('node:fs').readFileSync('.ultragamestudio/checks/result.txt', 'utf8'), 'verified');\n");
  let pending: NodeSkillWorkflowOutcome | undefined;
  // Distinct ordinary tasks, no /learn and no seeded candidate. A real child
  // process fails before each file fix and passes afterwards. Task actions are
  // scripted for determinism; they are not a live foreground-agent acceptance.
  for (let index = 1; index <= 2; index++) {
    await rm(join(cwd, '.ultragamestudio', 'checks', 'result.txt'), { force: true });
    const origin = { ...base, turnId: `ordinary-${index}`, runId: `ordinary-run-${index}` };
    const turn = createNodeSkillWorkflow({ origin, cwd, adapter: 'custom', route,
      prompt: '验证脚本找不到项目私有目录中的产物。请先复现，再在 .ultragamestudio/checks/result.txt 写入 verified 并重新运行验证。',
      config: { enabled: true, mode: 'approve-all', activityThreshold: 1, cooldownMs: 0,
        maxRounds: 6, maxInputTokens: 100000, maxOutputTokens: 10000, timeoutMs: 120000 } });
    await turn.loadContext();
    let failure: { code?: number; stderr?: string } | undefined;
    try { await execute(process.execPath, ['check.cjs'], { cwd }); }
    catch (error) { failure = error as typeof failure; }
    expect(failure?.code).toBe(1);
    turn.onHostVerification({ toolCallId: `failed-${index}`, command: 'node check.cjs',
      output: failure!.stderr ?? '', exitCode: failure!.code! });
    await mkdir(join(cwd, '.ultragamestudio', 'checks'), { recursive: true });
    await writeFile(join(cwd, '.ultragamestudio', 'checks', 'result.txt'), 'verified');
    turn.onNativeToolEvent({ runId: origin.runId, toolCallId: `fixed-${index}`, toolName: 'write_file',
      phase: 'end', provenance: 'native-tool', status: 'success',
      args: { path: '.ultragamestudio/checks/result.txt' }, result: '已写入项目私有验证产物。' });
    const checked = await execute(process.execPath, ['check.cjs'], { cwd });
    expect(checked.stderr).toBe('');
    turn.onHostVerification({ toolCallId: `passed-${index}`, command: 'node check.cjs',
      output: checked.stdout, exitCode: 0 });
    pending = await turn.finish({ terminal: 'completed', finalAnswer: '项目私有目录中的实际产物已通过原验证脚本。' });
    const candidates = JSON.parse(await readFile(join(cwd, '.ultragamestudio', 'skill-learning', 'pre-review.v1.json'), 'utf8'));
    expect(candidates.candidates).toHaveLength(1);
    expect(candidates.candidates[0].consecutive).toBe(index);
    if (index === 1) {
      expect(pending).toMatchObject({ status: 'reviewed', result: { status: 'noop' } });
      expect((await service.request({ action: 'list', origin }) as SkillCatalog).entries).toHaveLength(0);
    }
  }
  expect(pending).toMatchObject({ status: 'reviewed', result: { status: 'awaiting_approval' } });
  if (pending?.status !== 'reviewed') throw new Error('Expected a host review result');
  const origin = pending.result.origin;
  const saved = await service.request({ action: 'approve', origin, mode: 'approve-all', batchId: pending.result.batchId });
  expect(saved).toMatchObject({ status: 'applied', operationsApplied: 1 });
  const catalog = await service.request({ action: 'list', origin }) as SkillCatalog;
  expect(catalog.entries).toHaveLength(1);
  const entry = catalog.entries[0]!;
  const reloaded = await service.request({ action: 'view', origin, skillId: entry.skillId }) as SkillReadResult;
  const file = join(cwd, '.ultragamestudio', 'skills', entry.relativePath, 'SKILL.md');
  expect(await readFile(file, 'utf8')).toBe(reloaded.content);
  expect(reloaded.content).toContain('.ultragamestudio');

  const next = createNodeSkillWorkflow({ origin: { ...base, sessionId: 'next-session', turnId: 'next-turn', runId: 'next-run' },
    cwd, adapter: 'custom', route, prompt: '再次核对项目中的验证产物。', explicitSkillIds: [entry.skillId],
    config: { enabled: false, mode: 'off' } });
  const delivered = await next.loadContext();
  expect(delivered.loadedSkills).toEqual([expect.objectContaining({ skillId: entry.skillId, revision: reloaded.revision, hash: reloaded.hash })]);
  const contexts = JSON.parse(delivered.prompt.split('<UGS_SKILL_CONTEXT>\n')[1].split('\n</UGS_SKILL_CONTEXT>')[0]);
  expect(contexts[0].content).toBe(reloaded.content);
  await next.finish({ terminal: 'completed', finalAnswer: '上下文已送达，未提供专门的遵循检查。' });
  // Delivery is asserted, not adherence; generic check success is not adoption.
  const afterDelivery = await service.request({ action: 'list', origin }) as SkillCatalog;
  expect(afterDelivery.entries[0].usage?.usedWithEvidence ?? 0).toBe(0);
  const rolled = await service.request({ action: 'rollback', origin, rollbackId: saved.rollbackId });
  expect(rolled.status).toBe('applied');
  expect((await service.request({ action: 'list', origin }) as SkillCatalog).entries).toHaveLength(0);
  await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
}

it('L3: two ordinary checked tasks → real HTTP fixture → disk approval → later full delivery → rollback', async () => {
  let proposalCalls = 0;
  const bodies: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body); bodies.push(payload);
    const snapshot = JSON.parse(payload.messages[1].content);
    let text: string;
    if (payload.messages[0].content.includes('语义比对器')) {
      text = JSON.stringify({ candidateId: snapshot.candidates[0].id, similarity: 0.99 });
    } else {
      proposalCalls++;
      text = JSON.stringify({ version: 1, kind: 'propose',
        lesson: '当验证脚本读取项目产物失败时，把产物保存在 .ultragamestudio/checks/，再执行原脚本，避免从错误位置读取。',
        evidenceIds: snapshot.evidence.map((e: { evidenceId: string }) => e.evidenceId),
        operations: [{ action: 'create', name: 'project-verification', content:
          '---\nname: project-verification\ndescription: 当项目验证脚本读取产物失败时使用；把产物留在项目私有目录并重新运行原检查。\n---\n\n将验证产物存到 .ultragamestudio/checks/，再运行原脚本，因为错误位置会导致检查读不到文件。\n' }],
      });
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 500, completion_tokens: 200 } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  await acceptance({ selection: { adapter: 'custom', modelClass: 'review' }, adapter: 'custom', modelClass: 'review',
    mode: 'direct', transport: 'openai-compatible', model: 'fixture-reviewer',
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` });
  expect(proposalCalls).toBe(2);
  expect(bodies).toHaveLength(3); // two proposals plus budgeted similarity
  for (const body of bodies) { expect(body).not.toHaveProperty('tools'); expect(body).not.toHaveProperty('tool_choice'); }
}, 30000);

const liveReady = ['UGS_LIVE_REVIEW_KEY', 'UGS_LIVE_REVIEW_MODEL', 'UGS_LIVE_REVIEW_URL'].every((name) => Boolean(process.env[name]));
// Opt-in reviewer only: not installed Tauri or a live foreground task agent.
// Credentials remain env-only and are never included in assertions or logs.
it.skipIf(!liveReady)('live reviewer: the same two-task disk/delivery/rollback scenario (not installed L4)', async () => {
  await acceptance({ selection: { adapter: 'custom', modelClass: 'review' }, adapter: 'custom', modelClass: 'review',
    mode: 'direct', transport: 'openai-compatible', apiKey: process.env.UGS_LIVE_REVIEW_KEY!,
    model: process.env.UGS_LIVE_REVIEW_MODEL!, baseUrl: process.env.UGS_LIVE_REVIEW_URL! });
}, 300000);
