import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunGateway, SpawnCliAgentOpts } from '../../src/runtime';
import { runUltracode } from './ultracode';

let outBuf = '';
let errBuf = '';
let outSpy: { mockRestore: () => void };
let errSpy: { mockRestore: () => void };
let dir: string;

const sink = (append: (s: string) => void) =>
  ((chunk: unknown) => {
    append(String(chunk));
    return true;
  }) as never;

beforeEach(() => {
  outBuf = '';
  errBuf = '';
  outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(sink((s) => (outBuf += s)));
  errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(sink((s) => (errBuf += s)));
  dir = mkdtempSync(join(tmpdir(), 'fuc-ultracode-'));
});

afterEach(() => {
  outSpy.mockRestore();
  errSpy.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

describe('fuc ultracode', () => {
  it('plans, executes, validates, and persists a dynamic harness run', async () => {
    const calls: string[] = [];
    const gateway = fakeUltracodeGateway(calls);
    const code = await runUltracode('审查博客里的技术论断', {
      cwd: dir,
      runId: 'uc-test',
      json: true,
      quiet: true,
      gateway,
      concurrency: '3',
      maxRetries: '0',
    });

    expect(code).toBe(0);
    const result = JSON.parse(outBuf);
    const runDir = join(dir, '.fuc-run', 'uc-test');
    expect(result.success).toBe(true);
    expect(result.artifacts.verdict.pass).toBe(true);
    expect(result.artifacts.ledger.tasks[0].id).toBe('t1');
    expect(existsSync(join(runDir, 'request.json'))).toBe(true);
    expect(existsSync(join(runDir, 'harness.json'))).toBe(true);
    expect(existsSync(join(runDir, 'workflow.fuc.json'))).toBe(true);
    expect(existsSync(join(runDir, 'events.jsonl'))).toBe(true);
    expect(existsSync(join(runDir, 'status.json'))).toBe(true);
    expect(existsSync(join(runDir, 'result.json'))).toBe(true);
    expect(readFileSync(join(runDir, 'events.jsonl'), 'utf8')).toContain('node_success');
    expect(calls.length).toBeGreaterThanOrEqual(6);
  });
});

function fakeUltracodeGateway(calls: string[]): RunGateway {
  const respond = async (
    prompt: string,
    _adapter: string,
    opts: SpawnCliAgentOpts,
  ): Promise<string> => {
    calls.push(prompt);
    opts.onProgress?.('chunk');
    if (prompt.includes('DYNAMIC_HARNESS')) {
      return JSON.stringify({
        objective: '审查博客里的技术论断',
        nonGoals: ['不要改写博客风格'],
        successCriteria: ['每条技术论断都有证据'],
        budget: { maxAgentCalls: 20, maxRounds: 2 },
        strategies: ['fan-out-and-synthesize', 'adversarial-verification'],
        workerGroups: [
          {
            id: 't1',
            title: '识别论断',
            focus: '找出需要核验的技术论断',
            deliverable: '论断清单',
            acceptance: '至少列出一条论断',
            evidenceRequired: '原文片段',
          },
          {
            id: 't2',
            title: '代码核验',
            focus: '对照代码库核验论断',
            deliverable: '核验结果',
            acceptance: '每条结论都有文件路径或原因',
            evidenceRequired: '文件路径',
          },
        ],
        acceptanceRubric: ['证据充分', '没有过度声称'],
        stopCondition: '验收门通过',
      });
    }
    if (prompt.includes('DYNAMIC_TASK_LEDGER')) {
      return JSON.stringify({
        tasks: [
          {
            id: 't1',
            title: '识别论断',
            owner: 'worker',
            input: '博客草稿',
            deliverable: '论断清单',
            acceptance: '至少列出一条论断',
            evidenceRequired: '原文片段',
            status: 'accepted',
            artifact: 'claims.md',
            gaps: [],
          },
        ],
      });
    }
    if (prompt.includes('DYNAMIC_WORKER_RESULT')) {
      return JSON.stringify({
        taskId: prompt.includes('t2') ? 't2' : 't1',
        status: 'done',
        artifact: '核验结果',
        evidence: ['app/src/core/ir.ts'],
        gaps: [],
      });
    }
    if (prompt.includes('DYNAMIC_VERDICT')) {
      return JSON.stringify({
        pass: true,
        acceptedArtifact: '技术论断已核验',
        evidence: ['app/src/core/ir.ts'],
        gaps: [],
      });
    }
    return '最终结论：通过\n已验收内容与证据：app/src/core/ir.ts\n未解决 gaps：无';
  };

  return {
    resolveDirectRoute: () => null,
    resolveCliRoute: async () => ({ adapter: 'claude-code', cliCommand: 'fake' }),
    completeText: async () => {
      throw new Error('direct path not used');
    },
    spawnCliAgent: respond,
    applyOverride: (selection, override) =>
      override
        ? { ...selection, modelClass: override.modelClass ?? selection.modelClass }
        : { ...selection },
    nodeGatewayOverride: () => undefined,
    modelClassFromModelId: () => 'sonnet',
    recordCall: () => {},
    timeoutPolicy: () => ({ timeoutSeconds: 1800, idleTimeoutSeconds: 300 }),
    effectiveConcurrency: (configured) => Math.max(1, configured),
    effectiveConsensusSamples: (configured) => configured,
  };
}
