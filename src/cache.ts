const CACHE_NAME = 'upscaler-models-v1';

export type Progress = (loaded: number, total: number) => void;

// Bytes received by a download that failed part-way, so a retry can resume.
const partials = new Map<string, { chunks: Uint8Array[]; loaded: number }>();

export async function isCached(url: string): Promise<boolean> {
  try {
    return !!(await (await caches.open(CACHE_NAME)).match(url));
  } catch {
    return false;
  }
}

export function partialBytes(url: string): number {
  return partials.get(url)?.loaded ?? 0;
}

/** Returns the model bytes from the browser cache, downloading (and caching) on a miss. */
export async function loadModel(
  url: string,
  expected: number,
  onProgress: Progress,
  signal?: AbortSignal,
): Promise<{ buf: ArrayBuffer; fromCache: boolean }> {
  let cache: Cache | null = null;
  try {
    cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(url);
    if (hit) return { buf: await hit.arrayBuffer(), fromCache: true };
  } catch {
    /* Cache Storage unavailable (e.g. private mode): download every time. */
  }

  let part = partials.get(url);
  if (!part) partials.set(url, (part = { chunks: [], loaded: 0 }));

  const get = async (resume: boolean) => {
    const headers: HeadersInit = resume && part!.loaded > 0 ? { Range: `bytes=${part!.loaded}-` } : {};
    return fetch(url, { signal, headers });
  };

  let res: Response;
  try {
    res = await get(true);
  } catch (e) {
    if (signal?.aborted) throw e;
    // A Range request can fail CORS preflight on some hosts: restart from zero.
    part.chunks = [];
    part.loaded = 0;
    res = await get(false);
  }
  if (res.status === 200) {
    part.chunks = [];
    part.loaded = 0;
  } else if (res.status !== 206) {
    throw new Error(`Download failed (HTTP ${res.status})`);
  }

  const total = part.loaded + (Number(res.headers.get('content-length')) || expected - part.loaded);
  const reader = res.body!.getReader();
  onProgress(part.loaded, total);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    part.chunks.push(value);
    part.loaded += value.length;
    onProgress(part.loaded, total);
  }

  const out = new Uint8Array(part.loaded);
  let o = 0;
  for (const c of part.chunks) {
    out.set(c, o);
    o += c.length;
  }
  if (expected && Math.abs(out.length - expected) > 1024) {
    partials.delete(url);
    throw new Error('Downloaded file has an unexpected size');
  }
  partials.delete(url);
  try {
    await cache?.put(url, new Response(out.slice(), { headers: { 'content-type': 'application/octet-stream' } }));
  } catch {
    /* quota exceeded etc: still usable this session */
  }
  return { buf: out.buffer, fromCache: false };
}
