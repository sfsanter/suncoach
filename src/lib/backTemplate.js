/**
 * Repère dorsal figé au scan IA : les mains sont projetées dans cet espace
 * (comme sur une photo figée), pas sur le torse live qui bouge.
 */

/** Point image → coordonnées normalisées torse (lx, ly). */
function toLocal(p, f) {
  const dx = p.x - f.origin.x;
  const dy = p.y - f.origin.y;
  return {
    lx: (dx * f.ex.x + dy * f.ex.y) / f.width,
    ly: (dx * f.ey.x + dy * f.ey.y) / f.height,
  };
}

/** Coordonnées normalisées torse → point image. */
function fromLocal(lx, ly, f) {
  return {
    x: f.origin.x + f.ex.x * lx * f.width + f.ey.x * ly * f.height,
    y: f.origin.y + f.ex.y * lx * f.width + f.ey.y * ly * f.height,
    visibility: 1,
  };
}

/** Ramène un point détecté live dans l'espace du scan figé. */
export function warpToLocked(p, liveFrame, lockedFrame) {
  if (!p || !liveFrame || !lockedFrame) return p;
  const { lx, ly } = toLocal(p, liveFrame);
  return fromLocal(lx, ly, lockedFrame);
}

/** Projeté un point du scan figé dans l'image live (accroche dos B). */
export function warpToLive(p, lockedFrame, liveFrame) {
  if (!p || !liveFrame || !lockedFrame) return p;
  const { lx, ly } = toLocal(p, lockedFrame);
  return fromLocal(lx, ly, liveFrame);
}

export function cloneFrame(f) {
  if (!f) return null;
  return {
    origin: { ...f.origin },
    ex: { ...f.ex },
    ey: { ...f.ey },
    width: f.width,
    height: f.height,
  };
}
