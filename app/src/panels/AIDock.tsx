import { useCallback, useEffect, useRef, useState } from 'react';
import Select from '@/components/Select';
import WorkspaceSelect from '@/components/WorkspaceSelect';
import {
  loadDockHeight,
  loadPaneWidth,
  saveDockHeight,
  savePaneWidth,
} from '@/lib/composerStorage';
import { useStore } from '@/store/useStore';

const DEFAULT_DOCK_HEIGHT = 208; // matches the former h-52
const MIN_DOCK_HEIGHT = 120;

/** localStorage key + bounds for the AI-input pane width (right column). */
const INPUT_WIDTH_KEY = 'openworkflow.aiInputWidth.v1';
const DEFAULT_INPUT_WIDTH = 384; // matches the former w-96
const MIN_INPUT_WIDTH = 280;
const MIN_RETURN_WIDTH = 240; // keep the AI-return pane usable

/** localStorage key holding the user's Anthropic API key. */
const API_KEY_STORAGE = 'owf_anthropic_key';

/** Safely read the persisted API key from localStorage. */
function readApiKey(): string {
  try {
    if (typeof window === 'undefined') return '';
    return window.localStorage.getItem(API_KEY_STORAGE) ?? '';
  } catch {
    return '';
  }
}

/** Safely write the API key to localStorage; empty string removes it. */
function writeApiKey(value: string): void {
  try {
    if (typeof window === 'undefined') return;
    const v = value.trim();
    if (v) window.localStorage.setItem(API_KEY_STORAGE, v);
    else window.localStorage.removeItem(API_KEY_STORAGE);
  } catch {
    /* ignore */
  }
}

function clampHeight(h: number): number {
  const max =
    typeof window !== 'undefined' ? window.innerHeight * 0.75 : 600;
  return Math.min(Math.max(h, MIN_DOCK_HEIGHT), max);
}

/**
 * CONTRACT: default export, no props. Bottom-center AI interaction dock.
 *
 * Left : AI return stream (messages from the store).
 * Right: AI input box. Plain Enter calls store.sendPrompt; Shift+Enter inserts
 *        a newline.
 *
 * The whole dock is vertically resizable: drag the handle on its top edge
 * (cursor becomes row-resize) to change its height; the value is persisted.
 *
 * The split between the two panes is horizontally resizable: drag the vertical
 * divider between them (cursor becomes col-resize) to change the AI-input pane
 * width; the AI-return pane fills the rest. The width is persisted and clamped
 * so neither pane collapses.
 *
 * Mirrors design.html §06 "中 · 主工作区" bottom row (AI 返回 / AI 输入).
 */
