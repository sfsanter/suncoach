/**
 * Accrochage dos via landmarks MediaPipe (épaules + hanches).
 * Affine 6DOF seulement si elle reste saine ; sinon similarité (anti-pli / anti-filament).
 */

function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

function centroid(points) {
  const n = points.length;
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / n, y: sy / n };
}

function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-10) return null;
    if (pivot !== col) {
      const tmp = M[col];
      M[col] = M[pivot];
      M[pivot] = tmp;
    }
    const div = M[col][col];
    for (let c = col; c <= n; c++) M[col][c] /= div;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row) => row[n]);
}

/** Métriques MediaPipe du torse (4 coins : LS, RS, LH, RH). */
export function torsoMetrics(cloud) {
  if (!cloud || cloud.length < 4) return null;
  const [ls, rs, lh, rh] = cloud;
  const shoulderW = dist(ls, rs);
  const hipW = dist(lh, rh);
  const midS = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
  const midH = { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 };
  const height = dist(midS, midH);
  // Signe d’orientation (évite le « pliage miroir »)
  const sx = rs.x - ls.x;
  const sy = rs.y - ls.y;
  const hx = midH.x - midS.x;
  const hy = midH.y - midS.y;
  const chirality = sx * hy - sy * hx;
  const area = Math.abs(chirality); // ~ base×hauteur du parallelogramme
  if (shoulderW < 4 || height < 4) return null;
  return { shoulderW, hipW, height, chirality, area };
}

/** Pose trop dégénérée vs le lock → on refuse de suivre. */
export function poseCloudPlausible(locked, live) {
  const a = torsoMetrics(locked);
  const b = torsoMetrics(live);
  if (!a || !b) return false;
  const ratio = (x, y) => x / Math.max(y, 1e-6);
  const rs = ratio(b.shoulderW, a.shoulderW);
  const rh = ratio(b.hipW, a.hipW);
  const rt = ratio(b.height, a.height);
  if (rs < 0.55 || rs > 1.9) return false;
  if (rh < 0.5 || rh > 2.0) return false;
  if (rt < 0.5 || rt > 2.0) return false;
  // Flip gauche/droite ou basculement → « plié en 2 »
  if (a.chirality * b.chirality < 0) return false;
  // Torse quasi ligne (magnétisme / collapse)
  if (b.area < a.area * 0.35) return false;
  // Pincement vers l’axe vertical : largeur/hauteur s’effondre
  const aspectLock = a.shoulderW / a.height;
  const aspectLive = b.shoulderW / b.height;
  if (aspectLive < aspectLock * 0.72) return false;
  const hipAspectLock = a.hipW / a.height;
  const hipAspectLive = b.hipW / b.height;
  if (hipAspectLive < hipAspectLock * 0.68) return false;
  return true;
}

/**
 * Similarité (échelle uniforme + rotation + translation).
 */
export function estimateSimilarity2D(from, to) {
  if (!from?.length || from.length !== to?.length || from.length < 2) return null;

  const n = from.length;
  const cFrom = centroid(from);
  const cTo = centroid(to);

  let sxx = 0;
  let sxy = 0;
  let syx = 0;
  let syy = 0;
  let varFrom = 0;

  for (let i = 0; i < n; i++) {
    const fx = from[i].x - cFrom.x;
    const fy = from[i].y - cFrom.y;
    const tx = to[i].x - cTo.x;
    const ty = to[i].y - cTo.y;
    varFrom += fx * fx + fy * fy;
    sxx += fx * tx;
    sxy += fx * ty;
    syx += fy * tx;
    syy += fy * ty;
  }

  if (varFrom < 1e-8) return null;

  const a = sxx + syy;
  const b = sxy - syx;
  const scale = Math.hypot(a, b) / varFrom;
  if (!Number.isFinite(scale) || scale < 1e-6) return null;

  const angle = Math.atan2(b, a);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const invScale = 1 / scale;

  return {
    kind: 'similarity',
    scale,
    apply(p) {
      const dx = p.x - cFrom.x;
      const dy = p.y - cFrom.y;
      return {
        x: cTo.x + scale * (cos * dx - sin * dy),
        y: cTo.y + scale * (sin * dx + cos * dy),
      };
    },
    inv(p) {
      const dx = p.x - cTo.x;
      const dy = p.y - cTo.y;
      return {
        x: cFrom.x + invScale * (cos * dx + sin * dy),
        y: cFrom.y + invScale * (-sin * dx + cos * dy),
      };
    },
  };
}

function makeAffine(a, b, tx, c, d, ty) {
  const det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-8) return null;
  const invDet = 1 / det;
  const ia = d * invDet;
  const ib = -b * invDet;
  const ic = -c * invDet;
  const id = a * invDet;
  return {
    kind: 'affine',
    params: { a, b, tx, c, d, ty },
    det,
    apply(p) {
      return {
        x: a * p.x + b * p.y + tx,
        y: c * p.x + d * p.y + ty,
      };
    },
    inv(p) {
      const x = p.x - tx;
      const y = p.y - ty;
      return {
        x: ia * x + ib * y,
        y: ic * x + id * y,
      };
    },
  };
}

/**
 * Affine saine ? Pas de flip, pas d’aplatissement vers l’axe vertical.
 */
