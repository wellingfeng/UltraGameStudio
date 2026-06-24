import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import {
  Bone,
  Box,
  Boxes,
  Check,
  Copy,
  Cpu,
  DownloadCloud,
  Eye,
  EyeOff,
  ExternalLink,
  FileText,
  Gamepad2,
  Globe,
  Info,
  Keyboard,
  Languages,
  Monitor,
  Moon,
  Music,
  Palette,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  SlashSquare,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Terminal,
  Trash2,
  Type,
  UploadCloud,
  Video,
  Volume2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import type { GatewaySelection } from '@/core/ir';
import {
  ensureRequiredPersonalInstructions,
  personalInstructionsForSelection,
  personalInstructionsKey,
  personalInstructionsSample,
  selectionFromPersonalInstructionsKey,
  type PersonalInstructionsByModel,
} from '@/core/personalInstructions';
import {
  FREE_CHANNELS,
  FREE_CHANNEL_AUTO_ID,
  FREE_CHANNEL_AUTO_MODEL,
  ensureFreeProxy,
  exportFreeChannelsConfig,
  freeChannelById,
  freeChannelReady,
  freeChannelSelection,
  getFreeChannelKey,
  getFreeChannelModel,
  getFreeChannelModelOverride,
  importFreeChannelsConfig,
  importFreeChannelKeysFromAutoConfig,
  isFreeChannelSelection,
  setFreeChannelKey,
  setFreeChannelModel,
  type FreeChannel,
} from '@/lib/freeChannels';
import {
  RUNTIME_ADAPTERS,
  runtimeAdapterLabel,
  type RuntimeAdapterId,
} from '@/lib/adapters';
import {
  addProvider,
  deleteProvider,
  exportDefaultChannelsConfig,
  getProviderRuntimeInfo,
  importDefaultChannelsConfig,
  isProviderBaseUrlValid,
  listProviders,
  providerMetadataSignature,
  updateProvider,
  type Provider,
  type ProviderRuntimeStatus,
} from '@/lib/apiConfig';
import { importCcSwitchProviders } from '@/lib/ccSwitchAutoImport';
import {
  isTauri,
  installSkillFromText,
  installSkillFromUrl,
  localModelStatus,
  openExternal,
  setupComfyui,
  skillInstallTargets,
  type ComfyUiSetupModel,
  type LocalModelRuntimeStatus,
  type SkillInstallTarget,
  uninstallSkill,
  validateShellPath,
} from '@/lib/tauri';
import LocalModelSetupDialog from '@/components/LocalModelSetupDialog';
import ErrorBoundary from '@/components/ErrorBoundary';
import ProjectSettingsModal, {
  type ProjectEmbedTab,
} from '@/panels/ProjectSettingsModal';
import type { WorkspaceSummary } from '@/store/history/types';
import { EditableModelSelect } from '@/components/EditableModelSelect';
import {
  APP_VERSION,
  REPO_URL,
  RELEASES_URL,
  checkForUpdate,
  openDownload,
  type UpdateStatus,
} from '@/lib/updateCheck';
import {
  getRunShell,
  setRunShell,
  type RunShellConfig,
  type RunShellKind,
} from '@/lib/shellConfig';
import {
  getManifestModeEnabled,
  setManifestModeEnabled,
  subscribeManifestMode,
} from '@/lib/manifestMode';
import {
  getCliRuntimeSnapshot,
  isCliAdapterAvailable,
  primeCliRuntime,
  subscribeCliRuntime,
  type CliRuntimeSnapshot,
} from '@/lib/cliConfig';
import { pickFile } from '@/lib/folderPicker';
import {
  LANGUAGE_SELECT_OPTIONS,
  t,
  type Locale,
  type TranslationKey,
} from '@/lib/i18n';
import {
  DEFAULT_STYLE_PRESET_ID,
  FONT_FAMILY_LIST,
  FONT_SIZE_LIMITS,
  STYLE_PRESETS,
  STYLE_PRESET_LIST,
  TERMINAL_STYLE_PRESET_IDS,
  isUnsupportedStylePreset,
  resolveFontFamilyId,
  resolveFontSizePx,
  resolveStylePresetId,
  type StylePresetDefinition,
} from '@/lib/appearance';
import {
  DEFAULT_SHORTCUT_SETTINGS,
  SHORTCUT_ACTION_IDS,
  describeShortcutBinding,
  loadShortcutSettings,
  matchesShortcut,
  resetAllShortcutSettings,
  resetShortcutBinding,
  saveShortcutSettings,
  setShortcutBinding,
  shortcutConflict,
  shortcutFromKeyboardEvent,
  shortcutParts,
  subscribeShortcutSettings,
  type ShortcutActionId,
  type ShortcutSettings,
} from '@/lib/keyboardShortcuts';
import { useStore } from '@/store/useStore';
import {
  CONSENSUS_LIMITS,
  getConsensusSettings,
  setConsensusSetting,
  type ConsensusSettings as ConsensusSettingsValues,
} from '@/lib/consensusSettings';
import {
  canRefreshFreeChannelModels,
  endpointModelCacheKey,
  freeChannelModelCacheKey,
  freeChannelModelOptions,
  providerModelCacheKey,
  providerModelOptions,
  refreshEndpointModels,
  refreshFreeChannelModels,
  refreshProviderModels,
} from '@/lib/modelLists';
import {
  createCustomImageProviderId,
  imageProviderBaseUrl,
  imageProviderModel,
  imageProviders,
  imageProviderReady,
  imageProviderSupportsComfyUiGraph,
  loadImageGenerationSettings,
  saveImageGenerationSettings,
  type CustomImageProviderDefinition,
  type ImageGenerationSettings,
  type ImageProviderDefinition,
  type ImageProviderCategory,
  type ImageProviderId,
} from '@/lib/imageGeneration';
import {
  createCustomMusicProviderId,
  loadMusicGenerationSettings,
  musicProviders,
  musicProviderBaseUrl,
  musicProviderModel,
  musicProviderReady,
  saveMusicGenerationSettings,
  type CustomMusicProviderDefinition,
  type MusicGenerationSettings,
  type MusicProviderDefinition,
  type MusicProviderCategory,
  type MusicProviderId,
} from '@/lib/musicGeneration';
import {
  createCustomVideoProviderId,
  loadVideoGenerationSettings,
  saveVideoGenerationSettings,
  videoProviders,
  videoProviderBaseUrl,
  videoProviderModel,
  videoProviderReady,
  type CustomVideoProviderDefinition,
  type VideoGenerationSettings,
  type VideoProviderDefinition,
  type VideoProviderCategory,
  type VideoProviderId,
} from '@/lib/videoGeneration';
import {
  loadWorldModelGenerationSettings,
  saveWorldModelGenerationSettings,
  worldModelProviders,
  worldModelProviderBaseUrl,
  worldModelProviderModel,
  worldModelProviderReady,
  type WorldModelGenerationSettings,
  type WorldModelProviderDefinition,
  type WorldModelProviderId,
} from '@/lib/worldModel';
import {
  createCustomSpeechProviderId,
  loadSpeechGenerationSettings,
  saveSpeechGenerationSettings,
  speechProviders,
  speechProviderBaseUrl,
  speechProviderModel,
  speechProviderVoice,
  speechProviderReady,
  type CustomSpeechProviderDefinition,
  type SpeechGenerationSettings,
  type SpeechProviderDefinition,
  type SpeechProviderCategory,
  type SpeechProviderId,
} from '@/lib/speechGeneration';
import {
  loadSpriteGenerationSettings,
  saveSpriteGenerationSettings,
  type SpriteGenerationSettings,
  type SpriteComponentMode,
  type SpriteFrameAnchor,
  type SpriteSheetPreset,
} from '@/lib/spriteGeneration';
import {
  THREE_D_RIGGING_PROVIDERS,
  createCustomThreeDProviderId,
  loadThreeDGenerationSettings,
  saveThreeDGenerationSettings,
  threeDRiggingProviderBaseUrl,
  threeDRiggingProviderCommand,
  threeDRiggingProviderModel,
  threeDRiggingProviderReady,
  threeDRiggingInheritedKey,
  threeDProviderBaseUrl,
  threeDProviderById,
  threeDProviderModel,
  threeDProviders,
  threeDProviderReady,
  type CustomThreeDProviderDefinition,
  type ThreeDGenerationSettings,
  type ThreeDProviderCategory,
  type ThreeDProviderDefinition,
  type ThreeDProviderId,
  type ThreeDRiggingProviderCategory,
  type ThreeDRiggingProviderDefinition,
  type ThreeDRiggingProviderId,
} from '@/lib/threeDGeneration';
import {
  GAME_EXPERT_LIMITS,
  GAME_EXPERT_IDS,
  getGameExpertCatalog,
  gameExpertSlashCommand,
  type GameExpertDefinition,
  type GameExpertEngine,
  type GameExpertMode,
  type GameExpertSettings as GameExpertSettingsValues,
} from '@/lib/gameExperts';
import {
  localizedGameExpertName,
  localizedGameExpertGroup,
  localizedGameGroupLabel,
} from '@/lib/gameExpertI18n';
import {
  listGatewayRunOptions,
  systemDefaultGatewaySelection,
  workflowDefaultGatewaySelection,
} from '@/lib/modelGateway/resolver';
import { getActiveGatewaySelection } from '@/lib/gatewayConfig';
import {
  loadTranslationSettings,
  saveTranslationSettings,
  subscribeTranslationSettings,
  type TranslationProviderId,
  type TranslationSettings,
} from '@/lib/translationSettings';
import { isRemoteRunnerProvider } from '@/lib/remoteWorkspace';
import {
  isRemoteSettingsProfile,
  preloadSettingsProfile,
  settingsProfileIdForWorkspacePath,
  type SettingsProfileOptions,
} from '@/lib/generationSettingsStore';
import {
  ReadonlyField,
  SelectControl,
  SettingRow,
  StepperControl,
  SwitchControl,
  TextField,
} from '@/panels/settings/controls';
import CommandsSettings from '@/panels/settings/CommandsSettings';
import {
  UI_DESIGN_CHANNELS,
  loadUiDesignChannelSettings,
  saveUiDesignChannelSettings,
  uiDesignChannelBaseUrl,
  uiDesignChannelById,
  uiDesignChannelCategoryLabel,
  uiDesignChannelCommand,
  uiDesignChannelExportFormat,
  uiDesignChannelReady,
  type UiDesignChannelCategory,
  type UiDesignChannelDefinition,
  type UiDesignChannelId,
  type UiDesignChannelSettings,
} from '@/lib/uiDesignChannels';
import {
  createCustomMeshLibraryId,
  meshLibraryCategoryLabel,
  meshLibraries,
  loadMeshLibrarySettings,
  meshLibraryReady,
  meshLibraryUsability,
  meshLibraryUsable,
  saveMeshLibrarySettings,
  type CustomMeshLibraryDefinition,
  type MeshLibraryAccountSettings,
  type MeshLibraryDefinition,
  type MeshLibraryId,
} from '@/lib/meshLibrary';
import {
  CAPTURE_PERF_SKILLS,
  capturePerfCategoryLabel,
  type CapturePerfSkillDefinition,
} from '@/lib/capturePerfSkills';

  type SettingsTab =
  | 'general'
  | 'personalization'
  | 'models'
  | 'imageGeneration'
  | 'musicGeneration'
  | 'videoGeneration'
  | 'worldModelGeneration'
  | 'speechGeneration'
  | 'threeDGeneration'
  | 'meshLibrary'
  | 'spriteGeneration'
  | 'uiDesign'
  | 'rigging'
  | 'capturePerf'
  | 'gameExperts'
  | 'consensus'
  | 'commands'
  | 'mcp'
  | 'lsp'
  | 'skills'
  | 'shortcuts'
  | 'appearance'
  | 'about';
type LanguageOption = (typeof LANGUAGE_SELECT_OPTIONS)[number];
type TranslationProviderOption = {
  id: TranslationProviderId;
  label: string;
  hint?: string;
};

const tabs: { id: SettingsTab; labelKey: TranslationKey; Icon: LucideIcon }[] = [
  { id: 'general', labelKey: 'settings.tabs.general', Icon: SlidersHorizontal },
  { id: 'personalization', labelKey: 'settings.tabs.personalization', Icon: FileText },
  { id: 'models', labelKey: 'settings.tabs.models', Icon: Cpu },
  { id: 'imageGeneration', labelKey: 'settings.tabs.imageGeneration', Icon: Sparkles },
  { id: 'musicGeneration', labelKey: 'settings.tabs.musicGeneration', Icon: Music },
  { id: 'videoGeneration', labelKey: 'settings.tabs.videoGeneration', Icon: Video },
  { id: 'worldModelGeneration', labelKey: 'settings.tabs.worldModelGeneration', Icon: Globe },
  { id: 'speechGeneration', labelKey: 'settings.tabs.speechGeneration', Icon: Volume2 },
  { id: 'threeDGeneration', labelKey: 'settings.tabs.threeDGeneration', Icon: Box },
  { id: 'meshLibrary', labelKey: 'settings.tabs.meshLibrary', Icon: Boxes },
  { id: 'spriteGeneration', labelKey: 'settings.tabs.spriteGeneration', Icon: Boxes },
  { id: 'uiDesign', labelKey: 'settings.tabs.uiDesign', Icon: Palette },
  { id: 'rigging', labelKey: 'settings.tabs.rigging', Icon: Bone },
  { id: 'capturePerf', labelKey: 'settings.tabs.capturePerf', Icon: DownloadCloud },
  { id: 'commands', labelKey: 'settings.tabs.commands', Icon: SlashSquare },
  { id: 'mcp', labelKey: 'settings.tabs.mcp', Icon: Terminal },
  { id: 'lsp', labelKey: 'settings.tabs.lsp', Icon: Languages },
  { id: 'skills', labelKey: 'settings.tabs.skills', Icon: Box },
  { id: 'shortcuts', labelKey: 'settings.tabs.shortcuts', Icon: Keyboard },
  { id: 'appearance', labelKey: 'settings.tabs.appearance', Icon: Palette },
  { id: 'about', labelKey: 'settings.tabs.about', Icon: Info },
];

interface BrowserFileWritable {
  write(data: string): Promise<void>;
  close(): Promise<void>;
}

interface BrowserFileHandle {
  createWritable(): Promise<BrowserFileWritable>;
}

interface BrowserSavePickerWindow extends Window {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: Array<{
      description: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<BrowserFileHandle>;
}

async function exportJsonFile(
  data: unknown,
  filename: string,
  title: string,
): Promise<boolean> {
  const json = JSON.stringify(data, null, 2);

  if (isTauri()) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const picked = await save({
      title,
      defaultPath: filename,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (!picked) return false;
    const target = typeof picked === 'string' ? picked : String(picked);
    const { writeTextFile } = await import('@tauri-apps/plugin-fs');
    await writeTextFile(target, json);
    return true;
  }

  const picker = (window as BrowserSavePickerWindow).showSaveFilePicker;
  if (!picker) throw new Error('SAVE_PICKER_UNAVAILABLE');
  try {
    const handle = await picker({
      suggestedName: filename,
      types: [
        {
          description: 'JSON',
          accept: { 'application/json': ['.json'] },
        },
      ],
    });
    const writable = await handle.createWritable();
    await writable.write(json);
    await writable.close();
    return true;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return false;
    throw err;
  }
}

async function readJsonFile(file: File): Promise<unknown> {
  return JSON.parse(await file.text()) as unknown;
}

function formatStatusMessage(
  template: string,
  values: Record<string, string | number>,
): string {
  return Object.entries(values).reduce(
    (msg, [key, value]) => msg.replace(`{${key}}`, String(value)),
    template,
  );
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function describeExportError(err: unknown, locale: Locale): string {
  if (err instanceof Error && err.message === 'SAVE_PICKER_UNAVAILABLE') {
    return t(locale, 'settings.channels.exportPickerUnavailable');
  }
  return describeError(err);
}

function inputValueAfterPaste(event: ReactClipboardEvent<HTMLInputElement>): string | null {
  const text =
    event.clipboardData.getData('text/plain') ||
    event.clipboardData.getData('text');
  if (!text) return null;
  event.preventDefault();
  const input = event.currentTarget;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  return `${input.value.slice(0, start)}${text}${input.value.slice(end)}`;
}

function stopSettingsInputKeyPropagation(
  event: ReactKeyboardEvent<HTMLInputElement>,
): void {
  event.stopPropagation();
}

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<SettingsTab>('general');
  const cliRuntime = useCliRuntimeState();
  const locale = useStore((s) => s.locale);
  const setLocale = useStore((s) => s.setLocale);
  const promptAutoTranslate = useStore((s) => s.promptAutoTranslate);
  const setPromptAutoTranslate = useStore((s) => s.setPromptAutoTranslate);
  const workflow = useStore((s) => s.workflow);
  const composer = useStore((s) => s.composer);
  const activeGatewaySelection = useMemo(
    () => workflowDefaultGatewaySelection(workflow, composer.model),
    [composer.model, workflow],
  );
  const personalInstructionsByModel = useStore((s) => s.personalInstructionsByModel);
  const setPersonalInstructions = useStore((s) => s.setPersonalInstructions);
  const gameExpertSettings = useStore((s) => s.gameExpertSettings);
  const setGameExpertSettings = useStore((s) => s.setGameExpertSettings);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const workspaces = useStore((s) => s.workspaces);
  const [shortcutSettings, setShortcutSettingsState] = useState(
    loadShortcutSettings,
  );
  const settingsWorkspace = useMemo<WorkspaceSummary | null>(() => {
    if (activeWorkspaceId) {
      const match = workspaces.find((workspace) => workspace.id === activeWorkspaceId);
      if (match) return match;
    }
    return workspaces[0] ?? null;
  }, [activeWorkspaceId, workspaces]);
  const settingsProfileId = settingsProfileIdForWorkspacePath(
    settingsWorkspace?.path,
  );
  const settingsProfile = useMemo<SettingsProfileOptions>(
    () => ({ profileId: settingsProfileId }),
    [settingsProfileId],
  );
  const remoteSettingsProfile = isRemoteSettingsProfile(settingsProfileId);

  useEffect(() => {
    void preloadSettingsProfile(settingsProfileId);
  }, [settingsProfileId]);

  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const dragState = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!matchesShortcut(event, shortcutSettings['modal-close'])) return;
      if (document.querySelector('[data-shortcut-recorder-active="true"]')) {
        return;
      }
      if (document.querySelector('[data-settings-child-modal="true"]')) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, shortcutSettings]);

  useEffect(
    () => subscribeShortcutSettings(setShortcutSettingsState),
    [],
  );

  const handleHeaderPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // Ignore drags that start on interactive controls (e.g. the close button).
      if (event.button !== 0) return;
      if ((event.target as HTMLElement).closest('button, a, input, [role="button"]')) {
        return;
      }
      event.preventDefault();
      dragState.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: dragOffset.x,
        originY: dragOffset.y,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [dragOffset.x, dragOffset.y],
  );

  const handleHeaderPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const state = dragState.current;
      if (!state || state.pointerId !== event.pointerId) return;
      setDragOffset({
        x: state.originX + (event.clientX - state.startX),
        y: state.originY + (event.clientY - state.startY),
      });
    },
    [],
  );

  const handleHeaderPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const state = dragState.current;
      if (!state || state.pointerId !== event.pointerId) return;
      dragState.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [],
  );

  const languageOptions: LanguageOption[] = [...LANGUAGE_SELECT_OPTIONS];
  const targetLanguages = languageOptions.filter(
    (option) => option.id !== locale,
  );
  const panelId = `settings-panel-${tab}`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 sm:p-6"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="flex h-[calc(100vh-2.5rem)] w-[calc(100vw-2.5rem)] max-w-[1600px] max-h-[1000px] flex-col overflow-hidden rounded-lg border border-border bg-panel shadow-2xl"
        style={{ transform: `translate(${dragOffset.x}px, ${dragOffset.y}px)` }}
        onClick={(event) => event.stopPropagation()}
      >
        <div
          className="shrink-0 cursor-move select-none border-b border-border-soft bg-bg-alt px-5 py-4"
          onPointerDown={handleHeaderPointerDown}
          onPointerMove={handleHeaderPointerMove}
          onPointerUp={handleHeaderPointerUp}
          onPointerCancel={handleHeaderPointerUp}
        >
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent text-bg">
              <SettingsIcon size={18} strokeWidth={2.2} />
            </span>
            <div className="min-w-0 flex-1">
              <h2 id="settings-title" className="text-base font-semibold text-fg">
                {t(locale, 'settings.title')}
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-fg-faint">
                {t(locale, 'settings.subtitle')}
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-fg-faint">
                {remoteSettingsProfile
                  ? locale === 'zh-CN'
                    ? `当前云端项目独立设置：${settingsWorkspace?.name ?? settingsWorkspace?.path ?? '未命名项目'}`
                    : `Current remote project settings: ${settingsWorkspace?.name ?? settingsWorkspace?.path ?? 'Untitled project'}`
                  : locale === 'zh-CN'
                    ? '当前为本机共享设置：所有本地项目共用同一套账号和渠道。'
                    : 'Current local shared settings: local projects share one account/channel profile.'}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              title={t(locale, 'common.close')}
              aria-label={t(locale, 'common.close')}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-panel-2 text-fg-faint transition-colors hover:border-accent hover:text-fg"
            >
              <X size={15} strokeWidth={2.2} />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex flex-1 flex-col bg-border-soft sm:flex-row">
          <nav
            aria-label={t(locale, 'settings.title')}
            className="w-full shrink-0 overflow-y-auto border-b border-border-soft bg-bg-alt p-3 sm:w-56 sm:border-b-0 sm:border-r"
          >
            <div
              role="tablist"
              aria-orientation="vertical"
              className="flex flex-col gap-1"
            >
              {tabs.map((item) => {
                const active = item.id === tab;
                const Icon = item.Icon;
                return (
                  <button
                    key={item.id}
                    type="button"
                    id={`settings-tab-${item.id}`}
                    role="tab"
                    aria-selected={active}
                    aria-controls={`settings-panel-${item.id}`}
                    onClick={() => setTab(item.id)}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-left text-sm font-medium transition-colors',
                      active
                        ? 'border border-accent bg-accent/15 text-fg'
                        : 'border border-transparent text-fg-dim hover:bg-border-soft hover:text-fg',
                    )}
                  >
                    <Icon
                      size={15}
                      strokeWidth={2}
                      className={active ? 'text-accent' : 'text-fg-faint'}
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {t(locale, item.labelKey)}
                    </span>
                  </button>
                );
              })}
            </div>
          </nav>

          <section
            id={panelId}
            role="tabpanel"
            aria-labelledby={`settings-tab-${tab}`}
            className="min-w-0 flex-1 overflow-y-auto bg-panel px-6 py-5 md:px-8 md:py-7"
          >
            <div className={SETTINGS_CONTENT_MAX_WIDTH_CLASS}>
              {tab === 'general' ? (
                <GeneralSettings
                  locale={locale}
                  languageOptions={languageOptions}
                  targetLanguages={targetLanguages}
                  promptAutoTranslate={promptAutoTranslate}
                  setLocale={setLocale}
                  setPromptAutoTranslate={setPromptAutoTranslate}
                />
              ) : tab === 'personalization' ? (
                <PersonalizationSettings
                  locale={locale}
                  activeSelection={activeGatewaySelection}
                  personalInstructionsByModel={personalInstructionsByModel}
                  setPersonalInstructions={setPersonalInstructions}
                />
              ) : tab === 'models' ? (
                <ChannelsSettings
                  key={settingsProfileId ?? 'local'}
                  locale={locale}
                  cliRuntime={cliRuntime}
                />
              ) : tab === 'imageGeneration' ? (
                <ErrorBoundary label={t(locale, 'settings.tabs.imageGeneration')}>
                  <ImageGenerationSettingsPanel
                    key={settingsProfileId ?? 'local'}
                    locale={locale}
                    settingsProfile={settingsProfile}
                    remoteProfile={remoteSettingsProfile}
                  />
                </ErrorBoundary>
              ) : tab === 'musicGeneration' ? (
                <ErrorBoundary label={t(locale, 'settings.tabs.musicGeneration')}>
                  <MusicGenerationSettingsPanel
                    key={settingsProfileId ?? 'local'}
                    locale={locale}
                    settingsProfile={settingsProfile}
                    remoteProfile={remoteSettingsProfile}
                  />
                </ErrorBoundary>
              ) : tab === 'videoGeneration' ? (
                <ErrorBoundary label={t(locale, 'settings.tabs.videoGeneration')}>
                  <VideoGenerationSettingsPanel
                    key={settingsProfileId ?? 'local'}
                    locale={locale}
                    settingsProfile={settingsProfile}
                    remoteProfile={remoteSettingsProfile}
                  />
                </ErrorBoundary>
              ) : tab === 'worldModelGeneration' ? (
                <ErrorBoundary label={t(locale, 'settings.tabs.worldModelGeneration')}>
                  <WorldModelGenerationSettingsPanel
                    key={settingsProfileId ?? 'local'}
                    locale={locale}
                    settingsProfile={settingsProfile}
                    remoteProfile={remoteSettingsProfile}
                  />
                </ErrorBoundary>
              ) : tab === 'speechGeneration' ? (
                <ErrorBoundary label={t(locale, 'settings.tabs.speechGeneration')}>
                  <SpeechGenerationSettingsPanel
                    key={settingsProfileId ?? 'local'}
                    locale={locale}
                    settingsProfile={settingsProfile}
                    remoteProfile={remoteSettingsProfile}
                  />
                </ErrorBoundary>
              ) : tab === 'threeDGeneration' ? (
                <ThreeDGenerationSettingsPanel
                  key={settingsProfileId ?? 'local'}
                  locale={locale}
                  settingsProfile={settingsProfile}
                  remoteProfile={remoteSettingsProfile}
                />
              ) : tab === 'meshLibrary' ? (
                <MeshLibrarySettingsPanel
                  key={settingsProfileId ?? 'local'}
                  locale={locale}
                  settingsProfile={settingsProfile}
                />
              ) : tab === 'spriteGeneration' ? (
                <SpriteGenerationSettingsPanel
                  key={settingsProfileId ?? 'local'}
                  locale={locale}
                  settingsProfile={settingsProfile}
                />
              ) : tab === 'uiDesign' ? (
                <UiDesignChannelSettingsPanel
                  key={settingsProfileId ?? 'local'}
                  locale={locale}
                  settingsProfile={settingsProfile}
                />
              ) : tab === 'rigging' ? (
                <RiggingSettingsPanel
                  key={settingsProfileId ?? 'local'}
                  locale={locale}
                  settingsProfile={settingsProfile}
                  remoteProfile={remoteSettingsProfile}
                />
              ) : tab === 'capturePerf' ? (
                <CapturePerfSettingsPanel locale={locale} />
              ) : tab === 'gameExperts' ? (
                <GameExpertSettingsPanel
                  locale={locale}
                  settings={gameExpertSettings}
                  setSettings={setGameExpertSettings}
                />
              ) : tab === 'consensus' ? (
                <ConsensusSettings locale={locale} />
              ) : tab === 'commands' ? (
                <CommandsSettings locale={locale} />
              ) : tab === 'mcp' || tab === 'lsp' || tab === 'skills' ? (
                <ErrorBoundary label={t(locale, `settings.tabs.${tab}`)}>
                  <ProjectToolsSettings locale={locale} embedTab={tab} />
                </ErrorBoundary>
              ) : tab === 'shortcuts' ? (
                <ShortcutsSettings
                  locale={locale}
                  settings={shortcutSettings}
                  onSettingsChange={setShortcutSettingsState}
                />
              ) : tab === 'appearance' ? (
                <AppearanceSettings locale={locale} />
              ) : tab === 'about' ? (
                <AboutSettings locale={locale} />
              ) : null}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

/**
 * Hosts the project-scoped MCP / LSP / Skills tabs inside the global Settings
 * modal. It resolves the active workspace and renders ProjectSettingsModal in
 * embedded mode (only the requested tab's content), so the UI and behavior are
 * identical to the former project-settings tabs. When no workspace is active,
 * it shows a short hint instead.
 */
function ProjectToolsSettings({
  locale,
  embedTab,
}: {
  locale: Locale;
  embedTab: ProjectEmbedTab;
}) {
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const workspaces = useStore((s) => s.workspaces);
  const workspace = useMemo<WorkspaceSummary | null>(() => {
    if (activeWorkspaceId) {
      const match = workspaces.find((item) => item.id === activeWorkspaceId);
      if (match) return match;
    }
    return workspaces[0] ?? null;
  }, [activeWorkspaceId, workspaces]);

  if (!workspace) {
    return (
      <div className="rounded-md border border-border-soft bg-bg-alt px-4 py-6 text-center text-sm text-fg-faint">
        {locale === 'zh-CN'
          ? '请先打开或选择一个项目，再配置 MCP / LSP / Skills。'
          : 'Open or select a project first to configure MCP / LSP / Skills.'}
      </div>
    );
  }

  return (
    <ProjectSettingsModal
      // Remount when the active workspace changes so project-scoped state
      // (scan, settings, lifecycle) re-initializes for the new workspace.
      key={workspace.id}
      workspace={workspace}
      embedTab={embedTab}
      onClose={() => undefined}
    />
  );
}

function useCliRuntimeState(): CliRuntimeSnapshot {
  const [state, setState] = useState<CliRuntimeSnapshot>(() =>
    getCliRuntimeSnapshot(),
  );

  useEffect(() => {
    setState(getCliRuntimeSnapshot());
    const unsubscribe = subscribeCliRuntime(setState);
    void primeCliRuntime();
    return unsubscribe;
  }, []);

  return state;
}

function useTranslationSettingsState(): [
  TranslationSettings,
  (patch: Partial<TranslationSettings>) => void,
] {
  const [settings, setSettings] = useState<TranslationSettings>(() =>
    loadTranslationSettings(),
  );

  useEffect(() => subscribeTranslationSettings(setSettings), []);

  const updateSettings = useCallback((patch: Partial<TranslationSettings>) => {
    setSettings((current) => {
      const next = { ...current, ...patch };
      saveTranslationSettings(next);
      return next;
    });
  }, []);

  return [settings, updateSettings];
}

function translationProviderSelectOptions(
  locale: Locale,
): TranslationProviderOption[] {
  return [
    {
      id: 'google',
      label: t(locale, 'settings.translationProvider.google'),
      hint: t(locale, 'settings.translationProvider.googleShort'),
    },
    {
      id: 'baidu',
      label: t(locale, 'settings.translationProvider.baidu'),
      hint: t(locale, 'settings.translationProvider.baiduShort'),
    },
    {
      id: 'mymemory',
      label: t(locale, 'settings.translationProvider.mymemory'),
      hint: t(locale, 'settings.translationProvider.mymemoryShort'),
    },
    {
      id: 'libretranslate',
      label: t(locale, 'settings.translationProvider.libretranslate'),
      hint: t(locale, 'settings.translationProvider.libretranslateShort'),
    },
  ];
}

function translationProviderHint(
  locale: Locale,
  providerId: TranslationProviderId,
): string {
  switch (providerId) {
    case 'google':
      return t(locale, 'settings.translationProvider.googleHint');
    case 'baidu':
      return t(locale, 'settings.translationProvider.baiduHint');
    case 'mymemory':
      return t(locale, 'settings.translationProvider.mymemoryHint');
    case 'libretranslate':
      return t(locale, 'settings.translationProvider.libretranslateHint');
    default:
      providerId satisfies never;
      return '';
  }
}

function GeneralSettings({
  locale,
  languageOptions,
  targetLanguages,
  promptAutoTranslate,
  setLocale,
  setPromptAutoTranslate,
}: {
  locale: Locale;
  languageOptions: LanguageOption[];
  targetLanguages: LanguageOption[];
  promptAutoTranslate: boolean;
  setLocale: (locale: Locale) => void;
  setPromptAutoTranslate: (enabled: boolean) => void;
}) {
  // Launch shell that wraps AI CLI invocations (independent of the model CLI).
  const [runShell, setRunShellState] = useState<RunShellConfig>(() =>
    getRunShell(),
  );
  const [shellError, setShellError] = useState<string | null>(null);
  const [translationSettings, setTranslationSettings] =
    useTranslationSettingsState();
  const translationProviderOptions = useMemo(
    () => translationProviderSelectOptions(locale),
    [locale],
  );

  const applyShell = (config: RunShellConfig) => {
    setRunShell(config);
    setRunShellState(config);
  };

  const selectShellKind = async (kind: RunShellKind) => {
    setShellError(null);
    if (kind !== 'custom') {
      applyShell({ kind });
      return;
    }
    if (!isTauri()) {
      setShellError(t(locale, 'settings.cliDesktopOnly'));
      return;
    }
    try {
      const path = await pickFile(t(locale, 'settings.shellPickTitle'));
      if (!path) return;
      const normalized = await validateShellPath(path);
      applyShell({ kind: 'custom', path: normalized });
    } catch (err) {
      setShellError(stripCliErrorPrefix(err instanceof Error ? err.message : String(err)));
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-lg font-semibold text-fg">
          {t(locale, 'settings.generalTitle')}
        </h3>
        <p className="mt-1 text-xs leading-relaxed text-fg-faint">
          {t(locale, 'settings.generalDescription')}
        </p>
      </div>

      <SettingRow
        title={t(locale, 'settings.languageLabel')}
        description={t(locale, 'settings.languageDescription')}
      >
        <div className="w-full max-w-[24rem]">
          <SelectControl
            value={locale}
            options={languageOptions}
            onChange={(id) => setLocale(id)}
            icon={<Globe size={15} strokeWidth={2.1} />}
          />
        </div>
      </SettingRow>

      <SettingRow
        title={t(locale, 'settings.autoTranslateLabel')}
        description={t(locale, 'settings.autoTranslateDescription')}
      >
        <button
          type="button"
          role="switch"
          aria-checked={promptAutoTranslate}
          onClick={() => setPromptAutoTranslate(!promptAutoTranslate)}
          className={cn(
            'relative h-6 w-11 rounded-full border transition-colors',
            promptAutoTranslate
              ? 'border-accent bg-accent/25'
              : 'border-border bg-panel-2',
          )}
        >
          <span
            className={cn(
              'absolute left-0.5 top-0.5 h-5 w-5 rounded-full transition-transform',
              promptAutoTranslate
                ? 'translate-x-5 bg-accent'
                : 'translate-x-0 bg-fg-faint',
            )}
          />
        </button>
      </SettingRow>

      <SettingRow
        title={t(locale, 'settings.translationProviderLabel')}
        description={t(locale, 'settings.translationProviderDescription')}
      >
        <div className="w-full max-w-[34rem] space-y-3">
          <SelectControl<TranslationProviderId>
            value={translationSettings.providerId}
            options={translationProviderOptions}
            onChange={(providerId) => setTranslationSettings({ providerId })}
            icon={<Languages size={15} strokeWidth={2.1} />}
          />
          <p className="text-xs leading-relaxed text-fg-faint">
            {translationProviderHint(locale, translationSettings.providerId)}
          </p>

          {translationSettings.providerId === 'baidu' && (
            <div className="grid gap-2 rounded-md border border-border bg-panel-2 p-3 sm:grid-cols-2">
              <label className="space-y-1 text-xs text-fg-dim">
                <span>{t(locale, 'settings.translationBaiduAppId')}</span>
                <input
                  value={translationSettings.baiduAppId}
                  onChange={(event) =>
                    setTranslationSettings({ baiduAppId: event.target.value })
                  }
                  className="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg outline-none transition-colors focus:border-accent"
                  placeholder="APP ID"
                  autoComplete="off"
                />
              </label>
              <label className="space-y-1 text-xs text-fg-dim">
                <span>{t(locale, 'settings.translationBaiduSecretKey')}</span>
                <input
                  type="password"
                  value={translationSettings.baiduSecretKey}
                  onChange={(event) =>
                    setTranslationSettings({
                      baiduSecretKey: event.target.value,
                    })
                  }
                  className="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg outline-none transition-colors focus:border-accent"
                  placeholder={t(locale, 'settings.translationSecretPlaceholder')}
                  autoComplete="off"
                />
              </label>
              <p className="sm:col-span-2 text-[11px] leading-relaxed text-fg-faint">
                {t(locale, 'settings.translationCredentialHint')}
              </p>
            </div>
          )}

          {translationSettings.providerId === 'libretranslate' && (
            <div className="grid gap-2 rounded-md border border-border bg-panel-2 p-3 sm:grid-cols-2">
              <label className="space-y-1 text-xs text-fg-dim">
                <span>{t(locale, 'settings.translationLibreBaseUrl')}</span>
                <input
                  value={translationSettings.libreTranslateBaseUrl}
                  onChange={(event) =>
                    setTranslationSettings({
                      libreTranslateBaseUrl: event.target.value,
                    })
                  }
                  className="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg outline-none transition-colors focus:border-accent"
                  placeholder="https://libretranslate.com"
                  autoComplete="off"
                />
              </label>
              <label className="space-y-1 text-xs text-fg-dim">
                <span>{t(locale, 'settings.translationLibreApiKey')}</span>
                <input
                  type="password"
                  value={translationSettings.libreTranslateApiKey}
                  onChange={(event) =>
                    setTranslationSettings({
                      libreTranslateApiKey: event.target.value,
                    })
                  }
                  className="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg outline-none transition-colors focus:border-accent"
                  placeholder={t(locale, 'settings.translationOptionalKey')}
                  autoComplete="off"
                />
              </label>
              <p className="sm:col-span-2 text-[11px] leading-relaxed text-fg-faint">
                {t(locale, 'settings.translationCredentialHint')}
              </p>
            </div>
          )}
        </div>
      </SettingRow>

      <SettingRow
        title={t(locale, 'settings.shellLabel')}
        description={t(locale, 'settings.shellDescription')}
      >
        <div className="w-full max-w-[32rem] space-y-2">
          <div className="flex flex-wrap gap-2">
            {(
              [
                ['direct', 'settings.shellDirect'],
                ['cmd', 'settings.shellCmd'],
                ['powershell', 'settings.shellPowershell'],
                ['custom', 'settings.shellCustom'],
              ] as Array<[RunShellKind, TranslationKey]>
            ).map(([kind, labelKey]) => {
              const active = runShell.kind === kind;
              return (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    void selectShellKind(kind);
                  }}
                  className={cn(
                    'rounded-md border px-3 py-1.5 text-xs transition-colors',
                    active
                      ? 'border-accent bg-accent/15 text-fg'
                      : 'border-border bg-panel text-fg-dim hover:border-accent hover:text-fg',
                  )}
                >
                  {t(locale, labelKey)}
                </button>
              );
            })}
          </div>
          {runShell.kind === 'custom' && runShell.path && (
            <p className="truncate font-mono text-[11px] text-fg-faint" title={runShell.path}>
              {runShell.path}
            </p>
          )}
          <p className="text-xs leading-relaxed text-fg-faint">
            {t(locale, 'settings.shellHint')}
          </p>
          {shellError && (
            <p className="text-xs leading-relaxed text-[#f78b8b]">{shellError}</p>
          )}
        </div>
      </SettingRow>

      <SettingRow title={t(locale, 'settings.targetLanguages')}>
        <div className="flex flex-wrap gap-2">
          {targetLanguages.map((option) => (
            <span
              key={option.id}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs',
                promptAutoTranslate
                  ? 'border-accent/40 bg-accent/10 text-fg'
                  : 'border-border bg-panel text-fg-faint',
              )}
            >
              <span>{option.label}</span>
              {option.hint && (
                <span className="font-mono text-[10px] text-fg-faint">
                  {option.hint}
                </span>
              )}
            </span>
          ))}
        </div>
      </SettingRow>
    </div>
  );
}

function PersonalizationSettings({
  locale,
  activeSelection,
  personalInstructionsByModel,
  setPersonalInstructions,
}: {
  locale: Locale;
  activeSelection: GatewaySelection;
  personalInstructionsByModel: PersonalInstructionsByModel;
  setPersonalInstructions: (
    instructions: string,
    selection?: GatewaySelection | null,
  ) => void;
}) {
  const activeLabel = personalInstructionsSelectionLabel(activeSelection);
  const entries = useMemo(
    () =>
      personalInstructionsEntries(
        activeSelection,
        activeLabel,
        personalInstructionsByModel,
      ),
    [activeLabel, activeSelection, personalInstructionsByModel],
  );
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    setDrafts((previous) => {
      const visibleKeys = new Set(entries.map((entry) => entry.key));
      let changed = false;
      const next = { ...previous };
      for (const entry of entries) {
        if (entry.key in next) continue;
        next[entry.key] = personalInstructionsForSelection(
          personalInstructionsByModel,
          entry.selection,
        );
        changed = true;
      }
      for (const key of Object.keys(next)) {
        if (visibleKeys.has(key)) continue;
        delete next[key];
        changed = true;
      }
      return changed ? next : previous;
    });
  }, [entries, personalInstructionsByModel]);

  const setDraft = (key: string, value: string) => {
    setDrafts((previous) => ({ ...previous, [key]: value }));
  };

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-lg font-semibold text-fg">
          {t(locale, 'settings.personalizationTitle')}
        </h3>
        <p className="mt-1 text-xs leading-relaxed text-fg-faint">
          {t(locale, 'settings.personalizationDescription')}
        </p>
        <p className="mt-2 text-xs leading-relaxed text-fg-faint">
          {t(locale, 'settings.personalizationFieldDescription')}
        </p>
      </div>

      <div className="space-y-3">
        {entries.map((entry) => {
          const savedInstructions = personalInstructionsForSelection(
            personalInstructionsByModel,
            entry.selection,
          );
          const draft = drafts[entry.key] ?? savedInstructions;
          return (
            <PersonalizationModelCard
              key={entry.key}
              locale={locale}
              entry={entry}
              savedInstructions={savedInstructions}
              draft={draft}
              onDraftChange={(value) => setDraft(entry.key, value)}
              onUseSample={() =>
                setDraft(entry.key, personalInstructionsSample(entry.selection))
              }
              onClear={() => {
                setDraft(entry.key, '');
                setPersonalInstructions('', entry.selection);
              }}
              onSave={() => {
                // Persist, then sync the draft to the normalized value the store
                // actually stored (trimmed + required larkdoc section appended).
                // Otherwise the draft keeps differing from the saved value and
                // the button never flips to "已保存", making it look like the
                // save did not stick.
                setPersonalInstructions(draft, entry.selection);
                setDraft(entry.key, ensureRequiredPersonalInstructions(draft));
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

interface PersonalizationEntry {
  key: string;
  selection: GatewaySelection;
  label: string;
  hint?: string;
  current: boolean;
  saved: boolean;
  available: boolean;
}

function personalInstructionsEntries(
  activeSelection: GatewaySelection,
  activeLabel: string,
  personalInstructionsByModel: PersonalInstructionsByModel,
): PersonalizationEntry[] {
  const activeKey = personalInstructionsKey(activeSelection);
  const byKey = new Map<string, PersonalizationEntry>();
  const upsert = (
    selection: GatewaySelection,
    label: string,
    hint: string | undefined,
    flags: Partial<Pick<PersonalizationEntry, 'current' | 'available'>>,
  ) => {
    const key = personalInstructionsKey(selection);
    const saved = Boolean(personalInstructionsByModel[key]?.trim());
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        key,
        selection,
        label,
        hint,
        current: flags.current === true || key === activeKey,
        saved,
        available: flags.available === true,
      });
      return;
    }
    const replaceLabel = !existing.current && flags.available === true;
    byKey.set(key, {
      ...existing,
      selection,
      label: replaceLabel ? label : existing.label,
      hint: replaceLabel ? hint : existing.hint ?? hint,
      current: existing.current || flags.current === true || key === activeKey,
      saved: existing.saved || saved,
      available: existing.available || flags.available === true,
    });
  };

  upsert(activeSelection, activeLabel, undefined, {
    current: true,
    available: true,
  });

  for (const [key, instructions] of Object.entries(personalInstructionsByModel)) {
    if (!instructions.trim()) continue;
    const selection = selectionFromPersonalInstructionsKey(key);
    if (!selection) continue;
    upsert(selection, personalInstructionsSelectionLabel(selection), undefined, {});
  }

  for (const option of listGatewayRunOptions()) {
    upsert(option.selection, option.label, option.hint, { available: true });
  }

  return Array.from(byKey.values()).sort((a, b) => {
    const rank = (entry: PersonalizationEntry) =>
      entry.current ? 0 : entry.saved ? 1 : entry.available ? 2 : 3;
    const rankDelta = rank(a) - rank(b);
    if (rankDelta !== 0) return rankDelta;
    return a.label.localeCompare(b.label);
  });
}

function PersonalizationModelCard({
  locale,
  entry,
  savedInstructions,
  draft,
  onDraftChange,
  onUseSample,
  onClear,
  onSave,
}: {
  locale: Locale;
  entry: PersonalizationEntry;
  savedInstructions: string;
  draft: string;
  onDraftChange: (value: string) => void;
  onUseSample: () => void;
  onClear: () => void;
  onSave: () => void;
}) {
  const dirty = draft !== savedInstructions;
  return (
    <div className="rounded-lg border border-border bg-bg-alt p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h4 className="min-w-0 flex-1 truncate font-mono text-[12px] font-semibold text-fg">
          {entry.label}
        </h4>
        {entry.current && (
          <span className="rounded-md border border-accent/40 bg-accent/10 px-2 py-0.5 text-[11px] text-accent">
            {t(locale, 'settings.personalizationCurrentModel')}
          </span>
        )}
        {entry.saved && (
          <span className="rounded-md border border-border bg-panel px-2 py-0.5 text-[11px] text-fg-dim">
            {t(locale, 'settings.personalizationSaved')}
          </span>
        )}
      </div>
      {entry.hint && (
        <p className="mb-2 truncate text-[11px] text-fg-faint">{entry.hint}</p>
      )}
      <label className="block space-y-2">
        <span className="text-sm font-medium text-fg">
          {t(locale, 'settings.personalizationFieldLabel')}
        </span>
        <textarea
          value={draft}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
            onDraftChange(event.target.value)
          }
          placeholder={t(locale, 'settings.personalizationPlaceholder')}
          spellCheck={false}
          className="min-h-[8.5rem] max-h-[16rem] w-full resize-y rounded-md border border-border bg-panel px-3 py-2 font-mono text-xs leading-relaxed text-fg outline-none transition-colors placeholder:text-fg-faint focus:border-accent"
        />
      </label>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={onUseSample}
          className="rounded-md border border-border bg-panel px-3 py-1.5 text-xs text-fg-dim transition-colors hover:border-accent hover:text-fg"
        >
          {t(locale, 'settings.personalizationUseSample')}
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onClear}
            disabled={!draft && !savedInstructions}
            className="rounded-md border border-border bg-panel px-3 py-1.5 text-xs text-fg-dim transition-colors hover:border-rose-400 hover:text-rose-200 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t(locale, 'settings.personalizationClear')}
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={!dirty}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {dirty
              ? t(locale, 'settings.personalizationSave')
              : t(locale, 'settings.personalizationSaved')}
          </button>
        </div>
      </div>
    </div>
  );
}

function personalInstructionsSelectionLabel(selection: GatewaySelection): string {
  const adapter =
    RUNTIME_ADAPTERS.find((item) => item.id === selection.adapter)?.label ??
    runtimeAdapterLabel(selection.adapter as RuntimeAdapterId);
  const channel = selection.systemDefault
    ? 'system'
    : [selection.providerId, selection.channelId].filter(Boolean).join('/') ||
      'default';
  const model =
    selection.modelOverride?.trim() || selection.modelClass || 'default';
  return `${adapter} · ${channel} · ${model}`;
}

function stripCliErrorPrefix(raw: string): string {
  return raw.replace(/^[A-Z_]+:\s*/u, '').trim();
}

/** Map a stored provider kind to its runtime adapter id. */
function providerKindToAdapter(kind: Provider['kind']): RuntimeAdapterId {
  if (kind === 'codex') return 'codex';
  if (kind === 'gemini') return 'gemini';
  return 'claude-code';
}

/** Map a runtime adapter id back to the stored provider kind. */
function adapterToProviderKind(adapter: RuntimeAdapterId): Provider['kind'] {
  if (adapter === 'codex') return 'codex';
  if (adapter === 'gemini') return 'gemini';
  return 'anthropic';
}

/** Order + dot color for the three provider categories in the Models tab. */
const PROVIDER_ADAPTER_SECTIONS: ReadonlyArray<{
  adapter: RuntimeAdapterId;
  dotClassName: string;
}> = [
  { adapter: 'claude-code', dotClassName: 'bg-amber-400' },
  { adapter: 'codex', dotClassName: 'bg-fg-faint' },
  { adapter: 'gemini', dotClassName: 'bg-sky-400' },
];

type BadgeState = 'direct' | 'cli' | 'unavailable' | 'default';
type ProviderDraft = Omit<Provider, 'id'>;
type ProviderEditorMode = 'add' | 'edit';

type ChannelSettingsTab = 'default' | 'free';
const DEFAULT_PROVIDER_OPTION_PREFIX = 'default-provider:';
const SYSTEM_DEFAULT_OPTION_PREFIX = 'system-default:';
const FREE_CHANNEL_OPTION_PREFIX = 'free:';
const MODEL_DEFAULT_OPTION_ID = '__default_model__';
const CLAUDE_MODEL_CLASS_OPTIONS = ['sonnet', 'opus', 'haiku'];
const SETTINGS_CONTENT_MAX_WIDTH_CLASS = 'w-full max-w-[1180px]';
const SETTINGS_INNER_TABLIST_CLASS =
  'flex w-full min-w-0 flex-wrap items-center gap-1 border-b border-border';
const SETTINGS_INNER_TAB_CLASS =
  'px-4 py-2 text-xs font-medium outline-none transition-colors focus-visible:ring-1 focus-visible:ring-accent';
const SETTINGS_PROVIDER_GRID_CLASS = 'grid gap-2.5 xl:grid-cols-2';

function defaultProviderOptionId(providerId: string): string {
  return `${DEFAULT_PROVIDER_OPTION_PREFIX}${providerId}`;
}

function systemDefaultOptionId(adapter: RuntimeAdapterId): string {
  return `${SYSTEM_DEFAULT_OPTION_PREFIX}${adapter}`;
}

function freeChannelOptionId(channelId: string): string {
  return `${FREE_CHANNEL_OPTION_PREFIX}${channelId}`;
}

function providerIdFromDefaultOption(optionId: string): string | null {
  if (!optionId.startsWith(DEFAULT_PROVIDER_OPTION_PREFIX)) return null;
  return optionId.slice(DEFAULT_PROVIDER_OPTION_PREFIX.length) || null;
}

function adapterFromSystemDefaultOption(
  optionId: string,
): RuntimeAdapterId | null {
  if (!optionId.startsWith(SYSTEM_DEFAULT_OPTION_PREFIX)) return null;
  const adapterId = optionId.slice(SYSTEM_DEFAULT_OPTION_PREFIX.length);
  return RUNTIME_ADAPTERS.find((adapter) => adapter.id === adapterId)?.id ?? null;
}

function freeChannelFromOption(optionId: string): string | null {
  if (!optionId.startsWith(FREE_CHANNEL_OPTION_PREFIX)) return null;
  const channelId = optionId.slice(FREE_CHANNEL_OPTION_PREFIX.length);
  return freeChannelById(channelId) ? channelId : null;
}

function defaultChannelRuntimeLabel(
  locale: Locale,
  adapter: { label: string },
): string {
  return `${adapter.label} · ${t(locale, 'dock.channelKindDefault')}`;
}

function defaultChannelRuntimeGroup(
  locale: Locale,
  adapter: { label: string },
): string {
  return `${t(locale, 'dock.channelGroupDefault')} · ${adapter.label}`;
}

function modelFromOptionId(optionId: string): string {
  return optionId === MODEL_DEFAULT_OPTION_ID ? '' : optionId;
}

function providerSelection(provider: Provider, modelOverride?: string) {
  const adapter = providerKindToAdapter(provider.kind);
  const model = (modelOverride ?? provider.model ?? '').trim();
  return {
    adapter,
    modelClass: model || 'default',
    providerId: provider.id,
    channelId: 'default',
  };
}

function uniqueModelOptions(
  models: Array<string | undefined | null>,
): Array<{ id: string; label: string; hint?: string }> {
  const out: Array<{ id: string; label: string; hint?: string }> = [];
  const seen = new Set<string>();
  for (const raw of models) {
    const model = raw?.trim();
    if (!model) continue;
    const key = model.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: model, label: model });
  }
  return out;
}

function ChannelsSettings({
  locale,
  cliRuntime,
}: {
  locale: Locale;
  cliRuntime: CliRuntimeSnapshot;
}) {
  const [channelTab, setChannelTab] = useState<ChannelSettingsTab>('default');
  const channelTabs: Array<{
    id: ChannelSettingsTab;
    label: string;
  }> = [
    { id: 'default', label: t(locale, 'settings.modelsTitle') },
    { id: 'free', label: t(locale, 'settings.freeChannels.title') },
  ];

  return (
    <div className="space-y-5">
      <GlobalRunControls locale={locale} cliRuntime={cliRuntime} />

      <div>
        <div
          role="tablist"
          aria-orientation="horizontal"
          className={SETTINGS_INNER_TABLIST_CLASS}
        >
          {channelTabs.map((item) => {
            const active = channelTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setChannelTab(item.id)}
                className={cn(
                  SETTINGS_INNER_TAB_CLASS,
                  active
                    ? '-mb-px border-b-2 border-accent text-fg'
                    : 'text-fg-faint hover:text-fg',
                )}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      </div>

      <div role="tabpanel">
        {channelTab === 'default' ? (
          <ModelsSettings locale={locale} cliRuntime={cliRuntime} />
        ) : (
          <FreeChannelsSettings locale={locale} />
        )}
      </div>
    </div>
  );
}

function GlobalRunControls({
  locale,
  cliRuntime,
}: {
  locale: Locale;
  cliRuntime: CliRuntimeSnapshot;
}) {
  // Settings configures the *default* channel only. It must persist globally and
  // affect newly opened sessions without touching any session already in flight
  // (those switch channel from the input-box selector instead). So we use
  // setDefaultRunSelection — setGlobalRunSelection mutates the active session's
  // workflow and is blocked while a run is read-only, which would wrongly lock
  // the default-channel picker whenever any session is running.
  const setDefaultRunSelection = useStore((s) => s.setDefaultRunSelection);
  const composerModelOptions = useStore((s) => s.modelOptions);
  const [revision, setRevision] = useState(0);
  const [modelListRevision, setModelListRevision] = useState(0);
  const [loadingModels, setLoadingModels] = useState(false);
  const [manifestMode, setManifestModeState] = useState(() =>
    getManifestModeEnabled(),
  );
  // The picked selection is held in component state rather than re-read from
  // localStorage on every render. This mirrors the reactive input-box selector
  // (which reflects in-memory store state) and, crucially, keeps the display
  // correct even when the localStorage write fails — e.g. quota full, in which
  // case gatewayConfig.rawSet swallows the error and never dispatches
  // 'ugs:gateway-config-changed', so an event-only refresh would snap back to
  // the stale value. onChannelChange/onModelChange update it optimistically.
  const [runSelection, setRunSelection] = useState<GatewaySelection>(() =>
    getActiveGatewaySelection(),
  );

  useEffect(() => subscribeManifestMode(setManifestModeState), []);

  useEffect(() => {
    const refresh = () => {
      setRevision((n) => n + 1);
      setRunSelection(getActiveGatewaySelection());
    };
    window.addEventListener('ugs:gateway-config-changed', refresh);
    return () => window.removeEventListener('ugs:gateway-config-changed', refresh);
  }, []);

  useEffect(() => {
    const refresh = () => setModelListRevision((n) => n + 1);
    window.addEventListener('ugs:model-list-changed', refresh);
    return () => window.removeEventListener('ugs:model-list-changed', refresh);
  }, []);

  const defaultChannelProviders = useMemo(() => {
    void revision;
    const desktop = isTauri();
    const sorted = listProviders()
      .filter((provider) => !isRemoteRunnerProvider(provider))
      .map((provider) => {
        const adapter = providerKindToAdapter(provider.kind);
        const runtime = getProviderRuntimeInfo(provider, {
          canUseCliFallback:
            desktop && isCliAdapterAvailable(adapter, cliRuntime),
        });
        return { provider, adapter, status: runtime.status };
      })
      .sort((a, b) => {
        const adapterRank =
          RUNTIME_ADAPTERS.findIndex((item) => item.id === a.adapter) -
          RUNTIME_ADAPTERS.findIndex((item) => item.id === b.adapter);
        if (adapterRank !== 0) return adapterRank;
        const rankA = providerSortRank(a.status);
        const rankB = providerSortRank(b.status);
        if (rankA !== rankB) return rankA - rankB;
        return a.provider.name.localeCompare(b.provider.name);
      });
    const seen = new Set<string>();
    return sorted.filter(({ provider, adapter }) => {
      const key = [
        adapter,
        provider.name.trim().toLowerCase(),
        provider.baseUrl.trim().replace(/\/+$/, '').toLowerCase(),
        (provider.model ?? '').trim().toLowerCase(),
      ].join('\0');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [cliRuntime, revision]);

  const channelOptions = useMemo(
    () => {
      const defaultOptions = RUNTIME_ADAPTERS.flatMap((adapter) => {
        const hint = defaultChannelRuntimeLabel(locale, adapter);
        const group = defaultChannelRuntimeGroup(locale, adapter);
        return [
          {
            id: systemDefaultOptionId(adapter.id),
            label: `${adapter.label} · ${t(locale, 'dock.channelSystemDefault')}`,
            hint,
            group,
          },
          ...defaultChannelProviders
            .filter((item) => item.adapter === adapter.id)
            .map(({ provider }) => ({
              id: defaultProviderOptionId(provider.id),
              label: provider.name.trim() || adapter.label,
              hint,
              group,
            })),
        ];
      });

      return [
        ...defaultOptions,
        ...FREE_CHANNELS.map((channel) => {
          const ready = freeChannelReady(channel.id);
          const hint = channel.local
            ? ready
              ? t(locale, 'settings.freeChannels.localConfigured')
              : t(locale, 'settings.freeChannels.localNeedsSetup')
            : ready
              ? t(locale, 'settings.freeChannels.ready')
              : t(locale, 'settings.freeChannels.needsKey');
          return {
            id: freeChannelOptionId(channel.id),
            label: channel.label,
            hint,
            group: t(locale, 'dock.channelGroupFree'),
          };
        }),
      ];
    },
    [defaultChannelProviders, locale],
  );

  const selectedFreeChannelId = isFreeChannelSelection(runSelection);
  // Match a pinned provider on its globally-unique id alone. The adapter is
  // derived from the resolved provider, not the stored selection.adapter, so a
  // drifted/stale adapter on the persisted selection can't drop a valid match
  // and snap the dropdown back to the system default.
  const pinnedDefaultProvider = runSelection.providerId
    ? defaultChannelProviders.find(
        (item) => item.provider.id === runSelection.providerId,
      )
    : undefined;
  const selectedAdapter =
    pinnedDefaultProvider?.adapter ??
    RUNTIME_ADAPTERS.find((adapter) => adapter.id === runSelection.adapter)?.id ??
    RUNTIME_ADAPTERS[0].id;
  const selectedFreeChannel = selectedFreeChannelId
    ? freeChannelById(selectedFreeChannelId)
    : undefined;
  const selectedDefaultProvider = selectedFreeChannel
    ? undefined
    : pinnedDefaultProvider;
  const channelValue = selectedFreeChannelId
    ? freeChannelOptionId(selectedFreeChannelId)
    : selectedDefaultProvider
      ? defaultProviderOptionId(selectedDefaultProvider.provider.id)
      : systemDefaultOptionId(selectedAdapter);

  useEffect(() => {
    if (!selectedFreeChannel) return;
    if (!canRefreshFreeChannelModels(selectedFreeChannel)) return;
    let disposed = false;
    setLoadingModels(true);
    void refreshFreeChannelModels(selectedFreeChannel)
      .catch(() => undefined)
      .finally(() => {
        if (!disposed) setLoadingModels(false);
      });
    return () => {
      disposed = true;
    };
  }, [selectedFreeChannel, revision]);

  useEffect(() => {
    if (selectedFreeChannel || !selectedDefaultProvider) return;
    let disposed = false;
    setLoadingModels(true);
    void refreshProviderModels(selectedDefaultProvider.provider)
      .catch(() => undefined)
      .finally(() => {
        if (!disposed) setLoadingModels(false);
      });
    return () => {
      disposed = true;
    };
  }, [
    selectedFreeChannel,
    selectedDefaultProvider,
    selectedDefaultProvider?.provider.id,
    selectedDefaultProvider?.provider.apiKey,
    selectedDefaultProvider?.provider.baseUrl,
    selectedDefaultProvider?.provider.model,
  ]);

  const modelOptions = useMemo(() => {
    void modelListRevision;
    const defaultOption = {
      id: MODEL_DEFAULT_OPTION_ID,
      label: t(locale, 'settings.models.modelNone'),
      hint: 'default',
    };
    if (selectedFreeChannel) {
      if (selectedFreeChannel.id === FREE_CHANNEL_AUTO_ID) {
        return uniqueModelOptions(freeChannelModelOptions(selectedFreeChannel));
      }
      return [
        defaultOption,
        ...uniqueModelOptions(freeChannelModelOptions(selectedFreeChannel)),
      ];
    }
    if (selectedDefaultProvider) {
      const provider = selectedDefaultProvider.provider;
      const fallback =
        selectedDefaultProvider.adapter === 'claude-code'
          ? [
              runSelection.modelClass,
              ...composerModelOptions.map((option) => option.id),
              ...CLAUDE_MODEL_CLASS_OPTIONS,
            ]
          : ['default', runSelection.modelClass];
      return [
        defaultOption,
        ...uniqueModelOptions([
          provider.model,
          ...providerModelOptions(provider),
          ...fallback,
        ]),
      ];
    }
    if (selectedAdapter === 'claude-code') {
      return [
        defaultOption,
        ...uniqueModelOptions([
          runSelection.modelClass,
          ...composerModelOptions.map((option) => option.id),
          ...CLAUDE_MODEL_CLASS_OPTIONS,
        ]),
      ];
    }
    return [
      defaultOption,
      ...uniqueModelOptions(['default', runSelection.modelClass]),
    ];
  }, [
    composerModelOptions,
    locale,
    modelListRevision,
    runSelection.modelClass,
    selectedAdapter,
    selectedDefaultProvider,
    selectedFreeChannel,
  ]);

  const modelValue = selectedFreeChannel
    ? selectedFreeChannel.id === FREE_CHANNEL_AUTO_ID
      ? getFreeChannelModel(selectedFreeChannel.id) || FREE_CHANNEL_AUTO_MODEL
      : getFreeChannelModel(selectedFreeChannel.id) || MODEL_DEFAULT_OPTION_ID
    : selectedDefaultProvider
      ? (selectedDefaultProvider.provider.model ?? '').trim() ||
        MODEL_DEFAULT_OPTION_ID
      : runSelection.systemDefault || runSelection.modelClass === 'default'
        ? MODEL_DEFAULT_OPTION_ID
        : runSelection.modelClass;

  // Persist the pick AND reflect it locally right away, so the dropdown shows
  // the chosen channel even if the durable localStorage write later fails.
  const applyDefaultRunSelection = (selection: GatewaySelection) => {
    setDefaultRunSelection(selection);
    setRunSelection(selection);
  };

  const onChannelChange = (id: string) => {
    const providerId = providerIdFromDefaultOption(id);
    if (providerId) {
      const provider = defaultChannelProviders.find(
        (item) => item.provider.id === providerId,
      )?.provider;
      if (!provider) return;
      applyDefaultRunSelection(providerSelection(provider));
      return;
    }

    const defaultAdapter = adapterFromSystemDefaultOption(id);
    if (defaultAdapter) {
      applyDefaultRunSelection(systemDefaultGatewaySelection(defaultAdapter));
      return;
    }

    const freeChannelId = freeChannelFromOption(id);
    if (!freeChannelId) return;
    void ensureFreeProxy();
    applyDefaultRunSelection(
      freeChannelSelection(freeChannelId, getFreeChannelModel(freeChannelId)),
    );
  };

  const onModelChange = (id: string) => {
    const selectedModel = modelFromOptionId(id);
    if (selectedFreeChannel) {
      setFreeChannelModel(selectedFreeChannel.id, selectedModel);
      void ensureFreeProxy();
      applyDefaultRunSelection(
        freeChannelSelection(
          selectedFreeChannel.id,
          selectedModel || getFreeChannelModel(selectedFreeChannel.id),
        ),
      );
      return;
    }
    if (selectedDefaultProvider) {
      const nextModel = selectedModel || undefined;
      const provider = selectedDefaultProvider.provider;
      updateProvider(provider.id, { model: nextModel });
      applyDefaultRunSelection(
        providerSelection({ ...provider, model: nextModel }, selectedModel),
      );
      return;
    }
    applyDefaultRunSelection(
      {
        ...systemDefaultGatewaySelection(selectedAdapter),
        modelClass: selectedModel || 'default',
      },
    );
  };

  const toggleManifestMode = (enabled: boolean) => {
    setManifestModeEnabled(enabled);
    setManifestModeState(enabled);
  };

  return (
    <div className="rounded-lg border border-border bg-bg-alt p-4">
      <div className="mb-3 flex items-center gap-2">
        <Sparkles size={16} strokeWidth={2.1} className="text-accent-2" />
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-fg">
            {t(locale, 'settings.models.active')}
          </h4>
          <p className="mt-0.5 text-[11px] leading-relaxed text-fg-faint">
            {t(locale, 'settings.modelsDescription')}
          </p>
        </div>
      </div>
      <div className="grid w-full min-w-0 gap-3 md:grid-cols-2">
        <label className="block min-w-0 space-y-1.5">
          <span className="text-[11px] font-semibold text-fg-dim">
            {t(locale, 'dock.channelTitle')}
          </span>
          <SelectControl
            value={channelValue}
            options={channelOptions}
            onChange={onChannelChange}
            icon={<Sparkles size={15} strokeWidth={2.1} />}
          />
        </label>
        <label className="block min-w-0 space-y-1.5">
          <span className="text-[11px] font-semibold text-fg-dim">
            {t(locale, 'dock.modelVersionTitle')}
          </span>
          <SelectControl
            value={modelValue}
            options={modelOptions}
            onChange={onModelChange}
            icon={
              <RefreshCw
                size={15}
                strokeWidth={2.1}
                className={loadingModels ? 'animate-spin' : undefined}
              />
            }
          />
        </label>
      </div>
      <div className="mt-4 flex flex-col gap-3 border-t border-border-soft pt-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="text-sm font-medium text-fg">
            {t(locale, 'settings.models.manifestModeLabel')}
          </div>
          <p className="text-xs leading-relaxed text-fg-faint">
            {t(locale, 'settings.models.manifestModeDesc')}
          </p>
        </div>
        <SwitchControl checked={manifestMode} onChange={toggleManifestMode} />
      </div>
    </div>
  );
}

function ModelsSettings({
  locale,
  cliRuntime,
}: {
  locale: Locale;
  cliRuntime: CliRuntimeSnapshot;
}) {
  const [providers, setProviders] = useState<Provider[]>(() => listProviders());
  const [editor, setEditor] = useState<{
    mode: ProviderEditorMode;
    providerId?: string;
    draft: ProviderDraft;
    initial: ProviderDraft;
  } | null>(null);
  const [importing, setImporting] = useState(false);
  const [status, setStatus] = useState<{ tone: 'ok' | 'err'; msg: string } | null>(
    null,
  );
  const jsonImportInputRef = useRef<HTMLInputElement | null>(null);
  const desktop = isTauri();

  const refresh = () => {
    setProviders(listProviders());
  };

  const handleAdd = (kind: Provider['kind'] = 'anthropic') => {
    const draft = providerDraft({
      kind,
      name: t(locale, 'settings.models.newProviderName'),
      apiKey: '',
      baseUrl: '',
    });
    setStatus(null);
    setEditor({ mode: 'add', draft, initial: draft });
  };

  const handleDelete = (id: string) => {
    if (!window.confirm(t(locale, 'settings.models.confirmDelete'))) return;
    deleteProvider(id);
    refresh();
  };

  const handleEditorDelete = (id: string) => {
    if (!window.confirm(t(locale, 'settings.models.confirmDelete'))) return;
    deleteProvider(id);
    setEditor(null);
    refresh();
  };

  const handleImport = async () => {
    setImporting(true);
    setStatus(null);
    try {
      const result = await importCcSwitchProviders({
        promoteActiveAnthropic: true,
      });
      if (result.status === 'empty') {
        setStatus({ tone: 'err', msg: t(locale, 'settings.models.importEmpty') });
        return;
      }
      if (result.status === 'no-source') {
        const msg =
          result.reason === 'NO_BACKEND'
            ? t(locale, 'settings.models.importDesktopOnly')
            : t(locale, 'settings.models.importNoDb');
        setStatus({ tone: 'err', msg });
        return;
      }
      if (result.status === 'failed') {
        const reason = result.reason ?? 'Unknown error';
        // 远程项目档案下，渠道是写到远程账号的；写入失败时给出可操作的说明，
        // 而不是让用户误以为"导入成功"。
        if (reason.startsWith('REMOTE_SYNC_FAILED')) {
          const detail = reason.slice('REMOTE_SYNC_FAILED:'.length).trim();
          const hint =
            locale === 'zh-CN'
              ? `已读取本地 cc-switch 数据，但同步到远程账号失败，请检查远程连接/登录后重试${detail ? `（${detail}）` : ''}`
              : `Read local cc-switch data, but syncing to the remote account failed. Check the remote connection/login and retry${detail ? ` (${detail})` : ''}`;
          setStatus({ tone: 'err', msg: hint });
          return;
        }
        setStatus({
          tone: 'err',
          msg: `${t(locale, 'settings.models.importError')}: ${reason}`,
        });
        return;
      }

      refresh();
      const msg =
        result.skippedCount > 0
          ? t(locale, 'settings.models.importSkipped')
              .replace('{n}', String(result.importedCount))
              .replace('{m}', String(result.skippedCount))
          : t(locale, 'settings.models.importSuccess').replace(
              '{n}',
              String(result.importedCount),
            );
      setStatus({ tone: 'ok', msg });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      let msg = `${t(locale, 'settings.models.importError')}: ${raw}`;
      if (raw === 'NO_BACKEND') msg = t(locale, 'settings.models.importDesktopOnly');
      else if (raw.includes('未找到 cc-switch') || raw.includes('not found'))
        msg = t(locale, 'settings.models.importNoDb');
      setStatus({ tone: 'err', msg });
    } finally {
      setImporting(false);
    }
  };

  const handleExportJson = async () => {
    setStatus(null);
    try {
      const saved = await exportJsonFile(
        exportDefaultChannelsConfig(),
        'ultragamestudio-default-channels.json',
        t(locale, 'settings.modelsTitle'),
      );
      if (!saved) return;
      setStatus({
        tone: 'ok',
        msg: t(locale, 'settings.channels.exportSuccess'),
      });
    } catch (err) {
      setStatus({
        tone: 'err',
        msg: `${t(locale, 'settings.channels.exportError')}: ${describeExportError(err, locale)}`,
      });
    }
  };

  const handleImportJson = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    setStatus(null);
    try {
      const result = importDefaultChannelsConfig(await readJsonFile(file));
      refresh();
      setStatus({
        tone: 'ok',
        msg: formatStatusMessage(t(locale, 'settings.channels.importSuccess'), {
          n: result.imported,
          m: result.updated,
          k: result.skipped,
        }),
      });
    } catch (err) {
      setStatus({
        tone: 'err',
        msg: `${t(locale, 'settings.channels.importError')}: ${describeError(err)}`,
      });
    }
  };

  const providerCards = useMemo(
    () =>
      providers
        .filter((provider) => !isRemoteRunnerProvider(provider))
        .map((provider) => {
          const adapter = providerKindToAdapter(provider.kind);
          const canUseCliFallback =
            desktop && isCliAdapterAvailable(adapter, cliRuntime);
          return {
            provider,
            adapter,
            runtime: getProviderRuntimeInfo(provider, { canUseCliFallback }),
          };
        })
        .sort((a, b) => {
          const rankA = providerSortRank(a.runtime.status);
          const rankB = providerSortRank(b.runtime.status);
          if (rankA !== rankB) return rankA - rankB;
          return a.provider.name.localeCompare(b.provider.name);
        }),
    [providers, desktop, cliRuntime],
  );
  const directCount = providerCards.filter(
    ({ runtime }) => runtime.status === 'direct',
  ).length;
  const providerCliCount = providerCards.filter(
    ({ runtime }) => runtime.status === 'cli',
  ).length;
  const systemCliAvailable = RUNTIME_ADAPTERS.some(
    (adapter) => desktop && isCliAdapterAvailable(adapter.id, cliRuntime),
  );
  const hasAvailableRuntime =
    directCount > 0 || providerCliCount > 0 || systemCliAvailable;
  const showNoRuntime = !hasAvailableRuntime;
  const showEmptyProviders = providerCards.length === 0 && hasAvailableRuntime;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-lg font-semibold text-fg">
            {t(locale, 'settings.modelsTitle')}
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-fg-faint">
            {t(locale, 'settings.modelsDescription')}
          </p>
        </div>
        <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto sm:shrink-0">
          <button
            type="button"
            onClick={() => handleAdd()}
            className="inline-flex items-center gap-1.5 rounded border border-border bg-panel px-2.5 py-1 text-xs text-fg-dim transition-colors hover:border-accent hover:text-fg"
          >
            <Plus size={13} strokeWidth={2.2} />
            {t(locale, 'settings.models.add')}
          </button>
          <button
            type="button"
            onClick={() => void handleExportJson()}
            className="inline-flex items-center gap-1.5 rounded border border-border bg-panel px-2.5 py-1 text-xs text-fg-dim transition-colors hover:border-accent hover:text-fg"
          >
            <DownloadCloud size={13} strokeWidth={2.2} />
            {t(locale, 'settings.channels.exportJson')}
          </button>
          <button
            type="button"
            onClick={() => jsonImportInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 rounded border border-border bg-panel px-2.5 py-1 text-xs text-fg-dim transition-colors hover:border-accent hover:text-fg"
          >
            <UploadCloud size={13} strokeWidth={2.2} />
            {t(locale, 'settings.channels.importJson')}
          </button>
          <input
            ref={jsonImportInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(event) => void handleImportJson(event)}
          />
          {desktop && (
            <button
              type="button"
              onClick={handleImport}
              disabled={importing}
              className="inline-flex items-center gap-1.5 rounded border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-300 transition-colors hover:bg-emerald-500/20 disabled:opacity-60"
            >
              <DownloadCloud size={13} strokeWidth={2.2} />
              {importing
                ? t(locale, 'settings.models.importing')
                : t(locale, 'settings.models.importCcSwitch')}
            </button>
          )}
        </div>
      </div>

      {status && (
        <p
          className={cn(
            'text-[11px] leading-relaxed',
            status.tone === 'ok' ? 'text-emerald-300' : 'text-rose-300',
          )}
        >
          {status.msg}
        </p>
      )}

      {showNoRuntime && (
        <EmptyProviderState
          title={t(locale, 'settings.models.noRuntimeTitle')}
          body={t(locale, 'settings.models.noRuntimeBody')}
          action={t(locale, 'settings.models.add')}
          onAction={() => handleAdd()}
        />
      )}

      {showEmptyProviders && (
        <EmptyProviderState
          title={t(locale, 'settings.models.emptyTitle')}
          body={t(locale, 'settings.models.emptyBody')}
          action={t(locale, 'settings.models.add')}
          onAction={() => handleAdd()}
        />
      )}

      {PROVIDER_ADAPTER_SECTIONS.map(({ adapter, dotClassName }) => {
        const sectionCards = providerCards.filter(
          (card) => card.adapter === adapter,
        );
        return (
          <div key={adapter} className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <ProviderGroupHeader
                title={runtimeAdapterLabel(adapter)}
                count={sectionCards.length}
                dotClassName={dotClassName}
                locale={locale}
              />
              <button
                type="button"
                onClick={() => handleAdd(adapterToProviderKind(adapter))}
                className="inline-flex items-center gap-1 rounded border border-border bg-panel px-2 py-0.5 text-[11px] text-fg-dim transition-colors hover:border-accent hover:text-fg"
              >
                <Plus size={12} strokeWidth={2.2} />
                {t(locale, 'settings.models.add')}
              </button>
            </div>
            <div className={SETTINGS_PROVIDER_GRID_CLASS}>
              {sectionCards.map(({ provider, runtime }) => (
                <DefaultChannelRow
                  key={provider.id}
                  provider={provider}
                  providers={providers}
                  adapter={adapter}
                  dotClassName={dotClassName}
                  runtime={runtime}
                  onDelete={() => handleDelete(provider.id)}
                  onChange={refresh}
                  locale={locale}
                />
              ))}
            </div>
          </div>
        );
      })}

      {editor && (
        <ProviderEditor
          locale={locale}
          editor={editor}
          providers={providers}
          cliRuntime={cliRuntime}
          onChange={(draft) =>
            setEditor((prev) => (prev ? { ...prev, draft } : prev))
          }
          onClose={() =>
            setEditor((prev) => {
              if (!prev) return prev;
              if (
                providerDraftChanged(prev.draft, prev.initial) &&
                !window.confirm(t(locale, 'settings.models.discardConfirm'))
              ) {
                return prev;
              }
              return null;
            })
          }
          onDelete={
            editor.mode === 'edit' && editor.providerId
              ? () => handleEditorDelete(editor.providerId!)
              : undefined
          }
          onSaved={() => {
            setEditor(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function DefaultChannelRow({
  provider,
  providers,
  adapter,
  dotClassName,
  runtime,
  onDelete,
  onChange,
  locale,
}: {
  provider: Provider;
  providers: Provider[];
  adapter: RuntimeAdapterId;
  dotClassName: string;
  runtime: ReturnType<typeof getProviderRuntimeInfo>;
  onDelete?: () => void;
  onChange: () => void;
  locale: Locale;
}) {
  const [baseUrlValue, setBaseUrlValue] = useState(provider.baseUrl);
  const [keyValue, setKeyValue] = useState(provider.apiKey);
  const [modelValue, setModelValue] = useState(provider.model ?? '');
  const [nameValue, setNameValue] = useState(provider.name);
  const [editingName, setEditingName] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [baseUrlError, setBaseUrlError] = useState<string | null>(null);
  const [duplicateError, setDuplicateError] = useState<string | null>(null);
  const [modelRefresh, setModelRefresh] = useState<{
    loading: boolean;
    error: string | null;
  }>({ loading: false, error: null });

  useEffect(() => {
    setBaseUrlValue(provider.baseUrl);
    setKeyValue(provider.apiKey);
    setModelValue(provider.model ?? '');
    setNameValue(provider.name);
    setEditingName(false);
    setNameError(null);
    setBaseUrlError(null);
    setDuplicateError(null);
  }, [
    provider.id,
    provider.name,
    provider.baseUrl,
    provider.apiKey,
    provider.model,
  ]);

  const draftProvider: Provider = {
    ...provider,
    name: nameValue,
    baseUrl: baseUrlValue,
    apiKey: keyValue,
    model: modelValue.trim() || undefined,
  };
  const draftRuntime = getProviderRuntimeInfo(draftProvider, {
    canUseCliFallback: runtime.canUseCliFallback,
  });
  const modelOptions = providerModelOptions(draftProvider);
  const modelCacheKey = providerModelCacheKey(draftProvider);
  const KeyIcon = showKey ? EyeOff : Eye;

  const commitProvider = (patch: Partial<ProviderDraft>): boolean => {
    const nextProvider: Provider = {
      ...draftProvider,
      ...patch,
    };
    const next = trimProviderDraft(nextProvider);
    if (!next.name) {
      setNameError(t(locale, 'settings.models.validationNameRequired'));
      return false;
    }
    if (!isProviderBaseUrlValid(next.baseUrl)) {
      setBaseUrlError(t(locale, 'settings.models.validationBaseUrl'));
      return false;
    }
    const duplicate = providers.some((candidate) => {
      if (candidate.id === provider.id) return false;
      return (
        providerMetadataSignature(candidate) === providerMetadataSignature(next)
      );
    });
    if (duplicate) {
      setDuplicateError(t(locale, 'settings.models.validationDuplicate'));
      return false;
    }

    setBaseUrlError(null);
    setNameError(null);
    setDuplicateError(null);
    setNameValue(next.name);
    setBaseUrlValue(next.baseUrl);
    setKeyValue(next.apiKey);
    setModelValue(next.model ?? '');

    if (!providerDraftChanged(next, providerDraft(provider))) return false;
    updateProvider(provider.id, {
      name: next.name,
      apiKey: next.apiKey,
      baseUrl: next.baseUrl,
      model: next.model,
      models: next.models,
      transport: next.transport,
    });
    onChange();
    return true;
  };

  const commitName = () => {
    const nextName = nameValue.trim();
    if (nextName === provider.name.trim()) {
      setNameValue(provider.name);
      setNameError(null);
      setEditingName(false);
      return;
    }
    if (commitProvider({ name: nameValue })) {
      setEditingName(false);
    }
  };

  const commitModelList = ({
    add,
    remove,
    select,
  }: {
    add?: string;
    remove?: string;
    select?: string;
  }) => {
    let models = draftProvider.models ?? [];
    if (add !== undefined) {
      models = uniqueStringOptions([add, modelValue, ...models]);
    }
    if (remove !== undefined) {
      models = removeGenerationModelOption(models, remove);
    }
    if (select !== undefined && select.trim()) {
      models = uniqueStringOptions([select, ...models]);
    }
    commitProvider({
      model: select !== undefined ? select.trim() || undefined : draftProvider.model,
      models: models.length > 0 ? models : undefined,
    });
  };

  const refreshModels = async () => {
    setModelRefresh({ loading: true, error: null });
    try {
      const result = await refreshProviderModels(trimProviderDraft(draftProvider));
      setModelRefresh({
        loading: false,
        error: result.error ?? null,
      });
    } catch (err) {
      setModelRefresh({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <div className="relative space-y-3 rounded-lg border border-border bg-bg-alt p-4 transition-colors">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <GroupDot className={dotClassName} />
          {editingName ? (
            <input
              type="text"
              value={nameValue}
              onChange={(event) => {
                setNameValue(event.target.value);
                setNameError(null);
                setDuplicateError(null);
              }}
              onBlur={commitName}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
                if (event.key === 'Escape') {
                  setNameValue(provider.name);
                  setNameError(null);
                  setEditingName(false);
                }
              }}
              aria-label={t(locale, 'settings.models.providerName')}
              autoComplete="off"
              spellCheck={false}
              autoFocus
              className={cn(
                'h-7 min-w-0 max-w-[14rem] rounded-md border border-border bg-panel px-2 text-sm font-medium text-fg outline-none transition-colors focus:border-accent',
                nameError && 'border-rose-500/60',
              )}
            />
          ) : (
            <button
              type="button"
              onClick={() => {
                setNameValue(provider.name);
                setNameError(null);
                setEditingName(true);
              }}
              title={t(locale, 'settings.models.editTitle')}
              aria-label={`${t(locale, 'settings.models.editTitle')}: ${
                provider.name || runtimeAdapterLabel(adapter)
              }`}
              className="group inline-flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-left text-sm font-medium text-fg transition-colors hover:bg-panel hover:text-accent"
            >
              <span className="truncate">
                {provider.name || runtimeAdapterLabel(adapter)}
              </span>
              <Pencil
                size={12}
                strokeWidth={2.2}
                className="shrink-0 text-fg-faint opacity-0 transition-opacity group-hover:opacity-100"
              />
            </button>
          )}
        </div>
        {nameError && (
          <p className="basis-full text-[11px] leading-relaxed text-rose-300">
            {nameError}
          </p>
        )}
        <StatusBadge
          state={draftRuntime.status}
          label={providerStatusLabel(draftRuntime.status, locale)}
        />
        <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-fg-faint">
          {providerRouteLabel(draftProvider, draftRuntime, locale)}
        </span>
        <span className="min-w-0 flex-1" />
        <div className="flex items-center gap-1.5">
          {onDelete && (
            <button
              type="button"
              title={t(locale, 'settings.models.delete')}
              aria-label={t(locale, 'settings.models.delete')}
              onClick={onDelete}
              className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-panel text-fg-faint transition-colors hover:border-rose-500/50 hover:text-rose-400"
            >
              <Trash2 size={13} strokeWidth={2} />
            </button>
          )}
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <label className="block space-y-1">
          <span className="text-[11px] font-medium text-fg-dim">
            {t(locale, 'settings.models.baseUrl')}
          </span>
          <input
            type="text"
            value={baseUrlValue}
            onChange={(event) => {
              setBaseUrlValue(event.target.value);
              setBaseUrlError(null);
              setDuplicateError(null);
            }}
            onBlur={() => commitProvider({ baseUrl: baseUrlValue })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
            placeholder={providerBaseUrlPlaceholder(provider.kind)}
            autoComplete="off"
            spellCheck={false}
            className={cn(
              'w-full rounded-md border border-border bg-panel px-2.5 py-1.5 font-mono text-sm text-fg outline-none transition-colors focus:border-accent',
              baseUrlError && 'border-rose-500/60',
            )}
          />
          {baseUrlError && (
            <p className="text-[11px] leading-relaxed text-rose-300">
              {baseUrlError}
            </p>
          )}
        </label>

        <label className="block space-y-1">
          <span className="text-[11px] font-medium text-fg-dim">
            {t(locale, 'settings.models.apiKey')}
          </span>
          <div className="relative">
            <input
              type={showKey ? 'text' : 'password'}
              value={keyValue}
              onChange={(event) => setKeyValue(event.target.value)}
              onBlur={() => commitProvider({ apiKey: keyValue })}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
              placeholder="sk-..."
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-md border border-border bg-panel px-2.5 py-1.5 pr-14 font-mono text-sm text-fg outline-none transition-colors focus:border-accent"
            />
            <div className="absolute inset-y-0 right-1 flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                title={t(
                  locale,
                  showKey ? 'settings.models.hideKey' : 'settings.models.showKey',
                )}
                className="flex h-6 w-6 items-center justify-center rounded text-fg-faint transition-colors hover:text-fg"
              >
                <KeyIcon size={13} strokeWidth={2} />
              </button>
              {keyValue && (
                <button
                  type="button"
                  onClick={() => {
                    setKeyValue('');
                    commitProvider({ apiKey: '' });
                  }}
                  title={t(locale, 'settings.models.clear')}
                  className="flex h-6 w-6 items-center justify-center rounded text-fg-faint transition-colors hover:text-rose-300"
                >
                  <Trash2 size={13} strokeWidth={2} />
                </button>
              )}
            </div>
          </div>
        </label>

        <EditableModelSelect
          cacheKey={modelCacheKey}
          builtins={modelOptions}
          value={modelValue.trim()}
          label={t(locale, 'settings.freeChannels.modelLabel')}
          locale={locale}
          loading={modelRefresh.loading}
          error={modelRefresh.error}
          canRefresh={true}
          onChange={(next) => {
            setModelValue(next);
            commitModelList({ select: next });
          }}
          onAddModel={(next) => commitModelList({ add: next, select: next })}
          onRemoveModel={(removed, nextValue) =>
            commitModelList({ remove: removed, select: nextValue })
          }
          onRefresh={() => void refreshModels()}
        />
        {duplicateError && (
          <p className="text-[11px] leading-relaxed text-rose-300 lg:col-span-2">
            {duplicateError}
          </p>
        )}
      </div>
    </div>
  );
}

function providerBaseUrlPlaceholder(kind: Provider['kind']): string {
  if (kind === 'anthropic') return 'https://api.anthropic.com';
  if (kind === 'gemini') {
    return 'https://generativelanguage.googleapis.com/v1beta/openai';
  }
  return 'https://api.example.com/v1';
}

function ProviderGroupHeader({
  title,
  count,
  dotClassName,
  locale,
}: {
  title: string;
  count: number;
  dotClassName: string;
  locale: Locale;
}) {
  return (
    <div className="flex items-center gap-2">
      <GroupDot className={dotClassName} />
      <span className="text-sm font-medium text-fg">{title}</span>
      <span className="font-mono text-[11px] text-fg-faint">
        {t(locale, 'settings.models.headingCount').replace('{n}', String(count))}
      </span>
    </div>
  );
}

function EmptyProviderState({
  title,
  body,
  action,
  onAction,
}: {
  title: string;
  body: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <div className="rounded-lg border border-dashed border-border-soft bg-bg-alt/60 p-4">
      <div className="text-sm font-medium text-fg">{title}</div>
      <p className="mt-1 text-xs leading-relaxed text-fg-faint">{body}</p>
      <button
        type="button"
        onClick={onAction}
        className="mt-3 inline-flex items-center gap-1.5 rounded border border-border bg-panel px-2.5 py-1 text-xs text-fg-dim transition-colors hover:border-accent hover:text-fg"
      >
        <Plus size={13} strokeWidth={2.2} />
        {action}
      </button>
    </div>
  );
}

function GroupDot({ className }: { className: string }) {
  return <span className={cn('h-2 w-2 shrink-0 rounded-full', className)} />;
}

function StatusBadge({ state, label }: { state: BadgeState; label: string }) {
  const styles =
    state === 'direct'
      ? {
          pill: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
          dot: 'bg-emerald-400',
        }
      : state === 'unavailable'
        ? {
            pill: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
            dot: 'bg-rose-400',
          }
        : {
            pill: 'border-border bg-panel text-fg-faint',
            dot: 'bg-fg-faint',
          };

  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[11px]',
        styles.pill,
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', styles.dot)} />
      {label}
    </span>
  );
}

function ProviderEditor({
  locale,
  editor,
  providers,
  cliRuntime,
  onChange,
  onClose,
  onDelete,
  onSaved,
}: {
  locale: Locale;
  editor: {
    mode: ProviderEditorMode;
    providerId?: string;
    draft: ProviderDraft;
    initial: ProviderDraft;
  };
  providers: Provider[];
  cliRuntime: CliRuntimeSnapshot;
  onChange: (draft: ProviderDraft) => void;
  onClose: () => void;
  onDelete?: () => void;
  onSaved: () => void;
}) {
  const [shortcutSettings, setShortcutSettingsState] = useState(
    loadShortcutSettings,
  );
  const [keyVisible, setKeyVisible] = useState(false);
  const [modelRefresh, setModelRefresh] = useState<{
    loading: boolean;
    error: string | null;
  }>({ loading: false, error: null });
  const [errors, setErrors] = useState<{
    name?: string;
    baseUrl?: string;
    duplicate?: string;
  }>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  // CLI fallback availability depends on the selected adapter, which the user
  // can change mid-edit — recompute from the draft kind each render.
  const draftAdapter = providerKindToAdapter(editor.draft.kind);
  const canUseCliFallback =
    isTauri() && isCliAdapterAvailable(draftAdapter, cliRuntime);
  const runtime = getProviderRuntimeInfo(editor.draft, { canUseCliFallback });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!matchesShortcut(event, shortcutSettings['modal-close'])) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, shortcutSettings]);

  useEffect(
    () => subscribeShortcutSettings(setShortcutSettingsState),
    [],
  );

  const patchDraft = (patch: Partial<ProviderDraft>) => {
    setSaveError(null);
    setErrors((prev) => ({ ...prev, ...clearErrorsForPatch(patch) }));
    onChange({ ...editor.draft, ...patch });
  };

  const refreshModels = async () => {
    setModelRefresh({ loading: true, error: null });
    try {
      const result = await refreshProviderModels(editor.draft);
      setModelRefresh({
        loading: false,
        error: result.error ?? null,
      });
    } catch (err) {
      setModelRefresh({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
  const modelCacheKey = providerModelCacheKey(editor.draft);
  const modelOptions = providerModelOptions(editor.draft);
  const patchModelList = ({
    add,
    remove,
    select,
  }: {
    add?: string;
    remove?: string;
    select?: string;
  }) => {
    let models = editor.draft.models ?? [];
    if (add !== undefined) {
      models = uniqueStringOptions([add, editor.draft.model ?? '', ...models]);
    }
    if (remove !== undefined) {
      models = removeGenerationModelOption(models, remove);
    }
    if (select !== undefined && select.trim()) {
      models = uniqueStringOptions([select, ...models]);
    }
    patchDraft({
      model: select !== undefined ? select.trim() || undefined : editor.draft.model,
      models: models.length > 0 ? models : undefined,
    });
  };

  const handleSave = () => {
    const next = trimProviderDraft(editor.draft);
    const nextErrors: typeof errors = {};
    if (!next.name) {
      nextErrors.name = t(locale, 'settings.models.validationNameRequired');
    }
    if (!isProviderBaseUrlValid(next.baseUrl)) {
      nextErrors.baseUrl = t(locale, 'settings.models.validationBaseUrl');
    }
    const duplicate = providers.some((provider) => {
      if (editor.mode === 'edit' && provider.id === editor.providerId) {
        return false;
      }
      return (
        providerMetadataSignature(provider) === providerMetadataSignature(next)
      );
    });
    if (duplicate) {
      nextErrors.duplicate = t(locale, 'settings.models.validationDuplicate');
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    try {
      if (editor.mode === 'edit' && editor.providerId) {
        updateProvider(editor.providerId, next);
      } else {
        addProvider(next);
      }
      onSaved();
    } catch {
      setSaveError(t(locale, 'settings.models.saveError'));
    }
  };

  const title =
    editor.mode === 'add'
      ? t(locale, 'settings.models.addTitle')
      : t(locale, 'settings.models.editTitle');
  const keyToggleLabel = keyVisible
    ? t(locale, 'settings.models.hideKey')
    : t(locale, 'settings.models.showKey');
  const KeyIcon = keyVisible ? EyeOff : Eye;

  return (
    <div
      className="fixed inset-0 z-[70] bg-black/60 sm:flex sm:items-center sm:justify-center sm:p-6"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="provider-editor-title"
        data-provider-editor="true"
        data-settings-child-modal="true"
        className="fixed inset-x-0 bottom-0 flex max-h-[calc(100vh-1rem)] flex-col overflow-hidden rounded-t-lg border border-border bg-panel shadow-2xl sm:relative sm:inset-auto sm:max-h-[calc(100vh-3rem)] sm:w-[min(720px,calc(100vw-2rem))] sm:rounded-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="shrink-0 border-b border-border-soft bg-bg-alt px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <h3
                id="provider-editor-title"
                className="text-base font-semibold text-fg"
              >
                {title}
              </h3>
              <p className="mt-1 text-xs leading-relaxed text-fg-faint">
                {t(locale, 'settings.modelsDescription')}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              title={t(locale, 'common.close')}
              aria-label={t(locale, 'common.close')}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-panel-2 text-fg-faint transition-colors hover:border-accent hover:text-fg"
            >
              <X size={15} strokeWidth={2.2} />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label={t(locale, 'settings.models.providerName')}
              value={editor.draft.name}
              onChange={(value) => patchDraft({ name: value })}
              placeholder={t(locale, 'settings.models.newProviderName')}
              error={errors.name}
            />
            <div className="block space-y-1">
              <span className="text-[11px] font-medium text-fg-dim">
                {t(locale, 'settings.models.sourceType')}
              </span>
              <div className="flex gap-1">
                {RUNTIME_ADAPTERS.map((adapter) => {
                  const active = draftAdapter === adapter.id;
                  return (
                    <button
                      key={adapter.id}
                      type="button"
                      onClick={() =>
                        patchDraft({ kind: adapterToProviderKind(adapter.id) })
                      }
                      className={cn(
                        'flex-1 rounded border px-2 py-1.5 text-[11px] transition-colors',
                        active
                          ? 'border-accent bg-accent/10 text-accent'
                          : 'border-border bg-bg text-fg-dim hover:border-accent/50 hover:text-fg',
                      )}
                    >
                      {adapter.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <ReadonlyField
              label={t(locale, 'settings.models.authState')}
              value={
                runtime.hasApiKey
                  ? t(locale, 'settings.models.authConfigured')
                  : t(locale, 'settings.models.authMissing')
              }
            />
            <ReadonlyField
              label={t(locale, 'settings.models.availability')}
              value={
                <StatusBadge
                  state={runtime.status}
                  label={providerStatusLabel(runtime.status, locale)}
                />
              }
            />
            <TextField
              label={t(locale, 'settings.models.baseUrl')}
              value={editor.draft.baseUrl}
              onChange={(value) => patchDraft({ baseUrl: value })}
              placeholder="https://api.anthropic.com"
              error={errors.baseUrl}
              mono
              fullWidth
            />
            <EditableModelSelect
              className="block space-y-1 sm:col-span-2"
              cacheKey={modelCacheKey}
              builtins={modelOptions}
              label={t(locale, 'settings.models.defaultModel')}
              value={editor.draft.model ?? ''}
              locale={locale}
              loading={modelRefresh.loading}
              error={modelRefresh.error}
              canRefresh={true}
              onChange={(next) => patchModelList({ select: next })}
              onAddModel={(next) => patchModelList({ add: next, select: next })}
              onRemoveModel={(removed, nextValue) =>
                patchModelList({ remove: removed, select: nextValue })
              }
              onRefresh={() => void refreshModels()}
            />
            <p className="-mt-3 text-[11px] leading-relaxed text-fg-faint sm:col-span-2">
              {t(locale, 'settings.models.modelMetadataHelp')}
            </p>
            <div className="block space-y-1 sm:col-span-2">
              <div className="flex items-center justify-between gap-3">
                <label
                  htmlFor="provider-api-key"
                  className="text-[11px] font-medium text-fg-dim"
                >
                  {t(locale, 'settings.models.apiKey')}
                </label>
                <button
                  type="button"
                  aria-label={keyToggleLabel}
                  title={keyToggleLabel}
                  onClick={() => setKeyVisible((visible) => !visible)}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-fg-faint transition-colors hover:bg-panel-2 hover:text-fg"
                >
                  <KeyIcon size={15} strokeWidth={2.1} />
                </button>
              </div>
              <input
                id="provider-api-key"
                type={keyVisible ? 'text' : 'password'}
                value={editor.draft.apiKey}
                onChange={(event) => patchDraft({ apiKey: event.target.value })}
                placeholder="sk-ant-..."
                autoComplete="off"
                spellCheck={false}
                aria-describedby="provider-api-key-help"
                className="w-full rounded border border-border bg-bg py-1.5 pl-2 pr-10 font-mono text-xs text-fg outline-none transition-colors focus:border-accent"
              />
            </div>
          </div>

          {errors.duplicate && (
            <p className="mt-3 text-[11px] leading-relaxed text-rose-300">
              {errors.duplicate}
            </p>
          )}

          <p
            id="provider-api-key-help"
            className="mt-4 rounded border border-border-soft bg-bg-alt px-3 py-2 text-[11px] leading-relaxed text-fg-faint"
          >
            {t(locale, 'settings.models.localHint')}
          </p>
        </div>

        <div className="shrink-0 border-t border-border-soft bg-bg-alt px-5 py-3">
          {saveError && (
            <p className="mb-2 text-[11px] leading-relaxed text-rose-300">
              {saveError}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {onDelete && (
              <button
                type="button"
                onClick={onDelete}
                className="inline-flex items-center gap-1.5 rounded border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-xs text-rose-300 transition-colors hover:bg-rose-500/20"
              >
                <Trash2 size={13} strokeWidth={2.2} />
                {t(locale, 'settings.models.delete')}
              </button>
            )}
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded border border-border bg-panel px-3 py-1.5 text-xs text-fg-dim transition-colors hover:border-accent hover:text-fg"
              >
                {t(locale, 'common.cancel')}
              </button>
              <button
                type="button"
                onClick={handleSave}
                className="rounded border border-accent bg-accent px-3 py-1.5 text-xs font-medium text-bg transition-colors hover:bg-accent/90"
              >
                {t(locale, 'settings.models.save')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function providerDraft(provider: ProviderDraft): ProviderDraft {
  return {
    kind: provider.kind,
    name: provider.name,
    apiKey: provider.apiKey,
    baseUrl: provider.baseUrl,
    transport: provider.transport,
    model: provider.model ?? '',
    models: uniqueStringOptions(provider.models ?? []),
  };
}

function trimProviderDraft(draft: ProviderDraft): ProviderDraft {
  const model = draft.model?.trim();
  const models = uniqueStringOptions(draft.models ?? []);
  const transport =
    draft.kind === 'anthropic' ? draft.transport ?? 'direct' : 'cli';
  return {
    kind: draft.kind,
    name: draft.name.trim(),
    apiKey: draft.apiKey.trim(),
    baseUrl: draft.baseUrl.trim(),
    transport,
    ...(model ? { model } : {}),
    ...(models.length > 0 ? { models } : {}),
  };
}

function providerDraftChanged(a: ProviderDraft, b: ProviderDraft): boolean {
  const left = trimProviderDraft(a);
  const right = trimProviderDraft(b);
  const leftModels = left.models ?? [];
  const rightModels = right.models ?? [];
  return (
    left.kind !== right.kind ||
    left.name !== right.name ||
    left.apiKey !== right.apiKey ||
    left.baseUrl !== right.baseUrl ||
    (left.transport ?? '') !== (right.transport ?? '') ||
    (left.model ?? '') !== (right.model ?? '') ||
    leftModels.length !== rightModels.length ||
    leftModels.some((model, index) => model !== rightModels[index])
  );
}

function providerSortRank(status: ProviderRuntimeStatus): number {
  if (status === 'direct') return 1;
  if (status === 'cli') return 2;
  return 3;
}

function providerStatusLabel(
  status: ProviderRuntimeStatus,
  locale: Locale,
): string {
  if (status === 'direct') return t(locale, 'settings.models.statusDirect');
  if (status === 'cli') return t(locale, 'settings.models.statusCli');
  return t(locale, 'settings.models.statusUnavailable');
}

function providerRouteLabel(
  provider: Provider,
  runtime: ReturnType<typeof getProviderRuntimeInfo>,
  locale: Locale,
): string {
  if (
    runtime.status === 'cli' ||
    provider.transport === 'cli' ||
    provider.kind !== 'anthropic'
  ) {
    return t(locale, 'settings.models.sourceSystemCli');
  }
  return t(locale, 'settings.models.sourceDirect');
}

function clearErrorsForPatch(
  patch: Partial<ProviderDraft>,
): { name?: undefined; baseUrl?: undefined; duplicate?: undefined } {
  return {
    ...(patch.name !== undefined ? { name: undefined, duplicate: undefined } : {}),
    ...(patch.baseUrl !== undefined
      ? { baseUrl: undefined, duplicate: undefined }
      : {}),
    ...(patch.kind !== undefined ? { duplicate: undefined } : {}),
    ...(patch.model !== undefined ? { duplicate: undefined } : {}),
  };
}

function uniqueStringOptions(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = raw.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function persistCustomGenerationModelOption(
  models: string[],
  candidate: string,
  builtins: string[],
): string[] {
  const value = candidate.trim();
  if (!value) return models;
  const builtIn = builtins.some(
    (item) => item.trim().toLowerCase() === value.toLowerCase(),
  );
  return builtIn ? models : uniqueStringOptions([value, ...models]);
}

function removeGenerationModelOption(models: string[], model: string): string[] {
  const removed = model.trim().toLowerCase();
  if (!removed) return models;
  return models.filter((item) => item.trim().toLowerCase() !== removed);
}

type CustomGenerationProviderDraft = {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  models: string[];
};

function customGenerationProviderName(baseUrl: string, fallback: string): string {
  try {
    const url = new URL(baseUrl.trim());
    return url.hostname.replace(/^api\./iu, '') || fallback;
  } catch {
    return fallback;
  }
}

function uniqueCustomId<T extends `custom:${string}`>(
  baseId: T,
  existingIds: Iterable<string>,
): T {
  const used = new Set(existingIds);
  if (!used.has(baseId)) return baseId;
  let suffix = 2;
  while (used.has(`${baseId}-${suffix}`)) suffix += 1;
  return `${baseId}-${suffix}` as T;
}

function CustomGenerationProviderDialog({
  locale,
  title,
  modelScope,
  defaultName,
  defaultModel,
  endpointPlaceholder,
  onClose,
  onSave,
}: {
  locale: Locale;
  title: string;
  modelScope: 'image' | 'mesh' | 'music' | 'video' | 'speech';
  defaultName: string;
  defaultModel: string;
  endpointPlaceholder: string;
  onClose: () => void;
  // Return false to signal the save failed (e.g. localStorage quota); the dialog
  // then shows an inline error and stays open instead of silently closing.
  onSave: (draft: CustomGenerationProviderDraft) => boolean | void;
}) {
  const [showKey, setShowKey] = useState(false);
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(defaultModel);
  const [models, setModels] = useState<string[]>([defaultModel]);
  const [error, setError] = useState<string | null>(null);
  const [modelRefresh, setModelRefresh] = useState<{
    loading: boolean;
    error: string | null;
  }>({ loading: false, error: null });
  const KeyIcon = showKey ? EyeOff : Eye;
  const modelOptions = uniqueStringOptions([model, ...models]);

  const refreshModels = async () => {
    const trimmedBaseUrl = baseUrl.trim();
    if (!trimmedBaseUrl || modelRefresh.loading) return;
    setModelRefresh({ loading: true, error: null });
    try {
      const result = await refreshEndpointModels({
        cacheKey: endpointModelCacheKey(modelScope, `custom:${trimmedBaseUrl}`, trimmedBaseUrl),
        baseUrl: trimmedBaseUrl,
        apiKey,
        fallback: modelOptions,
      });
      setModels(result.models);
      if (!model.trim() && result.models[0]) setModel(result.models[0]);
      setModelRefresh({ loading: false, error: result.error ?? null });
    } catch (err) {
      setModelRefresh({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const save = () => {
    const trimmedBaseUrl = baseUrl.trim().replace(/\/+$/, '');
    const trimmedModel = model.trim() || models[0]?.trim() || defaultModel;
    if (!trimmedBaseUrl) {
      setError(locale === 'zh-CN' ? '请填写 URL。' : 'Enter a URL.');
      return;
    }
    setError(null);
    const result = onSave({
      name: name.trim() || customGenerationProviderName(trimmedBaseUrl, defaultName),
      baseUrl: trimmedBaseUrl,
      apiKey: apiKey.trim(),
      model: trimmedModel,
      models: uniqueStringOptions([trimmedModel, ...models]),
    });
    // onSave returns false when persistence failed (e.g. localStorage quota).
    // Keep the dialog open and show why, instead of closing as if it saved.
    if (result === false) {
      setError(
        locale === 'zh-CN'
          ? '保存失败：本地存储写入出错，可能空间已满。请在设置中清理历史会话后重试。'
          : 'Save failed: local storage write error (it may be full). Clear old sessions and try again.',
      );
    }
  };

  return (
    <div className="fixed inset-0 z-[75] bg-black/60 sm:flex sm:items-center sm:justify-center sm:p-6">
      <div
        role="dialog"
        aria-modal="true"
        data-custom-generation-provider-editor="true"
        className="fixed inset-x-0 bottom-0 flex max-h-[calc(100vh-1rem)] flex-col overflow-hidden rounded-t-lg border border-border bg-panel shadow-2xl sm:relative sm:inset-auto sm:max-h-[calc(100vh-3rem)] sm:w-[min(560px,calc(100vw-2rem))] sm:rounded-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="shrink-0 border-b border-border-soft bg-bg-alt px-5 py-4">
          <div className="flex items-center gap-3">
            <h3 className="min-w-0 flex-1 text-base font-semibold text-fg">{title}</h3>
            <button
              type="button"
              onClick={onClose}
              title={t(locale, 'common.close')}
              aria-label={t(locale, 'common.close')}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-panel-2 text-fg-faint transition-colors hover:border-accent hover:text-fg"
            >
              <X size={15} strokeWidth={2.2} />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <TextField
            label={locale === 'zh-CN' ? '渠道名称' : 'Channel name'}
            value={name}
            onChange={setName}
            placeholder={defaultName}
          />
          <TextField
            label={locale === 'zh-CN' ? 'URL（必填）' : 'URL (required)'}
            value={baseUrl}
            onChange={(value) => {
              setBaseUrl(value);
              setError(null);
            }}
            placeholder={endpointPlaceholder}
            error={error ?? undefined}
            mono
          />
          <label className="block space-y-1">
            <span className="text-[11px] font-medium text-fg-dim">Token</span>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                onKeyDown={stopSettingsInputKeyPropagation}
                onPaste={(event) => {
                  const nextValue = inputValueAfterPaste(event);
                  if (nextValue != null) setApiKey(nextValue);
                }}
                placeholder="sk-..."
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded border border-border bg-bg px-2 py-1.5 pr-10 font-mono text-xs text-fg outline-none transition-colors focus:border-accent"
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                title={t(locale, showKey ? 'settings.models.hideKey' : 'settings.models.showKey')}
                className="absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-fg-faint transition-colors hover:text-fg"
              >
                <KeyIcon size={13} strokeWidth={2} />
              </button>
            </div>
          </label>

          <label className="block space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium text-fg-dim">
                {locale === 'zh-CN' ? '渠道列表 / 模型' : 'Channel list / model'}
              </span>
              <button
                type="button"
                onClick={() => void refreshModels()}
                disabled={!baseUrl.trim() || modelRefresh.loading}
                className="inline-flex items-center gap-1 rounded border border-border bg-bg px-2 py-1 text-[11px] text-fg-dim transition-colors hover:border-accent hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RefreshCw
                  size={12}
                  strokeWidth={2}
                  className={modelRefresh.loading ? 'animate-spin' : undefined}
                />
                {locale === 'zh-CN' ? '获取渠道' : 'Fetch channels'}
              </button>
            </div>
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(10rem,14rem)]">
              <input
                type="text"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder={defaultModel}
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded border border-border bg-bg px-2 py-1.5 font-mono text-xs text-fg outline-none transition-colors focus:border-accent"
              />
              <select
                value={modelOptions.includes(model.trim()) ? model.trim() : ''}
                onChange={(event) => {
                  if (event.target.value) setModel(event.target.value);
                }}
                className="h-[31px] w-full rounded border border-border bg-bg px-2 font-mono text-xs text-fg outline-none transition-colors focus:border-accent"
              >
                <option value="">{locale === 'zh-CN' ? '选择渠道' : 'Select channel'}</option>
                {modelOptions.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </div>
            {modelRefresh.error && (
              <p className="text-[11px] leading-relaxed text-amber-300">
                {modelRefresh.error}
              </p>
            )}
          </label>
        </div>

        <div className="shrink-0 border-t border-border-soft bg-bg-alt px-5 py-3">
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-border bg-panel px-3 py-1.5 text-xs text-fg-dim transition-colors hover:border-accent hover:text-fg"
            >
              {t(locale, 'common.cancel')}
            </button>
            <button
              type="button"
              onClick={save}
              disabled={!baseUrl.trim()}
              className="rounded border border-accent bg-accent px-3 py-1.5 text-xs font-medium text-bg transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:border-border disabled:bg-panel disabled:text-fg-faint"
            >
              {t(locale, 'settings.models.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const IMAGE_GEN_ACTIVE_CATEGORY_KEY = 'ugs:imgGenActiveCategory';

function ImageGenerationSettingsPanel({
  locale,
  settingsProfile,
  remoteProfile = false,
}: {
  locale: Locale;
  settingsProfile?: SettingsProfileOptions;
  remoteProfile?: boolean;
}) {
  const [settings, setSettings] = useState<ImageGenerationSettings>(() =>
    loadImageGenerationSettings(settingsProfile),
  );
  // Commercial and free-credit providers live in separate tabs so each
  // category stays self-contained instead of stacking in one long list.
  // The active tab is persisted: a custom channel added on the free-credit
  // tab would otherwise look "lost" when the panel remounts on 'commercial'
  // (the channel persists fine, but the grid only renders the active tab).
  const [category, setCategoryState] = useState<ImageProviderCategory>(() => {
    try {
      const saved = window.localStorage.getItem(IMAGE_GEN_ACTIVE_CATEGORY_KEY);
      return saved === 'free-credit' || saved === 'commercial' ? saved : 'commercial';
    } catch {
      return 'commercial';
    }
  });
  const setCategory = (next: ImageProviderCategory) => {
    try {
      window.localStorage.setItem(IMAGE_GEN_ACTIVE_CATEGORY_KEY, next);
    } catch {
      /* non-fatal */
    }
    setCategoryState(next);
  };
  const [customDialogOpen, setCustomDialogOpen] = useState(false);

  const update = (patch: Partial<ImageGenerationSettings>) => {
    const next = { ...settings, ...patch };
    saveImageGenerationSettings(next, settingsProfile);
    setSettings(next);
  };

  const providers = imageProviders(settings).filter(
    (provider) => !remoteProfile || !provider.local,
  );
  const providerOptions = providers.map((provider) => ({
    id: provider.id,
    label: provider.label,
    hint: `${imageProviderCategoryLabel(provider.category, locale)} · ${imageProviderStatusLabel(
      provider,
      settings,
      locale,
    )}`,
  }));
  const activeProviders = providers.filter(
    (provider) => provider.category === category,
  );

  const addCustomProvider = (draft: CustomGenerationProviderDraft) => {
    const id = uniqueCustomId(
      createCustomImageProviderId(draft.name),
      settings.customProviders.map((provider) => provider.id),
    );
    const provider: CustomImageProviderDefinition = {
      id,
      label: draft.name,
      category,
      apiKind: 'openai-images',
      defaultModel: draft.model,
      models: draft.models,
      needsKey: true,
      local: false,
      defaultBaseUrl: draft.baseUrl,
      supportsBaseUrl: true,
      endpointPlaceholder: draft.baseUrl,
      keyPlaceholder: 'sk-...',
      note: '自定义 OpenAI-compatible 生图渠道。',
    };
    const next: ImageGenerationSettings = {
      ...settings,
      preferredProviderId: id,
      customProviders: [...settings.customProviders, provider],
      providerKeys: { ...settings.providerKeys },
      providerAccountIds: { ...settings.providerAccountIds },
      providerBaseUrls: { ...settings.providerBaseUrls, [id]: draft.baseUrl },
      providerModels: { ...settings.providerModels, [id]: draft.model },
      providerModelLists: { ...settings.providerModelLists, [id]: draft.models },
    };
    if (draft.apiKey) next.providerKeys[id] = draft.apiKey;
    const ok = saveImageGenerationSettings(next, settingsProfile);
    if (!ok) return false;
    setSettings(loadImageGenerationSettings(settingsProfile));
    // Keep the user on (and persist) the tab the channel was added to, so it
    // stays visible after the panel remounts.
    setCategory(category);
    setCustomDialogOpen(false);
    return true;
  };

  const deleteCustomProvider = (id: ImageProviderId) => {
    const providerKeys = { ...settings.providerKeys };
    const providerAccountIds = { ...settings.providerAccountIds };
    const providerBaseUrls = { ...settings.providerBaseUrls };
    const providerModels = { ...settings.providerModels };
    const providerModelLists = { ...settings.providerModelLists };
    delete providerKeys[id];
    delete providerAccountIds[id];
    delete providerBaseUrls[id];
    delete providerModels[id];
    delete providerModelLists[id];
    const next: ImageGenerationSettings = {
      ...settings,
      preferredProviderId:
        settings.preferredProviderId === id
          ? 'siliconflow'
          : settings.preferredProviderId,
      customProviders: settings.customProviders.filter((provider) => provider.id !== id),
      providerKeys,
      providerAccountIds,
      providerBaseUrls,
      providerModels,
      providerModelLists,
    };
    saveImageGenerationSettings(next, settingsProfile);
    setSettings(loadImageGenerationSettings(settingsProfile));
  };

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-lg font-semibold text-fg">
          {t(locale, 'settings.imageGeneration.title')}
        </h3>
        <p className="mt-1 text-xs leading-relaxed text-fg-faint">
          {t(locale, 'settings.imageGeneration.description')}
        </p>
      </div>

      <SettingRow
        title={t(locale, 'settings.imageGeneration.defaultProviderLabel')}
        description={t(locale, 'settings.imageGeneration.defaultProviderDesc')}
      >
        <div className="w-full min-w-[14rem]">
          <SelectControl
            value={settings.preferredProviderId}
            options={providerOptions}
            onChange={(id) =>
              update({ preferredProviderId: id as ImageProviderId })
            }
            icon={<Sparkles size={15} strokeWidth={2.1} />}
          />
        </div>
      </SettingRow>

      <div>
        <div
          role="tablist"
          aria-orientation="horizontal"
          className={SETTINGS_INNER_TABLIST_CLASS}
        >
          {imageProviderCategoryOrder.map((item) => {
            const active = category === item;
            return (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setCategory(item)}
                className={cn(
                  SETTINGS_INNER_TAB_CLASS,
                  active
                    ? '-mb-px border-b-2 border-accent text-fg'
                    : 'text-fg-faint hover:text-fg',
                )}
              >
                {t(locale, imageProviderCategoryTitleKey(item))}
              </button>
            );
          })}
        </div>
      </div>

      <section role="tabpanel" className="rounded-lg border border-border bg-bg-alt p-4">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h4 className="text-sm font-semibold text-fg">
              {t(locale, imageProviderCategoryTitleKey(category))}
            </h4>
            <p className="text-xs leading-relaxed text-fg-faint">
              {t(locale, imageProviderCategoryDescKey(category))}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <StatusBadge state="default" label={String(activeProviders.length)} />
            <button
              type="button"
              onClick={() => setCustomDialogOpen(true)}
              className="inline-flex items-center gap-1.5 rounded border border-border bg-panel px-2.5 py-1 text-xs text-fg-dim transition-colors hover:border-accent hover:text-fg"
            >
              <Plus size={13} strokeWidth={2.2} />
              {t(locale, 'settings.models.add')}
            </button>
          </div>
        </div>
        <div className={SETTINGS_PROVIDER_GRID_CLASS}>
          {activeProviders.map((provider) => (
            <ImageProviderSettingsRow
              key={provider.id}
              provider={provider}
              settings={settings}
              locale={locale}
              onChange={(next) => {
                saveImageGenerationSettings(next, settingsProfile);
                setSettings(next);
              }}
              onDelete={
                provider.custom ? () => deleteCustomProvider(provider.id) : undefined
              }
            />
          ))}
        </div>
      </section>
      {customDialogOpen && (
        <CustomGenerationProviderDialog
          locale={locale}
          title={t(locale, 'settings.models.addTitle')}
          modelScope="image"
          defaultName={t(locale, 'settings.models.newProviderName')}
          defaultModel="custom-image-model"
          endpointPlaceholder="https://api.example.com/v1"
          onClose={() => setCustomDialogOpen(false)}
          onSave={addCustomProvider}
        />
      )}
    </div>
  );
}

const imageProviderCategoryOrder: ImageProviderCategory[] = [
  'commercial',
  'free-credit',
];

function imageProviderCategoryTitleKey(
  category: ImageProviderCategory,
): TranslationKey {
  return category === 'free-credit'
    ? 'settings.imageGeneration.freeCreditProviders'
    : 'settings.imageGeneration.commercialProviders';
}

function imageProviderCategoryDescKey(
  category: ImageProviderCategory,
): TranslationKey {
  return category === 'free-credit'
    ? 'settings.imageGeneration.freeCreditProvidersDesc'
    : 'settings.imageGeneration.commercialProvidersDesc';
}

function imageProviderCategoryLabel(
  category: ImageProviderCategory,
  locale: Locale,
): string {
  return t(
    locale,
    category === 'free-credit'
      ? 'settings.imageGeneration.categoryFreeCredit'
      : 'settings.imageGeneration.categoryCommercial',
  );
}

function imageProviderCategoryBadgeClass(category: ImageProviderCategory): string {
  return category === 'free-credit'
    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
    : 'border-sky-500/30 bg-sky-500/10 text-sky-300';
}

function imageProviderStatusLabel(
  provider: ImageProviderDefinition,
  settings: ImageGenerationSettings,
  locale: Locale,
): string {
  if (imageProviderReady(provider.id, settings)) {
    return t(locale, 'settings.freeChannels.ready');
  }
  if (provider.local) return t(locale, 'settings.freeChannels.localNeedsSetup');
  if (provider.needsKey) return t(locale, 'settings.freeChannels.needsKey');
  return t(locale, 'settings.imageGeneration.noKeyRequired');
}

function ImageProviderSettingsRow({
  provider,
  settings,
  locale,
  onChange,
  onDelete,
}: {
  provider: ImageProviderDefinition;
  settings: ImageGenerationSettings;
  locale: Locale;
  onChange: (settings: ImageGenerationSettings) => void;
  onDelete?: () => void;
}) {
  const [showKey, setShowKey] = useState(false);
  const [modelRefresh, setModelRefresh] = useState<{
    loading: boolean;
    error: string | null;
  }>({ loading: false, error: null });
  const [comfyInstall, setComfyInstall] = useState<{
    state: 'idle' | 'starting' | 'started' | 'error';
    message: string | null;
  }>({ state: 'idle', message: null });
  const keyValue = settings.providerKeys[provider.id] ?? '';
  const accountId = settings.providerAccountIds[provider.id] ?? '';
  const baseUrl = settings.providerBaseUrls[provider.id] ?? '';
  const effectiveBaseUrl = imageProviderBaseUrl(provider.id, settings);
  const model = imageProviderModel(provider.id, settings);
  const ready = imageProviderReady(provider.id, settings);
  const KeyIcon = showKey ? EyeOff : Eye;

  const cacheKey = endpointModelCacheKey('image', provider.id, effectiveBaseUrl);
  const modelOptions = uniqueStringOptions([
    ...(settings.providerModelLists[provider.id] ?? []),
    ...provider.models,
  ]);
  const persistProviderModelOption = (models: string[], candidate: string) => {
    const value = candidate.trim();
    if (!value) return models;
    const builtIn = provider.models.some(
      (item) => item.trim().toLowerCase() === value.toLowerCase(),
    );
    return builtIn ? models : uniqueStringOptions([value, ...models]);
  };
  const cloudflareModelListUrl =
    provider.id === 'cloudflare' && accountId.trim()
      ? `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(
          accountId.trim(),
        )}/ai/models/search`
      : '';
  const modelListBaseUrl =
    provider.id === 'cloudflare' ? cloudflareModelListUrl : effectiveBaseUrl;
  const canRefresh =
    !!modelListBaseUrl && (!provider.needsKey || keyValue.trim().length > 0);

  const patchProvider = (
    patch: Partial<{
      key: string;
      accountId: string;
      baseUrl: string;
      model: string;
    }>,
  ) => {
    const next: ImageGenerationSettings = {
      ...settings,
      providerKeys: { ...settings.providerKeys },
      providerAccountIds: { ...settings.providerAccountIds },
      providerBaseUrls: { ...settings.providerBaseUrls },
      providerModels: { ...settings.providerModels },
      providerModelLists: { ...settings.providerModelLists },
    };
    if (patch.key !== undefined) {
      const value = patch.key.trim();
      if (value) next.providerKeys[provider.id] = value;
      else delete next.providerKeys[provider.id];
    }
    if (patch.accountId !== undefined) {
      const value = patch.accountId.trim();
      if (value) next.providerAccountIds[provider.id] = value;
      else delete next.providerAccountIds[provider.id];
    }
    if (patch.baseUrl !== undefined) {
      const value = patch.baseUrl.trim();
      if (value) next.providerBaseUrls[provider.id] = value;
      else delete next.providerBaseUrls[provider.id];
    }
    if (patch.model !== undefined) {
      const value = patch.model.trim();
      let models = next.providerModelLists[provider.id] ?? [];
      models = persistProviderModelOption(models, model);
      models = persistProviderModelOption(models, value);
      if (models.length > 0) next.providerModelLists[provider.id] = models;
      else delete next.providerModelLists[provider.id];
      if (value) next.providerModels[provider.id] = value;
      else delete next.providerModels[provider.id];
    }
    onChange(next);
  };

  const patchProviderModelList = ({
    add,
    remove,
    select,
  }: {
    add?: string;
    remove?: string;
    select?: string;
  }) => {
    const next: ImageGenerationSettings = {
      ...settings,
      providerModels: { ...settings.providerModels },
      providerModelLists: { ...settings.providerModelLists },
    };
    let models = settings.providerModelLists[provider.id] ?? [];
    if (add !== undefined) {
      models = uniqueStringOptions([add, ...models]);
    }
    if (remove !== undefined) {
      const removed = remove.trim().toLowerCase();
      models = models.filter((item) => item.trim().toLowerCase() !== removed);
    }
    if (models.length > 0) next.providerModelLists[provider.id] = models;
    else delete next.providerModelLists[provider.id];
    if (select !== undefined) {
      const value = select.trim();
      if (value) next.providerModels[provider.id] = value;
      else delete next.providerModels[provider.id];
    }
    onChange(next);
  };

  const refreshModels = async () => {
    if (!canRefresh || modelRefresh.loading) return;
    setModelRefresh({ loading: true, error: null });
    try {
      const result = await refreshEndpointModels({
        cacheKey,
        baseUrl: modelListBaseUrl,
        apiKey: keyValue,
        urls: provider.id === 'cloudflare' ? [modelListBaseUrl] : undefined,
        fallback: [model, ...provider.models],
      });
      setModelRefresh({ loading: false, error: result.error ?? null });
    } catch (err) {
      setModelRefresh({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const isComfyChannel = provider.id === 'local-comfyui';
  const runComfyInstall = async () => {
    if (!isTauri()) {
      setComfyInstall({
        state: 'error',
        message: t(locale, 'settings.imageGeneration.comfyInstallDesktopOnly'),
      });
      return;
    }
    setComfyInstall({ state: 'starting', message: null });
    try {
      // The model dropdown selection maps onto a known installer profile when it
      // is one of the one-click checkpoints; otherwise let the script pick by VRAM.
      const known: ComfyUiSetupModel[] = ['sd1.5', 'sdxl-turbo', 'flux-schnell'];
      const picked = known.find((m) => m === model);
      await setupComfyui(picked, false);
      setComfyInstall({
        state: 'started',
        message: t(locale, 'settings.imageGeneration.comfyInstallStarted'),
      });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      setComfyInstall({
        state: 'error',
        message:
          raw === 'NO_BACKEND'
            ? t(locale, 'settings.imageGeneration.comfyInstallDesktopOnly')
            : raw,
      });
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-border bg-bg-alt p-4">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-fg">{provider.label}</span>
            <span
              className={cn(
                'inline-flex shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium',
                imageProviderCategoryBadgeClass(provider.category),
              )}
            >
              {imageProviderCategoryLabel(provider.category, locale)}
            </span>
            <StatusBadge
              state={ready ? 'direct' : 'unavailable'}
              label={imageProviderStatusLabel(provider, settings, locale)}
            />
            <span
              className={cn(
                'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium',
                imageProviderSupportsComfyUiGraph(provider.id)
                  ? 'border-accent/40 bg-accent/10 text-accent'
                  : 'border-border bg-panel text-fg-faint',
              )}
              title={
                imageProviderSupportsComfyUiGraph(provider.id)
                  ? t(locale, 'settings.imageGeneration.comfyGraphSupportedHint')
                  : t(locale, 'settings.imageGeneration.comfyGraphUnsupportedHint')
              }
            >
              <Boxes size={11} strokeWidth={2.2} />
              {t(
                locale,
                imageProviderSupportsComfyUiGraph(provider.id)
                  ? 'settings.imageGeneration.comfyGraphSupported'
                  : 'settings.imageGeneration.comfyGraphUnsupported',
              )}
            </span>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-fg-faint">
            {provider.note}
          </p>
        </div>
        {provider.credentialUrl && (
          <button
            type="button"
            onClick={() => void openExternal(provider.credentialUrl as string)}
            className="inline-flex items-center gap-1.5 rounded border border-border bg-panel px-2.5 py-1 text-xs text-fg-dim transition-colors hover:border-accent hover:text-fg"
          >
            <ExternalLink size={13} strokeWidth={2.2} />
            {provider.local
              ? t(locale, 'dock.localModelDownload')
              : t(
                  locale,
                  ready
                    ? 'settings.freeChannels.manageKey'
                    : 'settings.freeChannels.getKey',
            )}
          </button>
        )}
        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            title={t(locale, 'settings.models.delete')}
            aria-label={t(locale, 'settings.models.delete')}
            className="inline-flex h-7 w-7 items-center justify-center rounded border border-rose-500/40 bg-rose-500/10 text-rose-300 transition-colors hover:bg-rose-500/20"
          >
            <Trash2 size={13} strokeWidth={2.2} />
          </button>
        )}
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {provider.supportsBaseUrl && (
          <label className="block space-y-1">
            <span className="text-[11px] font-medium text-fg-dim">
              {t(locale, 'settings.models.baseUrl')}
            </span>
            <input
              type="text"
              value={baseUrl}
              onChange={(event) => patchProvider({ baseUrl: event.target.value })}
              placeholder={effectiveBaseUrl || provider.endpointPlaceholder}
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-md border border-border bg-panel px-2.5 py-1.5 font-mono text-sm text-fg outline-none transition-colors focus:border-accent"
            />
          </label>
        )}

        {provider.needsKey || provider.id === 'pollinations' || provider.id === 'ai-horde' ? (
          <label className="block space-y-1">
            <span className="text-[11px] font-medium text-fg-dim">
              {provider.keyLabel ?? t(locale, 'settings.models.apiKey')}
            </span>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={keyValue}
                onChange={(event) => patchProvider({ key: event.target.value })}
                placeholder={
                  provider.keyPlaceholder ??
                  (provider.id === 'ai-horde'
                    ? 'optional, anonymous if empty'
                    : 'sk-...')
                }
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded-md border border-border bg-panel px-2.5 py-1.5 pr-14 font-mono text-sm text-fg outline-none transition-colors focus:border-accent"
              />
              <div className="absolute inset-y-0 right-1 flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  title={t(
                    locale,
                    showKey ? 'settings.models.hideKey' : 'settings.models.showKey',
                  )}
                  className="flex h-6 w-6 items-center justify-center rounded text-fg-faint transition-colors hover:text-fg"
                >
                  <KeyIcon size={13} strokeWidth={2} />
                </button>
                {keyValue && (
                  <button
                    type="button"
                    onClick={() => patchProvider({ key: '' })}
                    title={t(locale, 'settings.models.clear')}
                    className="flex h-6 w-6 items-center justify-center rounded text-fg-faint transition-colors hover:text-rose-300"
                  >
                    <Trash2 size={13} strokeWidth={2} />
                  </button>
                )}
              </div>
            </div>
          </label>
        ) : null}

        {provider.needsAccountId && (
          <label className="block space-y-1">
            <span className="text-[11px] font-medium text-fg-dim">
              {provider.accountIdLabel ?? t(locale, 'settings.imageGeneration.accountIdLabel')}
            </span>
            <input
              type="text"
              value={accountId}
              onChange={(event) =>
                patchProvider({ accountId: event.target.value })
              }
              placeholder={provider.accountIdPlaceholder ?? 'Cloudflare Account ID'}
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-md border border-border bg-panel px-2.5 py-1.5 font-mono text-sm text-fg outline-none transition-colors focus:border-accent"
            />
          </label>
        )}

        <div className="lg:col-span-2">
          <EditableModelSelect
            cacheKey={cacheKey}
            builtins={modelOptions}
            value={model}
            label={t(locale, 'settings.freeChannels.modelLabel')}
            locale={locale}
            loading={modelRefresh.loading}
            error={modelRefresh.error}
            canRefresh={canRefresh}
            onChange={(next) => patchProvider({ model: next })}
            onAddModel={(next) => patchProviderModelList({ add: next, select: next })}
            onRemoveModel={(removed, nextValue) =>
              patchProviderModelList({ remove: removed, select: nextValue })
            }
            onRefresh={() => void refreshModels()}
          />
        </div>

        {isComfyChannel && (
          <div className="lg:col-span-2 space-y-2 rounded-md border border-accent/30 bg-accent/5 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-fg">
                  <Boxes size={13} strokeWidth={2.2} className="text-accent" />
                  {t(locale, 'settings.imageGeneration.comfyInstallTitle')}
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-fg-faint">
                  {t(locale, 'settings.imageGeneration.comfyInstallDesc')}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void runComfyInstall()}
                disabled={comfyInstall.state === 'starting'}
                className="inline-flex shrink-0 items-center gap-1.5 rounded border border-accent bg-accent px-3 py-1.5 text-xs font-medium text-bg transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <DownloadCloud
                  size={14}
                  strokeWidth={2.2}
                  className={comfyInstall.state === 'starting' ? 'animate-pulse' : undefined}
                />
                {comfyInstall.state === 'starting'
                  ? t(locale, 'settings.imageGeneration.comfyInstallStarting')
                  : t(locale, 'settings.imageGeneration.comfyInstallButton')}
              </button>
            </div>
            {comfyInstall.state === 'started' && comfyInstall.message && (
              <p className="rounded border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-emerald-200">
                {comfyInstall.message}
              </p>
            )}
            {comfyInstall.state === 'error' && comfyInstall.message && (
              <p className="rounded border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-rose-200">
                {comfyInstall.message}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function MusicGenerationSettingsPanel({
  locale,
  settingsProfile,
  remoteProfile = false,
}: {
  locale: Locale;
  settingsProfile?: SettingsProfileOptions;
  remoteProfile?: boolean;
}) {
  const [settings, setSettings] = useState<MusicGenerationSettings>(() =>
    loadMusicGenerationSettings(settingsProfile),
  );
  const [category, setCategory] = useState<MusicProviderCategory>('commercial');
  const [customDialogOpen, setCustomDialogOpen] = useState(false);

  const update = (patch: Partial<MusicGenerationSettings>) => {
    const next = { ...settings, ...patch };
    saveMusicGenerationSettings(next, settingsProfile);
    setSettings(next);
  };

  const providers = musicProviders(settings).filter(
    (provider) => !remoteProfile || !provider.local,
  );
  const providerOptions = providers.map((provider) => ({
    id: provider.id,
    label: provider.label,
    hint: `${musicProviderCategoryLabel(provider.category, locale)} · ${musicProviderStatusLabel(
      provider,
      settings,
      locale,
    )}`,
    group: musicProviderCategoryLabel(provider.category, locale),
  }));
  const activeProviders = providers.filter(
    (provider) => provider.category === category,
  );

  const addCustomProvider = (draft: CustomGenerationProviderDraft) => {
    const id = uniqueCustomId(
      createCustomMusicProviderId(draft.name),
      settings.customProviders.map((provider) => provider.id),
    );
    const provider: CustomMusicProviderDefinition = {
      id,
      label: draft.name,
      category,
      apiKind: 'generic-online-music',
      defaultModel: draft.model,
      models: draft.models,
      needsKey: true,
      local: false,
      defaultBaseUrl: draft.baseUrl,
      supportsBaseUrl: true,
      endpointPlaceholder: draft.baseUrl,
      keyPlaceholder: 'sk-...',
      note: '自定义 OpenAI-compatible 音乐生成渠道。',
    };
    const next: MusicGenerationSettings = {
      ...settings,
      preferredProviderId: id,
      customProviders: [...settings.customProviders, provider],
      providerKeys: { ...settings.providerKeys },
      providerBaseUrls: { ...settings.providerBaseUrls, [id]: draft.baseUrl },
      providerModels: { ...settings.providerModels, [id]: draft.model },
      providerModelLists: { ...settings.providerModelLists, [id]: draft.models },
    };
    if (draft.apiKey) next.providerKeys[id] = draft.apiKey;
    if (!saveMusicGenerationSettings(next, settingsProfile)) return false;
    setSettings(loadMusicGenerationSettings(settingsProfile));
    setCustomDialogOpen(false);
    return true;
  };

  const deleteCustomProvider = (id: MusicProviderId) => {
    const providerKeys = { ...settings.providerKeys };
    const providerBaseUrls = { ...settings.providerBaseUrls };
    const providerModels = { ...settings.providerModels };
    const providerModelLists = { ...settings.providerModelLists };
    delete providerKeys[id];
    delete providerBaseUrls[id];
    delete providerModels[id];
    delete providerModelLists[id];
    const next: MusicGenerationSettings = {
      ...settings,
      preferredProviderId:
        settings.preferredProviderId === id
          ? 'elevenlabs-music'
          : settings.preferredProviderId,
      customProviders: settings.customProviders.filter((provider) => provider.id !== id),
      providerKeys,
      providerBaseUrls,
      providerModels,
      providerModelLists,
    };
    saveMusicGenerationSettings(next, settingsProfile);
    setSettings(loadMusicGenerationSettings(settingsProfile));
  };

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-lg font-semibold text-fg">
          {t(locale, 'settings.musicGeneration.title')}
        </h3>
        <p className="mt-1 text-xs leading-relaxed text-fg-faint">
          {t(locale, 'settings.musicGeneration.description')}
        </p>
      </div>

      <SettingRow
        title={t(locale, 'settings.musicGeneration.defaultProviderLabel')}
        description={t(locale, 'settings.musicGeneration.defaultProviderDesc')}
      >
        <div className="w-full min-w-[14rem]">
          <SelectControl
            value={settings.preferredProviderId}
            options={providerOptions}
            onChange={(id) =>
              update({ preferredProviderId: id as MusicProviderId })
            }
            icon={<Music size={15} strokeWidth={2.1} />}
          />
        </div>
      </SettingRow>

      <div>
        <div
          role="tablist"
          aria-orientation="horizontal"
          className={SETTINGS_INNER_TABLIST_CLASS}
        >
          {musicProviderCategoryOrder.map((item) => {
            const active = category === item;
            return (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setCategory(item)}
                className={cn(
                  SETTINGS_INNER_TAB_CLASS,
                  active
                    ? '-mb-px border-b-2 border-accent text-fg'
                    : 'text-fg-faint hover:text-fg',
                )}
              >
                {t(locale, musicProviderCategoryTitleKey(item))}
              </button>
            );
          })}
        </div>
      </div>

      <section role="tabpanel" className="rounded-lg border border-border bg-bg-alt p-4">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h4 className="text-sm font-semibold text-fg">
              {t(locale, musicProviderCategoryTitleKey(category))}
            </h4>
            <p className="text-xs leading-relaxed text-fg-faint">
              {t(locale, musicProviderCategoryDescKey(category))}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <StatusBadge state="default" label={String(activeProviders.length)} />
            <button
              type="button"
              onClick={() => setCustomDialogOpen(true)}
              className="inline-flex items-center gap-1.5 rounded border border-border bg-panel px-2.5 py-1 text-xs text-fg-dim transition-colors hover:border-accent hover:text-fg"
            >
              <Plus size={13} strokeWidth={2.2} />
              {t(locale, 'settings.models.add')}
            </button>
          </div>
        </div>
        <div className={SETTINGS_PROVIDER_GRID_CLASS}>
          {activeProviders.map((provider) => (
            <MusicProviderSettingsRow
              key={provider.id}
              provider={provider}
              settings={settings}
              locale={locale}
              onChange={(next) => {
                saveMusicGenerationSettings(next, settingsProfile);
                setSettings(next);
              }}
              onDelete={
                provider.custom ? () => deleteCustomProvider(provider.id) : undefined
              }
            />
          ))}
        </div>
      </section>
      {customDialogOpen && (
        <CustomGenerationProviderDialog
          locale={locale}
          title={t(locale, 'settings.models.addTitle')}
          modelScope="music"
          defaultName={t(locale, 'settings.models.newProviderName')}
          defaultModel="custom-music-model"
          endpointPlaceholder="https://api.example.com/v1/audio/generations"
          onClose={() => setCustomDialogOpen(false)}
          onSave={addCustomProvider}
        />
      )}
    </div>
  );
}

const musicProviderCategoryOrder: MusicProviderCategory[] = ['commercial', 'free'];

function musicProviderCategoryTitleKey(
  category: MusicProviderCategory,
): TranslationKey {
  return category === 'free'
    ? 'settings.musicGeneration.freeProviders'
    : 'settings.musicGeneration.commercialProviders';
}

function musicProviderCategoryDescKey(
  category: MusicProviderCategory,
): TranslationKey {
  return category === 'free'
    ? 'settings.musicGeneration.freeProvidersDesc'
    : 'settings.musicGeneration.commercialProvidersDesc';
}

function musicProviderCategoryLabel(
  category: MusicProviderCategory,
  locale: Locale,
): string {
  return t(
    locale,
    category === 'free'
      ? 'settings.musicGeneration.categoryFree'
      : 'settings.musicGeneration.categoryCommercial',
  );
}

function musicProviderCategoryBadgeClass(category: MusicProviderCategory): string {
  return category === 'free'
    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
    : 'border-sky-500/30 bg-sky-500/10 text-sky-300';
}

function musicProviderStatusLabel(
  provider: MusicProviderDefinition,
  settings: MusicGenerationSettings,
  locale: Locale,
): string {
  if (musicProviderReady(provider.id, settings)) {
    return t(locale, 'settings.freeChannels.ready');
  }
  if (provider.local) return t(locale, 'settings.freeChannels.localNeedsSetup');
  if (provider.needsKey) return t(locale, 'settings.freeChannels.needsKey');
  return t(locale, 'settings.imageGeneration.noKeyRequired');
}

function MusicProviderSettingsRow({
  provider,
  settings,
  locale,
  onChange,
  onDelete,
}: {
  provider: MusicProviderDefinition;
  settings: MusicGenerationSettings;
  locale: Locale;
  onChange: (settings: MusicGenerationSettings) => void;
  onDelete?: () => void;
}) {
  const [showKey, setShowKey] = useState(false);
  const [modelRefresh, setModelRefresh] = useState<{
    loading: boolean;
    error: string | null;
  }>({ loading: false, error: null });
  const keyProviderId = provider.keyProviderId ?? provider.id;
  const keyValue = settings.providerKeys[keyProviderId] ?? '';
  const baseUrl = settings.providerBaseUrls[provider.id] ?? '';
  const effectiveBaseUrl = musicProviderBaseUrl(provider.id, settings);
  const model = musicProviderModel(provider.id, settings);
  const ready = musicProviderReady(provider.id, settings);
  const KeyIcon = showKey ? EyeOff : Eye;

  const cacheKey = endpointModelCacheKey('music', provider.id, effectiveBaseUrl);
  const modelOptions = uniqueStringOptions([
    ...(settings.providerModelLists[provider.id] ?? []),
    ...provider.models,
  ]);
  const canRefresh =
    !!effectiveBaseUrl && (!provider.needsKey || keyValue.trim().length > 0);

  const patchProvider = (
    patch: Partial<{
      key: string;
      baseUrl: string;
      model: string;
    }>,
  ) => {
    const next: MusicGenerationSettings = {
      ...settings,
      providerKeys: { ...settings.providerKeys },
      providerBaseUrls: { ...settings.providerBaseUrls },
      providerModels: { ...settings.providerModels },
      providerModelLists: { ...settings.providerModelLists },
    };
    if (patch.key !== undefined) {
      const value = patch.key.trim();
      if (value) next.providerKeys[keyProviderId] = value;
      else delete next.providerKeys[keyProviderId];
    }
    if (patch.baseUrl !== undefined) {
      const value = patch.baseUrl.trim();
      if (value) next.providerBaseUrls[provider.id] = value;
      else delete next.providerBaseUrls[provider.id];
    }
    if (patch.model !== undefined) {
      const value = patch.model.trim();
      let models = next.providerModelLists[provider.id] ?? [];
      models = persistCustomGenerationModelOption(models, model, provider.models);
      models = persistCustomGenerationModelOption(models, value, provider.models);
      if (models.length > 0) next.providerModelLists[provider.id] = models;
      else delete next.providerModelLists[provider.id];
      if (value) next.providerModels[provider.id] = value;
      else delete next.providerModels[provider.id];
    }
    if (
      !musicProviderReady(next.preferredProviderId, next) &&
      musicProviderReady(provider.id, next)
    ) {
      next.preferredProviderId = provider.id;
    }
    onChange(next);
  };

  const patchProviderModelList = ({
    add,
    remove,
    select,
  }: {
    add?: string;
    remove?: string;
    select?: string;
  }) => {
    const next: MusicGenerationSettings = {
      ...settings,
      providerModels: { ...settings.providerModels },
      providerModelLists: { ...settings.providerModelLists },
    };
    let models = settings.providerModelLists[provider.id] ?? [];
    if (add !== undefined) {
      models = uniqueStringOptions([add, ...models]);
    }
    if (remove !== undefined) {
      models = removeGenerationModelOption(models, remove);
    }
    if (models.length > 0) next.providerModelLists[provider.id] = models;
    else delete next.providerModelLists[provider.id];
    if (select !== undefined) {
      const value = select.trim();
      if (value) next.providerModels[provider.id] = value;
      else delete next.providerModels[provider.id];
    }
    onChange(next);
  };

  const refreshModels = async () => {
    if (!canRefresh || modelRefresh.loading) return;
    setModelRefresh({ loading: true, error: null });
    try {
      const result = await refreshEndpointModels({
        cacheKey,
        baseUrl: effectiveBaseUrl,
        apiKey: keyValue,
        fallback: [model, ...modelOptions],
      });
      setModelRefresh({ loading: false, error: result.error ?? null });
    } catch (err) {
      setModelRefresh({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-border bg-bg-alt p-4">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-fg">{provider.label}</span>
            <span
              className={cn(
                'inline-flex shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium',
                musicProviderCategoryBadgeClass(provider.category),
              )}
            >
              {musicProviderCategoryLabel(provider.category, locale)}
            </span>
            <StatusBadge
              state={ready ? 'direct' : 'unavailable'}
              label={musicProviderStatusLabel(provider, settings, locale)}
            />
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-fg-faint">
            {provider.note}
          </p>
        </div>
        {provider.credentialUrl && (
          <button
            type="button"
            onClick={() => void openExternal(provider.credentialUrl as string)}
            className="inline-flex items-center gap-1.5 rounded border border-border bg-panel px-2.5 py-1 text-xs text-fg-dim transition-colors hover:border-accent hover:text-fg"
          >
            <ExternalLink size={13} strokeWidth={2.2} />
            {provider.local
              ? t(locale, 'dock.localModelDownload')
              : t(
                  locale,
                  ready
                    ? 'settings.freeChannels.manageKey'
                    : 'settings.freeChannels.getKey',
                )}
          </button>
        )}
        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            title={t(locale, 'settings.models.delete')}
            aria-label={t(locale, 'settings.models.delete')}
            className="inline-flex h-7 w-7 items-center justify-center rounded border border-rose-500/40 bg-rose-500/10 text-rose-300 transition-colors hover:bg-rose-500/20"
          >
            <Trash2 size={13} strokeWidth={2.2} />
          </button>
        )}
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {provider.supportsBaseUrl && (
          <label className="block space-y-1">
            <span className="text-[11px] font-medium text-fg-dim">
              {t(locale, 'settings.models.baseUrl')}
            </span>
            <input
              type="text"
              value={baseUrl}
              onChange={(event) => patchProvider({ baseUrl: event.target.value })}
              placeholder={effectiveBaseUrl || provider.endpointPlaceholder}
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-md border border-border bg-panel px-2.5 py-1.5 font-mono text-sm text-fg outline-none transition-colors focus:border-accent"
            />
          </label>
        )}

        {provider.needsKey && (
          <label className="block space-y-1">
            <span className="text-[11px] font-medium text-fg-dim">
              {provider.keyLabel ?? t(locale, 'settings.models.apiKey')}
            </span>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={keyValue}
                onChange={(event) => patchProvider({ key: event.target.value })}
                onPaste={(event) => {
                  const nextValue = inputValueAfterPaste(event);
                  if (nextValue != null) patchProvider({ key: nextValue });
                }}
                placeholder={provider.keyPlaceholder ?? 'sk-...'}
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded-md border border-border bg-panel px-2.5 py-1.5 pr-14 font-mono text-sm text-fg outline-none transition-colors focus:border-accent"
              />
              <div className="absolute inset-y-0 right-1 flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  title={t(
                    locale,
                    showKey ? 'settings.models.hideKey' : 'settings.models.showKey',
                  )}
                  className="flex h-6 w-6 items-center justify-center rounded text-fg-faint transition-colors hover:text-fg"
                >
                  <KeyIcon size={13} strokeWidth={2} />
                </button>
                {keyValue && (
                  <button
                    type="button"
                    onClick={() => patchProvider({ key: '' })}
                    title={t(locale, 'settings.models.clear')}
                    className="flex h-6 w-6 items-center justify-center rounded text-fg-faint transition-colors hover:text-rose-300"
                  >
                    <Trash2 size={13} strokeWidth={2} />
                  </button>
                )}
              </div>
            </div>
          </label>
        )}

        <div className="lg:col-span-2">
          <EditableModelSelect
            cacheKey={cacheKey}
            builtins={modelOptions}
            value={model}
            label={t(locale, 'settings.freeChannels.modelLabel')}
            locale={locale}
            loading={modelRefresh.loading}
            error={modelRefresh.error}
            canRefresh={canRefresh}
            onChange={(next) => patchProvider({ model: next })}
            onAddModel={(next) => patchProviderModelList({ add: next, select: next })}
            onRemoveModel={(removed, nextValue) =>
              patchProviderModelList({ remove: removed, select: nextValue })
            }
            onRefresh={() => void refreshModels()}
          />
        </div>
      </div>
    </div>
  );
}

function VideoGenerationSettingsPanel({
  locale,
  settingsProfile,
  remoteProfile = false,
}: {
  locale: Locale;
  settingsProfile?: SettingsProfileOptions;
  remoteProfile?: boolean;
}) {
  const [settings, setSettings] = useState<VideoGenerationSettings>(() =>
    loadVideoGenerationSettings(settingsProfile),
  );
  const [category, setCategory] = useState<VideoProviderCategory>('commercial');
  const [customDialogOpen, setCustomDialogOpen] = useState(false);

  const update = (patch: Partial<VideoGenerationSettings>) => {
    const next = { ...settings, ...patch };
    saveVideoGenerationSettings(next, settingsProfile);
    setSettings(next);
  };

  const providers = videoProviders(settings).filter(
    (provider) => !remoteProfile || !provider.local,
  );
  const providerOptions = providers.map((provider) => ({
    id: provider.id,
    label: provider.label,
    hint: `${videoProviderCategoryLabel(provider.category, locale)} · ${videoProviderStatusLabel(
      provider,
      settings,
      locale,
    )}`,
    group: videoProviderCategoryLabel(provider.category, locale),
  }));
  const activeProviders = providers.filter(
    (provider) => provider.category === category,
  );

  const addCustomProvider = (draft: CustomGenerationProviderDraft) => {
    const id = uniqueCustomId(
      createCustomVideoProviderId(draft.name),
      settings.customProviders.map((provider) => provider.id),
    );
    const provider: CustomVideoProviderDefinition = {
      id,
      label: draft.name,
      category,
      apiKind: 'generic-online-video',
      defaultModel: draft.model,
      models: draft.models,
      needsKey: true,
      local: false,
      defaultBaseUrl: draft.baseUrl,
      supportsBaseUrl: true,
      endpointPlaceholder: draft.baseUrl,
      keyPlaceholder: 'sk-...',
      note: '自定义 OpenAI-compatible 视频生成渠道。',
    };
    const next: VideoGenerationSettings = {
      ...settings,
      preferredProviderId: id,
      customProviders: [...settings.customProviders, provider],
      providerKeys: { ...settings.providerKeys },
      providerBaseUrls: { ...settings.providerBaseUrls, [id]: draft.baseUrl },
      providerModels: { ...settings.providerModels, [id]: draft.model },
      providerModelLists: { ...settings.providerModelLists, [id]: draft.models },
    };
    if (draft.apiKey) next.providerKeys[id] = draft.apiKey;
    if (!saveVideoGenerationSettings(next, settingsProfile)) return false;
    setSettings(loadVideoGenerationSettings(settingsProfile));
    setCustomDialogOpen(false);
    return true;
  };

  const deleteCustomProvider = (id: VideoProviderId) => {
    const providerKeys = { ...settings.providerKeys };
    const providerBaseUrls = { ...settings.providerBaseUrls };
    const providerModels = { ...settings.providerModels };
    const providerModelLists = { ...settings.providerModelLists };
    delete providerKeys[id];
    delete providerBaseUrls[id];
    delete providerModels[id];
    delete providerModelLists[id];
    const next: VideoGenerationSettings = {
      ...settings,
      preferredProviderId:
        settings.preferredProviderId === id ? 'fal-video' : settings.preferredProviderId,
      customProviders: settings.customProviders.filter((provider) => provider.id !== id),
      providerKeys,
      providerBaseUrls,
      providerModels,
      providerModelLists,
    };
    saveVideoGenerationSettings(next, settingsProfile);
    setSettings(loadVideoGenerationSettings(settingsProfile));
  };

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-lg font-semibold text-fg">
          {t(locale, 'settings.videoGeneration.title')}
        </h3>
        <p className="mt-1 text-xs leading-relaxed text-fg-faint">
          {t(locale, 'settings.videoGeneration.description')}
        </p>
      </div>

      <SettingRow
        title={t(locale, 'settings.videoGeneration.defaultProviderLabel')}
        description={t(locale, 'settings.videoGeneration.defaultProviderDesc')}
      >
        <div className="w-full min-w-[14rem]">
          <SelectControl
            value={settings.preferredProviderId}
            options={providerOptions}
            onChange={(id) =>
              update({ preferredProviderId: id as VideoProviderId })
            }
            icon={<Video size={15} strokeWidth={2.1} />}
          />
        </div>
      </SettingRow>

      <div>
        <div
          role="tablist"
          aria-orientation="horizontal"
          className={SETTINGS_INNER_TABLIST_CLASS}
        >
          {videoProviderCategoryOrder.map((item) => {
            const active = category === item;
            return (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setCategory(item)}
                className={cn(
                  SETTINGS_INNER_TAB_CLASS,
                  active
                    ? '-mb-px border-b-2 border-accent text-fg'
                    : 'text-fg-faint hover:text-fg',
                )}
              >
                {t(locale, videoProviderCategoryTitleKey(item))}
              </button>
            );
          })}
        </div>
      </div>

      <section role="tabpanel" className="rounded-lg border border-border bg-bg-alt p-4">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h4 className="text-sm font-semibold text-fg">
              {t(locale, videoProviderCategoryTitleKey(category))}
            </h4>
            <p className="text-xs leading-relaxed text-fg-faint">
              {t(locale, videoProviderCategoryDescKey(category))}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <StatusBadge state="default" label={String(activeProviders.length)} />
            <button
              type="button"
              onClick={() => setCustomDialogOpen(true)}
              className="inline-flex items-center gap-1.5 rounded border border-border bg-panel px-2.5 py-1 text-xs text-fg-dim transition-colors hover:border-accent hover:text-fg"
            >
              <Plus size={13} strokeWidth={2.2} />
              {t(locale, 'settings.models.add')}
            </button>
          </div>
        </div>
        <div className={SETTINGS_PROVIDER_GRID_CLASS}>
          {activeProviders.map((provider) => (
            <VideoProviderSettingsRow
              key={provider.id}
              provider={provider}
              settings={settings}
              locale={locale}
              onChange={(next) => {
                saveVideoGenerationSettings(next, settingsProfile);
                setSettings(next);
              }}
              onDelete={
                provider.custom ? () => deleteCustomProvider(provider.id) : undefined
              }
            />
          ))}
        </div>
      </section>
      {customDialogOpen && (
        <CustomGenerationProviderDialog
          locale={locale}
          title={t(locale, 'settings.models.addTitle')}
          modelScope="video"
          defaultName={t(locale, 'settings.models.newProviderName')}
          defaultModel="custom-video-model"
          endpointPlaceholder="https://api.example.com/v1/video/generations"
          onClose={() => setCustomDialogOpen(false)}
          onSave={addCustomProvider}
        />
      )}
    </div>
  );
}

const videoProviderCategoryOrder: VideoProviderCategory[] = ['commercial', 'free'];

// Interactive playable world-model channel settings. Compact, focused panel: a
// default-provider picker plus per-provider key / endpoint inputs. Mirrors the
// video panel's persistence pattern but without custom-provider authoring, since
// the world-model catalog is curated and live-session providers vary widely.
function WorldModelGenerationSettingsPanel({
  locale,
  settingsProfile,
  remoteProfile = false,
}: {
  locale: Locale;
  settingsProfile?: SettingsProfileOptions;
  remoteProfile?: boolean;
}) {
  const [settings, setSettings] = useState<WorldModelGenerationSettings>(() =>
    loadWorldModelGenerationSettings(settingsProfile),
  );

  const update = (patch: Partial<WorldModelGenerationSettings>) => {
    const next = { ...settings, ...patch };
    saveWorldModelGenerationSettings(next, settingsProfile);
    setSettings(next);
  };

  const providers = worldModelProviders(settings).filter(
    (provider) => !remoteProfile || !provider.local,
  );
  const providerOptions = providers.map((provider) => ({
    id: provider.id,
    label: provider.label,
    hint:
      (provider.category === 'commercial'
        ? t(locale, 'settings.worldModelGeneration.commercial')
        : t(locale, 'settings.worldModelGeneration.free')) +
      ' · ' +
      (worldModelProviderReady(provider.id, settings)
        ? t(locale, 'settings.worldModelGeneration.ready')
        : provider.hasPublicApi
          ? t(locale, 'settings.worldModelGeneration.needsConfig')
          : t(locale, 'settings.worldModelGeneration.previewOnly')),
  }));

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-lg font-semibold text-fg">
          {t(locale, 'settings.worldModelGeneration.title')}
        </h3>
        <p className="mt-1 text-xs leading-relaxed text-fg-faint">
          {t(locale, 'settings.worldModelGeneration.description')}
        </p>
      </div>

      <SettingRow
        title={t(locale, 'settings.worldModelGeneration.defaultProviderLabel')}
        description={t(locale, 'settings.worldModelGeneration.defaultProviderDesc')}
      >
        <div className="w-full min-w-[14rem]">
          <SelectControl
            value={settings.preferredProviderId}
            options={providerOptions}
            onChange={(id) =>
              update({ preferredProviderId: id as WorldModelProviderId })
            }
            icon={<Globe size={15} strokeWidth={2.1} />}
          />
        </div>
      </SettingRow>

      <section className="rounded-lg border border-border bg-bg-alt p-4">
        <div className={SETTINGS_PROVIDER_GRID_CLASS}>
          {providers.map((provider) => (
            <WorldModelProviderSettingsRow
              key={provider.id}
              provider={provider}
              settings={settings}
              locale={locale}
              onChange={(next) => {
                saveWorldModelGenerationSettings(next, settingsProfile);
                setSettings(next);
              }}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function WorldModelProviderSettingsRow({
  provider,
  settings,
  locale,
  onChange,
}: {
  provider: WorldModelProviderDefinition;
  settings: WorldModelGenerationSettings;
  locale: Locale;
  onChange: (settings: WorldModelGenerationSettings) => void;
}) {
  const [showKey, setShowKey] = useState(false);
  const keyValue = settings.providerKeys[provider.id] ?? '';
  const baseUrl = settings.providerBaseUrls[provider.id] ?? '';
  const effectiveBaseUrl = worldModelProviderBaseUrl(provider.id, settings);
  const model = worldModelProviderModel(provider.id, settings);
  const ready = worldModelProviderReady(provider.id, settings);
  const KeyIcon = showKey ? EyeOff : Eye;

  const patchProvider = (
    patch: Partial<{ key: string; baseUrl: string; model: string }>,
  ) => {
    const next: WorldModelGenerationSettings = {
      ...settings,
      providerKeys: { ...settings.providerKeys },
      providerBaseUrls: { ...settings.providerBaseUrls },
      providerModels: { ...settings.providerModels },
    };
    if (patch.key !== undefined) {
      const value = patch.key.trim();
      if (value) next.providerKeys[provider.id] = value;
      else delete next.providerKeys[provider.id];
    }
    if (patch.baseUrl !== undefined) {
      const value = patch.baseUrl.trim();
      if (value) next.providerBaseUrls[provider.id] = value;
      else delete next.providerBaseUrls[provider.id];
    }
    if (patch.model !== undefined) {
      const value = patch.model.trim();
      if (value) next.providerModels[provider.id] = value;
      else delete next.providerModels[provider.id];
    }
    onChange(next);
  };

  return (
    <div className="space-y-2 rounded-lg border border-border bg-panel p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-sm font-medium text-fg">
            <Globe size={13} className="shrink-0 text-accent" />
            <span className="truncate">{provider.label}</span>
          </div>
          <p className="mt-0.5 text-xs leading-relaxed text-fg-faint">{provider.note}</p>
        </div>
        <StatusBadge
          state={ready ? 'direct' : 'default'}
          label={
            ready
              ? t(locale, 'settings.worldModelGeneration.ready')
              : provider.hasPublicApi
                ? t(locale, 'settings.worldModelGeneration.needsConfig')
                : t(locale, 'settings.worldModelGeneration.previewOnly')
          }
        />
      </div>

      {provider.needsKey && (
        <label className="block space-y-1">
          <span className="text-xs text-fg-faint">
            {provider.keyLabel ?? t(locale, 'settings.worldModelGeneration.apiKey')}
          </span>
          <div className="flex items-center gap-1.5">
            <input
              type={showKey ? 'text' : 'password'}
              value={keyValue}
              placeholder={provider.keyPlaceholder ?? ''}
              onChange={(e) => patchProvider({ key: e.target.value })}
              className="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 text-xs text-fg outline-none focus:border-accent"
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-border text-fg-faint hover:text-fg"
              aria-label="toggle key visibility"
            >
              <KeyIcon size={13} />
            </button>
          </div>
        </label>
      )}

      {provider.supportsBaseUrl && (
        <label className="block space-y-1">
          <span className="text-xs text-fg-faint">
            {t(locale, 'settings.worldModelGeneration.endpoint')}
          </span>
          <input
            type="text"
            value={baseUrl}
            placeholder={provider.endpointPlaceholder}
            onChange={(e) => patchProvider({ baseUrl: e.target.value })}
            className="w-full rounded border border-border bg-bg px-2 py-1 text-xs text-fg outline-none focus:border-accent"
          />
        </label>
      )}

      <label className="block space-y-1">
        <span className="text-xs text-fg-faint">
          {t(locale, 'settings.worldModelGeneration.model')}
        </span>
        <input
          type="text"
          value={model}
          placeholder={provider.defaultModel}
          onChange={(e) => patchProvider({ model: e.target.value })}
          className="w-full rounded border border-border bg-bg px-2 py-1 text-xs text-fg outline-none focus:border-accent"
        />
      </label>

      {effectiveBaseUrl && (
        <p className="truncate text-[11px] text-fg-faint" title={effectiveBaseUrl}>
          {effectiveBaseUrl}
        </p>
      )}
      {provider.credentialUrl && (
        <button
          type="button"
          onClick={() => void openExternal(provider.credentialUrl as string)}
          className="text-[11px] text-accent hover:underline"
        >
          {t(locale, 'settings.worldModelGeneration.getAccess')}
        </button>
      )}
    </div>
  );
}

function videoProviderCategoryTitleKey(
  category: VideoProviderCategory,
): TranslationKey {
  return category === 'free'
    ? 'settings.videoGeneration.freeProviders'
    : 'settings.videoGeneration.commercialProviders';
}

function videoProviderCategoryDescKey(
  category: VideoProviderCategory,
): TranslationKey {
  return category === 'free'
    ? 'settings.videoGeneration.freeProvidersDesc'
    : 'settings.videoGeneration.commercialProvidersDesc';
}

function videoProviderCategoryLabel(
  category: VideoProviderCategory,
  locale: Locale,
): string {
  return t(
    locale,
    category === 'free'
      ? 'settings.videoGeneration.categoryFree'
      : 'settings.videoGeneration.categoryCommercial',
  );
}

function videoProviderCategoryBadgeClass(category: VideoProviderCategory): string {
  return category === 'free'
    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
    : 'border-sky-500/30 bg-sky-500/10 text-sky-300';
}

function videoProviderStatusLabel(
  provider: VideoProviderDefinition,
  settings: VideoGenerationSettings,
  locale: Locale,
): string {
  if (videoProviderReady(provider.id, settings)) {
    return t(locale, 'settings.freeChannels.ready');
  }
  if (provider.local) return t(locale, 'settings.freeChannels.localNeedsSetup');
  if (provider.needsKey) return t(locale, 'settings.freeChannels.needsKey');
  return t(locale, 'settings.imageGeneration.noKeyRequired');
}

function VideoProviderSettingsRow({
  provider,
  settings,
  locale,
  onChange,
  onDelete,
}: {
  provider: VideoProviderDefinition;
  settings: VideoGenerationSettings;
  locale: Locale;
  onChange: (settings: VideoGenerationSettings) => void;
  onDelete?: () => void;
}) {
  const [showKey, setShowKey] = useState(false);
  const [modelRefresh, setModelRefresh] = useState<{
    loading: boolean;
    error: string | null;
  }>({ loading: false, error: null });
  const keyProviderId = provider.keyProviderId ?? provider.id;
  const keyValue = settings.providerKeys[keyProviderId] ?? '';
  const baseUrl = settings.providerBaseUrls[provider.id] ?? '';
  const effectiveBaseUrl = videoProviderBaseUrl(provider.id, settings);
  const model = videoProviderModel(provider.id, settings);
  const ready = videoProviderReady(provider.id, settings);
  const KeyIcon = showKey ? EyeOff : Eye;

  const cacheKey = endpointModelCacheKey('video', provider.id, effectiveBaseUrl);
  const modelOptions = uniqueStringOptions([
    ...(settings.providerModelLists[provider.id] ?? []),
    ...provider.models,
  ]);
  const canRefresh =
    !!effectiveBaseUrl && (!provider.needsKey || keyValue.trim().length > 0);

  const patchProvider = (
    patch: Partial<{
      key: string;
      baseUrl: string;
      model: string;
    }>,
  ) => {
    const next: VideoGenerationSettings = {
      ...settings,
      providerKeys: { ...settings.providerKeys },
      providerBaseUrls: { ...settings.providerBaseUrls },
      providerModels: { ...settings.providerModels },
      providerModelLists: { ...settings.providerModelLists },
    };
    if (patch.key !== undefined) {
      const value = patch.key.trim();
      if (value) next.providerKeys[keyProviderId] = value;
      else delete next.providerKeys[keyProviderId];
    }
    if (patch.baseUrl !== undefined) {
      const value = patch.baseUrl.trim();
      if (value) next.providerBaseUrls[provider.id] = value;
      else delete next.providerBaseUrls[provider.id];
    }
    if (patch.model !== undefined) {
      const value = patch.model.trim();
      let models = next.providerModelLists[provider.id] ?? [];
      models = persistCustomGenerationModelOption(models, model, provider.models);
      models = persistCustomGenerationModelOption(models, value, provider.models);
      if (models.length > 0) next.providerModelLists[provider.id] = models;
      else delete next.providerModelLists[provider.id];
      if (value) next.providerModels[provider.id] = value;
      else delete next.providerModels[provider.id];
    }
    if (
      !videoProviderReady(next.preferredProviderId, next) &&
      videoProviderReady(provider.id, next)
    ) {
      next.preferredProviderId = provider.id;
    }
    onChange(next);
  };

  const patchProviderModelList = ({
    add,
    remove,
    select,
  }: {
    add?: string;
    remove?: string;
    select?: string;
  }) => {
    const next: VideoGenerationSettings = {
      ...settings,
      providerModels: { ...settings.providerModels },
      providerModelLists: { ...settings.providerModelLists },
    };
    let models = settings.providerModelLists[provider.id] ?? [];
    if (add !== undefined) {
      models = uniqueStringOptions([add, ...models]);
    }
    if (remove !== undefined) {
      models = removeGenerationModelOption(models, remove);
    }
    if (models.length > 0) next.providerModelLists[provider.id] = models;
    else delete next.providerModelLists[provider.id];
    if (select !== undefined) {
      const value = select.trim();
      if (value) next.providerModels[provider.id] = value;
      else delete next.providerModels[provider.id];
    }
    onChange(next);
  };

  const refreshModels = async () => {
    if (!canRefresh || modelRefresh.loading) return;
    setModelRefresh({ loading: true, error: null });
    try {
      const result = await refreshEndpointModels({
        cacheKey,
        baseUrl: effectiveBaseUrl,
        apiKey: keyValue,
        fallback: [model, ...modelOptions],
      });
      setModelRefresh({ loading: false, error: result.error ?? null });
    } catch (err) {
      setModelRefresh({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-border bg-bg-alt p-4">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-fg">{provider.label}</span>
            <span
              className={cn(
                'inline-flex shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium',
                videoProviderCategoryBadgeClass(provider.category),
              )}
            >
              {videoProviderCategoryLabel(provider.category, locale)}
            </span>
            <StatusBadge
              state={ready ? 'direct' : 'unavailable'}
              label={videoProviderStatusLabel(provider, settings, locale)}
            />
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-fg-faint">
            {provider.note}
          </p>
        </div>
        {provider.credentialUrl && (
          <button
            type="button"
            onClick={() => void openExternal(provider.credentialUrl as string)}
            className="inline-flex items-center gap-1.5 rounded border border-border bg-panel px-2.5 py-1 text-xs text-fg-dim transition-colors hover:border-accent hover:text-fg"
          >
            <ExternalLink size={13} strokeWidth={2.2} />
            {provider.local
              ? t(locale, 'dock.localModelDownload')
              : t(
                  locale,
                  ready
                    ? 'settings.freeChannels.manageKey'
                    : 'settings.freeChannels.getKey',
                )}
          </button>
        )}
        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            title={t(locale, 'settings.models.delete')}
            aria-label={t(locale, 'settings.models.delete')}
            className="inline-flex h-7 w-7 items-center justify-center rounded border border-rose-500/40 bg-rose-500/10 text-rose-300 transition-colors hover:bg-rose-500/20"
          >
            <Trash2 size={13} strokeWidth={2.2} />
          </button>
        )}
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {provider.supportsBaseUrl && (
          <label className="block space-y-1">
            <span className="text-[11px] font-medium text-fg-dim">
              {t(locale, 'settings.models.baseUrl')}
            </span>
            <input
              type="text"
              value={baseUrl}
              onChange={(event) => patchProvider({ baseUrl: event.target.value })}
              onKeyDown={stopSettingsInputKeyPropagation}
              placeholder={effectiveBaseUrl || provider.endpointPlaceholder}
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-md border border-border bg-panel px-2.5 py-1.5 font-mono text-sm text-fg outline-none transition-colors focus:border-accent"
            />
          </label>
        )}

        {provider.needsKey && (
          <label className="block space-y-1">
            <span className="text-[11px] font-medium text-fg-dim">
              {provider.keyLabel ?? t(locale, 'settings.models.apiKey')}
            </span>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={keyValue}
                onChange={(event) => patchProvider({ key: event.target.value })}
                onKeyDown={stopSettingsInputKeyPropagation}
                onPaste={(event) => {
                  const nextValue = inputValueAfterPaste(event);
                  if (nextValue != null) patchProvider({ key: nextValue });
                }}
                placeholder={provider.keyPlaceholder ?? 'sk-...'}
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded-md border border-border bg-panel px-2.5 py-1.5 pr-14 font-mono text-sm text-fg outline-none transition-colors focus:border-accent"
              />
              <div className="absolute inset-y-0 right-1 flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  title={t(
                    locale,
                    showKey ? 'settings.models.hideKey' : 'settings.models.showKey',
                  )}
                  className="flex h-6 w-6 items-center justify-center rounded text-fg-faint transition-colors hover:text-fg"
                >
                  <KeyIcon size={13} strokeWidth={2} />
                </button>
                {keyValue && (
                  <button
                    type="button"
                    onClick={() => patchProvider({ key: '' })}
                    title={t(locale, 'settings.models.clear')}
                    className="flex h-6 w-6 items-center justify-center rounded text-fg-faint transition-colors hover:text-rose-300"
                  >
                    <Trash2 size={13} strokeWidth={2} />
                  </button>
                )}
              </div>
            </div>
          </label>
        )}

        <div className="lg:col-span-2">
          <EditableModelSelect
            cacheKey={cacheKey}
            builtins={modelOptions}
            value={model}
            label={t(locale, 'settings.freeChannels.modelLabel')}
            locale={locale}
            loading={modelRefresh.loading}
            error={modelRefresh.error}
            canRefresh={canRefresh}
            onChange={(next) => patchProvider({ model: next })}
            onAddModel={(next) => patchProviderModelList({ add: next, select: next })}
            onRemoveModel={(removed, nextValue) =>
              patchProviderModelList({ remove: removed, select: nextValue })
            }
            onRefresh={() => void refreshModels()}
          />
        </div>
      </div>
    </div>
  );
}

function SpeechGenerationSettingsPanel({
  locale,
  settingsProfile,
  remoteProfile = false,
}: {
  locale: Locale;
  settingsProfile?: SettingsProfileOptions;
  remoteProfile?: boolean;
}) {
  const [settings, setSettings] = useState<SpeechGenerationSettings>(() =>
    loadSpeechGenerationSettings(settingsProfile),
  );
  const [category, setCategory] = useState<SpeechProviderCategory>('commercial');
  const [customDialogOpen, setCustomDialogOpen] = useState(false);

  const update = (patch: Partial<SpeechGenerationSettings>) => {
    const next = { ...settings, ...patch };
    saveSpeechGenerationSettings(next, settingsProfile);
    setSettings(next);
  };

  const providers = speechProviders(settings).filter(
    (provider) => !remoteProfile || !provider.local,
  );
  const providerOptions = providers.map((provider) => ({
    id: provider.id,
    label: provider.label,
    hint: `${speechProviderCategoryLabel(provider.category, locale)} · ${speechProviderStatusLabel(
      provider,
      settings,
      locale,
    )}`,
    group: speechProviderCategoryLabel(provider.category, locale),
  }));
  const activeProviders = providers.filter(
    (provider) => provider.category === category,
  );

  const addCustomProvider = (draft: CustomGenerationProviderDraft) => {
    const id = uniqueCustomId(
      createCustomSpeechProviderId(draft.name),
      settings.customProviders.map((provider) => provider.id),
    );
    const provider: CustomSpeechProviderDefinition = {
      id,
      label: draft.name,
      category,
      apiKind: 'generic-online-speech',
      defaultModel: draft.model,
      models: draft.models,
      defaultVoice: 'alloy',
      voices: ['alloy'],
      needsKey: true,
      local: false,
      defaultBaseUrl: draft.baseUrl,
      supportsBaseUrl: true,
      endpointPlaceholder: draft.baseUrl,
      keyPlaceholder: 'sk-...',
      note: '自定义 OpenAI-compatible 语音生成渠道。',
    };
    const next: SpeechGenerationSettings = {
      ...settings,
      preferredProviderId: id,
      customProviders: [...settings.customProviders, provider],
      providerKeys: { ...settings.providerKeys },
      providerAccountIds: { ...settings.providerAccountIds },
      providerBaseUrls: { ...settings.providerBaseUrls, [id]: draft.baseUrl },
      providerModels: { ...settings.providerModels, [id]: draft.model },
      providerModelLists: { ...settings.providerModelLists, [id]: draft.models },
      providerVoices: { ...settings.providerVoices },
    };
    if (draft.apiKey) next.providerKeys[id] = draft.apiKey;
    if (!saveSpeechGenerationSettings(next, settingsProfile)) return false;
    setSettings(loadSpeechGenerationSettings(settingsProfile));
    setCustomDialogOpen(false);
    return true;
  };

  const deleteCustomProvider = (id: SpeechProviderId) => {
    const providerKeys = { ...settings.providerKeys };
    const providerAccountIds = { ...settings.providerAccountIds };
    const providerBaseUrls = { ...settings.providerBaseUrls };
    const providerModels = { ...settings.providerModels };
    const providerModelLists = { ...settings.providerModelLists };
    const providerVoices = { ...settings.providerVoices };
    delete providerKeys[id];
    delete providerAccountIds[id];
    delete providerBaseUrls[id];
    delete providerModels[id];
    delete providerModelLists[id];
    delete providerVoices[id];
    const next: SpeechGenerationSettings = {
      ...settings,
      preferredProviderId:
        settings.preferredProviderId === id ? 'openai-tts' : settings.preferredProviderId,
      customProviders: settings.customProviders.filter((provider) => provider.id !== id),
      providerKeys,
      providerAccountIds,
      providerBaseUrls,
      providerModels,
      providerModelLists,
      providerVoices,
    };
    saveSpeechGenerationSettings(next, settingsProfile);
    setSettings(loadSpeechGenerationSettings(settingsProfile));
  };

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-lg font-semibold text-fg">
          {t(locale, 'settings.speechGeneration.title')}
        </h3>
        <p className="mt-1 text-xs leading-relaxed text-fg-faint">
          {t(locale, 'settings.speechGeneration.description')}
        </p>
      </div>

      <SettingRow
        title={t(locale, 'settings.speechGeneration.defaultProviderLabel')}
        description={t(locale, 'settings.speechGeneration.defaultProviderDesc')}
      >
        <div className="w-full min-w-[14rem]">
          <SelectControl
            value={settings.preferredProviderId}
            options={providerOptions}
            onChange={(id) =>
              update({ preferredProviderId: id as SpeechProviderId })
            }
            icon={<Volume2 size={15} strokeWidth={2.1} />}
          />
        </div>
      </SettingRow>

      <div>
        <div
          role="tablist"
          aria-orientation="horizontal"
          className={SETTINGS_INNER_TABLIST_CLASS}
        >
          {speechProviderCategoryOrder.map((item) => {
            const active = category === item;
            return (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setCategory(item)}
                className={cn(
                  SETTINGS_INNER_TAB_CLASS,
                  active
                    ? '-mb-px border-b-2 border-accent text-fg'
                    : 'text-fg-faint hover:text-fg',
                )}
              >
                {t(locale, speechProviderCategoryTitleKey(item))}
              </button>
            );
          })}
        </div>
      </div>

      <section role="tabpanel" className="rounded-lg border border-border bg-bg-alt p-4">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h4 className="text-sm font-semibold text-fg">
              {t(locale, speechProviderCategoryTitleKey(category))}
            </h4>
            <p className="text-xs leading-relaxed text-fg-faint">
              {t(locale, speechProviderCategoryDescKey(category))}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <StatusBadge state="default" label={String(activeProviders.length)} />
            <button
              type="button"
              onClick={() => setCustomDialogOpen(true)}
              className="inline-flex items-center gap-1.5 rounded border border-border bg-panel px-2.5 py-1 text-xs text-fg-dim transition-colors hover:border-accent hover:text-fg"
            >
              <Plus size={13} strokeWidth={2.2} />
              {t(locale, 'settings.models.add')}
            </button>
          </div>
        </div>
        <div className={SETTINGS_PROVIDER_GRID_CLASS}>
          {activeProviders.map((provider) => (
            <SpeechProviderSettingsRow
              key={provider.id}
              provider={provider}
              settings={settings}
              locale={locale}
              onChange={(next) => {
                saveSpeechGenerationSettings(next, settingsProfile);
                setSettings(next);
              }}
              onDelete={
                provider.custom ? () => deleteCustomProvider(provider.id) : undefined
              }
            />
          ))}
        </div>
      </section>
      {customDialogOpen && (
        <CustomGenerationProviderDialog
          locale={locale}
          title={t(locale, 'settings.models.addTitle')}
          modelScope="speech"
          defaultName={t(locale, 'settings.models.newProviderName')}
          defaultModel="custom-speech-model"
          endpointPlaceholder="https://api.example.com/v1/audio/speech"
          onClose={() => setCustomDialogOpen(false)}
          onSave={addCustomProvider}
        />
      )}
    </div>
  );
}

const speechProviderCategoryOrder: SpeechProviderCategory[] = ['commercial', 'free'];

function speechProviderCategoryTitleKey(
  category: SpeechProviderCategory,
): TranslationKey {
  return category === 'free'
    ? 'settings.speechGeneration.freeProviders'
    : 'settings.speechGeneration.commercialProviders';
}

function speechProviderCategoryDescKey(
  category: SpeechProviderCategory,
): TranslationKey {
  return category === 'free'
    ? 'settings.speechGeneration.freeProvidersDesc'
    : 'settings.speechGeneration.commercialProvidersDesc';
}

function speechProviderCategoryLabel(
  category: SpeechProviderCategory,
  locale: Locale,
): string {
  return t(
    locale,
    category === 'free'
      ? 'settings.speechGeneration.categoryFree'
      : 'settings.speechGeneration.categoryCommercial',
  );
}

function speechProviderCategoryBadgeClass(category: SpeechProviderCategory): string {
  return category === 'free'
    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
    : 'border-sky-500/30 bg-sky-500/10 text-sky-300';
}

function speechProviderStatusLabel(
  provider: SpeechProviderDefinition,
  settings: SpeechGenerationSettings,
  locale: Locale,
): string {
  if (speechProviderReady(provider.id, settings)) {
    return t(locale, 'settings.freeChannels.ready');
  }
  if (provider.local) return t(locale, 'settings.freeChannels.localNeedsSetup');
  if (provider.needsKey) return t(locale, 'settings.freeChannels.needsKey');
  return t(locale, 'settings.imageGeneration.noKeyRequired');
}
// __SPEECH_ROW__
function SpeechProviderSettingsRow({
  provider,
  settings,
  locale,
  onChange,
  onDelete,
}: {
  provider: SpeechProviderDefinition;
  settings: SpeechGenerationSettings;
  locale: Locale;
  onChange: (settings: SpeechGenerationSettings) => void;
  onDelete?: () => void;
}) {
  const [showKey, setShowKey] = useState(false);
  const [modelRefresh, setModelRefresh] = useState<{
    loading: boolean;
    error: string | null;
  }>({ loading: false, error: null });
  const keyProviderId = provider.keyProviderId ?? provider.id;
  const keyValue = settings.providerKeys[keyProviderId] ?? '';
  const accountIdValue = settings.providerAccountIds[provider.id] ?? '';
  const baseUrl = settings.providerBaseUrls[provider.id] ?? '';
  const effectiveBaseUrl = speechProviderBaseUrl(provider.id, settings);
  const model = speechProviderModel(provider.id, settings);
  const voice = speechProviderVoice(provider.id, settings);
  const ready = speechProviderReady(provider.id, settings);
  const KeyIcon = showKey ? EyeOff : Eye;

  const cacheKey = endpointModelCacheKey('speech', provider.id, effectiveBaseUrl);
  const modelOptions = uniqueStringOptions([
    ...(settings.providerModelLists[provider.id] ?? []),
    ...provider.models,
  ]);
  const voiceOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of [voice, ...provider.voices]) {
      const value = item?.trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
    return out;
  }, [voice, provider.voices]);
  const canRefresh =
    !!effectiveBaseUrl && (!provider.needsKey || keyValue.trim().length > 0);

  const patchProvider = (
    patch: Partial<{
      key: string;
      accountId: string;
      baseUrl: string;
      model: string;
      voice: string;
    }>,
  ) => {
    const next: SpeechGenerationSettings = {
      ...settings,
      providerKeys: { ...settings.providerKeys },
      providerAccountIds: { ...settings.providerAccountIds },
      providerBaseUrls: { ...settings.providerBaseUrls },
      providerModels: { ...settings.providerModels },
      providerModelLists: { ...settings.providerModelLists },
      providerVoices: { ...settings.providerVoices },
    };
    if (patch.key !== undefined) {
      const value = patch.key.trim();
      if (value) next.providerKeys[keyProviderId] = value;
      else delete next.providerKeys[keyProviderId];
    }
    if (patch.accountId !== undefined) {
      const value = patch.accountId.trim();
      if (value) next.providerAccountIds[provider.id] = value;
      else delete next.providerAccountIds[provider.id];
    }
    if (patch.baseUrl !== undefined) {
      const value = patch.baseUrl.trim();
      if (value) next.providerBaseUrls[provider.id] = value;
      else delete next.providerBaseUrls[provider.id];
    }
    if (patch.model !== undefined) {
      const value = patch.model.trim();
      let models = next.providerModelLists[provider.id] ?? [];
      models = persistCustomGenerationModelOption(models, model, provider.models);
      models = persistCustomGenerationModelOption(models, value, provider.models);
      if (models.length > 0) next.providerModelLists[provider.id] = models;
      else delete next.providerModelLists[provider.id];
      if (value) next.providerModels[provider.id] = value;
      else delete next.providerModels[provider.id];
    }
    if (patch.voice !== undefined) {
      const value = patch.voice.trim();
      if (value) next.providerVoices[provider.id] = value;
      else delete next.providerVoices[provider.id];
    }
    if (
      !speechProviderReady(next.preferredProviderId, next) &&
      speechProviderReady(provider.id, next)
    ) {
      next.preferredProviderId = provider.id;
    }
    onChange(next);
  };

  const patchProviderModelList = ({
    add,
    remove,
    select,
  }: {
    add?: string;
    remove?: string;
    select?: string;
  }) => {
    const next: SpeechGenerationSettings = {
      ...settings,
      providerModels: { ...settings.providerModels },
      providerModelLists: { ...settings.providerModelLists },
    };
    let models = settings.providerModelLists[provider.id] ?? [];
    if (add !== undefined) {
      models = uniqueStringOptions([add, ...models]);
    }
    if (remove !== undefined) {
      models = removeGenerationModelOption(models, remove);
    }
    if (models.length > 0) next.providerModelLists[provider.id] = models;
    else delete next.providerModelLists[provider.id];
    if (select !== undefined) {
      const value = select.trim();
      if (value) next.providerModels[provider.id] = value;
      else delete next.providerModels[provider.id];
    }
    onChange(next);
  };

  const refreshModels = async () => {
    if (!canRefresh || modelRefresh.loading) return;
    setModelRefresh({ loading: true, error: null });
    try {
      const result = await refreshEndpointModels({
        cacheKey,
        baseUrl: effectiveBaseUrl,
        apiKey: keyValue,
        fallback: [model, ...modelOptions],
      });
      setModelRefresh({ loading: false, error: result.error ?? null });
    } catch (err) {
      setModelRefresh({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
  // __SPEECH_ROW_RENDER__
  return (
    <div className="space-y-3 rounded-lg border border-border bg-bg-alt p-4">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-fg">{provider.label}</span>
            <span
              className={cn(
                'inline-flex shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium',
                speechProviderCategoryBadgeClass(provider.category),
              )}
            >
              {speechProviderCategoryLabel(provider.category, locale)}
            </span>
            <StatusBadge
              state={ready ? 'direct' : 'unavailable'}
              label={speechProviderStatusLabel(provider, settings, locale)}
            />
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-fg-faint">
            {provider.note}
          </p>
        </div>
        {provider.credentialUrl && (
          <button
            type="button"
            onClick={() => void openExternal(provider.credentialUrl as string)}
            className="inline-flex items-center gap-1.5 rounded border border-border bg-panel px-2.5 py-1 text-xs text-fg-dim transition-colors hover:border-accent hover:text-fg"
          >
            <ExternalLink size={13} strokeWidth={2.2} />
            {provider.local
              ? t(locale, 'dock.localModelDownload')
              : t(
                  locale,
                  ready
                    ? 'settings.freeChannels.manageKey'
                    : 'settings.freeChannels.getKey',
                )}
          </button>
        )}
        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            title={t(locale, 'settings.models.delete')}
            aria-label={t(locale, 'settings.models.delete')}
            className="inline-flex h-7 w-7 items-center justify-center rounded border border-rose-500/40 bg-rose-500/10 text-rose-300 transition-colors hover:bg-rose-500/20"
          >
            <Trash2 size={13} strokeWidth={2.2} />
          </button>
        )}
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {/* __SPEECH_ROW_FIELDS__ */}
        {provider.supportsBaseUrl && (
          <label className="block space-y-1">
            <span className="text-[11px] font-medium text-fg-dim">
              {t(locale, 'settings.models.baseUrl')}
            </span>
            <input
              type="text"
              value={baseUrl}
              onChange={(event) => patchProvider({ baseUrl: event.target.value })}
              onKeyDown={stopSettingsInputKeyPropagation}
              placeholder={effectiveBaseUrl || provider.endpointPlaceholder}
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-md border border-border bg-panel px-2.5 py-1.5 font-mono text-sm text-fg outline-none transition-colors focus:border-accent"
            />
          </label>
        )}

        {provider.needsKey && (
          <label className="block space-y-1">
            <span className="text-[11px] font-medium text-fg-dim">
              {provider.keyLabel ?? t(locale, 'settings.models.apiKey')}
            </span>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={keyValue}
                onChange={(event) => patchProvider({ key: event.target.value })}
                onKeyDown={stopSettingsInputKeyPropagation}
                onPaste={(event) => {
                  const nextValue = inputValueAfterPaste(event);
                  if (nextValue != null) patchProvider({ key: nextValue });
                }}
                placeholder={provider.keyPlaceholder ?? 'sk-...'}
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded-md border border-border bg-panel px-2.5 py-1.5 pr-14 font-mono text-sm text-fg outline-none transition-colors focus:border-accent"
              />
              <div className="absolute inset-y-0 right-1 flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  title={t(
                    locale,
                    showKey ? 'settings.models.hideKey' : 'settings.models.showKey',
                  )}
                  className="flex h-6 w-6 items-center justify-center rounded text-fg-faint transition-colors hover:text-fg"
                >
                  <KeyIcon size={13} strokeWidth={2} />
                </button>
                {keyValue && (
                  <button
                    type="button"
                    onClick={() => patchProvider({ key: '' })}
                    title={t(locale, 'settings.models.clear')}
                    className="flex h-6 w-6 items-center justify-center rounded text-fg-faint transition-colors hover:text-rose-300"
                  >
                    <Trash2 size={13} strokeWidth={2} />
                  </button>
                )}
              </div>
            </div>
          </label>
        )}
        {/* __SPEECH_ROW_FIELDS_B__ */}
        {provider.needsAccountId && (
          <label className="block space-y-1">
            <span className="text-[11px] font-medium text-fg-dim">
              {provider.accountIdLabel ??
                t(locale, 'settings.speechGeneration.accountIdLabel')}
            </span>
            <input
              type="text"
              value={accountIdValue}
              onChange={(event) => patchProvider({ accountId: event.target.value })}
              onKeyDown={stopSettingsInputKeyPropagation}
              placeholder={provider.accountIdPlaceholder ?? ''}
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-md border border-border bg-panel px-2.5 py-1.5 font-mono text-sm text-fg outline-none transition-colors focus:border-accent"
            />
          </label>
        )}

        <label className="block space-y-1">
          <span className="text-[11px] font-medium text-fg-dim">
            {t(locale, 'settings.speechGeneration.voiceLabel')}
          </span>
          <input
            type="text"
            value={voice}
            onChange={(event) => patchProvider({ voice: event.target.value })}
            onKeyDown={stopSettingsInputKeyPropagation}
            placeholder={provider.defaultVoice || 'voice id'}
            autoComplete="off"
            spellCheck={false}
            list={`speech-voices-${provider.id}`}
            className="w-full rounded-md border border-border bg-panel px-2.5 py-1.5 font-mono text-sm text-fg outline-none transition-colors focus:border-accent"
          />
          <datalist id={`speech-voices-${provider.id}`}>
            {voiceOptions.map((item) => (
              <option key={item} value={item} />
            ))}
          </datalist>
        </label>

        <div className="lg:col-span-2">
          <EditableModelSelect
            cacheKey={cacheKey}
            builtins={modelOptions}
            value={model}
            label={t(locale, 'settings.freeChannels.modelLabel')}
            locale={locale}
            loading={modelRefresh.loading}
            error={modelRefresh.error}
            canRefresh={canRefresh}
            onChange={(next) => patchProvider({ model: next })}
            onAddModel={(next) => patchProviderModelList({ add: next, select: next })}
            onRemoveModel={(removed, nextValue) =>
              patchProviderModelList({ remove: removed, select: nextValue })
            }
            onRefresh={() => void refreshModels()}
          />
        </div>
      </div>
    </div>
  );
}
export function SpriteGenerationSettingsPanel({
  locale,
  embedded = false,
  settingsProfile,
}: {
  locale: Locale;
  embedded?: boolean;
  settingsProfile?: SettingsProfileOptions;
}) {
  const [settings, setSettings] = useState<SpriteGenerationSettings>(() =>
    loadSpriteGenerationSettings(settingsProfile),
  );

  const update = (patch: Partial<SpriteGenerationSettings>) => {
    const next = { ...settings, ...patch };
    saveSpriteGenerationSettings(next, settingsProfile);
    setSettings(loadSpriteGenerationSettings(settingsProfile));
  };

  return (
    <div className="space-y-5">
      {!embedded && (
        <div>
          <h3 className="text-lg font-semibold text-fg">
            {t(locale, 'settings.spriteGeneration.title')}
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-fg-faint">
            {t(locale, 'settings.spriteGeneration.description')}
          </p>
        </div>
      )}

      <div className="grid gap-3 rounded-lg border border-border bg-bg-alt p-4 md:grid-cols-2">
        <label className="block space-y-1">
          <span className="text-[11px] font-medium text-fg-dim">
            {t(locale, 'settings.spriteGeneration.frameCountLabel')}
          </span>
          <input
            type="number"
            min={1}
            max={64}
            value={settings.defaultFrameCount}
            onChange={(event) =>
              update({ defaultFrameCount: Number(event.currentTarget.value) })
            }
            className="w-full rounded-md border border-border bg-panel px-2.5 py-1.5 text-sm text-fg outline-none transition-colors focus:border-accent"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-[11px] font-medium text-fg-dim">
            {t(locale, 'settings.spriteGeneration.frameSizeLabel')}
          </span>
          <input
            type="number"
            min={16}
            max={512}
            step={16}
            value={settings.defaultFrameSize}
            onChange={(event) =>
              update({ defaultFrameSize: Number(event.currentTarget.value) })
            }
            className="w-full rounded-md border border-border bg-panel px-2.5 py-1.5 text-sm text-fg outline-none transition-colors focus:border-accent"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-[11px] font-medium text-fg-dim">
            {t(locale, 'settings.spriteGeneration.sheetPresetLabel')}
          </span>
          <select
            value={settings.sheetPreset}
            onChange={(event) =>
              update(spriteSheetPresetPatch(event.currentTarget.value as SpriteSheetPreset))
            }
            className="h-[35px] w-full rounded-md border border-border bg-panel px-2 text-sm text-fg outline-none transition-colors focus:border-accent"
          >
            {spriteSheetPresetOptions.map((preset) => (
              <option key={preset} value={preset}>
                {spriteSheetPresetLabel(preset, locale)}
              </option>
            ))}
          </select>
        </label>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="block space-y-1">
            <span className="text-[11px] font-medium text-fg-dim">
              {t(locale, 'settings.spriteGeneration.sheetRowsLabel')}
            </span>
            <input
              type="number"
              min={1}
              max={8}
              value={settings.sheetRows}
              disabled={settings.sheetPreset !== 'custom'}
              onChange={(event) =>
                update({ sheetRows: Number(event.currentTarget.value) })
              }
              className="w-full rounded-md border border-border bg-panel px-2.5 py-1.5 text-sm text-fg outline-none transition-colors focus:border-accent disabled:cursor-not-allowed disabled:opacity-55"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[11px] font-medium text-fg-dim">
              {t(locale, 'settings.spriteGeneration.sheetColumnsLabel')}
            </span>
            <input
              type="number"
              min={1}
              max={8}
              value={settings.sheetColumns}
              disabled={settings.sheetPreset !== 'custom'}
              onChange={(event) =>
                update({ sheetColumns: Number(event.currentTarget.value) })
              }
              className="w-full rounded-md border border-border bg-panel px-2.5 py-1.5 text-sm text-fg outline-none transition-colors focus:border-accent disabled:cursor-not-allowed disabled:opacity-55"
            />
          </label>
        </div>
        <label className="block space-y-1">
          <span className="text-[11px] font-medium text-fg-dim">
            {t(locale, 'settings.spriteGeneration.chromaKeyLabel')}
          </span>
          <div className="flex h-[35px] items-center gap-2 rounded-md border border-border bg-panel px-2.5">
            <input
              type="color"
              value={settings.chromaKey}
              onChange={(event) => update({ chromaKey: event.currentTarget.value })}
              className="h-5 w-8 cursor-pointer border-0 bg-transparent p-0"
            />
            <span className="font-mono text-xs text-fg">{settings.chromaKey}</span>
          </div>
        </label>
        <label className="block space-y-1">
          <span className="text-[11px] font-medium text-fg-dim">
            {t(locale, 'settings.spriteGeneration.frameAnchorLabel')}
          </span>
          <select
            value={settings.frameAnchor}
            onChange={(event) =>
              update({ frameAnchor: event.currentTarget.value as SpriteFrameAnchor })
            }
            className="h-[35px] w-full rounded-md border border-border bg-panel px-2 text-sm text-fg outline-none transition-colors focus:border-accent"
          >
            {spriteFrameAnchorOptions.map((anchor) => (
              <option key={anchor} value={anchor}>
                {spriteFrameAnchorLabel(anchor, locale)}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1">
          <span className="text-[11px] font-medium text-fg-dim">
            {t(locale, 'settings.spriteGeneration.componentModeLabel')}
          </span>
          <select
            value={settings.componentMode}
            onChange={(event) =>
              update({
                componentMode: event.currentTarget.value as SpriteComponentMode,
              })
            }
            className="h-[35px] w-full rounded-md border border-border bg-panel px-2 text-sm text-fg outline-none transition-colors focus:border-accent"
          >
            {spriteComponentModeOptions.map((mode) => (
              <option key={mode} value={mode}>
                {spriteComponentModeLabel(mode, locale)}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1">
          <span className="text-[11px] font-medium text-fg-dim">
            {t(locale, 'settings.spriteGeneration.fitScaleLabel')}
          </span>
          <input
            type="number"
            min={0.5}
            max={1}
            step={0.01}
            value={settings.fitScale}
            onChange={(event) =>
              update({ fitScale: Number(event.currentTarget.value) })
            }
            className="w-full rounded-md border border-border bg-panel px-2.5 py-1.5 text-sm text-fg outline-none transition-colors focus:border-accent"
          />
        </label>
        <SwitchLine
          label={t(locale, 'settings.spriteGeneration.removeBackgroundLabel')}
          checked={settings.removeBackground}
          onChange={(removeBackground) => update({ removeBackground })}
        />
        <SwitchLine
          label={t(locale, 'settings.spriteGeneration.autoTrimLabel')}
          checked={settings.autoTrim}
          onChange={(autoTrim) => update({ autoTrim })}
        />
        <SwitchLine
          label={t(locale, 'settings.spriteGeneration.alignFramesLabel')}
          checked={settings.alignFrames}
          onChange={(alignFrames) => update({ alignFrames })}
        />
        <SwitchLine
          label={t(locale, 'settings.spriteGeneration.packSpritesheetLabel')}
          checked={settings.packSpritesheet}
          onChange={(packSpritesheet) => update({ packSpritesheet })}
        />
        <SwitchLine
          label={t(locale, 'settings.spriteGeneration.rejectEdgeTouchLabel')}
          checked={settings.rejectEdgeTouch}
          onChange={(rejectEdgeTouch) => update({ rejectEdgeTouch })}
        />
      </div>

    </div>
  );
}

const spriteSheetPresetOptions: SpriteSheetPreset[] = [
  'auto',
  '2x2',
  '2x3',
  '4x4',
  'custom',
];

const spriteFrameAnchorOptions: SpriteFrameAnchor[] = [
  'feet',
  'bottom',
  'center',
];

const spriteComponentModeOptions: SpriteComponentMode[] = [
  'largest',
  'all',
];

function spriteSheetPresetPatch(
  sheetPreset: SpriteSheetPreset,
): Partial<SpriteGenerationSettings> {
  switch (sheetPreset) {
    case '2x2':
      return { sheetPreset, sheetRows: 2, sheetColumns: 2, defaultFrameCount: 4 };
    case '2x3':
      return { sheetPreset, sheetRows: 2, sheetColumns: 3, defaultFrameCount: 6 };
    case '4x4':
      return { sheetPreset, sheetRows: 4, sheetColumns: 4, defaultFrameCount: 16 };
    default:
      return { sheetPreset };
  }
}

function spriteSheetPresetLabel(preset: SpriteSheetPreset, locale: Locale): string {
  if (preset === 'auto') return locale === 'zh-CN' ? '自动网格' : 'Auto grid';
  if (preset === 'custom') return locale === 'zh-CN' ? '自定义' : 'Custom';
  return preset;
}

function spriteFrameAnchorLabel(anchor: SpriteFrameAnchor, locale: Locale): string {
  if (anchor === 'feet') return locale === 'zh-CN' ? '脚底锚点' : 'Feet anchor';
  if (anchor === 'bottom') return locale === 'zh-CN' ? '底部锚点' : 'Bottom anchor';
  return locale === 'zh-CN' ? '中心锚点' : 'Center anchor';
}

function spriteComponentModeLabel(mode: SpriteComponentMode, locale: Locale): string {
  if (mode === 'largest') return locale === 'zh-CN' ? '最大主体' : 'Largest subject';
  return locale === 'zh-CN' ? '保留全部' : 'Keep all';
}

function SwitchLine({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 rounded-md border border-border-soft bg-panel px-2.5 py-2 text-xs text-fg-dim">
      <span>{label}</span>
      <SwitchControl checked={checked} onChange={onChange} />
    </label>
  );
}

function uiDesignChannelBadgeClass(category: UiDesignChannelCategory): string {
  return category === 'free-open'
    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
    : 'border-sky-500/30 bg-sky-500/10 text-sky-300';
}

function uiDesignChannelStatus(
  channel: UiDesignChannelDefinition,
  settings: UiDesignChannelSettings,
  locale: Locale,
): { label: string; className: string } {
  if (uiDesignChannelReady(channel.id, settings)) {
    return {
      label:
        channel.needsKey || channel.requiresCommand
          ? locale === 'zh-CN'
            ? '已配置'
            : 'Configured'
          : locale === 'zh-CN'
            ? '可用'
            : 'Ready',
      className: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
    };
  }
  if (channel.needsKey && !settings.channelKeys[channel.id]?.trim()) {
    return {
      label: locale === 'zh-CN' ? '待填 Key' : 'Needs key',
      className: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
    };
  }
  if (channel.requiresCommand && !uiDesignChannelCommand(channel.id, settings)) {
    return {
      label: locale === 'zh-CN' ? '待配置路径' : 'Needs path',
      className: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
    };
  }
  return {
    label: locale === 'zh-CN' ? '待配置' : 'Needs setup',
    className: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  };
}

function UiDesignChannelSettingsPanel({
  locale,
  settingsProfile,
}: {
  locale: Locale;
  settingsProfile?: SettingsProfileOptions;
}) {
  const [settings, setSettings] = useState<UiDesignChannelSettings>(() =>
    loadUiDesignChannelSettings(settingsProfile),
  );
  const [category, setCategory] = useState<UiDesignChannelCategory>(() =>
    uiDesignChannelById(
      loadUiDesignChannelSettings(settingsProfile).preferredChannelId,
    ).category,
  );

  const persist = useCallback((next: UiDesignChannelSettings) => {
    saveUiDesignChannelSettings(next, settingsProfile);
    setSettings(loadUiDesignChannelSettings(settingsProfile));
  }, [settingsProfile]);

  const defaultChannel = uiDesignChannelById(settings.preferredChannelId);
  const activeChannels = UI_DESIGN_CHANNELS.filter(
    (channel) => channel.category === category,
  );

  const setDefaultChannel = (channelId: UiDesignChannelId) => {
    const channel = uiDesignChannelById(channelId);
    setCategory(channel.category);
    persist({ ...settings, preferredChannelId: channelId });
  };

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h3 className="text-lg font-semibold text-fg">
          {locale === 'zh-CN' ? 'UI 渠道' : 'UI channels'}
        </h3>
        <p className="text-xs leading-relaxed text-fg-faint">
          {locale === 'zh-CN'
            ? '配置游戏 UI 设计任务使用的全局默认设计工具或协作平台。/ui-mode-start 使用这里的设置。'
            : 'Configure the global default design tool or collaboration channel used by UI design tasks. /ui-mode-start uses these settings.'}
        </p>
      </header>

      <SettingRow
        title={locale === 'zh-CN' ? '默认 UI 渠道' : 'Default UI channel'}
        description={
          locale === 'zh-CN'
            ? '商用与免费开源渠道共用一个全局默认。'
            : 'Commercial and free/open-source channels share one global default.'
        }
      >
        <div className="w-full min-w-[14rem]">
          <SelectControl
            value={settings.preferredChannelId}
            options={UI_DESIGN_CHANNELS.map((channel) => ({
              id: channel.id,
              label: channel.label,
              hint: uiDesignChannelCategoryLabel(channel.category, locale),
              group: uiDesignChannelCategoryLabel(channel.category, locale),
            }))}
            onChange={(id) => setDefaultChannel(id as UiDesignChannelId)}
            icon={<Palette size={15} strokeWidth={2.1} />}
          />
          <p className="mt-1 text-[11px] text-fg-faint">
            {locale === 'zh-CN'
              ? `当前默认：${defaultChannel.label}（${uiDesignChannelCategoryLabel(defaultChannel.category, locale)}）`
              : `Current default: ${defaultChannel.label} (${uiDesignChannelCategoryLabel(defaultChannel.category, locale)})`}
          </p>
        </div>
      </SettingRow>

      <div>
        <div
          role="tablist"
          aria-orientation="horizontal"
          className={SETTINGS_INNER_TABLIST_CLASS}
        >
          {(['commercial', 'free-open'] as const).map((item) => {
            const active = category === item;
            return (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setCategory(item)}
                className={cn(
                  SETTINGS_INNER_TAB_CLASS,
                  active
                    ? '-mb-px border-b-2 border-accent text-fg'
                    : 'text-fg-faint hover:text-fg',
                )}
              >
                {item === 'commercial'
                  ? locale === 'zh-CN'
                    ? '商用渠道'
                    : 'Commercial'
                  : locale === 'zh-CN'
                    ? '免费开源渠道'
                    : 'Free / open source'}
              </button>
            );
          })}
        </div>
      </div>

      <section role="tabpanel" className="rounded-lg border border-border bg-bg-alt p-4">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h4 className="text-sm font-semibold text-fg">
              {uiDesignChannelCategoryLabel(category, locale)}
            </h4>
            <p className="text-xs leading-relaxed text-fg-faint">
              {category === 'commercial'
                ? locale === 'zh-CN'
                  ? '生产协作优先，适合 Figma 文件、Photoshop 视觉资产和可交付 UI 规范。'
                  : 'Production collaboration first: Figma files, Photoshop visual assets, and deliverable UI specs.'
                : locale === 'zh-CN'
                  ? '免费和开源优先，适合 Pencil 原型、Penpot 协作、GIMP/Inkscape 图形资产。'
                  : 'Free/open-source first: Pencil prototypes, Penpot collaboration, and GIMP/Inkscape assets.'}
            </p>
          </div>
          <StatusBadge state="default" label={String(activeChannels.length)} />
        </div>

        <div className={SETTINGS_PROVIDER_GRID_CLASS}>
          {activeChannels.map((channel) => (
            <UiDesignChannelCard
              key={channel.id}
              channel={channel}
              isDefault={settings.preferredChannelId === channel.id}
              settings={settings}
              locale={locale}
              onDefault={() => setDefaultChannel(channel.id)}
              onChange={persist}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function UiDesignChannelCard({
  channel,
  isDefault,
  settings,
  locale,
  onDefault,
  onChange,
}: {
  channel: UiDesignChannelDefinition;
  isDefault: boolean;
  settings: UiDesignChannelSettings;
  locale: Locale;
  onDefault: () => void;
  onChange: (settings: UiDesignChannelSettings) => void;
}) {
  const [showKey, setShowKey] = useState(false);
  const keyValue = settings.channelKeys[channel.id] ?? '';
  const baseUrl = settings.channelBaseUrls[channel.id] ?? '';
  const command = settings.channelCommands[channel.id] ?? '';
  const exportFormat = uiDesignChannelExportFormat(channel.id, settings);
  const effectiveBaseUrl = uiDesignChannelBaseUrl(channel.id, settings);
  const status = uiDesignChannelStatus(channel, settings, locale);
  const KeyIcon = showKey ? EyeOff : Eye;
  const externalLinks =
    channel.downloadLinks && channel.downloadLinks.length > 0
      ? channel.downloadLinks
      : channel.credentialUrl
        ? [
            {
              label: channel.needsKey
                ? locale === 'zh-CN'
                  ? '获取 Key'
                  : 'Get key'
                : locale === 'zh-CN'
                  ? '打开官网'
                  : 'Open website',
              url: channel.credentialUrl,
            },
          ]
        : [];

  const patchChannel = (
    patch: Partial<{
      key: string;
      baseUrl: string;
      command: string;
      exportFormat: string;
    }>,
  ) => {
    const next: UiDesignChannelSettings = {
      ...settings,
      channelKeys: { ...settings.channelKeys },
      channelBaseUrls: { ...settings.channelBaseUrls },
      channelCommands: { ...settings.channelCommands },
      channelExportFormats: { ...settings.channelExportFormats },
    };
    if (patch.key !== undefined) {
      const value = patch.key.trim();
      if (value) next.channelKeys[channel.id] = value;
      else delete next.channelKeys[channel.id];
    }
    if (patch.baseUrl !== undefined) {
      const value = patch.baseUrl.trim();
      if (value) next.channelBaseUrls[channel.id] = value;
      else delete next.channelBaseUrls[channel.id];
    }
    if (patch.command !== undefined) {
      const value = patch.command.trim();
      if (value) next.channelCommands[channel.id] = value;
      else delete next.channelCommands[channel.id];
    }
    if (patch.exportFormat !== undefined) {
      const value = patch.exportFormat.trim();
      if (value && channel.exportFormats.includes(value)) {
        next.channelExportFormats[channel.id] = value;
      } else {
        delete next.channelExportFormats[channel.id];
      }
    }
    onChange(next);
  };

  return (
    <article className="space-y-3 rounded-lg border border-border bg-bg-alt p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-fg">{channel.label}</span>
            <span
              className={cn(
                'inline-flex shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium',
                uiDesignChannelBadgeClass(channel.category),
              )}
            >
              {uiDesignChannelCategoryLabel(channel.category, locale)}
            </span>
            <span
              className={cn(
                'inline-flex shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium',
                status.className,
              )}
            >
              {status.label}
            </span>
            {isDefault ? (
              <span className="inline-flex shrink-0 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent">
                {locale === 'zh-CN' ? '默认' : 'Default'}
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-fg-faint">
            {channel.note}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {!isDefault ? (
            <button
              type="button"
              onClick={onDefault}
              className="inline-flex items-center gap-1.5 rounded border border-border bg-panel px-2.5 py-1 text-xs text-fg-dim transition-colors hover:border-accent hover:text-fg"
            >
              <Check size={13} />
              {locale === 'zh-CN' ? '设为默认' : 'Set as default'}
            </button>
          ) : null}
          {externalLinks.map((link) => (
            <button
              key={link.url}
              type="button"
              onClick={() => void openExternal(link.url)}
              className="inline-flex items-center gap-1.5 rounded border border-border bg-panel px-2.5 py-1 text-xs text-fg-dim transition-colors hover:border-accent hover:text-fg"
            >
              {channel.downloadLinks && channel.downloadLinks.length > 0 ? (
                <DownloadCloud size={13} strokeWidth={2.2} />
              ) : (
                <ExternalLink size={13} strokeWidth={2.2} />
              )}
              {link.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {channel.supportsBaseUrl ? (
          <label className="block space-y-1">
            <span className="text-[11px] font-medium text-fg-dim">Base URL</span>
            <input
              type="text"
              value={baseUrl}
              onChange={(event) => patchChannel({ baseUrl: event.target.value })}
              onKeyDown={stopSettingsInputKeyPropagation}
              placeholder={effectiveBaseUrl || channel.endpointPlaceholder}
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-md border border-border bg-panel px-2.5 py-1.5 font-mono text-sm text-fg outline-none transition-colors focus:border-accent"
            />
          </label>
        ) : null}

        {channel.supportsKey ? (
          <label className="block space-y-1">
            <span className="text-[11px] font-medium text-fg-dim">
              {channel.keyLabel ?? 'API Key'}
            </span>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={keyValue}
                onChange={(event) => patchChannel({ key: event.target.value })}
                onKeyDown={stopSettingsInputKeyPropagation}
                placeholder={
                  channel.keyPlaceholder ??
                  (locale === 'zh-CN' ? '粘贴 API Key / Token' : 'Paste API key / token')
                }
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded-md border border-border bg-panel px-2.5 py-1.5 pr-14 font-mono text-sm text-fg outline-none transition-colors focus:border-accent"
              />
              <div className="absolute inset-y-0 right-1 flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => setShowKey((value) => !value)}
                  title={showKey ? t(locale, 'settings.models.hideKey') : t(locale, 'settings.models.showKey')}
                  className="flex h-6 w-6 items-center justify-center rounded text-fg-faint transition-colors hover:text-fg"
                >
                  <KeyIcon size={13} strokeWidth={2} />
                </button>
                {keyValue ? (
                  <button
                    type="button"
                    onClick={() => patchChannel({ key: '' })}
                    title={t(locale, 'settings.models.clear')}
                    className="flex h-6 w-6 items-center justify-center rounded text-fg-faint transition-colors hover:text-rose-300"
                  >
                    <Trash2 size={13} strokeWidth={2} />
                  </button>
                ) : null}
              </div>
            </div>
          </label>
        ) : null}

        {channel.supportsCommand ? (
          <label className="block space-y-1 lg:col-span-2">
            <span className="text-[11px] font-medium text-fg-dim">
              {locale === 'zh-CN' ? '本地命令 / 工具路径' : 'Local command / tool path'}
            </span>
            <input
              type="text"
              value={command}
              onChange={(event) => patchChannel({ command: event.target.value })}
              onKeyDown={stopSettingsInputKeyPropagation}
              placeholder={channel.commandPlaceholder}
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-md border border-border bg-panel px-2.5 py-1.5 font-mono text-sm text-fg outline-none transition-colors focus:border-accent"
            />
          </label>
        ) : null}

        <label
          className={cn(
            'block space-y-1',
            channel.supportsBaseUrl || channel.supportsKey ? 'lg:col-span-2' : '',
          )}
        >
          <span className="text-[11px] font-medium text-fg-dim">
            {locale === 'zh-CN' ? '默认导出格式' : 'Default export format'}
          </span>
          <select
            value={exportFormat}
            onChange={(event) => patchChannel({ exportFormat: event.target.value })}
            className="h-[35px] w-full rounded-md border border-border bg-panel px-2 font-mono text-xs text-fg outline-none transition-colors focus:border-accent"
          >
            {channel.exportFormats.map((format) => (
              <option key={format} value={format}>
                {format}
              </option>
            ))}
          </select>
        </label>
      </div>
    </article>
  );
}

type MeshLibraryInnerTab = 'enabled' | 'repository';

function MeshLibrarySettingsPanel({
  locale,
  settingsProfile,
}: {
  locale: Locale;
  settingsProfile?: SettingsProfileOptions;
}) {
  const [settings, setSettings] = useState<MeshLibraryAccountSettings>(() =>
    loadMeshLibrarySettings(settingsProfile),
  );
  const [innerTab, setInnerTab] = useState<MeshLibraryInnerTab>('enabled');
  const [query, setQuery] = useState('');
  const [customDialogOpen, setCustomDialogOpen] = useState(false);

  const persist = useCallback((next: MeshLibraryAccountSettings) => {
    saveMeshLibrarySettings(next, settingsProfile);
    setSettings(loadMeshLibrarySettings(settingsProfile));
  }, [settingsProfile]);

  const libraries = useMemo(() => meshLibraries(settings), [settings]);
  const usableLibraries = libraries.filter((library) =>
    settings.enabledIds.includes(library.id) && meshLibraryUsable(library.id, settings),
  );
  const pendingLibraries = libraries.filter(
    (library) =>
      settings.enabledIds.includes(library.id) &&
      !meshLibraryUsable(library.id, settings),
  );
  const enabledCount = settings.enabledIds.length;
  const usableCount = usableLibraries.length;
  const filteredRepository = libraries.filter((library) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return `${library.label} ${library.note} ${library.category} ${library.searchKind}`
      .toLowerCase()
      .includes(q);
  });

  const toggleLibrary = (id: MeshLibraryId, enabled: boolean) => {
    const enabledIds = enabled
      ? Array.from(new Set([...settings.enabledIds, id]))
      : settings.enabledIds.filter((item) => item !== id);
    persist({ ...settings, enabledIds });
  };

  const setKey = (id: MeshLibraryId, value: string) => {
    const apiKeys = { ...settings.apiKeys };
    const trimmed = value.trim();
    if (trimmed) apiKeys[id] = trimmed;
    else delete apiKeys[id];
    persist({ ...settings, apiKeys });
  };

  const addCustomLibrary = (draft: {
    name: string;
    homepageUrl: string;
    token: string;
  }) => {
    let id = createCustomMeshLibraryId(draft.name);
    const used = new Set(libraries.map((library) => library.id));
    let suffix = 2;
    while (used.has(id)) {
      id = `${createCustomMeshLibraryId(draft.name)}-${suffix}` as typeof id;
      suffix += 1;
    }
    const library: CustomMeshLibraryDefinition = {
      id,
      label: draft.name.trim() || customMeshLibraryName(draft.homepageUrl, '自定义模型库'),
      category: 'marketplace',
      searchKind: 'link-out',
      needsKey: !!draft.token.trim(),
      supportsDownload: false,
      homepageUrl: customMeshHomepageUrl(draft.homepageUrl),
      credentialUrl: customMeshHomepageUrl(draft.homepageUrl),
      keyLabel: 'Token / 账号备注',
      keyPlaceholder: '可选；记录账号、Token 或授权备注',
      searchUrlTemplate: customMeshSearchUrlTemplate(draft.homepageUrl),
      note: '自定义在线模型库渠道（深链搜索）。',
    };
    const apiKeys = { ...settings.apiKeys };
    if (draft.token.trim()) apiKeys[id] = draft.token.trim();
    persist({
      ...settings,
      customLibraries: [...settings.customLibraries, library],
      enabledIds: Array.from(new Set([...settings.enabledIds, id])),
      apiKeys,
    });
    setCustomDialogOpen(false);
  };

  const deleteCustomLibrary = (id: MeshLibraryId) => {
    const apiKeys = { ...settings.apiKeys };
    delete apiKeys[id];
    persist({
      ...settings,
      customLibraries: settings.customLibraries.filter((library) => library.id !== id),
      enabledIds: settings.enabledIds.filter((item) => item !== id),
      apiKeys,
    });
  };

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h3 className="text-lg font-semibold text-fg">
          {locale === 'zh-CN' ? '在线模型库' : 'Online model libraries'}
        </h3>
        <p className="text-xs leading-relaxed text-fg-faint">
          {locale === 'zh-CN'
            ? '配置 /mesh-search 使用的全局在线 3D 模型库。真正可搜索或可下载的库会出现在“已启用”里。'
            : 'Configure the global online 3D model libraries used by /mesh-search. Libraries that can actually search or download appear under Enabled.'}
        </p>
        <p className="text-[11px] text-fg-faint">
          {locale === 'zh-CN'
            ? `可用 ${usableCount} 个 · 已开启 ${enabledCount} 个 · 仓库共 ${libraries.length} 个`
            : `${usableCount} usable · ${enabledCount} enabled · ${libraries.length} in registry`}
        </p>
      </header>

      <div
        role="tablist"
        aria-orientation="horizontal"
        className={SETTINGS_INNER_TABLIST_CLASS}
      >
        {[
          { id: 'enabled' as const, label: locale === 'zh-CN' ? '已启用' : 'Enabled', count: usableCount },
          { id: 'repository' as const, label: locale === 'zh-CN' ? '仓库' : 'Registry', count: libraries.length },
        ].map((item) => {
          const active = innerTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setInnerTab(item.id)}
              className={cn(
                SETTINGS_INNER_TAB_CLASS,
                active
                  ? '-mb-px border-b-2 border-accent text-fg'
                  : 'text-fg-faint hover:text-fg',
              )}
            >
              {item.label}
              <span
                className={cn(
                  'ml-1.5 rounded-full px-1.5 py-0.5 text-[10px]',
                  active ? 'bg-accent/20 text-accent' : 'bg-bg-alt text-fg-faint',
                )}
              >
                {item.count}
              </span>
            </button>
          );
        })}
      </div>

      {innerTab === 'enabled' ? (
        <MeshLibraryEnabledTab
          usableLibraries={usableLibraries}
          pendingLibraries={pendingLibraries}
          settings={settings}
          locale={locale}
          onToggle={toggleLibrary}
          onKeyChange={setKey}
          onAddLibrary={() => setCustomDialogOpen(true)}
          onDeleteCustomLibrary={deleteCustomLibrary}
          onBrowseRepository={() => setInnerTab('repository')}
        />
      ) : (
        <MeshLibraryRepositoryTab
          libraries={filteredRepository}
          settings={settings}
          locale={locale}
          query={query}
          onQueryChange={setQuery}
          onToggle={toggleLibrary}
          onKeyChange={setKey}
          onAddLibrary={() => setCustomDialogOpen(true)}
          onDeleteCustomLibrary={deleteCustomLibrary}
        />
      )}

      <div className="grid gap-2 rounded-lg border border-border bg-bg-alt p-3 sm:grid-cols-2">
        <label className="flex items-center justify-between gap-2 rounded-md border border-border-soft bg-panel px-3 py-2">
          <span className="text-xs font-semibold text-fg">
            {locale === 'zh-CN' ? '自动下载可下载结果' : 'Auto-download downloadable results'}
          </span>
          <input
            type="checkbox"
            checked={settings.autoDownload}
            onChange={(event) =>
              persist({ ...settings, autoDownload: event.currentTarget.checked })
            }
            className="h-4 w-4 shrink-0 accent-accent"
          />
        </label>
        <label className="flex items-center justify-between gap-2 rounded-md border border-border-soft bg-panel px-3 py-2">
          <span className="text-xs font-semibold text-fg">
            {locale === 'zh-CN' ? '每个库返回上限' : 'Per-library result limit'}
          </span>
          <input
            type="number"
            min={1}
            max={24}
            value={settings.perLibraryLimit}
            onChange={(event) =>
              persist({
                ...settings,
                perLibraryLimit: Number(event.currentTarget.value) || 6,
              })
            }
            className="w-16 rounded-md border border-border bg-panel px-2 py-1 text-xs text-fg focus:border-accent focus:outline-none"
          />
        </label>
      </div>

      {customDialogOpen ? (
        <CustomMeshLibraryDialog
          locale={locale}
          onClose={() => setCustomDialogOpen(false)}
          onSave={addCustomLibrary}
        />
      ) : null}
    </div>
  );
}

function MeshLibraryCard({
  library,
  settings,
  locale,
  onToggle,
  onKeyChange,
  onDelete,
}: {
  library: MeshLibraryDefinition;
  settings: MeshLibraryAccountSettings;
  locale: Locale;
  onToggle: (enabled: boolean) => void;
  onKeyChange: (value: string) => void;
  onDelete?: () => void;
}) {
  const enabled = settings.enabledIds.includes(library.id);
  const ready = meshLibraryReady(library.id, settings);
  const usability = meshLibraryUsability(library.id, settings);
  const keyValue = settings.apiKeys[library.id] ?? '';
  const searchKindLabel =
    library.searchKind === 'public-api'
      ? locale === 'zh-CN'
        ? '免费 API'
        : 'Free API'
      : library.searchKind === 'api-key'
        ? locale === 'zh-CN'
          ? 'API Key 搜索'
          : 'API-key search'
        : locale === 'zh-CN'
          ? '深链搜索页'
          : 'Deep-link search';

  return (
    <section className="flex flex-col gap-2.5 rounded-lg border border-border bg-bg-alt p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-semibold text-fg">{library.label}</span>
            <span className="shrink-0 rounded border border-border-soft bg-panel px-1.5 py-0.5 text-[10px] text-fg-faint">
              {meshLibraryCategoryLabel(library.category, locale)}
            </span>
          </div>
          <span className="mt-1 block max-h-12 overflow-hidden text-xs leading-snug text-fg-faint">
            {library.note}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => void openExternal(library.homepageUrl)}
            title={locale === 'zh-CN' ? '打开来源' : 'Open source'}
            aria-label={locale === 'zh-CN' ? '打开来源' : 'Open source'}
            className="flex h-7 w-7 items-center justify-center rounded border border-border-soft bg-panel text-fg-faint hover:border-accent hover:text-fg"
          >
            <ExternalLink size={13} />
          </button>
          {onDelete ? (
            <button
              type="button"
              onClick={onDelete}
              title={locale === 'zh-CN' ? '删除' : 'Delete'}
              aria-label={locale === 'zh-CN' ? '删除' : 'Delete'}
              className="flex h-7 w-7 items-center justify-center rounded border border-rose-500/40 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20"
            >
              <Trash2 size={13} />
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1">
        <span className="rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent">
          {searchKindLabel}
        </span>
        {usability === 'usable' ? (
          <span className="rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-300">
            {locale === 'zh-CN' ? '真正可用' : 'Fully usable'}
          </span>
        ) : usability === 'needs-key' ? (
          <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300">
            {locale === 'zh-CN' ? '待配置 Key' : 'Needs key'}
          </span>
        ) : (
          <span className="rounded border border-border-soft bg-panel px-1.5 py-0.5 text-[10px] text-fg-faint">
            {locale === 'zh-CN' ? '仅深链浏览' : 'Deep-link only'}
          </span>
        )}
        {library.supportsDownload ? (
          <span className="rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-300">
            {locale === 'zh-CN' ? '可直接下载' : 'Direct download'}
          </span>
        ) : (
          <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300">
            {locale === 'zh-CN' ? '账号内下载' : 'In-account download'}
          </span>
        )}
        {library.needsKey ? (
          <span
            className={cn(
              'rounded border px-1.5 py-0.5 text-[10px]',
              ready
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                : 'border-amber-500/40 bg-amber-500/10 text-amber-300',
            )}
          >
            {ready
              ? locale === 'zh-CN'
                ? '已配置 Key'
                : 'Key configured'
              : locale === 'zh-CN'
                ? '需 API Key'
                : 'Needs API key'}
          </span>
        ) : null}
      </div>

      {(library.needsKey || library.keyLabel) && (
        <label className="grid gap-1">
          <span className="text-[11px] font-semibold text-fg-dim">
            {library.keyLabel ?? 'API Key'}
          </span>
          <input
            type="password"
            value={keyValue}
            placeholder={
              library.keyPlaceholder ??
              (locale === 'zh-CN' ? '粘贴 API Key / Token' : 'Paste API key / token')
            }
            onChange={(event) => onKeyChange(event.currentTarget.value)}
            onKeyDown={stopSettingsInputKeyPropagation}
            className="w-full rounded-md border border-border bg-panel px-2.5 py-1.5 text-xs text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none"
          />
          {library.credentialUrl ? (
            <button
              type="button"
              onClick={() => void openExternal(library.credentialUrl!)}
              className="justify-self-start text-[11px] text-accent hover:underline"
            >
              {locale === 'zh-CN' ? '获取 / 管理凭据' : 'Get / manage credentials'}
            </button>
          ) : null}
        </label>
      )}

      <label className="mt-auto flex items-center justify-between gap-2 rounded-md border border-border-soft bg-panel px-2.5 py-2">
        <span className="text-xs font-semibold text-fg">
          {locale === 'zh-CN' ? '在 /mesh-search 中启用' : 'Enable in /mesh-search'}
        </span>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => onToggle(event.currentTarget.checked)}
          className="h-4 w-4 shrink-0 accent-accent"
        />
      </label>
    </section>
  );
}

function customMeshLibraryName(baseUrl: string, fallback: string): string {
  try {
    const url = new URL(baseUrl.trim());
    return url.hostname.replace(/^www\./iu, '') || fallback;
  } catch {
    return fallback;
  }
}

function customMeshHomepageUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed.includes('{query}')) return trimmed.replace(/\/+$/, '');
  try {
    const url = new URL(trimmed.replace('{query}', ''));
    return url.origin;
  } catch {
    return trimmed.split('{query}', 1)[0]?.replace(/[?&=/_-]+$/u, '') || trimmed;
  }
}

function customMeshSearchUrlTemplate(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  if (trimmed.includes('{query}')) return trimmed;
  if (trimmed.includes('?')) return `${trimmed}&q={query}`;
  if (/\/search$/iu.test(trimmed)) return `${trimmed}?q={query}`;
  return `${trimmed}/search?q={query}`;
}

function CustomMeshLibraryDialog({
  locale,
  onClose,
  onSave,
}: {
  locale: Locale;
  onClose: () => void;
  onSave: (draft: {
    name: string;
    homepageUrl: string;
    token: string;
  }) => void;
}) {
  const [name, setName] = useState('');
  const [homepageUrl, setHomepageUrl] = useState('');
  const [token, setToken] = useState('');
  const canSave = homepageUrl.trim().length > 0;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/65 p-4"
      data-settings-child-modal="true"
    >
      <div className="w-full max-w-lg rounded-lg border border-border bg-panel shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="text-sm font-semibold text-fg">
            {locale === 'zh-CN' ? '添加模型库渠道' : 'Add model library channel'}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded text-fg-faint hover:bg-border-soft hover:text-fg"
          >
            <X size={14} />
          </button>
        </div>
        <div className="grid gap-3 p-4">
          <label className="grid gap-1">
            <span className="text-[11px] font-semibold text-fg-dim">
              {locale === 'zh-CN' ? '名称' : 'Name'}
            </span>
            <input
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              onKeyDown={stopSettingsInputKeyPropagation}
              placeholder={locale === 'zh-CN' ? '新模型库' : 'New model library'}
              className="rounded-md border border-border bg-bg-alt px-2.5 py-2 text-sm text-fg focus:border-accent focus:outline-none"
            />
          </label>
          <label className="grid gap-1">
            <span className="text-[11px] font-semibold text-fg-dim">URL</span>
            <input
              value={homepageUrl}
              onChange={(event) => setHomepageUrl(event.currentTarget.value)}
              onKeyDown={stopSettingsInputKeyPropagation}
              placeholder="https://example.com/search?q={query}"
              className="rounded-md border border-border bg-bg-alt px-2.5 py-2 font-mono text-sm text-fg focus:border-accent focus:outline-none"
            />
            <span className="text-[10px] text-fg-faint">
              {locale === 'zh-CN'
                ? '可填官网，也可填包含 {query} 的搜索 URL。'
                : 'Enter a homepage, or a search URL containing {query}.'}
            </span>
          </label>
          <label className="grid gap-1">
            <span className="text-[11px] font-semibold text-fg-dim">
              {locale === 'zh-CN' ? 'Token / 账号备注' : 'Token / account note'}
            </span>
            <input
              type="password"
              value={token}
              onChange={(event) => setToken(event.currentTarget.value)}
              onKeyDown={stopSettingsInputKeyPropagation}
              placeholder={locale === 'zh-CN' ? '可选' : 'Optional'}
              className="rounded-md border border-border bg-bg-alt px-2.5 py-2 text-sm text-fg focus:border-accent focus:outline-none"
            />
          </label>
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border bg-bg-alt px-3 py-1.5 text-xs text-fg-dim hover:border-accent hover:text-fg"
          >
            {locale === 'zh-CN' ? '取消' : 'Cancel'}
          </button>
          <button
            type="button"
            disabled={!canSave}
            onClick={() =>
              onSave({
                name: name.trim() || customMeshLibraryName(homepageUrl, '自定义模型库'),
                homepageUrl,
                token,
              })
            }
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-bg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {locale === 'zh-CN' ? '保存' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function MeshLibraryEnabledTab({
  usableLibraries,
  pendingLibraries,
  settings,
  locale,
  onToggle,
  onKeyChange,
  onAddLibrary,
  onDeleteCustomLibrary,
  onBrowseRepository,
}: {
  usableLibraries: MeshLibraryDefinition[];
  pendingLibraries: MeshLibraryDefinition[];
  settings: MeshLibraryAccountSettings;
  locale: Locale;
  onToggle: (id: MeshLibraryId, enabled: boolean) => void;
  onKeyChange: (id: MeshLibraryId, value: string) => void;
  onAddLibrary: () => void;
  onDeleteCustomLibrary: (id: MeshLibraryId) => void;
  onBrowseRepository: () => void;
}) {
  if (usableLibraries.length === 0 && pendingLibraries.length === 0) {
    return (
      <div className="grid gap-2 rounded-lg border border-border bg-bg-alt px-4 py-8 text-center">
        <p className="text-xs text-fg-faint">
          {locale === 'zh-CN'
            ? '还没有真正可用的模型库。前往“仓库”开启并配置好 API Key 后，可搜索/下载的库会出现在这里。'
            : 'No genuinely usable model libraries yet. Enable and configure API keys under Registry first.'}
        </p>
        <button
          type="button"
          onClick={onAddLibrary}
          className="justify-self-center rounded-md border border-accent/40 bg-accent/10 px-3 py-1.5 text-xs font-semibold text-accent hover:bg-accent/20"
        >
          {locale === 'zh-CN' ? '添加新渠道' : 'Add new channel'}
        </button>
        <button
          type="button"
          onClick={onBrowseRepository}
          className="justify-self-center rounded-md border border-border bg-panel px-3 py-1.5 text-xs font-semibold text-fg-dim hover:border-accent hover:text-fg"
        >
          {locale === 'zh-CN' ? '浏览仓库' : 'Browse registry'}
        </button>
      </div>
    );
  }
  return (
    <div className="grid gap-3">
      <div>
        <button
          type="button"
          onClick={onAddLibrary}
          className="inline-flex items-center gap-1.5 rounded border border-border bg-panel px-2.5 py-1 text-xs text-fg-dim transition-colors hover:border-accent hover:text-fg"
        >
          <Plus size={13} strokeWidth={2.2} />
          {locale === 'zh-CN' ? '添加新渠道' : 'Add new channel'}
        </button>
      </div>
      {usableLibraries.length > 0 ? (
        <div className="grid gap-2.5 lg:grid-cols-2 2xl:grid-cols-3">
          {usableLibraries.map((library) => (
            <MeshLibraryCard
              key={library.id}
              library={library}
              settings={settings}
              locale={locale}
              onToggle={(enabled) => onToggle(library.id, enabled)}
              onKeyChange={(value) => onKeyChange(library.id, value)}
              onDelete={
                library.custom ? () => onDeleteCustomLibrary(library.id) : undefined
              }
            />
          ))}
        </div>
      ) : null}

      {pendingLibraries.length > 0 ? (
        <section className="grid gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
          <div className="text-[11px] font-semibold text-amber-300">
            {locale === 'zh-CN'
              ? '已开启但还不能用（需补全 API Key 或只能深链浏览）'
              : 'Enabled but not fully usable yet'}
          </div>
          <div className="grid gap-2.5 lg:grid-cols-2 2xl:grid-cols-3">
            {pendingLibraries.map((library) => (
              <MeshLibraryCard
                key={library.id}
                library={library}
                settings={settings}
                locale={locale}
                onToggle={(enabled) => onToggle(library.id, enabled)}
                onKeyChange={(value) => onKeyChange(library.id, value)}
                onDelete={
                  library.custom ? () => onDeleteCustomLibrary(library.id) : undefined
                }
              />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function MeshLibraryRepositoryTab({
  libraries,
  settings,
  locale,
  query,
  onQueryChange,
  onToggle,
  onKeyChange,
  onAddLibrary,
  onDeleteCustomLibrary,
}: {
  libraries: MeshLibraryDefinition[];
  settings: MeshLibraryAccountSettings;
  locale: Locale;
  query: string;
  onQueryChange: (value: string) => void;
  onToggle: (id: MeshLibraryId, enabled: boolean) => void;
  onKeyChange: (id: MeshLibraryId, value: string) => void;
  onAddLibrary: () => void;
  onDeleteCustomLibrary: (id: MeshLibraryId) => void;
}) {
  return (
    <div className="grid gap-3">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div className="relative">
          <Search
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-faint"
          />
          <input
            type="text"
            value={query}
            onChange={(event) => onQueryChange(event.currentTarget.value)}
            onKeyDown={stopSettingsInputKeyPropagation}
            placeholder={
              locale === 'zh-CN'
                ? '搜索在线模型库名称、用途...'
                : 'Search online model library name or purpose...'
            }
            className="w-full rounded-lg border border-border bg-bg-alt py-2 pl-9 pr-3 text-sm text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none"
          />
        </div>
        <button
          type="button"
          onClick={onAddLibrary}
          className="inline-flex items-center justify-center gap-1.5 rounded border border-border bg-panel px-3 py-2 text-xs text-fg-dim transition-colors hover:border-accent hover:text-fg"
        >
          <Plus size={13} strokeWidth={2.2} />
          {locale === 'zh-CN' ? '添加新渠道' : 'Add new channel'}
        </button>
      </div>

      {libraries.length === 0 ? (
        <p className="rounded-lg border border-border bg-bg-alt px-4 py-6 text-center text-xs text-fg-faint">
          {locale === 'zh-CN' ? '没有匹配的模型库。' : 'No matching model libraries.'}
        </p>
      ) : (
        <div className="grid gap-2.5 lg:grid-cols-2 2xl:grid-cols-3">
          {libraries.map((library) => (
            <MeshLibraryCard
              key={library.id}
              library={library}
              settings={settings}
              locale={locale}
              onToggle={(enabled) => onToggle(library.id, enabled)}
              onKeyChange={(value) => onKeyChange(library.id, value)}
              onDelete={
                library.custom ? () => onDeleteCustomLibrary(library.id) : undefined
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function ThreeDGenerationSettingsPanel({
  locale,
  embedded = false,
  settingsProfile,
  remoteProfile = false,
}: {
  locale: Locale;
  embedded?: boolean;
  settingsProfile?: SettingsProfileOptions;
  remoteProfile?: boolean;
}) {
  const [settings, setSettings] = useState<ThreeDGenerationSettings>(() =>
    loadThreeDGenerationSettings(settingsProfile),
  );
  const [category, setCategory] = useState<ThreeDProviderCategory>('commercial');
  const [customDialogOpen, setCustomDialogOpen] = useState(false);

  const update = (patch: Partial<ThreeDGenerationSettings>) => {
    const next = { ...settings, ...patch };
    saveThreeDGenerationSettings(next, settingsProfile);
    setSettings(loadThreeDGenerationSettings(settingsProfile));
  };

  const providers = threeDProviders(settings).filter(
    (provider) => !remoteProfile || !provider.local,
  );
  const providerOptions = providers.map((provider) => ({
    id: provider.id,
    label: provider.label,
    hint: `${threeDProviderCategoryLabel(provider.category, locale)} · ${threeDProviderStatusLabel(
      provider,
      settings,
      locale,
    )}`,
    group: threeDProviderCategoryLabel(provider.category, locale),
  }));
  const activeProviders = providers.filter(
    (provider) => provider.category === category,
  );

  const addCustomProvider = (draft: CustomGenerationProviderDraft) => {
    const id = uniqueCustomId(
      createCustomThreeDProviderId(draft.name),
      settings.customProviders.map((provider) => provider.id),
    );
    const provider: CustomThreeDProviderDefinition = {
      id,
      label: draft.name,
      category,
      apiKind: 'generic-3d-api',
      defaultModel: draft.model,
      models: draft.models,
      needsKey: true,
      local: false,
      defaultBaseUrl: draft.baseUrl,
      supportsBaseUrl: true,
      endpointPlaceholder: draft.baseUrl,
      keyPlaceholder: 'sk-...',
      note: '自定义 OpenAI-compatible Mesh 生成渠道。',
    };
    const next: ThreeDGenerationSettings = {
      ...settings,
      preferredProviderId: id,
      customProviders: [...settings.customProviders, provider],
      providerKeys: { ...settings.providerKeys },
      providerBaseUrls: { ...settings.providerBaseUrls, [id]: draft.baseUrl },
      providerModels: { ...settings.providerModels, [id]: draft.model },
    };
    if (draft.apiKey) next.providerKeys[id] = draft.apiKey;
    if (!saveThreeDGenerationSettings(next, settingsProfile)) return false;
    setSettings(loadThreeDGenerationSettings(settingsProfile));
    setCustomDialogOpen(false);
    return true;
  };

  const deleteCustomProvider = (id: ThreeDProviderId) => {
    const providerKeys = { ...settings.providerKeys };
    const providerBaseUrls = { ...settings.providerBaseUrls };
    const providerModels = { ...settings.providerModels };
    delete providerKeys[id];
    delete providerBaseUrls[id];
    delete providerModels[id];
    const next: ThreeDGenerationSettings = {
      ...settings,
      preferredProviderId:
        settings.preferredProviderId === id ? 'meshy' : settings.preferredProviderId,
      customProviders: settings.customProviders.filter((provider) => provider.id !== id),
      providerKeys,
      providerBaseUrls,
      providerModels,
    };
    saveThreeDGenerationSettings(next, settingsProfile);
    setSettings(loadThreeDGenerationSettings(settingsProfile));
  };

  return (
    <div className="space-y-5">
      {!embedded && (
        <div>
          <h3 className="text-lg font-semibold text-fg">
            {t(locale, 'settings.threeDGeneration.title')}
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-fg-faint">
            {t(locale, 'settings.threeDGeneration.description')}
          </p>
        </div>
      )}

      <SettingRow
        title={t(locale, 'settings.threeDGeneration.defaultProviderLabel')}
        description={t(locale, 'settings.threeDGeneration.defaultProviderDesc')}
      >
        <div className="w-full min-w-[14rem]">
          <SelectControl
            value={settings.preferredProviderId}
            options={providerOptions}
            onChange={(id) =>
              update({ preferredProviderId: id as ThreeDProviderId })
            }
            icon={<Box size={15} strokeWidth={2.1} />}
          />
        </div>
      </SettingRow>

      <div>
        <div
          role="tablist"
          aria-orientation="horizontal"
          className={SETTINGS_INNER_TABLIST_CLASS}
        >
          {threeDProviderCategoryOrder.map((item) => {
            const active = category === item;
            return (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setCategory(item)}
                className={cn(
                  SETTINGS_INNER_TAB_CLASS,
                  active
                    ? '-mb-px border-b-2 border-accent text-fg'
                    : 'text-fg-faint hover:text-fg',
                )}
              >
                {t(locale, threeDProviderCategoryTitleKey(item))}
              </button>
            );
          })}
        </div>
      </div>

      <section role="tabpanel" className="rounded-lg border border-border bg-bg-alt p-4">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h4 className="text-sm font-semibold text-fg">
              {t(locale, threeDProviderCategoryTitleKey(category))}
            </h4>
            <p className="text-xs leading-relaxed text-fg-faint">
              {t(locale, threeDProviderCategoryDescKey(category))}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <StatusBadge state="default" label={String(activeProviders.length)} />
            <button
              type="button"
              onClick={() => setCustomDialogOpen(true)}
              className="inline-flex items-center gap-1.5 rounded border border-border bg-panel px-2.5 py-1 text-xs text-fg-dim transition-colors hover:border-accent hover:text-fg"
            >
              <Plus size={13} strokeWidth={2.2} />
              {t(locale, 'settings.models.add')}
            </button>
          </div>
        </div>
        <div className={SETTINGS_PROVIDER_GRID_CLASS}>
          {activeProviders.map((provider) => (
            <ThreeDProviderSettingsRow
              key={provider.id}
              provider={provider}
              settings={settings}
              locale={locale}
              onChange={(next) => {
                saveThreeDGenerationSettings(next, settingsProfile);
                setSettings(loadThreeDGenerationSettings(settingsProfile));
              }}
              onDelete={
                provider.custom ? () => deleteCustomProvider(provider.id) : undefined
              }
            />
          ))}
        </div>
      </section>
      {customDialogOpen && (
        <CustomGenerationProviderDialog
          locale={locale}
          title={t(locale, 'settings.models.addTitle')}
          modelScope="mesh"
          defaultName={t(locale, 'settings.models.newProviderName')}
          defaultModel="custom-3d-model"
          endpointPlaceholder="https://api.example.com/v1/3d/generations"
          onClose={() => setCustomDialogOpen(false)}
          onSave={addCustomProvider}
        />
      )}
    </div>
  );
}

const threeDProviderCategoryOrder: ThreeDProviderCategory[] = ['commercial', 'free'];

function threeDProviderCategoryTitleKey(
  category: ThreeDProviderCategory,
): TranslationKey {
  return category === 'free'
    ? 'settings.threeDGeneration.freeProviders'
    : 'settings.threeDGeneration.commercialProviders';
}

function threeDProviderCategoryDescKey(
  category: ThreeDProviderCategory,
): TranslationKey {
  return category === 'free'
    ? 'settings.threeDGeneration.freeProvidersDesc'
    : 'settings.threeDGeneration.commercialProvidersDesc';
}

function threeDProviderCategoryLabel(
  category: ThreeDProviderCategory,
  locale: Locale,
): string {
  return t(
    locale,
    category === 'free'
      ? 'settings.threeDGeneration.categoryFree'
      : 'settings.threeDGeneration.categoryCommercial',
  );
}

function threeDProviderCategoryBadgeClass(category: ThreeDProviderCategory): string {
  return category === 'free'
    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
    : 'border-sky-500/30 bg-sky-500/10 text-sky-300';
}

function threeDProviderStatusLabel(
  provider: ThreeDProviderDefinition,
  settings: ThreeDGenerationSettings,
  locale: Locale,
): string {
  if (threeDProviderReady(provider.id, settings)) {
    return t(locale, 'settings.freeChannels.ready');
  }
  if (provider.local) return t(locale, 'settings.freeChannels.localNeedsSetup');
  if (provider.needsKey) return t(locale, 'settings.freeChannels.needsKey');
  return t(locale, 'settings.imageGeneration.noKeyRequired');
}

function ThreeDProviderSettingsRow({
  provider,
  settings,
  locale,
  onChange,
  onDelete,
}: {
  provider: ThreeDProviderDefinition;
  settings: ThreeDGenerationSettings;
  locale: Locale;
  onChange: (settings: ThreeDGenerationSettings) => void;
  onDelete?: () => void;
}) {
  const [showKey, setShowKey] = useState(false);
  const keyProviderId = provider.keyProviderId ?? provider.id;
  const keyValue = settings.providerKeys[keyProviderId] ?? '';
  const baseUrl = settings.providerBaseUrls[provider.id] ?? '';
  const model = threeDProviderModel(provider.id, settings);
  const ready = threeDProviderReady(provider.id, settings);
  const KeyIcon = showKey ? EyeOff : Eye;

  const patchProvider = (
    patch: Partial<{
      key: string;
      baseUrl: string;
      model: string;
    }>,
  ) => {
    const next: ThreeDGenerationSettings = {
      ...settings,
      providerKeys: { ...settings.providerKeys },
      providerBaseUrls: { ...settings.providerBaseUrls },
      providerModels: { ...settings.providerModels },
    };
    if (patch.key !== undefined) {
      const value = patch.key.trim();
      if (value) next.providerKeys[keyProviderId] = value;
      else delete next.providerKeys[keyProviderId];
    }
    if (patch.baseUrl !== undefined) {
      const value = patch.baseUrl.trim();
      if (value) next.providerBaseUrls[provider.id] = value;
      else delete next.providerBaseUrls[provider.id];
    }
    if (patch.model !== undefined) {
      const value = patch.model.trim();
      if (value) next.providerModels[provider.id] = value;
      else delete next.providerModels[provider.id];
    }
    if (
      !threeDProviderReady(next.preferredProviderId, next) &&
      threeDProviderReady(provider.id, next)
    ) {
      next.preferredProviderId = provider.id;
    }
    onChange(next);
  };

  return (
    <div className="space-y-3 rounded-lg border border-border bg-bg-alt p-4">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-fg">{provider.label}</span>
            <span
              className={cn(
                'inline-flex shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium',
                threeDProviderCategoryBadgeClass(provider.category),
              )}
            >
              {threeDProviderCategoryLabel(provider.category, locale)}
            </span>
            <StatusBadge
              state={ready ? 'direct' : 'unavailable'}
              label={threeDProviderStatusLabel(provider, settings, locale)}
            />
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-fg-faint">
            {provider.note}
          </p>
        </div>
        {provider.credentialUrl && (
          <button
            type="button"
            onClick={() => void openExternal(provider.credentialUrl as string)}
            className="inline-flex items-center gap-1.5 rounded border border-border bg-panel px-2.5 py-1 text-xs text-fg-dim transition-colors hover:border-accent hover:text-fg"
          >
            <ExternalLink size={13} strokeWidth={2.2} />
            {provider.local
              ? t(locale, 'dock.localModelDownload')
              : t(
                  locale,
                  ready
                    ? 'settings.freeChannels.manageKey'
                    : 'settings.freeChannels.getKey',
            )}
          </button>
        )}
        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            title={t(locale, 'settings.models.delete')}
            aria-label={t(locale, 'settings.models.delete')}
            className="inline-flex h-7 w-7 items-center justify-center rounded border border-rose-500/40 bg-rose-500/10 text-rose-300 transition-colors hover:bg-rose-500/20"
          >
            <Trash2 size={13} strokeWidth={2.2} />
          </button>
        )}
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {provider.supportsBaseUrl && (
          <label className="block space-y-1 md:col-span-2">
            <span className="text-[11px] font-medium text-fg-dim">
              {t(locale, 'settings.models.baseUrl')}
            </span>
            <input
              type="text"
              value={baseUrl}
              onChange={(event) => patchProvider({ baseUrl: event.target.value })}
              placeholder={
                threeDProviderBaseUrl(provider.id, settings) ||
                provider.endpointPlaceholder
              }
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-md border border-border bg-panel px-2.5 py-1.5 font-mono text-sm text-fg outline-none transition-colors focus:border-accent"
            />
          </label>
        )}

        {provider.needsKey && (
          <label className="block space-y-1 md:col-span-2">
            <span className="text-[11px] font-medium text-fg-dim">
              {provider.keyLabel ?? t(locale, 'settings.models.apiKey')}
            </span>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={keyValue}
                onChange={(event) => patchProvider({ key: event.target.value })}
                placeholder={provider.keyPlaceholder ?? 'sk-...'}
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded-md border border-border bg-panel px-2.5 py-1.5 pr-14 font-mono text-sm text-fg outline-none transition-colors focus:border-accent"
              />
              <div className="absolute inset-y-0 right-1 flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  title={t(
                    locale,
                    showKey ? 'settings.models.hideKey' : 'settings.models.showKey',
                  )}
                  className="flex h-6 w-6 items-center justify-center rounded text-fg-faint transition-colors hover:text-fg"
                >
                  <KeyIcon size={13} strokeWidth={2} />
                </button>
                {keyValue && (
                  <button
                    type="button"
                    onClick={() => patchProvider({ key: '' })}
                    title={t(locale, 'settings.models.clear')}
                    className="flex h-6 w-6 items-center justify-center rounded text-fg-faint transition-colors hover:text-rose-300"
                  >
                    <Trash2 size={13} strokeWidth={2} />
                  </button>
                )}
              </div>
            </div>
          </label>
        )}

        <label className="block space-y-1 md:col-span-2">
          <span className="text-[11px] font-medium text-fg-dim">
            {t(locale, 'settings.freeChannels.modelLabel')}
          </span>
          <select
            value={provider.models.includes(model) ? model : ''}
            onChange={(event) => {
              if (event.target.value) {
                patchProvider({ model: event.target.value });
              }
            }}
            className="h-[35px] w-full rounded-md border border-border bg-panel px-2 font-mono text-xs text-fg outline-none transition-colors focus:border-accent"
          >
            <option value="">{t(locale, 'settings.models.selectModel')}</option>
            {provider.models.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}

export function RiggingSettingsPanel({
  locale,
  embedded = false,
  settingsProfile,
  remoteProfile = false,
}: {
  locale: Locale;
  embedded?: boolean;
  settingsProfile?: SettingsProfileOptions;
  remoteProfile?: boolean;
}) {
  const [settings, setSettings] = useState<ThreeDGenerationSettings>(() =>
    loadThreeDGenerationSettings(settingsProfile),
  );
  const [channel, setChannel] = useState<RiggingChannelTab>('commercial');

  const update = (patch: Partial<ThreeDGenerationSettings['rigging']>) => {
    const next: ThreeDGenerationSettings = {
      ...settings,
      rigging: { ...settings.rigging, ...patch },
    };
    saveThreeDGenerationSettings(next, settingsProfile);
    setSettings(loadThreeDGenerationSettings(settingsProfile));
  };

  const riggingProviders = THREE_D_RIGGING_PROVIDERS.filter(
    (provider) => !remoteProfile || !provider.local,
  );
  const providerOptions = riggingProviders.map((provider) => ({
    id: provider.id,
    label: provider.label,
    hint: `${riggingProviderCategoryLabel(provider.category, locale)} · ${riggingProviderStatusLabel(
      provider,
      settings,
      locale,
    )}`,
    group: t(locale, riggingChannelTitleKey(riggingChannelForCategory(provider.category))),
  }));
  const activeProviders = riggingProviders.filter(
    (provider) => riggingChannelForCategory(provider.category) === channel,
  );

  return (
    <div className="space-y-5">
      {!embedded && (
        <div>
          <h3 className="text-lg font-semibold text-fg">
            {t(locale, 'settings.rigging.title')}
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-fg-faint">
            {t(locale, 'settings.rigging.description')}
          </p>
        </div>
      )}

      <SettingRow
        title={t(locale, 'settings.rigging.defaultProviderLabel')}
        description={t(locale, 'settings.rigging.defaultProviderDesc')}
      >
        <div className="w-full min-w-[14rem]">
          <SelectControl
            value={settings.rigging.preferredProviderId}
            options={providerOptions}
            onChange={(id) => update({ preferredProviderId: id as ThreeDRiggingProviderId })}
            icon={<Bone size={15} strokeWidth={2.1} />}
          />
        </div>
      </SettingRow>

      <div className="rounded-lg border border-border bg-bg-alt p-4">
        <div className="flex items-start gap-3">
          <Info size={15} strokeWidth={2.1} className="mt-0.5 shrink-0 text-accent" />
          <p className="text-xs leading-relaxed text-fg-faint">
            {t(locale, 'settings.rigging.externalInstallNotice')}
          </p>
        </div>
      </div>

      <div>
        <div
          role="tablist"
          aria-orientation="horizontal"
          className={SETTINGS_INNER_TABLIST_CLASS}
        >
          {riggingChannelOrder.map((item) => {
            const active = channel === item;
            return (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setChannel(item)}
                className={cn(
                  SETTINGS_INNER_TAB_CLASS,
                  active
                    ? '-mb-px border-b-2 border-accent text-fg'
                    : 'text-fg-faint hover:text-fg',
                )}
              >
                {t(locale, riggingChannelTitleKey(item))}
              </button>
            );
          })}
        </div>
      </div>

      <section role="tabpanel" className="rounded-lg border border-border bg-bg-alt p-4">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h4 className="text-sm font-semibold text-fg">
              {t(locale, riggingChannelTitleKey(channel))}
            </h4>
            <p className="text-xs leading-relaxed text-fg-faint">
              {t(locale, riggingChannelDescKey(channel))}
            </p>
          </div>
          <StatusBadge state="default" label={String(activeProviders.length)} />
        </div>
        <div className={SETTINGS_PROVIDER_GRID_CLASS}>
          {activeProviders.map((provider) => (
            <RiggingProviderSettingsRow
              key={provider.id}
              provider={provider}
              settings={settings}
              locale={locale}
              onChange={(next) => {
                saveThreeDGenerationSettings(next, settingsProfile);
                setSettings(loadThreeDGenerationSettings(settingsProfile));
              }}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

type RiggingChannelTab = 'commercial' | 'free';

const riggingChannelOrder: RiggingChannelTab[] = ['commercial', 'free'];

/**
 * Online rigging APIs are the commercial channel; local tools and manual
 * imports fold into the free channel — mirroring the Mesh channel's
 * commercial / free split.
 */
function riggingChannelForCategory(
  category: ThreeDRiggingProviderCategory,
): RiggingChannelTab {
  return category === 'online' ? 'commercial' : 'free';
}

function riggingChannelTitleKey(channel: RiggingChannelTab): TranslationKey {
  return channel === 'free'
    ? 'settings.rigging.freeChannel'
    : 'settings.rigging.commercialChannel';
}

function riggingChannelDescKey(channel: RiggingChannelTab): TranslationKey {
  return channel === 'free'
    ? 'settings.rigging.freeChannelDesc'
    : 'settings.rigging.commercialChannelDesc';
}

function riggingProviderCategoryLabel(
  category: ThreeDRiggingProviderCategory,
  locale: Locale,
): string {
  if (category === 'local') return t(locale, 'settings.rigging.categoryLocal');
  if (category === 'manual') return t(locale, 'settings.rigging.categoryManual');
  return t(locale, 'settings.rigging.categoryOnline');
}

function riggingProviderCategoryBadgeClass(category: ThreeDRiggingProviderCategory): string {
  if (category === 'local') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
  if (category === 'manual') return 'border-amber-500/30 bg-amber-500/10 text-amber-300';
  return 'border-sky-500/30 bg-sky-500/10 text-sky-300';
}

function riggingProviderStatusLabel(
  provider: ThreeDRiggingProviderDefinition,
  settings: ThreeDGenerationSettings,
  locale: Locale,
): string {
  if (threeDRiggingProviderReady(provider.id, settings)) {
    return t(locale, 'settings.freeChannels.ready');
  }
  if (provider.category === 'manual') return t(locale, 'settings.rigging.manualOnly');
  if (provider.supportsCommand) return t(locale, 'settings.rigging.needsCommand');
  if (provider.local) return t(locale, 'settings.freeChannels.localNeedsSetup');
  if (provider.needsKey) return t(locale, 'settings.freeChannels.needsKey');
  return t(locale, 'settings.imageGeneration.noKeyRequired');
}

function RiggingProviderSettingsRow({
  provider,
  settings,
  locale,
  onChange,
}: {
  provider: ThreeDRiggingProviderDefinition;
  settings: ThreeDGenerationSettings;
  locale: Locale;
  onChange: (settings: ThreeDGenerationSettings) => void;
}) {
  const [showKey, setShowKey] = useState(false);
  const keyValue = settings.rigging.providerKeys[provider.id] ?? '';
  const inherited = threeDRiggingInheritedKey(provider.id, settings);
  const inheritedSourceLabel = inherited
    ? threeDProviderById(inherited.sourceProviderId).label
    : '';
  const baseUrl = settings.rigging.providerBaseUrls[provider.id] ?? '';
  const command = settings.rigging.providerCommands[provider.id] ?? '';
  const model = threeDRiggingProviderModel(provider.id, settings);
  const ready = threeDRiggingProviderReady(provider.id, settings);
  const KeyIcon = showKey ? EyeOff : Eye;

  const patchProvider = (
    patch: Partial<{
      key: string;
      baseUrl: string;
      command: string;
      model: string;
    }>,
  ) => {
    const next: ThreeDGenerationSettings = {
      ...settings,
      rigging: {
        ...settings.rigging,
        providerKeys: { ...settings.rigging.providerKeys },
        providerBaseUrls: { ...settings.rigging.providerBaseUrls },
        providerCommands: { ...settings.rigging.providerCommands },
        providerModels: { ...settings.rigging.providerModels },
      },
    };
    if (patch.key !== undefined) {
      const value = patch.key.trim();
      if (value) next.rigging.providerKeys[provider.id] = value;
      else delete next.rigging.providerKeys[provider.id];
    }
    if (patch.baseUrl !== undefined) {
      const value = patch.baseUrl.trim();
      if (value) next.rigging.providerBaseUrls[provider.id] = value;
      else delete next.rigging.providerBaseUrls[provider.id];
    }
    if (patch.command !== undefined) {
      const value = patch.command.trim();
      if (value) next.rigging.providerCommands[provider.id] = value;
      else delete next.rigging.providerCommands[provider.id];
    }
    if (patch.model !== undefined) {
      const value = patch.model.trim();
      if (value) next.rigging.providerModels[provider.id] = value;
      else delete next.rigging.providerModels[provider.id];
    }
    if (
      !threeDRiggingProviderReady(next.rigging.preferredProviderId, next) &&
      threeDRiggingProviderReady(provider.id, next)
    ) {
      next.rigging.preferredProviderId = provider.id;
    }
    onChange(next);
  };

  return (
    <div className="space-y-3 rounded-lg border border-border bg-bg-alt p-4">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-fg">{provider.label}</span>
            <span
              className={cn(
                'inline-flex shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium',
                riggingProviderCategoryBadgeClass(provider.category),
              )}
            >
              {riggingProviderCategoryLabel(provider.category, locale)}
            </span>
            <StatusBadge
              state={ready ? 'direct' : 'unavailable'}
              label={riggingProviderStatusLabel(provider, settings, locale)}
            />
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-fg-faint">
            {provider.note}
          </p>
          <p className="mt-1 text-[10px] leading-relaxed text-fg-faint">
            {provider.targets.join(' / ')} · {provider.supportedFormats.map((item) => item.toUpperCase()).join(' / ')}
          </p>
        </div>
        {provider.credentialUrl && (
          <button
            type="button"
            onClick={() => void openExternal(provider.credentialUrl as string)}
            className="inline-flex items-center gap-1.5 rounded border border-border bg-panel px-2.5 py-1 text-xs text-fg-dim transition-colors hover:border-accent hover:text-fg"
          >
            <ExternalLink size={13} strokeWidth={2.2} />
            {t(locale, 'settings.rigging.openDocs')}
          </button>
        )}
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {provider.supportsBaseUrl && (
          <label className="block space-y-1 md:col-span-2">
            <span className="text-[11px] font-medium text-fg-dim">
              {t(locale, 'settings.models.baseUrl')}
            </span>
            <input
              type="text"
              value={baseUrl}
              onChange={(event) => patchProvider({ baseUrl: event.target.value })}
              placeholder={
                threeDRiggingProviderBaseUrl(provider.id, settings) ||
                provider.endpointPlaceholder
              }
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-md border border-border bg-panel px-2.5 py-1.5 font-mono text-sm text-fg outline-none transition-colors focus:border-accent"
            />
          </label>
        )}

        {provider.needsKey && (
          <label className="block space-y-1 md:col-span-2">
            <span className="text-[11px] font-medium text-fg-dim">
              {provider.keyLabel ?? t(locale, 'settings.models.apiKey')}
            </span>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={keyValue}
                onChange={(event) => patchProvider({ key: event.target.value })}
                placeholder={
                  inherited
                    ? t(locale, 'settings.rigging.inheritedPlaceholder')
                    : provider.keyPlaceholder ?? 'sk-...'
                }
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded-md border border-border bg-panel px-2.5 py-1.5 pr-14 font-mono text-sm text-fg outline-none transition-colors focus:border-accent"
              />
              <div className="absolute inset-y-0 right-1 flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  title={t(
                    locale,
                    showKey ? 'settings.models.hideKey' : 'settings.models.showKey',
                  )}
                  className="flex h-6 w-6 items-center justify-center rounded text-fg-faint transition-colors hover:text-fg"
                >
                  <KeyIcon size={13} strokeWidth={2} />
                </button>
                {keyValue && (
                  <button
                    type="button"
                    onClick={() => patchProvider({ key: '' })}
                    title={t(locale, 'settings.models.clear')}
                    className="flex h-6 w-6 items-center justify-center rounded text-fg-faint transition-colors hover:text-rose-300"
                  >
                    <Trash2 size={13} strokeWidth={2} />
                  </button>
                )}
              </div>
            </div>
            {inherited && !keyValue && (
              <p className="text-[10px] leading-relaxed text-emerald-300/90">
                {t(locale, 'settings.rigging.inheritedHint').replace(
                  '{source}',
                  inheritedSourceLabel,
                )}
              </p>
            )}
          </label>
        )}

        <label className="block space-y-1 md:col-span-2">
          <span className="text-[11px] font-medium text-fg-dim">
            {t(locale, 'settings.freeChannels.modelLabel')}
          </span>
          <select
            value={provider.models.includes(model) ? model : ''}
            onChange={(event) => {
              if (event.target.value) {
                patchProvider({ model: event.target.value });
              }
            }}
            className="h-[35px] w-full rounded-md border border-border bg-panel px-2 font-mono text-xs text-fg outline-none transition-colors focus:border-accent"
          >
            <option value="">{t(locale, 'settings.models.selectModel')}</option>
            {provider.models.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>

        {provider.supportsCommand && (
          <label className="block space-y-1 md:col-span-2">
            <span className="text-[11px] font-medium text-fg-dim">
              {t(locale, 'settings.rigging.commandLabel')}
            </span>
            <input
              type="text"
              value={command}
              onChange={(event) => patchProvider({ command: event.target.value })}
              placeholder={
                threeDRiggingProviderCommand(provider.id, settings) ||
                provider.commandPlaceholder
              }
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-md border border-border bg-panel px-2.5 py-1.5 font-mono text-sm text-fg outline-none transition-colors focus:border-accent"
            />
          </label>
        )}
      </div>
    </div>
  );
}

function CapturePerfSettingsPanel({ locale }: { locale: Locale }) {
  const [targets, setTargets] = useState<SkillInstallTarget[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [status, setStatus] = useState<{
    tone: 'ok' | 'err';
    msg: string;
  } | null>(null);
  const desktop = isTauri();

  const installTarget = useMemo(
    () =>
      targets.find((target) => target.scope === 'global' && target.isDefault) ??
      targets.find((target) => target.scope === 'global') ??
      targets.find((target) => target.isDefault) ??
      targets[0] ??
      null,
    [targets],
  );

  const installedSkills = useMemo(() => {
    const installed = new Map<string, SkillInstallTarget>();
    for (const target of targets) {
      for (const skill of target.skills) {
        installed.set(skill.toLowerCase(), target);
      }
    }
    return installed;
  }, [targets]);

  const loadTargets = useCallback(async () => {
    if (!isTauri()) {
      setTargets([]);
      return;
    }
    try {
      setTargets(await skillInstallTargets(null));
    } catch (err) {
      setTargets([]);
      setStatus({
        tone: 'err',
        msg:
          locale === 'zh-CN'
            ? `读取安装目标失败：${describeError(err)}`
            : `Failed to read install targets: ${describeError(err)}`,
      });
    }
  }, [locale]);

  useEffect(() => {
    void loadTargets();
  }, [loadTargets]);

  const installSkill = useCallback(
    async (definition: CapturePerfSkillDefinition) => {
      if (!isTauri()) {
        setStatus({
          tone: 'err',
          msg:
            locale === 'zh-CN'
              ? '一键安装需要在桌面应用中运行。'
              : 'One-click install requires the desktop app.',
        });
        return;
      }
      if (!installTarget) {
        setStatus({
          tone: 'err',
          msg: locale === 'zh-CN' ? '未找到可用安装目标。' : 'No install target found.',
        });
        return;
      }
      setBusyId(definition.id);
      setStatus(null);
      try {
        const common = {
          name: definition.name,
          slug: definition.slug,
          targetId: installTarget.id,
          overwrite: true,
          sourceUrl: definition.sourceUrl,
          projectRoot: null,
        };
        const installed =
          definition.installKind === 'remote-skill'
            ? await installSkillFromUrl({
                ...common,
                url: definition.skillUrl ?? definition.sourceUrl,
              })
            : await installSkillFromText({
                ...common,
                text: definition.skillText ?? '',
              });
        await loadTargets();
        setStatus({
          tone: 'ok',
          msg:
            locale === 'zh-CN'
              ? `${installed.overwritten ? '已更新' : '已安装'} ${definition.title} · ${definition.version}`
              : `${installed.overwritten ? 'Updated' : 'Installed'} ${definition.title} · ${definition.version}`,
        });
      } catch (err) {
        setStatus({
          tone: 'err',
          msg:
            locale === 'zh-CN'
              ? `安装失败：${describeError(err)}`
              : `Install failed: ${describeError(err)}`,
        });
      } finally {
        setBusyId((current) => (current === definition.id ? null : current));
      }
    },
    [installTarget, loadTargets, locale],
  );

  const uninstallInstalledSkill = useCallback(
    async (definition: CapturePerfSkillDefinition) => {
      const target = installedSkills.get(definition.slug.toLowerCase());
      if (!target) {
        setStatus({
          tone: 'err',
          msg: locale === 'zh-CN' ? '未找到已安装目录。' : 'Installed folder not found.',
        });
        return;
      }
      setBusyId(definition.id);
      setStatus(null);
      try {
        const result = await uninstallSkill({
          targetId: target.id,
          slug: definition.slug,
          projectRoot: null,
        });
        await loadTargets();
        setStatus({
          tone: 'ok',
          msg:
            locale === 'zh-CN'
              ? `${result.removed ? '已卸载' : '已移除记录'} ${definition.title}`
              : `${result.removed ? 'Uninstalled' : 'Removed record for'} ${definition.title}`,
        });
      } catch (err) {
        setStatus({
          tone: 'err',
          msg:
            locale === 'zh-CN'
              ? `卸载失败：${describeError(err)}`
              : `Uninstall failed: ${describeError(err)}`,
        });
      } finally {
        setBusyId((current) => (current === definition.id ? null : current));
      }
    },
    [installedSkills, loadTargets, locale],
  );

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h3 className="text-lg font-semibold text-fg">
          {locale === 'zh-CN' ? '抓帧性能' : 'Capture / performance'}
        </h3>
        <p className="text-xs leading-relaxed text-fg-faint">
          {locale === 'zh-CN'
            ? '全局安装 RenderDoc、Nsight Graphics、Unreal Insights、Unity Profiler、Perfetto 和 Android 内存分析 Skill。'
            : 'Globally install RenderDoc, Nsight Graphics, Unreal Insights, Unity Profiler, Perfetto, and Android memory analysis Skills.'}
        </p>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-bg-alt px-4 py-3 text-xs text-fg-faint">
        <div className="min-w-0">
          {locale === 'zh-CN' ? '安装目标：' : 'Install target: '}
          <span className="text-fg">
            {installTarget
              ? `${installTarget.scope === 'global' ? (locale === 'zh-CN' ? '全局' : 'Global') : (locale === 'zh-CN' ? '项目' : 'Project')} · ${installTarget.label}`
              : desktop
                ? locale === 'zh-CN'
                  ? '未找到'
                  : 'Not found'
                : locale === 'zh-CN'
                  ? '桌面版可安装'
                  : 'Desktop app required'}
          </span>
        </div>
        <button
          type="button"
          onClick={() => void loadTargets()}
          disabled={!desktop}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-panel px-2.5 py-1.5 text-xs text-fg-dim hover:border-accent hover:text-fg disabled:opacity-50"
        >
          <RefreshCw size={13} />
          {locale === 'zh-CN' ? '重新检测' : 'Refresh'}
        </button>
      </div>

      {status ? (
        <div
          className={cn(
            'rounded-md border px-3 py-2 text-[11px] leading-relaxed',
            status.tone === 'ok'
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
              : 'border-red-500/30 bg-red-500/10 text-red-200',
          )}
        >
          {status.msg}
        </div>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-2">
        {CAPTURE_PERF_SKILLS.map((definition) => (
          <CapturePerfSkillCard
            key={definition.id}
            definition={definition}
            locale={locale}
            desktop={desktop}
            installedTarget={installedSkills.get(definition.slug.toLowerCase())}
            installing={busyId === definition.id}
            onInstall={() => void installSkill(definition)}
            onUninstall={() => void uninstallInstalledSkill(definition)}
          />
        ))}
      </div>
    </div>
  );
}

function CapturePerfSkillCard({
  definition,
  locale,
  desktop,
  installedTarget,
  installing,
  onInstall,
  onUninstall,
}: {
  definition: CapturePerfSkillDefinition;
  locale: Locale;
  desktop: boolean;
  installedTarget?: SkillInstallTarget;
  installing: boolean;
  onInstall: () => void;
  onUninstall: () => void;
}) {
  const installed = installedTarget != null;
  return (
    <div className="flex min-h-[13rem] flex-col rounded-lg border border-border bg-bg-alt p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[10px] font-semibold text-accent">
              {capturePerfCategoryLabel(definition.category)}
            </span>
            <span className="rounded border border-border bg-panel px-1.5 py-0.5 text-[10px] text-fg-faint">
              {/^\d/.test(definition.version)
                ? `v${definition.version}`
                : definition.version}
            </span>
            {installed ? (
              <span className="inline-flex items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-300">
                <Check size={11} />
                {locale === 'zh-CN' ? '已安装' : 'Installed'}
              </span>
            ) : null}
          </div>
          <h4 className="mt-2 text-sm font-semibold text-fg">{definition.title}</h4>
          <p className="mt-1 text-xs leading-relaxed text-fg-faint">
            {definition.summary}
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {definition.tags.map((tag) => (
          <span
            key={tag}
            className="rounded border border-border-soft bg-panel px-1.5 py-0.5 text-[10px] text-fg-faint"
          >
            {tag}
          </span>
        ))}
      </div>

      {definition.command ? (
        <div className="mt-3 truncate rounded border border-border-soft bg-panel px-2 py-1.5 font-mono text-[11px] text-fg-dim">
          {definition.command}
        </div>
      ) : null}

      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-4">
        <button
          type="button"
          onClick={() => void openExternal(definition.sourceUrl)}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-panel px-2.5 py-1.5 text-xs text-fg-dim hover:border-accent hover:text-fg"
        >
          <ExternalLink size={13} />
          {locale === 'zh-CN' ? '打开来源' : 'Open source'}
        </button>
        <div className="flex flex-wrap gap-2">
          {installed ? (
            <button
              type="button"
              onClick={onUninstall}
              disabled={installing || !desktop}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-panel px-2.5 py-1.5 text-xs text-fg-dim hover:border-red-400 hover:text-red-200 disabled:opacity-50"
              title={installedTarget?.label}
            >
              {installing ? (
                <RefreshCw size={13} className="animate-spin" />
              ) : (
                <Trash2 size={13} />
              )}
              {locale === 'zh-CN' ? '卸载' : 'Uninstall'}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onInstall}
            disabled={installing || !desktop}
            className="inline-flex items-center gap-1.5 rounded-md border border-accent bg-accent/15 px-2.5 py-1.5 text-xs font-semibold text-fg hover:bg-accent/25 disabled:border-border disabled:bg-panel disabled:text-fg-faint"
          >
            {installing ? (
              <RefreshCw size={13} className="animate-spin" />
            ) : (
              <DownloadCloud size={13} />
            )}
            {installing
              ? locale === 'zh-CN'
                ? '安装中...'
                : 'Installing...'
              : installed
                ? locale === 'zh-CN'
                  ? '更新'
                  : 'Update'
                : locale === 'zh-CN'
                  ? '一键安装'
                  : 'Install'}
          </button>
        </div>
      </div>
    </div>
  );
}

const SHORTCUT_ACTION_META: Record<
  ShortcutActionId,
  { titleKey: TranslationKey; descriptionKey: TranslationKey }
> = {
  'composer-send': {
    titleKey: 'settings.shortcutsComposerSendTitle',
    descriptionKey: 'settings.shortcutsComposerSendDescription',
  },
  'composer-newline': {
    titleKey: 'settings.shortcutsComposerNewlineTitle',
    descriptionKey: 'settings.shortcutsComposerNewlineDescription',
  },
  'return-search': {
    titleKey: 'settings.shortcutsReturnSearchTitle',
    descriptionKey: 'settings.shortcutsReturnSearchDescription',
  },
  'modal-close': {
    titleKey: 'settings.shortcutsCloseModalTitle',
    descriptionKey: 'settings.shortcutsCloseModalDescription',
  },
};

function shortcutActionTitle(locale: Locale, id: ShortcutActionId): string {
  return t(locale, SHORTCUT_ACTION_META[id].titleKey);
}

function ShortcutsSettings({
  locale,
  settings,
  onSettingsChange,
}: {
  locale: Locale;
  settings: ShortcutSettings;
  onSettingsChange: (settings: ShortcutSettings) => void;
}) {
  const [recordingId, setRecordingId] = useState<ShortcutActionId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<ShortcutActionId | null>(null);

  useEffect(() => {
    if (!savedId) return;
    const timeout = window.setTimeout(() => setSavedId(null), 1400);
    return () => window.clearTimeout(timeout);
  }, [savedId]);

  const commitSettings = (
    next: ShortcutSettings,
    savedActionId: ShortcutActionId | null,
  ) => {
    onSettingsChange(next);
    saveShortcutSettings(next);
    setRecordingId(null);
    setError(null);
    setSavedId(savedActionId);
  };

  const conflictMessage = (conflictId: ShortcutActionId) =>
    formatStatusMessage(t(locale, 'settings.shortcutsConflict'), {
      title: shortcutActionTitle(locale, conflictId),
    });

  const recordShortcut = (
    id: ShortcutActionId,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const binding = shortcutFromKeyboardEvent(event.nativeEvent);
    if (!binding) {
      setError(t(locale, 'settings.shortcutsInvalid'));
      return;
    }
    const conflictId = shortcutConflict(settings, id, binding);
    if (conflictId) {
      setError(conflictMessage(conflictId));
      return;
    }
    commitSettings(setShortcutBinding(settings, id, binding), id);
  };

  const resetShortcut = (id: ShortcutActionId) => {
    const conflictId = shortcutConflict(
      settings,
      id,
      DEFAULT_SHORTCUT_SETTINGS[id],
    );
    if (conflictId) {
      setRecordingId(null);
      setError(conflictMessage(conflictId));
      return;
    }
    commitSettings(resetShortcutBinding(settings, id), id);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-fg">
            {t(locale, 'settings.shortcutsTitle')}
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-fg-faint">
            {t(locale, 'settings.shortcutsDescription')}
          </p>
        </div>
        <button
          type="button"
          onClick={() => commitSettings(resetAllShortcutSettings(), null)}
          className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-border bg-bg px-3 text-xs font-medium text-fg-dim transition-colors hover:border-accent hover:text-fg"
        >
          <RefreshCw size={13} strokeWidth={2} />
          {t(locale, 'settings.shortcutsResetAll')}
        </button>
      </div>

      <div className="space-y-2">
        {SHORTCUT_ACTION_IDS.map((id) => {
          const binding = settings[id];
          const currentLabel = describeShortcutBinding(binding);
          const recording = recordingId === id;
          const meta = SHORTCUT_ACTION_META[id];
          return (
            <div
              key={id}
              className="grid gap-3 rounded-lg border border-border bg-bg-alt px-4 py-3 lg:grid-cols-[minmax(9rem,13rem)_minmax(0,1fr)_minmax(12rem,auto)] lg:items-center"
            >
              <ShortcutKeys keys={shortcutParts(binding)} />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="text-sm font-medium text-fg">
                    {t(locale, meta.titleKey)}
                  </div>
                  {savedId === id && (
                    <span className="rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                      {t(locale, 'settings.shortcutsSaved')}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-fg-faint">
                  {t(locale, meta.descriptionKey)}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                {recording ? (
                  <>
                    <button
                      type="button"
                      autoFocus
                      data-shortcut-recorder-active="true"
                      onKeyDown={(event) => recordShortcut(id, event)}
                      className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-accent bg-accent/10 px-3 text-xs font-medium text-accent outline-none ring-1 ring-accent/30"
                    >
                      <Keyboard size={13} strokeWidth={2} />
                      {t(locale, 'settings.shortcutsRecording')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setRecordingId(null);
                        setError(null);
                      }}
                      className="min-h-8 rounded-md border border-border bg-bg px-3 text-xs text-fg-dim transition-colors hover:border-accent hover:text-fg"
                    >
                      {t(locale, 'common.cancel')}
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setRecordingId(id);
                        setError(null);
                      }}
                      aria-label={`${t(locale, 'common.edit')}: ${currentLabel}`}
                      className="min-h-8 rounded-md border border-border bg-bg px-3 text-xs font-medium text-fg-dim transition-colors hover:border-accent hover:text-fg"
                    >
                      {t(locale, 'common.edit')}
                    </button>
                    <button
                      type="button"
                      onClick={() => resetShortcut(id)}
                      className="min-h-8 rounded-md border border-border bg-bg px-3 text-xs text-fg-faint transition-colors hover:border-accent hover:text-fg"
                    >
                      {t(locale, 'settings.shortcutsReset')}
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="space-y-1">
        {error && (
          <p className="text-xs font-medium text-rose-300">{error}</p>
        )}
        <p className="text-xs leading-relaxed text-fg-faint">
          {t(locale, 'settings.shortcutsRecordingHelp')}
        </p>
      </div>
    </div>
  );
}

function ShortcutKeys({ keys }: { keys: string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {keys.map((key, index) => (
        <span key={`${key}-${index}`} className="contents">
          {index > 0 && (
            <span className="font-mono text-[10px] text-fg-faint">+</span>
          )}
          <kbd className="min-w-8 rounded border border-border-soft bg-bg px-2 py-1 text-center font-mono text-[11px] text-fg">
            {key}
          </kbd>
        </span>
      ))}
    </div>
  );
}

function FreeChannelsSettings({ locale }: { locale: Locale }) {
  // Bumped after each row edit so status badges (ready / needs-key) re-read.
  const [revision, setRevision] = useState(0);
  const [localSetupOpen, setLocalSetupOpen] = useState(false);
  const [status, setStatus] = useState<{ tone: 'ok' | 'err'; msg: string } | null>(
    null,
  );
  const jsonImportInputRef = useRef<HTMLInputElement | null>(null);
  const refresh = () => setRevision((n) => n + 1);
  useEffect(() => {
    let disposed = false;
    void importFreeChannelKeysFromAutoConfig().then((ids) => {
      if (!disposed && ids.length > 0) refresh();
    });
    return () => {
      disposed = true;
    };
  }, []);

  const handleExportJson = async () => {
    setStatus(null);
    try {
      const saved = await exportJsonFile(
        exportFreeChannelsConfig(),
        'ultragamestudio-free-channels.json',
        t(locale, 'settings.freeChannels.title'),
      );
      if (!saved) return;
      setStatus({
        tone: 'ok',
        msg: t(locale, 'settings.channels.exportSuccess'),
      });
    } catch (err) {
      setStatus({
        tone: 'err',
        msg: `${t(locale, 'settings.channels.exportError')}: ${describeExportError(err, locale)}`,
      });
    }
  };

  const handleImportJson = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    setStatus(null);
    try {
      const result = importFreeChannelsConfig(await readJsonFile(file));
      refresh();
      void ensureFreeProxy();
      setStatus({
        tone: 'ok',
        msg: formatStatusMessage(t(locale, 'settings.channels.importFreeSuccess'), {
          n: result.keys,
          m: result.models,
          k: result.skipped,
        }),
      });
    } catch (err) {
      setStatus({
        tone: 'err',
        msg: `${t(locale, 'settings.channels.importError')}: ${describeError(err)}`,
      });
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-lg font-semibold text-fg">
            {t(locale, 'settings.freeChannels.title')}
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-fg-faint">
            {t(locale, 'settings.freeChannels.description')}
          </p>
        </div>
        <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto sm:shrink-0">
          <button
            type="button"
            onClick={() => void handleExportJson()}
            className="inline-flex items-center gap-1.5 rounded border border-border bg-panel px-2.5 py-1 text-xs text-fg-dim transition-colors hover:border-accent hover:text-fg"
          >
            <DownloadCloud size={13} strokeWidth={2.2} />
            {t(locale, 'settings.channels.exportJson')}
          </button>
          <button
            type="button"
            onClick={() => jsonImportInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 rounded border border-border bg-panel px-2.5 py-1 text-xs text-fg-dim transition-colors hover:border-accent hover:text-fg"
          >
            <UploadCloud size={13} strokeWidth={2.2} />
            {t(locale, 'settings.channels.importJson')}
          </button>
          <input
            ref={jsonImportInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(event) => void handleImportJson(event)}
          />
        </div>
      </div>
      {status && (
        <p
          className={cn(
            'text-[11px] leading-relaxed',
            status.tone === 'ok' ? 'text-emerald-300' : 'text-rose-300',
          )}
        >
          {status.msg}
        </p>
      )}
      <div className={SETTINGS_PROVIDER_GRID_CLASS}>
        {FREE_CHANNELS.map((channel) => (
          <FreeChannelRow
            key={channel.id}
            channel={channel}
            locale={locale}
            revision={revision}
            onChange={refresh}
            onLocalSetup={() => setLocalSetupOpen(true)}
          />
        ))}
      </div>
      {localSetupOpen && (
        <LocalModelSetupDialog
          locale={locale}
          downloadUrl={FREE_CHANNELS.find((c) => c.id === 'ollama')?.setupUrl}
          onClose={() => setLocalSetupOpen(false)}
          onModelSelected={(model) => {
            setFreeChannelModel('ollama', model);
            refresh();
            void ensureFreeProxy();
          }}
        />
      )}
    </div>
  );
}

function localChannelStatusBadge(
  locale: Locale,
  status: LocalModelRuntimeStatus | null,
  checking: boolean,
  configured: boolean,
): { label: string; cls: string; title?: string } {
  if (checking) {
    return {
      label: t(locale, 'settings.freeChannels.localChecking'),
      cls: 'border-sky-500/40 text-sky-300',
    };
  }
  if (!configured || status?.state === 'missing_model') {
    return {
      label: t(locale, 'settings.freeChannels.localMissingModel'),
      cls: 'border-amber-500/40 text-amber-300',
      title: status?.message ?? undefined,
    };
  }
  if (!status) {
    return {
      label: t(locale, 'settings.freeChannels.localConfigured'),
      cls: 'border-sky-500/40 text-sky-300',
    };
  }
  if (status.ready) {
    return {
      label: t(locale, 'settings.freeChannels.localReady'),
      cls: 'border-emerald-500/40 text-emerald-300',
    };
  }
  if (status.state === 'service_unavailable') {
    return {
      label: t(locale, 'settings.freeChannels.localServiceDown'),
      cls: 'border-amber-500/40 text-amber-300',
      title: status.message ?? undefined,
    };
  }
  if (status.state === 'model_missing') {
    return {
      label: t(locale, 'settings.freeChannels.localModelMissing'),
      cls: 'border-amber-500/40 text-amber-300',
      title: status.message ?? undefined,
    };
  }
  if (status.state === 'desktop_unavailable') {
    return {
      label: t(locale, 'settings.freeChannels.localDesktopOnly'),
      cls: 'border-sky-500/40 text-sky-300',
      title: status.message ?? undefined,
    };
  }
  if (status.state === 'unsupported') {
    return {
      label: t(locale, 'settings.freeChannels.localUnsupported'),
      cls: 'border-sky-500/40 text-sky-300',
      title: status.message ?? undefined,
    };
  }
  return {
    label: t(locale, 'settings.freeChannels.localServiceError'),
    cls: 'border-rose-500/40 text-rose-300',
    title: status.message ?? undefined,
  };
}

function FreeChannelRow({
  channel,
  locale,
  revision,
  onChange,
  onLocalSetup,
}: {
  channel: FreeChannel;
  locale: Locale;
  revision: number;
  onChange: () => void;
  onLocalSetup: () => void;
}) {
  const [keyValue, setKeyValue] = useState(() => getFreeChannelKey(channel.id));
  const [modelValue, setModelValue] = useState(() =>
    getFreeChannelModelOverride(channel.id),
  );
  const [showKey, setShowKey] = useState(false);
  const [probeRevision, setProbeRevision] = useState(0);
  const [localStatus, setLocalStatus] =
    useState<LocalModelRuntimeStatus | null>(null);
  const [checkingLocalStatus, setCheckingLocalStatus] = useState(false);
  const [modelRefresh, setModelRefresh] = useState<{
    loading: boolean;
    error: string | null;
  }>({ loading: false, error: null });
  useEffect(() => {
    setKeyValue(getFreeChannelKey(channel.id));
    setModelValue(getFreeChannelModelOverride(channel.id));
  }, [channel.id, revision]);

  useEffect(() => {
    if (!channel.local) return;
    const model = getFreeChannelModelOverride(channel.id);
    if (!model.trim()) {
      setLocalStatus({
        channelId: channel.id,
        configuredModel: '',
        reachable: false,
        ready: false,
        state: 'missing_model',
        models: [],
        message: null,
      });
      setCheckingLocalStatus(false);
      return;
    }
    let disposed = false;
    setCheckingLocalStatus(true);
    void localModelStatus(channel.id, model)
      .then((status) => {
        if (!disposed) setLocalStatus(status);
      })
      .catch((err) => {
        if (disposed) return;
        setLocalStatus({
          channelId: channel.id,
          configuredModel: model,
          reachable: false,
          ready: false,
          state: 'service_unavailable',
          models: [],
          message: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        if (!disposed) setCheckingLocalStatus(false);
      });
    return () => {
      disposed = true;
    };
  }, [channel.id, channel.local, revision, probeRevision]);

  const ready = freeChannelReady(channel.id);
  const transportLabel =
    channel.transport === 'anthropic'
      ? t(locale, 'settings.freeChannels.transportAnthropic')
      : channel.transport === 'openai'
        ? t(locale, 'settings.freeChannels.transportOpenai')
        : t(locale, 'settings.freeChannels.transportAuto');

  // Re-register the proxy with the latest keys/models. Cheap + idempotent;
  // fired on blur rather than per keystroke.
  const reproxy = () => {
    void ensureFreeProxy();
  };
  const commitKey = (value: string): boolean => {
    const trimmed = value.trim();
    setKeyValue(trimmed);
    const changed = setFreeChannelKey(channel.id, trimmed);
    if (changed) onChange();
    return changed;
  };
  const commitModel = (value: string): boolean => {
    const trimmed = value.trim();
    setModelValue(trimmed);
    const changed = setFreeChannelModel(channel.id, trimmed);
    if (changed) onChange();
    return changed;
  };
  const refreshModels = async () => {
    setModelRefresh({ loading: true, error: null });
    try {
      const result = await refreshFreeChannelModels(channel);
      setModelRefresh({
        loading: false,
        error: result.error ?? null,
      });
      onChange();
    } catch (err) {
      setModelRefresh({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const status: { label: string; cls: string; title?: string } = channel.local
    ? localChannelStatusBadge(locale, localStatus, checkingLocalStatus, ready)
    : ready
      ? {
          label: t(locale, 'settings.freeChannels.ready'),
          cls: 'border-emerald-500/40 text-emerald-300',
        }
      : {
          label: t(locale, 'settings.freeChannels.needsKey'),
          cls: 'border-amber-500/40 text-amber-300',
        };

  const KeyIcon = showKey ? EyeOff : Eye;
  const modelOptions = freeChannelModelOptions(channel);
  const modelCacheKey = freeChannelModelCacheKey(channel.id);
  const canRefreshModels = canRefreshFreeChannelModels(channel);

  return (
    <div className="space-y-3 rounded-lg border border-border bg-bg-alt p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-fg">{channel.label}</span>
        <span
          title={status.title}
          className={cn(
            'rounded border px-1.5 py-0.5 text-[10px] font-medium',
            status.cls,
          )}
        >
          {status.label}
        </span>
        <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-fg-faint">
          {transportLabel}
        </span>
        <span className="min-w-0 flex-1" />
        {channel.id === 'ollama' && (
          <button
            type="button"
            onClick={onLocalSetup}
            className="inline-flex items-center gap-1 rounded-md border border-accent/40 bg-accent/10 px-2 py-1 text-[11px] font-medium text-accent transition-colors hover:bg-accent/15"
          >
            <DownloadCloud size={12} strokeWidth={2.1} />
            {t(locale, 'settings.freeChannels.localSetup')}
          </button>
        )}
        {channel.local && (
          <button
            type="button"
            onClick={() => setProbeRevision((n) => n + 1)}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-panel px-2 py-1 text-[11px] text-fg-dim transition-colors hover:border-accent hover:text-fg"
            title={t(locale, 'settings.freeChannels.localStatusHint')}
          >
            <RefreshCw
              size={11}
              strokeWidth={2}
              className={checkingLocalStatus ? 'animate-spin' : undefined}
            />
            {t(locale, 'settings.freeChannels.localRecheck')}
          </button>
        )}
        {channel.local && channel.id !== 'ollama' && channel.setupUrl && (
          <button
            type="button"
            onClick={() => void openExternal(channel.setupUrl as string)}
            className="inline-flex items-center gap-1 rounded-md border border-accent/40 bg-accent/10 px-2 py-1 text-[11px] font-medium text-accent transition-colors hover:bg-accent/15"
          >
            <ExternalLink size={11} strokeWidth={2} />
            {t(locale, 'dock.localModelDownload')}
          </button>
        )}
        {channel.credentialUrl && (
          <button
            type="button"
            onClick={() => void openExternal(channel.credentialUrl as string)}
            className="inline-flex items-center gap-1 text-[11px] text-accent transition-colors hover:underline"
          >
            {t(locale, 'settings.freeChannels.getKey')}
            <ExternalLink size={11} strokeWidth={2} />
          </button>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {channel.needsKey && (
          <label className="block space-y-1">
            <span className="text-[11px] font-medium text-fg-dim">
              {t(locale, 'settings.freeChannels.apiKeyLabel')}
            </span>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={keyValue}
                onChange={(event) => setKeyValue(event.target.value)}
                onBlur={() => {
                  if (commitKey(keyValue)) reproxy();
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
                placeholder={t(locale, 'settings.freeChannels.apiKeyPlaceholder')}
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded-md border border-border bg-panel px-2.5 py-1.5 pr-14 text-sm text-fg outline-none transition-colors focus:border-accent"
              />
              <div className="absolute inset-y-0 right-1 flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  title={t(
                    locale,
                    showKey
                      ? 'settings.models.hideKey'
                      : 'settings.models.showKey',
                  )}
                  className="flex h-6 w-6 items-center justify-center rounded text-fg-faint transition-colors hover:text-fg"
                >
                  <KeyIcon size={13} strokeWidth={2} />
                </button>
                {keyValue && (
                  <button
                    type="button"
                    onClick={() => {
                      if (commitKey('')) reproxy();
                    }}
                    title={t(locale, 'settings.freeChannels.clear')}
                    className="flex h-6 w-6 items-center justify-center rounded text-fg-faint transition-colors hover:text-rose-300"
                  >
                    <Trash2 size={13} strokeWidth={2} />
                  </button>
                )}
              </div>
            </div>
          </label>
        )}
        <EditableModelSelect
          className="block space-y-1 sm:col-span-2"
          cacheKey={modelCacheKey}
          builtins={modelOptions}
          value={modelValue.trim()}
          label={t(locale, 'settings.freeChannels.modelLabel')}
          locale={locale}
          loading={modelRefresh.loading}
          error={modelRefresh.error}
          canRefresh={canRefreshModels}
          onChange={(next) => {
            if (commitModel(next)) reproxy();
          }}
          onAddModel={(next) => {
            if (commitModel(next)) reproxy();
          }}
          onRemoveModel={(_removed, nextValue) => {
            if (nextValue !== modelValue.trim() && commitModel(nextValue)) {
              reproxy();
            }
          }}
          onRefresh={() => void refreshModels()}
        />
      </div>

      {channel.note && (
        <p className="text-[11px] leading-relaxed text-fg-faint">
          {channel.note}
        </p>
      )}
    </div>
  );
}

type EditableGameExpertEngine = Exclude<GameExpertEngine, 'auto' | 'custom'>;

interface GameExpertEditorDraft {
  id: string;
  name: string;
  group: string;
  summary: string;
  role: string;
  triggersText: string;
  guidanceText: string;
  boundariesText: string;
  engineAffinity: EditableGameExpertEngine[];
  defaultRank: number;
}

const EDITABLE_GAME_EXPERT_ENGINES: EditableGameExpertEngine[] = [
  'unity',
  'unreal',
  'godot',
  'web',
];

function splitExpertLines(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value.split(/[\n,]+/)) {
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function slugGameExpertId(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'custom-expert'
  );
}

function uniqueGameExpertId(base: string, catalog: readonly GameExpertDefinition[]): string {
  const used = new Set(catalog.map((expert) => expert.id));
  const slug = slugGameExpertId(base);
  if (!used.has(slug)) return slug;
  let index = 2;
  while (used.has(`${slug}-${index}`)) index += 1;
  return `${slug}-${index}`;
}

function expertToDraft(expert: GameExpertDefinition): GameExpertEditorDraft {
  return {
    id: expert.id,
    name: expert.name,
    group: expert.group,
    summary: expert.summary,
    role: expert.role,
    triggersText: expert.triggers.join('\n'),
    guidanceText: expert.guidance.join('\n'),
    boundariesText: expert.boundaries.join('\n'),
    engineAffinity: [...(expert.engineAffinity ?? [])],
    defaultRank: expert.defaultRank,
  };
}

function newExpertDraft(
  catalog: readonly GameExpertDefinition[],
): GameExpertEditorDraft {
  const id = uniqueGameExpertId('custom-expert', catalog);
  return {
    id,
    name: '',
    group: 'Custom',
    summary: '',
    role: '',
    triggersText: '',
    guidanceText: '',
    boundariesText: '',
    engineAffinity: [],
    defaultRank: catalog.length + 1,
  };
}

function draftToExpert(draft: GameExpertEditorDraft): GameExpertDefinition | null {
  const id = slugGameExpertId(draft.id);
  const name = draft.name.trim();
  if (!id || !name) return null;
  return {
    id,
    name,
    group: draft.group.trim() || 'Custom',
    summary: draft.summary.trim() || name,
    role: draft.role.trim() || `作为 ${name} 提供游戏开发建议。`,
    triggers: splitExpertLines(draft.triggersText).length
      ? splitExpertLines(draft.triggersText)
      : [name.toLowerCase()],
    guidance: splitExpertLines(draft.guidanceText).length
      ? splitExpertLines(draft.guidanceText)
      : ['给出可执行、可验证的建议'],
    boundaries: splitExpertLines(draft.boundariesText).length
      ? splitExpertLines(draft.boundariesText)
      : ['避免脱离项目目标和实现约束'],
    engineAffinity: draft.engineAffinity.length
      ? [...draft.engineAffinity]
      : undefined,
    defaultRank: Math.max(1, Math.round(draft.defaultRank || 999)),
  };
}

export function GameExpertSettingsPanel({
  locale,
  settings,
  setSettings,
  embedded = false,
}: {
  locale: Locale;
  settings: GameExpertSettingsValues;
  setSettings: (patch: Partial<GameExpertSettingsValues>) => void;
  embedded?: boolean;
}) {
  const catalog = useMemo(() => getGameExpertCatalog(settings), [settings]);
  const enabledExpertIds = new Set(settings.enabledExpertIds);
  const enabledCount = catalog.filter((expert) =>
    enabledExpertIds.has(expert.id),
  ).length;
  // Category tabs derived from expert groups, mirroring the commercial/free
  // segmented control used by the image/music/3D channel panels. 'all' is a
  // synthetic sentinel that shows every expert.
  const groupOrder = useMemo(() => {
    const seen = new Set<string>();
    const groups: string[] = [];
    for (const expert of catalog) {
      if (!seen.has(expert.group)) {
        seen.add(expert.group);
        groups.push(expert.group);
      }
    }
    return groups;
  }, [catalog]);
  const [activeGroup, setActiveGroup] = useState<string>('all');
  // Tracks which expert's slash command was just copied, to flash a check icon.
  const [copiedCommandId, setCopiedCommandId] = useState<string | null>(null);
  // If the active group disappears (e.g. its only expert was deleted), fall back
  // to 'all' so the grid never renders empty for a stale selection.
  useEffect(() => {
    if (activeGroup !== 'all' && !groupOrder.includes(activeGroup)) {
      setActiveGroup('all');
    }
  }, [activeGroup, groupOrder]);
  const visibleExperts = useMemo(
    () =>
      activeGroup === 'all'
        ? catalog
        : catalog.filter((expert) => expert.group === activeGroup),
    [activeGroup, catalog],
  );
  const [draft, setDraft] = useState<GameExpertEditorDraft | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<GameExpertDefinition | null>(
    null,
  );

  const closeEditor = () => {
    setDraft(null);
    setFormError(null);
  };

  const setExpertEnabled = (id: string, enabled: boolean) => {
    const next = new Set(settings.enabledExpertIds);
    if (enabled) next.add(id);
    else next.delete(id);
    setSettings({
      enabledExpertIds: catalog.map((expert) => expert.id).filter((expertId) =>
        next.has(expertId),
      ),
    });
  };

  const saveDraft = () => {
    if (!draft) return;
    const expert = draftToExpert(draft);
    if (!expert) {
      setFormError(t(locale, 'settings.gameExperts.editorInvalid'));
      return;
    }

    const customExperts = [
      ...settings.customExperts.filter((item) => item.id !== expert.id),
      expert,
    ].sort((a, b) => a.defaultRank - b.defaultRank || a.name.localeCompare(b.name));
    const deletedExpertIds = settings.deletedExpertIds.filter(
      (id) => id !== expert.id,
    );
    const enabled = new Set(settings.enabledExpertIds);
    enabled.add(expert.id);
    const nextCatalog = getGameExpertCatalog({ customExperts, deletedExpertIds });
    setSettings({
      customExperts,
      deletedExpertIds,
      enabledExpertIds: nextCatalog
        .map((item) => item.id)
        .filter((id) => enabled.has(id)),
    });
    closeEditor();
  };

  const deleteExpert = (expert: GameExpertDefinition) => {
    const isBuiltIn = GAME_EXPERT_IDS.includes(expert.id);
    const customExperts = settings.customExperts.filter(
      (item) => item.id !== expert.id,
    );
    const deleted = new Set(settings.deletedExpertIds);
    if (isBuiltIn) deleted.add(expert.id);
    else deleted.delete(expert.id);
    const deletedExpertIds = [...deleted].filter(
      (id) => GAME_EXPERT_IDS.includes(id) || customExperts.some((item) => item.id === id),
    );
    const nextCatalog = getGameExpertCatalog({ customExperts, deletedExpertIds });
    const enabled = new Set(settings.enabledExpertIds);
    enabled.delete(expert.id);
    setSettings({
      customExperts,
      deletedExpertIds,
      enabledExpertIds: nextCatalog
        .map((item) => item.id)
        .filter((id) => enabled.has(id)),
    });
    setDeleteTarget(null);
    if (draft?.id === expert.id) closeEditor();
  };

  return (
    <div className="space-y-5">
      {!embedded && (
        <div>
          <h3 className="text-lg font-semibold text-fg">
            {t(locale, 'settings.gameExperts.title')}
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-fg-faint">
            {t(locale, 'settings.gameExperts.description')}
          </p>
        </div>
      )}

      {!embedded && (
        <SettingRow
          title={t(locale, 'settings.gameExperts.enabledLabel')}
          description={t(locale, 'settings.gameExperts.enabledDesc')}
        >
          <SwitchControl
            checked={settings.enabled}
            onChange={(enabled) => setSettings({ enabled })}
          />
        </SettingRow>
      )}

      <SettingRow
        title={t(locale, 'settings.gameExperts.engineLabel')}
        description={t(locale, 'settings.gameExperts.engineDesc')}
      >
        <div className="w-full min-w-[14rem]">
          <SelectControl
            value={settings.engine}
            options={gameExpertEngineOptions(locale)}
            onChange={(engine) => setSettings({ engine })}
            icon={<Gamepad2 size={15} strokeWidth={2.1} />}
          />
        </div>
      </SettingRow>

      <SettingRow
        title={t(locale, 'settings.gameExperts.modeLabel')}
        description={t(locale, 'settings.gameExperts.modeDesc')}
      >
        <div className="w-full min-w-[14rem]">
          <SelectControl
            value={settings.mode}
            options={gameExpertModeOptions(locale)}
            onChange={(mode) => setSettings({ mode })}
            icon={<Cpu size={15} strokeWidth={2.1} />}
          />
        </div>
      </SettingRow>

      <SettingRow
        title={t(locale, 'settings.gameExperts.maxExpertsLabel')}
        description={t(locale, 'settings.gameExperts.maxExpertsDesc')}
      >
        <StepperControl
          value={settings.maxExperts}
          min={GAME_EXPERT_LIMITS.maxExperts.min}
          max={GAME_EXPERT_LIMITS.maxExperts.max}
          onChange={(maxExperts) => setSettings({ maxExperts })}
        />
      </SettingRow>

      <section className="rounded-lg border border-border bg-bg-alt p-4">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h4 className="text-sm font-semibold text-fg">
              {t(locale, 'settings.gameExperts.poolTitle')}
            </h4>
            <p className="text-xs leading-relaxed text-fg-faint">
              {t(locale, 'settings.gameExperts.poolDesc')}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <StatusBadge
              state="default"
              label={formatStatusMessage(
                t(locale, 'settings.gameExperts.enabledCount'),
                { n: enabledCount, total: catalog.length },
              )}
            />
            <button
              type="button"
              onClick={() => {
                setDraft(newExpertDraft(catalog));
                setFormError(null);
              }}
              className="inline-flex items-center gap-1 rounded border border-accent/40 bg-accent/15 px-2 py-1 text-[11px] text-accent transition-colors hover:bg-accent/20"
            >
              <Plus size={12} strokeWidth={2.2} />
              {t(locale, 'settings.gameExperts.newExpert')}
            </button>
            <button
              type="button"
              onClick={() =>
                setSettings({
                  enabledExpertIds: catalog.map((expert) => expert.id),
                })
              }
              className="rounded border border-border bg-panel px-2 py-1 text-[11px] text-fg-dim transition-colors hover:border-accent hover:text-fg"
            >
              {t(locale, 'settings.gameExperts.selectAll')}
            </button>
          </div>
        </div>

        <div
          role="tablist"
          aria-orientation="horizontal"
          className="mb-3 flex flex-wrap gap-1.5"
        >
          {['all', ...groupOrder].map((group) => {
            const active = activeGroup === group;
            const label =
              group === 'all'
                ? t(locale, 'settings.gameExperts.categoryAll')
                : localizedGameGroupLabel(group, locale);
            const count =
              group === 'all'
                ? catalog.length
                : catalog.filter((expert) => expert.group === group).length;
            return (
              <button
                key={group}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setActiveGroup(group)}
                className={cn(
                  'rounded-md border px-2.5 py-1 text-[11px] font-semibold outline-none transition-colors focus-visible:ring-1 focus-visible:ring-accent',
                  active
                    ? 'border-accent bg-accent text-bg'
                    : 'border-border bg-panel text-fg-faint hover:border-accent hover:text-fg',
                )}
              >
                {label}
                <span
                  className={cn(
                    'ml-1.5 tabular-nums',
                    active ? 'text-bg/70' : 'text-fg-faint/70',
                  )}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          {visibleExperts.map((expert) => {
            const checked = enabledExpertIds.has(expert.id);
            const isCustom = settings.customExperts.some(
              (item) => item.id === expert.id,
            );
            return (
              <div
                key={expert.id}
                className={cn(
                  'min-h-[5.75rem] rounded-md border p-3 text-left transition-colors',
                  checked
                    ? 'border-accent bg-accent/10 text-fg'
                    : 'border-border bg-panel text-fg-dim hover:border-accent hover:text-fg',
                )}
              >
                <div className="flex items-start gap-2">
                  <button
                    type="button"
                    aria-pressed={checked}
                    onClick={() => setExpertEnabled(expert.id, !checked)}
                    className="flex min-w-0 flex-1 items-start gap-2 text-left"
                  >
                    <span
                      className={cn(
                        'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border',
                        checked
                          ? 'border-accent bg-accent text-bg'
                          : 'border-border bg-bg text-transparent',
                      )}
                    >
                      <Check size={13} strokeWidth={2.4} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">
                        {isCustom
                          ? expert.name
                          : localizedGameExpertName(expert, locale)}
                      </span>
                      <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] uppercase text-fg-faint">
                        <span>
                          {isCustom
                            ? expert.group
                            : localizedGameExpertGroup(expert, locale)}
                        </span>
                        {isCustom && (
                          <span className="rounded border border-accent/30 px-1.5 py-0.5 normal-case text-accent">
                            {t(locale, 'settings.gameExperts.customBadge')}
                          </span>
                        )}
                      </span>
                      <span className="mt-1 block text-xs leading-relaxed text-fg-faint">
                        {expert.summary}
                      </span>
                    </span>
                  </button>
                  <div className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      title={t(locale, 'settings.gameExperts.edit')}
                      aria-label={t(locale, 'settings.gameExperts.edit')}
                      onClick={() => {
                        setDraft(expertToDraft(expert));
                        setFormError(null);
                      }}
                      className="flex h-7 w-7 items-center justify-center rounded border border-border bg-bg text-fg-faint transition-colors hover:border-accent hover:text-fg"
                    >
                      <Pencil size={13} strokeWidth={2.2} />
                    </button>
                    <button
                      type="button"
                      title={t(locale, 'settings.gameExperts.delete')}
                      aria-label={t(locale, 'settings.gameExperts.delete')}
                      onClick={() => setDeleteTarget(expert)}
                      className="flex h-7 w-7 items-center justify-center rounded border border-border bg-bg text-fg-faint transition-colors hover:border-[#f78b8b] hover:text-[#f78b8b]"
                    >
                      <Trash2 size={13} strokeWidth={2.2} />
                    </button>
                  </div>
                </div>
                <button
                  type="button"
                  title={t(locale, 'settings.gameExperts.copyCommand')}
                  aria-label={formatStatusMessage(
                    t(locale, 'settings.gameExperts.copyCommand'),
                    { command: gameExpertSlashCommand(expert) },
                  )}
                  onClick={() => {
                    const command = gameExpertSlashCommand(expert);
                    void navigator.clipboard?.writeText(command).then(
                      () => {
                        setCopiedCommandId(expert.id);
                        window.setTimeout(() => {
                          setCopiedCommandId((current) =>
                            current === expert.id ? null : current,
                          );
                        }, 1500);
                      },
                      () => {},
                    );
                  }}
                  className="mt-2 inline-flex max-w-full items-center gap-1.5 rounded border border-border bg-bg px-2 py-1 font-mono text-[11px] text-fg-dim transition-colors hover:border-accent hover:text-fg"
                >
                  {copiedCommandId === expert.id ? (
                    <Check size={12} strokeWidth={2.4} className="text-accent" />
                  ) : (
                    <Copy size={12} strokeWidth={2.2} />
                  )}
                  <span className="truncate">{gameExpertSlashCommand(expert)}</span>
                </button>
              </div>
            );
          })}
        </div>
      </section>

      {draft && (
        <GameExpertEditor
          locale={locale}
          draft={draft}
          error={formError}
          onChange={(next) => {
            setDraft(next);
            setFormError(null);
          }}
          onCancel={closeEditor}
          onSave={saveDraft}
        />
      )}

      {deleteTarget && (
        <GameExpertDeleteDialog
          locale={locale}
          expert={deleteTarget}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => deleteExpert(deleteTarget)}
        />
      )}
    </div>
  );
}

function GameExpertEditor({
  locale,
  draft,
  error,
  onChange,
  onCancel,
  onSave,
}: {
  locale: Locale;
  draft: GameExpertEditorDraft;
  error: string | null;
  onChange: (draft: GameExpertEditorDraft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const update = <K extends keyof GameExpertEditorDraft>(
    key: K,
    value: GameExpertEditorDraft[K],
  ) => onChange({ ...draft, [key]: value });
  const textInputClass =
    'w-full rounded-md border border-border bg-panel px-2.5 py-1.5 text-sm text-fg outline-none transition-colors focus:border-accent';
  const areaClass =
    'min-h-[4.5rem] w-full resize-y rounded-md border border-border bg-panel px-2.5 py-1.5 text-sm text-fg outline-none transition-colors focus:border-accent';

  return (
    <div
      className="fixed inset-0 z-[70] bg-black/60 sm:flex sm:items-center sm:justify-center sm:p-6"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="game-expert-editor-title"
        data-game-expert-editor="true"
        data-settings-child-modal="true"
        className="fixed inset-x-0 bottom-0 flex max-h-[calc(100vh-1rem)] flex-col overflow-hidden rounded-t-lg border border-border bg-panel shadow-2xl sm:relative sm:inset-auto sm:max-h-[calc(100vh-3rem)] sm:w-[min(760px,calc(100vw-2rem))] sm:rounded-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="shrink-0 border-b border-border-soft bg-bg-alt px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <h5
                id="game-expert-editor-title"
                className="text-base font-semibold text-fg"
              >
                {t(locale, 'settings.gameExperts.editorTitle')}
              </h5>
              <p className="mt-1 text-xs leading-relaxed text-fg-faint">
                {draft.name || t(locale, 'settings.gameExperts.newExpert')}
              </p>
            </div>
            <button
              type="button"
              title={t(locale, 'common.close')}
              aria-label={t(locale, 'common.close')}
              onClick={onCancel}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-panel-2 text-fg-faint transition-colors hover:border-accent hover:text-fg"
            >
              <X size={15} strokeWidth={2.2} />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs text-fg-faint">
              <span>{t(locale, 'settings.gameExperts.editorId')}</span>
              <input
                type="text"
                value={draft.id}
                readOnly
                className={cn(textInputClass, 'font-mono text-xs text-fg-faint')}
              />
            </label>
            <label className="space-y-1 text-xs text-fg-faint">
              <span>{t(locale, 'settings.gameExperts.editorName')}</span>
              <input
                type="text"
                value={draft.name}
                onChange={(event) => update('name', event.target.value)}
                className={textInputClass}
              />
            </label>
            <label className="space-y-1 text-xs text-fg-faint">
              <span>{t(locale, 'settings.gameExperts.editorGroup')}</span>
              <input
                type="text"
                value={draft.group}
                onChange={(event) => update('group', event.target.value)}
                className={textInputClass}
              />
            </label>
            <label className="space-y-1 text-xs text-fg-faint">
              <span>{t(locale, 'settings.gameExperts.editorSummary')}</span>
              <input
                type="text"
                value={draft.summary}
                onChange={(event) => update('summary', event.target.value)}
                className={textInputClass}
              />
            </label>
          </div>

          <div className="mt-3 grid gap-3">
            <label className="space-y-1 text-xs text-fg-faint">
              <span>{t(locale, 'settings.gameExperts.editorRole')}</span>
              <textarea
                value={draft.role}
                onChange={(event) => update('role', event.target.value)}
                className={areaClass}
              />
            </label>
            <label className="space-y-1 text-xs text-fg-faint">
              <span>{t(locale, 'settings.gameExperts.editorTriggers')}</span>
              <textarea
                value={draft.triggersText}
                onChange={(event) => update('triggersText', event.target.value)}
                className={areaClass}
              />
            </label>
            <label className="space-y-1 text-xs text-fg-faint">
              <span>{t(locale, 'settings.gameExperts.editorGuidance')}</span>
              <textarea
                value={draft.guidanceText}
                onChange={(event) => update('guidanceText', event.target.value)}
                className={areaClass}
              />
            </label>
            <label className="space-y-1 text-xs text-fg-faint">
              <span>{t(locale, 'settings.gameExperts.editorBoundaries')}</span>
              <textarea
                value={draft.boundariesText}
                onChange={(event) => update('boundariesText', event.target.value)}
                className={areaClass}
              />
            </label>
          </div>

          <div className="mt-3 space-y-2">
            <span className="text-xs text-fg-faint">
              {t(locale, 'settings.gameExperts.editorAffinity')}
            </span>
            <div className="flex flex-wrap gap-2">
              {EDITABLE_GAME_EXPERT_ENGINES.map((engine) => {
                const active = draft.engineAffinity.includes(engine);
                return (
                  <button
                    key={engine}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      const next = active
                        ? draft.engineAffinity.filter((item) => item !== engine)
                        : [...draft.engineAffinity, engine];
                      update('engineAffinity', next);
                    }}
                    className={cn(
                      'rounded border px-2 py-1 text-[11px] transition-colors',
                      active
                        ? 'border-accent bg-accent/15 text-fg'
                        : 'border-border bg-panel text-fg-faint hover:border-accent hover:text-fg',
                    )}
                  >
                    {engine === 'web'
                      ? 'Web'
                      : engine[0].toUpperCase() + engine.slice(1)}
                  </button>
                );
              })}
            </div>
          </div>

          {error && <p className="mt-3 text-xs text-[#f78b8b]">{error}</p>}
        </div>

        <div className="shrink-0 border-t border-border-soft bg-bg-alt px-5 py-3">
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded border border-border bg-panel px-3 py-1.5 text-xs text-fg-dim transition-colors hover:border-accent hover:text-fg"
            >
              {t(locale, 'common.cancel')}
            </button>
            <button
              type="button"
              onClick={onSave}
              className="rounded border border-accent bg-accent/15 px-3 py-1.5 text-xs font-medium text-accent transition-colors hover:bg-accent/20"
            >
              {t(locale, 'common.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function GameExpertDeleteDialog({
  locale,
  expert,
  onCancel,
  onConfirm,
}: {
  locale: Locale;
  expert: GameExpertDefinition;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[70] bg-black/60 sm:flex sm:items-center sm:justify-center sm:p-6"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="game-expert-delete-title"
        data-game-expert-delete="true"
        data-settings-child-modal="true"
        className="fixed inset-x-0 bottom-0 overflow-hidden rounded-t-lg border border-border bg-panel shadow-2xl sm:relative sm:inset-auto sm:w-[min(440px,calc(100vw-2rem))] sm:rounded-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="border-b border-border-soft bg-bg-alt px-5 py-4">
          <h5
            id="game-expert-delete-title"
            className="text-base font-semibold text-fg"
          >
            {t(locale, 'settings.gameExperts.delete')}
          </h5>
          <p className="mt-2 text-sm leading-relaxed text-fg-dim">
            {formatStatusMessage(t(locale, 'settings.gameExperts.deleteConfirm'), {
              name: localizedGameExpertName(expert, locale),
            })}
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-2 px-5 py-4">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-border bg-panel-2 px-3 py-1.5 text-xs text-fg-dim transition-colors hover:border-accent hover:text-fg"
          >
            {t(locale, 'common.cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded border border-[#f78b8b]/60 bg-[#f78b8b]/15 px-3 py-1.5 text-xs font-medium text-[#f78b8b] transition-colors hover:bg-[#f78b8b]/20"
          >
            {t(locale, 'common.delete')}
          </button>
        </div>
      </div>
    </div>
  );
}

function gameExpertEngineOptions(
  locale: Locale,
): Array<{ id: GameExpertEngine; label: string; hint?: string }> {
  return [
    {
      id: 'auto',
      label: t(locale, 'settings.gameExperts.engineAuto'),
      hint: 'auto',
    },
    { id: 'unity', label: 'Unity', hint: 'C#' },
    { id: 'unreal', label: 'Unreal', hint: 'UE' },
    { id: 'godot', label: 'Godot', hint: 'GDScript' },
    { id: 'web', label: t(locale, 'settings.gameExperts.engineWeb'), hint: 'web' },
    {
      id: 'custom',
      label: t(locale, 'settings.gameExperts.engineCustom'),
      hint: 'custom',
    },
  ];
}

function gameExpertModeOptions(
  locale: Locale,
): Array<{ id: GameExpertMode; label: string; hint?: string }> {
  return [
    {
      id: 'light',
      label: t(locale, 'settings.gameExperts.modeLight'),
      hint: 'short',
    },
    {
      id: 'standard',
      label: t(locale, 'settings.gameExperts.modeStandard'),
      hint: '3x',
    },
    {
      id: 'council',
      label: t(locale, 'settings.gameExperts.modeCouncil'),
      hint: 'deep',
    },
  ];
}

function ConsensusSettings({ locale }: { locale: Locale }) {
  const [s, setS] = useState<ConsensusSettingsValues>(() => getConsensusSettings());
  const update = <K extends keyof ConsensusSettingsValues>(
    key: K,
    value: ConsensusSettingsValues[K],
  ) => {
    setConsensusSetting(key, value);
    setS(getConsensusSettings());
  };

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-lg font-semibold text-fg">
          {t(locale, 'settings.consensusTitle')}
        </h3>
        <p className="mt-1 text-xs leading-relaxed text-fg-faint">
          {t(locale, 'settings.consensusDescription')}
        </p>
      </div>

      <SettingRow
        title={t(locale, 'settings.consensus.genEnabledLabel')}
        description={t(locale, 'settings.consensus.genEnabledDesc')}
      >
        <SwitchControl
          checked={s.genEnabled}
          onChange={(v) => update('genEnabled', v)}
        />
      </SettingRow>

      <SettingRow
        title={t(locale, 'settings.consensus.genCandidatesLabel')}
        description={t(locale, 'settings.consensus.genCandidatesDesc')}
      >
        <StepperControl
          value={s.genCandidates}
          min={CONSENSUS_LIMITS.genCandidates.min}
          max={CONSENSUS_LIMITS.genCandidates.max}
          disabled={!s.genEnabled}
          onChange={(v) => update('genCandidates', v)}
        />
      </SettingRow>

      <SettingRow
        title={t(locale, 'settings.consensus.voteSamplesLabel')}
        description={t(locale, 'settings.consensus.voteSamplesDesc')}
      >
        <StepperControl
          value={s.voteSamples}
          min={CONSENSUS_LIMITS.voteSamples.min}
          max={CONSENSUS_LIMITS.voteSamples.max}
          onChange={(v) => update('voteSamples', v)}
        />
      </SettingRow>

      <SettingRow
        title={t(locale, 'settings.consensus.concurrencyLabel')}
        description={t(locale, 'settings.consensus.concurrencyDesc')}
      >
        <StepperControl
          value={s.concurrency}
          min={CONSENSUS_LIMITS.concurrency.min}
          max={CONSENSUS_LIMITS.concurrency.max}
          onChange={(v) => update('concurrency', v)}
        />
      </SettingRow>

      <SettingRow
        title={t(locale, 'settings.consensus.slowConcurrencyLabel')}
        description={t(locale, 'settings.consensus.slowConcurrencyDesc')}
      >
        <StepperControl
          value={s.slowConcurrency}
          min={CONSENSUS_LIMITS.slowConcurrency.min}
          max={CONSENSUS_LIMITS.slowConcurrency.max}
          onChange={(v) => update('slowConcurrency', v)}
        />
      </SettingRow>

      <SettingRow
        title={t(locale, 'settings.consensus.standardConcurrencyLabel')}
        description={t(locale, 'settings.consensus.standardConcurrencyDesc')}
      >
        <StepperControl
          value={s.standardConcurrency}
          min={CONSENSUS_LIMITS.standardConcurrency.min}
          max={CONSENSUS_LIMITS.standardConcurrency.max}
          onChange={(v) => update('standardConcurrency', v)}
        />
      </SettingRow>

      <SettingRow
        title={t(locale, 'settings.consensus.fastConcurrencyLabel')}
        description={t(locale, 'settings.consensus.fastConcurrencyDesc')}
      >
        <StepperControl
          value={s.fastConcurrency}
          min={CONSENSUS_LIMITS.fastConcurrency.min}
          max={CONSENSUS_LIMITS.fastConcurrency.max}
          onChange={(v) => update('fastConcurrency', v)}
        />
      </SettingRow>

      <SettingRow
        title={t(locale, 'settings.consensus.autoSuggestLabel')}
        description={t(locale, 'settings.consensus.autoSuggestDesc')}
      >
        <SwitchControl
          checked={s.autoSuggest}
          onChange={(v) => update('autoSuggest', v)}
        />
      </SettingRow>

      <div className="border-t border-border pt-4">
        <h4 className="text-sm font-semibold text-fg">
          {t(locale, 'settings.consensus.quantityTitle')}
        </h4>
        <p className="mt-1 text-xs leading-relaxed text-fg-faint">
          {t(locale, 'settings.consensus.quantityDesc')}
        </p>
      </div>

      <SettingRow
        title={t(locale, 'settings.consensus.adaptiveEscalationLabel')}
        description={t(locale, 'settings.consensus.adaptiveEscalationDesc')}
      >
        <SwitchControl
          checked={s.adaptiveEscalation}
          onChange={(v) => update('adaptiveEscalation', v)}
        />
      </SettingRow>

      <ConsensusRangeRow
        locale={locale}
        labelKey="settings.consensus.researchAnglesLabel"
        descKey="settings.consensus.researchAnglesDesc"
        minValue={s.researchAnglesMin}
        maxValue={s.researchAnglesMax}
        onMin={(v) => update('researchAnglesMin', v)}
        onMax={(v) => update('researchAnglesMax', v)}
      />

      <ConsensusRangeRow
        locale={locale}
        labelKey="settings.consensus.nodeGenCandidatesLabel"
        descKey="settings.consensus.nodeGenCandidatesDesc"
        minValue={s.nodeGenCandidatesMin}
        maxValue={s.nodeGenCandidatesMax}
        onMin={(v) => update('nodeGenCandidatesMin', v)}
        onMax={(v) => update('nodeGenCandidatesMax', v)}
      />

      <ConsensusRangeRow
        locale={locale}
        labelKey="settings.consensus.runtimeVoteSamplesLabel"
        descKey="settings.consensus.runtimeVoteSamplesDesc"
        minValue={s.runtimeVoteSamplesMin}
        maxValue={s.runtimeVoteSamplesMax}
        onMin={(v) => update('runtimeVoteSamplesMin', v)}
        onMax={(v) => update('runtimeVoteSamplesMax', v)}
      />

      <ConsensusRangeRow
        locale={locale}
        labelKey="settings.consensus.terminalVoteSamplesLabel"
        descKey="settings.consensus.terminalVoteSamplesDesc"
        minValue={s.terminalVoteSamplesMin}
        maxValue={s.terminalVoteSamplesMax}
        onMin={(v) => update('terminalVoteSamplesMin', v)}
        onMax={(v) => update('terminalVoteSamplesMax', v)}
      />

      <SettingRow
        title={t(locale, 'settings.consensus.complexityScalingLabel')}
        description={t(locale, 'settings.consensus.complexityScalingDesc')}
      >
        <StepperControl
          value={s.complexityScaling}
          min={CONSENSUS_LIMITS.complexityScaling.min}
          max={CONSENSUS_LIMITS.complexityScaling.max}
          onChange={(v) => update('complexityScaling', v)}
        />
      </SettingRow>

      <p className="text-xs leading-relaxed text-fg-faint">
        {t(locale, 'settings.consensus.costNote')}
      </p>
    </div>
  );
}

/**
 * A single quantity-for-quality tunable rendered as a (start, ceiling) pair:
 * "起始" = the Min stepper, "上限" = the Max stepper. The Max stepper's floor is
 * clamped to the current Min (and Min's ceiling to the current Max) so the UI
 * can never display an inverted range — the cross-field invariant the per-key
 * setter can't enforce. Range 1..16; set ceiling to 1 to disable the feature.
 */
function ConsensusRangeRow({
  locale,
  labelKey,
  descKey,
  minValue,
  maxValue,
  onMin,
  onMax,
}: {
  locale: Locale;
  labelKey: TranslationKey;
  descKey: TranslationKey;
  minValue: number;
  maxValue: number;
  onMin: (v: number) => void;
  onMax: (v: number) => void;
}) {
  return (
    <SettingRow title={t(locale, labelKey)} description={t(locale, descKey)}>
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-fg-faint">
            {t(locale, 'settings.consensus.rangeStart')}
          </span>
          <StepperControl
            value={minValue}
            min={1}
            max={maxValue}
            onChange={onMin}
          />
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-fg-faint">
            {t(locale, 'settings.consensus.rangeCeiling')}
          </span>
          <StepperControl
            value={maxValue}
            min={Math.max(1, minValue)}
            max={16}
            onChange={onMax}
          />
        </div>
      </div>
    </SettingRow>
  );
}

function AppearanceSettings({ locale }: { locale: Locale }) {
  const appearance = useStore((s) => s.appearance);
  const setStylePresetId = useStore((s) => s.setStylePresetId);
  const setFontFamilyId = useStore((s) => s.setFontFamilyId);
  const setFontSizePx = useStore((s) => s.setFontSizePx);
  const activePresetId = resolveStylePresetId(appearance.stylePresetId);
  const activePreset = STYLE_PRESETS[activePresetId];
  const activeFontFamilyId = resolveFontFamilyId(appearance.fontFamilyId);
  const activeFontSizePx = resolveFontSizePx(appearance.fontSizePx);
  const fontFamilyOptions = useMemo(
    () =>
      FONT_FAMILY_LIST.map((font) => ({
        id: font.id,
        label: t(locale, font.labelKey),
      })),
    [locale],
  );
  const hasUnsupportedStyle = isUnsupportedStylePreset(appearance.stylePresetId);

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h3 className="text-lg font-semibold text-fg">
          {t(locale, 'settings.appearanceTitle')}
        </h3>
        <p className="mt-1 text-xs leading-relaxed text-fg-faint">
          {t(locale, 'settings.appearanceDescription')}
        </p>
      </header>

      {hasUnsupportedStyle && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs leading-relaxed text-amber-200">
          <p>{t(locale, 'settings.appearanceUnsupportedStyle')}</p>
          <button
            type="button"
            onClick={() => setStylePresetId(DEFAULT_STYLE_PRESET_ID)}
            className="rounded-md border border-accent/40 bg-accent/15 px-2.5 py-1 text-[11px] font-medium text-accent transition-colors hover:bg-accent/20"
          >
            {t(locale, 'settings.appearanceUsePencil')}
          </button>
        </div>
      )}

      <SettingRow
        title={t(locale, 'settings.appearanceTypographyLabel')}
        description={t(locale, 'settings.appearanceTypographyDescription')}
      >
        <div className="flex w-full flex-col gap-2 sm:max-w-[28rem] sm:flex-row sm:items-center sm:justify-end">
          <div className="min-w-0 flex-1 sm:max-w-[17rem]">
            <SelectControl
              value={activeFontFamilyId}
              options={fontFamilyOptions}
              onChange={setFontFamilyId}
              icon={<Type size={15} strokeWidth={2.1} />}
            />
          </div>
          <div className="inline-flex items-center justify-end gap-2">
            <StepperControl
              value={activeFontSizePx}
              min={FONT_SIZE_LIMITS.min}
              max={FONT_SIZE_LIMITS.max}
              onChange={setFontSizePx}
            />
            <span className="w-6 font-mono text-xs text-fg-faint">px</span>
          </div>
        </div>
      </SettingRow>

      <section className="rounded-lg border border-border bg-bg-alt p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 max-w-xl space-y-1">
            <div className="text-sm font-medium text-fg">
              {t(locale, 'settings.appearanceStyleLabel')}
            </div>
            <p className="text-xs leading-relaxed text-fg-faint">
              {t(locale, 'settings.appearanceStyleDescription')}
            </p>
          </div>

          <div className="flex min-w-[12rem] items-center justify-between gap-3 rounded-md border border-border-soft bg-panel px-3 py-2">
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-accent">
                {t(locale, 'settings.appearanceActiveStyle')}
              </div>
              <div className="mt-0.5 truncate text-sm font-semibold text-fg">
                {t(locale, activePreset.labelKey)}
              </div>
            </div>
            <ThemeToneBadge preset={activePreset} locale={locale} />
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {STYLE_PRESET_LIST.map((preset) => (
            <StylePresetCard
              key={preset.id}
              preset={preset}
              active={preset.id === activePresetId}
              locale={locale}
              onSelect={() => setStylePresetId(preset.id)}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

const terminalStylePresetIds: readonly string[] = TERMINAL_STYLE_PRESET_IDS;

function stylePresetToneKey(
  preset: StylePresetDefinition,
): TranslationKey {
  if (terminalStylePresetIds.includes(preset.id)) {
    return 'settings.appearanceToneTerminal';
  }
  return preset.colorScheme === 'light'
    ? 'settings.appearanceToneLight'
    : 'settings.appearanceToneDark';
}

function ThemeToneBadge({
  preset,
  locale,
}: {
  preset: StylePresetDefinition;
  locale: Locale;
}) {
  const toneKey = stylePresetToneKey(preset);
  const Icon =
    toneKey === 'settings.appearanceToneTerminal'
      ? Terminal
      : toneKey === 'settings.appearanceToneLight'
        ? Sun
        : Moon;
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-bg-alt px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-fg-dim">
      <Icon size={12} strokeWidth={2.2} className="text-accent" />
      {t(locale, toneKey)}
    </span>
  );
}

function StylePresetCard({
  preset,
  active,
  locale,
  onSelect,
}: {
  preset: StylePresetDefinition;
  active: boolean;
  locale: Locale;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onSelect}
      className={cn(
        'group relative min-h-[9.25rem] w-full overflow-hidden rounded-lg border p-4 text-left transition-colors',
        active
          ? 'border-accent bg-accent/10 ring-1 ring-accent/25'
          : 'border-border bg-panel hover:border-accent/50 hover:bg-bg',
      )}
    >
      <div className="flex h-full flex-col gap-3">
        <div className="grid h-11 w-full grid-cols-5 overflow-hidden rounded-md border border-border-soft bg-bg-alt">
          {preset.swatches.map((color, index) => (
            <span
              key={`${preset.id}-${index}`}
              className="h-full"
              style={{ backgroundColor: color }}
            />
          ))}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <span className="min-w-0 flex-1 text-sm font-semibold text-fg">
              {t(locale, preset.labelKey)}
            </span>
            {active && (
              <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent text-bg">
                <Check size={12} strokeWidth={2.6} />
              </span>
            )}
          </div>
          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-fg-faint">
            {t(locale, preset.descriptionKey)}
          </p>
        </div>

        <div className="flex items-center justify-between gap-2">
          <ThemeToneBadge preset={preset} locale={locale} />
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-fg-faint transition-colors group-hover:text-fg-dim">
            <Monitor size={12} strokeWidth={2.1} />
            {active
              ? t(locale, 'settings.appearanceSelected')
              : t(locale, 'settings.appearancePreview')}
          </span>
        </div>
      </div>
    </button>
  );
}

function AboutSettings({ locale }: { locale: Locale }) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const runCheck = async () => {
    setChecking(true);
    try { setStatus(await checkForUpdate()); } finally { setChecking(false); }
  };
  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h3 className="text-base font-semibold text-fg">{t(locale, 'settings.aboutTitle')}</h3>
        <p className="text-xs leading-relaxed text-fg-faint">{t(locale, 'settings.aboutDescription')}</p>
      </header>
      <div className="rounded-lg border border-border bg-bg-alt p-5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/15 text-accent">
            <Sparkles size={20} strokeWidth={2.2} />
          </span>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-fg">UltraGameStudio</div>
            <span className="mt-1 inline-block rounded-md border border-border bg-panel-2 px-2 py-0.5 font-mono text-[11px] text-fg-dim">
              {t(locale, 'settings.aboutVersion')} v{APP_VERSION}
            </span>
          </div>
          <div className="flex-1" />
          <div className="flex flex-wrap items-center gap-2">
            <AboutLink label={t(locale, 'settings.aboutWebsite')} icon={<Globe size={14} />} onClick={() => void openExternal(REPO_URL)} />
            <AboutLink label="GitHub" icon={<ExternalLink size={14} />} onClick={() => void openExternal(REPO_URL)} />
            <AboutLink label={t(locale, 'settings.aboutChangelog')} icon={<FileText size={14} />} onClick={() => void openExternal(RELEASES_URL)} />
            <button type="button" onClick={() => void runCheck()} disabled={checking}
              className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-50">
              <RefreshCw size={14} className={checking ? "animate-spin" : undefined} />
              {checking ? t(locale, 'settings.aboutChecking') : t(locale, 'settings.aboutCheckUpdate')}
            </button>
          </div>
        </div>
        {status && !checking && (
          <div className="mt-4 border-t border-border-soft pt-3 text-xs">
            {status.error ? (
              <span className="text-[#f78b8b]">{t(locale, 'settings.aboutCheckFailed')}</span>
            ) : status.updateAvailable && status.manifest ? (
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-accent-2">{t(locale, 'settings.aboutUpdateFound')} v{status.latest}</span>
                <button type="button" onClick={() => void openDownload(status.manifest!.url)}
                  className="flex items-center gap-1.5 rounded-md border border-accent-2/50 bg-accent-2/15 px-2.5 py-1 font-semibold text-accent-2 transition-opacity hover:opacity-90">
                  <DownloadCloud size={14} />{t(locale, 'settings.aboutDownload')}
                </button>
              </div>
            ) : (
              <span className="text-fg-dim">{t(locale, 'settings.aboutUpToDate')}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function AboutLink({ label, icon, onClick }: { label: string; icon: ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className="flex items-center gap-1.5 rounded-md border border-border bg-panel-2 px-2.5 py-1.5 text-xs text-fg-dim transition-colors hover:border-accent hover:text-fg">
      {icon}<span>{label}</span>
    </button>
  );
}
