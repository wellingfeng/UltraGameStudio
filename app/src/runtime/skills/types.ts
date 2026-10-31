/** Wire contract shared by the pure skill runtime and injected filesystem hosts.
 * Models never select a root, actor, permission, or workspace. Hosts bind those.
 */
export interface SkillOrigin {
  hostId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  runId: string;
  cwd?: string;
}

export type SkillLearningMode = 'auto-safe' | 'approve-all' | 'off';
export type SkillEvidenceProvenance = 'native-tool' | 'host-check' | 'user-input' | 'model-output' | 'ui-synthetic' | 'fixture';
export interface SkillEvidence {
  evidenceId: string;
  origin: SkillOrigin;
  occurredAt: number;
  kind: 'tool' | 'verification' | 'artifact' | 'correction' | 'skill-use';
  provenance: SkillEvidenceProvenance;
  toolCallId?: string;
  toolName?: string;
  parentId?: string;
  status: 'success' | 'error' | 'unknown';
  exitCode?: number | null;
  summary: string;
  result?: string;
  path?: string;
  skillId?: string;
  revision?: string;
}

export interface SkillUsage {
  viewed: number;
  delivered: number;
  usedWithEvidence: number;
  lastActivityAt?: number;
}
export interface SkillEntry {
  skillId: string;
  rootId: string;
  name: string;
  description: string;
  scope: 'project' | 'global' | 'external';
  source: string;
  relativePath: string;
  revision: string;
  hash: string;
  readOnly: boolean;
  autoEditable: boolean;
  contentLocked: boolean;
  pinned: boolean;
  state: 'active' | 'stale' | 'archived';
  files: string[];
  usage?: SkillUsage;
}
export interface SkillCatalog {
  revision: string;
  entries: SkillEntry[];
}
export interface SkillReadRequest {
  skillId: string;
  filePath?: string;
}
export interface SkillReadResult {
  entry: SkillEntry;
  relativePath: string;
  content: string;
  revision: string;
  hash: string;
  fullRead: true;
  readReceiptId: string;
  files: string[];
}

export type SkillOperation =
  | { action: 'create'; name: string; content: string }
  | { action: 'patch'; skillId: string; filePath?: string; oldString: string; newString: string; expectedHash: string; readReceiptId: string }
  | { action: 'write_file'; skillId: string; filePath: string; content: string; expectedHash?: string; readReceiptId?: string; absent?: true }
  | { action: 'remove_file'; skillId: string; filePath: string; expectedHash: string; readReceiptId: string };
export interface SkillProposal {
  version: 1;
  kind: 'propose';
  lesson: string;
  evidenceIds: string[];
  operations: SkillOperation[];
}
export type SkillReviewMessage =
  | { version: 1; kind: 'read'; requests: SkillReadRequest[] }
  | SkillProposal
  | { version: 1; kind: 'noop'; reason: string };

export interface SkillDiff {
  skillId: string;
  name: string;
  filePath: string;
  before: string | null;
  after: string | null;
  beforeHash: string | null;
  afterHash: string | null;
}
export type SkillMutationStatus = 'applied' | 'awaiting_approval' | 'noop' | 'conflicted' | 'failed' | 'needs_recovery' | 'cancelled' | 'rejected';
export interface SkillReviewUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimated: boolean;
  calls: number;
}
export interface SkillMutationResult {
  status: SkillMutationStatus;
  batchId: string;
  origin: SkillOrigin;
  lesson: string;
  operationsApplied: number;
  changes: SkillDiff[];
  riskReasons: string[];
  revision?: string;
  rollbackId?: string;
  error?: string;
  usage?: SkillReviewUsage;
  createdAt?: number;
}
/** UI-only locator for a remote source in a local history bucket; never host authority. */
export interface SkillSourceSession {
  workspaceId: string;
  sessionId: string;
  /** Frozen client endpoint without credentials. */
  serverUrl: string;
}
export interface SkillReviewState {
  status: 'queued' | 'reading' | 'proposing' | 'applying' | SkillMutationStatus;
  origin: SkillOrigin;
  /** Kept out of provider payloads and remote service requests. */
  sourceSession?: SkillSourceSession;
  /** Policy frozen by the host for this review, not the current composer. */
  mode?: SkillLearningMode;
  /** Host-only scheduling decision; never inferred from model-authored lesson/reason text. */
  admission?: { status: 'not-admitted'; reason: string; completedActivities: number; activityThreshold: number };
  /** UI action context, retained on history reload; rollback is an applied transaction, not new learning. */
  action?: 'review' | 'approve' | 'reject' | 'rollback';
  /** Only trusted host mutation results prove persistence. */
  result?: SkillMutationResult;
  error?: string;
  /** Redacted host snapshot for restart/retry; never reconstructed from assistant text. */
  resume?: { job: SkillLearningJob; selection: import('@/core/ir').GatewaySelection };
  queuedAt?: number;
  updatedAt?: number;
  detail?: string;
}

export interface SkillLearningConfig {
  enabled: boolean;
  mode: SkillLearningMode;
  activityThreshold: number;
  cooldownMs: number;
  maxRounds: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  timeoutMs: number;
  autoArchive: boolean;
  staleAfterDays: number;
  archiveAfterDays: number;
  /** Explicit completion-only protocol; never changes foreground CLI execution. */
  reviewTransport?: 'anthropic' | 'openai-compatible';
  reviewSelection?: { adapter: string; modelClass: string; providerId?: string; channelId?: string; model?: string };
}

/** Constructed by the trusted host for ONE review/execution origin. */
export interface SkillHostPort {
  list(): Promise<SkillCatalog>;
  view(request: SkillReadRequest): Promise<SkillReadResult>;
  manage(proposal: SkillProposal): Promise<SkillMutationResult>;
  recordUsage?(skillId: string, kind: 'viewed' | 'delivered' | 'used-with-evidence', evidenceIds?: string[]): Promise<void>;
}
export interface SkillModelRequest {
  system: string;
  userContent: string;
  signal: AbortSignal;
  timeoutMs: number;
  maxOutputTokens: number;
}
export interface SkillModelResult {
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; estimated?: boolean };
}
export interface SkillReviewModelPort {
  capability: 'completion-only';
  complete(request: SkillModelRequest): Promise<SkillModelResult>;
}
export interface SkillLearningJob {
  origin: SkillOrigin;
  userText: string;
  finalAnswer: string;
  evidence: SkillEvidence[];
  loadedSkills: Array<{ skillId: string; revision: string; hash: string; files: string[] }>;
  config: SkillLearningConfig;
  focus?: string;
  explicit?: boolean;
}
export interface SkillNativeToolEvent {
  runId: string;
  toolCallId: string;
  toolName: string;
  phase: 'start' | 'end';
  provenance: SkillEvidenceProvenance;
  occurredAt?: number;
  parentId?: string;
  args?: unknown;
  result?: string;
  status?: 'success' | 'error' | 'unknown';
  exitCode?: number | null;
}
