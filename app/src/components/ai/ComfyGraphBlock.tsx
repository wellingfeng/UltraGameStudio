import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react';
import { Boxes, Maximize2, Play, AlertTriangle } from 'lucide-react';
import CopyButton from './CopyButton';
import RawCodeBlock from './RawCodeBlock';
import {
  comfyToFlow,
  comfyGraphStats,
  type ComfyFlowNodeData,
} from '@/core/comfyToFlow';
import {
  parseComfyGraph,
  runComfyGraph,
  comfyBaseUrl,
  type ComfyOutputImage,
  type ComfyPromptGraph,
} from '@/lib/comfyui';

/**
 * Chat-stream renderer for a fenced ` ```comfyui ` block: a compact, read-only
 * mini node-graph (the analogue of MermaidBlock for ComfyUI). Clicking 展开
 * opens a full-screen editor overlay that takes over the message stream, where
 * each node can be inspected/edited and the graph re-run against the local
 * ComfyUI server. Routed from CodeBlock when the fence language is `comfyui`.
 *
 * The block body (raw JSON) is the single source of truth — editing writes a
 * new graph back through `onEdit`, mirroring how every other embedded block
 * keeps its state in the message text.
 */

/** Custom React Flow node: a small ComfyUI-style card. */
function ComfyNodeCard({ data }: NodeProps) {
  const d = data as ComfyFlowNodeData;
  return (
    <div className="rounded-md border border-[var(--code-border)] bg-[var(--code-bg)] text-[11px] shadow-sm">
      <div className="truncate rounded-t-md border-b border-[var(--code-border)] bg-[var(--code-header-bg)] px-2 py-1 font-medium text-fg-faint">
        {d.title}
      </div>
      {d.fields.length > 0 && (
        <div className="space-y-0.5 px-2 py-1">
          {d.fields.slice(0, 5).map((f) => (
            <div key={f.key} className="flex gap-1.5 leading-tight">
              <span className="shrink-0 text-fg-dim">{f.key}</span>
              <span className="truncate text-fg-faint">{f.value}</span>
            </div>
          ))}
          {d.fields.length > 5 && (
            <div className="text-fg-dim">…+{d.fields.length - 5}</div>
          )}
        </div>
      )}
    </div>
  );
}

const nodeTypes: NodeTypes = { comfy: ComfyNodeCard };

export interface ComfyGraphBlockProps {
  /** Raw block body (ComfyUI prompt-graph JSON). */
  code: string;
  /** Persist an edited graph back into the owning message text, if editable. */
  onEdit?: (nextBody: string) => void;
}

export default function ComfyGraphBlock({ code, onEdit }: ComfyGraphBlockProps) {
  const graph = useMemo(() => parseComfyGraph(code), [code]);
  const [expanded, setExpanded] = useState(false);

  if (!graph) {
    return (
      <div className="ai-comfy my-2 overflow-hidden rounded-lg border border-[var(--code-border)]">
        <div className="flex items-center justify-between gap-2 border-b border-[var(--code-border)] bg-[var(--code-header-bg)] px-3 py-1.5">
          <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-fg-faint">
            <AlertTriangle size={13} className="shrink-0 text-danger" />
            <span className="truncate">ComfyUI 图解析失败</span>
          </span>
          <CopyButton value={code} label="复制" className="px-1 py-0.5" />
        </div>
        <RawCodeBlock raw={code} language="json" compact className="border-x-0 border-b-0" />
      </div>
    );
  }

  return (
    <>
      <ComfyMiniPreview graph={graph} onExpand={() => setExpanded(true)} />
      {expanded && (
        <ComfyEditorOverlay
          graph={graph}
          editable={!!onEdit}
          onSave={(body) => {
            onEdit?.(body);
            setExpanded(false);
          }}
          onClose={() => setExpanded(false)}
        />
      )}
    </>
  );
}

/** Collapsed inline mini-graph shown in the message stream. */
function ComfyMiniPreview({
  graph,
  onExpand,
}: {
  graph: ComfyPromptGraph;
  onExpand: () => void;
}) {
  const { nodes, edges } = useMemo(() => comfyToFlow(graph), [graph]);
  const stats = useMemo(() => comfyGraphStats(graph), [graph]);
  return (
    <div className="ai-comfy my-2 overflow-hidden rounded-lg border border-[var(--code-border)] bg-[var(--code-bg)]">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--code-border)] bg-[var(--code-header-bg)] px-3 py-1.5">
        <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-fg-faint">
          <Boxes size={13} className="shrink-0 text-accent" />
          <span className="truncate">
            ComfyUI · {stats.nodes} 节点 · {stats.edges} 连线
          </span>
        </span>
        <button
          type="button"
          onClick={onExpand}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-fg-faint hover:bg-[var(--code-border)] hover:text-fg"
        >
          <Maximize2 size={12} />
          展开
        </button>
      </div>
      <div className="ai-comfy__mini h-44" aria-label="ComfyUI 节点图预览">
        <ReactFlowProvider>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            zoomOnScroll={false}
            panOnScroll={false}
            panOnDrag={false}
            zoomOnDoubleClick={false}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            minZoom={0.1}
            maxZoom={1.5}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
          </ReactFlow>
        </ReactFlowProvider>
      </div>
    </div>
  );
}

