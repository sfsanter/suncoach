/**
 * Caméra + MediaPipe PoseLandmarker (tout tourne dans le navigateur).
 */
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';

export const LM = {
  NOSE: 0,
  L_SHOULDER: 11, R_SHOULDER: 12,
  L_ELBOW: 13, R_ELBOW: 14,
  L_WRIST: 15, R_WRIST: 16,
  L_INDEX: 19, R_INDEX: 20,
  L_HIP: 23, R_HIP: 24,
};

const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

export class PoseTracker {
  constructor(video) {
    this.video = video;
    this.landmarker = null;
    this.stream = null;
    this.facing = 'user';
    this.smoothed = null;
    this._raf = 0;
    this._lastVideoTime = -1;
  }

  async init() {
    const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
    const options = (delegate) => ({
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'VIDEO',
      numPoses: 1,
    });
    try {
      this.landmarker = await PoseLandmarker.createFromOptions(fileset, options('GPU'));
    } catch {
      this.landmarker = await PoseLandmarker.createFromOptions(fileset, options('CPU'));
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

  /** Boucle de détection ; onFrame(landmarks|null, timestampMs) à chaque frame vidéo. */
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
      onFrame(raw ? this._smooth(raw) : null, ts);
    };
    loop();
  }

  stop() {
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    this.smoothed = null;
    this._lastVideoTime = -1;
  }

  /** Lissage exponentiel pour atténuer le bruit des landmarks. */
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
