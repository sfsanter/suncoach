/**
 * Facteur de taille du contour dos — outil de calibration, pas d’UI.
 * Le contour auto est géométrique ; `?contour=0.9` permet de tester une
 * largeur globale sans rebuild, la valeur retenue est ensuite figée dans le code.
 */
const KEY = 'suncoach.contourScale';
export const MIN_SCALE = 0.62;
export const MAX_SCALE = 1.3;
export const STEP = 0.06;

let cached = null;

function clampScale(v) {
  if (!Number.isFinite(v)) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, v));
}

function fromUrl() {
  if (typeof window === 'undefined') return null;
  try {
    const raw = new URLSearchParams(window.location.search).get('contour');
    if (raw == null) return null;
    const v = Number(raw);
    return Number.isFinite(v) ? clampScale(v) : null;
  } catch {
    return null;
  }
}

export function getContourScale() {
  if (cached != null) return cached;
  const forced = fromUrl();
  if (forced != null) {
    cached = forced;
    return cached;
  }
  try {
    const stored = Number(window.localStorage?.getItem(KEY));
    cached = Number.isFinite(stored) && stored > 0 ? clampScale(stored) : 1;
  } catch {
    cached = 1;
  }
  return cached;
}

export function setContourScale(v) {
  cached = clampScale(v);
  try {
    window.localStorage?.setItem(KEY, String(cached));
  } catch {
    /* stockage indisponible : réglage valable pour la séance */
  }
  return cached;
}

export function nudgeContourScale(delta) {
  return setContourScale(getContourScale() + delta);
}

/** Redimensionne 8 ancres autour de leur centre (largeur pleine, hauteur amortie). */
export function scaleAnchors(anchors, factor) {
  if (!anchors || factor === 1) return anchors;
  const pts = Object.values(anchors).filter(Boolean);
  if (!pts.length) return anchors;
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const fy = 1 + (factor - 1) * 0.5;
  const out = {};
  for (const [id, p] of Object.entries(anchors)) {
    if (!p) continue;
    out[id] = { x: cx + (p.x - cx) * factor, y: cy + (p.y - cy) * fy };
  }
  return out;
}
