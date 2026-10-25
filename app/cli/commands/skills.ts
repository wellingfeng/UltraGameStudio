/** Standalone Node skill commands; no coding-agent or browser dependency. */
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { SkillCatalog, SkillOrigin } from '../../src/runtime/skills/types';
import { createNodeSkillHostPort, createNodeWorkspaceSkillRequest } from '../io/skill-host';
import { CliError } from '../utils/fs';
import type { GlobalOptions } from '../utils/format';
import { createNodeSkillWorkflow, type NodeSkillWorkflowOptions } from '../io/skill-workflow';

export interface SkillLearnOptions extends SkillsOptions {
  route?: NodeSkillWorkflowOptions['route'];
  model?: NodeSkillWorkflowOptions['model'];
  skillConfig?: NodeSkillWorkflowOptions['config'];
  adapter?: string;
  reviewUrl?: string;
  reviewModel?: string;
  reviewTransport?: string;
  /** Only an env name may be passed on argv, never the credential itself. */
  reviewKeyEnv?: string;
}

export interface SkillsOptions extends GlobalOptions {
  cwd?: string;
  file?: string;
}

export async function runSkills(action: string, target: string | undefined, options: SkillsOptions): Promise<number> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const origin: SkillOrigin = {
    hostId: 'node-cli', workspaceId: createHash('sha256').update(process.platform === 'win32' ? cwd.toLowerCase() : cwd).digest('hex'),
    sessionId: randomUUID(), turnId: randomUUID(), runId: randomUUID(), cwd,
  };
  const host = createNodeSkillHostPort({ origin, request: createNodeWorkspaceSkillRequest({ cwd, hostId: origin.hostId, workspaceId: origin.workspaceId }) });
  if (action === 'view') {
    if (!target) throw new CliError('Provide the exact skill id returned by skills list.', 1);
    const read = await host.view({ skillId: target, ...(options.file ? { filePath: options.file } : {}) });
    process.stdout.write(options.json ? `${JSON.stringify(read, null, 2)}\n` : read.content);
    return 0;
  }
  if (action !== 'list') throw new CliError('Unknown skills action; use list or view.', 1);
  const catalog: SkillCatalog = await host.list();
  process.stdout.write(options.json ? `${JSON.stringify(catalog, null, 2)}\n`
    : catalog.entries.map((entry) => `${entry.skillId}\t${entry.name}\t${entry.scope}`).join('\n') + '\n');
  return 0;
}

/** User-directed text evidence still goes through shared budgets and host policy. */
export async function runSkillLearn(action: 'learn' | 'refine', text: string, options: SkillLearnOptions): Promise<number> {
  if (!text.trim()) throw new CliError('Provide the lesson or correction as explicit text; historical/model claims are not verification.', 1);
  const cwd = resolve(options.cwd ?? process.cwd());
  const origin: SkillOrigin = {
    hostId: 'node-cli', workspaceId: createHash('sha256').update(process.platform === 'win32' ? cwd.toLowerCase() : cwd).digest('hex'),
    sessionId: randomUUID(), turnId: randomUUID(), runId: randomUUID(), cwd,
  };
  let route = options.route;
  if (!route && options.reviewUrl && options.reviewModel) {
    const endpoint = new URL(options.reviewUrl);
    if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new CliError('Review URL must be HTTP(S) without embedded credentials.', 1);
    const transport = options.reviewTransport ?? 'openai-compatible';
    if (!['openai-compatible', 'anthropic'].includes(transport)) throw new CliError('Review transport must be openai-compatible or anthropic; CLI is never permitted.', 1);
    if (options.reviewKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.reviewKeyEnv)) throw new CliError('Review key env name is invalid.', 1);
    const apiKey = options.reviewKeyEnv ? process.env[options.reviewKeyEnv] : undefined;
    if (options.reviewKeyEnv && !apiKey) throw new CliError('Requested review credential env is unset.', 4);
    route = { selection: { adapter: 'custom', modelClass: options.reviewModel }, adapter: 'custom', modelClass: options.reviewModel,
      model: options.reviewModel, baseUrl: options.reviewUrl, mode: 'direct', transport: transport as 'anthropic' | 'openai-compatible', ...(apiKey ? { apiKey } : {}) };
  }
  const workflow = createNodeSkillWorkflow({ origin, cwd, adapter: options.adapter ?? 'claude-code',
    prompt: `/${action} ${text}`, explicit: true, config: options.skillConfig, route, model: options.model });
  const outcome = await workflow.finish({ finalAnswer: '', terminal: 'completed' });
  process.stdout.write(`${JSON.stringify(outcome, null, options.json ? 2 : undefined)}\n`);
  if (outcome.status === 'unavailable') return 4;
  if (outcome.status !== 'reviewed') return 0;
  return ['applied', 'noop', 'awaiting_approval'].includes(outcome.result.status) ? 0 : 1;
}
