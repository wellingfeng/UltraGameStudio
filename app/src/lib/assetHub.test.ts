import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { __resetAssetsForTest, getAssets, initializeAssetIndex, flushAssetIndex, linkKnownAssetsToNearestMessages, linkManagedAssetsFromMessageText, linkModifiedAssetsFromMessage, mergeCachedAssetsFromDisk, registerAsset, removeAsset, updateAssetDetails, markAssetDone } from './downloadRegistry';
import { filterHubAssets } from './assetHubModel';
import { readAssetIndex, writeAssetIndex, type AssetIndexIO } from './assetIndex';
import { regenerateAsset } from './assetReuse';
import { saveAssetCopy } from './assetCopy';

afterEach(() => { __resetAssetsForTest(); window.localStorage.clear(); });
const options = { scope: 'all' as const, category: 'all' as const, query: '', source: 'all', favoritesOnly: false, oldestFirst: false };
const memory = () => {
  const files = new Map<string, string>();
  const io: AssetIndexIO = { read: async path => files.get(path) ?? null, write: async (path, json) => { files.set(path, json); } };
  return { files, io };
};

describe('资产中心收集与筛选', () => {
  it('与回答卡片统一：带空格的办公文档入库，工具日志/代码/源文件引用排除', () => {
    linkManagedAssetsFromMessageText({ text: '[交付报告](</E:/Game/reports/研发 报告.docx>)\n[数据](E:/Game/outputs/数据.xlsx)\n[演示](E:/Game/artifacts/演示.pptx)\n[源码](E:/Game/app.ts:2)\n```md\n[示例](E:/Game/reports/example.docx)\n```', sessionId: 's', workspaceId: 'w', messageId: 'm', at: 12 });
    expect(getAssets().map(e => e.localPath).sort()).toEqual(['E:/Game/reports/研发 报告.docx', 'E:/Game/outputs/数据.xlsx', 'E:/Game/artifacts/演示.pptx'].sort());
    expect(getAssets().every(e => e.startedAt === 12 && e.messageId === 'm')).toBe(true);
  });
  it('输入与安装能力不混入默认产物；未知项目只在全部项目出现', () => {
    mergeCachedAssetsFromDisk([{ kind: 'image', title: '输入图', source: 'generated', localPath: 'E:/Game/.ultragamestudio/clipboard-images/a.png' }], 'w');
    registerAsset({ kind: 'skill', source: 'installed', title: '能力', status: 'success', workspaceId: 'w' });
    registerAsset({ kind: 'file', source: 'generated', title: '未知项目', status: 'success' });
    registerAsset({ kind: 'file', source: 'modified', title: '项目产物', status: 'success', workspaceId: 'w' });
    linkKnownAssetsToNearestMessages({ messages: [{ role: 'assistant', sessionId: 's', workspaceId: 'w', messageId: 'm', createdAt: Date.now() }] });
    expect(filterHubAssets(getAssets(), { ...options }).map(e => e.title).sort()).toEqual(['未知项目', '项目产物']);
    expect(filterHubAssets(getAssets(), { ...options, scope: 'workspace', workspaceId: 'w' }).map(e => e.title)).toEqual(['项目产物']);
    expect(filterHubAssets(getAssets(), { ...options, category: 'input' })).toHaveLength(1);
  });
  it('同路径并行登记后，旧任务回执仍能完成归并资源', () => {
    const old = registerAsset({ kind: 'file', source: 'generated', localPath: 'E:/a.docx' });
    registerAsset({ kind: 'file', source: 'generated', localPath: 'E:/a.docx' });
    markAssetDone(old, { sizeBytes: 123 });
    expect(getAssets()).toHaveLength(1);
    expect(getAssets()[0].status).toBe('success');
    expect(getAssets()[0].sizeBytes).toBe(123);
  });
  it('修改操作使用已确认的文件变更，引用归并且旧消息不覆盖最新来源', () => {
    const input = { sessionId: 's', workspaceId: 'w', messageId: 'm2', at: 200, changes: { source: 'agent' as const, rootPath: 'E:/Game', files: [{ path: 'report.docx', status: 'modified' as const }, { path: 'gone.docx', status: 'deleted' as const }] } };
    linkModifiedAssetsFromMessage(input);
    linkModifiedAssetsFromMessage(input);
    linkManagedAssetsFromMessageText({ text: '[报告](E:/Game/report.docx)', sessionId: 's', workspaceId: 'w', messageId: 'm1', at: 100, sessionTitle: '旧消息' });
    expect(getAssets()).toHaveLength(1);
    expect(getAssets()[0].source).toBe('modified');
    expect(getAssets()[0].messageId).toBe('m2');
    expect(getAssets()[0].events).toHaveLength(2);
  });
  it('同路径不同斜杠/大小写去重，收藏标签与会话标题可搜索', () => {
    const a = registerAsset({ kind: 'file', source: 'generated', status: 'success', localPath: 'E:/Game/Report.docx', sessionId: 's', workspaceId: 'w' });
    registerAsset({ kind: 'file', source: 'modified', status: 'success', localPath: 'e:\\game\\report.docx', sessionId: 's2', workspaceId: 'w2' });
    expect(getAssets()).toHaveLength(1);
    updateAssetDetails(getAssets()[0].id, { favorite: true, tags: [' 报告 ', '报告'], sessionTitle: '渲染研究' });
    expect(filterHubAssets(getAssets(), { ...options, query: '渲染研究', favoritesOnly: true })).toHaveLength(1);
    expect(filterHubAssets(getAssets(), { ...options, query: 'game' })).toHaveLength(1);
    expect(getAssets()[0].tags).toEqual(['报告']);
    expect(a).toBeTruthy();
  });
});

