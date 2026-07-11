/**
 * Calibrage par GESTE (dos à la caméra, sans viser un point à l'écran).
 * Cascade : poignet pose → paume Holistic → estimation coude.
 * 8 repères dont reins en 7 et 8.
 */
import { LM, contactPointsFromHand, palmFromHand } from './pose.js';
import { toBack, backToPx } from './coverage.js';

export const CALIBRATION_STEP_COUNT = 8;

export const CALIBRATION_STEPS = [
  { id: 'nuque', label: 'NUQUE', side: 'droite', gesture: 'over_shoulder' },
  { id: 'epaule_g', label: 'ÉPAULE G.', side: 'gauche', gesture: 'under_arm_side' },
  { id: 'epaule_d', label: 'ÉPAULE D.', side: 'droite', gesture: 'under_arm_side' },
  { id: 'milieu_g', label: 'MILIEU G.', side: 'gauche', gesture: 'lateral_mid' },
  { id: 'milieu_d', label: 'MILIEU D.', side: 'droite', gesture: 'lateral_mid' },
  { id: 'bas', label: 'BAS DOS', side: 'either', gesture: 'center_low' },
  { id: 'rein_g', label: 'REIN G.', side: 'gauche', gesture: 'lateral_waist' },
  { id: 'rein_d', label: 'REIN D.', side: 'droite', gesture: 'lateral_waist' },
];

const STABLE_MS = 900;
const STABLE_UV_EPS = 0.045;

function vis(p) {
  return p?.visibility ?? 0;
}

function torsoLocal(p, frame) {
  const dx = p.x - frame.origin.x;
  const dy = p.y - frame.origin.y;
  return {
    x: dx * frame.ex.x + dy * frame.ex.y,
    y: dx * frame.ey.x + dy * frame.ey.y,
  };
}

function wristUv(P, frame, wristIdx) {
  const w = P[wristIdx];
  if (!w || vis(w) < 0.32) return null;
  return toBack(w, frame);
}

function holisticUv(track, frame, W, H, side) {
  const hand = side === 'gauche' ? track.leftHand2D : track.rightHand2D;
  if (!hand?.length) return null;
  const px = hand.map((p) => ({
    x: p.x * W,
    y: p.y * H,
    visibility: p.visibility ?? p.presence ?? 0,
  }));
  const palm = palmFromHand(px);
  const pt = palm ?? (px[0] && (px[0].visibility ?? 0) >= 0.35 ? { x: px[0].x, y: px[0].y } : null);
  if (!pt) return null;
  return toBack({ x: pt.x, y: pt.y, visibility: 1 }, frame);
}

/** Estimation nuque depuis coude/poignet droit si poignet seul insuffisant. */
function inferNuqueUv(P, frame) {
  const rs = P[LM.R_SHOULDER];
  const re = P[LM.R_ELBOW];
  const rw = P[LM.R_WRIST];
  const ls = P[LM.L_SHOULDER];
  if (rw && vis(rw) >= 0.32) return toBack(rw, frame);
  if (re && vis(re) >= 0.4 && rs && vis(rs) >= 0.4) {
    const nx = (ls.x + rs.x) / 2;
    const ny = Math.min(re.y, rs.y) - Math.hypot(rs.x - ls.x) * 0.08;
    return toBack({ x: nx, y: ny, visibility: 1 }, frame);
  }
  if (rs && ls && vis(rs) >= 0.45 && vis(ls) >= 0.45) {
    return toBack({
      x: (ls.x + rs.x) / 2,
      y: Math.min(ls.y, rs.y) - Math.hypot(rs.x - ls.x) * 0.12,
      visibility: 1,
    }, frame);
  }
  return null;
}

/** Détecte si le geste attendu est en cours (pose, pas Holistic). */
export function detectCalibrationGesture(stepId, P, frame) {
  if (!P || !frame) return false;

  const ls = P[LM.L_SHOULDER], rs = P[LM.R_SHOULDER];
  const lh = P[LM.L_HIP], rh = P[LM.R_HIP];
  const le = P[LM.L_ELBOW], re = P[LM.R_ELBOW];
  const lw = P[LM.L_WRIST], rw = P[LM.R_WRIST];

  switch (stepId) {
    case 'nuque': {
      if (vis(rs) < 0.4 || vis(re) < 0.35) return false;
      const elbowUp = re.y < rs.y + Math.hypot(rs.x - ls.x) * 0.15;
      const wristUp = !rw || vis(rw) < 0.32 || rw.y < rs.y + Math.hypot(rs.x - ls.x) * 0.22;
      return elbowUp && wristUp;
    }
    case 'epaule_g': {
      if (vis(lw) < 0.32 && vis(le) < 0.35) return false;
      const loc = lw && vis(lw) >= 0.32 ? torsoLocal(lw, frame) : torsoLocal(le, frame);
      return loc.x < -frame.width * 0.18 && loc.y < frame.height * 0.35;
    }
    case 'epaule_d': {
      if (vis(rw) < 0.32 && vis(re) < 0.35) return false;
      const loc = rw && vis(rw) >= 0.32 ? torsoLocal(rw, frame) : torsoLocal(re, frame);
      return loc.x > frame.width * 0.18 && loc.y < frame.height * 0.35;
    }
    case 'milieu_g': {
      if (vis(lw) < 0.32) return false;
      const loc = torsoLocal(lw, frame);
      return loc.x < -frame.width * 0.15 && loc.y > frame.height * 0.22 && loc.y < frame.height * 0.62;
    }
    case 'milieu_d': {
      if (vis(rw) < 0.32) return false;
      const loc = torsoLocal(rw, frame);
      return loc.x > frame.width * 0.15 && loc.y > frame.height * 0.22 && loc.y < frame.height * 0.62;
    }
    case 'bas': {
      const w = (lw && vis(lw) >= 0.32) ? lw : (rw && vis(rw) >= 0.32 ? rw : null);
      if (!w) return false;
      const loc = torsoLocal(w, frame);
      return Math.abs(loc.x) < frame.width * 0.28 && loc.y > frame.height * 0.62;
    }
    case 'rein_g': {
      if (vis(lw) < 0.32) return false;
      const loc = torsoLocal(lw, frame);
      const hipY = lh && rh ? (lh.y + rh.y) / 2 : frame.origin.y + frame.height * 0.55;
      return loc.x < -frame.width * 0.12 && Math.abs(lw.y - hipY) < frame.height * 0.22;
    }
    case 'rein_d': {
      if (vis(rw) < 0.32) return false;
      const loc = torsoLocal(rw, frame);
      const hipY = lh && rh ? (lh.y + rh.y) / 2 : frame.origin.y + frame.height * 0.55;
      return loc.x > frame.width * 0.12 && Math.abs(rw.y - hipY) < frame.height * 0.22;
    }
    default:
      return false;
  }
}

