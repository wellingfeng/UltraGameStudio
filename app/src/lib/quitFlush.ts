import {
  flushSecureStorage,
  flushSecretsToLocalStorageFallback,
} from "@/lib/secureStorage";
import { flushGenerationSettings } from "@/lib/generationSettingsStore";
import { flushRemoteProfileWrites } from "@/lib/settingsProfile";
import { flushApiConfigDiskWrites } from "@/lib/apiConfig";
import { flushGatewayConfigDiskWrites } from "@/lib/gatewayConfig";
import { flushPersonalInstructionsDiskWrites } from "@/lib/composerStorage";

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

let beforeQuitListener: (() => void) | null = null;
let beforeUnloadListener: (() => void) | null = null;
let quitInProgress = false;

// Extra synchronous flush tasks registered at runtime (e.g. the settings
// personalization autosave flushing its pending debounced writes). Both the
// browser beforeunload path and the Tauri tray-quit path run these before exit.
const quitFlushTasks = new Set<() => void>();

export function registerQuitFlushTask(task: () => void): () => void {
  quitFlushTasks.add(task);
  return () => {
    quitFlushTasks.delete(task);
  };
}

function runQuitFlushTasks(): void {
  for (const task of [...quitFlushTasks]) {
    try {
      task();
    } catch {
      /* best-effort: a failing flush task must not block exit */
    }
  }
}

export function resetQuitFlushForTests(): void {
  beforeQuitListener = null;
  beforeUnloadListener = null;
  quitInProgress = false;
  quitFlushTasks.clear();
}

/**
 * 安装「退出前落盘兜底」：
 * - 浏览器 beforeunload：同步把内存中的密钥写回 localStorage 镜像。
 * - Tauri 宿主：监听托盘右键菜单「退出」发出的 `ugs:before-quit` 事件，先同步
 *   落盘 localStorage 兜底，再尽力冲刷 OS keychain、生图/音频/视频等生成类
 *   设置磁盘写入，以及远程 project profile 写入，完成后通知宿主（invoke
 *   `ugs_quit_flush_done`）放行退出；密钥写入失败时取消退出并提示重试。
 * 浏览器 / dev 构建下自动跳过 Tauri 部分，beforeunload 兜底始终生效。
 */
export async function installQuitFlushHandler(): Promise<void> {
  if (hasWindow() && !beforeUnloadListener) {
    beforeUnloadListener = () => {
      runQuitFlushTasks();
      flushSecretsToLocalStorageFallback();
    };
    window.addEventListener("beforeunload", beforeUnloadListener);
  }
  const { isTauri } = await import("@/lib/tauri");
  if (!isTauri()) return;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    if (beforeQuitListener) return;
    beforeQuitListener = () => {
      if (quitInProgress) return;
      quitInProgress = true;
      void (async () => {
        let failureContext = "退出确认失败";
        try {
          const { activeRunChannels, activeAiEditChannels } = await import(
            "@/store/channelRegistry"
          );
          const running =
            activeRunChannels().length + activeAiEditChannels().length;
          if (running > 0 && hasWindow()) {
            const { invoke } = await import("@tauri-apps/api/core");
            // 托盘退出时主窗口可能隐藏，先恢复窗口，再等待原生对话框结果。
            await invoke("focus_main_window");
            const { confirm } = await import("@tauri-apps/plugin-dialog");
            const ok = await confirm(
              `仍有 ${running} 个会话正在运行中，退出会强制中断它们。\n\n确认退出？`,
              { title: "退出 UltraGameStudio", kind: "warning", okLabel: "退出", cancelLabel: "取消" },
            );
            if (!ok) {
              await invoke("ugs_quit_cancel");
              return;
            }
          }

          failureContext = "退出前数据保存失败";
          // Free the bounded history queue before synchronous quit hooks or
          // draft/final producers submit their last writes. The reserved
          // barrier still reports any earlier unobserved persistence failure.
          const { historyStore } = await import("@/store/history/store");
          await historyStore.flush();
          runQuitFlushTasks();
          flushSecretsToLocalStorageFallback();
          const flushResults = await Promise.allSettled([
          import('@/lib/downloadRegistry').then(({ flushAssetIndex }) => flushAssetIndex()).catch(error => {
            console.error('[asset-index] 退出前资产索引写入失败', error);
          }),
          import('@/components/temporaryChat/sessions').then(({ flushTemporaryChatSessions }) => flushTemporaryChatSessions()),
          flushSecureStorage(),
          flushGenerationSettings().catch(() => {
            /* disk write failed — localStorage mirror above still applies */
          }),
          flushRemoteProfileWrites().catch(() => {
            /* remote write failed — server copy may be stale */
          }),
          // 渠道/网关配置走的是 write-behind 磁盘队列，退出前必须冲刷，否则
          // settings/providers.v1.json 等文件保持陈旧，下次启动会以磁盘为权威
          // 源覆盖 localStorage 镜像，导致新加的渠道「重启后消失」。
          flushApiConfigDiskWrites().catch(() => {
            /* disk write failed — localStorage mirror above still applies */
          }),
          flushGatewayConfigDiskWrites().catch(() => {
            /* disk write failed — localStorage mirror above still applies */
          }),
          // 个性化指令（按 adapter 分桶）也是 write-behind 磁盘镜像，退出前必须
          // 冲刷，否则 WebView2 进程被杀时 leveldb 内存 log 未压实即丢失。
          flushPersonalInstructionsDiskWrites().catch(() => {
            /* disk write failed — localStorage mirror above still applies */
          }),
          // 把仍处于 debounce 窗口内的输入框草稿立即落盘，避免「退出即丢」。
          import("@/store/composerDraftPersistence")
            .then(({ flushComposerDraftPersist }) => flushComposerDraftPersist()),
          ]);
          const failedFlushes = flushResults.filter((result) => result.status === "rejected");
          if (failedFlushes.length > 0) {
            throw new Error(failedFlushes.map((result) =>
              result.reason instanceof Error ? result.reason.message : String(result.reason),
            ).join("\n"));
          }
          // Flush the producers before the history barrier. Waiting for only
          // already-admitted writes misses their debounce/publication timers.
          const { flushChatPersistenceForQuit } = await import('@/store/useStore');
          await flushChatPersistenceForQuit();
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("ugs_quit_flush_done");
        } catch (error) {
          console.error("[quitFlush] quit cancelled", error);
          let detail = error instanceof Error ? error.message : String(error);
          // A producer can report a failed write before the queue barrier sees
          // it. Report any distinct history error now so a recovered retry
          // does not replay an error already shown to the user.
          try {
            const { historyStore } = await import("@/store/history/store");
            await historyStore.flush();
          } catch (historyError) {
            const historyDetail = historyError instanceof Error ? historyError.message : String(historyError);
            if (!detail.includes(historyDetail)) detail += `\n${historyDetail}`;
          }
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("ugs_quit_cancel");
          } catch (cancelError) {
            console.warn("[quitFlush] failed to notify host about quit cancellation", cancelError);
          }
          if (hasWindow()) {
            window.alert(`${failureContext}，已取消退出：${detail}`);
          }
        } finally {
          quitInProgress = false;
        }
      })();
    };
    await listen("ugs:before-quit", beforeQuitListener);
  } catch (err) {
    console.warn("[quitFlush] before-quit handler unavailable", err);
  }
}
