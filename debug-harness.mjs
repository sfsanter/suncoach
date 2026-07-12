/**
 * Harness Node — logique session sans DOM ni MediaPipe.
 * Usage : node debug-harness.mjs
 */
import { applyCalibration, SYNTHETIC_ANCHORS_PX, SYNTHETIC_FRAME } from './src/lib/sessionCore.js';
import {
  customBackOutlineUV,
  nearBackShape,
  getBackWarp,
  CoverageGrid,
} from './src/lib/coverage.js';

const { calibrationAnchors, layout, warp } = applyCalibration(
  SYNTHETIC_ANCHORS_PX,
  SYNTHETIC_FRAME,
);

const outline = customBackOutlineUV();
const grid = new CoverageGrid();

console.log('=== SunCoach debug harness ===');
console.log('anchors:', Object.keys(calibrationAnchors).length, '/ 8');
console.log('layout aspect:', layout?.aspect?.toFixed(3) ?? 'n/a');
console.log('warp outline pts:', warp?.outline?.length ?? 0);
console.log('customBackOutlineUV pts:', outline?.length ?? 0);
console.log('getBackWarp:', getBackWarp() ? 'active' : 'null');
console.log('insideGeneric center:', nearBackShape(0.5, 0.5));
console.log('body pixels:', [...Array(grid.heat.length)].filter((_, i) => grid.isBody(i)).length);
console.log('OK — harness passed');
