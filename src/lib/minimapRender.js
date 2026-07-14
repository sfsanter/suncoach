/** Rendu commun : données UV génériques → forme personnalisée affichée. */

export function toDisplayUv(warp, point) {
  if (!point) return null;
  return warp?.genericToDisplayUv?.(point) ?? point;
}

function mapTowardCenter(warp, point, center) {
  let candidate = point;
  for (let attempt = 0; attempt < 5; attempt++) {
    const mapped = toDisplayUv(warp, candidate);
    if (mapped) return mapped;
    candidate = {
      u: (candidate.u + center.u) / 2,
      v: (candidate.v + center.v) / 2,
    };
  }
  return null;
}

export function mappedRectPolygon(warp, u0, v0, u1, v1) {
  const center = { u: (u0 + u1) / 2, v: (v0 + v1) / 2 };
  const corners = [
    { u: u0, v: v0 },
    { u: u1, v: v0 },
    { u: u1, v: v1 },
    { u: u0, v: v1 },
  ];
  const mapped = corners.map((point) => mapTowardCenter(warp, point, center));
  return mapped.every(Boolean) ? mapped : null;
}

export function traceDisplayPolygon(ctx, points, toX, toY) {
  if (!points?.length) return false;
  ctx.beginPath();
  points.forEach((point, index) => {
    const x = toX(point.u);
    const y = toY(point.v);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
  return true;
}

export function drawMappedHeatCells(
  ctx,
  { w, h, isBody, fractionAt },
  warp,
  toX,
  toY,
  colorForFraction,
) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const index = y * w + x;
      if (!isBody(index)) continue;
      const polygon = mappedRectPolygon(warp, x / w, y / h, (x + 1) / w, (y + 1) / h);
      if (!polygon || !traceDisplayPolygon(ctx, polygon, toX, toY)) continue;
      const [r, g, b, a] = colorForFraction(fractionAt(index));
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a / 255})`;
      ctx.fill();
    }
  }
}

export function strokeMappedZone(ctx, zone, warp, toX, toY, color, lineWidth = 2) {
  const polygon = mappedRectPolygon(warp, zone.u0, zone.v0, zone.u1, zone.v1);
  if (!polygon || !traceDisplayPolygon(ctx, polygon, toX, toY)) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.stroke();
}

export function strokeMappedPath(ctx, path, warp, toX, toY, color, lineWidth = 1.5) {
  const points = path.map((point) => toDisplayUv(warp, point)).filter(Boolean);
  if (points.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(toX(points[0].u), toY(points[0].v));
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(toX(points[i].u), toY(points[i].v));
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.stroke();
}

/**
 * Renderer unique du labo et de la session.
 * Toutes les entrées de données sont en UV générique ; le warp gère l'affichage.
 */
export function drawMinimapScene(
  ctx,
  {
    width,
    height,
    warp,
    heat,
    colorForFraction,
    paths = null,
    gapZone = null,
    showZones = false,
    background = 'rgba(0, 0, 0, 0.82)',
    bottomSpace = 16,
  },
) {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);
  if (!warp?.outline?.length) return null;

  const pad = 6;
  const availableWidth = width - pad * 2;
  const availableHeight = height - pad * 2 - bottomSpace;
  const aspect = warp.displayAspect || 0.55;
  let mapWidth;
  let mapHeight;
  if (availableWidth / availableHeight > aspect) {
    mapHeight = availableHeight;
    mapWidth = mapHeight * aspect;
  } else {
    mapWidth = availableWidth;
    mapHeight = mapWidth / aspect;
  }
  const offsetX = pad + (availableWidth - mapWidth) / 2;
  const offsetY = pad + (availableHeight - mapHeight) / 2;
  const toX = (u) => offsetX + u * mapWidth;
  const toY = (v) => offsetY + v * mapHeight;

  ctx.save();
  traceDisplayPolygon(ctx, warp.outline, toX, toY);
  ctx.clip();
  if (heat && colorForFraction) {
    drawMappedHeatCells(ctx, heat, warp, toX, toY, colorForFraction);
  }
  if (paths) {
    ctx.globalAlpha = 0.85;
    strokeMappedPath(ctx, paths.gauche ?? [], warp, toX, toY, '#00FFFF', 2);
    strokeMappedPath(ctx, paths.droite ?? [], warp, toX, toY, '#FF00FF', 2);
    ctx.globalAlpha = 1;
  }
  ctx.restore();

  if (showZones) {
    for (const zone of showZones) {
      strokeMappedZone(ctx, zone, warp, toX, toY, 'rgba(255,255,255,0.5)', 1);
    }
  }
  if (gapZone) {
    ctx.save();
    ctx.setLineDash([4, 3]);
    strokeMappedZone(ctx, gapZone, warp, toX, toY, 'rgba(255,50,50,0.95)', 2.5);
    ctx.restore();
  }

  traceDisplayPolygon(ctx, warp.outline, toX, toY);
  ctx.strokeStyle = 'rgba(0,255,90,0.95)';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.font = '9px Fira Code, monospace';
  ctx.fillStyle = 'rgba(0,255,90,0.8)';
  ctx.textAlign = 'left';
  ctx.fillText('G', offsetX + 2, offsetY + 10);
  ctx.textAlign = 'right';
  ctx.fillText('D', offsetX + mapWidth - 2, offsetY + 10);

  return { toX, toY, offsetX, offsetY, mapWidth, mapHeight };
}