export function affineIsHealthy(aff) {
  if (!aff?.params) return false;
  const { a, b, c, d } = aff.params;
  const det = a * d - b * c;
  if (det <= 0) return false;
  // Colonne 1 ≈ axe largeur image ; colonne 2 ≈ hauteur
  const col1 = Math.hypot(a, c);
  const col2 = Math.hypot(b, d);
  if (col1 < 0.25 || col2 < 0.25) return false;
  const stretch = Math.max(col1, col2) / Math.min(col1, col2);
  // Interdit le « tube » vertical (largeur écrasée)
  if (stretch > 1.45) return false;
  if (col1 < col2 * 0.72) return false;
  const shear = Math.abs(a * b + c * d) / (col1 * col2 + 1e-6);
  if (shear > 0.45) return false;
  return true;
}

/** L’affine est-elle nettement plus étroite que la similarité ? */
function affineNarrowerThanSimilarity(aff, sim, lockedCloud) {
  if (!aff || !sim || !lockedCloud || lockedCloud.length < 2) return true;
  const ls = lockedCloud[0];
  const rs = lockedCloud[1];
  const aw = dist(aff.apply(ls), aff.apply(rs));
  const sw = dist(sim.apply(ls), sim.apply(rs));
  return aw < sw * 0.92;
}

export function estimateAffine2D(from, to) {
  if (!from?.length || from.length !== to?.length || from.length < 3) return null;

  const AtA = Array.from({ length: 6 }, () => Array(6).fill(0));
  const Atb = Array(6).fill(0);

  for (let i = 0; i < from.length; i++) {
    const x = from[i].x;
    const y = from[i].y;
    const xp = to[i].x;
    const yp = to[i].y;
    const rows = [
      [x, y, 1, 0, 0, 0],
      [0, 0, 0, x, y, 1],
    ];
    const vals = [xp, yp];
    for (let r = 0; r < 2; r++) {
      const row = rows[r];
      const v = vals[r];
      for (let c = 0; c < 6; c++) {
        Atb[c] += row[c] * v;
        for (let d = 0; d < 6; d++) AtA[c][d] += row[c] * row[d];
      }
    }
  }

  const sol = solveLinear(AtA, Atb);
  if (!sol) return null;
  return makeAffine(sol[0], sol[1], sol[2], sol[3], sol[4], sol[5]);
}

export function blendAffineParams(prev, next, alpha = 0.35) {
  if (!next?.params) return next;
  if (!prev?.params) return next;
  const p = prev.params;
  const n = next.params;
  const m = makeAffine(
    p.a * (1 - alpha) + n.a * alpha,
    p.b * (1 - alpha) + n.b * alpha,
    p.tx * (1 - alpha) + n.tx * alpha,
    p.c * (1 - alpha) + n.c * alpha,
    p.d * (1 - alpha) + n.d * alpha,
    p.ty * (1 - alpha) + n.ty * alpha,
  );
  return m && affineIsHealthy(m) ? m : next;
}

/**
 * 4 coins MediaPipe seulement (LS, RS, LH, RH).
 * Les milieux n’apportent pas d’info affine indépendante et accentuent le shear.
 */
export function torsoCornersFromPose(P, LM) {
  if (!P) return null;
  const ls = P[LM.L_SHOULDER];
  const rs = P[LM.R_SHOULDER];
  const lh = P[LM.L_HIP];
  const rh = P[LM.R_HIP];
  if (!ls || !rs || !lh || !rh) return null;
  const minVis = 0.45;
  if ([ls, rs, lh, rh].some((p) => (p.visibility ?? 0) < minVis)) return null;

  const cloud = [
    { x: ls.x, y: ls.y },
    { x: rs.x, y: rs.y },
    { x: lh.x, y: lh.y },
    { x: rh.x, y: rh.y },
  ];
  const m = torsoMetrics(cloud);
  if (!m) return null;
  // Épaules trop proches = vue de profil / collapse → refuse
  if (m.shoulderW < m.height * 0.35) return null;
  return cloud;
}

/**
 * Similarité d’abord (largeur préservée).
 * Affine seulement si elle ne pince pas vers l’axe vertical.
 */
export function torsoAttachTransform(lockedCloud, liveCloud) {
  if (!poseCloudPlausible(lockedCloud, liveCloud)) return null;

  const sim = estimateSimilarity2D(lockedCloud, liveCloud);
  if (!sim) return null;

  const aff = estimateAffine2D(lockedCloud, liveCloud);
  if (
    aff
    && affineIsHealthy(aff)
    && !affineNarrowerThanSimilarity(aff, sim, lockedCloud)
  ) {
    return { ok: true, ...aff };
  }

  return { ok: true, ...sim };
}

/** Lissage EMA des 4 coins MediaPipe (anti-jitter épaules → anti-tube). */
export function smoothTorsoCloud(prev, next, alpha = 0.4) {
  if (!next) return [...prev];
  if (!prev || prev.length !== next.length) {
    return next.map((p) => ({ x: p.x, y: p.y }));
  }
  return next.map((p, i) => ({
    x: prev[i].x * (1 - alpha) + p.x * alpha,
    y: prev[i].y * (1 - alpha) + p.y * alpha,
  }));
}

export function similarityFromCorrespondences(src, dst) {
  const sim = estimateSimilarity2D(src, dst);
  if (!sim) return null;
  return { ok: true, map: sim.apply, inv: sim.inv, scale: sim.scale };
}

export function mapAnchorsWithTorsoAffine(lockedAnchors, lockedCorners, liveCorners, anchorOrder) {
  const xf = torsoAttachTransform(lockedCorners, liveCorners);
  if (!xf) return null;
  const out = {};
  for (const id of anchorOrder) {
    const a = lockedAnchors[id];
    if (!a) continue;
    out[id] = xf.apply(a);
  }
  return Object.keys(out).length >= 4 ? out : null;
}
