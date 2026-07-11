/**
 * Segmentation MediaPipe → silhouette dorsale live + couverture lissée (sans grille).
 */
import { LM } from './pose.js';
import { backHalfWidth, nearBackShape, toBack, coverageHeatRGBA } from './coverage.js';

const MASK_THRESH = 0.28;
const BLEND = 0.38;

function inTorsoClip(x, y, P) {
  const ls = P[LM.L_SHOULDER], rs = P[LM.R_SHOULDER];
  const lh = P[LM.L_HIP], rh = P[LM.R_HIP];
  const top = Math.min(ls.y, rs.y) - Math.hypot(rs.x - ls.x, rs.y - ls.y) * 0.15;
  const bot = Math.max(lh.y, rh.y) + Math.hypot(rh.x - lh.x, rh.y - lh.y) * 0.12;
  if (y < top || y > bot) return false;

  const mx = (ls.x + rs.x + lh.x + rh.x) / 4;
  const my = (ls.y + rs.y + lh.y + rh.y) / 4;
  const shoulderW = Math.hypot(rs.x - ls.x, rs.y - ls.y);
  const halfW = shoulderW * 0.78;
  const dx = x - mx;
  const dy = y - my;
  const ex = { x: rs.x - ls.x, y: rs.y - ls.y };
  const ey = {
    x: (lh.x + rh.x) / 2 - (ls.x + rs.x) / 2,
    y: (lh.y + rh.y) / 2 - (ls.y + rs.y) / 2,
  };
  const el = Math.hypot(ex.x, ex.y) || 1;
  const ew = Math.hypot(ey.x, ey.y) || 1;
  ex.x /= el; ex.y /= el;
  ey.x /= ew; ey.y /= ew;
  const lx = dx * ex.x + dy * ex.y;
  const ly = dx * ey.x + dy * ey.y;
  return Math.abs(lx) <= halfW && ly >= -shoulderW * 0.2 && ly <= shoulderW * 1.1;
}

/** Silhouette de repli depuis les landmarks si le masque MediaPipe est faible. */
export function buildFallbackSilhouette(P, W, H, prev = null) {
  if (!P) return prev;
  const ls = P[LM.L_SHOULDER], rs = P[LM.R_SHOULDER];
  const lh = P[LM.L_HIP], rh = P[LM.R_HIP];
  if ([ls, rs, lh, rh].some((p) => p.visibility < 0.35)) return prev;

  const n = W * H;
  const out = prev && prev.length === n ? prev : new Uint8ClampedArray(n);
  const top = Math.min(ls.y, rs.y);
  const bot = Math.max(lh.y, rh.y);
  const torsoH = Math.max(1, bot - top);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const v = (y - top) / torsoH;
      let a = 0;
      if (v >= -0.05 && v <= 1.05) {
        const cx = (ls.x + rs.x) / 2 + ((lh.x + rh.x) / 2 - (ls.x + rs.x) / 2) * Math.max(0, v);
        const hw = backHalfWidth(Math.max(0, Math.min(1, v))) * Math.hypot(rs.x - ls.x, rs.y - ls.y) * 1.05;
        if (Math.abs(x - cx) <= hw) a = 255;
      }
      if (prev) a = Math.round(prev[i] * (1 - BLEND) + a * BLEND);
      out[i] = a;
    }
  }
  return out;
}

/**
 * Masque dorsal lissé (W×H), valeurs 0–255.
 */
export function buildBackSilhouette(mask, P, W, H, prev = null) {
  if (!P) return prev;

  let raw = null;
  if (mask) {
    try {
      raw = mask.getAsFloat32Array();
    } catch {
      raw = null;
    }
  }

  const n = W * H;
  const out = prev && prev.length === n ? prev : new Uint8ClampedArray(n);
  let hits = 0;

  if (raw) {
    const mw = mask.width;
    const mh = mask.height;
    for (let y = 0; y < H; y++) {
      const sy = Math.min(mh - 1, Math.round((y / H) * mh));
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const sx = Math.min(mw - 1, Math.round((x / W) * mw));
        let v = raw[sy * mw + sx] > MASK_THRESH && inTorsoClip(x, y, P) ? 255 : 0;
        if (v) hits++;
        if (prev) v = Math.round(prev[i] * (1 - BLEND) + v * BLEND);
        out[i] = v;
      }
    }
  }

  if (!raw || hits < n * 0.002) {
    return buildFallbackSilhouette(P, W, H, out);
  }
  return out;
}

