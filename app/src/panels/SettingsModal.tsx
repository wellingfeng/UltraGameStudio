import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react';
import {
  Check,
  ChevronDown,
  Cpu,
  DownloadCloud,
  Eye,
  EyeOff,
  ExternalLink,
  FileText,
  Globe,
  Info,
  Keyboard,
  Palette,
  Plus,
  RefreshCw,
  Settings as SettingsIcon,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Type,
  UploadCloud,
  X,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import type { GatewaySelection } from '@/core/ir';
import {
  personalInstructionsForSelection,
  personalInstructionsKey,
  personalInstructionsSample,
  selectionFromPersonalInstructionsKey,
  shouldInjectPersonalInstructions,
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
import { DEFAULT_MODEL } from '@/lib/anthropic';
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
  localModelStatus,
  openExternal,
  type LocalModelRuntimeStatus,
  validateShellPath,
} from '@/lib/tauri';
import LocalModelSetupDialog from '@/components/LocalModelSetupDialog';
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
  STYLE_PRESET_LIST,
  isUnsupportedStylePreset,
  resolveFontFamilyId,
  resolveFontSizePx,
  resolveStylePresetId,
  type StylePresetDefinition,
} from '@/lib/appearance';
import { useStore } from '@/store/useStore';
import {
  CONSENSUS_LIMITS,
  getConsensusSettings,
  setConsensusSetting,
  type ConsensusSettings as ConsensusSettingsValues,
} from '@/lib/consensusSettings';
import {
  canRefreshFreeChannelModels,
  freeChannelModelOptions,
  providerModelOptions,
  refreshFreeChannelModels,
  refreshProviderModels,
} from '@/lib/modelLists';
import {
  listGatewayRunOptions,
  systemDefaultGatewaySelection,
  workflowDefaultGatewaySelection,
} from '@/lib/modelGateway/resolver';
import { getActiveGatewaySelection } from '@/lib/gatewayConfig';

type SettingsTab =
  | 'general'
  | 'personalization'
  | 'models'
  | 'consensus'
  | 'shortcuts'
  | 'appearance'
  | 'about';
type LanguageOption = (typeof LANGUAGE_SELECT_OPTIONS)[number];

