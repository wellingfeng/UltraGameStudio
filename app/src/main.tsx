// Must run before any module that reads localStorage (e.g. the store seed):
// migrates pre-rebrand `owf_*` keys to `ugs_*` so dev data survives the rename.
import "./lib/legacyStorageMigration";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./styles/fonts.css";
import "./styles/global.css";
import { initializeSecureStorage } from "@/lib/secureStorage";
import { installQuitFlushHandler, registerQuitFlushTask } from "@/lib/quitFlush";
import { flushComposerDraftsOnQuit } from "@/store/composerDraftPersistence";
import { initializeGenerationSettingsStore } from "@/lib/generationSettingsStore";
import { initializeGatewayConfigStore } from "@/lib/gatewayConfig";
import { initializeApiConfigStore, syncGatewayFromProviders } from "@/lib/apiConfig";
import { initializePersonalInstructionsStore } from "@/lib/composerStorage";
import { refreshModelPricing } from "@/lib/modelPricing";
import { startUiPerformanceMonitor } from "@/lib/uiPerformance";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Root element #root not found");
}

async function bootstrap(): Promise<void> {
  // Secure storage must be ready before gateway/api config hydration, because
  // those readers decide whether API keys live in the OS keychain. Hydrate it
  // first, then run the remaining independent initializers concurrently.
  await initializeSecureStorage();
  await Promise.all([
    initializeGenerationSettingsStore(),
    initializeGatewayConfigStore(),
  ]);
  await initializeApiConfigStore();
  // 用权威的 providers 数据重建网关镜像，修复 modelGateway.v1.json 与
  // providers.v1.json 脱节导致的「渠道名显示成旧值」问题（如 ExampleGemini 显示
  // 成 ExampleAI）。必须在 useStore 冷启动（首次 import）之前完成，否则路由头
  // 仍会读到陈旧的 gateway name。
  syncGatewayFromProviders();
  // 个性化指令（按 adapter 分桶）需要在 settingsSlice 冷启动（首次 import
  // useStore 时同步跑 loadPersonalInstructionsByModel）之前完成磁盘 hydrate，
  // 否则启动时会从 localStorage 读到陈旧值。必须放在 dynamic import useStore 之前。
  await initializePersonalInstructionsStore();
  // 退出兜底（托盘右键菜单「退出」/ 浏览器关闭）：把内存密钥同步落盘
  // localStorage，避免 keychain 异步写未完成时丢失就地编辑的 API Key。
  void installQuitFlushHandler();
  // 输入框草稿兜底：托盘「退出」路径由 quitFlush 直接 flush；这里补上
  // beforeunload（关窗 / 刷新 / 崩溃）分支。否则删除草稿后若在 30s 去抖窗口内
  // 重启，磁盘仍是旧文本、重启后「已删除的内容复活」。
  registerQuitFlushTask(flushComposerDraftsOnQuit);
  const [{ default: App }, { applyAppearance }, { useStore }] =
    await Promise.all([
      import("./App"),
      import("@/lib/appearance"),
      import("@/store/useStore"),
    ]);

  applyAppearance(useStore.getState().appearance);

  createRoot(rootEl!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

  // 仅清理已在磁盘核对一致的旧会话改动缓存，避免占满 WebView2 配额。
  void import('@/lib/sessionChanges').then(({ prunePersistedSessionChangesCache }) => prunePersistedSessionChangesCache());

  // 启动时联网刷新一次模型价格目录（OpenRouter 公开接口），不阻塞渲染。
  void refreshModelPricing();
}

// Start before hydration so cold-start stalls are observable as well. The
// monitor is optional, numeric-only and never delays bootstrap or quit flush.
const stopUiPerformanceMonitor = startUiPerformanceMonitor();
window.addEventListener("pagehide", stopUiPerformanceMonitor, { once: true });
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    window.removeEventListener("pagehide", stopUiPerformanceMonitor);
    stopUiPerformanceMonitor();
  });
}

void bootstrap();