/** Masque IA (Uint8ClampedArray W×H) → silhouette dorsale lissée. */
export function buildBackSilhouetteFromBytes(bytes, P, W, H, prev = null) {
  if (!P || !bytes || bytes.length !== W * H) return prev;

  const n = W * H;
  const out = prev && prev.length === n ? prev : new Uint8ClampedArray(n);
  let hits = 0;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let v = bytes[i] > 128 && inTorsoClip(x, y, P) ? 255 : 0;
      if (v) hits++;
      if (prev) v = Math.round(prev[i] * (1 - BLEND) + v * BLEND);
      out[i] = v;
    }
  }

  if (hits < n * 0.002) {
    return buildFallbackSilhouette(P, W, H, out);
  }
  return out;
}

function isEdge(alpha, W, H, x, y, t = 80) {
  const i = y * W + x;
  if (alpha[i] < t) return false;
  if (x === 0 || y === 0 || x === W - 1 || y === H - 1) return true;
  return (
    alpha[i - 1] < t || alpha[i + 1] < t ||
    alpha[i - W] < t || alpha[i + W] < t
  );
}

export function traceBackContour(alpha, W, H) {
  if (!alpha) return null;
  const edges = [];
  const step = Math.max(2, Math.round(Math.min(W, H) / 200));
  for (let y = 0; y < H; y += step) {
    for (let x = 0; x < W; x += step) {
      if (isEdge(alpha, W, H, x, y)) edges.push({ x, y });
    }
  }
  if (edges.length < 6) return null;

  let cx = 0, cy = 0;
  for (const p of edges) { cx += p.x; cy += p.y; }
  cx /= edges.length;
  cy /= edges.length;
  edges.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));

  const maxPts = 80;
  if (edges.length > maxPts) {
    const slim = [];
    const stride = edges.length / maxPts;
    for (let i = 0; i < maxPts; i++) slim.push(edges[Math.floor(i * stride)]);
    return slim;
  }
  return edges;
}

export function pathFromContour(contour) {
  if (!contour?.length) return null;
  const path = new Path2D();
  path.moveTo(contour[0].x, contour[0].y);
  for (let i = 1; i < contour.length; i++) path.lineTo(contour[i].x, contour[i].y);
  path.closePath();
  return path;
}

/**
 * Peint la couverture pixel par pixel sur la silhouette (pas de grille 36×48 upscalée).
 */
function paintCoverageOnSilhouette(ctx, alpha, W, H, grid, frame) {
  if (!grid || !frame) return;
  const img = ctx.createImageData(W, H);
  const d = img.data;
  const step = 3;

  for (let y = 0; y < H; y += step) {
    for (let x = 0; x < W; x += step) {
      const i = y * W + x;
      if (alpha[i] < 70) continue;
      const { u, v } = toBack({ x, y }, frame);
      if (!nearBackShape(u, v, 0.08)) continue;
      const f = grid.sample(u, v);
      const [r, g, b, a] = coverageHeatRGBA(f);
      for (let dy = 0; dy < step && y + dy < H; dy++) {
        for (let dx = 0; dx < step && x + dx < W; dx++) {
          const j = (y + dy) * W + (x + dx);
          if (alpha[j] < 50) continue;
          const o = j * 4;
          d[o] = r;
          d[o + 1] = g;
          d[o + 2] = b;
          d[o + 3] = a;
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * Overlay : contour vert + couverture lissée clipée au dos segmenté.
 */
export function drawBackSegmentationOverlay(ctx, alpha, W, H, { contour, grid, frame, showCoverage } = {}) {
  if (!alpha) return;

  const path = contour ? pathFromContour(contour) : null;

  if (showCoverage && grid && frame) {
    paintCoverageOnSilhouette(ctx, alpha, W, H, grid, frame);
  } else if (path) {
    const fillImg = ctx.createImageData(W, H);
    const d = fillImg.data;
    for (let i = 0; i < W * H; i++) {
      if (alpha[i] < 70) continue;
      const o = i * 4;
      d[o] = 255;
      d[o + 1] = 120;
      d[o + 2] = 35;
      d[o + 3] = 50;
    }
    ctx.save();
    ctx.clip(path);
    ctx.putImageData(fillImg, 0, 0);
    ctx.restore();
  }

  if (path && !showCoverage) {
    ctx.save();
    ctx.strokeStyle = 'rgba(0, 255, 130, 0.55)';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke(path);
    ctx.restore();
  }
}
