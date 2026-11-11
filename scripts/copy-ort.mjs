// Copies the ONNX Runtime WASM binaries into public/ort so they are served
// same-origin (and cached) instead of fetched from a CDN.
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
const src = 'node_modules/onnxruntime-web/dist';
mkdirSync('public/ort', { recursive: true });
for (const f of readdirSync(src)) {
  if (/^ort-wasm-simd-threaded(\.jsep)?\.(mjs|wasm)$/.test(f)) cpSync(`${src}/${f}`, `public/ort/${f}`);
}