/** Contact UV : cascade poignet → Holistic → inférence. */
export function getCalibrationContact(stepId, track, P, frame, W, H) {
  const step = CALIBRATION_STEPS.find((s) => s.id === stepId);
  if (!step || !P || !frame) return null;

  const side = step.side;
  const wristIdx = side === 'gauche' ? LM.L_WRIST : side === 'droite' ? LM.R_WRIST : null;

  if (stepId === 'nuque') {
    const uv = wristUv(P, frame, LM.R_WRIST)
      ?? holisticUv(track, frame, W, H, 'droite')
      ?? inferNuqueUv(P, frame);
    return uv ? { ...uv, source: 'nuque' } : null;
  }

  if (stepId === 'bas') {
    const lw = wristUv(P, frame, LM.L_WRIST);
    const rw = wristUv(P, frame, LM.R_WRIST);
    const uv = lw ?? rw
      ?? holisticUv(track, frame, W, H, 'gauche')
      ?? holisticUv(track, frame, W, H, 'droite');
    return uv ? { ...uv, source: 'bas' } : null;
  }

  const sideKey = side === 'gauche' ? 'gauche' : 'droite';
  const uv = wristUv(P, frame, wristIdx)
    ?? holisticUv(track, frame, W, H, sideKey);
  return uv ? { ...uv, source: sideKey } : null;
}

/**
 * Évalue l'étape courante : geste + stabilité → repère validé.
 */
export function evaluateCalibrationStep(stepIndex, track, P, frame, W, H, ts, state = {}) {
  const step = CALIBRATION_STEPS[stepIndex];
  if (!step) return { gesture: false, progress: 0, done: false, anchor: null, screen: null };

  const gesture = detectCalibrationGesture(step.id, P, frame);
  const contact = gesture ? getCalibrationContact(step.id, track, P, frame, W, H) : null;

  if (!gesture || !contact) {
    return {
      gesture: false,
      progress: 0,
      done: false,
      anchor: null,
      screen: null,
      stableSince: 0,
    };
  }

  const last = state.lastUv;
  const jumped = last && Math.hypot(contact.u - last.u, contact.v - last.v) > STABLE_UV_EPS * 2.5;
  let stableSince = state.stableSince || 0;
  if (!stableSince || jumped) stableSince = ts;

  const elapsed = ts - stableSince;
  const progress = Math.min(1, elapsed / STABLE_MS);
  const done = elapsed >= STABLE_MS;
  const screen = backToPx(contact.u, contact.v, frame);

  return {
    gesture: true,
    progress,
    done,
    anchor: done ? { u: contact.u, v: contact.v } : null,
    screen,
    stableSince,
    lastUv: { u: contact.u, v: contact.v },
    source: contact.source,
  };
}

export function drawCalibrationAnchors(ctx, anchors, frame) {
  if (!frame) return;
  const order = ['nuque', 'epaule_g', 'milieu_g', 'rein_g', 'bas', 'rein_d', 'milieu_d', 'epaule_d'];
  const pts = order
    .map((id) => anchors[id] && { id, ...backToPx(anchors[id].u, anchors[id].v, frame) })
    .filter(Boolean);
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

/** Indicateur visuel discret (pour spectateur) — pas requis pour valider. */
export function drawCalibrationFeedback(ctx, screen, ts, { gesture = false, progress = 0 } = {}) {
  if (!screen) return;
  ctx.save();
  if (gesture) {
    const r = 16 + progress * 10;
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, r, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(80, 255, 140, ${0.5 + progress * 0.5})`;
    ctx.lineWidth = 3;
    ctx.stroke();
    if (progress > 0) {
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, r + 8, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
      ctx.strokeStyle = 'rgba(120, 255, 180, 0.95)';
      ctx.lineWidth = 4;
      ctx.stroke();
    }
  }
  ctx.restore();
}
