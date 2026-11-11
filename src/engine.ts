import * as ort from 'onnxruntime-web';

export interface Runtime {
  gpu: boolean;
  f16: boolean;
  label: string;
}

export interface Pixels {
  data: Uint8ClampedArray;
  w: number;
  h: number;
}

export interface Session {
  ort: ort.InferenceSession;
  ep: 'webgpu' | 'wasm';
}

let runtimePromise: Promise<Runtime> | null = null;

/** Probe WebGPU once and configure ONNX Runtime accordingly. */
export function detectRuntime(): Promise<Runtime> {
  return (runtimePromise ??= (async () => {
    let gpu = false;
    let f16 = false;
    try {
      const adapter = await navigator.gpu?.requestAdapter();
      if (adapter) {
        gpu = true;
        f16 = adapter.features.has('shader-f16');
      }
    } catch {
      /* no WebGPU */
    }
    ort.env.wasm.wasmPaths = new URL('ort/', document.baseURI).href;
    ort.env.wasm.numThreads = crossOriginIsolated ? Math.min(navigator.hardwareConcurrency || 4, 8) : 1;
    // Keep the page responsive during WASM inference by running it in a worker.
    // (Not combined with WebGPU, which must stay on the page's own thread.)
    ort.env.wasm.proxy = false;
    return { gpu, f16, label: gpu ? 'WebGPU, WASM fallback' : 'WASM (WebGPU unavailable)' };
  })());
}

export async function createSession(buf: ArrayBuffer, rt: Runtime): Promise<Session> {
  const bytes = new Uint8Array(buf);
  if (rt.gpu) {
    try {
      const s = await ort.InferenceSession.create(bytes, {
        executionProviders: ['webgpu'],
        graphOptimizationLevel: 'all',
      });
      return { ort: s, ep: 'webgpu' };
    } catch (e) {
      console.warn('WebGPU session failed, falling back to WASM', e);
    }
  }
  const s = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
  return { ort: s, ep: 'wasm' };
}

export async function releaseSession(s: Session | null) {
  try {
    await s?.ort.release();
  } catch {
    /* ignore */
  }
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

export class Aborted extends Error {
  constructor() {
    super('Cancelled');
  }
}

/**
 * Run one network pass over `src` in overlapping, fixed-size tiles.
 * Returns opaque RGBA pixels at `scale`x size (alpha is handled by the caller).
 */
export async function runPass(
  session: Session,
  src: Pixels,
  scale: number,
  tile: number,
  onTile: () => void,
  signal: AbortSignal,
): Promise<Pixels> {
  const PAD = 12;
  const { w, h } = src;
  // Small images: shrink the tile so we don't process mostly padding.
  const T = Math.min(tile, Math.ceil(Math.max(w, h) / 8) * 8);
  const S = T + PAD * 2;
  const ow = w * scale;
  const oh = h * scale;
  const out = new Uint8ClampedArray(ow * oh * 4);
  const input = new Float32Array(3 * S * S);
  const inName = session.ort.inputNames[0];
  const outName = session.ort.outputNames[0];
  const plane = S * S;
  const O = S * scale;

  for (let y0 = 0; y0 < h; y0 += T) {
    for (let x0 = 0; x0 < w; x0 += T) {
      if (signal.aborted) throw new Aborted();
      const tw = Math.min(T, w - x0);
      const th = Math.min(T, h - y0);

      for (let y = 0; y < S; y++) {
        const sy = Math.min(h - 1, Math.max(0, y0 - PAD + y));
        for (let x = 0; x < S; x++) {
          const sx = Math.min(w - 1, Math.max(0, x0 - PAD + x));
          const si = (sy * w + sx) * 4;
          const di = y * S + x;
          input[di] = src.data[si] / 255;
          input[plane + di] = src.data[si + 1] / 255;
          input[2 * plane + di] = src.data[si + 2] / 255;
        }
      }

      const tensor = new ort.Tensor('float32', input, [1, 3, S, S]);
      const result = await session.ort.run({ [inName]: tensor });
      const t = result[outName];
      const od = t.data as Float32Array;
      const oplane = O * O;

      const cw = tw * scale;
      const ch = th * scale;
      const off = PAD * scale;
      for (let y = 0; y < ch; y++) {
        let di = ((y0 * scale + y) * ow + x0 * scale) * 4;
        let si = (off + y) * O + off;
        for (let x = 0; x < cw; x++, di += 4, si++) {
          out[di] = od[si] * 255 + 0.5;
          out[di + 1] = od[oplane + si] * 255 + 0.5;
          out[di + 2] = od[2 * oplane + si] * 255 + 0.5;
          out[di + 3] = 255;
        }
      }
      t.dispose();
      onTile();
      await tick();
    }
  }
  return { data: out, w: ow, h: oh };
}

export function tileCount(w: number, h: number, passes: number, tile: number, nativeScale: number) {
  let total = 0;
  for (let p = 0; p < passes; p++) {
    const T = Math.min(tile, Math.ceil(Math.max(w, h) / 8) * 8);
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
      const a = ((2 * y) * src.w + 2 * x) * 4;
      const b = a + src.w * 4;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 4; c++) out[o + c] = (s[a + c] + s[a + 4 + c] + s[b + c] + s[b + 4 + c] + 2) >> 2;
    }
  }
  return { data: out, w, h };
}
