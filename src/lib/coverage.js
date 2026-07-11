/**
 * Modélisation du dos en coordonnées torse (u, v). Heatmap fine limitée à une
 * silhouette ajustable (scale morphologique via segmentation légère).
 */
import { LM } from './pose.js';
import { ANATOMICAL_ZONES, ZONE_COUNT } from './zones.js';
import { buildCanonicalShape, canonicalToBackUv, backUvToCanonical } from './anchorShape.js';

export { ANATOMICAL_ZONES, ZONE_COUNT };
export const ROWS = 4;
export const COLS = 3;

export const HEAT_W = 36;
export const HEAT_H = 48;

const PIXEL_NEED = 0.2;
const ZONE_RATIO = 0.58;
/** Pinceau : une paume couvre une zone visible sur la minimap. */
const SIGMA = 0.085;
export const DONE_PAINTED_RATIO = 0.94;
export const MIN_COVERAGE_SEC = 50;

const TRACE_BINS = 32;

let shapeScale = 1.0;
let bodyMask = new Uint8Array(HEAT_W * HEAT_H);
/** @type {Record<string, {u:number,v:number}>|null} */
let customAnchors = null;
let canonicalShape = null;
/** @type {{ left: Float32Array, right: Float32Array, valid: Uint8Array, vTop: number, vBot: number, outline: {u,v}[] }|null} */
let tracedContour = null;

const SHAPE_KNOTS = [
  [0.00, 0.42],
  [0.06, 0.50],
  [0.22, 0.45],
  [0.50, 0.36],
  [0.78, 0.42],
  [0.92, 0.46],
  [1.00, 0.43],
];

export function backHalfWidth(v) {
  if (v <= SHAPE_KNOTS[0][0]) return SHAPE_KNOTS[0][1] * shapeScale;
  for (let i = 1; i < SHAPE_KNOTS.length; i++) {
    const [v1, w1] = SHAPE_KNOTS[i];
    const [v0, w0] = SHAPE_KNOTS[i - 1];
    if (v <= v1) return (w0 + ((v - v0) / (v1 - v0)) * (w1 - w0)) * shapeScale;
  }
  return SHAPE_KNOTS[SHAPE_KNOTS.length - 1][1] * shapeScale;
}

function effectiveHalfWidth(v) {
  let hw = backHalfWidth(v);
  if (v < 0.06) {
    const t = v / 0.06;
    hw = Math.min(hw, (0.42 + t * 0.1) * shapeScale);
  }
  return hw;
}

export function insideBackShape(u, v) {
  if (tracedContour) {
    const { left, right, valid, vTop, vBot } = tracedContour;
    // Nuque : au-dessus du masque IA (cheveux souvent exclus du scan).
    if (v < vTop - 0.04) {
      if (v >= vTop - 0.18) {
        const hw = effectiveHalfWidth(Math.max(0, vTop - 0.06)) * 0.88;
        return Math.abs(u - 0.5) <= hw;
      }
      return false;
    }
    if (v > vBot + 0.04) return false;
    const idx = Math.max(0, Math.min(TRACE_BINS - 1, Math.floor(v * TRACE_BINS)));
    if (!valid[idx]) return false;
    const margin = 0.04;
    return u >= left[idx] - margin && u <= right[idx] + margin;
  }
  if (customAnchors) {
    const top = customAnchors.nuque?.v ?? 0;
    const bot = customAnchors.bas?.v ?? 1;
    if (v < top - 0.03 || v > bot + 0.03) return false;
    const left = boundaryAt(v, 'left');
    const right = boundaryAt(v, 'right');
    return u >= left && u <= right;
  }
  if (v < 0 || v > 1) return false;
  return Math.abs(u - 0.5) <= effectiveHalfWidth(v);
}

function boundaryAt(v, side) {
  const ids = side === 'left'
    ? ['epaule_g', 'milieu_g', 'rein_g']
    : ['epaule_d', 'milieu_d', 'rein_d'];
  const pts = ids
    .map((id) => customAnchors?.[id])
    .filter(Boolean)
    .sort((a, b) => a.v - b.v);
  if (!pts.length) {
    const hw = effectiveHalfWidth(v);
    return side === 'left' ? 0.5 - hw : 0.5 + hw;
  }
  if (v <= pts[0].v) return pts[0].u;
  if (v >= pts[pts.length - 1].v) return pts[pts.length - 1].u;
  for (let i = 1; i < pts.length; i++) {
    const p0 = pts[i - 1];
    const p1 = pts[i];
    if (v <= p1.v) {
      const t = (v - p0.v) / (p1.v - p0.v || 1);
      return p0.u + t * (p1.u - p0.u);
    }
  }
  return pts[pts.length - 1].u;
}

