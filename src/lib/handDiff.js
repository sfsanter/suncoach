/**
 * Détection main labo : différence pose vide vs pose avec main.
 * Pic / petit blob — pas de centroid global.
 *
 * Décision (scripts/validate-hand-diff.mjs) :
 * - pic local améliore vs centroid, mais Simple reste faux
 * → NE PAS brancher sur la session vidéo / couverture.
 * Labo frames uniquement (debug warp / comparaison visuelle).
 */

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Impossible de charger ${src}`));
    img.src = src;
  });
}

function readPixels(img, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height).data;
}

function mapContact(warp, pixel) {
  if (!pixel || !warp) return null;
  const uv = warp.toGenericUv(pixel);
  if (!uv) return null;
  const display = warp.genericToDisplayUv(uv);
  if (!display) return null;
  return {
    name: 'diff',
    source: 'diff',
    pixel,
    uv,
    display,
  };
}

/**
 * Algo pur (testable hors DOM) : pic local + petite grappe autour.
 * @param {Uint8ClampedArray|Uint8Array} base RGBA
 * @param {Uint8ClampedArray|Uint8Array} pose RGBA
 * @param {number} w
 * @param {number} h
 * @param {(x:number,y:number)=>boolean} insideMask
 * @param {{ sampleStep?: number, peakRadius?: number, blobRadius?: number, topFraction?: number }} [opts]
 */
export function findDiffPeak(base, pose, w, h, insideMask, opts = {}) {
  const step = Math.max(1, opts.sampleStep ?? 2);
  const peakRadius = opts.peakRadius ?? 10;
  const blobRadius = opts.blobRadius ?? 18;
  const topFraction = opts.topFraction ?? 0.015;

  /** @type {{ x: number, y: number, d: number }[]} */
  const samples = [];
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      if (!insideMask(x, y)) continue;
      const i = (y * w + x) * 4;
      const d = Math.abs(pose[i] - base[i])
        + Math.abs(pose[i + 1] - base[i + 1])
        + Math.abs(pose[i + 2] - base[i + 2]);
      samples.push({ x, y, d });
    }
  }

  if (samples.length < 40) {
    return { ok: false, reason: 'mask-too-small', pixel: null, hot: 0, peakScore: 0 };
  }

  // Seuil = percentile haut (seulement le sommet de la diff)
  const sorted = samples.map((s) => s.d).sort((a, b) => a - b);
  const pctIdx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(sorted.length * (1 - topFraction))),
  );
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const percentile = sorted[pctIdx];
  const threshold = Math.max(70, mean * 2.8, percentile);

  const hot = samples.filter((s) => s.d >= threshold);
  if (hot.length < 4) {
    return {
      ok: false,
      reason: 'diff-too-weak',
      pixel: null,
      hot: hot.length,
      peakScore: 0,
      threshold,
    };
  }

  // Score local = somme des (d - threshold) dans un disque — favorise un vrai amas
  let best = null;
  for (const candidate of hot) {
    let score = 0;
    let n = 0;
    for (const s of hot) {
      const dx = s.x - candidate.x;
      const dy = s.y - candidate.y;
      if (dx * dx + dy * dy > peakRadius * peakRadius) continue;
      score += s.d - threshold;
      n += 1;
    }
    if (!best || score > best.score) {
      best = { x: candidate.x, y: candidate.y, score, n };
    }
  }

  if (!best || best.n < 3) {
    return {
      ok: false,
      reason: 'no-local-peak',
      pixel: null,
      hot: hot.length,
      peakScore: 0,
      threshold,
    };
  }

  // Petite grappe autour du pic (pas tout le dos)
  let mass = 0;
  let mx = 0;
  let my = 0;
  let blobCount = 0;
  for (const s of hot) {
    const dx = s.x - best.x;
    const dy = s.y - best.y;
    if (dx * dx + dy * dy > blobRadius * blobRadius) continue;
    const weight = (s.d - threshold) ** 2;
    mass += weight;
    mx += s.x * weight;
    my += s.y * weight;
    blobCount += 1;
  }

  if (mass <= 0 || blobCount < 3) {
    return {
      ok: false,
      reason: 'blob-too-small',
      pixel: null,
      hot: hot.length,
      peakScore: best.score,
      threshold,
    };
  }

  return {
    ok: true,
    reason: 'peak',
    pixel: { x: mx / mass, y: my / mass },
    hot: blobCount,
    peakScore: best.score,
    threshold,
    totalHot: hot.length,
  };
}

/**
 * Compare base (dos sans main) et pose actuelle.
 * @returns {Promise<{ ok: boolean, reason: string, contacts: object[] }>}
 */
export async function contactFromImageDiff({
  baseSrc,
  poseSrc,
  warp,
  width,
  height,
  sampleStep = 2,
}) {
  if (!warp) {
    return { ok: false, reason: '8 points manquants', contacts: [] };
  }
  if (!baseSrc || !poseSrc) {
    return { ok: false, reason: 'Images manquantes', contacts: [] };
  }
  if (baseSrc === poseSrc) {
    return {
      ok: true,
      reason: 'Pose « sans rien » : pas de main à trouver (passe à Simple / Compliquée)',
      contacts: [],
    };
  }

  const [baseImg, poseImg] = await Promise.all([loadImage(baseSrc), loadImage(poseSrc)]);
  const w = width || poseImg.naturalWidth || poseImg.width;
  const h = height || poseImg.naturalHeight || poseImg.height;
  if (!w || !h) return { ok: false, reason: 'Dimensions image invalides', contacts: [] };

  const base = readPixels(baseImg, w, h);
  const pose = readPixels(poseImg, w, h);

  const insideMask = (x, y) => {
    const uv = warp.toGenericUv({ x, y });
    return !!(uv && warp.insideGeneric(uv.u, uv.v));
  };

  const peak = findDiffPeak(base, pose, w, h, insideMask, { sampleStep });
  if (!peak.ok || !peak.pixel) {
    const detail = peak.threshold != null ? ` (seuil ${peak.threshold.toFixed?.(0) ?? peak.threshold})` : '';
    return {
      ok: true,
      reason: `Diff: pas de pic local${detail} — ${peak.reason || 'échec'}`,
      contacts: [],
    };
  }

  const mapped = mapContact(warp, peak.pixel);
  if (!mapped) {
    return {
      ok: true,
      reason: 'Pic hors warp — 8 points ou alignement à revoir',
      contacts: [],
    };
  }

  return {
    ok: true,
    reason: `diff pic → UV ${mapped.uv.u.toFixed(2)}, ${mapped.uv.v.toFixed(2)} (blob ${peak.hot} / ${peak.totalHot} chauds)`,
    contacts: [mapped],
  };
}
