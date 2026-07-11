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

const CALIBRATION_VOICES = {
  intro:
    'Avant de commencer, montre-moi où finit ton dos. ' +
    'Pose ta main à huit endroits, une seconde immobile à chaque fois. ' +
    'Suis le rond orange.',
  nuque: 'Point un : pose ta main au milieu de la nuque, sur le rond orange.',
  epaule_g: 'Point deux : bord gauche en haut, là où ton dos finit côté épaule.',
  epaule_d: 'Point trois : même chose à droite, bord de l’épaule.',
  milieu_g: 'Point quatre : au milieu du dos, côté gauche — le bord externe.',
  milieu_d: 'Point cinq : au milieu du dos, côté droit.',
  bas: 'Point six : tout en bas, au centre du bas du dos.',
  rein_g: 'Point sept : rein gauche — paume sur le bord gauche, au niveau des reins.',
  rein_d: 'Point huit : rein droit — même chose à droite, au niveau des reins.',
  hold: 'Reste une seconde immobile sur le point.',
  next: 'Parfait ! Point suivant.',
  done:
    'Super, j’ai ton dos. Mets de la crème dans tes mains, c’est parti ! ' +
    'Le orange montre ce qui reste à faire, le vert ce qui est couvert.',
  nohand: 'Je ne vois pas ta main — colle la paume à plat sur le rond orange.',
};

export function calibrationVoice(id) {
  return CALIBRATION_VOICES[id] ?? '';
}