const tabs: { id: SettingsTab; labelKey: TranslationKey; Icon: LucideIcon }[] = [
  { id: 'general', labelKey: 'settings.tabs.general', Icon: SlidersHorizontal },
  { id: 'personalization', labelKey: 'settings.tabs.personalization', Icon: FileText },
  { id: 'models', labelKey: 'settings.tabs.models', Icon: Cpu },
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (document.querySelector('[data-settings-child-modal="true"]')) return;
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const languageOptions: LanguageOption[] = [...LANGUAGE_SELECT_OPTIONS];
  const targetLanguages = languageOptions.filter(
    (option) => option.id !== locale,
  );
  const panelId = `settings-panel-${tab}`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 sm:p-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="flex h-[86vh] w-[calc(100vw-2rem)] max-w-[980px] max-h-[660px] flex-col overflow-hidden rounded-lg border border-border bg-panel shadow-2xl sm:w-[calc(100vw-3rem)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="shrink-0 border-b border-border-soft bg-bg-alt px-5 py-4">
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
            className="w-full shrink-0 overflow-y-auto border-b border-border-soft bg-bg-alt p-3 sm:w-52 sm:border-b-0 sm:border-r"
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
            className="min-w-0 flex-1 overflow-y-auto bg-panel px-6 py-5 md:px-7 md:py-6"
          >
            <div className="mx-auto max-w-3xl">
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
                <ChannelsSettings locale={locale} cliRuntime={cliRuntime} />
              ) : tab === 'consensus' ? (
                <ConsensusSettings locale={locale} />
              ) : tab === 'shortcuts' ? (
                <ShortcutsSettings locale={locale} />
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
        <div className="w-full max-w-[20rem]">
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
        title={t(locale, 'settings.shellLabel')}
        description={t(locale, 'settings.shellDescription')}
      >
        <div className="w-full max-w-[24rem] space-y-2">
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
  const activeKey = personalInstructionsKey(activeSelection);
  const activeLabel = personalInstructionsSelectionLabel(activeSelection);
  const entries = useMemo(
    () =>
      personalInstructionsEntries(
        activeSelection,
        activeLabel,
        personalInstructionsByModel,
      ),
    [activeKey, activeLabel, activeSelection, personalInstructionsByModel],
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
              onSave={() => setPersonalInstructions(draft, entry.selection)}
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
  const injects = shouldInjectPersonalInstructions(entry.selection.adapter);
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
        {!injects && (
          <span className="rounded-md border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[11px] text-amber-200">
            {t(locale, 'settings.personalizationCodexSkipped')}
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

function SelectControl<T extends string>({
  value,
  options,
  onChange,
  icon,
}: {
  value: T;
  options: { id: T; label: string; hint?: string }[];
  onChange: (id: T) => void;
  icon?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const selected = options.find((o) => o.id === value);

  return (
    <div ref={rootRef} className="relative w-full">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex min-h-9 w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors',
          open
            ? 'border-accent bg-border-soft text-fg'
            : 'border-border bg-panel text-fg-dim hover:border-accent hover:text-fg',
        )}
      >
        {icon && <span className="shrink-0 text-fg-faint">{icon}</span>}
        <span className="min-w-0 flex-1 truncate text-fg">{selected?.label}</span>
        <ChevronDown
          size={15}
          strokeWidth={2.1}
          className={cn('shrink-0 text-fg-faint transition-transform', open && 'rotate-180')}
        />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-full min-w-[16rem] max-w-[20rem] overflow-hidden rounded-md border border-border bg-panel py-1 shadow-xl">
          <ul role="listbox">
            {options.map((option) => {
              const active = option.id === value;
              return (
                <li key={option.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={active}
                    onClick={() => {
                      onChange(option.id);
                      setOpen(false);
                    }}
                    className={cn(
                      'flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors',
                      active
                        ? 'bg-border-soft text-fg'
                        : 'text-fg-dim hover:bg-border-soft hover:text-fg',
                    )}
                  >
                    <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                      {active && <Check size={14} strokeWidth={2.4} className="text-accent" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    {option.hint && (
                      <span className="shrink-0 font-mono text-[10px] text-fg-faint">
                        {option.hint}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
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

type BadgeState = 'direct' | 'cli' | 'unavailable';
type ProviderDraft = Omit<Provider, 'id'>;
type ProviderEditorMode = 'add' | 'edit';

type ChannelSettingsTab = 'default' | 'free';
const DEFAULT_PROVIDER_OPTION_PREFIX = 'default-provider:';
const SYSTEM_DEFAULT_OPTION_PREFIX = 'system-default:';
const FREE_CHANNEL_OPTION_PREFIX = 'free:';
const MODEL_DEFAULT_OPTION_ID = '__default_model__';
const CLAUDE_MODEL_CLASS_OPTIONS = ['sonnet', 'opus', 'haiku'];

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
          className="inline-flex w-fit gap-1 rounded-lg border border-border-soft bg-bg p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
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
                  'min-h-11 min-w-[7rem] rounded-md border px-5 py-2.5 text-sm font-semibold outline-none transition-[background-color,border-color,color,box-shadow] focus-visible:ring-1 focus-visible:ring-accent',
                  active
                    ? 'border-accent bg-accent text-bg shadow-[0_8px_18px_-14px_rgba(124,140,255,0.9)]'
                    : 'border-transparent text-fg-faint hover:border-border-soft hover:bg-panel hover:text-fg',
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
  const setGlobalRunSelection = useStore((s) => s.setGlobalRunSelection);
  const composerModelOptions = useStore((s) => s.modelOptions);
  const [revision, setRevision] = useState(0);
  const [modelListRevision, setModelListRevision] = useState(0);
  const [loadingModels, setLoadingModels] = useState(false);
  const runSelection = useMemo(
    () => getActiveGatewaySelection(),
    [revision],
  );

  useEffect(() => {
    const refresh = () => setRevision((n) => n + 1);
    window.addEventListener('fuc:gateway-config-changed', refresh);
    return () => window.removeEventListener('fuc:gateway-config-changed', refresh);
  }, []);

  useEffect(() => {
    const refresh = () => setModelListRevision((n) => n + 1);
    window.addEventListener('fuc:model-list-changed', refresh);
    return () => window.removeEventListener('fuc:model-list-changed', refresh);
  }, []);

  const defaultChannelProviders = useMemo(() => {
    void revision;
    const desktop = isTauri();
    return listProviders()
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
  }, [cliRuntime, revision]);

  const channelOptions = useMemo(
    () => {
      const defaultOptions = RUNTIME_ADAPTERS.flatMap((adapter) => {
        const group = `${t(locale, 'dock.channelGroupDefault')} · ${adapter.label}`;
        return [
          {
            id: systemDefaultOptionId(adapter.id),
            label: `${adapter.label} · ${t(locale, 'dock.channelSystemDefault')}`,
            hint: t(locale, 'settings.models.sourceSystemCli'),
            group,
          },
          ...defaultChannelProviders
            .filter((item) => item.adapter === adapter.id)
            .map(({ provider }) => ({
              id: defaultProviderOptionId(provider.id),
              label: provider.name.trim() || adapter.label,
              hint: t(locale, 'dock.channelKindDefault'),
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
  const selectedAdapter =
    RUNTIME_ADAPTERS.find((adapter) => adapter.id === runSelection.adapter)?.id ??
    RUNTIME_ADAPTERS[0].id;
  const pinnedDefaultProvider = runSelection.providerId
    ? defaultChannelProviders.find(
        (item) =>
          item.provider.id === runSelection.providerId &&
          item.adapter === selectedAdapter,
      )
    : undefined;
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

  const onChannelChange = (id: string) => {
    const providerId = providerIdFromDefaultOption(id);
    if (providerId) {
      const provider = defaultChannelProviders.find(
        (item) => item.provider.id === providerId,
      )?.provider;
      if (!provider) return;
      setGlobalRunSelection(providerSelection(provider));
      return;
    }

    const defaultAdapter = adapterFromSystemDefaultOption(id);
    if (defaultAdapter) {
      setGlobalRunSelection(systemDefaultGatewaySelection(defaultAdapter));
      return;
    }

    const freeChannelId = freeChannelFromOption(id);
    if (!freeChannelId) return;
    void ensureFreeProxy();
    setGlobalRunSelection(
      freeChannelSelection(freeChannelId, getFreeChannelModel(freeChannelId)),
    );
  };

  const onModelChange = (id: string) => {
    const selectedModel = modelFromOptionId(id);
    if (selectedFreeChannel) {
      setFreeChannelModel(selectedFreeChannel.id, selectedModel);
      void ensureFreeProxy();
      setGlobalRunSelection(
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
      setGlobalRunSelection(
        providerSelection({ ...provider, model: nextModel }, selectedModel),
      );
      return;
    }
    setGlobalRunSelection(
      {
        ...systemDefaultGatewaySelection(selectedAdapter),
        modelClass: selectedModel || 'default',
      },
    );
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
        'openworkflow-default-channels.json',
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
            <div className="space-y-2.5">
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
  const [showKey, setShowKey] = useState(false);
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
    setBaseUrlError(null);
    setDuplicateError(null);
  }, [provider.id, provider.baseUrl, provider.apiKey, provider.model]);

  const draftProvider: Provider = {
    ...provider,
    baseUrl: baseUrlValue,
    apiKey: keyValue,
    model: modelValue.trim() || undefined,
  };
  const draftRuntime = getProviderRuntimeInfo(draftProvider, {
    canUseCliFallback: runtime.canUseCliFallback,
  });
  const modelOptions = providerModelOptions(draftProvider);
  const modelSelectValue = modelOptions.includes(modelValue.trim())
    ? modelValue.trim()
    : '';
  const KeyIcon = showKey ? EyeOff : Eye;

  const commitProvider = (patch: Partial<ProviderDraft>): boolean => {
    const nextProvider: Provider = {
      ...draftProvider,
      ...patch,
    };
    const next = trimProviderDraft(nextProvider);
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
    setDuplicateError(null);
    setBaseUrlValue(next.baseUrl);
    setKeyValue(next.apiKey);
    setModelValue(next.model ?? '');

    if (!providerDraftChanged(next, providerDraft(provider))) return false;
    updateProvider(provider.id, {
      apiKey: next.apiKey,
      baseUrl: next.baseUrl,
      model: next.model,
      transport: next.transport,
    });
    onChange();
    return true;
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
    <div
      className="relative space-y-3 overflow-hidden rounded-lg border border-border bg-bg-alt p-4 transition-colors"
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <GroupDot className={dotClassName} />
          <span className="truncate text-sm font-medium text-fg">
            {provider.name || runtimeAdapterLabel(adapter)}
          </span>
        </div>
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

        <label className="block space-y-1 lg:col-span-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium text-fg-dim">
              {t(locale, 'settings.freeChannels.modelLabel')}
            </span>
            <button
              type="button"
              onClick={() => void refreshModels()}
              disabled={modelRefresh.loading}
              className="inline-flex items-center gap-1 rounded border border-border bg-panel px-2 py-0.5 text-[11px] text-fg-dim transition-colors hover:border-accent hover:text-fg disabled:cursor-not-allowed disabled:opacity-45"
            >
              <RefreshCw
                size={11}
                strokeWidth={2}
                className={modelRefresh.loading ? 'animate-spin' : undefined}
              />
              {t(locale, 'settings.models.fetchModels')}
            </button>
          </div>
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(10rem,14rem)]">
            <input
              type="text"
              value={modelValue}
              onChange={(event) => {
                setModelValue(event.target.value);
                setDuplicateError(null);
              }}
              onBlur={() => commitProvider({ model: modelValue })}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
              placeholder={providerModelPlaceholder(provider.kind, locale)}
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-md border border-border bg-panel px-2.5 py-1.5 font-mono text-sm text-fg outline-none transition-colors focus:border-accent"
            />
            <select
              value={modelSelectValue}
              onChange={(event) => {
                if (!event.target.value) return;
                setModelValue(event.target.value);
                commitProvider({ model: event.target.value });
              }}
              className="h-[35px] w-full rounded-md border border-border bg-panel px-2 font-mono text-xs text-fg outline-none transition-colors focus:border-accent"
            >
              <option value="">{t(locale, 'settings.models.selectModel')}</option>
              {modelOptions.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </div>
          {modelRefresh.error && (
            <p className="text-[11px] leading-relaxed text-amber-300">
              {modelRefresh.error}
            </p>
          )}
          {duplicateError && (
            <p className="text-[11px] leading-relaxed text-rose-300">
              {duplicateError}
            </p>
          )}
        </label>
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

function providerModelPlaceholder(kind: Provider['kind'], locale: Locale): string {
  if (kind === 'anthropic') return DEFAULT_MODEL;
  return t(locale, 'settings.models.modelComposerSelected');
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
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

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
      onClick={onClose}
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
            <ModelTextField
              label={t(locale, 'settings.models.defaultModel')}
              value={editor.draft.model ?? ''}
              onChange={(value) => patchDraft({ model: value })}
              placeholder={DEFAULT_MODEL}
              description={t(locale, 'settings.models.modelMetadataHelp')}
              options={providerModelOptions(editor.draft)}
              loading={modelRefresh.loading}
              error={modelRefresh.error}
              refreshLabel={t(locale, 'settings.models.fetchModels')}
              selectLabel={t(locale, 'settings.models.selectModel')}
              onRefresh={refreshModels}
            />
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
          <div className="flex items-center gap-2">
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
  };
}

function trimProviderDraft(draft: ProviderDraft): ProviderDraft {
  const model = draft.model?.trim();
  const transport =
    draft.kind === 'anthropic' ? draft.transport ?? 'direct' : 'cli';
  return {
    kind: draft.kind,
    name: draft.name.trim(),
    apiKey: draft.apiKey.trim(),
    baseUrl: draft.baseUrl.trim(),
    transport,
    ...(model ? { model } : {}),
  };
}

function providerDraftChanged(a: ProviderDraft, b: ProviderDraft): boolean {
  const left = trimProviderDraft(a);
  const right = trimProviderDraft(b);
  return (
    left.kind !== right.kind ||
    left.name !== right.name ||
    left.apiKey !== right.apiKey ||
    left.baseUrl !== right.baseUrl ||
    (left.transport ?? '') !== (right.transport ?? '') ||
    (left.model ?? '') !== (right.model ?? '')
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

function TextField({
  label,
  value,
  onChange,
  placeholder,
  description,
  error,
  mono,
  fullWidth,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  description?: string;
  error?: string;
  mono?: boolean;
  fullWidth?: boolean;
}) {
  return (
    <label className={cn('block space-y-1', fullWidth && 'sm:col-span-2')}>
      <span className="text-[11px] font-medium text-fg-dim">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        className={cn(
          'w-full rounded border border-border bg-bg px-2 py-1.5 text-xs text-fg outline-none transition-colors focus:border-accent',
          mono && 'font-mono',
          error && 'border-rose-500/60',
        )}
      />
      {description && (
        <p className="text-[11px] leading-relaxed text-fg-faint">{description}</p>
      )}
      {error && (
        <p className="text-[11px] leading-relaxed text-rose-300">{error}</p>
      )}
    </label>
  );
}

function ModelTextField({
  label,
  value,
  onChange,
  placeholder,
  description,
  options,
  loading,
  error,
  refreshLabel,
  selectLabel,
  onRefresh,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  description?: string;
  options: string[];
  loading: boolean;
  error: string | null;
  refreshLabel: string;
  selectLabel: string;
  onRefresh: () => void;
}) {
  const modelOptions = uniqueStringOptions([value, ...options]);
  const selectValue = modelOptions.includes(value.trim()) ? value.trim() : '';
  return (
    <label className="block space-y-1 sm:col-span-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] font-medium text-fg-dim">{label}</span>
        <button
          type="button"
          onClick={() => void onRefresh()}
          disabled={loading}
          className="inline-flex items-center gap-1 rounded border border-border bg-bg px-2 py-1 text-[11px] text-fg-dim transition-colors hover:border-accent hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RefreshCw
            size={12}
            strokeWidth={2}
            className={loading ? 'animate-spin' : undefined}
          />
          {refreshLabel}
        </button>
      </div>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(10rem,14rem)]">
        <input
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          className="w-full rounded border border-border bg-bg px-2 py-1.5 font-mono text-xs text-fg outline-none transition-colors focus:border-accent"
        />
        <select
          value={selectValue}
          onChange={(event) => {
            if (event.target.value) onChange(event.target.value);
          }}
          className="h-[31px] w-full rounded border border-border bg-bg px-2 font-mono text-xs text-fg outline-none transition-colors focus:border-accent"
        >
          <option value="">{selectLabel}</option>
          {modelOptions.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      </div>
      {description && (
        <p className="text-[11px] leading-relaxed text-fg-faint">{description}</p>
      )}
      {error && (
        <p className="text-[11px] leading-relaxed text-amber-300">{error}</p>
      )}
    </label>
  );
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

function ReadonlyField({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}) {
  return (
    <div className="block space-y-1">
      <span className="text-[11px] font-medium text-fg-dim">{label}</span>
      <div className="min-h-[31px] rounded border border-border bg-bg px-2 py-1.5 text-xs text-fg-dim">
        {value}
      </div>
    </div>
  );
}

function ShortcutsSettings({ locale }: { locale: Locale }) {
  const shortcuts: {
    id: string;
    keys: string[];
    titleKey: TranslationKey;
    descriptionKey: TranslationKey;
  }[] = [
    {
      id: 'composer-send',
      keys: ['Ctrl', 'Enter'],
      titleKey: 'settings.shortcutsComposerSendTitle',
      descriptionKey: 'settings.shortcutsComposerSendDescription',
    },
    {
      id: 'composer-newline',
      keys: ['Enter'],
      titleKey: 'settings.shortcutsComposerNewlineTitle',
      descriptionKey: 'settings.shortcutsComposerNewlineDescription',
    },
    {
      id: 'modal-close',
      keys: ['Esc'],
      titleKey: 'settings.shortcutsCloseModalTitle',
      descriptionKey: 'settings.shortcutsCloseModalDescription',
    },
  ];

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-lg font-semibold text-fg">
          {t(locale, 'settings.shortcutsTitle')}
        </h3>
        <p className="mt-1 text-xs leading-relaxed text-fg-faint">
          {t(locale, 'settings.shortcutsDescription')}
        </p>
      </div>

      <div className="space-y-2">
        {shortcuts.map((shortcut) => (
          <div
            key={shortcut.id}
            className="grid gap-3 rounded-lg border border-border bg-bg-alt px-4 py-3 md:grid-cols-[minmax(9rem,14rem)_minmax(0,1fr)] md:items-center"
          >
            <ShortcutKeys keys={shortcut.keys} />
            <div className="min-w-0">
              <div className="text-sm font-medium text-fg">
                {t(locale, shortcut.titleKey)}
              </div>
              <p className="mt-1 text-xs leading-relaxed text-fg-faint">
                {t(locale, shortcut.descriptionKey)}
              </p>
            </div>
          </div>
        ))}
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

function SettingRow({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-4 rounded-lg border border-border bg-bg-alt p-4 md:grid-cols-[minmax(0,1fr)_minmax(12rem,24rem)] md:items-center">
      <div className="space-y-1">
        <div className="text-sm font-medium text-fg">{title}</div>
        {description && (
          <p className="text-xs leading-relaxed text-fg-faint">{description}</p>
        )}
      </div>
      <div className="md:justify-self-end">{children}</div>
    </div>
  );
}

function SwitchControl({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-6 w-11 rounded-full border transition-colors',
        checked ? 'border-accent bg-accent/25' : 'border-border bg-panel-2',
      )}
    >
      <span
        className={cn(
          'absolute left-0.5 top-0.5 h-5 w-5 rounded-full transition-transform',
          checked ? 'translate-x-5 bg-accent' : 'translate-x-0 bg-fg-faint',
        )}
      />
    </button>
  );
}

function StepperControl({
  value,
  min,
  max,
  disabled = false,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  const set = (v: number) => onChange(Math.min(max, Math.max(min, v)));
  const btn =
    'flex h-8 w-8 items-center justify-center rounded-md border border-border bg-panel text-fg-dim transition-colors hover:border-accent hover:text-fg disabled:cursor-not-allowed disabled:opacity-40';
  return (
    <div
      className={cn(
        'inline-flex items-center gap-1.5',
        disabled && 'pointer-events-none opacity-50',
      )}
    >
      <button
        type="button"
        aria-label="−"
        onClick={() => set(value - 1)}
        disabled={value <= min}
        className={btn}
      >
        −
      </button>
      <span className="w-10 text-center font-mono text-sm text-fg">{value}</span>
      <button
        type="button"
        aria-label="+"
        onClick={() => set(value + 1)}
        disabled={value >= max}
        className={btn}
      >
        +
      </button>
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
        'openworkflow-free-channels.json',
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
      <div className="space-y-2.5">
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
  const modelSelectValue = modelOptions.includes(modelValue.trim())
    ? modelValue.trim()
    : '';
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
        <label className="block space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium text-fg-dim">
              {t(locale, 'settings.freeChannels.modelLabel')}
            </span>
            <button
              type="button"
              onClick={() => void refreshModels()}
              disabled={!canRefreshModels || modelRefresh.loading}
              title={
                canRefreshModels
                  ? t(locale, 'settings.models.fetchModels')
                  : t(locale, 'settings.models.fetchModelsUnavailable')
              }
              className="inline-flex items-center gap-1 rounded border border-border bg-panel px-2 py-0.5 text-[11px] text-fg-dim transition-colors hover:border-accent hover:text-fg disabled:cursor-not-allowed disabled:opacity-45"
            >
              <RefreshCw
                size={11}
                strokeWidth={2}
                className={modelRefresh.loading ? 'animate-spin' : undefined}
              />
              {t(locale, 'settings.models.fetchModels')}
            </button>
          </div>
          <input
            type="text"
            value={modelValue}
            onChange={(event) => setModelValue(event.target.value)}
            onBlur={() => {
              if (commitModel(modelValue)) reproxy();
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
            placeholder={
              channel.defaultModel ||
              t(locale, 'settings.freeChannels.modelPlaceholderLocal')
            }
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-md border border-border bg-panel px-2.5 py-1.5 text-sm text-fg outline-none transition-colors focus:border-accent"
          />
          {modelOptions.length > 0 && (
            <select
              value={modelSelectValue}
              onChange={(event) => {
                if (!event.target.value) return;
                if (commitModel(event.target.value)) reproxy();
              }}
              className="h-8 w-full rounded-md border border-border bg-panel px-2 font-mono text-xs text-fg outline-none transition-colors focus:border-accent"
            >
              <option value="">{t(locale, 'settings.models.selectModel')}</option>
              {modelOptions.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          )}
          {modelRefresh.error && (
            <p className="text-[11px] leading-relaxed text-amber-300">
              {modelRefresh.error}
            </p>
          )}
        </label>
      </div>

      {channel.note && (
        <p className="text-[11px] leading-relaxed text-fg-faint">
          {channel.note}
        </p>
      )}
    </div>
  );
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
        title={t(locale, 'settings.fontFamilyLabel')}
        description={t(locale, 'settings.fontFamilyDescription')}
      >
        <div className="w-full max-w-[20rem]">
          <SelectControl
            value={activeFontFamilyId}
            options={fontFamilyOptions}
            onChange={setFontFamilyId}
            icon={<Type size={15} strokeWidth={2.1} />}
          />
        </div>
      </SettingRow>

      <SettingRow
        title={t(locale, 'settings.fontSizeLabel')}
        description={t(locale, 'settings.fontSizeDescription')}
      >
        <div className="inline-flex items-center gap-2">
          <StepperControl
            value={activeFontSizePx}
            min={FONT_SIZE_LIMITS.min}
            max={FONT_SIZE_LIMITS.max}
            onChange={setFontSizePx}
          />
          <span className="w-6 font-mono text-xs text-fg-faint">px</span>
        </div>
      </SettingRow>

      <SettingRow
        title={t(locale, 'settings.appearanceStyleLabel')}
        description={t(locale, 'settings.appearanceStyleDescription')}
      >
        <div className="w-full max-w-[34rem]">
          <div className="grid gap-3">
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
        </div>
      </SettingRow>
    </div>
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
        'group w-full rounded-lg border p-4 text-left transition-colors',
        active
          ? 'border-accent bg-accent/10'
          : 'border-border bg-panel hover:border-accent/50 hover:bg-bg',
      )}
    >
      <div className="flex items-start gap-4">
        <div className="grid h-10 w-16 shrink-0 grid-cols-5 overflow-hidden rounded-md border border-border-soft bg-bg-alt">
          {preset.swatches.map((color, index) => (
            <span
              key={`${preset.id}-${index}`}
              className="h-full"
              style={{ backgroundColor: color }}
            />
          ))}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-fg">
              {t(locale, preset.labelKey)}
            </span>
            {active && (
              <Check size={12} strokeWidth={2.4} className="text-accent" />
            )}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-fg-faint">
            {t(locale, preset.descriptionKey)}
          </p>
        </div>

        <span
          className={cn(
            'shrink-0 rounded-md border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider',
            active
              ? 'border-accent/40 bg-accent/10 text-accent'
              : 'border-border bg-bg-alt text-fg-faint',
          )}
        >
          {preset.colorScheme}
        </span>
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
            <div className="text-sm font-semibold text-fg">FreeUltraCode</div>
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
