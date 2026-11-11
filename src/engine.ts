// Runs inside the inference worker (see worker.ts). Never import from the main thread.
import * as ort from 'onnxruntime-web';
import { Aborted, PAD, effTile, halve, type Pixels } from './pixels';

export interface Runtime {
  gpu: boolean;
  f16: boolean;
  label: string;
}

export interface Session {
  ort: ort.InferenceSession;
  ep: 'webgpu' | 'wasm';
}

export function configure(wasmPaths: string, threads: number) {
  ort.env.wasm.wasmPaths = wasmPaths;
  ort.env.wasm.numThreads = threads;
}

export async function createSession(buf: ArrayBuffer, gpu: boolean): Promise<Session> {
  const bytes = new Uint8Array(buf);
  if (gpu) {
    try {
      const s = await ort.InferenceSession.create(bytes, { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' });
      return { ort: s, ep: 'webgpu' };
    } catch (e) {
      console.warn('WebGPU session failed, falling back to WASM', e);
    }
  }
  return { ort: await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] }), ep: 'wasm' };
}

export async function releaseSession(s: Session | null) {
  try {
    await s?.ort.release();
  } catch {
    /* ignore */
  }
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** One network pass over `src` in overlapping, fixed-size tiles. Output alpha is opaque. */
async function runPass(session: Session, src: Pixels, scale: number, tile: number, onTile: () => void, signal: AbortSignal): Promise<Pixels> {
  const { w, h } = src;
  const T = effTile(w, h, tile);
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
      const result = await session.ort.run({ [inName]: new ort.Tensor('float32', input, [1, 3, S, S]) });
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

export async function upscale(
  session: Session,
  src: Pixels,
  nativeScale: number,
  passes: number,
  downscale: boolean,
  tile: number,
  onTile: (pass: number, done: number) => void,
  signal: AbortSignal,
): Promise<Pixels> {
  let px = src;
  let done = 0;
  for (let p = 1; p <= passes; p++) px = await runPass(session, px, nativeScale, tile, () => onTile(p, ++done), signal);
  return downscale ? halve(px) : px;
}
