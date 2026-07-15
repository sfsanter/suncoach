/**
 * PoseLandmarker VIDEO — session + labo accroche dos.
 * Remplace Holistic pour la pose live.
 */
import { PoseLandmarker } from '@mediapipe/tasks-vision';
import { LM } from './pose.js';
import { torsoFrame } from './coverage.js';
import { getVisionFileset } from './visionFileset.js';

const POSE_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

let posePromise = null;

function preferCpuDelegate() {
  if (typeof window === 'undefined') return false;
  try {
    return new URLSearchParams(window.location.search).has('cpu');
  } catch {
    return false;
  }
}

async function createVideoPose() {
  const fileset = await getVisionFileset();
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  if (preferCpuDelegate()) {
    return PoseLandmarker.createFromOptions(fileset, options('CPU'));
  }
  try {
    return await PoseLandmarker.createFromOptions(fileset, options('GPU'));
  } catch {
    return PoseLandmarker.createFromOptions(fileset, options('CPU'));
  }
}

export function preloadVideoPose() {
  if (!posePromise) {
    posePromise = createVideoPose().catch((err) => {
      posePromise = null;
      throw err;
    });
  }
  return posePromise;
}

export async function detectPoseForVideo(video, timestampMs) {
  const landmarker = await preloadVideoPose();
  return landmarker.detectForVideo(video, timestampMs);
}

/** Landmarks normalisés → pixels + frame torse. */
export function posePixelsAndFrame(result, W, H) {
  const raw = result?.landmarks?.[0];
  if (!raw?.length) return { P: null, frame: null };
  const P = raw.map((p) => ({
    x: p.x * W,
    y: p.y * H,
    visibility: p.visibility ?? p.presence ?? 0,
  }));
  return { P, frame: torsoFrame(P) };
}

export { LM };
