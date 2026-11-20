import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ArrowDownToLine, ArrowUpFromLine, Bug, ChevronDown, CornerDownRight, Hammer, Pause, Play, RotateCcw, Square, Unplug, type LucideIcon } from 'lucide-react';
import { tauriAvailable } from '@/lib/tauri';
import { workflowDefaultGatewaySelection } from '@/lib/modelGateway/resolver';
import { useStore } from '@/store/useStore';
import { requestProjectRightPanelFilePreview } from '@/panels/projectRightPanelEvents';
import { autoConfigureProjectRun } from './projectRunSetup';
import './ProjectRunToolbar.css';

type Action = 'build' | 'cancelBuild' | 'editor' | 'game' | 'pie' | 'stopPie' | 'stopRun'
  | 'debugEditor' | 'debugGame' | 'attach' | 'disconnect' | 'pause' | 'continue' | 'next'
  | 'stepIn' | 'stepOut' | 'restart' | 'frame';
type Frame = { id: number; name: string; line: number; column?: number; source?: { name?: string; path?: string } };
type Debugger = {
  phase: 'starting' | 'running' | 'paused' | 'stopping';
  attached: boolean;
  reason: string;
  frames: Frame[];
  frameId?: number;
  variables: { name: string; value: string; type?: string }[];
};
type Status = {
  build: boolean;
  cancelBuild: boolean;
  run?: string;
  pie?: 'starting' | 'running' | 'stopping';
  debugger?: Debugger;
  unityDebugEditor?: string;
  notice: string;
  error: string;
};
type ProjectInfo = {
  engine: string; project?: string; name?: string; target?: string; editor?: string;
  installed: boolean; build: boolean; debugger: boolean; attach: boolean; pie: boolean;
  profile?: Action; issue?: string;
};
type Profile = { action: Action; label: string; debug?: boolean };

const profilesByEngine: Partial<Record<string, Profile[]>> = {
  unreal: [
    { action: 'pie', label: '编辑器内运行（PIE）' },
    { action: 'editor', label: '运行 Unreal 编辑器' },
    { action: 'game', label: '运行独立游戏' },
    { action: 'debugEditor', label: 'C++ 调试编辑器', debug: true },
    { action: 'debugGame', label: 'C++ 调试独立游戏', debug: true },
    { action: 'attach', label: '附加到当前项目编辑器', debug: true },
  ],
  unity: [
    { action: 'debugEditor', label: 'C# 调试 Unity 编辑器', debug: true },
    { action: 'editor', label: '运行 Unity 编辑器' },
  ],
  godot: [
    { action: 'debugGame', label: 'GDScript 调试主场景', debug: true },
    { action: 'game', label: '运行主场景' },
    { action: 'editor', label: '运行 Godot 编辑器' },
  ],
};
const engineLabels: Record<string, string> = { unreal: 'Unreal Engine', unity: 'Unity', godot: 'Godot', cocos: 'Cocos' };

export default function ProjectRunToolbar() {
  const workspace = useStore((state) => state.workspaces.find((item) => item.id === state.activeWorkspaceId)?.path);
  const localWorkspace = workspace && tauriAvailable() && !/^\w+:\/\//.test(workspace) ? workspace : undefined;
  return <WorkspaceRunToolbar key={localWorkspace} workspace={localWorkspace} />;
}

