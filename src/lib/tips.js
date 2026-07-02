/**
 * Messages vocaux pour les zones manquantes.
 */
import { ANATOMICAL_ZONES } from './zones.js';

export function gapMessage(gap) {
  if (!gap) return '';
  const z = gap.zone;
  const tips = {
    nuque: 'Passe une main par-dessus l’épaule et frotte la nuque.',
    omoplate_g: 'Bras par en dessous, remonte le long de l’omoplate gauche.',
    omoplate_d: 'Bras par en dessous, remonte le long de l’omoplate droite.',
    colonne: 'Paume à plat, remonte le long de la colonne.',
    rein_g: 'Main à plat sur le rein gauche, balaie vers le centre.',
    rein_d: 'Main à plat sur le rein droit, balaie vers le centre.',
    bas: 'Mains sur les reins, balaie vers le centre.',
  };
  const pct = Math.round((1 - gap.ratio) * 100);
  return `Il manque encore ${z.name}, environ ${pct} pour cent de cette zone. ${tips[z.id] ?? ''}`;
}

export function gapShort(gap) {
  return gap ? `MANQUE : ${gap.zone.short}` : '';
}

export function zoneName(idx) {
  return ANATOMICAL_ZONES[idx]?.name ?? '';
}
