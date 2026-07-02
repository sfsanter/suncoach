/**
 * Calibration distance sujet ↔ caméra (modèle sténopé) et tolérance de contact
 * paume-dos dérivée de cette distance.
 */

/** Largeur bi-acromiale moyenne (mètres). */
export const SHOULDER_WIDTH_M = 0.40;
/** Champ de vision horizontal typique d'un smartphone (degrés). */
const FOV_DEG = 65;
/** Distance de référence du protocole (mètres). */
const REF_DISTANCE_M = 2.0;
/** Tolérance w de base à la distance de référence (mètres). */
const BASE_TOUCH_M = 0.16;

/** Focal length en pixels : f = (W/2) / tan(FOV/2). */
export function focalLengthPx(imageWidthPx) {
  const halfRad = ((FOV_DEG * Math.PI) / 180) / 2;
  return (imageWidthPx / 2) / Math.tan(halfRad);
}

/** distance = (largeur_réelle × f) / largeur_px */
export function estimateSubjectDistance(shoulderWidthPx, imageWidthPx) {
  if (shoulderWidthPx < 1) return REF_DISTANCE_M;
  const f = focalLengthPx(imageWidthPx);
  return (SHOULDER_WIDTH_M * f) / shoulderWidthPx;
}

/**
 * Plus le sujet est loin, plus le bruit 3D MediaPipe grossit relativement :
 * on assouplit légèrement la tolérance w. Plus il est proche, on resserre.
 */
export function touchDistanceForRange(distanceM) {
  const scale = distanceM / REF_DISTANCE_M;
  return Math.max(0.09, Math.min(0.22, BASE_TOUCH_M * scale));
}

/** Formate la distance pour le HUD. */
export function formatDistance(m) {
  if (m < 1.5) return 'PROCHE';
  if (m > 2.8) return 'LOIN';
  return `${m.toFixed(1)} M`;
}
