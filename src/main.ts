import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/600.css';
import '@fontsource/space-grotesk/600.css';
import './style.css';
import { zipSync } from 'fflate';
import { MODELS, mb, type ModelDef, type ModelFile } from './models';
import { isCached, loadModel, partialBytes } from './cache';
import { detectRuntime, loadSession, upscale, type Runtime } from './engineClient';
import { Aborted, tileCount, type Pixels } from './pixels';
import { Viewer } from './viewer';
import { toast, type Toast } from './toast';

interface Item {
  id: number;
  name: string;
  w: number;
  h: number;
  src: HTMLCanvasElement;
  result?: { canvas: HTMLCanvasElement; scale: number; model: string };
}

const MAX_SIDE = 16384;
const MAX_PIXELS = 130e6;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const items: Item[] = [];
let cur = -1;
let nextId = 1;
let scale: 2 | 4 = 2;
let modelId = 'RealESRGAN_x4plus_anime_6B';
let infoFor: string | null = null;
let busy = false;
let abort: AbortController | null = null;
let rt: Runtime = { gpu: false, f16: false, label: 'detecting…' };
interface Loaded {
  key: string;
  ep: 'webgpu' | 'wasm';
}
let session: Loaded | null = null;
const cachedFlags = new Map<string, boolean>();

const viewer = new Viewer($('viewport'));
const model = () => MODELS.find((m) => m.id === modelId)!;
const variant = (m: ModelDef): { kind: 'fp16' | 'fp32'; file: ModelFile } =>
  rt.gpu && rt.f16 && m.fp16 ? { kind: 'fp16', file: m.fp16 } : { kind: 'fp32', file: m.fp32 };

/* ───────────── model list ───────────── */

function renderModels() {
  const host = $('models');
  host.innerHTML = '';
  for (const m of MODELS) {
    const on = m.id === modelId;
    const v = variant(m);
    const row = document.createElement('div');
    row.className = `model${on ? ' on' : ''}`;
    row.setAttribute('role', 'radio');
    row.setAttribute('aria-checked', String(on));
    row.innerHTML = `
      <input type="radio" name="m" ${on ? 'checked' : ''} aria-label="${m.name}">
      <div style="min-width:0"><div class="mono"></div><div class="label"></div></div>
      <div class="thumb"></div>
      <button type="button" class="info${infoFor === m.id ? ' on' : ''}" aria-label="Model details: ${m.name}" aria-expanded="${infoFor === m.id}">i</button>`;
    (row.querySelector('.mono') as HTMLElement).textContent = m.name;
    const lab = row.querySelector('.label') as HTMLElement;
    lab.textContent = m.blurb;
    if (cachedFlags.get(v.file.url)) {
      const c = document.createElement('span');
      c.className = 'cached';
      c.textContent = ' · cached';
      lab.appendChild(c);
    }
    (row.querySelector('.thumb') as HTMLElement).textContent = m.tag;
    row.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.info')) return;
      modelId = m.id;
      renderModels();
      updateHint();
      if (infoFor) openInfo(m.id);
    });
    (row.querySelector('.info') as HTMLElement).addEventListener('click', (e) => {
      e.stopPropagation();
      infoFor === m.id ? closeInfo() : openInfo(m.id, row);
    });
    host.appendChild(row);
  }
}

async function refreshCached() {
  await Promise.all(
    MODELS.map(async (m) => {
      const v = variant(m);
      cachedFlags.set(v.file.url, await isCached(v.file.url));
    }),
  );
  renderModels();
  if (infoFor) openInfo(infoFor);
}

