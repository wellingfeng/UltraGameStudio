import { useEffect, useMemo, useRef, useState } from 'react';
import { Cloud, Loader2, Plus, Trash2, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { CLOUD_PROJECTS_ENABLED } from '@/lib/cloudProjects';
import { t, type Locale } from '@/lib/i18n';
import {
  RunnerClient,
  deleteRemoteWorkspace,
  getRemoteRunnerAuthUser,
  readRemoteRunnerConnection,
  readRemoteRunnerConnectionSecrets,
  readRemoteSecrets,
  refreshRemoteWorkspaceAccounts,
  refreshRemoteRunnerAuthSession,
  saveRemoteRunnerAuthSession,
  refreshRemoteWorkspaceSkills,
  remoteWorkspacePath,
  saveRemoteWorkspace,
  saveRemoteRunnerConnection,
  syncRemoteWorkspaceAccounts,
  type RemoteAdapter,
  type RemoteRunnerAuthSession,
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
type AuthMode = 'token' | 'email';
type EmailAuthStep = 'login' | 'register' | 'verify' | 'reset';

function normalizedServerUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

// 云端项目已退役：不挂载旧表单，其 hooks 和自动连接均不再执行。
export default function RemoteWorkspaceDialog(props: RemoteWorkspaceDialogProps) {
  if (!CLOUD_PROJECTS_ENABLED) return null;
  return <RetiredRemoteWorkspaceDialog {...props} />;
}

// 原云端表单保留，便于查阅历史实现。
function RetiredRemoteWorkspaceDialog({
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
  // 预填内置默认云端 Runner（官方测试服务器地址 + 共享 Token），
  // 这样「添加云端项目」打开即带出可用连接，用户无需每次手填 Token，
  // 保存按钮也不再因连接未就绪而置灰。仍可被用户覆盖。
  // 注意：空白对话框不会误存出幽灵云端工作区——保存要求 label + repoUrl
  // 都非空（见 required），而启动期 purgeDefaultRemoteWorkspaces 只清理
  // 没有 repoUrl/projectId 的纯空壳，不会误删用默认 Token 保存的真实项目。
  const initialConnection = useMemo(
    () => readRemoteRunnerConnection({ allowDefault: true }),
    [],
  );
  const initialConnectionSecrets = useMemo(
    () => readRemoteRunnerConnectionSecrets({ allowDefault: true }),
    [],
  );

  const [label, setLabel] = useState(existing?.label ?? '');
  const [serverUrl, setServerUrl] = useState(
    initialConnection?.serverUrl ?? existing?.serverUrl ?? '',
  );
  const [token, setToken] = useState(
    initialConnectionSecrets.token || initialSecrets?.token || '',
  );
  const [authMode, setAuthMode] = useState<AuthMode>(
    initialConnectionSecrets.userEmail ? 'email' : 'token',
  );
  const [authStep, setAuthStep] = useState<EmailAuthStep>('login');
  const [authEmail, setAuthEmail] = useState(initialConnectionSecrets.userEmail ?? '');
  const [authPassword, setAuthPassword] = useState('');
  const [authCode, setAuthCode] = useState('');
  const [authUserLabel, setAuthUserLabel] = useState(
    initialConnectionSecrets.userEmail ?? '',
  );
  // 后端分配的账号名（displayName）。门禁验证通过后展示给用户。
  const [authUserName, setAuthUserName] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [repoUrl, setRepoUrl] = useState(existing?.repoUrl ?? '');
  const [branch, setBranch] = useState(existing?.branch ?? '');
  const [pushBranch, setPushBranch] = useState(existing?.pushBranch ?? '');
  const [adapter, setAdapter] = useState<RemoteAdapter>(
    existing?.adapter ?? 'claude',
  );
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

  // 身份门禁：新建云端项目时，必须先通过邮箱验证、由后端分配账号后，
  // 才展示云端项目配置表单。以下情况视为已通过门禁，直接放行：
  //  1) 正在编辑一个已存在的云端项目（existing）；
  //  2) 本地已保存可用的邮箱登录态（有 refreshToken + 已验证邮箱）。
  // 纯 Token 模式不强制门禁（无邮箱体系），但新建项目仍鼓励先登录。
  const hasExistingEmailSession = Boolean(
    initialConnectionSecrets.userEmail && initialConnectionSecrets.refreshToken,
  );
  const [gatePassed, setGatePassed] = useState<boolean>(
    Boolean(existing) || hasExistingEmailSession,
  );

  const connectionReady = Boolean(serverUrl.trim() && token.trim());
  const required = Boolean(label.trim() && connectionReady && repoUrl.trim());
  const authToken = token.trim();
  const connectionSecretsForSave = () => {
    const current = readRemoteRunnerConnectionSecrets({ allowDefault: false });
    if (authMode === 'email') {
      return {
        ...current,
        token: authToken,
        userEmail: authUserLabel || authEmail || current.userEmail,
      };
    }
    return { token: authToken, refreshToken: '', userEmail: '' };
  };
  const runnerTokenForAction = async () => {
    if (authMode !== 'email') return authToken;
    const refreshed = await refreshRemoteRunnerAuthSession(serverUrl);
    if (!refreshed?.accessToken) return authToken;
    setToken(refreshed.accessToken);
    setAuthUserLabel(refreshed.user.email);
    return refreshed.accessToken;
  };

  // 「默认 Agent」从服务器账号派生：服务器上实际存在的账号决定可选 Agent。
  // 没有连接或没测出账号时，回退到全量 ADAPTERS，保证仍可手选。模型不再由项目
  // 级配置，运行时跟随所选服务器账号，避免出现「Agent 与模型不匹配」(如
  // codex + claude-opus-4-8) 导致后端 503。
  const availableAdapters = useMemo<RemoteAdapter[]>(() => {
    const accounts = runnerUsage?.accounts ?? [];
    const fromAccounts = ADAPTERS.filter((a) =>
      accounts.some((account) => account.adapter === a),
    );
    return fromAccounts.length > 0 ? fromAccounts : ADAPTERS;
  }, [runnerUsage]);

  // 若当前选中的 Agent 不在服务器派生出的可选列表里，自动归正到第一个可用 Agent，
  // 杜绝保存出服务器上没有对应账号的 Agent。
  useEffect(() => {
    if (!availableAdapters.includes(adapter)) {
      setAdapter(availableAdapters[0]);
    }
  }, [availableAdapters, adapter]);

  const handleTest = async () => {
    if (!serverUrl.trim()) return;
    testAbort.current?.abort();
    const controller = new AbortController();
    testAbort.current = controller;
    setTestState('testing');
    setRunnerUsage(null);
    const currentToken = await runnerTokenForAction();
    const client = new RunnerClient(serverUrl, currentToken);
    const health = await client.health(controller.signal);
    if (controller.signal.aborted) return;
    setTestState(health.ok ? 'ok' : 'fail');
    if (health.ok) {
      if (health.authMode === 'multiuser' && !currentToken) {
        setAuthMode('email');
        setEditingConnection(true);
        setError(t(locale, 'remoteWorkspace.emailLoginRequired'));
        setTestState('fail');
        return;
      }
      saveRemoteRunnerConnection(
        { serverUrl },
        { ...connectionSecretsForSave(), token: currentToken },
      );
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

  // 验证/登录成功后统一落地会话：保存登录态、记录后端分配的账号名，并放行门禁。
  const applyAuthSession = (session: RemoteRunnerAuthSession) => {
    saveRemoteRunnerAuthSession({ serverUrl }, session);
    setToken(session.accessToken);
    setAuthUserLabel(session.user.email);
    setAuthUserName(session.user.displayName?.trim() || session.user.email);
    setTestState('ok');
    setGatePassed(true);
  };

  const handleEmailAuth = async () => {
    if (!serverUrl.trim() || !authEmail.trim()) return;
    setAuthBusy(true);
    setError('');
    try {
      const currentToken = await runnerTokenForAction();
      const client = new RunnerClient(serverUrl, currentToken);
      // 先探测后端是否启用了多用户邮箱认证。未启用时，/auth/* 路由不存在，
      // 直接发注册/登录会撞后端兜底的 404「not found」，对用户毫无意义。
      // 这里提前判断并给出可操作提示（需要后端以 multiuser 模式部署）。
      const health = await client.health();
      if (!health.ok) {
        setError(t(locale, 'remoteWorkspace.gateServerUnreachable'));
        return;
      }
      if (health.authMode !== 'multiuser') {
        setError(t(locale, 'remoteWorkspace.gateMultiuserDisabled'));
        return;
      }
      if (authStep === 'register') {
        // 提交一个由邮箱派生的默认账号名，后端据此分配用户名；
        // 后端在缺省时也会自动分配，这里只是给出更友好的默认值。
        const suggested = authEmail.split('@')[0]?.trim() || undefined;
        await client.register({
          email: authEmail,
          password: authPassword,
          displayName: suggested,
        });
        setAuthStep('verify');
        setError(t(locale, 'remoteWorkspace.emailCodeSent'));
        return;
      }
      if (authStep === 'verify') {
        const session = await client.verifyEmail({ email: authEmail, code: authCode });
        applyAuthSession(session);
        setError(t(locale, 'remoteWorkspace.emailVerified'));
        return;
      }
      if (authStep === 'reset') {
        if (!authCode.trim()) {
          await client.forgotPassword({ email: authEmail });
          setError(t(locale, 'remoteWorkspace.emailCodeSent'));
          return;
        }
        const session = await client.resetPassword({
          email: authEmail,
          code: authCode,
          password: authPassword,
        });
        applyAuthSession(session);
        setAuthStep('login');
        return;
      }
      const session = await client.login({ email: authEmail, password: authPassword });
      applyAuthSession(session);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('email is not verified')) setAuthStep('verify');
      setError(msg);
    } finally {
      setAuthBusy(false);
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
      const currentToken = await runnerTokenForAction();
      const connection = saveRemoteRunnerConnection(
        { serverUrl },
        { ...connectionSecretsForSave(), token: currentToken },
      );
      const client = new RunnerClient(serverUrl, currentToken);
      const project = await client.saveProject({
        id: existing?.projectId,
        label,
        repoUrl,
        branch: branch.trim() || undefined,
        pushBranch: pushBranch.trim() || undefined,
        adapter,
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
          // 模型不再由项目级配置，运行时跟随所选服务器账号。
          model: undefined,
          useOwnModelKey,
          // 用户在对话框里显式保存的云端项目，标记来源，避免启动期清理误删
          // （以及避免被当成「内置默认预填幽灵」处理）。
          userCreated: true,
        },
        {
          token: undefined,
          apiKey: useOwnModelKey ? apiKey : '',
          baseUrl: useOwnModelKey ? baseUrl : '',
          gitToken,
        },
      );
      void refreshRemoteWorkspaceAccounts(config).catch(() => undefined);
      void refreshRemoteWorkspaceSkills(config, { sync: true }).catch(
        () => undefined,
      );
      onSaved(remoteWorkspacePath(config.id), config);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingProject(false);
    }
  };

  const handleAddAccount = async () => {
    const currentToken = await runnerTokenForAction();
    if (!serverUrl.trim() || !currentToken || !accountLabel.trim()) return;
    setSavingAccount(true);
    setError('');
    try {
      const id = accountId.trim() || accountLabel.trim();
      const client = new RunnerClient(serverUrl, currentToken);
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

  useEffect(() => {
    if (!serverUrl.trim() || !token.trim() || authMode !== 'email') return;
    void getRemoteRunnerAuthUser(serverUrl, token).then((user) => {
      if (user?.email) {
        setAuthUserLabel(user.email);
        setAuthEmail(user.email);
      }
    });
  }, [authMode, serverUrl, token]);

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

        {!gatePassed ? (
          <>
            <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
              <div className="rounded-md border border-border-soft bg-bg/60 px-3 py-3">
                <div className="text-sm font-semibold text-fg">
                  {t(locale, 'remoteWorkspace.gateTitle')}
                </div>
                <p className="mt-1 text-[11px] leading-snug text-fg-faint">
                  {t(locale, 'remoteWorkspace.gateSubtitle')}
                </p>
              </div>

              <div>
                <label className={labelClass}>
                  {t(locale, 'remoteWorkspace.gateServerLabel')}
                </label>
                <input
                  className={fieldClass}
                  value={serverUrl}
                  onChange={(e) => {
                    setServerUrl(e.target.value);
                    setTestState('idle');
                  }}
                  placeholder="http://150.158.47.232:8787"
                />
                <p className="mt-1 text-[10px] text-fg-faint">
                  {t(locale, 'remoteWorkspace.serverUrlHint')}
                </p>
              </div>

              <div className="space-y-2 rounded-md border border-border-soft bg-bg/70 p-2.5">
                {authUserName && token ? (
                  <div className="rounded border border-status-success/30 bg-status-success/10 px-2 py-1.5 text-[11px] text-status-success">
                    {t(locale, 'remoteWorkspace.gateAssignedUser')}: {authUserName}
                  </div>
                ) : null}
                <div className="grid grid-cols-2 gap-2">
                  <input
                    className={fieldClass}
                    value={authEmail}
                    onChange={(e) => setAuthEmail(e.target.value)}
                    placeholder={t(locale, 'remoteWorkspace.email')}
                  />
                  {(authStep === 'verify' || authStep === 'reset') && (
                    <input
                      className={fieldClass}
                      value={authCode}
                      onChange={(e) =>
                        setAuthCode(e.target.value.replace(/\D/g, '').slice(0, 6))
                      }
                      placeholder={t(locale, 'remoteWorkspace.emailCode')}
                    />
                  )}
                  {authStep !== 'verify' && (
                    <input
                      type="password"
                      className={fieldClass}
                      value={authPassword}
                      onChange={(e) => setAuthPassword(e.target.value)}
                      placeholder={t(locale, 'remoteWorkspace.password')}
                      autoComplete="off"
                    />
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      if (!serverUrl.trim()) {
                        setError(t(locale, 'remoteWorkspace.gateNeedServer'));
                        return;
                      }
                      setAuthMode('email');
                      void handleEmailAuth();
                    }}
                    disabled={authBusy || !authEmail.trim()}
                    className="rounded-md bg-accent px-3 py-1.5 text-[11px] font-medium text-white hover:bg-accent/90 disabled:opacity-40"
                  >
                    {authBusy
                      ? t(locale, 'remoteWorkspace.saving')
                      : authStep === 'register'
                        ? t(locale, 'remoteWorkspace.register')
                        : authStep === 'verify'
                          ? t(locale, 'remoteWorkspace.verifyEmail')
                          : authStep === 'reset'
                            ? t(locale, 'remoteWorkspace.resetPassword')
                            : t(locale, 'remoteWorkspace.login')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAuthStep(authStep === 'register' ? 'login' : 'register');
                      setAuthCode('');
                    }}
                    className="rounded px-2 py-1 text-[11px] text-fg-faint hover:text-fg"
                  >
                    {authStep === 'register'
                      ? t(locale, 'remoteWorkspace.login')
                      : t(locale, 'remoteWorkspace.register')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAuthStep(authStep === 'reset' ? 'login' : 'reset');
                      setAuthCode('');
                    }}
                    className="rounded px-2 py-1 text-[11px] text-fg-faint hover:text-fg"
                  >
                    {authStep === 'reset'
                      ? t(locale, 'remoteWorkspace.login')
                      : t(locale, 'remoteWorkspace.forgotPassword')}
                  </button>
                  {authStep !== 'verify' ? null : (
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await new RunnerClient(serverUrl, authToken).resendCode({
                            email: authEmail,
                          });
                          setError(t(locale, 'remoteWorkspace.emailCodeSent'));
                        } catch (err) {
                          setError(err instanceof Error ? err.message : String(err));
                        }
                      }}
                      className="rounded px-2 py-1 text-[11px] text-fg-faint hover:text-fg"
                    >
                      {t(locale, 'remoteWorkspace.resendCode')}
                    </button>
                  )}
                </div>
              </div>

              {error && <p className="text-[11px] text-status-error">{error}</p>}
            </div>

            <div className="flex items-center gap-2 border-t border-border-soft px-4 py-3">
              <div className="flex-1" />
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-border px-3 py-1.5 text-xs text-fg-dim hover:text-fg"
              >
                {t(locale, 'remoteWorkspace.cancel')}
              </button>
            </div>
          </>
        ) : (
        <>
        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {authUserName ? (
            <div className="flex items-center justify-between gap-2 rounded-md border border-status-success/30 bg-status-success/10 px-2.5 py-1.5 text-[11px] text-status-success">
              <span className="truncate">
                {t(locale, 'remoteWorkspace.signedInAs')}: {authUserName}
              </span>
              <button
                type="button"
                onClick={() => {
                  setGatePassed(false);
                  setAuthStep('login');
                  setAuthPassword('');
                  setAuthCode('');
                }}
                className="shrink-0 rounded px-2 py-0.5 text-status-success/80 hover:text-status-success"
              >
                {t(locale, 'remoteWorkspace.switchAccount')}
              </button>
            </div>
          ) : null}
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

                <div className="grid grid-cols-2 gap-1 rounded-md border border-border-soft bg-bg p-1">
                  <button
                    type="button"
                    onClick={() => setAuthMode('email')}
                    className={cn(
                      'rounded px-2 py-1 text-[11px]',
                      authMode === 'email'
                        ? 'bg-accent text-white'
                        : 'text-fg-dim hover:text-fg',
                    )}
                  >
                    {t(locale, 'remoteWorkspace.authEmail')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setAuthMode('token')}
                    className={cn(
                      'rounded px-2 py-1 text-[11px]',
                      authMode === 'token'
                        ? 'bg-accent text-white'
                        : 'text-fg-dim hover:text-fg',
                    )}
                  >
                    {t(locale, 'remoteWorkspace.authToken')}
                  </button>
                </div>

                {authMode === 'token' ? (
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
                ) : (
                  <div className="space-y-2 rounded-md border border-border-soft bg-bg/70 p-2.5">
                    {authUserLabel && token ? (
                      <div className="rounded border border-status-success/30 bg-status-success/10 px-2 py-1.5 text-[11px] text-status-success">
                        {t(locale, 'remoteWorkspace.emailLoggedIn')}: {authUserLabel}
                      </div>
                    ) : null}
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        className={fieldClass}
                        value={authEmail}
                        onChange={(e) => setAuthEmail(e.target.value)}
                        placeholder={t(locale, 'remoteWorkspace.email')}
                      />
                      {(authStep === 'verify' || authStep === 'reset') && (
                        <input
                          className={fieldClass}
                          value={authCode}
                          onChange={(e) =>
                            setAuthCode(e.target.value.replace(/\D/g, '').slice(0, 6))
                          }
                          placeholder={t(locale, 'remoteWorkspace.emailCode')}
                        />
                      )}
                      {authStep !== 'verify' && (
                        <input
                          type="password"
                          className={fieldClass}
                          value={authPassword}
                          onChange={(e) => setAuthPassword(e.target.value)}
                          placeholder={t(locale, 'remoteWorkspace.password')}
                          autoComplete="off"
                        />
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => void handleEmailAuth()}
                        disabled={authBusy || !authEmail.trim()}
                        className="rounded-md border border-border px-2.5 py-1.5 text-[11px] text-fg-dim hover:border-accent hover:text-fg disabled:opacity-40"
                      >
                        {authBusy
                          ? t(locale, 'remoteWorkspace.saving')
                          : authStep === 'register'
                            ? t(locale, 'remoteWorkspace.register')
                            : authStep === 'verify'
                              ? t(locale, 'remoteWorkspace.verifyEmail')
                              : authStep === 'reset'
                                ? t(locale, 'remoteWorkspace.resetPassword')
                                : t(locale, 'remoteWorkspace.login')}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setAuthStep(authStep === 'register' ? 'login' : 'register');
                          setAuthCode('');
                        }}
                        className="rounded px-2 py-1 text-[11px] text-fg-faint hover:text-fg"
                      >
                        {authStep === 'register'
                          ? t(locale, 'remoteWorkspace.login')
                          : t(locale, 'remoteWorkspace.register')}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setAuthStep(authStep === 'reset' ? 'login' : 'reset');
                          setAuthCode('');
                        }}
                        className="rounded px-2 py-1 text-[11px] text-fg-faint hover:text-fg"
                      >
                        {authStep === 'reset'
                          ? t(locale, 'remoteWorkspace.login')
                          : t(locale, 'remoteWorkspace.forgotPassword')}
                      </button>
                      {authStep !== 'verify' ? null : (
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              await new RunnerClient(serverUrl, authToken).resendCode({
                                email: authEmail,
                              });
                              setError(t(locale, 'remoteWorkspace.emailCodeSent'));
                            } catch (err) {
                              setError(err instanceof Error ? err.message : String(err));
                            }
                          }}
                          className="rounded px-2 py-1 text-[11px] text-fg-faint hover:text-fg"
                        >
                          {t(locale, 'remoteWorkspace.resendCode')}
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          <div>
            <label className={labelClass}>
              {t(locale, 'remoteWorkspace.adapter')}
            </label>
            <select
              className={fieldClass}
              value={adapter}
              onChange={(e) => setAdapter(e.target.value as RemoteAdapter)}
            >
              {availableAdapters.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[10px] text-fg-faint">
              {t(locale, 'remoteWorkspace.adapterHint')}
            </p>
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

          {error && <p className="text-[11px] text-status-error">{error}</p>}
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
                  ? 'border-status-success/50 text-status-success'
                  : testState === 'fail'
                    ? 'border-status-error/50 text-status-error'
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
              className="flex items-center gap-1 rounded-md border border-border px-2 py-1.5 text-xs text-status-error transition-colors hover:border-status-error/50"
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
        </>
        )}
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
