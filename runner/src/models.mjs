/**
 * Maps an adapter id + (optional client-supplied) model config to the concrete
 * CLI invocation and environment.
 *
 * Key precedence (most specific wins):
 *   1. Per-job apiKey / baseUrl sent by the client.
 *   2. The runner's own env keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...).
 *
 * This is exactly the "用自己的 key" answer in practice: the client can keep
 * sending its own key, OR you keep the key only on the server and clients send
 * nothing sensitive. Both work.
 */

/** @typedef {{adapter:string, model?:string, prompt:string, apiKey?:string, baseUrl?:string}} JobModelSpec */

const ADAPTERS = {
  claude: {
    command: 'claude',
    keyEnv: 'ANTHROPIC_API_KEY',
    baseUrlEnv: 'ANTHROPIC_BASE_URL',
    buildArgs: (spec) => {
      const args = ['-p', spec.prompt];
      if (spec.model) args.push('--model', spec.model);
      return args;
    },
  },
  codex: {
    command: 'codex',
    keyEnv: 'OPENAI_API_KEY',
    baseUrlEnv: 'OPENAI_BASE_URL',
    buildArgs: (spec) => {
      const args = ['exec', spec.prompt];
      if (spec.model) args.push('-m', spec.model);
      return args;
    },
  },
  gemini: {
    command: 'gemini',
    keyEnv: 'GEMINI_API_KEY',
    baseUrlEnv: 'GOOGLE_GEMINI_BASE_URL',
    buildArgs: (spec) => {
      const args = ['-p', spec.prompt];
      if (spec.model) args.push('-m', spec.model);
      return args;
    },
  },
};

export function supportedAdapters() {
  return Object.keys(ADAPTERS);
}

/**
 * Resolve a job spec into a runnable invocation.
 * @param {JobModelSpec} spec
 * @returns {{command:string, args:string[], env:Record<string,string>, missingKey:boolean}}
 */
export function resolveInvocation(spec) {
  const adapter = ADAPTERS[spec.adapter] ?? ADAPTERS.claude;
  const env = {};

  const key = (spec.apiKey ?? '').trim() || process.env[adapter.keyEnv] || '';
  const baseUrl = (spec.baseUrl ?? '').trim() || process.env[adapter.baseUrlEnv] || '';

  if (key) env[adapter.keyEnv] = key;
  if (baseUrl) env[adapter.baseUrlEnv] = baseUrl;

  return {
    command: adapter.command,
    args: adapter.buildArgs(spec),
    env,
    missingKey: !key,
  };
}
