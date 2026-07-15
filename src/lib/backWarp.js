/**
 * Warp affine par morceaux (éventail) : unifie pixels photo ↔ UV générique (zones, heatmap).
 */

export const BACK_ANCHOR_ORDER = [
  'nuque',
  'epaule_g',
  'milieu_g',
  'rein_g',
  'bas',
  'rein_d',
  'milieu_d',
  'epaule_d',
];

export const GENERIC_UV_ANCHORS = {
  nuque: { x: 0.50, y: 0.00 },
  epaule_g: { x: 0.14, y: 0.14 },
  epaule_d: { x: 0.86, y: 0.14 },
  milieu_g: { x: 0.08, y: 0.50 },
  milieu_d: { x: 0.92, y: 0.50 },
  rein_g: { x: 0.18, y: 0.82 },
  rein_d: { x: 0.82, y: 0.82 },
  bas: { x: 0.50, y: 0.96 },
};

/** Points intermédiaires nuque↔épaules — lissage léger, sans « bosse » deltoïde. */
const UPPER_STEPS = 3;
/** Ancien 0.07 : trop bombé → protubérance surtout d’un côté. */
const OUTWARD_FRAC = 0.012;
const LIFT_FRAC = 0.03;

function dist2(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Arc haut symétrique par rapport au milieu nuque (évite une bosse asymétrique
 * due aux normales de chemin côté droit vs gauche).
 */
function enrichUpperArc(from, to, steps, midX, scale) {
  const pts = [];
  const outward = scale * OUTWARD_FRAC;
  const lift = scale * LIFT_FRAC;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    // sin: max au milieu du segment, 0 aux extrémités
    const s = Math.sin(t * Math.PI);
    const x0 = from.x + t * dx;
    const y0 = from.y + t * dy;
    // Pousse hors du centre-dos (pas le long de la normale de chemin)
    const away = x0 >= midX ? 1 : -1;
    pts.push({
      x: x0 + away * outward * s,
      y: y0 - lift * s,
    });
  }
  return pts;
}

/** Polyligne fermée densifiée (8 ancres utilisateur + arcs haut). */
export function buildDensifiedPolygon(anchorsByName) {
  const nuque = anchorsByName?.nuque;
  const epaule_g = anchorsByName?.epaule_g;
  const epaule_d = anchorsByName?.epaule_d;
  if (!nuque || !epaule_g || !epaule_d) return null;
  const scale = dist2(epaule_g, epaule_d);
  const midX = nuque.x;
  const leftArc = enrichUpperArc(nuque, epaule_g, UPPER_STEPS, midX, scale);
  const rightArc = enrichUpperArc(epaule_d, nuque, UPPER_STEPS, midX, scale);
  const body = BACK_ANCHOR_ORDER.slice(1).map((id) => anchorsByName[id]);
  if (body.some((p) => !p || !Number.isFinite(p.x))) return null;
  return [nuque, ...leftArc, ...body, ...rightArc];
}

function centroid(points) {
  const n = points.length;
  const s = points.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y }), { x: 0, y: 0 });
  return { x: s.x / n, y: s.y / n };
}

function buildFanTriangles(orderedPoints) {
  if (!orderedPoints?.length || orderedPoints.length < 3) return [];
  if (orderedPoints.some((p) => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) return [];
  const c = centroid(orderedPoints);
  const triangles = [];
  for (let i = 0; i < orderedPoints.length; i++) {
    triangles.push([c, orderedPoints[i], orderedPoints[(i + 1) % orderedPoints.length]]);
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

function buildMappers(srcTriangles, dstTriangles) {
  return srcTriangles.map((triangle, index) => ({
    triangle,
    map: affineFromTriangle(triangle, dstTriangles[index]),
  }));
}

function mapVia(mappers, point) {
  for (const mapper of mappers) {
    if (mapper.map && pointInTriangle(point, mapper.triangle)) {
      return mapper.map(point);
    }
  }
  return null;
}

function bounds(points) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    minX,
    minY,
    width: Math.max(1e-6, maxX - minX),
    height: Math.max(1e-6, maxY - minY),
  };
}

/** Pixels photo → UV générique (0–1, même espace que ANATOMICAL_ZONES). */
export function buildBackWarp(pxAnchorsByName, genericAnchorsByName = GENERIC_UV_ANCHORS) {
  const customOrdered = buildDensifiedPolygon(pxAnchorsByName);
  const genericOrdered = buildDensifiedPolygon(genericAnchorsByName);
  if (!customOrdered || !genericOrdered) return null;

  const customTris = buildFanTriangles(customOrdered);
  const genericTris = buildFanTriangles(genericOrdered);
  if (!customTris.length || customTris.length !== genericTris.length) return null;

  const anchorPixels = BACK_ANCHOR_ORDER.map((id) => pxAnchorsByName[id]);
  const customBounds = bounds(anchorPixels);
  const customToGeneric = buildMappers(customTris, genericTris);
  const genericToCustom = buildMappers(genericTris, customTris);
  const pixelToDisplayUv = (point) => ({
    u: (point.x - customBounds.minX) / customBounds.width,
    v: (point.y - customBounds.minY) / customBounds.height,
  });
  const displayUvToPixel = (point) => ({
    x: customBounds.minX + point.u * customBounds.width,
    y: customBounds.minY + point.v * customBounds.height,
  });

  const pixelOutline = customOrdered.map((p) => ({ x: p.x, y: p.y }));
  const outline = customOrdered.map(pixelToDisplayUv);
  const displayAnchors = Object.fromEntries(
    BACK_ANCHOR_ORDER.map((id, index) => [id, {
      x: pixelToDisplayUv(pxAnchorsByName[id]).u,
      y: pixelToDisplayUv(pxAnchorsByName[id]).v,
    }]),
  );
  const genericOutline = genericOrdered.map((p) => ({ u: p.x, v: p.y }));

  return {
    toGenericUv: (pixelPoint) => {
      const m = mapVia(customToGeneric, pixelPoint);
      return m ? { u: m.x, v: m.y } : null;
    },
    fromGenericUv: (uvPoint) => {
      const m = mapVia(genericToCustom, { x: uvPoint.u, y: uvPoint.v });
      return m ? { x: m.x, y: m.y } : null;
    },
    genericToDisplayUv(uvPoint) {
      const pixel = mapVia(genericToCustom, { x: uvPoint.u, y: uvPoint.v });
      return pixel ? pixelToDisplayUv(pixel) : null;
    },
    displayToGenericUv(displayPoint) {
      const pixel = displayUvToPixel(displayPoint);
      const generic = mapVia(customToGeneric, pixel);
      return generic ? { u: generic.x, v: generic.y } : null;
    },
    displayAspect: customBounds.width / customBounds.height,
    displayAnchors,
    outline,
    pixelOutline,
    genericOutline,
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

/**
 * Pixel figé → UV peinture (même espace que heatmap / zones).
 * Si warp actif : uniquement toGenericUv (pas de fallback mapBackUV, espace différent).
 * @returns {{u:number,v:number}|null}
 */
export function paintUvFromWarpedPixel(warpedPx, backU, backV, layout) {
  if (activeWarp && warpedPx) {
    return activeWarp.toGenericUv(warpedPx);
  }
  if (layout && warpedPx) {
    return {
      u: (warpedPx.x - layout.minX) / layout.bw,
      v: (warpedPx.y - layout.minY) / layout.bh,
    };
  }
  if (backU == null || backV == null) return null;
  return { u: backU, v: backV };
}
