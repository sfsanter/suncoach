/**
 * Verrouillage du contour dos depuis masque IA (moyenne sur plusieurs frames).
 */
import { toBack } from './coverage.js';
import { TRACE_BINS } from './contourTrace.js';

export const LOCK_FRAMES = 20;

export class MaskLockAccumulator {
  constructor(W, H) {
    this.W = W;
    this.H = H;
    this.sum = new Float32Array(W * H);
    this.count = 0;
  }

  push(mask) {
    if (!mask || mask.length !== this.W * this.H) return;
    for (let i = 0; i < mask.length; i++) {
      this.sum[i] += mask[i] / 255;
    }
    this.count++;
  }

  getAveraged(threshold = 0.42) {
    if (!this.count) return null;
    const out = new Uint8ClampedArray(this.W * this.H);
    for (let i = 0; i < this.sum.length; i++) {
      out[i] = this.sum[i] / this.count >= threshold ? 255 : 0;
    }
    return out;
  }

  /** Contour UV lissé depuis le masque IA + repère torse figé. */
  extractContour(frame, mask, bins = TRACE_BINS) {
    if (!frame || !mask) return null;

    const left = new Float32Array(bins);
    const right = new Float32Array(bins);
    const valid = new Uint8Array(bins);
    const counts = new Uint16Array(bins);

    for (let row = 0; row < this.H; row++) {
      for (let x = 0; x < this.W; x++) {
        if (mask[row * this.W + x] < 128) continue;
        const uv = toBack({ x, y: row, visibility: 1 }, frame);
        const bi = Math.max(0, Math.min(bins - 1, Math.floor(uv.v * bins)));
        counts[bi]++;
        if (!valid[bi] || uv.u < left[bi]) left[bi] = uv.u;
        if (!valid[bi] || uv.u > right[bi]) right[bi] = uv.u;
        valid[bi] = 1;
      }
    }

    for (let i = 0; i < bins; i++) {
      if (!valid[i] || counts[i] < 3) {
        valid[i] = 0;
        left[i] = 0.5;
        right[i] = 0.5;
      }
    }

    for (let pass = 0; pass < 2; pass++) {
      for (let i = 1; i < bins - 1; i++) {
        if (!valid[i]) {
          if (valid[i - 1] && valid[i + 1]) {
            left[i] = (left[i - 1] + left[i + 1]) / 2;
            right[i] = (right[i - 1] + right[i + 1]) / 2;
            valid[i] = 1;
          }
        } else {
          if (valid[i - 1]) {
            left[i] = left[i] * 0.6 + left[i - 1] * 0.4;
            right[i] = right[i] * 0.6 + right[i - 1] * 0.4;
          }
          if (valid[i + 1]) {
            left[i] = left[i] * 0.6 + left[i + 1] * 0.4;
            right[i] = right[i] * 0.6 + right[i + 1] * 0.4;
          }
        }
      }
    }

    let vTop = 0;
    let vBot = 1;
    for (let i = 0; i < bins; i++) {
      if (valid[i]) { vTop = (i + 0.5) / bins; break; }
    }
    for (let i = bins - 1; i >= 0; i--) {
      if (valid[i]) { vBot = (i + 0.5) / bins; break; }
    }

    const outline = [];
    for (let i = 0; i < bins; i++) {
      if (valid[i]) outline.push({ u: left[i], v: (i + 0.5) / bins });
    }
    for (let i = bins - 1; i >= 0; i--) {
      if (valid[i]) outline.push({ u: right[i], v: (i + 0.5) / bins });
    }

    if (outline.length < 6) return null;

    return { left, right, valid, vTop, vBot, outline, bins };
  }
}
