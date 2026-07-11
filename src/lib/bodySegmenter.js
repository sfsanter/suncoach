/**
 * MediaPipe Image Segmenter (selfie_multiclass) — segmentation IA dédiée,
 * plus récente que le masque Holistic. Gratuit, local, même package npm.
 */
import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision';

const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite';

/** 0=bg 1=hair 2=body-skin 3=face-skin 4=clothes 5=accessories */
const PERSON_CATS = new Set([1, 2, 3, 4, 5]);

let segmenterPromise = null;

export function preloadBodySegmenter() {
  if (!segmenterPromise) {
    segmenterPromise = createSegmenter().catch((e) => {
      segmenterPromise = null;
      throw e;
    });
  }
  return segmenterPromise;
}

async function createSegmenter() {
  const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: 'VIDEO',
    outputCategoryMask: true,
    outputConfidenceMasks: false,
  });
  try {
    return await ImageSegmenter.createFromOptions(fileset, opts('GPU'));
  } catch {
    return await ImageSegmenter.createFromOptions(fileset, opts('CPU'));
  }
}

export class BodySegmenter {
  constructor() {
    this.segmenter = null;
  }

  async init() {
    if (!this.segmenter) this.segmenter = await preloadBodySegmenter();
  }

  /**
   * Masque personne 0–255 (W×H), depuis catégories peau + vêtements + cheveux.
   */
  segmentPersonMask(video, ts, W, H) {
    if (!this.segmenter) return null;
    let result;
    try {
      result = this.segmenter.segmentForVideo(video, ts);
    } catch {
      return null;
    }
    const cat = result.categoryMask;
    if (!cat) {
      result.close?.();
      return null;
    }
    let data;
    try {
      data = cat.getAsUint8Array();
    } catch {
      cat.close?.();
      result.close?.();
      return null;
    }
    const mw = cat.width;
    const mh = cat.height;
    const n = W * H;
    const out = new Uint8ClampedArray(n);
    for (let y = 0; y < H; y++) {
      const sy = Math.min(mh - 1, Math.round((y / H) * mh));
      for (let x = 0; x < W; x++) {
        const sx = Math.min(mw - 1, Math.round((x / W) * mw));
        const c = data[sy * mw + sx];
        out[y * W + x] = PERSON_CATS.has(c) ? 255 : 0;
      }
    }
    cat.close?.();
    result.close?.();
    return out;
  }
}