function openInfo(id: string, anchor?: HTMLElement) {
  infoFor = id;
  const m = MODELS.find((x) => x.id === id)!;
  const v = variant(m);
  const pop = $('pop');
  const row = anchor ?? ($('models').children[MODELS.indexOf(m)] as HTMLElement);
  document.querySelectorAll('.info').forEach((b, i) => {
    b.classList.toggle('on', MODELS[i].id === id);
    b.setAttribute('aria-expanded', String(MODELS[i].id === id));
  });
  pop.hidden = false;
  pop.setAttribute('aria-label', `${m.name} details`);
  const cached = cachedFlags.get(v.file.url);
  pop.innerHTML = `<div class="mono" style="margin-bottom:var(--space-2)"></div><dl></dl>`;
  (pop.firstElementChild as HTMLElement).textContent = m.name;
  const rows: [string, string][] = [
    ['machine name', m.id],
    ['scale', `${m.scale}×${m.scale === 2 ? ' (4× runs it twice)' : ''}`],
    ['download', `${mb(v.file.bytes)} MB (${v.kind})`],
    ['in memory', `~${m.memMB} MB peak (approx.)`],
    ['best for', m.bestFor],
    ['runtime', rt.label],
    ['cached', cached ? 'yes, in this browser' : 'no, downloads on first use'],
    ['weights', m.source],
  ];
  const dl = pop.querySelector('dl')!;
  for (const [k, val] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = val;
    dl.append(dt, dd);
  }
  if (matchMedia('(min-width: 961px)').matches) {
    const pr = $('params').getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    pop.style.left = `${pr.right + 12}px`;
    pop.style.top = `${Math.max(12, Math.min(rr.top - 20, innerHeight - pop.offsetHeight - 12))}px`;
  }
}

function closeInfo() {
  infoFor = null;
  $('pop').hidden = true;
  document.querySelectorAll('.info').forEach((b) => {
    b.classList.remove('on');
    b.setAttribute('aria-expanded', 'false');
  });
}

document.addEventListener('click', (e) => {
  if (infoFor && !(e.target as HTMLElement).closest('#pop, .info')) closeInfo();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeInfo();
});

/* ───────────── scale switch ───────────── */

function setScale(v: 2 | 4) {
  scale = v;
  const sw = $('scale');
  sw.dataset.value = String(v);
  sw.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(Number(b.dataset.v) === v)));
  updateHint();
}
$('scale').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (b) setScale(Number(b.dataset.v) as 2 | 4);
});
$('scale').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    setScale(scale === 2 ? 4 : 2);
    ($('scale').querySelector(`[data-v="${scale}"]`) as HTMLElement).focus();
  }
});
function updateHint() {
  const m = model();
  $('scale-hint').textContent =
    m.scale === 2 && scale === 4 ? 'This model is 2× only: runs twice (2× → 4×).' : m.scale === 4 && scale === 2 ? 'Native 4× model, result is downsampled to 2×.' : '';
}

/* ───────────── images ───────────── */

function drawThumb(c: HTMLCanvasElement, src: HTMLCanvasElement) {
  const s = Math.max(c.width / src.width, c.height / src.height);
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.drawImage(src, (c.width - src.width * s) / 2, (c.height - src.height * s) / 2, src.width * s, src.height * s);
}

async function addFiles(files: FileList | File[]) {
  const list = [...files].filter((f) => f.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(f.name));
  if (!list.length) {
    toast({ kind: 'fail', title: 'No images found', sub: 'Drop PNG, JPEG, WebP, AVIF, GIF or BMP files.', autoClose: 6000 });
    return;
  }
  const bad: string[] = [];
  for (const f of list) {
    try {
      const bmp = await createImageBitmap(f);
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      c.getContext('2d')!.drawImage(bmp, 0, 0);
      bmp.close();
      items.push({ id: nextId++, name: f.name, w: c.width, h: c.height, src: c });
    } catch {
      bad.push(f.name);
    }
  }
  if (bad.length) toast({ kind: 'fail', title: "Couldn't read image", sub: bad.join(', '), autoClose: 8000 });
  if (cur < 0 && items.length) cur = 0;
  else if (list.length && items.length) cur = items.length - Math.max(1, list.length - bad.length);
  renderFiles();
  showCurrent();
}

