/**
 * Calibrage par tour du dos : l'utilisateur frotte le contour plusieurs fois,
 * on accumule les extrêmes (min/max u par hauteur v) et on lisse → silhouette.
 */
import { LM, contactPointsFromHand, palmFromHand } from './pose.js';
import { toBack } from './coverage.js';

export const TRACE_BINS = 32;
const MIN_SAMPLES_READY = 70;
const MIN_COVERAGE = 0.68;

export class ContourTracer {
  constructor() {
    this.reset();
  }

  reset() {
    this.bins = Array.from({ length: TRACE_BINS }, (_, i) => ({
      v: (i + 0.5) / TRACE_BINS,
      minU: 1,
      maxU: 0,
      n: 0,
    }));
    this.totalSamples = 0;
    this.startedAt = performance.now();
  }

  addSample(u, v) {
    if (u < -0.05 || u > 1.05 || v < -0.08 || v > 1.08) return false;
    const idx = Math.max(0, Math.min(TRACE_BINS - 1, Math.floor(v * TRACE_BINS)));
    const b = this.bins[idx];
    b.minU = Math.min(b.minU, u);
    b.maxU = Math.max(b.maxU, u);
    b.n++;
    this.totalSamples++;
    return true;
  }

  /** Part du contour vertical déjà échantillonné (0–1). */
  get coverage() {
    let ok = 0;
    for (const b of this.bins) {
      if (b.n >= 3 && b.maxU - b.minU >= 0.06) ok++;
    }
    return ok / TRACE_BINS;
  }

  get sampleCount() {
    return this.totalSamples;
  }

  get elapsedSec() {
    return (performance.now() - this.startedAt) / 1000;
  }

  isReady() {
    return this.totalSamples >= MIN_SAMPLES_READY && this.coverage >= MIN_COVERAGE;
  }

  /** Zone manquante pour guider la voix. */
  biggestGap() {
    let best = null;
    for (const b of this.bins) {
      const need = b.n < 2 ? 1 : (b.maxU - b.minU < 0.06 ? 0.5 : 0);
      if (need > 0 && (!best || need > best.need || b.n < best.n)) {
        best = { v: b.v, n: b.n, need };
      }
    }
    if (!best) return null;
    if (best.v < 0.2) return { zone: 'haut', v: best.v };
    if (best.v > 0.75) return { zone: 'bas', v: best.v };
    if (best.v < 0.55) return { zone: 'milieu', v: best.v };
    return { zone: 'reins', v: best.v };
  }

  /** Lisse les bords (moyenne glissante) et comble les trous. */
  getSmoothedContour() {
    const left = new Float32Array(TRACE_BINS);
    const right = new Float32Array(TRACE_BINS);
    const valid = new Uint8Array(TRACE_BINS);

    for (let i = 0; i < TRACE_BINS; i++) {
      const b = this.bins[i];
      if (b.n >= 2 && b.maxU >= b.minU) {
        left[i] = b.minU;
        right[i] = b.maxU;
        valid[i] = 1;
      } else {
        left[i] = 0.5;
        right[i] = 0.5;
      }
    }

    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < TRACE_BINS; i++) {
        if (valid[i]) continue;
        let l = null, r = null, d = 1;
        while (d < TRACE_BINS && (l === null || r === null)) {
          if (i - d >= 0 && valid[i - d]) l = i - d;
          if (i + d < TRACE_BINS && valid[i + d]) r = i + d;
          d++;
        }
        if (l !== null && r !== null) {
          const t = (i - l) / (r - l || 1);
          left[i] = left[l] + t * (left[r] - left[l]);
          right[i] = right[l] + t * (right[r] - right[l]);
          valid[i] = 1;
        }
      }
    }

    for (let i = 1; i < TRACE_BINS - 1; i++) {
      if (!valid[i]) continue;
      left[i] = (left[i - 1] + left[i] + left[i + 1]) / 3;
      right[i] = (right[i - 1] + right[i] + right[i + 1]) / 3;
    }

    let vTop = 0;
    let vBot = 1;
    for (let i = 0; i < TRACE_BINS; i++) {
      if (this.bins[i].n >= 2) {
        vTop = this.bins[i].v;
        break;
      }
    }
    for (let i = TRACE_BINS - 1; i >= 0; i--) {
      if (this.bins[i].n >= 2) {
        vBot = this.bins[i].v;
        break;
      }
    }

    const outline = [];
    for (let i = 0; i < TRACE_BINS; i++) {
      if (valid[i]) outline.push({ u: left[i], v: this.bins[i].v });
    }
    for (let i = TRACE_BINS - 1; i >= 0; i--) {
      if (valid[i]) outline.push({ u: right[i], v: this.bins[i].v });
    }

    return { left, right, valid, vTop, vBot, outline, bins: this.bins };
  }
}

/** Collecte contacts mains/poignets pour le traçage. */
export function collectTraceContacts(track, P, frame, W, H) {
  const out = [];
  const add = (pt) => {
    if (!pt) return;
    const uv = toBack(pt, frame);
    out.push(uv);
  };

  for (const idx of [LM.L_WRIST, LM.R_WRIST]) {
    const w = P?.[idx];
    if (w && (w.visibility ?? 0) >= 0.3) add(w);
  }

  for (const hand of [track.leftHand2D, track.rightHand2D]) {
    if (!hand?.length) continue;
    const px = hand.map((p) => ({
      x: p.x * W,
      y: p.y * H,
      visibility: p.visibility ?? p.presence ?? 0,
    }));
    for (const p of contactPointsFromHand(px)) add(p);
    const palm = palmFromHand(px);
    if (palm) add(palm);
  }
  return out;
}

export function traceGapVoice(gap) {
  if (!gap) return '';
  const m = {
    haut: 'Passe encore sur le haut du dos, nuque et épaules.',
    milieu: 'Frotte le milieu du dos, côtés inclus.',
    reins: 'Passe sur les reins, gauche et droite.',
    bas: 'Termine par le bas du dos.',
  };
  return m[gap.zone] ?? 'Continue de faire le tour du dos.';
}
