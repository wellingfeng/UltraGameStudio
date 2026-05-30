import { useState } from 'react';
import { useStore } from '@/store/useStore';
import AutoTextarea from '@/components/AutoTextarea';
import NodeInspector from './NodeInspector';
import { useResizableWidth } from '@/lib/useResizableWidth';
import type { PromptItem } from '@/store/types';

/**
 * CONTRACT: default export, no props. Right-hand prompt panel.
 *
 * Renders the store's grouped prompt library. Each item carries a clickable
 * ▷ triangle; clicking dispatches store.sendPrompt with the item's text.
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
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  const sendPrompt = useStore((s) => s.sendPrompt);
  const addPromptItem = useStore((s) => s.addPromptItem);
  const updatePromptItem = useStore((s) => s.updatePromptItem);
  const removePromptItem = useStore((s) => s.removePromptItem);
  const addPromptGroup = useStore((s) => s.addPromptGroup);
  const updatePromptGroup = useStore((s) => s.updatePromptGroup);
  const removePromptGroup = useStore((s) => s.removePromptGroup);
  const resetPromptGroups = useStore((s) => s.resetPromptGroups);

  const [editMode, setEditMode] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // Id of the item currently being edited inline (one at a time).
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  // Id of the group whose label is being renamed inline.
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);

  const toggle = (id: string) =>
    setCollapsed((prev) => ({ ...prev, [id]: !prev[id] }));

  const { width, onResizeStart } = useResizableWidth({
    storageKey: 'openworkflow.panelWidth.v1',
    defaultWidth: 288,
    min: 220,
    max: 560,
    edge: 'left',
  });

  const handleAddItem = (groupId: string) => {
    if (collapsed[groupId]) toggle(groupId);
    addPromptItem(groupId, '新提示词', '');
    // The new item is appended; open its editor on the next render. We locate it
    // by reading the freshly-updated store state.
    const grp = useStore.getState().promptGroups.find((g) => g.id === groupId);
    const last = grp?.items[grp.items.length - 1];
    if (last) setEditingItemId(last.id);
  };

  const handleAddGroup = () => {
    const id = addPromptGroup('新分组');
    setRenamingGroupId(id);
  };

  const handleReset = () => {
    if (window.confirm('确定恢复默认提示词库？你的所有自定义改动将被覆盖。')) {
      resetPromptGroups();
      setEditingItemId(null);
      setRenamingGroupId(null);
    }
  };

  return (
    <aside
      className="relative flex h-full shrink-0 flex-col border-l border-border bg-panel"
      style={{ width }}
    >
      {/* Resize handle — left edge, drag horizontally. */}
      <div
        onMouseDown={onResizeStart}
        title="拖动调整宽度"
        className="group absolute -left-1 top-0 bottom-0 z-20 flex w-2 cursor-col-resize items-center justify-center"
      >
        <div className="h-full w-0.5 bg-transparent transition-colors group-hover:bg-accent/40" />
      </div>

      <div className="flex items-center gap-2 border-b border-border-soft px-4 py-3.5">
        <span className="text-accent-3">◨</span>
        <span className="text-sm font-semibold tracking-tight text-fg">
          {selectedNodeId ? '节点属性' : '常用提示词'}
        </span>
        {!selectedNodeId && (
          <button
            type="button"
            onClick={() => {
              setEditMode((v) => !v);
              setEditingItemId(null);
              setRenamingGroupId(null);
            }}
            className="ml-auto rounded px-2 py-0.5 text-[11px] text-fg-faint transition-colors hover:bg-border-soft hover:text-fg"
          >
            {editMode ? '完成' : '编辑'}
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {selectedNodeId ? (
          <NodeInspector />
        ) : (
          <div className="flex flex-col gap-4">
            {promptGroups.map((group) => {
              const isCollapsed = collapsed[group.id];
              const isRenaming = renamingGroupId === group.id;
              return (
                <div key={group.id}>
                  {isRenaming ? (
                    <div className="mb-1.5 flex items-center gap-1">
                      <input
                        autoFocus
                        defaultValue={group.label}
                        onBlur={(e) => {
                          const v = e.target.value.trim();
                          if (v) updatePromptGroup(group.id, v);
                          setRenamingGroupId(null);
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
                        <span className="truncate">{group.label}</span>
                      </button>
                      {editMode && (
                        <>
                          <button
                            type="button"
                            title="重命名分组"
                            onClick={() => setRenamingGroupId(group.id)}
                            className={miniBtnClass}
                          >
                            ✎
                          </button>
                          <button
                            type="button"
                            title="删除分组"
                            onClick={() => {
                              if (
                                window.confirm(`删除分组「${group.label}」及其全部提示词？`)
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
                      {group.items.map((item) =>
                        editMode && editingItemId === item.id ? (
                          <li key={item.id}>
                            <ItemEditor
                              item={item}
                              onSave={(patch) => {
                                updatePromptItem(group.id, item.id, patch);
                                setEditingItemId(null);
                              }}
                              onCancel={() => setEditingItemId(null)}
                            />
                          </li>
                        ) : (
                          <li key={item.id}>
                            <div className="group flex w-full items-start gap-1">
                              <button
                                type="button"
                                onClick={() =>
                                  editMode
                                    ? setEditingItemId(item.id)
                                    : sendPrompt(item.text)
                                }
                                title={item.text}
                                className="flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm text-fg-dim transition-colors hover:bg-border-soft hover:text-fg"
                              >
                                <span className="mt-0.5 text-accent transition-colors group-hover:text-accent-2">
                                  {editMode ? '✎' : '▷'}
                                </span>
                                <span className="min-w-0 flex-1">{item.label}</span>
                              </button>
                              {editMode && (
                                <button
                                  type="button"
                                  title="删除提示词"
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
                        ),
                      )}
                      {editMode && (
                        <li>
                          <button
                            type="button"
                            onClick={() => handleAddItem(group.id)}
                            className="mt-0.5 w-full rounded-md border border-dashed border-border-soft px-2 py-1 text-left text-[11px] text-fg-faint transition-colors hover:border-accent hover:text-fg-dim"
                          >
                            + 新增提示词
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
                  + 新增分组
                </button>
                <button
                  type="button"
                  onClick={handleReset}
                  className="w-full rounded-md px-2 py-1.5 text-[11px] text-fg-faint transition-colors hover:bg-border-soft hover:text-accent-2"
                >
                  恢复默认
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {!selectedNodeId && (
        <div className="border-t border-border-soft px-4 py-2.5 text-[10px] leading-relaxed text-fg-faint">
          {editMode
            ? '编辑模式：增删改提示词与分组，改动自动保存。'
            : '点击 ▷ 将该提示词作为消息发给 AI。'}
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
}: {
  item: PromptItem;
  onSave: (patch: Partial<PromptItem>) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(item.label);
  const [text, setText] = useState(item.text);
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border bg-panel-2 p-2">
      <input
        autoFocus
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="标签"
        className={inputClass}
      />
      <AutoTextarea
        value={text}
        onChange={setText}
        placeholder="提示词内容（发送给 AI 的指令）"
        minHeight={56}
        maxHeight={220}
        className={textareaClass}
      />
      <div className="flex items-center justify-end gap-1.5">
        <button type="button" onClick={onCancel} className={miniBtnClass}>
          取消
        </button>
        <button
          type="button"
          onClick={() => onSave({ label: label.trim() || '未命名', text })}
          className="rounded bg-accent/15 px-2 py-0.5 text-[11px] text-accent transition-colors hover:bg-accent/25"
        >
          保存
        </button>
      </div>
    </div>
  );
}
