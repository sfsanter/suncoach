/**
 * Correcteur bords par couleur peau — une fois au lock (pas 60 fps).
 * Les 8 ancres restent la structure ; on les snappe le long de la normale sortante
 * tant que la couleur reste proche de l’échantillon intérieur.
 */
import { BACK_ANCHOR_ORDER } from './backWarp.js';

/** Max push / pull as fraction of shoulder width. */
const MAX_PUSH_FRAC = 0.07;
/** Lab distance threshold (~10–18 = peau vs tissu/cheveux). */
const LAB_THRESH = 14;
/** Patch radius (px) for averaging. */
const SAMPLE_R = 4;
/** Steps along each normal. */
const NORMAL_STEPS = 12;

function srgbToLinear(c) {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

function rgbToXyz(r, g, b) {
  const R = srgbToLinear(r);
  const G = srgbToLinear(g);
  const B = srgbToLinear(b);
  return {
    x: R * 0.4124564 + G * 0.3575761 + B * 0.1804375,
    y: R * 0.2126729 + G * 0.7151522 + B * 0.072175,
    z: R * 0.0193339 + G * 0.119192 + B * 0.9503041,
  };
}

function fLab(t) {
  return t > 0.008856 ? t ** (1 / 3) : 7.787 * t + 16 / 116;
}

/** RGB 0–255 → Lab (D65). */
export function rgbToLab(r, g, b) {
  const { x, y, z } = rgbToXyz(r, g, b);
  // D65 white
  const fx = fLab(x / 0.95047);
  const fy = fLab(y / 1);
  const fz = fLab(z / 1.08883);
  return {
    L: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz),
  };
}

export function labDist(p, q) {
  if (!p || !q) return Infinity;
  return Math.hypot(p.L - q.L, p.a - q.a, p.b - q.b);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function sampleLabAt(data, W, H, x, y, r = SAMPLE_R) {
  const ix = Math.round(x);
  const iy = Math.round(y);
  let n = 0;
  let L = 0;
  let a = 0;
  let b = 0;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const px = ix + dx;
      const py = iy + dy;
      if (px < 0 || py < 0 || px >= W || py >= H) continue;
      const i = (py * W + px) * 4;
      const lab = rgbToLab(data[i], data[i + 1], data[i + 2]);
      L += lab.L;
      a += lab.a;
      b += lab.b;
      n++;
    }
  }
  if (!n) return null;
  return { L: L / n, a: a / n, b: b / n };
}

function pointInPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const intersect = ((yi > py) !== (yj > py))
      && (px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-9) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function orderedAnchors(anchors) {
  return BACK_ANCHOR_ORDER.map((id) => ({ id, ...(anchors[id] || {}) }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
}

function shoulderWidth(anchors) {
  const lg = anchors.epaule_g;
  const rd = anchors.epaule_d;
  if (!lg || !rd) return 100;
  return Math.hypot(rd.x - lg.x, rd.y - lg.y) || 100;
}

/** Pastilles intérieures → moyenne Lab peau. */
export function sampleSkinFromPolygon(imageData, W, H, anchors) {
  if (!imageData?.data || !anchors?.nuque) return null;
  const poly = orderedAnchors(anchors);
  if (poly.length < 4) return null;

  const cx = poly.reduce((s, p) => s + p.x, 0) / poly.length;
  const cy = poly.reduce((s, p) => s + p.y, 0) / poly.length;
  const samples = [
    { x: cx, y: cy },
    anchors.nuque && anchors.epaule_g && anchors.epaule_d
      ? {
        x: (anchors.nuque.x + anchors.epaule_g.x + anchors.epaule_d.x) / 3,
        y: (anchors.nuque.y + anchors.epaule_g.y + anchors.epaule_d.y) / 3,
      }
      : null,
    anchors.milieu_g && anchors.milieu_d
      ? {
        x: (anchors.milieu_g.x + anchors.milieu_d.x) / 2,
        y: (anchors.milieu_g.y + anchors.milieu_d.y) / 2,
      }
      : null,
    anchors.rein_g && anchors.rein_d
      ? {
        x: (anchors.rein_g.x + anchors.rein_d.x) * 0.5 * 0.7 + cx * 0.3,
        y: (anchors.rein_g.y + anchors.rein_d.y) / 2,
      }
      : null,
  ].filter(Boolean);

  const labs = [];
  for (const s of samples) {
    if (!pointInPoly(s.x, s.y, poly)) continue;
    const lab = sampleLabAt(imageData.data, W, H, s.x, s.y, SAMPLE_R + 2);
    if (lab) labs.push(lab);
  }
  if (labs.length < 2) return null;
  return {
    L: labs.reduce((s, p) => s + p.L, 0) / labs.length,
    a: labs.reduce((s, p) => s + p.a, 0) / labs.length,
    b: labs.reduce((s, p) => s + p.b, 0) / labs.length,
  };
}

/**
 * Normale sortante en ancre i (polygone CCW/CW — on oriente vers l’extérieur via centroïde).
 */
function outwardNormal(poly, index, centroid) {
  const n = poly.length;
  const prev = poly[(index - 1 + n) % n];
  const next = poly[(index + 1) % n];
  const tx = next.x - prev.x;
  const ty = next.y - prev.y;
  const len = Math.hypot(tx, ty) || 1;
  // Deux perpendiculaires ; garder celle qui s’éloigne du centre
  let nx = -ty / len;
  let ny = tx / len;
  const p = poly[index];
  const toC = { x: centroid.x - p.x, y: centroid.y - p.y };
  if (nx * toC.x + ny * toC.y > 0) {
    nx = -nx;
    ny = -ny;
  }
  return { x: nx, y: ny };
}

/**
 * Snap chaque ancre le long de la normale : point le plus loin encore « peau ».
 */
export function refineAnchorsBySkin(anchors, imageData, W, H, skin) {
  if (!skin || !imageData?.data) return null;
  const ordered = orderedAnchors(anchors);
  if (ordered.length < 8) return null;

  const sw = shoulderWidth(anchors);
  const maxPush = sw * MAX_PUSH_FRAC;
  const cx = ordered.reduce((s, p) => s + p.x, 0) / ordered.length;
  const cy = ordered.reduce((s, p) => s + p.y, 0) / ordered.length;
  const centroid = { x: cx, y: cy };

  const out = {};
  for (let i = 0; i < ordered.length; i++) {
    const p = ordered[i];
    const n = outwardNormal(ordered, i, centroid);
    let best = { x: p.x, y: p.y };
    // Du plus extérieur → intérieur : dernier match = le plus loin encore peau
    let found = false;
    for (let s = NORMAL_STEPS; s >= -Math.floor(NORMAL_STEPS * 0.35); s--) {
      const t = (s / NORMAL_STEPS) * maxPush;
      const x = clamp(p.x + n.x * t, 0, W - 1);
      const y = clamp(p.y + n.y * t, 0, H - 1);
      const lab = sampleLabAt(imageData.data, W, H, x, y);
      if (!lab) continue;
      if (labDist(lab, skin) <= LAB_THRESH) {
        best = { x, y };
        found = true;
        break;
      }
    }
    if (!found) best = { x: p.x, y: p.y };
    out[p.id] = best;
  }

  // Soft blend (évite gros sauts)
  const blended = {};
  const midX = ((anchors.epaule_g?.x ?? 0) + (anchors.epaule_d?.x ?? 0)) / 2;
  for (const id of BACK_ANCHOR_ORDER) {
    const a = anchors[id];
    const b = out[id];
    if (!a || !b) return null;
    let x = a.x * 0.35 + b.x * 0.65;
    let y = a.y * 0.35 + b.y * 0.65;

    // Reins / milieux : interdire un snap vers la colonne (crée une pique bas-dos).
    if (id === 'rein_g' || id === 'milieu_g') {
      x = Math.min(x, a.x); // rester à gauche (ou égal)
      const minOut = midX - sw * 0.16;
      x = Math.min(x, minOut);
    } else if (id === 'rein_d' || id === 'milieu_d') {
      x = Math.max(x, a.x);
      const maxOut = midX + sw * 0.16;
      x = Math.max(x, maxOut);
    } else if (id === 'bas') {
      // Garder le bas centré ; limiter tirage vertical bizarre.
      x = midX * 0.5 + x * 0.5;
      y = Math.max(y, a.y - sw * 0.04);
    }

    blended[id] = { x, y };
  }
  return blended;
}

/**
 * Frame vidéo → ImageData (canvas offscreen).
 * @param {CanvasImageSource} source
 */
export function frameToImageData(source, W, H) {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(source, 0, 0, W, H);
    return ctx.getImageData(0, 0, W, H);
  } catch {
    return null;
  }
}

/**
 * Pipeline lock : sample + refine. Retourne ancres snappées ou null.
 */
export function refineBackAnchorsFromFrame(source, W, H, anchors) {
  const imageData = frameToImageData(source, W, H);
  if (!imageData) return { ok: false, reason: 'frame', anchors };
  const skin = sampleSkinFromPolygon(imageData, W, H, anchors);
  if (!skin) return { ok: false, reason: 'sample', anchors };
  const snapped = refineAnchorsBySkin(anchors, imageData, W, H, skin);
  if (!snapped) return { ok: false, reason: 'snap', anchors };
  return { ok: true, reason: 'peau', anchors: snapped, skin };
}
