/**
 * Validation labo handDiff (hors navigateur) sur les 3 captures.
 * Ancres approximatives pour ces PNG 569×1024 — assez pour juger pic vs centroid.
 */
import fs from 'fs';
import { buildBackWarp } from '../src/lib/backWarp.js';
import { findDiffPeak } from '../src/lib/handDiff.js';

const W = 569;
const H = 1024;
const DIR = '/tmp/suncoach-diff';

/** Ancres plaçables à l’œil sur le dos de vide.png (même échelle). */
const ANCHORS = {
  nuque: { x: 286, y: 245 },
  epaule_g: { x: 205, y: 305 },
  epaule_d: { x: 368, y: 305 },
  milieu_g: { x: 190, y: 430 },
  milieu_d: { x: 385, y: 430 },
  rein_g: { x: 215, y: 555 },
  rein_d: { x: 360, y: 555 },
  bas: { x: 288, y: 640 },
};

/** Zones UV génériques attendues (tolérance large, jugement humain). */
const EXPECT = {
  simple: {
    // Main bas du dos
    vMin: 0.55,
    vMax: 0.95,
    uMin: 0.2,
    uMax: 0.85,
    label: 'main bas du dos',
  },
  complexe: {
    // Main haute / omoplate
    vMin: 0.05,
    vMax: 0.45,
    uMin: 0.25,
    uMax: 0.85,
    label: 'main haute / omoplate',
  },
};

function loadRgba(name) {
  const buf = fs.readFileSync(`${DIR}/${name}.rgba`);
  const expect = W * H * 4;
  if (buf.length !== expect) {
    throw new Error(`${name}.rgba size ${buf.length} != ${expect}`);
  }
  return new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.byteLength);
}

function runOne(name, base, pose, warp) {
  const insideMask = (x, y) => {
    const uv = warp.toGenericUv({ x, y });
    return !!(uv && warp.insideGeneric(uv.u, uv.v));
  };
  const peak = findDiffPeak(base, pose, W, H, insideMask, { sampleStep: 2 });
  if (!peak.ok || !peak.pixel) {
    return { name, ok: false, detail: peak };
  }
  const uv = warp.toGenericUv(peak.pixel);
  const exp = EXPECT[name];
  const inZone = uv
    && uv.u >= exp.uMin && uv.u <= exp.uMax
    && uv.v >= exp.vMin && uv.v <= exp.vMax;
  return {
    name,
    ok: !!inZone,
    uv,
    hot: peak.hot,
    totalHot: peak.totalHot,
    threshold: peak.threshold,
    expect: exp.label,
  };
}

const warp = buildBackWarp(ANCHORS);
if (!warp) {
  console.error('warp failed');
  process.exit(1);
}

const base = loadRgba('vide');
const results = [
  runOne('simple', base, loadRgba('simple'), warp),
  runOne('complexe', base, loadRgba('complexe'), warp),
];

for (const r of results) {
  if (!r.ok && !r.uv) {
    console.log(`${r.name}: FAIL — ${JSON.stringify(r.detail)}`);
  } else {
    console.log(
      `${r.name}: ${r.ok ? 'PASS' : 'FAIL'} — UV ${r.uv?.u.toFixed(2)},${r.uv?.v.toFixed(2)} `
      + `blob ${r.hot}/${r.totalHot} — attendu: ${r.expect}`,
    );
  }
}

const allOk = results.every((r) => r.ok);
console.log(allOk ? 'VERDICT: pic OK pour labo → piste photo figée envisageable' : 'VERDICT: pic encore faux → abandonner diff pour le produit vidéo');
process.exit(allOk ? 0 : 2);
