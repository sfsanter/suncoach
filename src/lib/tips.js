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
    'Calibrage de ton dos. À chaque étape, je te dis quel geste faire. ' +
    'Reste une seconde immobile quand tu entends les bips accélérer.',
  nuque:
    'Point un, la nuque. Main droite : passe ton bras par-dessus ton épaule droite, ' +
    'coude vers le haut, paume sur la nuque. Reste immobile.',
  epaule_g:
    'Point deux, épaule gauche. Main gauche par en dessous, touche le bord gauche en haut du dos.',
  epaule_d:
    'Point trois, épaule droite. Main droite par en dessous, bord droit en haut du dos.',
  milieu_g:
    'Point quatre, milieu gauche. Main gauche sur le bord externe, au milieu du dos.',
  milieu_d:
    'Point cinq, milieu droit. Main droite, bord externe à droite, au milieu du dos.',
  bas:
    'Point six, bas du dos. Une main au centre, tout en bas du dos.',
  rein_g:
    'Point sept, rein gauche. Main gauche à plat, bord gauche au niveau des reins.',
  rein_d:
    'Point huit, rein droit. Main droite à plat, bord droit au niveau des reins.',
  gesture_ok: 'Je vois ton geste, reste immobile.',
  next: 'Parfait ! Point suivant.',
  done:
    'Calibrage terminé. Mets de la crème dans tes mains, c’est parti ! ' +
    'L’orange montre ce qui reste à faire, le vert ce qui est couvert.',
  no_gesture:
    'Je ne vois pas le bon geste. Écoute bien l’instruction et recommence.',
  nuque_hint:
    'Pour la nuque : main droite, bras par-dessus l’épaule droite, coude bien levé.',
};

export function calibrationVoice(id) {
  return CALIBRATION_VOICES[id] ?? '';
}
