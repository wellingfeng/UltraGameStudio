import { useMemo, useRef, useState } from 'react';
import { Cloud, Loader2, Trash2, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { t, type Locale } from '@/lib/i18n';
import {
  RunnerClient,
  deleteRemoteWorkspace,
  readRemoteSecrets,
  remoteWorkspacePath,
  saveRemoteWorkspace,
  type RemoteAdapter,
  type RemoteWorkspaceConfig,
} from '@/lib/remoteWorkspace';

/**
 * Configure (create or edit) a remote workspace that points at a self-hosted
 * Runner. On save it persists non-secret config to localStorage and secrets to
 * the keychain, then hands back the synthetic remote://<id> path so the caller
 * can register/select it like any other workspace.
 */
export interface RemoteWorkspaceDialogProps {
  locale: Locale;
  existing?: RemoteWorkspaceConfig | null;
  onClose: () => void;
  onSaved: (remotePath: string, config: RemoteWorkspaceConfig) => void;
  onDeleted?: (id: string) => void;
}

const ADAPTERS: RemoteAdapter[] = ['claude', 'codex', 'gemini'];

type TestState = 'idle' | 'testing' | 'ok' | 'fail';

export default function RemoteWorkspaceDialog({
  locale,
  existing = null,
  onClose,
  onSaved,
  onDeleted,
}: RemoteWorkspaceDialogProps) {
  const initialSecrets = useMemo(
    () => (existing ? readRemoteSecrets(existing.id) : null),
    [existing],
  );

  const [label, setLabel] = useState(existing?.label ?? '');
  const [serverUrl, setServerUrl] = useState(existing?.serverUrl ?? '');
  const [token, setToken] = useState(initialSecrets?.token ?? '');
  const [repoUrl, setRepoUrl] = useState(existing?.repoUrl ?? '');
  const [branch, setBranch] = useState(existing?.branch ?? '');
  const [pushBranch, setPushBranch] = useState(existing?.pushBranch ?? '');
  const [adapter, setAdapter] = useState<RemoteAdapter>(
    existing?.adapter ?? 'claude',
  );
  const [model, setModel] = useState(existing?.model ?? '');
  const [useOwnModelKey, setUseOwnModelKey] = useState(
    existing?.useOwnModelKey ?? false,
  );
  const [apiKey, setApiKey] = useState(initialSecrets?.apiKey ?? '');
  const [baseUrl, setBaseUrl] = useState(initialSecrets?.baseUrl ?? '');
  const [gitToken, setGitToken] = useState(initialSecrets?.gitToken ?? '');

  const [testState, setTestState] = useState<TestState>('idle');
  const [error, setError] = useState('');
  const testAbort = useRef<AbortController | null>(null);

  const required = label.trim() && serverUrl.trim() && token.trim();

  const handleTest = async () => {
    if (!serverUrl.trim()) return;
    testAbort.current?.abort();
    const controller = new AbortController();
    testAbort.current = controller;
    setTestState('testing');
    const client = new RunnerClient(serverUrl, token);
    const health = await client.health(controller.signal);
    if (controller.signal.aborted) return;
    setTestState(health.ok ? 'ok' : 'fail');
  };

  const handleSave = () => {
    if (!required) {
      setError(t(locale, 'remoteWorkspace.missingRequired'));
      return;
    }
    const config = saveRemoteWorkspace(
      {
        id: existing?.id,
        label,
        serverUrl,
        repoUrl,
        branch,
        pushBranch,
        adapter,
        model,
        useOwnModelKey,
      },
      {
        token,
        apiKey: useOwnModelKey ? apiKey : '',
        baseUrl: useOwnModelKey ? baseUrl : '',
        gitToken,
      },
    );
    onSaved(remoteWorkspacePath(config.id), config);
    onClose();
  };

  const handleDelete = () => {
    if (!existing) return;
    deleteRemoteWorkspace(existing.id);
    onDeleted?.(existing.id);
    onClose();
  };

  const fieldClass =
    'w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs text-fg outline-none transition-colors focus:border-accent';
  const labelClass = 'mb-1 block text-[11px] font-medium text-fg-dim';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-panel shadow-2xl">
        <div className="flex items-center gap-2 border-b border-border-soft px-4 py-3">
          <Cloud size={16} className="text-accent" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-fg">
              {t(locale, 'remoteWorkspace.title')}
            </div>
            <div className="truncate text-[11px] text-fg-faint">
              {t(locale, 'remoteWorkspace.subtitle')}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-fg-faint hover:bg-border-soft hover:text-fg"
            aria-label={t(locale, 'remoteWorkspace.cancel')}
          >
            <X size={15} />
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
          <div>
            <label className={labelClass}>
              {t(locale, 'remoteWorkspace.label')}
            </label>
            <input
              className={fieldClass}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t(locale, 'remoteWorkspace.labelPlaceholder')}
            />
          </div>

          <div>
            <label className={labelClass}>
              {t(locale, 'remoteWorkspace.serverUrl')}
            </label>
            <input
              className={fieldClass}
              value={serverUrl}
              onChange={(e) => {
                setServerUrl(e.target.value);
                setTestState('idle');
              }}
              placeholder="https://your-server:8787"
            />
            <p className="mt-1 text-[10px] text-fg-faint">
              {t(locale, 'remoteWorkspace.serverUrlHint')}
            </p>
          </div>

          <div>
            <label className={labelClass}>
              {t(locale, 'remoteWorkspace.token')}
            </label>
            <input
              type="password"
              className={fieldClass}
              value={token}
              onChange={(e) => {
                setToken(e.target.value);
                setTestState('idle');
              }}
              autoComplete="off"
            />
            <p className="mt-1 text-[10px] text-fg-faint">
              {t(locale, 'remoteWorkspace.tokenHint')}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={labelClass}>
                {t(locale, 'remoteWorkspace.adapter')}
              </label>
              <select
                className={fieldClass}
                value={adapter}
                onChange={(e) => setAdapter(e.target.value as RemoteAdapter)}
              >
                {ADAPTERS.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass}>
                {t(locale, 'remoteWorkspace.model')}
              </label>
              <input
                className={fieldClass}
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
            </div>
          </div>

          <div>
            <label className={labelClass}>
              {t(locale, 'remoteWorkspace.repoUrl')}
            </label>
            <input
              className={fieldClass}
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="https://github.com/me/repo.git"
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={labelClass}>
                {t(locale, 'remoteWorkspace.branch')}
              </label>
              <input
                className={fieldClass}
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
              />
            </div>
            <div>
              <label className={labelClass}>
                {t(locale, 'remoteWorkspace.pushBranch')}
              </label>
              <input
                className={fieldClass}
                value={pushBranch}
                onChange={(e) => setPushBranch(e.target.value)}
              />
            </div>
          </div>

          <div>
            <label className={labelClass}>
              {t(locale, 'remoteWorkspace.gitToken')}
            </label>
            <input
              type="password"
              className={fieldClass}
              value={gitToken}
              onChange={(e) => setGitToken(e.target.value)}
              autoComplete="off"
            />
          </div>

          <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border-soft bg-bg px-2.5 py-2">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={useOwnModelKey}
              onChange={(e) => setUseOwnModelKey(e.target.checked)}
            />
            <span className="text-[11px] leading-snug text-fg-dim">
              {t(locale, 'remoteWorkspace.useOwnKey')}
            </span>
          </label>

          {useOwnModelKey && (
            <div className="space-y-3 rounded-md border border-border-soft bg-bg/60 px-2.5 py-2.5">
              <div>
                <label className={labelClass}>
                  {t(locale, 'remoteWorkspace.apiKey')}
                </label>
                <input
                  type="password"
                  className={fieldClass}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  autoComplete="off"
                />
              </div>
              <div>
                <label className={labelClass}>
                  {t(locale, 'remoteWorkspace.baseUrl')}
                </label>
                <input
                  className={fieldClass}
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                />
              </div>
            </div>
          )}

          {error && <p className="text-[11px] text-rose-400">{error}</p>}
        </div>

        <div className="flex items-center gap-2 border-t border-border-soft px-4 py-3">
          <button
            type="button"
            onClick={() => void handleTest()}
            disabled={!serverUrl.trim() || testState === 'testing'}
            className={cn(
              'flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition-colors disabled:opacity-40',
              testState === 'ok'
                ? 'border-emerald-500/50 text-emerald-400'
                : testState === 'fail'
                  ? 'border-rose-500/50 text-rose-400'
                  : 'border-border text-fg-dim hover:border-accent hover:text-fg',
            )}
          >
            {testState === 'testing' && (
              <Loader2 size={12} className="animate-spin" />
            )}
            <span>
              {testState === 'testing'
                ? t(locale, 'remoteWorkspace.testing')
                : testState === 'ok'
                  ? t(locale, 'remoteWorkspace.testOk')
                  : testState === 'fail'
                    ? t(locale, 'remoteWorkspace.testFail')
                    : t(locale, 'remoteWorkspace.test')}
            </span>
          </button>

          {existing && (
            <button
              type="button"
              onClick={handleDelete}
              title={t(locale, 'remoteWorkspace.delete')}
              className="flex items-center gap-1 rounded-md border border-border px-2 py-1.5 text-xs text-rose-400 transition-colors hover:border-rose-500/50"
            >
              <Trash2 size={12} />
            </button>
          )}

          <div className="flex-1" />

          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-3 py-1.5 text-xs text-fg-dim hover:text-fg"
          >
            {t(locale, 'remoteWorkspace.cancel')}
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!required}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-40"
          >
            {t(locale, 'remoteWorkspace.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
