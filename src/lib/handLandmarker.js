/**
 * MediaPipe Hand Landmarker (standalone) — labo frames.
 * Cherche les paumes dans toute l’image, sans Holistic / sans pose.
 * Session produit : Hand Landmarker VIDEO (stack labo) via PoseTracker.
 * Labs frames : IMAGE mode reste dispo.
 */
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import { palmFromHand, HM, lmScore } from './pose.js';

const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const HAND_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

let handPromise = null;

function preferCpuDelegate() {
  if (typeof window === 'undefined') return false;
  try {
    return new URLSearchParams(window.location.search).has('cpu');
  } catch {
    return false;
  }
}

async function createHandLandmarker() {
  const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate },
    runningMode: 'IMAGE',
    numHands: 2,
    // Strict en plein cadre — le zoom haut-dos rattrape les poses atypiques
    minHandDetectionConfidence: 0.45,
    minHandPresenceConfidence: 0.45,
  });
  if (preferCpuDelegate()) {
    return HandLandmarker.createFromOptions(fileset, options('CPU'));
  }
  try {
    return await HandLandmarker.createFromOptions(fileset, options('GPU'));
  } catch {
    return HandLandmarker.createFromOptions(fileset, options('CPU'));
  }
}

export function preloadHandLandmarker() {
  if (!handPromise) {
    handPromise = createHandLandmarker().catch((err) => {
      handPromise = null;
      throw err;
    });
  }
  return handPromise;
}

let videoHandPromise = null;

async function createVideoHandLandmarker() {
  const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate },
    runningMode: 'VIDEO',
    numHands: 2,
    minHandDetectionConfidence: 0.45,
    minHandPresenceConfidence: 0.45,
    minTrackingConfidence: 0.45,
  });
  if (preferCpuDelegate()) {
    return HandLandmarker.createFromOptions(fileset, options('CPU'));
  }
  try {
    return await HandLandmarker.createFromOptions(fileset, options('GPU'));
  } catch {
    return HandLandmarker.createFromOptions(fileset, options('CPU'));
  }
}

/** Instance VIDEO dédiée (labo live mains, 8 points figés). */
export function preloadVideoHandLandmarker() {
  if (!videoHandPromise) {
    videoHandPromise = createVideoHandLandmarker().catch((err) => {
      videoHandPromise = null;
      throw err;
    });
  }
  return videoHandPromise;
}

export async function detectHandsForVideo(video, timestampMs) {
  const landmarker = await preloadVideoHandLandmarker();
  return landmarker.detectForVideo(video, timestampMs);
}

function emptyResult() {
  return { landmarks: [], handedness: [], worldLandmarks: [] };
}

function hasHands(result) {
  return (result?.landmarks?.length ?? 0) > 0;
}

function remapResultFromCrop(result, crop, fullW, fullH) {
  if (!hasHands(result)) return emptyResult();
  const { x0, y0, cw, ch } = crop;
  return {
    landmarks: result.landmarks.map((hand) =>
      hand.map((p) => ({
        ...p,
        x: (x0 + p.x * cw) / fullW,
        y: (y0 + p.y * ch) / fullH,
      })),
    ),
    handedness: result.handedness ?? [],
    worldLandmarks: result.worldLandmarks ?? [],
  };
}

/** Zone haut du dos (+ marge) pour zoom si détection plein cadre échoue. */
function upperBackCrop(anchorsPx, W, H) {
  const ids = ['nuque', 'epaule_g', 'epaule_d', 'milieu_g', 'milieu_d'];
  const pts = ids.map((id) => anchorsPx?.[id]).filter(Boolean);
  if (pts.length < 3) {
    return {
      x0: Math.floor(W * 0.15),
      y0: Math.floor(H * 0.08),
      cw: Math.floor(W * 0.7),
      ch: Math.floor(H * 0.45),
    };
  }
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  let minX = Math.min(...xs);
  let maxX = Math.max(...xs);
  let minY = Math.min(...ys);
  let maxY = Math.max(...ys);
  const padX = (maxX - minX) * 0.45;
  const padY = (maxY - minY) * 0.55;
  minX = Math.max(0, minX - padX);
  maxX = Math.min(W, maxX + padX);
  minY = Math.max(0, minY - padY);
  maxY = Math.min(H, maxY + padY * 0.35);
  return {
    x0: Math.floor(minX),
    y0: Math.floor(minY),
    cw: Math.max(32, Math.floor(maxX - minX)),
    ch: Math.max(32, Math.floor(maxY - minY)),
  };
}

function cropToCanvas(image, crop) {
  const canvas = document.createElement('canvas');
  // Upscale léger : aide le palm detector sur petite main
  const scale = Math.min(2.5, Math.max(1.6, 480 / Math.min(crop.cw, crop.ch)));
  canvas.width = Math.round(crop.cw * scale);
  canvas.height = Math.round(crop.ch * scale);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(
    image,
    crop.x0, crop.y0, crop.cw, crop.ch,
    0, 0, canvas.width, canvas.height,
  );
  return canvas;
}

