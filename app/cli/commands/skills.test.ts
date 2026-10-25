import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { ResolvedRoute } from '../config/providers';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function workspace() { const dir = await mkdtemp(join(tmpdir(), 'ugs-skills-command-')); dirs.push(dir); return dir; }
async function implementation() { return await import(/* @vite-ignore */ './skills'); }

describe('ugs skills', () => {
  it('lists real managed skills without requiring a coding agent or enabling studio', async () => {
    const { runSkills } = await implementation();
    const cwd = await workspace();
    const packageDir = join(cwd, '.ultragamestudio', 'skills', 'verify-work');
    await mkdir(packageDir, { recursive: true });
    await writeFile(join(packageDir, 'SKILL.md'), '---\nname: verify-work\ndescription: Use when verifying work.\n---\nActual full rule.\n');
    let stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { stdout += String(chunk); return true; }) as never);
    expect(await runSkills('list', undefined, { cwd, json: true, quiet: true })).toBe(0);
    const catalog = JSON.parse(stdout);
    expect(catalog.entries).toHaveLength(1);
    expect(catalog.entries[0]).toMatchObject({ name: 'verify-work', scope: 'project', relativePath: 'verify-work' });
  });

  it('views the full requested skill and returns a host receipt rather than a description', async () => {
    const { runSkills } = await implementation();
    const cwd = await workspace();
    const packageDir = join(cwd, '.ultragamestudio', 'skills', 'verify-work');
    await mkdir(packageDir, { recursive: true });
    const content = '---\nname: verify-work\ndescription: Use when verifying work.\n---\nFULL BODY\n';
    await writeFile(join(packageDir, 'SKILL.md'), content);
    let stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { stdout += String(chunk); return true; }) as never);
    expect(await runSkills('list', undefined, { cwd, json: true })).toBe(0);
    const id = JSON.parse(stdout).entries[0].skillId; stdout = '';
    expect(await runSkills('view', id, { cwd, json: true })).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ content, fullRead: true, relativePath: 'SKILL.md', readReceiptId: expect.any(String), hash: expect.any(String) });
  });

  it('learns explicit user evidence via the shared reviewer and actual HTTP plus managed filesystem', async () => {
    const { runSkillLearn } = await implementation();
    const cwd = await workspace();
    const content = '---\nname: verify-work\ndescription: Use when verifying work.\n---\nRead actual results before reporting success.\n';
    const server = createServer((req, res) => {
      let body = ''; req.setEncoding('utf8'); req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const request = JSON.parse(body); const snapshot = JSON.parse(request.messages[1].content);
        res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ version: 1, kind: 'propose',
          lesson: 'Read actual results before reporting success.', evidenceIds: snapshot.evidence.map((item: { evidenceId: string }) => item.evidenceId),
          operations: [{ action: 'create', name: 'verify-work', content }] }) } }], usage: { prompt_tokens: 30, completion_tokens: 30 } }));
      });
    });
    servers.push(server); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('server');
    const route: ResolvedRoute = { selection: { adapter: 'custom', modelClass: 'review' }, adapter: 'custom', modelClass: 'review',
      mode: 'direct', transport: 'openai-compatible', model: 'review-model', baseUrl: `http://127.0.0.1:${address.port}` };
    let stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { stdout += String(chunk); return true; }) as never);
    expect(await runSkillLearn('learn', 'Always read actual test outcomes before reporting success.', { cwd, json: true, route })).toBe(0);
    const reviewed = JSON.parse(stdout);
    expect(reviewed).toMatchObject({ status: 'reviewed', result: { status: 'awaiting_approval', operationsApplied: 0 } });
    const file = join(cwd, '.ultragamestudio', 'skills', 'verify-work', 'SKILL.md');
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    // @ts-expect-error Existing Node filesystem service has no TypeScript declaration.
    const { createWorkspaceSkillService } = await import('../../../backend/src/workspace-skill-service.mjs');
    const origin = reviewed.result.origin;
    const service = createWorkspaceSkillService({ dir: cwd, hostId: origin.hostId, workspaceId: origin.workspaceId });
    expect(await service.request({ action: 'approve', origin, batchId: reviewed.result.batchId }))
      .toMatchObject({ status: 'applied', operationsApplied: 1 });
    expect(await readFile(file, 'utf8')).toBe(content);
  });

  it('accepts an explicit HTTP review endpoint without opening credential or agent config files', async () => {
    const { runSkillLearn } = await implementation();
    const cwd = await workspace(); let stdout = '';
    const requests: Record<string, unknown>[] = [];
    const server = createServer((req, res) => {
      let body = ''; req.setEncoding('utf8'); req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        requests.push(JSON.parse(body));
        res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify({ choices: [{ message: { content: '{"version":1,"kind":"noop","reason":"no new lesson"}' } }], usage: { prompt_tokens: 20, completion_tokens: 20 } }));
      });
    });
    servers.push(server); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('server');
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { stdout += String(chunk); return true; }) as never);
    expect(await runSkillLearn('refine', 'Verify actual outcomes.', { cwd, json: true,
      reviewUrl: `http://127.0.0.1:${address.port}`, reviewModel: 'review-only' })).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ status: 'reviewed', result: { status: 'noop' } });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ model: 'review-only', stream: false });
    expect(requests[0]).not.toHaveProperty('tools');
  });

  it('keeps the global config path distinct from host-injected learning policy without opening it', async () => {
    const { runSkillLearn } = await implementation();
    const cwd = await workspace(); let stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { stdout += String(chunk); return true; }) as never);
    expect(await runSkillLearn('learn', 'Use actual checks.', { cwd, json: true,
      config: 'unused-private-config-path', skillConfig: { mode: 'off' } })).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ status: 'disabled' });
  });

  it('fails closed without a safe completion route and never claims that explicit text was learned', async () => {
    const { runSkillLearn } = await implementation();
    const cwd = await workspace(); let stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { stdout += String(chunk); return true; }) as never);
    expect(await runSkillLearn('refine', 'Use actual checks.', { cwd, json: true, adapter: 'codex' })).toBe(4);
    expect(JSON.parse(stdout)).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('SKILL_REVIEW_UNAVAILABLE') });
  });
});
