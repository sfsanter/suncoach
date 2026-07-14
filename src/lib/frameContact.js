/**
 * Contact main → UV pour le labo frames.
 * Version proche de celle qui montrait un point sur « simple »,
 * sans l’invention coude (source du 2e point fantôme).
 */
import { LM, lmScore, palmFromHand } from './pose.js';
import { torsoFrame } from './coverage.js';
import {
  credibleBackHand,
  crediblePoseWrist,
  handContactPixels,
} from './handGate.js';

function mapContact(warp, pixel, name, source) {
  if (!pixel) return null;
  const uv = warp?.toGenericUv?.(pixel) ?? null;
  const display = uv ? warp.genericToDisplayUv(uv) : null;
  return { name, source, pixel, uv, display };
}

/**
 * @param {object} result sortie HolisticLandmarker.detect
 * @param {number} W
 * @param {number} H
 * @param {object|null} warp
 */
export function contactsFromHolistic(result, W, H, warp) {
  const raw = result.poseLandmarks?.[0];
  if (!raw) return { ok: false, reason: 'Pas de pose détectée', contacts: [] };

  const P = raw.map((p) => ({
    x: p.x * W,
    y: p.y * H,
    visibility: p.visibility ?? p.presence ?? 0,
  }));
  const frame = torsoFrame(P);
  if (!frame) return { ok: false, reason: 'Torse non détecté', contacts: [] };
  if (!warp) return { ok: false, reason: '8 points manquants', contacts: [] };

  const contacts = [];
  const defs = [
    { hand: result.leftHandLandmarks?.[0], wrist: LM.L_WRIST, name: 'gauche' },
    { hand: result.rightHandLandmarks?.[0], wrist: LM.R_WRIST, name: 'droite' },
  ];

  for (const d of defs) {
    const poseWrist = P[d.wrist];
    let source = null;
    let pixels = [];

    if (d.hand?.length >= 21 && credibleBackHand(d.hand, poseWrist, P, W, H)) {
      pixels = handContactPixels(d.hand, W, H).slice(0, 1);
      source = 'main';
    } else if (crediblePoseWrist(poseWrist, P)) {
      pixels = [poseWrist];
      source = 'poignet';
    }
    // Pas de elbowBackContact — c’était l’invention du point magenta.

    for (const pixel of pixels) {
      const mapped = mapContact(warp, pixel, d.name, source);
      if (mapped) contacts.push(mapped);
    }

    // Jaune diagnostic si landmarks main présents mais filtrés
    if (d.hand?.length >= 21 && source !== 'main') {
      const handPx = d.hand.map((p) => ({
        x: p.x * W,
        y: p.y * H,
        visibility: lmScore(p),
      }));
      const palm = palmFromHand(handPx);
      const brute = mapContact(warp, palm, d.name, 'main-brute');
      if (brute) contacts.push(brute);
    }
  }

  const primary = contacts.filter((c) => c.source !== 'main-brute' && c.uv);
  const yellow = contacts.filter((c) => c.source === 'main-brute' && c.uv);

  if (!primary.length && !yellow.length) {
    return {
      ok: true,
      reason: 'MediaPipe: aucun poignet/main mappable',
      contacts: [],
      frame,
    };
  }

  const shown = primary.length ? primary.slice(0, 2) : yellow.slice(0, 1);
  const lines = shown.map((c) => {
    const uvTxt = c.uv ? `${c.uv.u.toFixed(2)},${c.uv.v.toFixed(2)}` : 'hors warp';
    return `${c.name} (${c.source}) → ${uvTxt}`;
  });

  return {
    ok: true,
    reason: lines.join(' · '),
    contacts: shown,
    frame,
  };
}
