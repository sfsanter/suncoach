/**
 * Calibrage manuel du dos : 8 repères à la main (dont rein G/D en 7 et 8).
 * Cible orange pulsante ; repères validés = position réelle de la main.
 */
import { backToPx } from './coverage.js';

export const CALIBRATION_STEP_COUNT = 8;

export const CALIBRATION_STEPS = [
  { id: 'nuque', label: 'NUQUE', nominal: { u: 0.5, v: 0.05 } },
  { id: 'epaule_g', label: 'ÉPAULE G.', nominal: { u: 0.1, v: 0.14 } },
  { id: 'epaule_d', label: 'ÉPAULE D.', nominal: { u: 0.9, v: 0.14 } },
  { id: 'milieu_g', label: 'MILIEU G.', nominal: { u: 0.08, v: 0.4 } },
  { id: 'milieu_d', label: 'MILIEU D.', nominal: { u: 0.92, v: 0.4 } },
  { id: 'bas', label: 'BAS DOS', nominal: { u: 0.5, v: 0.9 } },
  { id: 'rein_g', label: 'REIN G.', nominal: { u: 0.07, v: 0.58 } },
  { id: 'rein_d', label: 'REIN D.', nominal: { u: 0.93, v: 0.58 } },
];

const STABLE_MS = 850;
const HIT_RADIUS = 0.13;

/** UV cible : générique au début, puis relative aux repères déjà posés. */
export function getCalibrationTargetUV(stepIndex, anchors) {
  const step = CALIBRATION_STEPS[stepIndex];
  if (!step) return { u: 0.5, v: 0.5 };
  const a = anchors;
  const n = a.nuque;
  const eg = a.epaule_g;
  const ed = a.epaule_d;

  switch (step.id) {
    case 'nuque':
      return { ...step.nominal };
    case 'epaule_g':
      if (n) return { u: Math.max(0.02, n.u - 0.38), v: n.v + 0.05 };
      return { ...step.nominal };
    case 'epaule_d':
      if (n) return { u: Math.min(0.98, n.u + 0.38), v: n.v + 0.05 };
      return { ...step.nominal };
    case 'milieu_g':
      if (eg) return { u: eg.u, v: (eg.v + (a.bas?.v ?? 0.75)) * 0.52 };
      if (n) return { u: Math.max(0.02, n.u - 0.4), v: 0.42 };
      return { ...step.nominal };
    case 'milieu_d':
      if (ed) return { u: ed.u, v: (ed.v + (a.bas?.v ?? 0.75)) * 0.52 };
      if (n) return { u: Math.min(0.98, n.u + 0.4), v: 0.42 };
      return { ...step.nominal };
    case 'bas':
      if (a.milieu_g && a.milieu_d) {
        return { u: (a.milieu_g.u + a.milieu_d.u) / 2, v: 0.88 };
      }
      return { ...step.nominal };
    case 'rein_g':
      if (a.milieu_g) return { u: a.milieu_g.u, v: 0.56 };
      if (eg) return { u: eg.u, v: 0.56 };
      return { ...step.nominal };
    case 'rein_d':
      if (a.milieu_d) return { u: a.milieu_d.u, v: 0.56 };
      if (ed) return { u: ed.u, v: 0.56 };
      return { ...step.nominal };
    default:
      return { ...step.nominal };
  }
}

export function targetScreenPos(uv, frame) {
  if (!frame) return null;
  return backToPx(uv.u, uv.v, frame);
}

export function handNearTarget(handUv, targetUv, radius = HIT_RADIUS) {
  if (!handUv || !targetUv) return false;
  return Math.hypot(handUv.u - targetUv.u, handUv.v - targetUv.v) <= radius;
}

/**
 * Suit la stabilisation de la main près de la cible.
 * @returns {{ done: boolean, progress: number, anchor: {u,v}|null }}
 */
export function trackCalibrationHold(handUv, targetUv, ts, state) {
  if (!handUv || !handNearTarget(handUv, targetUv)) {
    return { done: false, progress: 0, anchor: null, stableSince: 0 };
  }
  const since = state.stableSince || ts;
  const elapsed = ts - since;
  const progress = Math.min(1, elapsed / STABLE_MS);
  if (elapsed >= STABLE_MS) {
    return { done: true, progress: 1, anchor: { u: handUv.u, v: handUv.v }, stableSince: since };
  }
  return { done: false, progress, anchor: null, stableSince: since };
}

export function drawCalibrationTarget(ctx, x, y, ts, { near = false, progress = 0 } = {}) {
  const pulse = 0.7 + 0.3 * Math.sin(ts / 260);
  const baseR = near ? 30 : 24;
  const r = baseR * pulse;

  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r + 6, 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(255, 120, 0, ${0.25 + 0.2 * pulse})`;
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = near
    ? `rgba(255, 160, 30, ${0.45 + 0.25 * pulse})`
    : `rgba(255, 100, 0, ${0.35 + 0.3 * pulse})`;
  ctx.fill();
  ctx.strokeStyle = near ? 'rgba(255, 200, 80, 0.95)' : 'rgba(255, 140, 0, 0.9)';
  ctx.lineWidth = near ? 3 : 2;
  ctx.stroke();

  if (progress > 0) {
    ctx.beginPath();
    ctx.arc(x, y, r + 10, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
    ctx.strokeStyle = 'rgba(80, 255, 120, 0.95)';
    ctx.lineWidth = 4;
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.arc(x, y, 4, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.restore();
}

export function drawCalibrationAnchors(ctx, anchors, frame) {
  if (!frame) return;
  const order = ['nuque', 'epaule_g', 'milieu_g', 'rein_g', 'bas', 'rein_d', 'milieu_d', 'epaule_d'];
  const pts = order.map((id) => anchors[id] && { id, ...targetScreenPos(anchors[id], frame) }).filter(Boolean);
  if (pts.length < 2) return;

  ctx.save();
  ctx.strokeStyle = 'rgba(80, 255, 120, 0.75)';
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);

  for (const p of pts) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(40, 255, 100, 0.85)';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  ctx.restore();
}
