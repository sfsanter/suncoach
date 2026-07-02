/**
 * Modélisation du dos : quadrilatère épaules → hanches en coordonnées
 * relatives au torse (u : gauche→droite de la personne, v : épaules→hanches).
 *
 * La couverture est suivie sur une heatmap fine (HEAT_W × HEAT_H pixels) :
 * chaque pixel doit recevoir assez de temps de présence de la paume pour être
 * considéré couvert. Les 4×3 zones servent au guidage vocal ; une zone n'est
 * validée que si 75 % de ses pixels sont réellement couverts — plus de
 * validation "par débordement" sur les zones voisines.
 */
import { LM } from './pose.js';

export const ROWS = 4;
export const COLS = 3;

/** Résolution de la heatmap (multiple de COLS/ROWS pour un découpage exact). */
export const HEAT_W = 36;
export const HEAT_H = 48;

/** Secondes de présence cumulée de la paume pour couvrir un pixel. */
const PIXEL_NEED = 0.3;
/** Part de pixels couverts pour valider une zone. */
const ZONE_RATIO = 0.75;
/** Rayon du "pinceau" gaussien, en coordonnées dos (~ taille d'une paume). */
const SIGMA = 0.05;

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

/** Coordonnées dos → pixels (pour dessiner sur la vidéo). */
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
    this.heat = new Float32Array(HEAT_W * HEAT_H);
    // Masque corporel en espace dos (1 = ce pixel est vraiment sur le corps),
    // alimenté par la segmentation MediaPipe. Par défaut tout compte.
    this.bodyMask = new Float32Array(HEAT_W * HEAT_H).fill(1);
    this.need = PIXEL_NEED;
  }

  reset() {
    this.heat.fill(0);
    this.bodyMask.fill(1);
  }

  isBody(i) {
    return this.bodyMask[i] >= 0.5;
  }

  /** Progression 0..1 d'un pixel de la heatmap. */
  pixelFraction(i) {
    return Math.min(1, this.heat[i] / PIXEL_NEED);
  }

  /**
   * hands : [{u,v}] positions des paumes sur le dos ; dt en secondes.
   * Pinceau gaussien étroit : seuls les pixels réellement sous la paume
   * reçoivent de la "peinture".
   */
  update(hands, dt) {
    const reach = 3 * SIGMA;
    for (const h of hands) {
      if (h.u < -0.08 || h.u > 1.08 || h.v < -0.08 || h.v > 1.08) continue;
      const x0 = Math.max(0, Math.floor((h.u - reach) * HEAT_W));
      const x1 = Math.min(HEAT_W - 1, Math.ceil((h.u + reach) * HEAT_W));
      const y0 = Math.max(0, Math.floor((h.v - reach) * HEAT_H));
      const y1 = Math.min(HEAT_H - 1, Math.ceil((h.v + reach) * HEAT_H));
      for (let y = y0; y <= y1; y++) {
        const pv = (y + 0.5) / HEAT_H;
        for (let x = x0; x <= x1; x++) {
          const pu = (x + 0.5) / HEAT_W;
          const du = pu - h.u;
          const dv = pv - h.v;
          const w = Math.exp(-(du * du + dv * dv) / (2 * SIGMA * SIGMA));
          if (w > 0.03) this.heat[y * HEAT_W + x] += dt * w;
        }
      }
    }
  }

  /** Part de pixels du corps couverts (heat >= need) dans une zone. */
  zoneRatio(row, col) {
    const x0 = (col * HEAT_W) / COLS, x1 = ((col + 1) * HEAT_W) / COLS;
    const y0 = (row * HEAT_H) / ROWS, y1 = ((row + 1) * HEAT_H) / ROWS;
    let painted = 0, body = 0, total = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * HEAT_W + x;
        total++;
        if (!this.isBody(i)) continue;
        body++;
        if (this.heat[i] >= PIXEL_NEED) painted++;
      }
    }
    // Zone quasiment hors du corps (coins au-delà des épaules…) : rien à couvrir.
    if (body < total * 0.1) return 1;
    return painted / body;
  }

  /** Progression 0..1 d'une zone (1 quand ZONE_RATIO des pixels sont couverts). */
  fractionOf(row, col) {
    return Math.min(1, this.zoneRatio(row, col) / ZONE_RATIO);
  }

  isCovered(row, col) {
    return this.zoneRatio(row, col) >= ZONE_RATIO;
  }

  get fraction() {
    let sum = 0;
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++) sum += this.fractionOf(r, c);
    return sum / (ROWS * COLS);
  }

  /** Part brute de la surface du dos réellement couverte (pour les stats). */
  get paintedRatio() {
    let painted = 0, body = 0;
    for (let i = 0; i < this.heat.length; i++) {
      if (!this.isBody(i)) continue;
      body++;
      if (this.heat[i] >= PIXEL_NEED) painted++;
    }
    return body ? painted / body : 0;
  }

  get done() {
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++) if (!this.isCovered(r, c)) return false;
    return true;
  }

  /** Prochaine zone à couvrir : de haut en bas (stratégie naturelle). */
  nextTarget() {
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++)
        if (!this.isCovered(r, c)) return { row: r, col: c };
    return null;
  }

  cellCenter(row, col) {
    return { u: (col + 0.5) / COLS, v: (row + 0.5) / ROWS };
  }

  /** Point du corps le moins couvert d'une zone — cible des bips et de la voix. */
  coldestPoint(row, col) {
    const x0 = (col * HEAT_W) / COLS, x1 = ((col + 1) * HEAT_W) / COLS;
    const y0 = (row * HEAT_H) / ROWS, y1 = ((row + 1) * HEAT_H) / ROWS;
    let best = null;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * HEAT_W + x;
        if (!this.isBody(i)) continue;
        const v = this.heat[i];
        if (!best || v < best.v) best = { v, x, y };
      }
    }
    if (!best) return this.cellCenter(row, col);
    return { u: (best.x + 0.5) / HEAT_W, v: (best.y + 0.5) / HEAT_H };
  }

  /** Copie de l'état pour l'écran de fin. */
  snapshot() {
    return {
      w: HEAT_W,
      h: HEAT_H,
      need: PIXEL_NEED,
      data: Float32Array.from(this.heat),
      body: Float32Array.from(this.bodyMask),
    };
  }
}
