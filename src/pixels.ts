export interface Pixels {
  data: Uint8ClampedArray;
  w: number;
  h: number;
}

export class Aborted extends Error {
  constructor() {
    super('Cancelled');
  }
}

export const PAD = 12;

/** Effective tile edge: small images shrink the tile so we don't process mostly padding. */
export const effTile = (w: number, h: number, tile: number) => Math.min(tile, Math.ceil(Math.max(w, h) / 8) * 8);

export function tileCount(w: number, h: number, passes: number, tile: number, nativeScale: number) {
  let total = 0;
  for (let p = 0; p < passes; p++) {
    const T = effTile(w, h, tile);
    total += Math.ceil(w / T) * Math.ceil(h / T);
    w *= nativeScale;
    h *= nativeScale;
  }
  return total;
}

/** Exact 2:1 box-filter downscale (used when a 4x model serves a 2x request). */
export function halve(src: Pixels): Pixels {
  const w = src.w >> 1;
  const h = src.h >> 1;
  const out = new Uint8ClampedArray(w * h * 4);
  const s = src.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = (2 * y * src.w + 2 * x) * 4;
      const b = a + src.w * 4;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 4; c++) out[o + c] = (s[a + c] + s[a + 4 + c] + s[b + c] + s[b + 4 + c] + 2) >> 2;
    }
  }
  return { data: out, w, h };
}
