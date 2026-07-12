/**
 * Repères en pixels image (placement tactile) + forme canonique minimap depuis 8 points.
 */
import { LM } from './pose.js';
import { toBack } from './coverage.js';
import { ANCHOR_ORDER } from './backCalibration.js';

/** Positions initiales visibles sur la photo (épaules / hanches), pas le masque IA. */
export function defaultAnchorsPx(P, W, H) {
  const ls = P[LM.L_SHOULDER];
  const rs = P[LM.R_SHOULDER];
  const lh = P[LM.L_HIP];
  const rh = P[LM.R_HIP];
  if (!ls || !rs || !lh || !rh) return null;

  const sw = Math.hypot(rs.x - ls.x, rs.y - ls.y);
  const midX = (ls.x + rs.x) / 2;
  const topY = Math.min(ls.y, rs.y);
  const botY = Math.max(lh.y, rh.y);
  const th = Math.max(sw, botY - topY);

  return {
    nuque: { x: midX, y: topY - sw * 0.1 },
    epaule_g: { x: ls.x - sw * 0.06, y: topY + th * 0.06 },
    epaule_d: { x: rs.x + sw * 0.06, y: topY + th * 0.06 },
    milieu_g: { x: ls.x - sw * 0.04, y: topY + th * 0.38 },
    milieu_d: { x: rs.x + sw * 0.04, y: topY + th * 0.38 },
    rein_g: { x: ls.x + sw * 0.02, y: topY + th * 0.68 },
    rein_d: { x: rs.x - sw * 0.02, y: topY + th * 0.68 },
    bas: { x: midX, y: botY + sw * 0.04 },
  };
}

/** Schéma minimap = proportions exactes des 8 points en pixels photo. */
export function buildMinimapLayout(pxAnchors) {
  const pts = ANCHOR_ORDER.map((id) => pxAnchors[id]).filter(Boolean);
  if (pts.length < 4) return null;

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const padX = (maxX - minX) * 0.1;
  const padY = (maxY - minY) * 0.08;
  minX -= padX;
  maxX += padX;
  minY -= padY;
  maxY += padY;
  const bw = Math.max(40, maxX - minX);
  const bh = Math.max(60, maxY - minY);

  const uvAnchors = {};
  for (const id of ANCHOR_ORDER) {
    const p = pxAnchors[id];
    if (!p) continue;
    uvAnchors[id] = { u: (p.x - minX) / bw, v: (p.y - minY) / bh };
  }

  const leftIds = ['epaule_g', 'milieu_g', 'rein_g'];
  const rightIds = ['epaule_d', 'milieu_d', 'rein_d'];

  const boundaryAt = (v, side) => {
    const ids = side === 'left' ? leftIds : rightIds;
    const list = ids.map((id) => uvAnchors[id]).filter(Boolean).sort((a, b) => a.v - b.v);
    if (!list.length) return side === 'left' ? 0.12 : 0.88;
    if (v <= list[0].v) return list[0].u;
    if (v >= list[list.length - 1].v) return list[list.length - 1].u;
    for (let i = 1; i < list.length; i++) {
      const p0 = list[i - 1];
      const p1 = list[i];
      if (v <= p1.v) {
        const t = (v - p0.v) / (p1.v - p0.v || 1);
        return p0.u + t * (p1.u - p0.u);
      }
    }
    return list[list.length - 1].u;
  };

  const outline = ANCHOR_ORDER.map((id) => uvAnchors[id]).filter(Boolean);

  return {
    minX, minY, bw, bh,
    aspect: bw / bh,
    uvAnchors,
    boundaryAt,
    outline,
  };
}

export function pixelToLayoutUv(x, y, layout) {
  if (!layout) return { u: 0.5, v: 0.5 };
  return {
    u: (x - layout.minX) / layout.bw,
    v: (y - layout.minY) / layout.bh,
  };
}

export function insideLayoutShape(u, v, layout) {
  if (!layout?.uvAnchors) return false;
  const top = layout.uvAnchors.nuque?.v ?? 0;
  const bot = layout.uvAnchors.bas?.v ?? 1;
  if (v < top - 0.03 || v > bot + 0.03) return false;
  const left = layout.boundaryAt(v, 'left');
  const right = layout.boundaryAt(v, 'right');
  return u >= left - 0.02 && u <= right + 0.02;
}

/** Pixels image → repère dos (u, v) pour la heatmap. */
export function pixelsToBackAnchors(pxAnchors, frame) {
  const out = {};
  for (const [id, p] of Object.entries(pxAnchors)) {
    if (!p) continue;
    out[id] = toBack({ x: p.x, y: p.y, visibility: 1 }, frame);
  }
  return out;
}

