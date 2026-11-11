import { defineConfig } from 'vite';

// Cross-origin isolation lets ONNX Runtime's WASM backend use SharedArrayBuffer
// threads. Without these headers everything still works, just single-threaded.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  base: './',
  server: { headers: isolation },
  preview: { headers: isolation },
  resolve: { conditions: ['onnxruntime-web-use-extern-wasm'] },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  build: { target: 'es2022' },
});
