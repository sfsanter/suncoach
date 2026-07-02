/**
 * Segmentation MediaPipe → silhouette dorsale live + contour.
 */
import { LM } from './pose.js';

const MASK_THRESH = 0.38;
const BLEND = 0.42;

function inTorsoClip(x, y, P) {
  const ls = P[LM.L_SHOULDER], rs = P[LM.R_SHOULDER];
  const lh = P[LM.L_HIP], rh = P[LM.R_HIP];
  const top = Math.min(ls.y, rs.y) - Math.hypot(rs.x - ls.x, rs.y - ls.y) * 0.12;
  const bot = Math.max(lh.y, rh.y) + Math.hypot(rh.x - lh.x, rh.y - lh.y) * 0.08;
  if (y < top || y > bot) return false;

  const mx = (ls.x + rs.x + lh.x + rh.x) / 4;
  const my = (ls.y + rs.y + lh.y + rh.y) / 4;
  const shoulderW = Math.hypot(rs.x - ls.x, rs.y - ls.y);
  const halfW = shoulderW * 0.72;
  const dx = x - mx;
  const dy = y - my;
  const ex = { x: rs.x - ls.x, y: rs.y - ls.y };
  const ey = { x: (lh.x + rh.x) / 2 - (ls.x + rs.x) / 2, y: (lh.y + rh.y) / 2 - (ls.y + rs.y) / 2 };
  const el = Math.hypot(ex.x, ex.y) || 1;
  const ew = Math.hypot(ey.x, ey.y) || 1;
  ex.x /= el; ex.y /= el;
  ey.x /= ew; ey.y /= ew;
  const lx = dx * ex.x + dy * ex.y;
  const ly = dx * ey.x + dy * ey.y;
  return Math.abs(lx) <= halfW && ly >= -shoulderW * 0.15 && ly <= shoulderW * 1.05;
}

/**
 * Masque dorsal lissé (W×H), valeurs 0–255.
 */
export function buildBackSilhouette(mask, P, W, H, prev = null) {
  if (!mask || !P) return prev;

  let raw;
  try {
    raw = mask.getAsFloat32Array();
  } catch {
    return prev;
  }

  const mw = mask.width;
  const mh = mask.height;
  const n = W * H;
  const out = prev && prev.length === n ? prev : new Uint8ClampedArray(n);

  for (let y = 0; y < H; y++) {
    const sy = Math.min(mh - 1, Math.round((y / H) * mh));
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const sx = Math.min(mw - 1, Math.round((x / W) * mw));
      let v = raw[sy * mw + sx] > MASK_THRESH && inTorsoClip(x, y, P) ? 255 : 0;
      if (prev) v = Math.round(prev[i] * (1 - BLEND) + v * BLEND);
      out[i] = v;
    }
  }
  return out;
}

function isEdge(alpha, W, H, x, y, t = 96) {
  const i = y * W + x;
  if (alpha[i] < t) return false;
  if (x === 0 || y === 0 || x === W - 1 || y === H - 1) return true;
  return (
    alpha[i - 1] < t || alpha[i + 1] < t ||
    alpha[i - W] < t || alpha[i + W] < t
  );
}

/** Contour angulaire autour du centroïde (silhouette lissée). */
export function traceBackContour(alpha, W, H) {
  if (!alpha) return null;
  const edges = [];
  const step = Math.max(2, Math.round(Math.min(W, H) / 240));
  for (let y = 0; y < H; y += step) {
    for (let x = 0; x < W; x += step) {
      if (isEdge(alpha, W, H, x, y)) edges.push({ x, y });
    }
  }
  if (edges.length < 8) return null;

  let cx = 0, cy = 0;
  for (const p of edges) { cx += p.x; cy += p.y; }
  cx /= edges.length;
  cy /= edges.length;

  edges.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));

  // Lissage léger : sous-échantillonner pour éviter les zigzags.
  const maxPts = 72;
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
 * Overlay : remplissage léger + contour vert + heatmap éventuelle clipée au dos.
 */
export function drawBackSegmentationOverlay(ctx, alpha, W, H, { contour, heatCanvas, frame } = {}) {
  if (!alpha) return;

  const path = contour ? pathFromContour(contour) : null;

  // Remplissage de la silhouette
  const fillImg = ctx.createImageData(W, H);
  const d = fillImg.data;
  for (let i = 0; i < W * H; i++) {
    if (alpha[i] < 80) continue;
    const o = i * 4;
    d[o] = 0;
    d[o + 1] = 255;
    d[o + 2] = 120;
    d[o + 3] = Math.min(55, Math.round(alpha[i] * 0.22));
  }
  ctx.putImageData(fillImg, 0, 0);

  // Heatmap projetée sur le dos réel (pas de grille)
  if (heatCanvas && frame && path) {
    const a = frame.ex.x * frame.width;
    const b = frame.ex.y * frame.width;
    const c = frame.ey.x * frame.height;
    const d2 = frame.ey.y * frame.height;
    const e = frame.origin.x - 0.5 * a;
    const f = frame.origin.y - 0.5 * b;
    ctx.save();
    ctx.clip(path);
    ctx.setTransform(a, b, c, d2, e, f);
    ctx.globalAlpha = 0.72;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(heatCanvas, 0, 0, 1, 1);
    ctx.restore();
  }

  // Contour du dos
  if (path) {
    ctx.save();
    ctx.strokeStyle = 'rgba(0, 255, 120, 0.95)';
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(0, 255, 0, 0.55)';
    ctx.shadowBlur = 6;
    ctx.stroke(path);
    ctx.restore();
  }
}
