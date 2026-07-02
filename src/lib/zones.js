/**
 * Zones anatomiques du dos + dessin de gestes animés sur la minimap.
 * Remplace la grille 4×3 par 7 régions nommées cliniquement.
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

export function zoneById(id) {
  return ANATOMICAL_ZONES.find((z) => z.id === id);
}

export function zoneCenter(z) {
  return { u: (z.u0 + z.u1) / 2, v: (z.v0 + z.v1) / 2 };
}

/**
 * Dessine un pictogramme de geste animé (bras simplifié) dans la zone cible
 * de la minimap. phase ∈ [0,1] boucle via sin().
 */
export function drawZoneGesture(ctx, zone, toX, toY, phase = 0) {
  const cx = toX((zone.u0 + zone.u1) / 2);
  const cy = toY((zone.v0 + zone.v1) / 2);
  const zw = toX(zone.u1) - toX(zone.u0);
  const zh = toY(zone.v1) - toY(zone.v0);
  const t = 0.5 + 0.5 * Math.sin(phase * Math.PI * 2);
  const arm = Math.min(zw, zh) * 0.35;

  ctx.save();
  ctx.strokeStyle = 'rgba(255, 153, 0, 0.95)';
  ctx.fillStyle = 'rgba(255, 153, 0, 0.35)';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';

  switch (zone.id) {
    case 'nuque': {
      // Bras par-dessus l'épaule, descente le long de la nuque.
      const sx = cx + zw * 0.28;
      const sy = cy - zh * 0.35;
      const ex = cx - zw * 0.05;
      const ey = cy + zh * (0.1 + t * 0.25);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo(sx - arm * 0.3, sy + arm * 0.5, ex, ey);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(ex, ey, 4, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'omoplate_g':
    case 'omoplate_d': {
      // Bras par en dessous qui remonte.
      const left = zone.id === 'omoplate_g';
      const sx = cx + (left ? -zw * 0.35 : zw * 0.35);
      const sy = cy + zh * 0.35;
      const ex = cx + (left ? zw * 0.05 : -zw * 0.05);
      const ey = cy - zh * (0.05 + t * 0.2);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo(cx, cy + zh * 0.15, ex, ey);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(ex, ey, 4, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'colonne': {
      // Main remonte le long de la colonne.
      const ex = cx;
      const ey = cy - zh * (0.15 + t * 0.2);
      const sx = cx + zw * 0.25;
      const sy = cy + zh * 0.25;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(ex, ey, 4, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'rein_g':
    case 'rein_d': {
      // Paume à plat, balayage horizontal vers le centre.
      const left = zone.id === 'rein_g';
      const sx = cx + (left ? -zw * 0.2 : zw * 0.2);
      const ex = cx + (left ? zw * 0.15 * t : -zw * 0.15 * t);
      const y = cy;
      ctx.beginPath();
      ctx.moveTo(sx, y);
      ctx.lineTo(ex, y);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(ex, y, 4, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'bas': {
      // Mains sur les reins, balayage vers le centre.
      const spread = zw * 0.22 * (1 - t * 0.4);
      for (const sign of [-1, 1]) {
        const px = cx + sign * spread;
        ctx.beginPath();
        ctx.moveTo(px, cy - zh * 0.1);
        ctx.lineTo(cx + sign * zw * 0.08, cy + zh * 0.08);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx + sign * zw * 0.08, cy + zh * 0.08, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    default:
      break;
  }
  ctx.restore();
}

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
