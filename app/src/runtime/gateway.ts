/**
 * CONTRACT: host-agnostic agent invocation.
 *
 * `invokeAgent` dispatches one model call along the injected gateway — direct
 * HTTP when a provider key resolves, else a spawned CLI agent — and records
 * timing telemetry. `runAgentWithInteraction` wraps it in the bounded
 * "node may ask the user" loop (see core/interaction.ts), streaming each attempt
 * through `callbacks.beginStream` and blocking on `callbacks.promptInteraction`.
 *
 * Moved from store/useStore.ts (`invokeGatewayAgent` / `invokeAgentCli` /
 * `runCliWithInteraction`). The Tauri spawn seam and React streaming/interaction
 * are replaced by the injected {@link RunGateway} + {@link RunCallbacks}.
 */
import {
  INTERACTION_PROTOCOL,
  formatAnswerForPrompt,
  parseInteraction,
  stripInteraction,
} from '../core/interaction';
import type { GatewaySelection } from '../core/ir';
import {
  appendPersonalInstructions,
  personalInstructionsForSelection,
} from '../core/personalInstructions';
import { appendExecutionContract } from './contract';
import { parseRunFailure } from './failure';
import { formatFailureLine } from './failure';
import type { RunCallbacks, RunContext } from './types';

/** Max times a single node may ask the user before we stop re-invoking it. */
export const MAX_INTERACTION_ROUNDS = 6;

/**
 * Chinese guidance appended to the prompt when a schema-validation retry fires.
 * The schema *instruction* is already re-appended every round (see the loop), so
 * this only needs to surface the concrete problems so the model self-corrects.
 */
function schemaRetryAppendix(problems: string[]): string {
  const list = problems.length
    ? problems.map((p) => `- ${p}`).join('\n')
    : '- 未能从你的输出中解析出符合结构的 JSON';
  return `---
你上一次的输出不满足结构要求，存在以下问题：
${list}

请重新只输出一个满足上面结构要求的 JSON（可放在 \`\`\`json 代码块里），不要附加任何解释性文字。`;
}

/** A fresh session id (uuid) for chaining warm context across steps. */
export function newSessionId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Run one model call: direct HTTP when a provider key resolves, otherwise a
 * spawned CLI agent. Records timing telemetry on success and failure.
 */
export async function invokeAgent(
  context: RunContext,
  prompt: string,
  selection: GatewaySelection,
  opts: {
    model?: string;
    omitModel?: boolean;
    cliCommand?: string;
    cwd?: string;
    permission?: string;
    timeoutSeconds?: number;
    idleTimeoutSeconds?: number;
    onProgress?: (text: string) => void;
    sessionId?: string;
    resume?: boolean;
  } = {},
): Promise<{ text: string; adapter: string }> {
  const { gateway } = context;
  const direct = gateway.resolveDirectRoute(selection);
  if (direct) {
    const startedAt = Date.now();
    let firstProgressAt: number | undefined;
    try {
      const result = await gateway.completeText({
        selection,
        model: opts.model ?? direct.model,
        omitModel: opts.omitModel,
        prompt,
        onDelta: (chunk) => {
          firstProgressAt ??= Date.now();
          opts.onProgress?.(chunk);
        },
      });
      gateway.recordCall(selection, {
        elapsedMs: Date.now() - startedAt,
        firstProgressMs: firstProgressAt ? firstProgressAt - startedAt : undefined,
        ok: true,
      });
      return { text: result.text, adapter: result.adapter };
    } catch (err) {
      const failure = parseRunFailure(err);
      gateway.recordCall(selection, {
        elapsedMs: Date.now() - startedAt,
        firstProgressMs: firstProgressAt ? firstProgressAt - startedAt : undefined,
        ok: false,
        failureCode: failure.code,
        timeoutSeconds: failure.timeoutSeconds,
        idleTimeoutSeconds: failure.idleTimeoutSeconds,
      });
      throw err;
    }
  }

  const cli = await gateway.resolveCliRoute(selection);
  const startedAt = Date.now();
  let firstProgressAt: number | undefined;
  try {
    const text = await gateway.spawnCliAgent(prompt, cli.adapter, {
      model: opts.omitModel ? undefined : opts.model ?? cli.model,
      env: cli.env,
      cwd: opts.cwd,
      permission: opts.permission,
      timeoutSeconds: opts.timeoutSeconds,
      idleTimeoutSeconds: opts.idleTimeoutSeconds,
      cliCommand: opts.cliCommand ?? cli.cliCommand ?? context.cliCommand,
      onProgress: (chunk) => {
        firstProgressAt ??= Date.now();
        opts.onProgress?.(chunk);
      },
      sessionId: opts.sessionId,
      resume: opts.resume,
    });
    gateway.recordCall(selection, {
      elapsedMs: Date.now() - startedAt,
      firstProgressMs: firstProgressAt ? firstProgressAt - startedAt : undefined,
      ok: true,
    });
    return { text, adapter: cli.adapter };
  } catch (err) {
    const failure = parseRunFailure(err);
    gateway.recordCall(selection, {
      elapsedMs: Date.now() - startedAt,
      firstProgressMs: firstProgressAt ? firstProgressAt - startedAt : undefined,
      ok: false,
      failureCode: failure.code,
      timeoutSeconds: failure.timeoutSeconds,
      idleTimeoutSeconds: failure.idleTimeoutSeconds,
    });
    throw err;
  }
}

/**
 * Run one CLI step that may ask the user to choose/type before producing its
 * final result. Streams each attempt into its own message via
 * `callbacks.beginStream`. If the model emits an interaction block it renders a
 * widget (`callbacks.promptInteraction`), waits for the answer, appends it to
 * the prompt, and re-invokes — bounded by MAX_INTERACTION_ROUNDS. Returns the
 * final (interaction-stripped) output; throws on CLI failure.
 */
