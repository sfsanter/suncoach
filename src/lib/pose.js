/**
 * Caméra + MediaPipe HolisticLandmarker : pose + mains dédiées (21 pts/main)
 * + masque de segmentation léger pour ajuster la morphologie du dos.
 */
import { FilesetResolver, HolisticLandmarker } from '@mediapipe/tasks-vision';

export const LM = {
  NOSE: 0,
  L_SHOULDER: 11, R_SHOULDER: 12,
  L_ELBOW: 13, R_ELBOW: 14,
  L_WRIST: 15, R_WRIST: 16,
  L_PINKY: 17, R_PINKY: 18,
  L_INDEX: 19, R_INDEX: 20,
  L_THUMB: 21, R_THUMB: 22,
  L_HIP: 23, R_HIP: 24,
};

export const HM = {
  WRIST: 0,
  INDEX_MCP: 5,
  PINKY_MCP: 17,
  INDEX_TIP: 8,
  PINKY_TIP: 20,
  MIDDLE_TIP: 12,
};

const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/holistic_landmarker/holistic_landmarker/float16/1/holistic_landmarker.task';

let landmarkerPromise = null;

async function createLandmarker() {
  const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: 'VIDEO',
    minPosePresenceConfidence: 0.6,
    minHandLandmarksConfidence: 0.5,
    outputPoseSegmentationMasks: true,
  });
  try {
    return await HolisticLandmarker.createFromOptions(fileset, options('GPU'));
  } catch {
    return await HolisticLandmarker.createFromOptions(fileset, options('CPU'));
  }
}

export function preloadPose() {
  if (!landmarkerPromise) {
    landmarkerPromise = createLandmarker().catch((err) => {
      landmarkerPromise = null;
      throw err;
    });
  }
  return landmarkerPromise;
}

function lmScore(p) {
  return p.visibility ?? p.presence ?? 0;
}

export function palmFromHand(hand) {
  if (!hand || hand.length < 21) return null;
  const w = hand[HM.WRIST];
  if (lmScore(w) < 0.35) return null;
  const refs = [hand[HM.INDEX_TIP], hand[HM.PINKY_TIP], hand[HM.MIDDLE_TIP], hand[HM.INDEX_MCP]]
    .filter((p) => lmScore(p) > 0.35);
  if (refs.length >= 1) {
    const cx = refs.reduce((s, p) => s + p.x, 0) / refs.length;
    const cy = refs.reduce((s, p) => s + p.y, 0) / refs.length;
    return {
      x: w.x + (cx - w.x) * 0.62,
      y: w.y + (cy - w.y) * 0.62,
      visibility: Math.min(1, lmScore(w)),
    };
  }
  return { x: w.x, y: w.y, visibility: lmScore(w) };
}

/** Paume + doigt index pour peindre plusieurs points de contact. */
export function contactPointsFromHand(hand) {
  if (!hand || hand.length < 21) return [];
  const pts = [];
  const palm = palmFromHand(hand);
  if (palm) pts.push(palm);
  for (const idx of [HM.INDEX_TIP, HM.MIDDLE_TIP]) {
    const p = hand[idx];
    if (lmScore(p) > 0.4) pts.push({ x: p.x, y: p.y, visibility: lmScore(p) });
  }
  return pts;
}

/**
 * Dos à la caméra : épaules visibles et assez écartées.
 * On évite les faux positifs « tourne-toi » quand les bras bougent.
 */
export function isBackTurned(P, imageWidth = 1) {
  const ls = P[LM.L_SHOULDER], rs = P[LM.R_SHOULDER];
  const lh = P[LM.L_HIP], rh = P[LM.R_HIP];
  if ([ls, rs, lh, rh].some((p) => p.visibility < 0.35)) return false;

  const shoulderW = Math.abs(rs.x - ls.x);
  const minW = imageWidth > 100 ? 0.06 * imageWidth : 0.06;
  if (shoulderW < minW) return false;

  // De dos : épaule gauche de la personne à gauche de l'image (x plus petit).
  return ls.x < rs.x;
}

/** Moyenne glissante pour ne pas couper la peinture sur une frame bruitée. */
export class BackOrientation {
  constructor(size = 12) {
    this.size = size;
    this.buf = [];
  }

  reset() {
    this.buf = [];
  }

  /** true = assez de frames récentes indiquent dos à la caméra. */
  update(P, imageWidth) {
    const ok = P ? isBackTurned(P, imageWidth) : false;
    this.buf.push(ok);
    if (this.buf.length > this.size) this.buf.shift();
    const n = this.buf.filter(Boolean).length;
    return n >= Math.ceil(this.size * 0.34);
  }
}