/** Contour minimap : uniquement les 8 points manuels (espace canonique 0–1). */
export function customBackOutlineUV() {
  if (canonicalShape?.outline?.length >= 4) {
    return canonicalShape.outline.map((p) => ({ u: p.u, v: p.v }));
  }
  if (!customAnchors) return null;
  const order = ['nuque', 'epaule_g', 'milieu_g', 'rein_g', 'bas', 'rein_d', 'milieu_d', 'epaule_d'];
  const pts = order.map((id) => customAnchors[id]).filter(Boolean);
  return pts.length >= 4 ? pts : null;
}

export function getCanonicalShape() {
  return canonicalShape;
}

export function toCanonicalUV(u, v) {
  return canonicalShape ? backUvToCanonical(u, v, canonicalShape) : { u, v };
}

export function setCustomBackAnchors(anchors) {
  customAnchors = anchors ? { ...anchors } : null;
  canonicalShape = anchors ? buildCanonicalShape(anchors) : null;
  if (anchors) tracedContour = null;
  rebuildBodyMask();
}

export function setTracedContour(contour) {
  tracedContour = contour;
  if (contour) customAnchors = null;
  rebuildBodyMask();
}

export function getTracedContour() {
  return tracedContour;
}

export function getCustomBackAnchors() {
  return customAnchors;
}

/** Marge élargie pour accepter une main légèrement hors silhouette. */
export function nearBackShape(u, v, margin = 0.06) {
  if (tracedContour || customAnchors) return insideBackShape(u, v);
  if (v < -0.05 || v > 1.05) return false;
  const vClamped = Math.max(0, Math.min(1, v));
  return Math.abs(u - 0.5) <= effectiveHalfWidth(vClamped) + margin;
}

function rebuildBodyMask() {
  for (let y = 0; y < HEAT_H; y++) {
    for (let x = 0; x < HEAT_W; x++) {
      const i = y * HEAT_W + x;
      const uc = (x + 0.5) / HEAT_W;
      const vc = (y + 0.5) / HEAT_H;
      if (canonicalShape && customAnchors) {
        const { u, v } = canonicalToBackUv(uc, vc, canonicalShape);
        bodyMask[i] = insideBackShape(u, v) ? 1 : 0;
      } else {
        bodyMask[i] = insideBackShape(uc, vc) ? 1 : 0;
      }
    }
  }
}

export function setShapeScale(scale) {
  shapeScale = Math.max(0.75, Math.min(1.25, scale));
  rebuildBodyMask();
}

export function getShapeScale() {
  return shapeScale;
}

rebuildBodyMask();

export function zoneName(zoneIdx) {
  return ANATOMICAL_ZONES[zoneIdx]?.name ?? '';
}

export function torsoFrame(P) {
  const ls = P[LM.L_SHOULDER], rs = P[LM.R_SHOULDER];
  const lh = P[LM.L_HIP], rh = P[LM.R_HIP];
  if ([ls, rs, lh, rh].some((p) => p.visibility < 0.4)) return null;

  const origin = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
  const hipMid = { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 };

  let ex = { x: rs.x - ls.x, y: rs.y - ls.y };
  const width = Math.hypot(ex.x, ex.y) * 1.1;
  let ey = { x: hipMid.x - origin.x, y: hipMid.y - origin.y };
  const height = Math.hypot(ey.x, ey.y) * 1.08;
  if (width < 1 || height < 1) return null;

  ex = { x: ex.x / Math.hypot(ex.x, ex.y), y: ex.y / Math.hypot(ex.x, ex.y) };
  ey = { x: ey.x / Math.hypot(ey.x, ey.y), y: ey.y / Math.hypot(ey.x, ey.y) };

  return { origin, ex, ey, width, height };
}

export function toBack(p, f) {
  const dx = p.x - f.origin.x;
  const dy = p.y - f.origin.y;
  const raw = {
    u: (dx * f.ex.x + dy * f.ex.y) / f.width + 0.5,
    v: (dx * f.ey.x + dy * f.ey.y) / f.height,
  };
  return mapBackUV(raw.u, raw.v);
}

/**
 * Corrige l'inversion miroir caméra → schéma dos.
 * Sans ce flip, frotter en haut-gauche peignait en bas-droite sur la minimap.
 */
export function mapBackUV(u, v) {
  return { u: 1 - u, v: 1 - v };
}

/**
 * Heatmap inversée : voile orange léger au départ, dégradés visibles en frottant,
 * vert néon opaque quand la zone est bien couverte.
 * @param {number} f fraction de couverture 0–1
 * @returns {[number, number, number, number]} rgba
 */