export async function runAgentWithInteraction(opts: {
  context: RunContext;
  callbacks: RunCallbacks;
  /** Streaming header, e.g. `【label】\n`. */
  head: string;
  /** Bracket label for the streamed finalize/failure line (no ✓ prefix). */
  label: string;
  /** Prompt base — already includes upstream data context / stage feed. */
  basePrompt: string;
  selection: GatewaySelection;
  cli: {
    model?: string;
    omitModel?: boolean;
    cliCommand?: string;
    cwd?: string;
    permission?: string;
    timeoutSeconds?: number;
    idleTimeoutSeconds?: number;
  };
  /** Optional session continuity (shared id; resume marks continuation). */
  session?: { id: string; resume: boolean };
  /**
   * Optional output-schema enforcement. When present, each round appends
   * `instruction` to the prompt; once a clean, non-interaction output is
   * produced it is run through `validate`. On failure we feed the model
   * `schemaRetryFeedback`-style guidance and re-invoke (bounded by `maxRounds`,
   * default 2). A still-failing schema is NON-FATAL: the best-effort output is
   * adopted (a warning is logged). See `runtime/schema.ts`.
   */
  schema?: {
    instruction: string;
    validate: (text: string) => { ok: boolean; problems: string[]; normalized?: string };
    maxRounds?: number;
  };
}): Promise<string> {
  const { context, callbacks } = opts;
  const stillRunning = () => !callbacks.isCancelled();
  let appendix = '';
  let lastClean = '';
  // Bound the loop to cover both interaction rounds AND schema retry rounds so a
  // node that both asks the user and must satisfy a schema still terminates.
  const schemaMaxRounds = opts.schema ? opts.schema.maxRounds ?? 2 : 0;
  const maxRounds = MAX_INTERACTION_ROUNDS + schemaMaxRounds;
  let schemaRetries = 0;
  for (let round = 0; round < maxRounds; round += 1) {
    if (!stillRunning()) return lastClean;
    const sm = callbacks.beginStream(
      round === 0 ? opts.head : `${opts.head}（已根据你的回答继续）\n`,
    );
    const schemaSuffix = opts.schema ? `\n\n${opts.schema.instruction}` : '';
    const personalInstructions = context.personalInstructionsByModel
      ? personalInstructionsForSelection(
          context.personalInstructionsByModel,
          opts.selection,
        )
      : context.personalInstructions;
    const promptBase = appendPersonalInstructions(
      opts.basePrompt,
      personalInstructions,
      opts.selection.adapter,
    );
    const prompt = `${appendExecutionContract(promptBase)}\n\n${INTERACTION_PROTOCOL}${appendix}${schemaSuffix}`;
    const timeoutPolicy = context.gateway.timeoutPolicy(opts.selection, prompt);

    let raw: string;
    try {
      raw = (
        await invokeAgent(context, prompt, opts.selection, {
          model: opts.cli.model,
          omitModel: opts.cli.omitModel,
          cliCommand: opts.cli.cliCommand,
          cwd: opts.cli.cwd,
          permission: opts.cli.permission,
          timeoutSeconds: opts.cli.timeoutSeconds ?? timeoutPolicy.timeoutSeconds,
          idleTimeoutSeconds:
            opts.cli.idleTimeoutSeconds ?? timeoutPolicy.idleTimeoutSeconds,
          onProgress: sm.append,
          sessionId: opts.session?.id,
          resume: opts.session ? opts.session.resume || round > 0 : undefined,
        })
      ).text.trim();
    } catch (err) {
      const failure = parseRunFailure(err);
      if (stillRunning()) sm.fail(formatFailureLine(opts.label, failure));
      throw err;
    }

    const clean = stripInteraction(raw);
    lastClean = clean;

    const req = stillRunning() ? parseInteraction(raw) : null;
    if (!req) {
      if (!stillRunning()) return clean;
      // No interaction requested: if a schema is in effect, validate before
      // finalizing. Validation failures trigger a bounded, user-free retry.
      if (opts.schema) {
        const result = opts.schema.validate(clean);
        const finalText = result.normalized ?? clean;
        if (result.ok) {
          sm.finalize(`【✓ ${opts.label}】\n${finalText || '(无输出)'}`);
          return finalText;
        }
        if (schemaRetries < schemaMaxRounds) {
          schemaRetries += 1;
          sm.finalize(
            `【${opts.label}】\n${clean || '(无输出)'}\n（输出不满足结构要求，正在重试 ${schemaRetries}/${schemaMaxRounds}）`,
          );
          appendix += `\n\n${schemaRetryAppendix(result.problems)}`;
          continue;
        }
        // Exhausted schema retries — adopt the best-effort result (non-fatal).
        callbacks.onLog(
          `⚠ ${opts.label}：输出仍不满足结构要求（${result.problems.join('；') || '无法解析 JSON'}），已采用尽力结果。`,
          'system',
        );
        sm.finalize(`【✓ ${opts.label}】\n${finalText || '(无输出)'}`);
        return finalText;
      }
      sm.finalize(`【✓ ${opts.label}】\n${clean || '(无输出)'}`);
      return clean;
    }

    sm.finalize(
      clean
        ? `【${opts.label}】\n${clean}`
        : `【${opts.label}】\n（已向你提出一个问题，请在下方作答）`,
    );
    const answer = await callbacks.promptInteraction(req);
    if (!answer || !stillRunning()) return clean;
    appendix += `\n\n${formatAnswerForPrompt(req, answer)}`;
  }

  callbacks.onLog(
    `⚠ ${opts.label}：交互轮数已达上限（${MAX_INTERACTION_ROUNDS}），停止追问。`,
    'system',
  );
  return lastClean;
}
