/**
 * Modélisation du dos en coordonnées torse (u : gauche→droite de la personne,
 * v : épaules→hanches). La couverture est suivie sur une heatmap fine
 * (HEAT_W × HEAT_H), limitée à une silhouette de dos dessinée (déterministe,
 * contrairement à la segmentation vidéo qui était trop bruitée).
 */
import { LM } from './pose.js';

export const ROWS = 4;
export const COLS = 3;

/** Résolution de la heatmap (multiple de COLS/ROWS pour un découpage exact). */
export const HEAT_W = 36;
export const HEAT_H = 48;

/** Secondes de présence cumulée de la paume pour couvrir un pixel. */
const PIXEL_NEED = 0.25;
/** Part de pixels couverts pour valider une zone. */
const ZONE_RATIO = 0.7;
/** Rayon du "pinceau" gaussien, en coordonnées dos (~ taille d'une paume). */
const SIGMA = 0.055;

const ROW_NAMES = ['le haut du dos', 'les omoplates', 'le milieu du dos', 'le bas du dos'];

export function zoneName(row, col) {
  if (row === 1 && col === 1) return 'entre les omoplates';
  const side = col === 0 ? ', côté gauche' : col === 2 ? ', côté droit' : '';
  return ROW_NAMES[row] + side;
}

/* ------------------------------------------------------------------ *
 * Silhouette du dos : profil de demi-largeur en fonction de v.
 * Sert à la fois de masque de validation et de dessin dans l'UI.
 * ------------------------------------------------------------------ */

const SHAPE_KNOTS = [
  // [v, demi-largeur]
  [0.00, 0.42], // ligne des épaules (épaules arrondies via le cap plus bas)
  [0.06, 0.50], // deltoïdes, point le plus large
  [0.22, 0.45],
  [0.50, 0.36], // taille
  [0.78, 0.42],
  [0.92, 0.46], // hanches
  [1.00, 0.43],
];

/** Demi-largeur du dos à la hauteur v (interpolation linéaire entre nœuds). */
export function backHalfWidth(v) {
  if (v <= SHAPE_KNOTS[0][0]) return SHAPE_KNOTS[0][1];
  for (let i = 1; i < SHAPE_KNOTS.length; i++) {
    const [v1, w1] = SHAPE_KNOTS[i];
    const [v0, w0] = SHAPE_KNOTS[i - 1];
    if (v <= v1) return w0 + ((v - v0) / (v1 - v0)) * (w1 - w0);
  }
  return SHAPE_KNOTS[SHAPE_KNOTS.length - 1][1];
}

export function insideBackShape(u, v) {
  if (v < 0 || v > 1) return false;
  let hw = backHalfWidth(v);
  // Épaules arrondies : on rabote les coins supérieurs.
  if (v < 0.06) {
    const t = v / 0.06;
    hw = Math.min(hw, 0.42 + t * 0.1);
  }
  return Math.abs(u - 0.5) <= hw;
}

/** Masque précalculé sur la grille heatmap. */
const SHAPE_MASK = (() => {
  const m = new Uint8Array(HEAT_W * HEAT_H);
  for (let y = 0; y < HEAT_H; y++) {
    for (let x = 0; x < HEAT_W; x++) {
      m[y * HEAT_W + x] = insideBackShape((x + 0.5) / HEAT_W, (y + 0.5) / HEAT_H) ? 1 : 0;
    }
  }
  return m;
})();

/* ------------------------------------------------------------------ *
 * Repère torse 2D (pixels image) — pour l'overlay vidéo.
 * ------------------------------------------------------------------ */

export function torsoFrame(P) {
  const ls = P[LM.L_SHOULDER], rs = P[LM.R_SHOULDER];
  const lh = P[LM.L_HIP], rh = P[LM.R_HIP];
  if ([ls, rs, lh, rh].some((p) => p.visibility < 0.4)) return null;

  const origin = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
  const hipMid = { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 };

  let ex = { x: rs.x - ls.x, y: rs.y - ls.y }; // gauche → droite de la personne (vue de dos)
  const width = Math.hypot(ex.x, ex.y) * 1.1;
  let ey = { x: hipMid.x - origin.x, y: hipMid.y - origin.y };
  const height = Math.hypot(ey.x, ey.y) * 1.08;
  if (width < 1 || height < 1) return null;

  ex = { x: ex.x / Math.hypot(ex.x, ex.y), y: ex.y / Math.hypot(ex.x, ex.y) };
  ey = { x: ey.x / Math.hypot(ey.x, ey.y), y: ey.y / Math.hypot(ey.x, ey.y) };

  return { origin, ex, ey, width, height };
}

export function toBack(p, f) {
  const dx = p.x - f.origin.x;
  const dy = p.y - f.origin.y;
  return {
    u: (dx * f.ex.x + dy * f.ex.y) / f.width + 0.5,
    v: (dx * f.ey.x + dy * f.ey.y) / f.height,
  };
}

export function backToPx(u, v, f) {
  const du = (u - 0.5) * f.width;
  const dv = v * f.height;
  return {
    x: f.origin.x + f.ex.x * du + f.ey.x * dv,
    y: f.origin.y + f.ex.y * du + f.ey.y * dv,
  };
}

/* ------------------------------------------------------------------ *
 * Repère torse 3D (world landmarks, mètres) — pour la peinture.
 * Invariant à la rotation : le repère tourne avec le corps, et la
 * coordonnée w (distance au plan du dos) permet de ne peindre que
 * quand la paume touche vraiment le dos.
 * ------------------------------------------------------------------ */