function renderFiles() {
  const has = items.length > 0;
  $('files').hidden = !has;
  $('drop-text').textContent = has ? 'Add more images' : 'Drag images or click to browse';
  ($('drop') as HTMLElement).style.height = has ? '64px' : '120px';
  ($('run') as HTMLButtonElement).disabled = !has || busy;
  const strip = $('strip');
  strip.innerHTML = '';
  strip.hidden = items.length < 2;
  items.forEach((it, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', String(i === cur));
    b.setAttribute('aria-label', it.name);
    b.title = it.name;
    const c = document.createElement('canvas');
    c.width = c.height = 88;
    drawThumb(c, it.src);
    b.appendChild(c);
    if (it.result) b.insertAdjacentHTML('beforeend', '<span class="ok" aria-hidden="true">✓</span>');
    b.onclick = () => {
      cur = i;
      renderFiles();
      showCurrent();
    };
    strip.appendChild(b);
  });
  const it = items[cur];
  if (it) {
    drawThumb($('cur-thumb') as HTMLCanvasElement, it.src);
    $('cur-name').textContent = it.name;
    $('cur-name').title = it.name;
    $('cur-info').textContent = `${it.w} × ${it.h} · ${((it.w * it.h) / 1e6).toFixed(2)} MP · ${cur + 1} of ${items.length} selected`;
  }
  renderOut();
}

function showCurrent() {
  const it = items[cur];
  viewer.show(it?.src ?? null, it?.result?.canvas ?? null);
  renderOut();
}

function renderOut() {
  const done = items.filter((i) => i.result);
  const bar = $('outbar');
  bar.hidden = !done.length;
  if (!done.length) return;
  const it = items[cur];
  const sc = done[done.length - 1].result!.scale;
  $('out-title').textContent = `${done.length} ${done.length === 1 ? 'image' : 'images'} upscaled ${sc}×`;
  const r = it?.result;
  $('out-sub').textContent = r ? `${outName(it, r.scale)} · ${r.canvas.width} × ${r.canvas.height} · PNG` : 'Not upscaled yet';
  ($('dl-one') as HTMLButtonElement).disabled = !r;
  ($('dl-one') as HTMLButtonElement).style.opacity = r ? '' : '.4';
  const all = $('dl-all');
  all.hidden = done.length < 2;
  all.textContent = `Download all (${done.length}, .zip)`;
}

const outName = (it: Item, sc: number) => `${it.name.replace(/\.[^.]+$/, '')}_x${sc}.png`;
const toBlob = (c: HTMLCanvasElement) => new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('PNG encode failed'))), 'image/png'));

function save(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

$('dl-one').addEventListener('click', async () => {
  const it = items[cur];
  if (it?.result) save(await toBlob(it.result.canvas), outName(it, it.result.scale));
});
$('dl-all').addEventListener('click', async () => {
  const t = toast({ kind: 'busy', title: 'Zipping', sub: 'Encoding PNGs…' });
  try {
    const files: Record<string, Uint8Array> = {};
    const used = new Set<string>();
    for (const it of items) {
      if (!it.result) continue;
      let n = outName(it, it.result.scale);
      for (let k = 2; used.has(n); k++) n = n.replace(/(\.png)$/, `_${k}$1`);
      used.add(n);
      files[n] = new Uint8Array(await (await toBlob(it.result.canvas)).arrayBuffer());
    }
    save(new Blob([zipSync(files, { level: 0 }) as BlobPart], { type: 'application/zip' }), 'upscaled.zip');
  } catch (e) {
    toast({ kind: 'fail', title: 'Zip failed', sub: String((e as Error).message ?? e) });
  } finally {
    t.close();
  }
});

$('clear').addEventListener('click', () => {
  if (busy) return;
  items.length = 0;
  cur = -1;
  renderFiles();
  showCurrent();
});

const fileInput = $('file') as HTMLInputElement;
$('drop').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files?.length) addFiles(fileInput.files);
  fileInput.value = '';
});
let dragDepth = 0;
addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  $('drop').classList.add('over');
});
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $('drop').classList.remove('over');
  }
});
addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop').classList.remove('over');
  if (e.dataTransfer?.files.length) addFiles(e.dataTransfer.files);
});
addEventListener('paste', (e) => {
  const fs = [...(e.clipboardData?.files ?? [])];
  if (fs.length) addFiles(fs);
});

