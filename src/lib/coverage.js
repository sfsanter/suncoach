/**
 * Modélisation du dos en coordonnées torse (u, v). Heatmap fine limitée à une
 * silhouette ajustable (scale morphologique via segmentation légère).
 */
import { LM } from './pose.js';
import { ANATOMICAL_ZONES, ZONE_COUNT } from './zones.js';

export { ANATOMICAL_ZONES, ZONE_COUNT };
export const ROWS = 4;
export const COLS = 3;

export const HEAT_W = 36;
export const HEAT_H = 48;

const PIXEL_NEED = 0.18;
const ZONE_RATIO = 0.55;
/** Pinceau plus large : une paume couvre une zone visible sur la minimap. */
const SIGMA = 0.085;

let shapeScale = 1.0;
let bodyMask = new Uint8Array(HEAT_W * HEAT_H);

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
  if (v < 0 || v > 1) return false;
  return Math.abs(u - 0.5) <= effectiveHalfWidth(v);
}

/** Marge élargie pour accepter une main légèrement hors silhouette. */
export function nearBackShape(u, v, margin = 0.06) {
  if (v < -0.05 || v > 1.05) return false;
  const vClamped = Math.max(0, Math.min(1, v));
  return Math.abs(u - 0.5) <= effectiveHalfWidth(vClamped) + margin;
}

function rebuildBodyMask() {
  for (let y = 0; y < HEAT_H; y++) {
    for (let x = 0; x < HEAT_W; x++) {
      const i = y * HEAT_W + x;
      bodyMask[i] = insideBackShape((x + 0.5) / HEAT_W, (y + 0.5) / HEAT_H) ? 1 : 0;
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
  return {
    u: (dx * f.ex.x + dy * f.ex.y) / f.width + 0.5,
    v: (dx * f.ey.x + dy * f.ey.y) / f.height,
  };
}

export function backToPx(u, v, f) {
  const du = (u - 0.5) * f.width;
  const dv = v * f.height;
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
  }

  isBody(i) {
    return bodyMask[i] === 1;
  }

  pixelFraction(i) {
    return Math.min(1, this.heat[i] / PIXEL_NEED);
  }

  update(hands, dt) {
    const reach = 3 * SIGMA;
    let added = 0, crossed = 0;
    for (const h of hands) {
      if (h.u < -0.08 || h.u > 1.08 || h.v < -0.08 || h.v > 1.08) continue;
      const x0 = Math.max(0, Math.floor((h.u - reach) * HEAT_W));
      const x1 = Math.min(HEAT_W - 1, Math.ceil((h.u + reach) * HEAT_W));
      const y0 = Math.max(0, Math.floor((h.v - reach) * HEAT_H));
      const y1 = Math.min(HEAT_H - 1, Math.ceil((h.v + reach) * HEAT_H));
      for (let y = y0; y <= y1; y++) {
        const pv = (y + 0.5) / HEAT_H;
        for (let x = x0; x <= x1; x++) {
          const i = y * HEAT_W + x;
          if (bodyMask[i] === 0) continue;
          const pu = (x + 0.5) / HEAT_W;
          const du = pu - h.u;
          const dv = pv - h.v;
          const wgt = Math.exp(-(du * du + dv * dv) / (2 * SIGMA * SIGMA));
          if (wgt <= 0.03) continue;
          const before = this.heat[i];
          if (before < PIXEL_NEED) {
            this.heat[i] = before + dt * wgt;
            added += dt * wgt;
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
    for (let i = 0; i < ZONE_COUNT; i++) if (!this.isCovered(i)) return false;
    return true;
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
