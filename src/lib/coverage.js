/**
 * Modélisation du dos : quadrilatère épaules → hanches en coordonnées
 * relatives au torse (u : gauche→droite de la personne, v : épaules→hanches),
 * découpé en grille. Robuste aux déplacements puisque la grille suit le corps.
 */
import { LM } from './pose.js';

export const ROWS = 4;
export const COLS = 3;

/** Secondes de présence cumulée de la main pour valider une zone. */
const PAINT_NEEDED = 1.0;
/** Rayon du "pinceau" gaussien autour de la main, en unités de cellule. */
const BRUSH_SIGMA = 0.75;

const ROW_NAMES = ['le haut du dos', 'les omoplates', 'le milieu du dos', 'le bas du dos'];

export function zoneName(row, col) {
  if (row === 1 && col === 1) return 'entre les omoplates';
  const side = col === 0 ? ', côté gauche' : col === 2 ? ', côté droit' : '';
  return ROW_NAMES[row] + side;
}

/**
 * Repère du torse à partir des landmarks en pixels.
 * Renvoie null si épaules/hanches pas assez visibles.
 */
export function torsoFrame(P) {
  const ls = P[LM.L_SHOULDER], rs = P[LM.R_SHOULDER];
  const lh = P[LM.L_HIP], rh = P[LM.R_HIP];
  if ([ls, rs, lh, rh].some((p) => p.visibility < 0.4)) return null;

  const origin = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
  const hipMid = { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 };

  let ex = { x: rs.x - ls.x, y: rs.y - ls.y }; // gauche → droite de la personne (vue de dos)
  const width = Math.hypot(ex.x, ex.y) * 1.1; // le dos déborde un peu des épaules
  let ey = { x: hipMid.x - origin.x, y: hipMid.y - origin.y }; // épaules → hanches
  const height = Math.hypot(ey.x, ey.y) * 1.08; // jusqu'au creux des reins
  if (width < 1 || height < 1) return null;

  ex = { x: ex.x / Math.hypot(ex.x, ex.y), y: ex.y / Math.hypot(ex.x, ex.y) };
  ey = { x: ey.x / Math.hypot(ey.x, ey.y), y: ey.y / Math.hypot(ey.x, ey.y) };

  return { origin, ex, ey, width, height };
}

/** Pixels → coordonnées dos (u,v), u et v dans [0,1] sur la zone à couvrir. */
export function toBack(p, f) {
  const dx = p.x - f.origin.x;
  const dy = p.y - f.origin.y;
  return {
    u: (dx * f.ex.x + dy * f.ex.y) / f.width + 0.5,
    v: (dx * f.ey.x + dy * f.ey.y) / f.height,
  };
}

/** Coordonnées dos → pixels (pour dessiner la grille sur la vidéo). */
export function backToPx(u, v, f) {
  const du = (u - 0.5) * f.width;
  const dv = v * f.height;
  return {
    x: f.origin.x + f.ex.x * du + f.ey.x * dv,
    y: f.origin.y + f.ex.y * du + f.ey.y * dv,
  };
}

export class CoverageGrid {
  constructor() {
    this.paint = new Float32Array(ROWS * COLS);
  }

  cellCenter(row, col) {
    return { u: (col + 0.5) / COLS, v: (row + 0.5) / ROWS };
  }

  fractionOf(row, col) {
    return Math.min(1, this.paint[row * COLS + col] / PAINT_NEEDED);
  }

  isCovered(row, col) {
    return this.fractionOf(row, col) >= 1;
  }

  get fraction() {
    let sum = 0;
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++) sum += this.fractionOf(r, c);
    return sum / (ROWS * COLS);
  }

  get done() {
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++) if (!this.isCovered(r, c)) return false;
    return true;
  }

  /**
   * hands : [{u,v}] positions des mains sur le dos ; dt en secondes.
   * Pinceau gaussien : la cellule sous la main se remplit vite,
   * les voisines un peu ; il faut vraiment frotter pour valider.
   */
  update(hands, dt) {
    for (const h of hands) {
      // La main doit être sur le dos (avec une petite marge).
      if (h.u < -0.12 || h.u > 1.12 || h.v < -0.12 || h.v > 1.12) continue;
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const center = this.cellCenter(r, c);
          const du = (h.u - center.u) * COLS; // distances en unités de cellule
          const dv = (h.v - center.v) * ROWS;
          const d2 = du * du + dv * dv;
          const w = Math.exp(-d2 / (2 * BRUSH_SIGMA * BRUSH_SIGMA));
          if (w > 0.05) this.paint[r * COLS + c] += dt * w;
        }
      }
    }
  }

  /** Prochaine zone à couvrir : de haut en bas (stratégie naturelle). */
  nextTarget() {
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++)
        if (!this.isCovered(r, c)) return { row: r, col: c };
    return null;
  }

  reset() {
    this.paint.fill(0);
  }
}
