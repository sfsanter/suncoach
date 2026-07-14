/** Mode replay vidéo (?replay=1) — injection fichier au lieu de la caméra live. */

export const DEFAULT_REPLAY_FILE = 'IMG_3805.mp4';

/**
 * Marqueurs UI uniquement (légende timeline).
 * NE DÉCLENCHENT AUCUNE PHASE — le moteur réagit à la pose MediaPipe seule.
 */
export const REPLAY_SCENARIO = [
  { t: 0, label: 'Placement', phase: 'placement' },
  { t: 2, label: 'Verrouillage', phase: 'locking' },
  { t: 7, label: 'Rotation', phase: 'adjusting' },
  { t: 9, label: 'Reposition', phase: 'reposition' },
  { t: 12, label: 'Couverture dos', phase: 'coverage' },
  { t: 34, label: 'Couverture torse', phase: 'coverage' },
];

export function isReplayMode() {
  if (typeof window === 'undefined') return false;
  try {
    return new URLSearchParams(window.location.search).has('replay');
  } catch {
    return false;
  }
}

/** Fichier explicite : ?replay=1&video=monclip.MOV */
export function replayFileFromUrl() {
  if (typeof window === 'undefined') return '';
  try {
    return new URLSearchParams(window.location.search).get('video') || '';
  } catch {
    return '';
  }
}

export function isLocalDevHost() {
  if (typeof window === 'undefined') return false;
  const h = window.location.hostname;
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
}

/** Tente de charger la vidéo par défaut depuis la racine du serveur (dev local). */
export async function tryAutoLoadDefaultVideo() {
  const explicit = replayFileFromUrl();
  const name = explicit || DEFAULT_REPLAY_FILE;
  const url = new URL(name, window.location.href).href;
  try {
    const head = await fetch(url, { method: 'HEAD' });
    if (!head.ok) return null;
    return url;
  } catch {
    return null;
  }
}
