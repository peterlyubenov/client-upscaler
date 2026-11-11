import type { Pixels } from './pixels';
import { Aborted } from './pixels';

export interface Runtime {
  gpu: boolean;
  f16: boolean;
  label: string;
}

let runtimePromise: Promise<Runtime> | null = null;

/** Probe WebGPU once (cheap, on the main thread). */
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
    return { gpu, f16, label: gpu ? 'WebGPU, WASM fallback' : 'WASM (WebGPU unavailable)' };
  })());
}

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; onTile?: (pass: number, done: number) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  worker.postMessage({
    type: 'configure',
    wasmPaths: new URL('ort/', document.baseURI).href,
    threads: crossOriginIsolated ? Math.min(navigator.hardwareConcurrency || 4, 8) : 1,
  });
  worker.onmessage = (e) => {
    const m = e.data;
    const p = pending.get(m.id);
    if (!p) return;
    if (m.type === 'tile') return p.onTile?.(m.pass, m.done);
    pending.delete(m.id);
    if (m.type === 'error') p.reject(m.aborted ? new Aborted() : new Error(m.message));
    else p.resolve(m);
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || 'Worker crashed'));
    pending.clear();
    worker = null;
  };
  return worker;
}

function call<T>(msg: Record<string, unknown>, transfer: Transferable[] = [], onTile?: (pass: number, done: number) => void): Promise<T> {
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject, onTile });
    getWorker().postMessage({ ...msg, id }, transfer);
  });
}

/** Create the ONNX session in the worker. The buffer is copied so the caller's bytes stay valid. */
export async function loadSession(buf: ArrayBuffer, gpu: boolean): Promise<'webgpu' | 'wasm'> {
  const copy = buf.slice(0);
  return (await call<{ ep: 'webgpu' | 'wasm' }>({ type: 'load', buf: copy, gpu }, [copy])).ep;
}

export async function upscale(
  src: Pixels,
  o: { nativeScale: number; passes: number; downscale: boolean; tile: number },
  onTile: (pass: number, done: number) => void,
  signal: AbortSignal,
): Promise<Pixels> {
  const onAbort = () => worker?.postMessage({ type: 'abort' });
  signal.addEventListener('abort', onAbort);
  try {
    const copy = src.data.slice();
    return (await call<{ out: Pixels }>({ type: 'upscale', src: { data: copy, w: src.w, h: src.h }, ...o }, [copy.buffer], onTile)).out;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
