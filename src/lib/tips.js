/**
 * Conseils de mouvements de bras pour les zones du dos difficiles à atteindre.
 * Donnés à la voix quand une zone reste non couverte malgré les annonces.
 */

const TIPS_BY_ROW = [
  // Rangée 0 : haut du dos / épaules
  'Astuce pour le haut du dos : passe ta main par-dessus ton épaule, le coude pointé vers le ciel, et descends le long de la colonne. Penche la tête en avant pour gagner quelques centimètres.',
  // Rangée 1 : omoplates — la zone la plus difficile
  "Astuce pour les omoplates : passe ton bras dans le dos par en dessous, coude plié, et fais remonter ta main le long de la colonne. Tu peux attraper ce coude avec l'autre main pour le pousser plus haut. Sinon, essaie par-dessus l'épaule opposée.",
  // Rangée 2 : milieu du dos
  'Astuce pour le milieu du dos : passe la main par en dessous, paume vers le dos, et balaie de gauche à droite en remontant petit à petit.',
  // Rangée 3 : bas du dos
  'Pour le bas du dos : mains sur les hanches, puis fais-les glisser vers la colonne.',
];

const SIDE_HINT = [
  ' Utilise plutôt ta main gauche pour ce côté.',
  '',
  ' Utilise plutôt ta main droite pour ce côté.',
];

export function tipFor(row, col) {
  return TIPS_BY_ROW[row] + (row <= 2 ? SIDE_HINT[col] : '');
}

/**
 * Instruction courte main + geste, donnée dès qu'une zone devient la cible.
 * Beaucoup plus actionnable que « va vers ta droite ».
 */
const HAND_FOR_COL = ['main gauche', 'chaque main à son tour', 'main droite'];

export function zoneInstruction(row, col) {
  const hand = HAND_FOR_COL[col];
  switch (row) {
    case 0:
      return col === 1
        ? 'Une main par-dessus l’épaule, descends le long de la nuque.'
        : `${cap(hand)} par-dessus l’épaule, coude au ciel.`;
    case 1:
      return col === 1
        ? 'Bras dans le dos par en dessous, remonte le long de la colonne.'
        : `${cap(hand)} par en dessous, remonte vers l’omoplate.`;
    case 2:
      return `${cap(hand)} par en dessous, paume bien à plat.`;
    default:
      return `${cap(hand)} sur les reins, balaie vers le centre.`;
  }
}

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
