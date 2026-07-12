/**
 * Sources de contact dos : main Holistic, poignet pose, estimation coude.
 * Dos tourné = la main est souvent invisible → il faut plusieurs relais.
 */
import { LM, HM, lmScore, palmFromHand, contactPointsFromHand } from './pose.js';

const MIN_HAND_AVG_STRICT = 0.52;
const MIN_HAND_AVG_LOOSE = 0.38;
const MIN_TIP_LOOSE = 0.38;

/** Main Holistic acceptable (seuils assouplis dos tourné). */
export function credibleBackHand(handNorm, poseWrist, P, W, H) {
  if (!handNorm || handNorm.length < 21) return false;

  const scores = handNorm.map((p) => lmScore(p));
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  const behindBack = !poseWrist || poseWrist.visibility < 0.45;
  const minAvg = behindBack ? MIN_HAND_AVG_LOOSE : MIN_HAND_AVG_STRICT;
  if (avg < minAvg) return false;

  if (!behindBack) {
    for (const idx of [HM.INDEX_TIP, HM.MIDDLE_TIP]) {
      if (lmScore(handNorm[idx]) < 0.48) return false;
    }
  } else if (lmScore(handNorm[HM.WRIST]) < MIN_TIP_LOOSE) {
    return false;
  }

  const ls = P?.[LM.L_SHOULDER];
  const rs = P?.[LM.R_SHOULDER];
  if (!ls || !rs) return false;
  const shoulderW = Math.hypot(rs.x - ls.x, rs.y - ls.y);

  if (poseWrist && poseWrist.visibility >= 0.5) {
    const hw = handNorm[HM.WRIST];
    const dist = Math.hypot(hw.x * W - poseWrist.x, hw.y * H - poseWrist.y);
    if (dist > shoulderW * 0.55) return false;
  }

  const palm = palmFromHand(
    handNorm.map((p) => ({
      x: p.x * W,
      y: p.y * H,
      visibility: lmScore(p),
    }))
  );
  if (!palm) return false;

  const top = Math.min(ls.y, rs.y);
  const bot = Math.max(P[LM.L_HIP]?.y ?? top, P[LM.R_HIP]?.y ?? top);
  // Nuque : la main monte au-dessus des épaules dans l'image.
  if (palm.y < top - shoulderW * 0.38 || palm.y > bot + shoulderW * 0.12) return false;

  return true;
}

/** Poignet pose seul (bras derrière le dos, main invisible). */
export function crediblePoseWrist(wrist, P) {
  if (!wrist || wrist.visibility < 0.48) return false;
  const ls = P[LM.L_SHOULDER];
  const rs = P[LM.R_SHOULDER];
  const lh = P[LM.L_HIP];
  const rh = P[LM.R_HIP];
  if ([ls, rs, lh, rh].some((p) => p.visibility < 0.35)) return false;
  const shoulderW = Math.hypot(rs.x - ls.x, rs.y - ls.y);
  const top = Math.min(ls.y, rs.y) - shoulderW * 0.35;
  const bot = Math.max(lh.y, rh.y) + shoulderW * 0.1;
  const mx = (ls.x + rs.x) / 2;
  if (wrist.y < top || wrist.y > bot) return false;
  if (Math.abs(wrist.x - mx) > shoulderW * 0.72) return false;
  return true;
}

/**
 * Estime le contact sur le dos via coude + épaule quand la main n'est pas visible.
 */
export function elbowBackContact(P, side) {
  const isLeft = side === 'gauche';
  const sh = P[isLeft ? LM.L_SHOULDER : LM.R_SHOULDER];
  const el = P[isLeft ? LM.L_ELBOW : LM.R_ELBOW];
  const wr = P[isLeft ? LM.L_WRIST : LM.R_WRIST];
  if (!sh || !el || sh.visibility < 0.42 || el.visibility < 0.42) return null;

  if (wr && wr.visibility >= 0.48 && crediblePoseWrist(wr, P)) {
    return { x: wr.x, y: wr.y, visibility: wr.visibility };
  }

  const ls = P[LM.L_SHOULDER];
  const rs = P[LM.R_SHOULDER];
  const midX = (ls.x + rs.x) / 2;
  const midY = (ls.y + rs.y) / 2;
  const shoulderW = Math.hypot(rs.x - ls.x, rs.y - ls.y);

  const fx = el.x - sh.x;
  const fy = el.y - sh.y;
  const fl = Math.hypot(fx, fy) || 1;
  const towardSpine = midX - el.x;

  return {
    x: el.x + (fx / fl) * shoulderW * 0.35 + towardSpine * 0.45,
    y: el.y + (fy / fl) * shoulderW * 0.2 + (midY - el.y) * 0.08,
    visibility: Math.min(sh.visibility, el.visibility),
  };
}

/** Score confiance continu 0–1 pour mode dégradé. */
export function handConfidence(handLandmarks, poseLandmarks, wristIdx, elbowIdx) {
  const wristVis = poseLandmarks?.[wristIdx]?.visibility ?? 0;
  const elbowVis = poseLandmarks?.[elbowIdx]?.visibility ?? 0;
  if (handLandmarks?.length >= 21) {
    const avg = handLandmarks.reduce((s, l) => s + (l.visibility ?? l.presence ?? 0), 0) / handLandmarks.length;
    return avg;
  }
  return wristVis * 0.6 + elbowVis * 0.4;
}

const CONF_HIGH = 0.6;
const CONF_LOW = 0.35;

export function updateCoachMode(confidence, currentMode) {
  if (currentMode === 'precise' && confidence < CONF_LOW) return 'degraded';
  if (currentMode === 'degraded' && confidence > CONF_HIGH) return 'precise';
  return currentMode;
}

/** Ramène les points contact d'une main (coords normalisées 0–1). */
export function handContactPixels(handNorm, W, H) {
  if (!handNorm?.length) return [];
  return contactPointsFromHand(
    handNorm.map((p) => ({
      x: p.x * W,
      y: p.y * H,
      visibility: lmScore(p),
    }))
  );
}

/** Lisse les sauts brusques sans tout bloquer. */
export class ContactVelocityGate {
  constructor(maxJump = 0.22) {
    this.maxJump = maxJump;
    this.prev = { gauche: null, droite: null };
  }

  reset() {
    this.prev = { gauche: null, droite: null };
  }

  clamp(name, u, v) {
    const p = this.prev[name];
    if (!p) {
      this.prev[name] = { u, v };
      return { u, v };
    }
    const du = u - p.u;
    const dv = v - p.v;
    const d = Math.hypot(du, dv);
    if (d > this.maxJump) {
      const t = this.maxJump / d;
      u = p.u + du * t;
      v = p.v + dv * t;
    }
    this.prev[name] = { u, v };
    return { u, v };
  }
}
