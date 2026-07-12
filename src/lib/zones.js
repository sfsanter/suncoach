/**
 * Zones anatomiques du dos — 7 régions nommées cliniquement.
 */

export const ANATOMICAL_ZONES = [
  {
    id: 'nuque',
    name: 'nuque et trapèzes',
    short: 'NUQUE',
    u0: 0.25, v0: 0.0, u1: 0.75, v1: 0.20,
    hand: 'alternance',
  },
  {
    id: 'omoplate_g',
    name: 'omoplate gauche',
    short: 'OMOPL. G.',
    u0: 0.0, v0: 0.10, u1: 0.44, v1: 0.42,
    hand: 'gauche',
  },
  {
    id: 'omoplate_d',
    name: 'omoplate droite',
    short: 'OMOPL. D.',
    u0: 0.56, v0: 0.10, u1: 1.0, v1: 0.42,
    hand: 'droite',
  },
  {
    id: 'colonne',
    name: 'milieu de la colonne',
    short: 'COLONNE',
    u0: 0.34, v0: 0.28, u1: 0.66, v1: 0.55,
    hand: 'alternance',
  },
  {
    id: 'rein_g',
    name: 'rein gauche',
    short: 'REIN G.',
    u0: 0.0, v0: 0.48, u1: 0.44, v1: 0.70,
    hand: 'gauche',
  },
  {
    id: 'rein_d',
    name: 'rein droit',
    short: 'REIN D.',
    u0: 0.56, v0: 0.48, u1: 1.0, v1: 0.70,
    hand: 'droite',
  },
  {
    id: 'bas',
    name: 'bas du dos',
    short: 'BAS',
    u0: 0.22, v0: 0.68, u1: 0.78, v1: 1.0,
    hand: 'alternance',
  },
];

export const ZONE_COUNT = ANATOMICAL_ZONES.length;

/** Contour de la zone (clip arrondi) pour surbrillance sur la minimap. */
export function strokeZoneOutline(ctx, zone, toX, toY, color, lineWidth = 2) {
  const x = toX(zone.u0);
  const y = toY(zone.v0);
  const w = toX(zone.u1) - x;
  const h = toY(zone.v1) - y;
  const r = Math.min(6, w * 0.12, h * 0.12);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.stroke();
}
