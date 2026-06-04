import { useState } from 'react';
import { useStore } from '@/store/useStore';
import AutoTextarea from '@/components/AutoTextarea';
import NodeInspector from './NodeInspector';
import TaskLedgerPanel from './TaskLedgerPanel';
import { useResizableWidth } from '@/lib/useResizableWidth';
import { isPromptEntryDisabled } from '@/lib/composerEntryPolicy';
import {
  localizePromptGroup,
  localizePromptItem,
  t,
  type Locale,
} from '@/lib/i18n';
import type { PromptItem } from '@/store/types';

/**
 * CONTRACT: default export, no props. Right-hand prompt panel.
 *
 * Renders the store's grouped prompt library. Each item carries a clickable
 * ▷ triangle; clicking appends the item's text to the AI input box.
 * Groups are collapsible. When a node is selected, the panel flips to the
 * NodeInspector view (label / type / per-type params + 删除节点).
 *
 * Edit mode (toggled by the 编辑/完成 button in the header, available only when
 * no node is selected) exposes full CRUD over the prompt library, wired to the
 * store's prompt-library actions (which persist to localStorage):
 *   - rename / delete a group; "+ 新增分组"
 *   - add / inline-edit (label + text) / delete an item within a group
 *   - "恢复默认" resets to the bundled defaults (window.confirm guarded)
 *
 * Mirrors design.html §07 "常用提示词面板".
 */

const inputClass =
  'w-full rounded-md border border-border bg-panel-2 px-2 py-1 text-xs text-fg outline-none transition-colors placeholder:text-fg-faint focus:border-accent';
const textareaClass = inputClass + ' leading-relaxed';
const miniBtnClass =
  'rounded px-1.5 py-0.5 text-[11px] text-fg-faint transition-colors hover:bg-border-soft hover:text-fg';

