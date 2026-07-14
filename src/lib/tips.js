/**
 * Messages vocaux pour les zones manquantes et le flux de calibration.
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

const CALIBRATION_VOICES = {
  done:
    'Calibrage terminé. Prends la crème, puis replace-toi dos à la caméra. ' +
    'Je te guide pour retrouver la même position.',
  reposition_intro:
    'Mets de la crème dans tes mains. Replace-toi dos à la caméra, à la même distance qu’au scan.',
  reposition_ok: 'Position retrouvée. C’est parti, frotte tout ton dos !',
  reposition_far: 'Tu es un peu loin. Rapproche-toi comme au début.',
  reposition_close: 'Tu es trop près. Recule un peu.',
  reposition_turn: 'Tourne-toi, dos à la caméra.',
  reposition_shift: 'Décale-toi pour retrouver la même position qu’au scan.',
  reposition_left: 'Décale-toi un peu vers la droite.',
  reposition_right: 'Décale-toi un peu vers la gauche.',
  reposition_back: 'Recule légèrement.',
  reposition_approx:
    'Position approximative, mais ton contour reste figé. On continue !',
  reposition_approx_ok:
    'C’est suffisant. Ton schéma de dos est enregistré, frotte maintenant !',
  scan_done:
    'Photo enregistrée. Tourne-toi vers l’écran : les points sont sur tes épaules. ' +
    'Glisse-les sur le bord de ton dos, puis valide.',
  adjust_intro:
    'Photo prise ! Les points verts sont sur tes épaules et ta nuque. ' +
    'Glisse chaque point sur le contour de ton dos, puis valide.',
  degraded_hint:
    'Je vois mal ta main. Frotte largement la zone indiquée, sans viser un point précis.',
};

export function calibrationVoice(id) {
  return CALIBRATION_VOICES[id] ?? '';
}