describe('资产索引迁移与恢复', () => {
  it('1500 个文件真正落盘，清空浏览器记录后完整恢复；移除不复活', async () => {
    const root = resolve('../.ultragamestudio/tests/asset-center-index', `${Date.now()}`);
    const io: AssetIndexIO = {
      read: async path => { try { return await readFile(resolve(root, path), 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; } },
      write: async (path, json) => { const file = resolve(root, path); await mkdir(dirname(file), { recursive: true }); await writeFile(file, json); },
    };
    // Migrate a genuine legacy localStorage payload, not the new index API.
    window.localStorage.setItem('ultragamestudio.assets.v1', JSON.stringify(Array.from({ length: 1500 }, (_, i) => ({ id: `a${i}`, kind: 'file', source: 'generated', origin: 'local', status: 'success', title: `报告${i}.docx`, localPath: `E:/Game/reports/${i}.docx`, workspaceId: i % 2 ? 'w1' : 'w2', startedAt: i + 1 }))));
    await initializeAssetIndex(io); await flushAssetIndex();
    expect((await readAssetIndex(io))?.entries).toHaveLength(1500);
    expect(JSON.parse((await io.read('assets/migration-v1.json'))!).entries).toHaveLength(1500);
    updateAssetDetails('a1499', { favorite: true, tags: ['验收'] });
    removeAsset('a1'); await flushAssetIndex();
    __resetAssetsForTest(); window.localStorage.clear();
    await initializeAssetIndex(io); await flushAssetIndex();
    expect(getAssets()).toHaveLength(1499);
    expect(getAssets().find(e => e.id === 'a1499')?.favorite).toBe(true);
    mergeCachedAssetsFromDisk([{ kind: 'file', title: '已清除', localPath: 'E:/Game/reports/1.docx' }], 'w1');
    expect(getAssets()).toHaveLength(1499);
    await flushAssetIndex();
  });
  it('磁盘读取期间的新登记/删除不丢失', async () => {
    const { io } = memory();
    registerAsset({ kind: 'file', source: 'generated', status: 'success', localPath: 'E:/a.docx' });
    await writeAssetIndex(io, { version: 2, entries: getAssets(), dismissedPaths: [] });
    const id = getAssets()[0].id;
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const load = initializeAssetIndex({ ...io, read: async p => { await gate; return io.read(p); } });
    removeAsset(id);
    registerAsset({ kind: 'file', source: 'generated', status: 'success', localPath: 'E:/b.docx' });
    release(); await load; await flushAssetIndex();
    expect(getAssets().map(e => e.localPath)).toEqual(['E:/b.docx']);
  });
  it('损坏索引不被空库覆盖；可观测失败', async () => {
    const { io, files } = memory(); files.set('assets/catalog.v2.json', '{ broken');
    await initializeAssetIndex(io);
    await expect(flushAssetIndex()).rejects.toThrow('资产索引读取失败');
    expect(files.get('assets/catalog.v2.json')).toBe('{ broken');
  });
  it('旧版本重新迁移不会改变收藏或清除记录', async () => {
    const { io } = memory();
    registerAsset({ kind: 'file', source: 'generated', status: 'success', localPath: 'E:/a.docx' });
    await initializeAssetIndex(io); await flushAssetIndex();
    updateAssetDetails(getAssets()[0].id, { favorite: true }); await flushAssetIndex();
    __resetAssetsForTest();
    await initializeAssetIndex(io); await flushAssetIndex();
    expect(getAssets()[0].favorite).toBe(true);
    expect((await readAssetIndex(io))?.entries).toHaveLength(1);
  });
});

describe('原参数再次生成', () => {
  it('调用现有生成入口并等待成功回执，渠道和模型原样保留', async () => {
    const generate = vi.fn((_prompt, options) => options.onSettled({ ok: true }));
    const state = { generateImagePrompt: generate, generateSpritePrompt: generate, generateVideoPrompt: generate, generateMusicPrompt: generate, generateSpeechPrompt: generate, generateThreeDPrompt: generate };
    await regenerateAsset({ id: 'a', kind: 'image', source: 'generated', status: 'success', origin: 'remote', title: 'a', startedAt: 1, provider: 'openai', model: 'gpt-image-1', prompt: '测试提示词' }, state);
    expect(generate).toHaveBeenCalledWith('测试提示词', expect.objectContaining({ providerId: 'openai', model: 'gpt-image-1' }));
  });
});

describe('产物另存', () => {
  it('真实二进制文件另存逐字节一致；取消和原路径不写入', async () => {
    const source = resolve('../.ultragamestudio/tests/asset-center-copy/source.bin');
    const target = resolve('../.ultragamestudio/tests/asset-center-copy/target.bin');
    await mkdir(dirname(source), { recursive: true });
    await writeFile(source, Uint8Array.from({ length: 256 }, (_, index) => index));
    const bytes = await readFile(source);
    const write = vi.fn(async (path, data) => { await writeFile(path, data); });
    const io = { choose: async () => target, read: async () => ({ bytesBase64: bytes.toString('base64') }), write };
    await saveAssetCopy(source, io);
    expect(await readFile(target)).toEqual(bytes);
    write.mockClear();
    await saveAssetCopy(source, { ...io, choose: async () => null });
    await expect(saveAssetCopy(source, { ...io, choose: async () => source })).rejects.toThrow('不同的目标文件');
    expect(write).not.toHaveBeenCalled();
  });
});
