/**
 * Détection « dos immobile » (labo) — pose MediaPipe, pas tracking couleur.
 * Sert à pause auto + inviter à tracer les 8 points.
 */
import { torsoMetrics } from './torsoAffine.js';

/** Durée minimale d’immobilité (ms). */
export const STILL_DURATION_MS = 1600;
/** Mouvement max acceptable = fraction de la largeur d’épaules. */
export const STILL_MOTION_FRAC = 0.028;

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Score de mouvement entre deux nuages torse (0 = identique).
 * Normalisé par largeur d’épaules live.
 * @returns {number} fraction (ex. 0.02 = 2 % épaule)
 */
export function torsoMotionFrac(prevCloud, nextCloud) {
  if (!prevCloud || !nextCloud || prevCloud.length < 4 || nextCloud.length < 4) {
    return Infinity;
  }
  const m = torsoMetrics(nextCloud);
  const scale = m?.shoulderW || 1;
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    sum += dist(prevCloud[i], nextCloud[i]);
  }
  return (sum / 4) / scale;
}

/**
 * Accumule la stabilité ; retourne true quand seuil durée atteint.
 * @param {{ lastCloud: any, stillSince: number|null, fired: boolean }} state
 * @param {any} liveCloud
 * @param {number} nowMs
 */
export function updateStandStill(state, liveCloud, nowMs, opts = {}) {
  const duration = opts.durationMs ?? STILL_DURATION_MS;
  const maxMotion = opts.maxMotionFrac ?? STILL_MOTION_FRAC;

  if (!liveCloud) {
    state.lastCloud = null;
    state.stillSince = null;
    return { stable: false, progress: 0, justFired: false };
  }

  const motion = torsoMotionFrac(state.lastCloud, liveCloud);
  state.lastCloud = liveCloud.map((p) => ({ x: p.x, y: p.y }));

  if (!Number.isFinite(motion) || motion > maxMotion) {
    state.stillSince = null;
    // Si ça bouge fort après un fire, permettre un nouveau cycle
    if (motion > maxMotion * 2.5) state.fired = false;
    return { stable: false, progress: 0, justFired: false };
  }

  if (state.stillSince == null) state.stillSince = nowMs;
  const elapsed = nowMs - state.stillSince;
  const progress = Math.min(1, elapsed / duration);

  if (elapsed >= duration && !state.fired) {
    state.fired = true;
    return { stable: true, progress: 1, justFired: true };
  }

  return {
    stable: elapsed >= duration,
    progress,
    justFired: false,
  };
}