/**
 * Full-screen editor that takes over the message stream. Shows the editable
 * graph, a per-node parameter panel, and Run/Save/Close actions. Editing a
 * node's literal inputs mutates a draft graph; Save serializes it back through
 * onSave so the owning message's block body updates.
 */
function ComfyEditorOverlay({
  graph,
  editable,
  onSave,
  onClose,
}: {
  graph: ComfyPromptGraph;
  editable: boolean;
  onSave: (body: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<ComfyPromptGraph>(() =>
    structuredClone(graph),
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState('');
  const [images, setImages] = useState<ComfyOutputImage[]>([]);

  // Escape closes the overlay, matching the rest of the app's dialog behavior.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const { nodes, edges } = useMemo(() => comfyToFlow(draft), [draft]);
  const selectedNode = selectedId ? draft[selectedId] : null;

  const updateField = useCallback(
    (nodeId: string, key: string, raw: string) => {
      setDraft((prev) => {
        const next = structuredClone(prev);
        const node = next[nodeId];
        if (!node) return prev;
        node.inputs[key] = coerceFieldValue(raw, node.inputs[key]);
        return next;
      });
    },
    [],
  );

  const handleRun = useCallback(async () => {
    setRunning(true);
    setRunError('');
    setImages([]);
    try {
      const result = await runComfyGraph(draft, { baseUrl: comfyBaseUrl() });
      setImages(result);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, [draft]);

  return (
    <div className="ai-comfy-overlay absolute inset-0 z-30 flex flex-col bg-[var(--bg)]">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span className="flex items-center gap-1.5 text-sm font-medium text-fg">
          <Boxes size={15} className="text-accent" />
          ComfyUI 节点编辑器
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => void handleRun()}
            disabled={running}
            className="flex items-center gap-1 rounded bg-accent px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50"
          >
            <Play size={12} />
            {running ? '运行中…' : '运行'}
          </button>
          {editable && (
            <button
              type="button"
              onClick={() => onSave(JSON.stringify(draft, null, 2))}
              className="rounded border border-border px-2.5 py-1 text-xs text-fg-faint hover:text-fg"
            >
              保存并返回
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-border px-2.5 py-1 text-xs text-fg-faint hover:text-fg"
          >
            返回
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <ReactFlowProvider>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodeClick={(_, n) => setSelectedId(n.id)}
              onPaneClick={() => setSelectedId(null)}
              nodesDraggable
              nodesConnectable={false}
              fitView
              fitViewOptions={{ padding: 0.2 }}
              minZoom={0.1}
              maxZoom={2}
              proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
              <Controls showInteractive={false} />
            </ReactFlow>
          </ReactFlowProvider>
        </div>

        <aside className="w-72 shrink-0 overflow-y-auto border-l border-border p-3 text-xs">
          {selectedNode ? (
            <div className="space-y-2">
              <div className="font-medium text-fg">
                {selectedNode._meta?.title?.trim() || selectedNode.class_type}
              </div>
              <div className="text-fg-dim">{selectedNode.class_type}</div>
              {Object.entries(selectedNode.inputs).map(([key, value]) =>
                Array.isArray(value) ? (
                  <div key={key} className="text-fg-dim">
                    <span className="text-fg-faint">{key}</span>
                    <span className="ml-1">← {value[0]}[{value[1]}]</span>
                  </div>
                ) : (
                  <label key={key} className="block space-y-0.5">
                    <span className="text-fg-faint">{key}</span>
                    <input
                      value={value === null ? '' : String(value)}
                      disabled={!editable}
                      onChange={(e) =>
                        selectedId && updateField(selectedId, key, e.target.value)
                      }
                      className="w-full rounded border border-border bg-[var(--code-bg)] px-1.5 py-1 text-fg disabled:opacity-60"
                    />
                  </label>
                ),
              )}
            </div>
          ) : (
            <div className="text-fg-dim">点击节点查看并编辑参数</div>
          )}

          {runError && (
            <div className="mt-3 rounded border border-danger/40 bg-danger/10 p-2 text-danger">
              {runError}
            </div>
          )}
          {images.length > 0 && (
            <div className="mt-3 space-y-2">
              <div className="text-fg-faint">生成结果</div>
              {images.map((img) => (
                <img
                  key={img.url}
                  src={img.url}
                  alt={img.filename}
                  className="w-full rounded border border-border"
                />
              ))}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

/**
 * Coerce an edited string back to the field's original primitive type so the
 * graph stays valid for POST /prompt (numbers stay numbers, etc.).
 */
function coerceFieldValue(raw: string, previous: unknown): string | number | boolean | null {
  if (typeof previous === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : previous;
  }
  if (typeof previous === 'boolean') {
    return raw === 'true' || raw === '1';
  }
  return raw;
}
