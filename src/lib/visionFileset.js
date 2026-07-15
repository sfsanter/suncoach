/**
 * Shared MediaPipe WASM fileset — avoid triple FilesetResolver.forVisionTasks
 * (same wasm ~11 Mo from CDN on cold phone load).
 */
import { FilesetResolver } from '@mediapipe/tasks-vision';

export const VISION_WASM_URL =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';

let filesetPromise = null;

export function getVisionFileset() {
  if (!filesetPromise) {
    filesetPromise = FilesetResolver.forVisionTasks(VISION_WASM_URL).catch((err) => {
      filesetPromise = null;
      throw err;
    });
  }
  return filesetPromise;
}
