export interface ModelFile {
  url: string;
  bytes: number;
}

export interface ModelDef {
  id: string;
  name: string;
  blurb: string;
  tag: string;
  /** Native scale factor of the network. */
  scale: 2 | 4;
  bestFor: string;
  source: string;
  /** Preferred (smaller) half-precision weights, fp32 IO. Optional. */
  fp16?: ModelFile;
  fp32: ModelFile;
  /** Input tile edge (before padding) per backend. */
  tile: { gpu: number; wasm: number };
  /** Rough peak activation memory for one tile on the GPU backend, MB. */
  memMB: number;
}

const HF = 'https://huggingface.co';
const skillsafe = (repo: string, rev: string, file: string) =>
  `${HF}/skillsafe-ai/${repo}/resolve/${rev}/${file}`;

// All weights are ONNX exports with dynamic H/W, NCHW, RGB, 0..1 float32 I/O.
export const MODELS: ModelDef[] = [
  {
    id: 'animevideov3',
    name: 'animevideov3',
    blurb: 'Fast and optimized for illustrations and anime',
    tag: 'anime',
    scale: 4,
    bestFor: 'illustration, speed',
    source: 'Real-ESRGAN realesr-animevideov3',
    fp16: { url: skillsafe('realesr-animevideov3', '185e9142d439d17e3fb99395600fb7d08af09de5', 'model_fp16.onnx'), bytes: 1253495 },
    fp32: { url: skillsafe('realesr-animevideov3', '185e9142d439d17e3fb99395600fb7d08af09de5', 'model.onnx'), bytes: 2492908 },
    tile: { gpu: 256, wasm: 128 },
    memMB: 250,
  },
  {
    id: 'realesr-general-x4v3',
    name: 'realesr-general-x4v3',
    blurb: 'Fast, general purpose for photos',
    tag: 'photo',
    scale: 4,
    bestFor: 'photos, speed',
    source: 'Real-ESRGAN realesr-general-x4v3',
    fp16: { url: skillsafe('realesr-general-x4v3', '042a40bc4c918349ad3e2e607a68ae509a4c27b5', 'model_fp16.onnx'), bytes: 2445496 },
    fp32: { url: skillsafe('realesr-general-x4v3', '042a40bc4c918349ad3e2e607a68ae509a4c27b5', 'model.onnx'), bytes: 4866428 },
    tile: { gpu: 256, wasm: 128 },
    memMB: 250,
  },
  {
    id: 'RealESRGAN_x4plus_anime_6B',
    name: 'RealESRGAN_x4plus_anime_6B',
    blurb: 'Quality pass for illustrations and anime',
    tag: 'line art',
    scale: 4,
    bestFor: 'illustration, quality',
    source: 'Real-ESRGAN RealESRGAN_x4plus_anime_6B',
    fp16: { url: skillsafe('realesrgan-x4plus-anime-6b', 'c001be50fae1c7a2bae8b2b4dec5e6fcbdbcca96', 'model_fp16.onnx'), bytes: 9031567 },
    fp32: { url: skillsafe('realesrgan-x4plus-anime-6b', 'c001be50fae1c7a2bae8b2b4dec5e6fcbdbcca96', 'model.onnx'), bytes: 17939975 },
    tile: { gpu: 128, wasm: 64 },
    memMB: 400,
  },
  {
    id: 'RealESRGAN_x4plus',
    name: 'RealESRGAN_x4plus',
    blurb: 'Quality pass for photos, slower',
    tag: 'photo',
    scale: 4,
    bestFor: 'photos, quality',
    source: 'Real-ESRGAN RealESRGAN_x4plus',
    fp16: { url: skillsafe('realesrgan-x4plus', '107475e49b7d46412cc966481efccc3500955801', 'model_fp16.onnx'), bytes: 33754617 },
    fp32: { url: skillsafe('realesrgan-x4plus', '107475e49b7d46412cc966481efccc3500955801', 'model.onnx'), bytes: 67051650 },
    tile: { gpu: 128, wasm: 64 },
    memMB: 700,
  },
  {
    id: 'Real-CUGAN-2x',
    name: 'Real-CUGAN 2x',
    blurb: 'Anime only, 2× only',
    tag: 'anime 2×',
    scale: 2,
    bestFor: 'anime, clean 2×',
    source: '2xHFA2kReal-CUGAN (Phips), fp32',
    fp32: { url: `${HF}/nesaorg/2xHFA2kReal-CUGAN_fp32_opset17/resolve/9a4515382d29a4700637f76f0c97dfbfacb287b4/2xHFA2kReal-CUGAN_fp32_opset17.onnx`, bytes: 5163975 },
    tile: { gpu: 256, wasm: 128 },
    memMB: 300,
  },
];

export const mb = (b: number) => (b / 1048576).toFixed(b < 10485760 ? 1 : 0);
