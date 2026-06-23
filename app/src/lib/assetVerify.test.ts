import { afterEach, describe, expect, it, vi } from 'vitest';
import { canVerifyAsset, verifyAsset } from './assetVerify';
import type { GatewaySelection } from './modelGateway';

const mocks = vi.hoisted(() => ({
  completeGatewayText: vi.fn(),
  resolveDirectGatewayRoute: vi.fn(),
}));

vi.mock('./modelGateway', () => ({
  completeGatewayText: mocks.completeGatewayText,
  resolveDirectGatewayRoute: mocks.resolveDirectGatewayRoute,
}));

const SELECTION = { adapter: 'anthropic', model: 'claude' } as unknown as GatewaySelection;
const DATA_URL = 'data:image/png;base64,AAAA';
const ROUTE = { transport: 'anthropic', apiKey: 'k', model: 'claude' };

afterEach(() => {
  vi.clearAllMocks();
});

describe('canVerifyAsset', () => {
  it('is true only when a direct route resolves', () => {
    mocks.resolveDirectGatewayRoute.mockReturnValueOnce(ROUTE);
    expect(canVerifyAsset(SELECTION)).toBe(true);
    mocks.resolveDirectGatewayRoute.mockReturnValueOnce(null);
    expect(canVerifyAsset(SELECTION)).toBe(false);
  });
});

describe('verifyAsset', () => {
  it('returns null when there is no direct route (skip, not fail)', async () => {
    mocks.resolveDirectGatewayRoute.mockReturnValue(null);
    const verdict = await verifyAsset({
      kind: 'image',
      prompt: 'a cat',
      sources: [DATA_URL],
      selection: SELECTION,
    });
    expect(verdict).toBeNull();
    expect(mocks.completeGatewayText).not.toHaveBeenCalled();
  });

  it('returns null when no inspectable image source is present', async () => {
    mocks.resolveDirectGatewayRoute.mockReturnValue(ROUTE);
    const verdict = await verifyAsset({
      kind: 'image',
      prompt: 'a cat',
      sources: ['not-an-image', ''],
      selection: SELECTION,
    });
    expect(verdict).toBeNull();
  });

  it('parses a passing verdict and forwards images to the vision model', async () => {
    mocks.resolveDirectGatewayRoute.mockReturnValue(ROUTE);
    mocks.completeGatewayText.mockResolvedValue(
      '{"score": 88, "pass": true, "defects": [], "promptPatch": ""}',
    );
    const verdict = await verifyAsset({
      kind: 'image',
      prompt: 'a cat',
      sources: [DATA_URL],
      selection: SELECTION,
    });
    expect(verdict).toEqual({ pass: true, score: 88, defects: [], promptPatch: undefined });
    const call = mocks.completeGatewayText.mock.calls[0][0];
    expect(call.userImages).toEqual([DATA_URL]);
    expect(call.route).toBe(ROUTE);
  });

  it('derives a failing verdict and surfaces defects + promptPatch', async () => {
    mocks.resolveDirectGatewayRoute.mockReturnValue(ROUTE);
    mocks.completeGatewayText.mockResolvedValue(
      '```json\n{"score": 40, "defects": ["手指畸形"], "promptPatch": "重画手部为五指"}\n```',
    );
    const verdict = await verifyAsset({
      kind: 'image',
      prompt: 'a cat',
      sources: [DATA_URL],
      selection: SELECTION,
      threshold: 70,
    });
    expect(verdict?.pass).toBe(false);
    expect(verdict?.score).toBe(40);
    expect(verdict?.defects).toEqual(['手指畸形']);
    expect(verdict?.promptPatch).toBe('重画手部为五指');
  });

  it('caps the number of images sent to bound cost', async () => {
    mocks.resolveDirectGatewayRoute.mockReturnValue(ROUTE);
    mocks.completeGatewayText.mockResolvedValue('{"score":90,"pass":true}');
    await verifyAsset({
      kind: 'sprite',
      prompt: 'p',
      sources: [DATA_URL, DATA_URL, DATA_URL],
      selection: SELECTION,
    });
    const call = mocks.completeGatewayText.mock.calls[0][0];
    expect(call.userImages).toHaveLength(2);
  });

  it('treats an unparseable verdict as a pass to avoid wasted retries', async () => {
    mocks.resolveDirectGatewayRoute.mockReturnValue(ROUTE);
    mocks.completeGatewayText.mockResolvedValue('the model rambled with no json');
    const verdict = await verifyAsset({
      kind: 'image',
      prompt: 'p',
      sources: [DATA_URL],
      selection: SELECTION,
      threshold: 65,
    });
    expect(verdict?.pass).toBe(true);
    expect(verdict?.score).toBe(65);
  });
});
