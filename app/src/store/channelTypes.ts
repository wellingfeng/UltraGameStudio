// Channel type definitions for the run/AI-edit streaming engine.
//
// Extracted verbatim from useStore.ts as the first, lowest-risk step of the
// streaming-logic decomposition (architect M3). This file is TYPE-ONLY: it has
// no runtime code and imports nothing from useStore, so it cannot participate in
// the store import cycle. useStore.ts re-exports these names, so existing
// `import type { AiEditChannel } from './useStore'` sites keep working unchanged.
import type { GatewaySelection, IRGraph } from '@/core/ir';
import type { Message, NodeRunState } from './types';

export interface RunConfig {
  cwd?: string;
  extraWorkspacePaths?: string[];
  permission?: string;
  model?: string;
  cliCommand?: string;
  gatewaySelection?: GatewaySelection;
}

/**
 * A run is bound to the session that started it — NOT to whatever session the
 * user is currently viewing. This channel is that run's single source of truth:
 * the run loop reads/writes the shadow state here, and `channelCommit` mirrors it
 * into the live store ONLY while the owning session is the active view, and
 * persists it to the owning session regardless. That decoupling is what lets a
 * run keep executing in the background after the user switches to another
 * session (and resume seamlessly when they switch back). Multiple sessions may
 * have their own channels so independent workflow blueprints can run together.
 */
export interface RunChannel {
  key: string;
  workspaceId: string | null;
  sessionId: string | null;
  cancelled: boolean;
  workflow: IRGraph;
  config: RunConfig;
  cliRunIds: Set<string>;
  messages: Message[];
  runState: Record<string, NodeRunState>;
  runOutputs: Record<string, string>;
  failedNodeId: string | null;
  error: Record<string, unknown> | null;
  /**
   * Per-node content hashes from this run (runtime `computeNodeHashes`). Captured
   * when the run finishes and persisted in the run snapshot, so the next
   * "continue" reuses a cached node output only when its hash still matches —
   * editing the graph re-runs the affected subgraph. Absent until the run ends.
   */
  nodeHashes?: Record<string, string>;
}

export interface AiEditChannel {
  key: string;
  sessionKey: string;
  workspaceId: string | null;
  sessionId: string | null;
  /** Filesystem root used for this turn's session-change snapshot. */
  workspaceRootPath?: string | null;
  workflow: IRGraph;
  messages: Message[];
  cliRunIds: Set<string>;
  abortController: AbortController;
  /** Gateway/model snapshot captured when this AI turn started. */
  gatewaySelection?: GatewaySelection;
  /** Whether this channel belongs to a history session that should store IRGraph. */
  workflowSession: boolean;
  /**
   * True for simple-workflow chat turns. Such turns reuse the AI-edit channel
   * plumbing (message persistence, background completion, userInputs commit) but
   * are NOT "blueprint editing": they surface as `chattingSessions` rather than
   * `aiEditingSessions`, so they don't lock the (nonexistent) canvas as
   * read-only. See sendPrompt's simpleMode branch.
   */
  chat?: boolean;
  /**
   * True when this turn is driven programmatically (e.g. the UGS_GEN protocol
   * runs a generation action from inside the chat loop) rather than by the user
   * clicking a generation button in the composer. A background turn still
   * persists its results, but `aiEditViewActive` returns false for it so its
   * two-message shadow view never flashes over the live chat bubble that is
   * driving it.
   */
  background?: boolean;
  /** Message ids created by this chat turn; used to merge concurrent replies. */
  ownedMessageIds?: Set<string>;
  /** Current reply bubble; intermediate persistence may already set completedAt. */
  activeAssistantMessageId?: string;
  /**
   * Active CLI run with native steering. The explicit lightning action can steer a
   * queued follow-up into this turn without cancelling it. Normal sends remain
   * in the per-session FIFO queue.
   *
   * `native: true` means the CLI has a real in-turn steer channel (codex
   * `turn/steer`, claude stream-json stdin, zcode `session/send`). `native:
   * false` is the queue-steer fallback for adapters without one (gemini, kimi,
   * grok, dsh, …): the queued message is confirmed immediately and leaves the
   * "pending" badge, then rides the existing FIFO + full-history replay so it
   * fires right after the current turn drains.
   */
  liveSteer?: {
    adapter: GatewaySelection['adapter'];
    runId: string;
    accepting: boolean;
    native: boolean;
  };
}

export interface ChatNativeSession {
  sessionId: string;
  started: boolean;
  coveredMessageCount: number;
}