export function coverageHeatRGBA(f) {
  const x = Math.max(0, Math.min(1, f));
  if (x >= 0.9) return [30, 255, 90, 255];
  if (x <= 0.03) return [255, 110, 25, 48];

  const t = (x - 0.03) / 0.87;
  if (t < 0.2) {
    const u = t / 0.2;
    return [255, Math.round(105 + u * 70), Math.round(20 + u * 15), Math.round(48 + u * 55)];
  }
  if (t < 0.45) {
    const u = (t - 0.2) / 0.25;
    return [
      Math.round(255 - u * 120),
      Math.round(175 + u * 55),
      Math.round(35 - u * 10),
      Math.round(103 + u * 70),
    ];
  }
  if (t < 0.7) {
    const u = (t - 0.45) / 0.25;
    return [
      Math.round(135 - u * 100),
      Math.round(230 + u * 20),
      Math.round(25 + u * 35),
      Math.round(173 + u * 55),
    ];
  }
  const u = (t - 0.7) / 0.3;
  return [
    Math.round(35 - u * 5),
    Math.round(250 + u * 5),
    Math.round(60 + u * 30),
    Math.round(228 + u * 27),
  ];
}

export function mapBackPoint(p, f) {
  return toBack(p, f);
}

export function backToPx(u, v, f) {
  const m = mapBackUV(u, v);
  const du = (m.u - 0.5) * f.width;
  const dv = m.v * f.height;
  return {
    x: f.origin.x + f.ex.x * du + f.ey.x * dv,
    y: f.origin.y + f.ex.y * du + f.ey.y * dv,
  };
}

const v3 = {
  sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }),
  mid: (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 }),
  dot: (a, b) => a.x * b.x + a.y * b.y + a.z * b.z,
  cross: (a, b) => ({
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  }),
  len: (a) => Math.hypot(a.x, a.y, a.z),
  norm: (a) => {
    const l = Math.hypot(a.x, a.y, a.z) || 1;
    return { x: a.x / l, y: a.y / l, z: a.z / l };
  },
};

export function torsoFrame3D(W) {
  const ls = W[LM.L_SHOULDER], rs = W[LM.R_SHOULDER];
  const lh = W[LM.L_HIP], rh = W[LM.R_HIP];
  if ([ls, rs, lh, rh].some((p) => p.visibility < 0.4)) return null;

  const origin = v3.mid(ls, rs);
  const hipMid = v3.mid(lh, rh);
  const shoulderVec = v3.sub(rs, ls);
  const downVec = v3.sub(hipMid, origin);

  const width = v3.len(shoulderVec) * 1.15;
  const height = v3.len(downVec) * 1.08;
  if (width < 0.05 || height < 0.05) return null;

  const ex = v3.norm(shoulderVec);
  const ey = v3.norm(downVec);
  const ez = v3.norm(v3.cross(ex, ey));

  return { origin, ex, ey, ez, width, height };
}

export function toBack3D(p, f) {
  const d = v3.sub(p, f.origin);
  return {
    u: v3.dot(d, f.ex) / f.width + 0.5,
    v: v3.dot(d, f.ey) / f.height,
    w: v3.dot(d, f.ez),
  };
}

function inZone(u, v, z) {
  return u >= z.u0 && u <= z.u1 && v >= z.v0 && v <= z.v1;
}

export class CoverageGrid {
  constructor() {
    this.heat = new Float32Array(HEAT_W * HEAT_H);
    this.need = PIXEL_NEED;
  }

  reset() {
    this.heat.fill(0);
    setShapeScale(1.0);
    setCustomBackAnchors(null);
    setTracedContour(null);
    canonicalShape = null;
  }

  isBody(i) {
    return bodyMask[i] === 1;
  }

  pixelFraction(i) {
    return Math.min(1, this.heat[i] / PIXEL_NEED);
  }

  /** Interpolation bilinéaire — entrée en repère dos, stockage canonique si 8 points. */
  sample(u, v) {
    let qu = u;
    let qv = v;
    if (canonicalShape && customAnchors) {
      const c = backUvToCanonical(u, v, canonicalShape);
      qu = c.u;
      qv = c.v;
    }
    if (qu < 0 || qu > 1 || qv < 0 || qv > 1) return 0;
    const x = qu * (HEAT_W - 1);
    const y = qv * (HEAT_H - 1);
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const x1 = Math.min(HEAT_W - 1, x0 + 1);
    const y1 = Math.min(HEAT_H - 1, y0 + 1);
    const tx = x - x0, ty = y - y0;
    const s = (ix, iy) => {
      const i = iy * HEAT_W + ix;
      return bodyMask[i] ? this.pixelFraction(i) : 0;
    };
    return (
      s(x0, y0) * (1 - tx) * (1 - ty) +
      s(x1, y0) * tx * (1 - ty) +
      s(x0, y1) * (1 - tx) * ty +
      s(x1, y1) * tx * ty
    );
  }

