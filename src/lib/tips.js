/**
 * Conseils vocaux par zone anatomique + instructions geste/main.
 */
import { ANATOMICAL_ZONES } from './zones.js';

const TIPS = {
  nuque: 'Pour la nuque : passe une main par-dessus l’épaule, coude au ciel, et descends le long de la nuque en frottant.',
  omoplate_g: 'Pour l’omoplate gauche : bras dans le dos par en dessous, coude plié, remonte ta main le long de la colonne. L’autre main peut pousser le coude.',
  omoplate_d: 'Pour l’omoplate droite : même geste par en dessous avec la main droite, ou passe par-dessus l’épaule gauche.',
  colonne: 'Pour le milieu du dos : bras par en dessous, paume à plat, remonte le long de la colonne vertébrale.',
  rein_g: 'Pour le rein gauche : main par en dessous, paume à plat, balaie vers le centre.',
  rein_d: 'Pour le rein droit : même geste avec la main droite, de l’extérieur vers la colonne.',
  bas: 'Pour le bas du dos : mains sur les reins et balaie vers le centre, en remontant légèrement.',
};

const INSTRUCTIONS = {
  nuque: 'Main par-dessus l’épaule, descends le long de la nuque.',
  omoplate_g: 'Main gauche par en dessous, remonte vers l’omoplate.',
  omoplate_d: 'Main droite par en dessous, remonte vers l’omoplate.',
  colonne: 'Bras dans le dos, remonte le long de la colonne.',
  rein_g: 'Main gauche à plat sur le rein, balaie vers le centre.',
  rein_d: 'Main droite à plat sur le rein, balaie vers le centre.',
  bas: 'Mains sur les reins, balaie vers le centre.',
};

export function tipFor(zoneIdx) {
  const z = ANATOMICAL_ZONES[zoneIdx];
  return z ? TIPS[z.id] ?? '' : '';
}

export function zoneInstruction(zoneIdx) {
  const z = ANATOMICAL_ZONES[zoneIdx];
  return z ? INSTRUCTIONS[z.id] ?? '' : '';
}
