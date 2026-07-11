/**
 * Filtre anti-hallucination : Holistic invente souvent des mains quand elles
 * sont derrière le dos. On n'accepte que les contacts crédibles.
 */
import { LM, HM, lmScore, palmFromHand } from './pose.js';

const MIN_HAND_AVG = 0.58;
const MIN_TIP = 0.62;

/** Main Holistic crédible pour peindre sur le dos. */
export function credibleBackHand(handNorm, poseWrist, P, W, H) {
  if (!handNorm || handNorm.length < 21) return false;

  const scores = handNorm.map((p) => lmScore(p));
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  if (avg < MIN_HAND_AVG) return false;

  for (const idx of [HM.INDEX_TIP, HM.MIDDLE_TIP, HM.PINKY_TIP]) {
    if (lmScore(handNorm[idx]) < MIN_TIP) return false;
  }

  const ls = P?.[LM.L_SHOULDER];
  const rs = P?.[LM.R_SHOULDER];
  if (!ls || !rs) return false;
  const shoulderW = Math.hypot(rs.x - ls.x, rs.y - ls.y);

  const hw = handNorm[HM.WRIST];
  const hx = hw.x * W;
  const hy = hw.y * H;

  if (poseWrist && poseWrist.visibility >= 0.5) {
    const dist = Math.hypot(hx - poseWrist.x, hy - poseWrist.y);
    if (dist > shoulderW * 0.42) return false;
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
  if (palm.y < top - shoulderW * 0.12 || palm.y > bot + shoulderW * 0.08) return false;

  return true;
}

/** Rejette les sauts impossibles entre deux frames (hallucination). */
export class ContactVelocityGate {
  constructor(maxJump = 0.12) {
    this.maxJump = maxJump;
    this.prev = { gauche: null, droite: null };
  }

  reset() {
    this.prev = { gauche: null, droite: null };
  }

  allow(name, u, v) {
    const p = this.prev[name];
    if (!p) {
      this.prev[name] = { u, v };
      return true;
    }
    const d = Math.hypot(u - p.u, v - p.v);
    if (d > this.maxJump) return false;
    this.prev[name] = { u, v };
    return true;
  }
}
