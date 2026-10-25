import type { AssetEntry } from './downloadRegistry';
import type { OnGenerationSettled } from './assetCapture';
import type { StoreState } from '@/store/storeState';

type Generator<P extends string> = (text: string, options?: {
  providerId?: P; model?: string; strictProvider?: boolean; onSettled?: OnGenerationSettled;
}) => void;

/** Reuse the original provider/model through the existing generation actions. */
export async function regenerateAsset(entry: AssetEntry, state: Pick<StoreState,
  'generateImagePrompt' | 'generateSpritePrompt' | 'generateVideoPrompt' | 'generateMusicPrompt' | 'generateSpeechPrompt' | 'generateThreeDPrompt'>): Promise<void> {
  if (!entry.prompt || !entry.provider || !entry.model) throw new Error('原提示词、渠道或模型未记录，无法按原参数再次生成');
  const invoke = <P extends string>(generate: Generator<P>) => new Promise<void>((resolve, reject) => {
    generate(entry.prompt!, {
      providerId: entry.provider as P, model: entry.model, strictProvider: true,
      onSettled: result => result.ok ? resolve() : reject(new Error(result.error ?? '再次生成失败')),
    });
  });
  switch (entry.kind) {
    case 'image': return invoke(state.generateImagePrompt);
    case 'sprite': return invoke(state.generateSpritePrompt);
    case 'video': return invoke(state.generateVideoPrompt);
    case 'speech': return invoke(state.generateSpeechPrompt);
    case 'audio': case 'music': return invoke(state.generateMusicPrompt);
    case 'mesh': case 'model': return invoke(state.generateThreeDPrompt);
    default: throw new Error('该类型暂不支持按原参数再次生成');
  }
}