  missingZones() {
    return ANATOMICAL_ZONES.map((zone, idx) => ({
      idx,
      zone,
      ratio: this.zoneRatio(idx),
    }))
      .filter((z) => z.ratio < ZONE_RATIO)
      .sort((a, b) => a.ratio - b.ratio);
  }

  biggestGap() {
    return this.missingZones()[0] ?? null;
  }

  update(hands, dt) {
    const reach = 3 * SIGMA;
    let added = 0, crossed = 0;
    for (const h of hands) {
      let hu = h.u;
      let hv = h.v;
      if (canonicalShape && customAnchors) {
        const c = backUvToCanonical(hu, hv, canonicalShape);
        hu = c.u;
        hv = c.v;
      }
      if (hu < -0.08 || hu > 1.08 || hv < -0.08 || hv > 1.08) continue;
      const x0 = Math.max(0, Math.floor((hu - reach) * HEAT_W));
      const x1 = Math.min(HEAT_W - 1, Math.ceil((hu + reach) * HEAT_W));
      const y0 = Math.max(0, Math.floor((hv - reach) * HEAT_H));
      const y1 = Math.min(HEAT_H - 1, Math.ceil((hv + reach) * HEAT_H));
      for (let y = y0; y <= y1; y++) {
        const pv = (y + 0.5) / HEAT_H;
        for (let x = x0; x <= x1; x++) {
          const i = y * HEAT_W + x;
          if (bodyMask[i] === 0) continue;
          const pu = (x + 0.5) / HEAT_W;
          const du = pu - hu;
          const dv = pv - hv;
          const wgt = Math.exp(-(du * du + dv * dv) / (2 * SIGMA * SIGMA));
          if (wgt <= 0.03) continue;
          const before = this.heat[i];
          if (before < PIXEL_NEED) {
            const step = Math.min(dt, 0.035) * wgt;
            this.heat[i] = before + step;
            added += step;
            if (this.heat[i] >= PIXEL_NEED) crossed++;
          }
        }
      }
    }
    return { added, crossed };
  }

  zoneRatio(zoneIdx) {
    const z = ANATOMICAL_ZONES[zoneIdx];
    if (!z) return 1;
    let painted = 0, body = 0;
    for (let y = 0; y < HEAT_H; y++) {
      const v = (y + 0.5) / HEAT_H;
      for (let x = 0; x < HEAT_W; x++) {
        const u = (x + 0.5) / HEAT_W;
        if (!inZone(u, v, z)) continue;
        const i = y * HEAT_W + x;
        if (bodyMask[i] === 0) continue;
        body++;
        if (this.heat[i] >= PIXEL_NEED) painted++;
      }
    }
    if (body === 0) return 1;
    return painted / body;
  }

  fractionOf(zoneIdx) {
    return Math.min(1, this.zoneRatio(zoneIdx) / ZONE_RATIO);
  }

  isCovered(zoneIdx) {
    return this.zoneRatio(zoneIdx) >= ZONE_RATIO;
  }

  get fraction() {
    let sum = 0;
    for (let i = 0; i < ZONE_COUNT; i++) sum += this.fractionOf(i);
    return sum / ZONE_COUNT;
  }

  get paintedRatio() {
    let painted = 0, body = 0;
    for (let i = 0; i < this.heat.length; i++) {
      if (bodyMask[i] === 0) continue;
      body++;
      if (this.heat[i] >= PIXEL_NEED) painted++;
    }
    return body ? painted / body : 0;
  }

  get done() {
    if (this.paintedRatio >= DONE_PAINTED_RATIO) return true;
    return this.missingZones().length === 0;
  }

  nextTarget() {
    for (let i = 0; i < ZONE_COUNT; i++) if (!this.isCovered(i)) return i;
    return null;
  }

  coldestPoint(zoneIdx) {
    const z = ANATOMICAL_ZONES[zoneIdx];
    if (!z) return { u: 0.5, v: 0.5 };
    let best = null;
    for (let y = 0; y < HEAT_H; y++) {
      const v = (y + 0.5) / HEAT_H;
      for (let x = 0; x < HEAT_W; x++) {
        const u = (x + 0.5) / HEAT_W;
        if (!inZone(u, v, z)) continue;
        const i = y * HEAT_W + x;
        if (bodyMask[i] === 0) continue;
        const val = this.heat[i];
        if (!best || val < best.val) best = { val, x, y };
      }
    }
    if (!best) return { u: (z.u0 + z.u1) / 2, v: (z.v0 + z.v1) / 2 };
    return { u: (best.x + 0.5) / HEAT_W, v: (best.y + 0.5) / HEAT_H };
  }

  snapshot() {
    return {
      w: HEAT_W,
      h: HEAT_H,
      need: PIXEL_NEED,
      data: Float32Array.from(this.heat),
      body: Uint8Array.from(bodyMask),
      shapeScale,
    };
  }
}
