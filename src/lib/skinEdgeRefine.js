/**
 * Correcteur bords par couleur peau — une fois au lock (pas 60 fps).
 * Marche depuis l’intérieur (peau connue) vers l’extérieur jusqu’à la
 * rupture de couleur = silhouette réelle. Les joints MediaPipe sont trop
 * « dedans » : on autorise une poussée large.
 */
import { BACK_ANCHOR_ORDER } from './backWarp.js';

/** Recherche max le long de la normale (fraction largeur d’épaules). */
const MAX_PUSH_FRAC = 0.32;
/** Lab : peau vs fond / vêtement. Un peu large (lumière téléphone). */
const LAB_THRESH = 18;
const SAMPLE_R = 3;
const NORMAL_STEPS = 28;

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
        x: (anchors.rein_g.x + anchors.rein_d.x) / 2,
        y: (anchors.rein_g.y + anchors.rein_d.y) / 2,
      }
      : null,
  ].filter(Boolean);

  const labs = [];
  for (const s of samples) {
    // Centre-dos : toujours échantillonner, même si le poly de départ est petit.
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

function outwardNormal(poly, index, centroid) {
  const n = poly.length;
  const prev = poly[(index - 1 + n) % n];
  const next = poly[(index + 1) % n];
  const tx = next.x - prev.x;
  const ty = next.y - prev.y;
  const len = Math.hypot(tx, ty) || 1;
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
 * Depuis un point intérieur, avance le long de la normale jusqu’à la
 * dernière position encore « peau ».
 */
function walkOutToSkinEdge(data, W, H, start, normal, maxPush, skin) {
  const step = maxPush / NORMAL_STEPS;
  let lastSkin = { x: start.x, y: start.y };
  let seenSkin = false;
  for (let s = 0; s <= NORMAL_STEPS; s++) {
    const t = s * step;
    const x = clamp(start.x + normal.x * t, 0, W - 1);
    const y = clamp(start.y + normal.y * t, 0, H - 1);
    const lab = sampleLabAt(data, W, H, x, y);
    if (!lab) break;
    if (labDist(lab, skin) <= LAB_THRESH) {
      lastSkin = { x, y };
      seenSkin = true;
      continue;
    }
    if (seenSkin) break;
  }
  return seenSkin ? lastSkin : null;
}

/**
 * Snap chaque ancre : intérieur → bord peau. Ne jamais rentrer vers la colonne
 * par rapport au départ (filet « trop petit »).
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

  const snapped = {};
  for (let i = 0; i < ordered.length; i++) {
    const p = ordered[i];
    const n = outwardNormal(ordered, i, centroid);
    // Recule un peu vers le centre pour partir de peau sûre, puis marche dehors.
    const start = {
      x: p.x - n.x * sw * 0.08,
      y: p.y - n.y * sw * 0.08,
    };
    const edge = walkOutToSkinEdge(imageData.data, W, H, start, n, maxPush, skin);
    snapped[p.id] = edge || { x: p.x, y: p.y };
  }

  const midX = ((anchors.epaule_g?.x ?? 0) + (anchors.epaule_d?.x ?? 0)) / 2;
  const out = {};
  const leftIds = new Set(['epaule_g', 'milieu_g', 'rein_g']);
  const rightIds = new Set(['epaule_d', 'milieu_d', 'rein_d']);

  for (const id of BACK_ANCHOR_ORDER) {
    const a = anchors[id];
    const b = snapped[id];
    if (!a || !b) return null;
    let x = b.x;
    let y = b.y;

    if (leftIds.has(id)) {
      x = Math.min(a.x, b.x);
    } else if (rightIds.has(id)) {
      x = Math.max(a.x, b.x);
    } else if (id === 'bas') {
      x = midX;
      const reinY = Math.max(anchors.rein_g?.y ?? a.y, anchors.rein_d?.y ?? a.y);
      y = clamp(Math.max(a.y, b.y), reinY, reinY + sw * 0.12);
    } else if (id === 'nuque') {
      x = midX * 0.35 + ((a.x + b.x) / 2) * 0.65;
      y = Math.min(a.y, b.y);
    }

    out[id] = { x, y };
  }
  return out;
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
