import { useMemo, useRef, useState } from 'react';
import { Cloud, Loader2, Plus, Trash2, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { t, type Locale } from '@/lib/i18n';
import {
  RunnerClient,
  deleteRemoteWorkspace,
  readRemoteRunnerConnection,
  readRemoteRunnerConnectionSecrets,
  readRemoteSecrets,
  refreshRemoteWorkspaceAccounts,
  remoteWorkspacePath,
  saveRemoteWorkspace,
  saveRemoteRunnerConnection,
  syncRemoteWorkspaceAccounts,
  type RemoteAdapter,
  type RemoteRunnerUsage,
  type RemoteWorkspaceConfig,
} from '@/lib/remoteWorkspace';

/**
 * Configure (create or edit) a remote Runner project. The client stores
 * connection + project metadata; the Runner owns the real workspace path.
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

function normalizedServerUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

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
  const initialConnection = useMemo(() => readRemoteRunnerConnection(), []);
  const initialConnectionSecrets = useMemo(
    () => readRemoteRunnerConnectionSecrets(),
    [],
  );

  const [label, setLabel] = useState(existing?.label ?? '');
  const [serverUrl, setServerUrl] = useState(
    initialConnection?.serverUrl ?? existing?.serverUrl ?? '',
  );
  const [token, setToken] = useState(
    initialConnectionSecrets.token || initialSecrets?.token || '',
  );
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
  const [runnerUsage, setRunnerUsage] = useState<RemoteRunnerUsage | null>(null);
  const [accountLabel, setAccountLabel] = useState('');
  const [accountId, setAccountId] = useState('');
  const [accountAdapter, setAccountAdapter] = useState<RemoteAdapter>('claude');
  const [accountModel, setAccountModel] = useState('');
  const [accountApiKey, setAccountApiKey] = useState('');
  const [savingAccount, setSavingAccount] = useState(false);
  const [savingProject, setSavingProject] = useState(false);
  const [editingConnection, setEditingConnection] = useState(false);
  const [editingGitCredential, setEditingGitCredential] = useState(false);
  const testAbort = useRef<AbortController | null>(null);

  const connectionReady = Boolean(serverUrl.trim() && token.trim());
  const required = Boolean(label.trim() && connectionReady && repoUrl.trim());

  const handleTest = async () => {
    if (!serverUrl.trim()) return;
    testAbort.current?.abort();
    const controller = new AbortController();
    testAbort.current = controller;
    setTestState('testing');
    setRunnerUsage(null);
    const client = new RunnerClient(serverUrl, token);
    const health = await client.health(controller.signal);
    if (controller.signal.aborted) return;
    setTestState(health.ok ? 'ok' : 'fail');
    if (health.ok) {
      saveRemoteRunnerConnection({ serverUrl }, { token });
      setEditingConnection(false);
      try {
        const usage = await client.usage();
        const scopedAccounts = usage.accounts.filter((account) => {
          const projectId = account.projectId?.trim();
          return !projectId || projectId === existing?.projectId;
        });
        setRunnerUsage({ ...usage, accounts: scopedAccounts });
        if (existing) {
          syncRemoteWorkspaceAccounts(
            { ...existing, serverUrl: normalizedServerUrl(serverUrl) },
            scopedAccounts,
          );
        }
      } catch {
        const scopedAccounts = (health.accounts ?? []).filter((account) => {
          const projectId = account.projectId?.trim();
          return !projectId || projectId === existing?.projectId;
        });
        setRunnerUsage({
          ok: true,
          totals: health.usage ?? {
            inputTokens: 0,
            outputTokens: 0,
            cachedInputTokens: 0,
            totalTokens: 0,
            calls: 0,
          },
          accounts: scopedAccounts,
          recentJobs: [],
        });
        if (existing && health.accounts) {
          syncRemoteWorkspaceAccounts(
            { ...existing, serverUrl: normalizedServerUrl(serverUrl) },
            scopedAccounts,
          );
        }
      }
    }
  };

  const handleSave = async () => {
    if (!required) {
      if (!connectionReady) setEditingConnection(true);
      setError(t(locale, 'remoteWorkspace.missingRequired'));
      return;
    }
    setSavingProject(true);
    setError('');
    try {
      const connection = saveRemoteRunnerConnection(
        { serverUrl },
        { token },
      );
      const client = new RunnerClient(serverUrl, token);
      const project = await client.saveProject({
        id: existing?.projectId,
        label,
        repoUrl,
        branch: branch.trim() || undefined,
        pushBranch: pushBranch.trim() || undefined,
        adapter,
        model: model.trim() || undefined,
        gitToken: gitToken.trim() || undefined,
      });
      const config = saveRemoteWorkspace(
        {
          id: existing?.id,
          label: project.label,
          serverUrl: connection.serverUrl,
          projectId: project.id,
          repoUrl: project.repoUrl,
          branch: project.branch ?? undefined,
          pushBranch: project.pushBranch ?? undefined,
          adapter: (project.adapter as RemoteAdapter | undefined) ?? adapter,
          model: project.model ?? undefined,
          useOwnModelKey,
        },
        {
          token: undefined,
          apiKey: useOwnModelKey ? apiKey : '',
          baseUrl: useOwnModelKey ? baseUrl : '',
          gitToken,
        },
      );
      void refreshRemoteWorkspaceAccounts(config).catch(() => undefined);
      onSaved(remoteWorkspacePath(config.id), config);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingProject(false);
    }
  };

  const handleAddAccount = async () => {
    if (!serverUrl.trim() || !token.trim() || !accountLabel.trim()) return;
    setSavingAccount(true);
    setError('');
    try {
      const id = accountId.trim() || accountLabel.trim();
      const client = new RunnerClient(serverUrl, token);
      const account = await client.saveAccount({
        id,
        projectId: existing?.projectId ?? undefined,
        label: accountLabel,
        adapter: accountAdapter,
        model: accountModel.trim() || undefined,
        apiKey: accountApiKey.trim() || undefined,
      });
      setAccountLabel('');
      setAccountId('');
      setAccountModel('');
      setAccountApiKey('');
      const usage = await client.usage();
      const scopedAccounts = usage.accounts.filter((item) => {
        const projectId = item.projectId?.trim();
        return !projectId || projectId === existing?.projectId;
      });
      setRunnerUsage({ ...usage, accounts: scopedAccounts });
      if (existing) {
        syncRemoteWorkspaceAccounts(
          { ...existing, serverUrl: normalizedServerUrl(serverUrl) },
          scopedAccounts,
          { makeActiveAccountId: account.id },
        );
      }
      setTestState('ok');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingAccount(false);
    }
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

          <div className="rounded-md border border-border-soft bg-bg/60 px-2.5 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[11px] font-medium text-fg">
                  {t(locale, 'remoteWorkspace.connectionTitle')}
                </div>
                <div className="mt-0.5 truncate text-[10px] text-fg-faint">
                  {connectionReady
                    ? t(locale, 'remoteWorkspace.connectionReady')
                    : t(locale, 'remoteWorkspace.connectionMissing')}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setEditingConnection((v) => !v)}
                className="shrink-0 rounded-md border border-border px-2 py-1 text-[11px] text-fg-dim hover:border-accent hover:text-fg"
              >
                {editingConnection
                  ? t(locale, 'remoteWorkspace.connectionHide')
                  : t(locale, 'remoteWorkspace.connectionEdit')}
              </button>
            </div>

            {editingConnection && (
              <div className="mt-3 space-y-3">
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
                      setRunnerUsage(null);
                    }}
                    placeholder="http://150.158.47.232:8787"
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
                      setRunnerUsage(null);
                    }}
                    autoComplete="off"
                  />
                  <p className="mt-1 text-[10px] text-fg-faint">
                    {t(locale, 'remoteWorkspace.tokenHint')}
                  </p>
                </div>
              </div>
            )}
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

          <div className="rounded-md border border-border-soft bg-bg/60 px-2.5 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[11px] font-medium text-fg">
                  {t(locale, 'remoteWorkspace.gitCredentialTitle')}
                </div>
                <div className="mt-0.5 truncate text-[10px] text-fg-faint">
                  {gitToken
                    ? t(locale, 'remoteWorkspace.gitCredentialReady')
                    : t(locale, 'remoteWorkspace.gitCredentialHint')}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setEditingGitCredential((v) => !v)}
                className="shrink-0 rounded-md border border-border px-2 py-1 text-[11px] text-fg-dim hover:border-accent hover:text-fg"
              >
                {editingGitCredential
                  ? t(locale, 'remoteWorkspace.connectionHide')
                  : t(locale, 'remoteWorkspace.gitCredentialEdit')}
              </button>
            </div>

            {editingGitCredential && (
              <div className="mt-3">
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
            )}
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

          {runnerUsage && (
            <div className="rounded-md border border-border-soft bg-bg/60 px-2.5 py-2.5">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium text-fg">
                  {t(locale, 'remoteWorkspace.usageTitle')}
                </span>
                <span className="text-[10px] text-fg-faint">
                  {formatTokens(runnerUsage.totals.totalTokens)} tokens
                </span>
              </div>
              {runnerUsage.accounts.length > 0 ? (
                <div className="space-y-1.5">
                  {runnerUsage.accounts.slice(0, 4).map((account) => (
                    <div
                      key={account.id}
                      className="flex items-center justify-between gap-2 rounded border border-border-soft/70 px-2 py-1.5 text-[10px]"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-fg-dim">
                          {account.label}
                        </div>
                        <div className="truncate text-fg-faint">
                          {account.adapter}
                          {account.model ? ` · ${account.model}` : ''}
                          {account.hasApiKey ? '' : ` · ${t(locale, 'remoteWorkspace.keyMissing')}`}
                        </div>
                      </div>
                      <div className="shrink-0 text-right text-fg-faint">
                        {formatTokens(account.usage?.totalTokens ?? 0)}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-[10px] text-fg-faint">
                  {t(locale, 'remoteWorkspace.noAccounts')}
                </div>
              )}
            </div>
          )}

          {testState === 'ok' && (
            <div className="rounded-md border border-border-soft bg-bg/60 px-2.5 py-2.5">
              <div className="mb-2 text-[11px] font-medium text-fg">
                {t(locale, 'remoteWorkspace.addAccount')}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input
                  className={fieldClass}
                  value={accountLabel}
                  onChange={(e) => setAccountLabel(e.target.value)}
                  placeholder={t(locale, 'remoteWorkspace.accountLabel')}
                />
                <input
                  className={fieldClass}
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value)}
                  placeholder={t(locale, 'remoteWorkspace.accountId')}
                />
                <select
                  className={fieldClass}
                  value={accountAdapter}
                  onChange={(e) => setAccountAdapter(e.target.value as RemoteAdapter)}
                >
                  {ADAPTERS.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
                <input
                  className={fieldClass}
                  value={accountModel}
                  onChange={(e) => setAccountModel(e.target.value)}
                  placeholder={t(locale, 'remoteWorkspace.accountModel')}
                />
                <input
                  type="password"
                  className="col-span-2 w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs text-fg outline-none transition-colors focus:border-accent"
                  value={accountApiKey}
                  onChange={(e) => setAccountApiKey(e.target.value)}
                  placeholder={t(locale, 'remoteWorkspace.accountApiKey')}
                  autoComplete="off"
                />
              </div>
              <button
                type="button"
                onClick={() => void handleAddAccount()}
                disabled={savingAccount || !accountLabel.trim()}
                className="mt-2 flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-fg-dim transition-colors hover:border-accent hover:text-fg disabled:opacity-40"
              >
                {savingAccount ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Plus size={12} />
                )}
                <span>{t(locale, 'remoteWorkspace.addAccountAction')}</span>
              </button>
            </div>
          )}

          {error && <p className="text-[11px] text-rose-400">{error}</p>}
        </div>

        <div className="flex items-center gap-2 border-t border-border-soft px-4 py-3">
          {editingConnection && (
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
          )}

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
            onClick={() => void handleSave()}
            disabled={!required || savingProject}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-40"
          >
            {savingProject
              ? t(locale, 'remoteWorkspace.saving')
              : t(locale, 'remoteWorkspace.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}