export default function PromptPanel() {
  const promptGroups = useStore((s) => s.promptGroups);
  const locale = useStore((s) => s.locale);
  const autoTranslate = useStore((s) => s.promptAutoTranslate);
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  const taskLedger = useStore((s) => s.workflow.meta.run?.taskLedger);
  const mode = useStore((s) => s.mode);
  const appendComposerDraft = useStore((s) => s.appendComposerDraft);
  const addPromptItem = useStore((s) => s.addPromptItem);
  const updatePromptItemLocalized = useStore(
    (s) => s.updatePromptItemLocalized,
  );
  const removePromptItem = useStore((s) => s.removePromptItem);
  const addPromptGroup = useStore((s) => s.addPromptGroup);
  const updatePromptGroupLocalized = useStore(
    (s) => s.updatePromptGroupLocalized,
  );
  const removePromptGroup = useStore((s) => s.removePromptGroup);
  const resetPromptGroups = useStore((s) => s.resetPromptGroups);

  const [editMode, setEditMode] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // Id of the item currently being edited inline (one at a time).
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  // Id of the group whose label is being renamed inline.
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [translatingItemId, setTranslatingItemId] = useState<string | null>(null);
  const [statusText, setStatusText] = useState<string | null>(null);

  const toggle = (id: string) =>
    setCollapsed((prev) => ({ ...prev, [id]: !prev[id] }));

  const { width, onResizeStart } = useResizableWidth({
    storageKey: 'freeultracode.panelWidth.v1',
    defaultWidth: 288,
    min: 220,
    max: 560,
    edge: 'left',
  });

  const handleAddItem = (groupId: string) => {
    if (collapsed[groupId]) toggle(groupId);
    addPromptItem(groupId, t(locale, 'prompt.newPrompt'), '', locale);
    // The new item is appended; open its editor on the next render. We locate it
    // by reading the freshly-updated store state.
    const grp = useStore.getState().promptGroups.find((g) => g.id === groupId);
    const last = grp?.items[grp.items.length - 1];
    if (last) setEditingItemId(last.id);
  };

  const handleAddGroup = () => {
    const id = addPromptGroup(t(locale, 'prompt.newGroup'), locale);
    setRenamingGroupId(id);
  };

  const handleReset = () => {
    if (window.confirm(t(locale, 'prompt.resetConfirm'))) {
      resetPromptGroups();
      setEditingItemId(null);
      setRenamingGroupId(null);
      setStatusText(null);
    }
  };

  const saveItem = async (
    groupId: string,
    itemId: string,
    patch: Partial<PromptItem>,
  ) => {
    const translating = autoTranslate;
    if (translating) setTranslatingItemId(itemId);
    setStatusText(
      translating ? t(locale, 'prompt.translating') : null,
    );
    const translated = await updatePromptItemLocalized(
      groupId,
      itemId,
      patch,
      locale,
    );
    if (translating) setTranslatingItemId(null);
    setEditingItemId(null);
    setStatusText(
      translated
        ? t(locale, 'prompt.translateDone')
        : t(
            locale,
            autoTranslate
              ? 'prompt.translateSkipped'
              : 'prompt.translateDisabled',
          ),
    );
  };

  const saveGroup = async (groupId: string, label: string) => {
    const trimmed = label.trim();
    if (!trimmed) {
      setRenamingGroupId(null);
      return;
    }
    setStatusText(
      autoTranslate ? t(locale, 'prompt.translating') : null,
    );
    const translated = await updatePromptGroupLocalized(groupId, trimmed, locale);
    setRenamingGroupId(null);
    setStatusText(
      translated
        ? t(locale, 'prompt.translateDone')
        : t(
            locale,
            autoTranslate
              ? 'prompt.translateSkipped'
              : 'prompt.translateDisabled',
          ),
    );
  };

  return (
    <aside
      className="relative flex h-full shrink-0 flex-col border-l border-border bg-panel"
      style={{ width }}
    >
      {/* Resize handle — left edge, drag horizontally. */}
      <div
        onMouseDown={onResizeStart}
        title={t(locale, 'common.resizeWidth')}
        className="group absolute -left-1 top-0 bottom-0 z-20 flex w-2 cursor-col-resize items-center justify-center"
      >
        <div className="h-full w-0.5 bg-transparent transition-colors group-hover:bg-accent/40" />
      </div>

      <div className="flex items-center gap-2 border-b border-border-soft px-4 py-3.5">
        <span className="text-accent-3">◨</span>
        <span className="text-sm font-semibold tracking-tight text-fg">
          {selectedNodeId
            ? t(locale, 'prompt.nodeProperties')
            : taskLedger
              ? t(locale, 'prompt.taskLedger')
              : t(locale, 'prompt.commonPrompts')}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {!selectedNodeId && !taskLedger && (
            <button
              type="button"
              onClick={() => {
                setEditMode((v) => !v);
                setEditingItemId(null);
                setRenamingGroupId(null);
              }}
              className="rounded px-2 py-0.5 text-[11px] text-fg-faint transition-colors hover:bg-border-soft hover:text-fg"
            >
              {editMode ? t(locale, 'common.done') : t(locale, 'common.edit')}
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {selectedNodeId ? (
          <NodeInspector />
        ) : taskLedger ? (
          <TaskLedgerPanel ledger={taskLedger} />
        ) : (
          <div className="flex flex-col gap-4">
            {promptGroups.map((group) => {
              const isCollapsed = collapsed[group.id];
              const isRenaming = renamingGroupId === group.id;
              const localizedGroup = localizePromptGroup(group, locale);
              return (
                <div key={group.id}>
                  {isRenaming ? (
                    <div className="mb-1.5 flex items-center gap-1">
                      <input
                        autoFocus
                        defaultValue={localizedGroup.label}
                        onBlur={(e) => {
                          void saveGroup(group.id, e.target.value);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') e.currentTarget.blur();
                          if (e.key === 'Escape') setRenamingGroupId(null);
                        }}
                        className={inputClass}
                      />
                    </div>
                  ) : (
                    <div className="mb-1.5 flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => toggle(group.id)}
                        className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[11px] font-medium uppercase tracking-wider text-fg-faint transition-colors hover:text-fg-dim"
                      >
                        <span
                          className={
                            'inline-block text-[9px] transition-transform ' +
                            (isCollapsed ? '' : 'rotate-90')
                          }
                        >
                          ▶
                        </span>
                        <span className="truncate">{localizedGroup.label}</span>
                      </button>
                      {editMode && (
                        <>
                          <button
                            type="button"
                            title={t(locale, 'prompt.renameGroup')}
                            onClick={() => setRenamingGroupId(group.id)}
                            className={miniBtnClass}
                          >
                            ✎
                          </button>
                          <button
                            type="button"
                            title={t(locale, 'prompt.deleteGroup')}
                            onClick={() => {
                              if (
                                window.confirm(
                                  `${t(locale, 'prompt.deleteGroupConfirmPrefix')}「${localizedGroup.label}」${t(locale, 'prompt.deleteGroupConfirmSuffix')}`,
                                )
                              )
                                removePromptGroup(group.id);
                            }}
                            className={miniBtnClass + ' hover:text-accent-2'}
                          >
                            ×
                          </button>
                        </>
                      )}
                    </div>
                  )}

                  {!isCollapsed && (
                    <ul className="flex flex-col gap-0.5">
                      {group.items.map((item) => {
                        const localizedItem = localizePromptItem(item, locale);
                        const promptEntryDisabled = isPromptEntryDisabled(mode);
                        return editMode && editingItemId === item.id ? (
                          <li key={item.id}>
                            <ItemEditor
                              item={item}
                              onSave={(patch) => saveItem(group.id, item.id, patch)}
                              onCancel={() => setEditingItemId(null)}
                              locale={locale}
                              busy={translatingItemId === item.id}
                            />
                          </li>
                        ) : (
                          <li key={item.id}>
                            <div className="group flex w-full items-start gap-1">
                              <button
                                type="button"
                                disabled={promptEntryDisabled}
                                onClick={() => {
                                  if (editMode) {
                                    setEditingItemId(item.id);
                                    return;
                                  }
                                  appendComposerDraft(localizedItem.text);
                                }}
                                title={
                                  promptEntryDisabled
                                    ? t(locale, 'dock.inputLockedTitle')
                                    : localizedItem.text
                                }
                                className={
                                  'flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm text-fg-dim transition-colors ' +
                                  (promptEntryDisabled
                                    ? 'cursor-not-allowed text-fg-faint opacity-50'
                                    : 'hover:bg-border-soft hover:text-fg')
                                }
                              >
                                <span
                                  className={
                                    'mt-0.5 transition-colors ' +
                                    (promptEntryDisabled
                                      ? 'text-fg-faint'
                                      : 'text-accent group-hover:text-accent-2')
                                  }
                                >
                                  {editMode ? '✎' : '▷'}
                                </span>
                                <span className="min-w-0 flex-1">
                                  {localizedItem.label}
                                </span>
                              </button>
                              {editMode && (
                                <button
                                  type="button"
                                  title={t(locale, 'prompt.deletePrompt')}
                                  onClick={() => removePromptItem(group.id, item.id)}
                                  className={
                                    miniBtnClass + ' mt-1 hover:text-accent-2'
                                  }
                                >
                                  ×
                                </button>
                              )}
                            </div>
                          </li>
                        );
                      })}
                      {editMode && (
                        <li>
                          <button
                            type="button"
                            onClick={() => handleAddItem(group.id)}
                            className="mt-0.5 w-full rounded-md border border-dashed border-border-soft px-2 py-1 text-left text-[11px] text-fg-faint transition-colors hover:border-accent hover:text-fg-dim"
                          >
                            {t(locale, 'prompt.addPrompt')}
                          </button>
                        </li>
                      )}
                    </ul>
                  )}
                </div>
              );
            })}

            {editMode && (
              <div className="flex flex-col gap-2 border-t border-border-soft pt-3">
                <button
                  type="button"
                  onClick={handleAddGroup}
                  className="w-full rounded-md border border-dashed border-border-soft px-2 py-1.5 text-xs text-fg-dim transition-colors hover:border-accent hover:text-fg"
                >
                  {t(locale, 'prompt.addGroup')}
                </button>
                <button
                  type="button"
                  onClick={handleReset}
                  className="w-full rounded-md px-2 py-1.5 text-[11px] text-fg-faint transition-colors hover:bg-border-soft hover:text-accent-2"
                >
                  {t(locale, 'prompt.resetDefaults')}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {!selectedNodeId && !taskLedger && (
        <div className="border-t border-border-soft px-4 py-2.5 text-[10px] leading-relaxed text-fg-faint">
          {statusText ??
            (editMode
              ? t(
                  locale,
                  autoTranslate
                    ? 'prompt.editHelpOn'
                    : 'prompt.editHelpOff',
                )
              : t(locale, 'prompt.clickHelp'))}
        </div>
      )}
    </aside>
  );
}

/** Inline editor for a single prompt item: label <input> + text <textarea>. */
function ItemEditor({
  item,
  onSave,
  onCancel,
  locale,
  busy,
}: {
  item: PromptItem;
  onSave: (patch: Partial<PromptItem>) => void | Promise<void>;
  onCancel: () => void;
  locale: Locale;
  busy: boolean;
}) {
  const localized = localizePromptItem(item, locale);
  const [label, setLabel] = useState(localized.label);
  const [text, setText] = useState(localized.text);
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border bg-panel-2 p-2">
      <input
        autoFocus
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder={t(locale, 'prompt.labelPlaceholder')}
        className={inputClass}
      />
      <AutoTextarea
        value={text}
        onChange={setText}
        placeholder={t(locale, 'prompt.textPlaceholder')}
        minHeight={56}
        maxHeight={220}
        className={textareaClass}
      />
      <div className="flex items-center justify-end gap-1.5">
        <button type="button" onClick={onCancel} className={miniBtnClass}>
          {t(locale, 'common.cancel')}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void onSave({
              label: label.trim() || t(locale, 'prompt.fallbackName'),
              text,
            })
          }
          className="rounded bg-accent/15 px-2 py-0.5 text-[11px] text-accent transition-colors hover:bg-accent/25 disabled:cursor-wait disabled:opacity-60"
        >
          {busy ? t(locale, 'prompt.translating') : t(locale, 'common.save')}
        </button>
      </div>
    </div>
  );
}
