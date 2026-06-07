/**
 * Minimal type declarations for `gifenc` (it ships no types). Only the surface
 * we use — GIFEncoder + quantize + applyPalette — is declared here.
 * @see https://github.com/mattdesl/gifenc
 */
declare module 'gifenc' {
  export interface GifEncoderWriteFrameOptions {
    /** Indexed palette (array of [r,g,b] or [r,g,b,a]). */
    palette?: number[][];
    /** Frame delay in milliseconds. */
    delay?: number;
    /** Disposal method; 2 = restore to background. */
    dispose?: number;
    /** Whether the frame is rendered as transparent where applicable. */
    transparent?: boolean;
    transparentIndex?: number;
    repeat?: number;
    first?: boolean;
  }

  export interface GifEncoderInstance {
    writeFrame(
      index: Uint8Array | Uint8ClampedArray,
      width: number,
      height: number,
      options?: GifEncoderWriteFrameOptions,
    ): void;
    finish(): void;
    bytes(): Uint8Array;
    bytesView(): Uint8Array;
    reset(): void;
  }

  export function GIFEncoder(options?: {
    auto?: boolean;
    initialCapacity?: number;
  }): GifEncoderInstance;

  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: { format?: 'rgb565' | 'rgb444' | 'rgba4444'; oneBitAlpha?: boolean | number; clearAlpha?: boolean },
  ): number[][];

  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: number[][],
    format?: 'rgb565' | 'rgb444' | 'rgba4444',
  ): Uint8Array;
}
