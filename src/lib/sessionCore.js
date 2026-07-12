/**
 * Logique session testable hors DOM (harness Node) — pas de canvas ni MediaPipe.
 */
import { buildMinimapLayout, pixelsToBackAnchors } from './anchorShape.js';
import { buildBackWarp, setBackWarp } from './backWarp.js';
import { setMinimapLayout, setCustomBackAnchors, setTracedContour } from './coverage.js';

/** Applique calibration 8 points (photo figée) — même effet que confirmAdjustment. */
export function applyCalibration(pxAnchors, calibrationFrame) {
  const calibrationAnchors = pixelsToBackAnchors(pxAnchors, calibrationFrame);
  const layout = buildMinimapLayout(pxAnchors);
  const warp = buildBackWarp(pxAnchors);
  setTracedContour(null);
  setMinimapLayout(layout);
  setBackWarp(warp);
  setCustomBackAnchors(calibrationAnchors);
  return { calibrationAnchors, layout, warp };
}

/** Ancres synthétiques plausibles (720×1280 portrait). */
export const SYNTHETIC_ANCHORS_PX = {
  nuque: { x: 360, y: 280 },
  epaule_g: { x: 260, y: 340 },
  epaule_d: { x: 460, y: 340 },
  milieu_g: { x: 240, y: 520 },
  milieu_d: { x: 480, y: 520 },
  rein_g: { x: 280, y: 720 },
  rein_d: { x: 440, y: 720 },
  bas: { x: 360, y: 880 },
};

export const SYNTHETIC_FRAME = {
  origin: { x: 360, y: 320 },
  ex: { x: 1, y: 0 },
  ey: { x: 0, y: 1 },
  width: 220,
  height: 600,
};
