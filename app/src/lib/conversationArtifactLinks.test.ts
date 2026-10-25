import { afterEach, describe, expect, it } from 'vitest';
import { __resetAssetsForTest, getAssets, linkConversationUrls, removeAsset, clearFinishedAssets } from './downloadRegistry';
import { assetCategory, filterHubAssets } from './assetHubModel';

afterEach(() => { __resetAssetsForTest(); localStorage.clear(); });
const input = { sessionId: 's', workspaceId: 'w', messageId: 'm', at: 100, sessionTitle: '渲染研究' };
describe('回答链接索引', () => {
  it('保留链接标题、查询参数与来源；排除图片和代码示例', () => {
    linkConversationUrls({ ...input, text: '[官方参考](https://example.com/api?q=test#section)\nhttps://example.com/other。\n![参考图](https://example.com/image.png)\n```md\nhttps://example.com/code\n```\n`https://example.com/inline`' });
    const entries = getAssets();
    expect(entries).toHaveLength(2);
    expect(entries.find(entry => entry.title === '官方参考')).toMatchObject({ remoteUrl: 'https://example.com/api?q=test#section', messageId: 'm', sessionTitle: '渲染研究', startedAt: 100, provenance: 'answer' });
    expect(entries.every(entry => assetCategory(entry) === 'link')).toBe(true);
    expect(filterHubAssets(entries, { scope: 'workspace', workspaceId: 'w', category: 'link', source: 'all', query: '渲染', favoritesOnly: false, oldestFirst: false })).toHaveLength(2);
  });
  it('重复回填不增行；保留多条引用事件和最新来源；项目隔离', () => {
    const text = '[参考](https://example.com/api)';
    linkConversationUrls({ ...input, text });
    linkConversationUrls({ ...input, text });
    linkConversationUrls({ ...input, text, messageId: 'new', at: 200 });
    linkConversationUrls({ ...input, text, messageId: 'older', at: 50 });
    expect(getAssets()).toHaveLength(1);
    expect(getAssets()[0]).toMatchObject({ messageId: 'new', startedAt: 200 });
    expect(getAssets()[0].events).toHaveLength(3);
    linkConversationUrls({ ...input, text, workspaceId: 'other' });
    expect(getAssets()).toHaveLength(1);
    expect(getAssets()[0].events).toHaveLength(4);
    expect(filterHubAssets(getAssets(), { scope: 'workspace', workspaceId: 'other', category: 'link', source: 'all', query: '', favoritesOnly: false, oldestFirst: false })).toHaveLength(1);
  });
  it('移除和清除结果后，历史回填不复活链接', () => {
    linkConversationUrls({ ...input, text: 'https://example.com/first https://example.com/second' });
    removeAsset(getAssets()[0].id);
    clearFinishedAssets();
    linkConversationUrls({ ...input, text: 'https://example.com/first https://example.com/second' });
    expect(getAssets()).toHaveLength(0);
  });
});