export default function AIDock() {
  const messages = useStore((s) => s.messages);
  const sendPrompt = useStore((s) => s.sendPrompt);
  const composer = useStore((s) => s.composer);
  const setComposer = useStore((s) => s.setComposer);
  const setWorkspace = useStore((s) => s.setWorkspace);
  const permissionOptions = useStore((s) => s.permissionOptions);
  const modelOptions = useStore((s) => s.modelOptions);
  const workspaceHistory = useStore((s) => s.workspaceHistory);
  const mode = useStore((s) => s.mode);
  const aiStreaming = useStore((s) => s.aiStreaming);
  const [draft, setDraft] = useState('');
  const streamRef = useRef<HTMLDivElement>(null);

  // API-key settings popover state.
  const [showKeySettings, setShowKeySettings] = useState(false);
  const [apiKeyDraft, setApiKeyDraft] = useState<string>(() => readApiKey());
  const [hasApiKey, setHasApiKey] = useState<boolean>(
    () => readApiKey().length > 0,
  );

  const isReadOnly = mode === 'running';

  const [height, setHeight] = useState<number>(
    () => loadDockHeight() ?? DEFAULT_DOCK_HEIGHT,
  );

  // Width (px) of the right-hand AI-input pane. The left AI-return pane fills
  // the remaining space, so dragging the divider re-splits the dock.
  const [inputWidth, setInputWidth] = useState<number>(
    () => loadPaneWidth(INPUT_WIDTH_KEY) ?? DEFAULT_INPUT_WIDTH,
  );
  const dockRef = useRef<HTMLDivElement>(null);

  /** Clamp the input width to keep both panes usable within the dock. */
  const clampInputWidth = useCallback((w: number): number => {
    const total = dockRef.current?.clientWidth ?? window.innerWidth;
    const max = Math.max(MIN_INPUT_WIDTH, total - MIN_RETURN_WIDTH);
    return Math.min(Math.max(w, MIN_INPUT_WIDTH), max);
  }, []);

  // Keep the latest message in view.
  useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Re-clamp the input width when the window (and thus the dock) resizes so
  // neither pane collapses below its minimum.
  useEffect(() => {
    const onResize = () => setInputWidth((w) => clampInputWidth(w));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [clampInputWidth]);

  // Drag the top edge to resize. The panel is anchored to the bottom, so
  // dragging up (smaller clientY) increases height.
  const onResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startHeight = height;
      const prevUserSelect = document.body.style.userSelect;
      const prevCursor = document.body.style.cursor;
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'row-resize';

      const onMove = (ev: MouseEvent) => {
        setHeight(clampHeight(startHeight - (ev.clientY - startY)));
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.style.userSelect = prevUserSelect;
        document.body.style.cursor = prevCursor;
        setHeight((h) => {
          saveDockHeight(h);
          return h;
        });
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [height],
  );

  // Drag the vertical divider between the AI-return (left) and AI-input
  // (right) panes. Dragging left (smaller clientX) widens the input pane.
  const onSplitStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = inputWidth;
      const prevUserSelect = document.body.style.userSelect;
      const prevCursor = document.body.style.cursor;
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';

      const onMove = (ev: MouseEvent) => {
        setInputWidth(clampInputWidth(startWidth - (ev.clientX - startX)));
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.style.userSelect = prevUserSelect;
        document.body.style.cursor = prevCursor;
        setInputWidth((w) => {
          savePaneWidth(INPUT_WIDTH_KEY, w);
          return w;
        });
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [inputWidth, clampInputWidth],
  );

  const submit = () => {
    if (isReadOnly || aiStreaming) return;
    const text = draft.trim();
    if (!text) return;
    sendPrompt(text);
    setDraft('');
  };

  const saveApiKey = () => {
    writeApiKey(apiKeyDraft);
    setHasApiKey(apiKeyDraft.trim().length > 0);
    setShowKeySettings(false);
  };

  return (
    <div
      ref={dockRef}
      className="relative flex shrink-0 border-t border-border bg-panel"
      style={{ height }}
    >
      {/* Resize handle — sits on the top edge, cursor becomes row-resize. */}
      <div
        onMouseDown={onResizeStart}
        title="拖动调整高度"
        className="group absolute -top-1 left-0 right-0 z-20 flex h-2 cursor-row-resize items-center justify-center"
      >
        <div className="h-0.5 w-full bg-transparent transition-colors group-hover:bg-accent/40" />
      </div>
      {/* AI return stream */}
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-border-soft px-3 py-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-accent">
            AI 返回
          </span>
          {aiStreaming && (
            <span className="flex items-center gap-1 font-mono text-[10px] text-accent-2">
              <span className="omc-pulse-dot" />
              生成中…
            </span>
          )}
        </header>
        <div ref={streamRef} className="min-h-0 flex-1 overflow-y-auto p-3">
          {messages.length === 0 ? (
            <div className="text-xs text-fg-faint">
              在右侧描述你的意图，AI 将据此操作画布并在此回显。
            </div>
          ) : (
            <ul className="flex flex-col gap-3">
              {messages.map((m) => {
                const isUser = m.role === 'user';
                return (
                  <li key={m.id} className="flex flex-col gap-1">
                    <span
                      className={
                        'font-mono text-[10px] uppercase tracking-wider ' +
                        (isUser ? 'text-accent' : 'text-accent-2')
                      }
                    >
                      {isUser ? '› you' : '⟳ assistant'}
                    </span>
                    <span className="whitespace-pre-wrap text-sm leading-relaxed text-fg-dim">
                      {m.text}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      {/* Vertical divider — drag to re-split AI 返回 / AI 输入. */}
      <div
        onMouseDown={onSplitStart}
        title="拖动调整左右宽度"
        className="group relative z-20 flex w-1.5 shrink-0 cursor-col-resize items-stretch justify-center border-l border-border-soft"
      >
        <div className="h-full w-0.5 bg-transparent transition-colors group-hover:bg-accent/40" />
      </div>

      {/* AI input box */}
      <section
        className="relative flex shrink-0 flex-col"
        style={{ width: inputWidth }}
      >
        <header className="flex items-center justify-between gap-2 border-b border-border-soft px-3 py-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-fg-faint">
            AI 输入{isReadOnly ? ' · 只读 (运行中)' : ''}
          </span>
          <button
            type="button"
            onClick={() => {
              setApiKeyDraft(readApiKey());
              setShowKeySettings((v) => !v);
            }}
            title={
              hasApiKey
                ? 'Anthropic API key 已配置 · 点击修改'
                : '未配置 API key · 将回退到本地意图引擎'
            }
            className={
              'rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider transition-colors ' +
              (hasApiKey
                ? 'border-accent-2/60 text-accent-2 hover:bg-accent-2/10'
                : 'border-border text-fg-faint hover:border-accent/50 hover:text-accent')
            }
          >
            {hasApiKey ? '⚙ key ✓' : '⚙ set key'}
          </button>
        </header>

        {/* API-key settings popover. Anchored to the input panel; only visible
            when toggled. Keeps the key local to this device (localStorage). */}
        {showKeySettings && (
          <div className="absolute right-2 top-9 z-30 w-80 rounded-md border border-border bg-panel-2 p-3 shadow-lg">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-mono text-[10px] uppercase tracking-wider text-accent">
                Anthropic API Key
              </span>
              <button
                type="button"
                onClick={() => setShowKeySettings(false)}
                className="text-fg-faint hover:text-fg"
                title="关闭"
              >
                ×
              </button>
            </div>
            <input
              type="password"
              value={apiKeyDraft}
              onChange={(e) => setApiKeyDraft(e.target.value)}
              placeholder="sk-ant-..."
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded border border-border bg-bg px-2 py-1.5 font-mono text-xs text-fg outline-none focus:border-accent"
            />
            <p className="mt-2 text-[10px] leading-relaxed text-fg-faint">
              仅保存在本机 localStorage (键 <code>{API_KEY_STORAGE}</code>)。
              未配置时将回退到本地意图引擎。
            </p>
            <div className="mt-2 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setApiKeyDraft('');
                  writeApiKey('');
                  setHasApiKey(false);
                  setShowKeySettings(false);
                }}
                className="rounded border border-border px-2 py-1 text-[11px] text-fg-faint hover:border-accent-3/60 hover:text-accent-3"
              >
                清除
              </button>
              <button
                type="button"
                onClick={saveApiKey}
                className="rounded bg-accent px-2.5 py-1 text-[11px] font-medium text-bg hover:opacity-90"
              >
                保存
              </button>
            </div>
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            readOnly={isReadOnly}
            disabled={isReadOnly}
            placeholder={
              isReadOnly
                ? '运行中 · 输入框已锁定，停止后可再编辑蓝图'
                : '描述意图，例如：在 Verify 后加一个汇总节点…'
            }
            className={
              'min-h-0 flex-1 resize-none rounded-md border border-border bg-bg p-2.5 text-sm leading-relaxed text-fg outline-none transition-colors placeholder:text-fg-faint focus:border-accent ' +
              (isReadOnly ? 'cursor-not-allowed opacity-60' : '')
            }
          />

          {/* Tool row: permission · (spacer) · model · send */}
          <div className="flex items-center gap-2">
            <Select
              title="权限设定"
              options={permissionOptions}
              value={composer.permission}
              onChange={(id) => setComposer({ permission: id })}
              icon="⚠"
            />
            <div className="min-w-0 flex-1" />
            <Select
              title="模型选择"
              options={modelOptions}
              value={composer.model}
              onChange={(id) => setComposer({ model: id })}
            />
            <button
              type="button"
              onClick={submit}
              disabled={!draft.trim() || isReadOnly || aiStreaming}
              title={
                isReadOnly
                  ? '运行中 · 输入框已锁定'
                  : aiStreaming
                    ? 'AI 生成中…'
                    : 'Enter 发送 · Shift+Enter 换行'
              }
              className="rounded-md bg-accent px-2.5 py-1.5 text-sm font-medium text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {aiStreaming ? '…' : '↑'}
            </button>
          </div>

          {/* Context row: workspace */}
          <div className="flex items-center gap-2">
            <WorkspaceSelect
              value={composer.workspace}
              history={workspaceHistory}
              onSelect={setWorkspace}
            />
            <span className="font-mono text-[10px] text-fg-faint">
              {isReadOnly
                ? '运行中 · 只读'
                : 'Enter 发送 · Shift+Enter 换行'}
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}
