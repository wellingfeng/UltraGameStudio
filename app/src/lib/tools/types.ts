/** Runtime evidence only. A catalogue never grants execution permission. */
export interface ToolCatalogScope {
  workspaceId: string;
  sessionId: string;
  agentId: string;
  providerId: string;
  channelId: string;
  model: string;
}

export interface McpToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  [extension: string]: unknown;
}

export interface ToolDescriptor {
  toolId: string;
  originalName: string;
  wireName?: string;
  providerId: string;
  serverId?: string;
  origin: 'builtin' | 'mcp' | 'plugin' | 'sdk' | 'host' | 'unknown';
  owner: 'agent' | 'ugs-probe';
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  discovery: 'live' | 'cached' | 'observed' | 'unknown';
  selected: 'yes' | 'no' | 'unknown';
  exposure: 'direct' | 'search' | 'code' | 'unknown';
  connection: 'connected' | 'disconnected' | 'unknown';
  permission: 'agent-managed' | 'unknown';
  evidence: string;
  lastSeenAtMs: number;
  lastCall?: { atMs: number; status: string };
}

export interface ToolCatalogCoverage {
  source: string;
  level: 'full' | 'names' | 'observed' | 'unknown';
  reason: string;
}

export interface ToolCatalogSnapshot {
  schemaVersion: 1;
  scope: ToolCatalogScope;
  runId: string;
  startedAtMs: number;
  updatedAtMs: number;
  revision: number;
  active: boolean;
  tools: ToolDescriptor[];
  coverage: ToolCatalogCoverage[];
}

export interface ToolCatalogCapabilities {
  sessionNames: boolean;
  mcpMetadata: boolean;
  schema: boolean;
  policy: false;
  reload: false;
  reason: string;
}

/** A new adapter implements this port; the panel is protocol-independent. */
export interface ToolCatalogPort {
  describeCapabilities(agentId: string): ToolCatalogCapabilities;
  listCatalog(scope: ToolCatalogScope): Promise<ToolCatalogSnapshot | null>;
}