const v3 = {
  sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }),
  mid: (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 }),
  dot: (a, b) => a.x * b.x + a.y * b.y + a.z * b.z,
  cross: (a, b) => ({
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  }),
  len: (a) => Math.hypot(a.x, a.y, a.z),
  norm: (a) => {
    const l = Math.hypot(a.x, a.y, a.z) || 1;
    return { x: a.x / l, y: a.y / l, z: a.z / l };
  },
};

export function torsoFrame3D(W) {
  const ls = W[LM.L_SHOULDER], rs = W[LM.R_SHOULDER];
  const lh = W[LM.L_HIP], rh = W[LM.R_HIP];
  if ([ls, rs, lh, rh].some((p) => p.visibility < 0.4)) return null;

  const origin = v3.mid(ls, rs);
  const hipMid = v3.mid(lh, rh);
  const shoulderVec = v3.sub(rs, ls);
  const downVec = v3.sub(hipMid, origin);

  const width = v3.len(shoulderVec) * 1.15;
  const height = v3.len(downVec) * 1.08;
  if (width < 0.05 || height < 0.05) return null;

  const ex = v3.norm(shoulderVec); // gauche → droite de la personne
  const ey = v3.norm(downVec); // épaules → hanches
  const ez = v3.norm(v3.cross(ex, ey)); // normale au plan du dos

  return { origin, ex, ey, ez, width, height };
}

/** Point 3D → (u, v, w) : position sur le dos + distance au plan (mètres). */
export function toBack3D(p, f) {
  const d = v3.sub(p, f.origin);
  return {
    u: v3.dot(d, f.ex) / f.width + 0.5,
    v: v3.dot(d, f.ey) / f.height,
    w: v3.dot(d, f.ez),
  };
}

/* ------------------------------------------------------------------ *
 * Grille de couverture.
 * ------------------------------------------------------------------ */

export class CoverageGrid {
  constructor() {
    this.heat = new Float32Array(HEAT_W * HEAT_H);
    this.need = PIXEL_NEED;
  }

  reset() {
    this.heat.fill(0);
  }

  isBody(i) {
    return SHAPE_MASK[i] === 1;
  }

  pixelFraction(i) {
    return Math.min(1, this.heat[i] / PIXEL_NEED);
  }

  /**
   * hands : [{u,v}] positions des paumes sur le dos ; dt en secondes.
   * Renvoie l'activité de peinture pour le feedback sonore :
   *   added   — quantité de peinture déposée sur des pixels non finis
   *   crossed — nombre de pixels qui viennent d'être validés
   */
  update(hands, dt) {
    const reach = 3 * SIGMA;
    let added = 0, crossed = 0;
    for (const h of hands) {
      if (h.u < -0.08 || h.u > 1.08 || h.v < -0.08 || h.v > 1.08) continue;
      const x0 = Math.max(0, Math.floor((h.u - reach) * HEAT_W));
      const x1 = Math.min(HEAT_W - 1, Math.ceil((h.u + reach) * HEAT_W));
      const y0 = Math.max(0, Math.floor((h.v - reach) * HEAT_H));
      const y1 = Math.min(HEAT_H - 1, Math.ceil((h.v + reach) * HEAT_H));
      for (let y = y0; y <= y1; y++) {
        const pv = (y + 0.5) / HEAT_H;
        for (let x = x0; x <= x1; x++) {
          const i = y * HEAT_W + x;
          if (SHAPE_MASK[i] === 0) continue;
          const pu = (x + 0.5) / HEAT_W;
          const du = pu - h.u;
          const dv = pv - h.v;
          const wgt = Math.exp(-(du * du + dv * dv) / (2 * SIGMA * SIGMA));
          if (wgt <= 0.03) continue;
          const before = this.heat[i];
          if (before < PIXEL_NEED) {
            this.heat[i] = before + dt * wgt;
            added += dt * wgt;
            if (this.heat[i] >= PIXEL_NEED) crossed++;
          }
        }
      }
    }
    return { added, crossed };
  }

  /** Part de pixels du dos couverts (heat >= need) dans une zone. */
  zoneRatio(row, col) {
    const x0 = (col * HEAT_W) / COLS, x1 = ((col + 1) * HEAT_W) / COLS;
    const y0 = (row * HEAT_H) / ROWS, y1 = ((row + 1) * HEAT_H) / ROWS;
    let painted = 0, body = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * HEAT_W + x;
        if (SHAPE_MASK[i] === 0) continue;
        body++;
        if (this.heat[i] >= PIXEL_NEED) painted++;
      }
    }
    if (body === 0) return 1;
    return painted / body;
  }

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
      if (SHAPE_MASK[i] === 0) continue;
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

  /** Point du dos le moins couvert d'une zone — cible de la voix. */
  coldestPoint(row, col) {
    const x0 = (col * HEAT_W) / COLS, x1 = ((col + 1) * HEAT_W) / COLS;
    const y0 = (row * HEAT_H) / ROWS, y1 = ((row + 1) * HEAT_H) / ROWS;
    let best = null;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * HEAT_W + x;
        if (SHAPE_MASK[i] === 0) continue;
        const val = this.heat[i];
        if (!best || val < best.val) best = { val, x, y };
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
      body: Uint8Array.from(SHAPE_MASK),
    };
  }
}
