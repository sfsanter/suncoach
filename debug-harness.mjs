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
  toBack,
  backToPx,
} from './src/lib/coverage.js';
import { buildBackWarp } from './src/lib/backWarp.js';
import { mappedRectPolygon } from './src/lib/minimapRender.js';
import { ANATOMICAL_ZONES } from './src/lib/zones.js';

const { calibrationAnchors, layout, warp } = applyCalibration(
  SYNTHETIC_ANCHORS_PX,
  SYNTHETIC_FRAME,
);

const outline = customBackOutlineUV();
const grid = new CoverageGrid();

console.log('=== SunCoach debug harness ===');
console.log('anchors:', Object.keys(calibrationAnchors).length, '/ 8');
const nuque = calibrationAnchors.nuque;
console.log('nuque generic UV:', nuque ? `${nuque.u.toFixed(2)},${nuque.v.toFixed(2)}` : 'missing');
console.log('layout aspect:', layout?.aspect?.toFixed(3) ?? 'n/a');
console.log('warp outline pts:', warp?.outline?.length ?? 0);
console.log('warp pixelOutline pts:', warp?.pixelOutline?.length ?? 0);
console.log('display aspect:', warp?.displayAspect?.toFixed(3) ?? 'n/a');
console.log('customBackOutlineUV pts:', outline?.length ?? 0);
console.log('getBackWarp:', getBackWarp() ? 'active' : 'null');
console.log('insideGeneric center:', nearBackShape(0.5, 0.5));
console.log('body pixels:', [...Array(grid.heat.length)].filter((_, i) => grid.isBody(i)).length);
if (Object.keys(calibrationAnchors).length < 8) throw new Error('expected 8 anchors');
if (!getBackWarp()) throw new Error('warp inactive');
if (!nearBackShape(0.5, 0.5)) throw new Error('center should be inside');
if (nuque && (nuque.v < 0 || nuque.v > 0.25)) throw new Error('nuque should be near top in generic UV');

const assertClose = (actual, expected, label, epsilon = 1e-5) => {
  if (Math.abs(actual - expected) > epsilon) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
};

assertClose(warp.displayAnchors.nuque.y, 0, 'display nuque top');
assertClose(warp.displayAnchors.bas.y, 1, 'display lower back bottom');
if ((warp.outline?.length ?? 0) < 12) throw new Error('expected densified outline (>=12 pts)');

for (const uv of [{ u: 0.5, v: 0.5 }, { u: 0.5, v: 0.04 }, { u: 0.18, v: 0.82 }]) {
  const pixel = warp.fromGenericUv(uv);
  const roundTrip = pixel && warp.toGenericUv(pixel);
  if (!roundTrip) throw new Error(`generic round-trip failed at ${JSON.stringify(uv)}`);
  assertClose(roundTrip.u, uv.u, 'generic round-trip u');
  assertClose(roundTrip.v, uv.v, 'generic round-trip v');

  const display = warp.genericToDisplayUv(uv);
  const displayRoundTrip = display && warp.displayToGenericUv(display);
  if (!displayRoundTrip) throw new Error(`display round-trip failed at ${JSON.stringify(uv)}`);
  assertClose(displayRoundTrip.u, uv.u, 'display round-trip u');
  assertClose(displayRoundTrip.v, uv.v, 'display round-trip v');
}

const samplePixel = { x: 330, y: 560 };
const backUv = toBack(samplePixel, SYNTHETIC_FRAME);
const sampleRoundTrip = backToPx(backUv.u, backUv.v, SYNTHETIC_FRAME);
assertClose(sampleRoundTrip.x, samplePixel.x, 'torso round-trip x');
assertClose(sampleRoundTrip.y, samplePixel.y, 'torso round-trip y');

const missingAnchorWarp = buildBackWarp({ ...SYNTHETIC_ANCHORS_PX, bas: undefined });
if (missingAnchorWarp) throw new Error('warp must reject incomplete anchors');
for (const zone of ANATOMICAL_ZONES) {
  const polygon = mappedRectPolygon(warp, zone.u0, zone.v0, zone.u1, zone.v1);
  if (!polygon || polygon.length !== 4) {
    throw new Error(`display mapping failed for zone ${zone.id}`);
  }
}
console.log('OK — harness passed');
