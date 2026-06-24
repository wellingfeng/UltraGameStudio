import { useEffect, useMemo, useState } from 'react';
import Sidebar from '@/panels/Sidebar';
import AIDock from '@/panels/AIDock';
import ProjectFileTree from '@/panels/ProjectFileTree';
import ScheduledTaskRunner from '@/components/ScheduledTaskRunner';
import StatusBar from '@/components/StatusBar';
import { primeCliRuntime } from '@/lib/cliConfig';
import {
  migrateLegacyBrandStorage,
  onSingleInstanceWarning,
  type LegacyBrandMigrationProgress,
} from '@/lib/tauri';
import { useStore } from '@/store/useStore';
import { setActiveSettingsProfile } from '@/lib/settingsProfile';
import { profileIdForWorkspacePath } from '@/lib/settingsProfile';

let startupStorageMigrationPromise: Promise<LegacyBrandMigrationProgress> | null = null;
const startupStorageMigrationSubscribers = new Set<
  (progress: LegacyBrandMigrationProgress) => void
>();

function subscribeStartupStorageMigration(
  onProgress: (progress: LegacyBrandMigrationProgress) => void,
): { promise: Promise<LegacyBrandMigrationProgress>; unsubscribe: () => void } {
  startupStorageMigrationSubscribers.add(onProgress);
  if (!startupStorageMigrationPromise) {
    startupStorageMigrationPromise = migrateLegacyBrandStorage((next) => {
      for (const subscriber of startupStorageMigrationSubscribers) subscriber(next);
    });
  }
  return {
    promise: startupStorageMigrationPromise,
    unsubscribe: () => startupStorageMigrationSubscribers.delete(onProgress),
  };
}

/**
 * Top-level chat layout:
 *   left  : Sidebar
 *   center: AIDock full-height chat surface
 *
 * App.tsx is the consumer of all import contracts.
 */
export default function App() {
  const initHistory = useStore((s) => s.initHistory);
  const startupMigration = useStartupStorageMigration();
  useActiveChannelProfile();

  useEffect(() => {
    if (!startupMigration.done) return;
    initHistory();
    void primeCliRuntime();
  }, [initHistory, startupMigration.done]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onSingleInstanceWarning((message) => {
      window.alert(message || '只能同时运行一个进程');
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg text-fg">
      <ScheduledTaskRunner />
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <div className="hidden md:block">
          <Sidebar />
        </div>
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <AIDock layout="chat" />
        </main>
        <div className="hidden lg:block">
          <ProjectFileTree />
        </div>
      </div>
      <StatusBar />
      <StartupStorageMigrationOverlay progress={startupMigration.progress} />
    </div>
  );
}

/**
 * Activate the programming-channel settings profile that matches the active
 * workspace. Remote projects switch the global providers/gateway view to their
 * own `/user-settings`-backed config (hydrated once, then cached); local
 * projects use the local profile. This is what makes the bottom channel/model
 * selector and Settings follow the active remote project.
 */
function useActiveChannelProfile(): void {
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const workspaces = useStore((s) => s.workspaces);
  const composerWorkspace = useStore((s) => s.composer.workspace);
  const workspacePath = useMemo(() => {
    const active = workspaces
      .find((workspace) => workspace.id === activeWorkspaceId)
      ?.path?.trim();
    return composerWorkspace.trim() || active || '';
  }, [activeWorkspaceId, workspaces, composerWorkspace]);

  useEffect(() => {
    void setActiveSettingsProfile(profileIdForWorkspacePath(workspacePath));
  }, [workspacePath]);
}

function useStartupStorageMigration(): {
  done: boolean;
  progress: LegacyBrandMigrationProgress | null;
} {
  const [done, setDone] = useState(false);
  const [progress, setProgress] = useState<LegacyBrandMigrationProgress | null>(
    null,
  );

  useEffect(() => {
    let disposed = false;
    const { promise, unsubscribe } = subscribeStartupStorageMigration((next) => {
      if (!disposed) setProgress(next);
    });
    void promise
      .then((next) => {
        if (!disposed) setProgress(next);
      })
      .catch((err) => {
        if (disposed) return;
        setProgress({
          phase: 'error',
          rootsTotal: 0,
          rootsDone: 0,
          filesTotal: 0,
          filesDone: 0,
          dirsTotal: 0,
          dirsDone: 0,
          copiedFiles: 0,
          skippedFiles: 0,
          archivedRoots: 0,
          message: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        if (!disposed) setDone(true);
      });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  return { done, progress };
}

function StartupStorageMigrationOverlay({
  progress,
}: {
  progress: LegacyBrandMigrationProgress | null;
}) {
  const percent = useMemo(() => {
    if (!progress?.filesTotal) return null;
    return Math.min(100, Math.round((progress.filesDone / progress.filesTotal) * 100));
  }, [progress?.filesDone, progress?.filesTotal]);

  if (
    !progress ||
    progress.phase === 'done' ||
    progress.phase === 'skipped' ||
    progress.phase === 'error'
  ) {
    return null;
  }

  const phaseText =
    progress.phase === 'scanning'
      ? '扫描旧版配置'
      : progress.phase === 'copying'
        ? '复制旧版配置'
        : progress.phase === 'archiving'
          ? '归档旧目录'
          : '准备迁移配置';
  const fileText =
    progress.filesTotal > 0
      ? `${progress.filesDone}/${progress.filesTotal} 个文件`
      : `${progress.dirsDone} 个目录`;
  const pathText = shortMigrationPath(progress.currentPath);

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/65 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="旧版配置迁移进度"
        className="w-full max-w-md rounded-md border border-border bg-panel p-5 text-fg shadow-2xl"
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold">正在迁移旧版配置</div>
            <div className="mt-1 text-xs text-fg-dim">{phaseText}</div>
          </div>
          <div className="shrink-0 rounded border border-border bg-bg px-2 py-1 font-mono text-xs text-fg-dim">
            {percent === null ? fileText : `${percent}%`}
          </div>
        </div>
        <div
          role="progressbar"
          aria-label="旧版配置迁移进度"
          aria-valuemin={0}
          aria-valuemax={100}
          {...(percent === null ? {} : { 'aria-valuenow': percent })}
          className="relative h-2 overflow-hidden rounded-sm bg-bg"
        >
          {percent === null ? (
            <div className="vcs-scan-indeterminate absolute inset-y-0 left-0 w-1/3 bg-accent" />
          ) : (
            <div
              className="h-full bg-accent transition-[width] duration-150"
              style={{ width: `${percent}%` }}
            />
          )}
        </div>
        <div className="mt-3 flex items-center justify-between gap-3 text-xs text-fg-dim">
          <span>{fileText}</span>
          <span>{progress.rootsDone}/{progress.rootsTotal} 个目录</span>
        </div>
        {pathText && (
          <div
            className="mt-2 truncate font-mono text-[11px] text-fg-dim"
            title={progress.currentPath ?? undefined}
          >
            {pathText}
          </div>
        )}
      </div>
    </div>
  );
}

function shortMigrationPath(path: string | null | undefined): string {
  if (!path) return '';
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.slice(-3).join(' / ');
}
