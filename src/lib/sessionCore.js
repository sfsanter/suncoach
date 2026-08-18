/**
 * Logique session testable hors DOM (harness Node) — pas de canvas ni MediaPipe.
 */
import { buildMinimapLayout } from './anchorShape.js';
import { buildBackWarp, setBackWarp } from './backWarp.js';
import { setMinimapLayout, setCustomBackAnchors, setTracedContour } from './coverage.js';

/**
 * Ancres en UV générique (même espace que zones / heatmap / warp).
 * Plus de mapBackUV ici — ça combattait le warp.
 */
export function anchorsToGenericUv(pxAnchors, warp) {
  const out = {};
  if (!warp) return out;
  for (const [id, p] of Object.entries(pxAnchors || {})) {
    if (!p) continue;
    const g = warp.toGenericUv(p);
    if (g) out[id] = g;
  }
  return out;
}

/** Applique calibration 8 points (photo figée) — même effet que confirmAdjustment. */
export function applyCalibration(pxAnchors, calibrationFrame) {
  const layout = buildMinimapLayout(pxAnchors);
  const warp = buildBackWarp(pxAnchors);
  setTracedContour(null);
  setMinimapLayout(layout);
  setBackWarp(warp);
  const calibrationAnchors = anchorsToGenericUv(pxAnchors, warp);
  setCustomBackAnchors(calibrationAnchors);
  return { calibrationAnchors, layout, warp };
}

/** Ancres synthétiques plausibles (720×1280 portrait). */
export const SYNTHETIC_ANCHORS_PX = {
  nuque: { x: 360, y: 270 },
  epaule_g: { x: 245, y: 340 },
  epaule_d: { x: 475, y: 340 },
  milieu_g: { x: 225, y: 520 },
  milieu_d: { x: 495, y: 520 },
  rein_g: { x: 255, y: 750 },
  rein_d: { x: 465, y: 750 },
  bas: { x: 360, y: 810 },
};

export const SYNTHETIC_FRAME = {
  origin: { x: 360, y: 320 },
  ex: { x: 1, y: 0 },
  ey: { x: 0, y: 1 },
  width: 220,
  height: 600,
};