/* ───────────── upscaling ───────────── */

function hasAlpha(d: Uint8ClampedArray) {
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) return true;
  return false;
}

/** Scale the alpha channel with the browser's resampler and merge it back. */
function applyAlpha(src: Pixels, out: Pixels) {
  const a = document.createElement('canvas');
  a.width = src.w;
  a.height = src.h;
  const id = new ImageData(src.w, src.h);
  for (let i = 0; i < src.w * src.h; i++) {
    const v = src.data[i * 4 + 3];
    id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v;
    id.data[i * 4 + 3] = 255;
  }
  a.getContext('2d')!.putImageData(id, 0, 0);
  const b = document.createElement('canvas');
  b.width = out.w;
  b.height = out.h;
  const bx = b.getContext('2d')!;
  bx.imageSmoothingQuality = 'high';
  bx.drawImage(a, 0, 0, out.w, out.h);
  const ad = bx.getImageData(0, 0, out.w, out.h).data;
  for (let i = 0; i < out.w * out.h; i++) out.data[i * 4 + 3] = ad[i * 4];
}

async function getSession(m: ModelDef, kind: 'fp16' | 'fp32', file: ModelFile, t: Toast, signal: AbortSignal): Promise<Loaded> {
  const key = `${m.id}:${kind}`;
  if (session?.key === key) return session;
  session = null;
  const resumed = partialBytes(file.url);
  const cachedBefore = await isCached(file.url);
  if (!cachedBefore) {
    t.update({ title: 'Downloading model', sub: `${m.name} · ${mb(resumed)} / ${mb(file.bytes)} MB`, pct: resumed / file.bytes });
  } else {
    t.update({ title: 'Loading model', sub: `${m.name} · from browser cache` });
  }
  const { buf, fromCache } = await loadModel(
    file.url,
    file.bytes,
    (l, tot) => t.update({ sub: `${m.name} · ${mb(l)} / ${mb(tot)} MB`, pct: l / tot }),
    signal,
  );
  if (!fromCache) {
    cachedFlags.set(file.url, true);
    renderModels();
  }
  t.update({ title: 'Preparing model', sub: `${m.name} · ${rt.gpu ? 'compiling for WebGPU' : 'initialising WASM'}` });
  const ep = await loadSession(buf, rt.gpu);
  return (session = { key, ep });
}

async function upscaleOne(it: Item, m: ModelDef, tile: number, onPass: (p: number, passes: number, done: number, total: number) => void, signal: AbortSignal) {
  const passes = scale > m.scale ? Math.round(Math.log(scale / m.scale) / Math.log(m.scale)) + 1 : 1;
  const total = tileCount(it.w, it.h, passes, tile, m.scale);
  const id = it.src.getContext('2d')!.getImageData(0, 0, it.w, it.h);
  const original: Pixels = { data: id.data, w: it.w, h: it.h };
  const px = await upscale(original, { nativeScale: m.scale, passes, downscale: m.scale > scale, tile }, (p, d) => onPass(p, passes, d, total), signal);
  if (hasAlpha(original.data)) applyAlpha(original, px);
  const c = document.createElement('canvas');
  c.width = px.w;
  c.height = px.h;
  c.getContext('2d')!.putImageData(new ImageData(px.data as Uint8ClampedArray<ArrayBuffer>, px.w, px.h), 0, 0);
  return c;
}

