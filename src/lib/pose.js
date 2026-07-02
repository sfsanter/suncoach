/**
 * Caméra + MediaPipe PoseLandmarker (tout tourne dans le navigateur).
 * Modèle "full" (plus précis que "lite" sur les poignets/doigts), et sortie
 * des world landmarks 3D en mètres pour un repère torse invariant à la rotation.
 */
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';

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

const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task';

let landmarkerPromise = null;

async function createLandmarker() {
  const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: 'VIDEO',
    numPoses: 1,
    minTrackingConfidence: 0.6,
  });
  try {
    return await PoseLandmarker.createFromOptions(fileset, options('GPU'));
  } catch {
    return await PoseLandmarker.createFromOptions(fileset, options('CPU'));
  }
}

/**
 * Télécharge WASM + modèle une seule fois, dès que possible (appelé depuis
 * l'écran d'accueil pour que tout soit prêt quand on lance le protocole).
 */
export function preloadPose() {
  if (!landmarkerPromise) {
    landmarkerPromise = createLandmarker().catch((err) => {
      landmarkerPromise = null; // permet de retenter au prochain appel
      throw err;
    });
  }
  return landmarkerPromise;
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
      // un seul retry : les échecs réseau transitoires sont fréquents sur mobile
      this.landmarker = await preloadPose();
    }
  }

  async startCamera(facing = this.facing) {
    this.stopCamera();
    const request = navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: facing,
        width: { ideal: 960 },
        height: { ideal: 720 },
      },
      audio: false,
    });
    // Certains navigateurs sans caméra laissent getUserMedia suspendu indéfiniment.
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
      await this.startCamera(this.facing); // l'appareil n'a peut-être qu'une caméra
    }
  }

  stopCamera() {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
  }

  /**
   * Boucle de détection ; onFrame(landmarks2D|null, worldLandmarks3D|null, ts)
   * à chaque frame vidéo.
   */
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
      const raw = result.landmarks && result.landmarks[0];
      const world = result.worldLandmarks && result.worldLandmarks[0];
      onFrame(
        raw ? this._smooth(raw) : null,
        world ? this._smoothWorld(world) : null,
        ts
      );
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

  /** Lissage exponentiel pour atténuer le bruit des landmarks 2D. */
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

  /** Idem pour les world landmarks 3D (z bruité → lissage plus fort). */
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

/**
 * De dos, l'épaule gauche (landmark 11) apparaît à gauche de l'image
 * (les frames ne sont pas en miroir) ; de face c'est l'inverse.
 */
export function isBackTurned(lm) {
  const ls = lm[LM.L_SHOULDER];
  const rs = lm[LM.R_SHOULDER];
  if (ls.visibility < 0.5 || rs.visibility < 0.5) return false;
  return ls.x < rs.x;
}

/**
 * Filtre one-euro (Casiez et al.) : peu de jitter à basse vitesse, peu de
 * latence à haute vitesse. Recommandé par la littérature pour les landmarks.
 */
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