/**
 * Détection labo : plein cadre (strict) → zoom haut du dos (légèrement plus souple).
 * Pas de passage « laxiste » plein cadre : trop de faux positifs.
 * @returns {{ result: object, mode: string }}
 */
export async function detectHandsOnImageLab(imageSource, anchorsPx = null) {
  const landmarker = await preloadHandLandmarker();
  const W = imageSource.naturalWidth || imageSource.width;
  const H = imageSource.naturalHeight || imageSource.height;

  let result = landmarker.detect(imageSource);
  if (hasHands(result)) return { result, mode: 'plein-cadre' };

  // Zoom ROI uniquement (pas de baisse de seuil sur toute l’image)
  await landmarker.setOptions({
    minHandDetectionConfidence: 0.35,
    minHandPresenceConfidence: 0.35,
  });
  const crop = upperBackCrop(anchorsPx, W, H);
  const zoomed = cropToCanvas(imageSource, crop);
  result = landmarker.detect(zoomed);
  await landmarker.setOptions({
    minHandDetectionConfidence: 0.45,
    minHandPresenceConfidence: 0.45,
  });
  if (hasHands(result)) {
    return {
      result: remapResultFromCrop(result, crop, W, H),
      mode: 'zoom-haut-dos',
    };
  }

  return { result: emptyResult(), mode: 'aucune' };
}

/** @deprecated préférer detectHandsOnImageLab */
export async function detectHandsOnImage(imageSource) {
  const { result } = await detectHandsOnImageLab(imageSource, null);
  return result;
}

function mapContact(warp, pixel, name, source, score) {
  if (!pixel || !warp) return null;
  const uv = warp.toGenericUv(pixel);
  const display = uv ? warp.genericToDisplayUv(uv) : null;
  return { name, source, pixel, uv, display, score };
}

/**
 * Résultat Hand Landmarker → contact UV.
 * @param {object} [opts]
 * @param {(p:{x:number,y:number})=>{x:number,y:number}} [opts.toWarpPixel]
 *   Projette le pixel live vers l’espace du warp (ex. warpToLocked).
 */
export function contactsFromHandLandmarker(result, W, H, warp, mode = '', opts = {}) {
  if (!warp) return { ok: false, reason: '8 points manquants', contacts: [] };
  const toWarpPixel = opts.toWarpPixel || ((p) => p);
  const landmarks = result?.landmarks ?? [];
  const handedness = result?.handedness ?? [];
  if (!landmarks.length) {
    return {
      ok: true,
      reason: `Hand Landmarker : aucune main (${mode || 'échec'})`,
      contacts: [],
    };
  }

  const mapped = [];
  for (let i = 0; i < landmarks.length; i++) {
    const hand = landmarks[i];
    const label = handedness[i]?.[0]?.categoryName?.toLowerCase?.() || '';
    const score = handedness[i]?.[0]?.score ?? 0;
    const name = label.includes('left') ? 'gauche' : label.includes('right') ? 'droite' : `main${i}`;

    const handPx = hand.map((p) => ({
      x: p.x * W,
      y: p.y * H,
      visibility: lmScore(p) || 1,
    }));
    let contactPx = palmFromHand(handPx);
    if (!contactPx) {
      const tips = [HM.INDEX_TIP, HM.MIDDLE_TIP, HM.PINKY_TIP]
        .map((idx) => handPx[idx])
        .filter(Boolean);
      if (tips.length) {
        contactPx = {
          x: tips.reduce((s, p) => s + p.x, 0) / tips.length,
          y: tips.reduce((s, p) => s + p.y, 0) / tips.length,
        };
      } else {
        contactPx = handPx[HM.WRIST];
      }
    }
    if (!contactPx) continue;

    const warpPx = toWarpPixel(contactPx);
    const inWarp = mapContact(warp, warpPx, name, 'hand-lm', score);
    if (inWarp?.uv && inWarp.display) {
      mapped.push({ ...inWarp, pixel: contactPx });
    } else {
      mapped.push({
        name,
        source: 'hand-lm-hors',
        pixel: contactPx,
        uv: null,
        display: null,
        score,
      });
    }
  }

  if (!mapped.length) {
    return { ok: true, reason: 'Mains vues mais non converties', contacts: [] };
  }

  const inBack = mapped.filter((c) => c.uv);
  const pick = (inBack.length ? inBack : mapped)
    .slice()
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];

  const extras = mapped.filter((c) => c !== pick).slice(0, 1);
  const contacts = [pick, ...extras];
  const modeTag = mode ? ` [${mode}]` : '';
  const lines = contacts.map((c) => {
    if (c.uv) {
      return `${c.name} (hand-lm ${((c.score ?? 0) * 100).toFixed(0)}%)${modeTag} → UV ${c.uv.u.toFixed(2)},${c.uv.v.toFixed(2)}`;
    }
    return `${c.name} (hors warp)${modeTag}`;
  });

  return { ok: true, reason: lines.join(' · '), contacts };
}
