# Client-side ESRGAN upscaler

Runs entirely in the browser: pick one or many images, choose **2×** or **4×** and a model, press **Upscale**.
Inference runs in a Web Worker (the page stays responsive) using [ONNX Runtime Web](https://onnxruntime.ai/) on **WebGPU** (fp16 weights when the GPU supports
`shader-f16`) with an automatic **WASM** fallback. Nothing is uploaded.

- Models download on first use from Hugging Face and are stored in the browser Cache Storage
  (`upscaler-models-v1`); later runs load from the cache. A failed download resumes from the bytes already received.
- Images are processed in overlapping tiles so large inputs fit in memory.
- 4× on a 2×-only model (Real-CUGAN 2x) runs the network twice; 2× on a 4× model downsamples the 4× result with an exact 2:1 box filter.
- Compare view: drag the handle, wheel/pinch to zoom (up to 4800%), drag to pan, double-click to fit. Pixels are shown crisp when zoomed in.
- Download single PNGs or everything as a `.zip`.

## Develop

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # outputs dist/
```

The dev/preview servers send COOP/COEP headers so WASM can use threads. If you host `dist/` yourself, send the same
headers (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`) for multi-threaded WASM;
without them everything still works, single-threaded.

## Deploy to GitHub Pages

`.github/workflows/deploy.yml` builds and publishes `dist/` on every push to `main`. One-time setup:

1. Create the repo and push (`gh repo create client-upscaler --public --source . --push`).
2. In the repo go to **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. The site appears at `https://<user>.github.io/client-upscaler/` after the workflow finishes.

Pages can't send COOP/COEP headers, so `public/coi-sw.js` (a tiny service worker) adds them. The first visit
reloads once to activate it; after that WASM runs multi-threaded. Asset paths are relative, so any sub-path works.

## Models

Edit `src/models.ts`. Weights are pinned to specific Hugging Face commits:
`skillsafe-ai/*` (Real-ESRGAN exports, BSD-3-Clause) and `nesaorg/2xHFA2kReal-CUGAN_fp32_opset17`
(the 2xHFA2k Real-CUGAN-architecture model by Phips, standing in for "Real-CUGAN 2x").
Any ONNX model with a dynamic `[1,3,H,W]` float32 RGB 0–1 input works.
