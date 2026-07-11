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
  if (!live || !locked) return { ok: false, hint: 'reposition_shift', status: 'REPOSITION…' };

  const scale = live.shoulderW / locked.shoulderW;
  const dx = live.midX - locked.midX;
  const dy = live.midY - locked.midY;
  const lateral = dx * locked.ex.x + dy * locked.ex.y;
  const depth = dx * locked.ey.x + dy * locked.ey.y;
  const w = locked.shoulderW;

  if (scale < 0.84) {
    return { ok: false, hint: 'reposition_far', status: 'TROP LOIN — APPROCHE-TOI' };
  }
  if (scale > 1.18) {
    return { ok: false, hint: 'reposition_close', status: 'TROP PRÈS — RECULE' };
  }
  if (lateral < -0.1 * w) {
    return { ok: false, hint: 'reposition_left', status: 'DÉCALE-TOI À DROITE' };
  }
  if (lateral > 0.1 * w) {
    return { ok: false, hint: 'reposition_right', status: 'DÉCALE-TOI À GAUCHE' };
  }
  if (depth < -0.08 * w) {
    return { ok: false, hint: 'reposition_back', status: 'RECULE UN PEU' };
  }
  if (depth > 0.08 * w) {
    return { ok: false, hint: 'reposition_forward', status: 'AVANCE UN PEU' };
  }

  const pct = Math.round(
    (1 - Math.min(1, (Math.abs(scale - 1) / 0.18 + Math.abs(lateral) / (0.12 * w)) / 2)) * 100
  );
  return { ok: true, hint: null, status: `POSITION ${pct} %`, pct: pct / 100 };
}