async function run() {
  if (busy || !items.length) return;
  const m = model();
  const targets = items.slice();
  // Validate sizes up front so we fail before downloading anything.
  const finalMul = Math.max(scale, m.scale);
  const big = targets.filter((it) => it.w * finalMul > MAX_SIDE || it.h * finalMul > MAX_SIDE || it.w * it.h * finalMul * finalMul > MAX_PIXELS);
  if (big.length) {
    toast({
      kind: 'fail',
      title: 'Image too large',
      sub: `${big.map((b) => b.name).join(', ')} would exceed ${MAX_SIDE}px or ${MAX_PIXELS / 1e6} MP at ${finalMul}×. Try 2× or a smaller image.`,
    });
    return;
  }

  busy = true;
  abort = new AbortController();
  const signal = abort.signal;
  const btn = $('run') as HTMLButtonElement;
  btn.disabled = true;
  btn.classList.add('busy');
  btn.textContent = 'Upscaling…';
  rt = await detectRuntime();
  let v = variant(m);
  const t = toast({
    kind: 'busy',
    title: 'Loading model',
    sub: m.name,
    pct: 0,
    actions: [{ label: 'Cancel', run: () => abort?.abort() }],
  });
  try {
    let s: Loaded;
    try {
      s = await getSession(m, v.kind, v.file, t, signal);
    } catch (e) {
      if (signal.aborted || v.kind === 'fp32') throw e;
      v = { kind: 'fp32', file: m.fp32 };
      s = await getSession(m, v.kind, v.file, t, signal);
    }
    const tile = s.ep === 'webgpu' ? m.tile.gpu : m.tile.wasm;
    let ok = 0;
    for (let i = 0; i < targets.length; i++) {
      const it = targets[i];
      t.update({ title: 'Upscaling', sub: `${i + 1} of ${targets.length} images · starting…`, pct: 0 });
      const c = await upscaleOne(
        it,
        m,
        tile,
        (p, passes, d, tot) => {
          t.update({ sub: `${i + 1} of ${targets.length} images · ${d} of ${tot} tiles · ${p} of ${passes} passes`, pct: d / tot });
        },
        signal,
      );
      it.result = { canvas: c, scale, model: m.name };
      ok++;
      if (items[cur] === it || ok === 1) {
        cur = items.indexOf(it);
      }
      renderFiles();
      showCurrent();
    }
    t.close();
    toast({ kind: 'done', title: 'Done', sub: `${ok} ${ok === 1 ? 'image' : 'images'} upscaled ${scale}×`, autoClose: 7000 });
  } catch (e) {
    t.close();
    if (e instanceof Aborted || (e as Error).name === 'AbortError' || signal.aborted) {
      toast({ kind: 'fail', title: 'Cancelled', sub: 'Partial results are kept. Downloaded model bytes are kept for a retry.', autoClose: 5000 });
    } else {
      console.error(e);
      const part = partialBytes(v.file.url);
      toast({
        kind: 'fail',
        title: 'Upscale failed',
        sub: part ? `Model download stopped at ${mb(part)} / ${mb(v.file.bytes)} MB. Retry resumes from the received bytes.` : String((e as Error).message ?? e),
        actions: [{ label: 'Retry', run: () => run() }],
      });
    }
  } finally {
    busy = false;
    abort = null;
    btn.classList.remove('busy');
    btn.textContent = 'Upscale';
    btn.disabled = !items.length;
  }
}

$('run').addEventListener('click', run);

/* ───────────── init ───────────── */

renderModels();
setScale(2);
renderFiles();
showCurrent();
detectRuntime().then((r) => {
  rt = r;
  $('runtime').textContent = `${r.gpu ? 'WebGPU' : 'WASM'}${r.gpu && r.f16 ? ' · fp16' : ''}${crossOriginIsolated ? ' · threaded' : ''}`;
  refreshCached();
});
