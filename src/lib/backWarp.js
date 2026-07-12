/**
 * Warp affine par morceaux (éventail) : unifie pixels photo ↔ UV générique (zones, heatmap).
 */
import { ANCHOR_ORDER } from './backCalibration.js';

export const GENERIC_UV_ANCHORS = {
  nuque: { x: 0.50, y: 0.04 },
  epaule_g: { x: 0.14, y: 0.14 },
  epaule_d: { x: 0.86, y: 0.14 },
  milieu_g: { x: 0.08, y: 0.50 },
  milieu_d: { x: 0.92, y: 0.50 },
  rein_g: { x: 0.18, y: 0.82 },
  rein_d: { x: 0.82, y: 0.82 },
  bas: { x: 0.50, y: 0.96 },
};

function centroid(points) {
  const n = points.length;
  const s = points.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y }), { x: 0, y: 0 });
  return { x: s.x / n, y: s.y / n };
}

function buildFanTriangles(anchorsByName) {
  const ordered = ANCHOR_ORDER.map((name) => anchorsByName[name]).filter(Boolean);
  if (ordered.length < 4) return [];
  const c = centroid(ordered);
  const triangles = [];
  for (let i = 0; i < ordered.length; i++) {
    triangles.push([c, ordered[i], ordered[(i + 1) % ordered.length]]);
  }
  return triangles;
}

function affineFromTriangle(srcTri, dstTri) {
  const [s0, s1, s2] = srcTri;
  const [d0, d1, d2] = dstTri;
  const x1 = s1.x - s0.x, y1 = s1.y - s0.y;
  const x2 = s2.x - s0.x, y2 = s2.y - s0.y;
  const det = x1 * y2 - x2 * y1;
  if (Math.abs(det) < 1e-9) return null;
  return (p) => {
    const px = p.x - s0.x, py = p.y - s0.y;
    const a = (px * y2 - py * x2) / det;
    const b = (py * x1 - px * y1) / det;
    return {
      x: d0.x + a * (d1.x - d0.x) + b * (d2.x - d0.x),
      y: d0.y + a * (d1.y - d0.y) + b * (d2.y - d0.y),
    };
  };
}

function pointInTriangle(p, [a, b, c]) {
  const d1 = (p.x - b.x) * (a.y - b.y) - (a.x - b.x) * (p.y - b.y);
  const d2 = (p.x - c.x) * (b.y - c.y) - (b.x - c.x) * (p.y - c.y);
  const d3 = (p.x - a.x) * (c.y - a.y) - (c.x - a.x) * (p.y - a.y);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function mapVia(triSetA, triSetB, point) {
  for (let i = 0; i < triSetA.length; i++) {
    if (pointInTriangle(point, triSetA[i])) {
      const warp = affineFromTriangle(triSetA[i], triSetB[i]);
      if (warp) return warp(point);
    }
  }
  return null;
}

/** Pixels photo → UV générique (0–1, même espace que ANATOMICAL_ZONES). */
export function buildBackWarp(pxAnchorsByName, genericAnchorsByName = GENERIC_UV_ANCHORS) {
  const customTris = buildFanTriangles(pxAnchorsByName);
  const genericTris = buildFanTriangles(genericAnchorsByName);
  if (!customTris.length || customTris.length !== genericTris.length) return null;

  const outline = ANCHOR_ORDER
    .map((id) => genericAnchorsByName[id])
    .filter(Boolean)
    .map((p) => ({ u: p.x, v: p.y }));

  return {
    toGenericUv: (pixelPoint) => {
      const m = mapVia(customTris, genericTris, pixelPoint);
      return m ? { u: m.x, v: m.y } : null;
    },
    fromGenericUv: (uvPoint) => {
      const m = mapVia(genericTris, customTris, { x: uvPoint.u, y: uvPoint.v });
      return m ? { x: m.x, y: m.y } : null;
    },
    outline,
    insideGeneric(u, v) {
      const p = { x: u, y: v };
      for (const tri of genericTris) {
        if (pointInTriangle(p, tri)) return true;
      }
      return false;
    },
  };
}

let activeWarp = null;

export function setBackWarp(warp) {
  activeWarp = warp;
}

export function getBackWarp() {
  return activeWarp;
}

export function paintUvFromWarpedPixel(warpedPx, backU, backV, layout) {
  if (activeWarp && warpedPx) {
    const g = activeWarp.toGenericUv(warpedPx);
    if (g) return g;
  }
  if (layout && warpedPx) {
    return {
      u: (warpedPx.x - layout.minX) / layout.bw,
      v: (warpedPx.y - layout.minY) / layout.bh,
    };
  }
  return { u: backU, v: backV };
}