function WorkspaceRunToolbar({ workspace }: { workspace?: string }) {
  const [project, setProject] = useState<ProjectInfo>();
  const [status, setStatus] = useState<Status>();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [configuring, setConfiguring] = useState(false);
  const [setupNotice, setSetupNotice] = useState('');
  const [setupError, setSetupError] = useState('');
  const setupRequest = useRef<AbortController>();
  const toolbar = useRef<HTMLDivElement>(null);
  const requestRevision = useRef(0);
  const busy = useRef(false);

  useEffect(() => {
    if (!workspace) return;
    let active = true;
    void invoke<ProjectInfo>('project_run_info', { workspace }).then((info) => {
      if (!active) return;
      setProject(info);
      if (profilesByEngine[info.engine]) {
        void invoke<Status>('project_run_status', { workspace }).then((value) => {
          if (active && requestRevision.current === 0) setStatus(value);
        }).catch((reason: unknown) => { if (active) setError(String(reason)); });
      }
    }).catch((reason: unknown) => { if (active) setError(String(reason)); });
    return () => { active = false; setupRequest.current?.abort(); };
  }, [workspace]);

  useEffect(() => {
    if (!open || !workspace || busy.current) return;
    let disposed = false;
    const revision = requestRevision.current;
    void invoke<ProjectInfo>('project_run_info', { workspace }).then((info) => {
      if (!disposed && revision === requestRevision.current) setProject(info);
    }).catch((reason: unknown) => {
      if (!disposed && revision === requestRevision.current) setError(String(reason));
    });
    return () => { disposed = true; };
  }, [open, workspace]);

  const active = Boolean(status?.build || status?.run || status?.pie || status?.debugger);
  useEffect(() => {
    if (!workspace || (!active && !open)) return;
    let disposed = false;
    let timer: number;
    const refresh = async () => {
      const revision = requestRevision.current;
      try {
        if (!busy.current) {
          const next = await invoke<Status>('project_run_status', { workspace });
          if (!disposed && !busy.current && revision === requestRevision.current) setStatus(next);
        }
      } catch (reason) {
        if (!disposed && !busy.current && revision === requestRevision.current) setError(String(reason));
      } finally {
        if (!disposed && active) timer = window.setTimeout(() => void refresh(), open ? 650 : 1200);
      }
    };
    timer = window.setTimeout(() => void refresh(), open ? 0 : 350);
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [active, open, workspace]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!toolbar.current?.contains(event.target as Node)) setOpen(false);
    };
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  const run = useCallback(async (action: Action, args?: { frame: number }) => {
    if (!workspace || busy.current) return;
    busy.current = true;
    requestRevision.current++;
    setPending(true);
    setError('');
    setSetupError('');
    setSetupNotice('');
    try {
      setStatus(await invoke<Status>('project_run_action', { workspace, action, ...args }));
    } catch (reason) {
      setError(String(reason));
      setOpen(true);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }, [workspace]);

  const engine = project?.engine;
  const profiles = (engine && profilesByEngine[engine]) || [];
  const selected = profiles.find((item) => item.action === project?.profile) ?? profiles[0];
  const projectName = project?.name || project?.project?.split(/[/\\]/).pop();
  const debuggerState = status?.debugger;
  const paused = debuggerState?.phase === 'paused';
  const canStop = Boolean(debuggerState || status?.pie || status?.run || status?.cancelBuild);

  function canLaunch(item?: Profile) {
    if (!item || pending || configuring || !project?.installed || status?.build || debuggerState) return false;
    if (item.action === 'attach') return project.attach;
    if (item.action === 'pie' && project.pie === false) return false;
    if (item.action === 'game' && engine === 'godot' && !project.debugger) return false;
    return !(status?.pie || (item.action !== 'pie' && status?.run) || (item.debug && !project.debugger));
  }

  const debugProfile = selected?.debug ? selected : profiles.find((item) => item.debug);
  let debugAction: Action | undefined;
  if (status && !pending && !configuring) {
    if (paused) debugAction = 'continue';
    else if (!debuggerState && canLaunch(debugProfile)) debugAction = debugProfile?.action;
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'F5') return;
      event.preventDefault();
      if (debugAction && !event.repeat && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey) {
        void run(debugAction);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [debugAction, run]);

  if (!engine || engine === 'unknown') return null;
  const message = error || status?.error;
  const checking = profiles.length > 0 && !status && !message && !project?.issue;
  const unityNeedsVerification = engine === 'unity' && Boolean(project?.editor && project.editor !== status?.unityDebugEditor);
  const ready = Boolean(profiles.length && project?.installed && project.debugger && !project.issue && status && !message && !unityNeedsVerification);
  const stateLabel = paused ? '已暂停' : debuggerState?.phase === 'starting' ? '启动调试中' : debuggerState?.phase === 'stopping' ? '断开调试中' : debuggerState ? '调试中'
    : status?.pie === 'starting' ? '启动 PIE 中' : status?.pie === 'stopping' ? '结束 PIE 中' : status?.pie ? 'PIE 运行中' : status?.build ? '编译中' : status?.run ? `${status.run}运行中`
    : configuring ? '配置中' : pending ? '正在处理' : checking ? '检查中' : ready ? '就绪' : '待配置';

  async function configure() {
    if (!workspace || busy.current || active) return;
    busy.current = true;
    requestRevision.current++;
    const controller = new AbortController();
    setupRequest.current = controller;
    setConfiguring(true);
    setSetupNotice('');
    setSetupError('');
    try {
      const { workflow, composer } = useStore.getState();
      const model = workflowDefaultGatewaySelection(workflow, composer.model);
      const info = await autoConfigureProjectRun<ProjectInfo>(workspace, model, controller.signal);
      if (controller.signal.aborted) return;
      setProject(info);
      setError('');
      setSetupNotice('已保存项目调试配置。');
      const nextStatus = await invoke<Status>('project_run_status', { workspace });
      if (!controller.signal.aborted) setStatus(nextStatus);
    } catch (reason) {
      if (!controller.signal.aborted) setSetupError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setupRequest.current = undefined;
      busy.current = false;
      setConfiguring(false);
    }
  }

  async function selectProfile(profile: Action) {
    if (!workspace || !project || busy.current) return;
    busy.current = true;
    requestRevision.current++;
    setPending(true);
    setSetupError('');
    try {
      setProject(await invoke<ProjectInfo>('project_run_save_profile', { workspace, profile }));
    } catch (reason) {
      setSetupError(String(reason));
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  function stop() {
    if (paused || (!status?.pie && debuggerState)) void run('disconnect');
    else if (status?.pie) void run('stopPie');
    else if (status?.cancelBuild) void run('cancelBuild');
    else void run('stopRun');
  }

  function selectFrame(frame: Frame) {
    void run('frame', { frame: frame.id });
    const source = frame.source?.path;
    if (source) requestProjectRightPanelFilePreview({ cwd: workspace, ref: {
      path: source, basename: frame.source?.name || source.split(/[/\\]/).pop() || source,
      startLine: frame.line || undefined, col: frame.column,
    } });
  }

  return (
    <div className="ugs-project-run" ref={toolbar} data-tauri-drag-region="false">
      <div className="ugs-project-run-bar" role="group" aria-label="项目运行与调试">
        <span className="ugs-project-run-led" data-state={message ? 'error' : paused ? 'paused' : active ? 'running' : ready ? 'ready' : 'idle'} title={message || project?.issue || status?.notice || stateLabel} aria-label={stateLabel} />
        {profiles.length > 0 && <>
          <Tool icon={debuggerState?.phase === 'running' ? Pause : Play} color={debuggerState?.phase === 'running' ? 'blue' : 'green'}
            label={paused ? '继续' : debuggerState?.phase === 'running' ? '暂停' : selected?.label || '运行'}
            disabled={debuggerState ? pending || !['running', 'paused'].includes(debuggerState.phase) : !canLaunch(selected)}
            shortcut={debugAction && (paused || debugAction === selected?.action) ? 'F5' : undefined}
            onClick={() => { if (paused) void run('continue'); else if (debuggerState) void run('pause'); else if (selected) void run(selected.action); }} />
          <Tool icon={CornerDownRight} label="单步跳过" disabled={!paused || pending || engine === 'unity'} onClick={() => void run('next')} />
          <Tool icon={ArrowDownToLine} label="单步进入" disabled={!paused || pending || engine === 'unity'} onClick={() => void run('stepIn')} />
          <Tool icon={ArrowUpFromLine} label="单步跳出" disabled={!paused || pending || engine === 'unity'} onClick={() => void run('stepOut')} />
          <Tool icon={RotateCcw} label="重启调试" color="green" disabled={pending || !debuggerState || debuggerState.attached || !['paused', 'running'].includes(debuggerState.phase)} onClick={() => void run('restart')} />
          <Tool icon={debuggerState?.attached ? Unplug : Square} label={debuggerState && !status?.pie ? debuggerState.attached ? '断开调试' : '停止调试' : status?.pie ? '结束 PIE' : status?.cancelBuild ? '取消编译' : '停止运行'} color="red" disabled={pending || !canStop || (debuggerState?.phase === 'stopping')} onClick={stop} />
        </>}
        <Tool icon={ChevronDown} label="运行配置" expanded={open} onClick={() => setOpen((value) => !value)} />
      </div>

      {open && <section className="ugs-project-run-panel" aria-label="运行配置">
        <header>
          <strong>{projectName || engineLabels[engine]}</strong>
          {!active && !ready && !configuring && !pending && !checking
            ? <button type="button" disabled={!profiles.length} onClick={() => void configure()}>自动配置</button>
            : <span>{stateLabel}</span>}
        </header>
        {project?.issue && <p role="status">{project.issue}</p>}
        {unityNeedsVerification && !active && !message && !project?.issue && <p role="status">按 F5 验证 Unity C# 调试连接。</p>}
        {message && <p className="ugs-project-run-error" role="alert">{message}</p>}
        {setupError && <p className="ugs-project-run-error" role="alert">{setupError}</p>}
        {setupNotice && <p role="status">{setupNotice}</p>}
        {profiles.length > 0 && <>
          <label className="ugs-project-run-config">
            <span>运行配置</span>
            <select value={selected?.action} disabled={pending || configuring || active} onChange={(event) => void selectProfile(event.target.value as Action)}>
              {profiles.map((item) => <option key={item.action} value={item.action}>{item.label}</option>)}
            </select>
          </label>
          {engine === 'unreal' && <div className="ugs-project-run-actions">
            <button type="button" disabled={pending || configuring || !project?.build || Boolean(status?.build)} onClick={() => void run('build')} title={project?.target}>
              <Hammer size={14} /> 编译
            </button>
            <button type="button" disabled={pending || configuring || !project?.installed || project.pie === false || Boolean(status?.build || status?.pie) || debuggerState?.phase === 'paused'} onClick={() => void run('pie')}><Play size={14} /> 开始 PIE</button>
            <button type="button" disabled={pending || configuring || !project?.installed || !project?.attach || Boolean(debuggerState || status?.build)} onClick={() => void run('attach')}><Bug size={14} /> 附加调试</button>
            {status?.cancelBuild && <button type="button" onClick={() => void run('cancelBuild')} disabled={pending}>取消编译</button>}
            {debuggerState && status?.pie && <button type="button" onClick={() => void run('disconnect')} disabled={pending || debuggerState.phase === 'stopping'}>断开调试</button>}
          </div>}
          {debuggerState?.reason && <p role="status">{debuggerState.reason}</p>}
          {paused && <div className="ugs-project-run-stack">
            <div><h3>调用栈</h3>{debuggerState.frames.map((frame) => <button type="button" key={frame.id} aria-pressed={frame.id === debuggerState.frameId} title={frame.source?.path || frame.name} onClick={() => selectFrame(frame)}>
              <span>{frame.name}</span>{frame.source?.name && <small>{frame.source.name}:{frame.line}</small>}
            </button>)}</div>
            <div><h3>局部变量</h3>{debuggerState.variables.map((variable, index) => <div className="ugs-project-run-variable" key={`${variable.name}-${index}`} title={`${variable.type ?? ''} ${variable.value}`}>{variable.name} = {variable.value}</div>)}</div>
          </div>}
        </>}
      </section>}
    </div>
  );
}

function Tool({ icon: Icon, label, color, disabled, expanded, shortcut, onClick }: {
  icon: LucideIcon; label: string; color?: 'green' | 'blue' | 'red'; disabled?: boolean; expanded?: boolean; shortcut?: string; onClick: () => void;
}) {
  return <button type="button" className="ugs-project-run-tool" data-color={color} aria-label={label} aria-keyshortcuts={shortcut} title={shortcut ? `${label}（${shortcut}）` : label} aria-expanded={expanded} disabled={disabled} onClick={onClick}><Icon size={15} strokeWidth={1.8} aria-hidden="true" /></button>;
}