export class PoseTracker {
  constructor(video) {
    this.video = video;
    this.landmarker = null;
    this.stream = null;
    this.facing = 'user';
    this.smoothed = null;
    this.smoothedWorld = null;
    this._raf = 0;
    this._lastVideoTime = -1;
  }

  async init() {
    try {
      this.landmarker = await preloadPose();
    } catch {
      this.landmarker = await preloadPose();
    }
  }

  async startCamera(facing = this.facing) {
    this.stopCamera();
    const request = navigator.mediaDevices.getUserMedia({
      video: { facingMode: facing, width: { ideal: 960 }, height: { ideal: 720 } },
      audio: false,
    });
    const timeout = new Promise((_, reject) =>
      setTimeout(() => {
        const e = new Error('camera timeout');
        e.name = 'CameraTimeoutError';
        reject(e);
      }, 20000)
    );
    this.stream = await Promise.race([request, timeout]);
    this.facing = facing;
    this.video.srcObject = this.stream;
    await new Promise((resolve) => {
      const fallback = setTimeout(resolve, 8000);
      this.video.onloadedmetadata = () => {
        clearTimeout(fallback);
        this.video.play().then(resolve, resolve);
      };
    });
  }

  async switchCamera() {
    const next = this.facing === 'user' ? 'environment' : 'user';
    try {
      await this.startCamera(next);
    } catch {
      await this.startCamera(this.facing);
    }
  }

  stopCamera() {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
  }

  start(onFrame) {
    const loop = () => {
      this._raf = requestAnimationFrame(loop);
      if (!this.landmarker || this.video.readyState < 2) return;
      if (this.video.currentTime === this._lastVideoTime) return;
      this._lastVideoTime = this.video.currentTime;
      const ts = performance.now();
      let result;
      try {
        result = this.landmarker.detectForVideo(this.video, ts);
      } catch {
        return;
      }

      const raw = result.poseLandmarks?.[0];
      const world = result.poseWorldLandmarks?.[0];
      const mask = result.poseSegmentationMasks?.[0] ?? null;

      onFrame(
        {
          pose2D: raw ? this._smooth(raw) : null,
          poseWorld: world ? this._smoothWorld(world) : null,
          leftHandWorld: result.leftHandWorldLandmarks?.[0] ?? null,
          rightHandWorld: result.rightHandWorldLandmarks?.[0] ?? null,
          leftHand2D: result.leftHandLandmarks?.[0] ?? null,
          rightHand2D: result.rightHandLandmarks?.[0] ?? null,
          segmentationMask: mask,
        },
        ts
      );

      mask?.close();
    };
    loop();
  }

  stop() {
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    this.smoothed = null;
    this.smoothedWorld = null;
    this._lastVideoTime = -1;
  }

  _smooth(raw, alpha = 0.45) {
    if (!this.smoothed || this.smoothed.length !== raw.length) {
      this.smoothed = raw.map((p) => ({ ...p }));
      return this.smoothed;
    }
    for (let i = 0; i < raw.length; i++) {
      const s = this.smoothed[i];
      s.x += alpha * (raw[i].x - s.x);
      s.y += alpha * (raw[i].y - s.y);
      s.visibility = raw[i].visibility;
    }
    return this.smoothed;
  }

  _smoothWorld(raw, alpha = 0.35) {
    if (!this.smoothedWorld || this.smoothedWorld.length !== raw.length) {
      this.smoothedWorld = raw.map((p) => ({ ...p }));
      return this.smoothedWorld;
    }
    for (let i = 0; i < raw.length; i++) {
      const s = this.smoothedWorld[i];
      s.x += alpha * (raw[i].x - s.x);
      s.y += alpha * (raw[i].y - s.y);
      s.z += alpha * (raw[i].z - s.z);
      s.visibility = raw[i].visibility;
    }
    return this.smoothedWorld;
  }
}

export class OneEuro {
  constructor({ minCutoff = 1.2, beta = 0.02, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.prev = null;
    this.prevD = 0;
    this.prevT = 0;
  }

  static _alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(x, tMs) {
    const t = tMs / 1000;
    if (this.prev === null) {
      this.prev = x;
      this.prevT = t;
      return x;
    }
    const dt = Math.max(1e-3, t - this.prevT);
    this.prevT = t;
    const dRaw = (x - this.prev) / dt;
    const aD = OneEuro._alpha(this.dCutoff, dt);
    this.prevD += aD * (dRaw - this.prevD);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.prevD);
    const a = OneEuro._alpha(cutoff, dt);
    this.prev += a * (x - this.prev);
    return this.prev;
  }

  reset() {
    this.prev = null;
    this.prevD = 0;
  }
}
