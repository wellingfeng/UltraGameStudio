import { describe, expect, it } from 'vitest';
import { comfyToFlow, comfyGraphStats } from './comfyToFlow';
import type { ComfyPromptGraph } from '@/lib/comfyui';

const GRAPH: ComfyPromptGraph = {
  loader: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'm.safetensors' } },
  pos: {
    class_type: 'CLIPTextEncode',
    inputs: { text: 'a cat', clip: ['loader', 1] },
    _meta: { title: '正向提示词' },
  },
  save: { class_type: 'SaveImage', inputs: { images: ['pos', 0] } },
};

describe('comfyToFlow', () => {
  it('projects nodes with title, classType, and literal fields', () => {
    const { nodes } = comfyToFlow(GRAPH);
    expect(nodes).toHaveLength(3);
    const pos = nodes.find((n) => n.id === 'pos')!;
    expect(pos.data.title).toBe('正向提示词');
    expect(pos.data.classType).toBe('CLIPTextEncode');
    // The `clip` link is excluded; only the `text` literal becomes a field.
    expect(pos.data.fields.map((f) => f.key)).toEqual(['text']);
  });

  it('recovers edges from link-tuple inputs', () => {
    const { edges } = comfyToFlow(GRAPH);
    expect(edges).toHaveLength(2);
    const sources = edges.map((e) => `${e.source}->${e.target}`).sort();
    expect(sources).toEqual(['loader->pos', 'pos->save']);
  });

  it('lays out nodes left-to-right by dependency depth', () => {
    const { nodes } = comfyToFlow(GRAPH);
    const x = (id: string) => nodes.find((n) => n.id === id)!.position.x;
    expect(x('loader')).toBeLessThan(x('pos'));
    expect(x('pos')).toBeLessThan(x('save'));
  });

  it('returns empty for a null graph', () => {
    expect(comfyToFlow(null)).toEqual({ nodes: [], edges: [] });
  });

  it('does not crash on a cyclic graph', () => {
    const cyclic: ComfyPromptGraph = {
      a: { class_type: 'X', inputs: { in: ['b', 0] } },
      b: { class_type: 'Y', inputs: { in: ['a', 0] } },
    };
    const { nodes, edges } = comfyToFlow(cyclic);
    expect(nodes).toHaveLength(2);
    expect(edges).toHaveLength(2);
  });
});

describe('comfyGraphStats', () => {
  it('counts nodes and link edges', () => {
    expect(comfyGraphStats(GRAPH)).toEqual({ nodes: 3, edges: 2 });
  });

  it('returns zeros for a null graph', () => {
    expect(comfyGraphStats(null)).toEqual({ nodes: 0, edges: 0 });
  });
});