/** Métriques pour déplier le dos en rectangle minimap (évite l'écrasement). */
export function buildCanonicalShape(uvAnchors) {
  if (!uvAnchors?.nuque || !uvAnchors?.bas) return null;

  const vTop = uvAnchors.nuque.v;
  const vBot = uvAnchors.bas.v;
  const vSpan = Math.max(0.15, vBot - vTop);

  const leftIds = ['epaule_g', 'milieu_g', 'rein_g'];
  const rightIds = ['epaule_d', 'milieu_d', 'rein_d'];

  const boundaryAt = (v, side) => {
    const ids = side === 'left' ? leftIds : rightIds;
    const pts = ids.map((id) => uvAnchors[id]).filter(Boolean).sort((a, b) => a.v - b.v);
    if (!pts.length) return side === 'left' ? 0.25 : 0.75;
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
  };

  return {
    vTop,
    vBot,
    vSpan,
    boundaryAt,
    outline: ANCHOR_ORDER.map((id) => {
      const a = uvAnchors[id];
      if (!a) return null;
      const left = boundaryAt(a.v, 'left');
      const right = boundaryAt(a.v, 'right');
      const uc = (a.u - left) / Math.max(0.08, right - left);
      const vc = (a.v - vTop) / vSpan;
      return { u: uc, v: vc, id };
    }).filter(Boolean),
  };
}

export function backUvToCanonical(u, v, shape) {
  if (!shape) return { u, v };
  const left = shape.boundaryAt(v, 'left');
  const right = shape.boundaryAt(v, 'right');
  const uc = (u - left) / Math.max(0.08, right - left);
  const vc = (v - shape.vTop) / shape.vSpan;
  return {
    u: Math.max(0, Math.min(1, uc)),
    v: Math.max(0, Math.min(1, vc)),
  };
}

export function canonicalToBackUv(uc, vc, shape) {
  if (!shape) return { u: uc, v: vc };
  const v = shape.vTop + vc * shape.vSpan;
  const left = shape.boundaryAt(v, 'left');
  const right = shape.boundaryAt(v, 'right');
  return { u: left + uc * (right - left), v };
}

/** Signature pose pour repositionnement (épaules + centre torse). */
export function capturePoseSignature(P, frame) {
  const ls = P[LM.L_SHOULDER];
  const rs = P[LM.R_SHOULDER];
  const lh = P[LM.L_HIP];
  const rh = P[LM.R_HIP];
  if (!ls || !rs) return null;
  return {
    shoulderW: Math.hypot(rs.x - ls.x, rs.y - ls.y),
    midX: (ls.x + rs.x) / 2,
    midY: (ls.y + rs.y) / 2,
    hipY: lh && rh ? (lh.y + rh.y) / 2 : frame.origin.y + frame.height * 0.55,
    ex: { ...frame.ex },
    ey: { ...frame.ey },
  };
}

export function comparePoseSignature(live, locked) {
  if (!live || !locked) {
    return {
      ok: false, approxOk: false, score: 0,
      hint: 'reposition_shift', status: 'REPOSITION…', pct: 0,
    };
  }

  const scale = live.shoulderW / locked.shoulderW;
  const dx = live.midX - locked.midX;
  const dy = live.midY - locked.midY;
  const lateral = dx * locked.ex.x + dy * locked.ex.y;
  const depth = dx * locked.ey.x + dy * locked.ey.y;
  const w = locked.shoulderW;

  const scaleErr = Math.abs(scale - 1) / 0.35;
  const latErr = Math.abs(lateral) / (0.22 * w);
  const depErr = Math.abs(depth) / (0.18 * w);
  const score = Math.max(0, Math.min(1, 1 - (scaleErr * 0.45 + latErr * 0.35 + depErr * 0.2)));
  const pct = Math.round(score * 100);

  let hint = null;
  let status = `ALIGNEMENT ${pct} %`;
  if (scale < 0.68) { hint = 'reposition_far'; status = 'TROP LOIN'; }
  else if (scale > 1.45) { hint = 'reposition_close'; status = 'TROP PRÈS'; }
  else if (lateral < -0.2 * w) { hint = 'reposition_left'; status = '→ DROITE'; }
  else if (lateral > 0.2 * w) { hint = 'reposition_right'; status = '→ GAUCHE'; }
  else if (depth < -0.16 * w) { hint = 'reposition_back'; status = 'RECULE UN PEU'; }
  else if (depth > 0.16 * w) { hint = 'reposition_forward'; status = 'AVANCE UN PEU'; }

  const approxOk = score >= 0.42;
  const ok = score >= 0.55;

  return {
    ok,
    approxOk,
    score,
    hint,
    status,
    pct: pct / 100,
  };
}

/** Entrée coverage quand score stable au-dessus du seuil. */
export function shouldEnterCoverage(score, stableFrames, framesRequired = 15) {
  const next = score > 0.5 ? stableFrames + 1 : 0;
  return { entered: next >= framesRequired, stableFrames: next };
}
