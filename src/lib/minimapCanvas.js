/** Setup canvas minimap avec devicePixelRatio + flag debug URL. */

export const MINIMAP_CSS_W = 110;
export const MINIMAP_CSS_H = 150;

export function preferredMinimapSize() {
  if (typeof window !== 'undefined' && window.innerWidth >= 768) {
    return { width: 190, height: 250 };
  }
  return { width: MINIMAP_CSS_W, height: MINIMAP_CSS_H };
}

export function isDebugMinimap() {
  if (typeof window === 'undefined') return false;
  try {
    return new URLSearchParams(window.location.search).has('debug');
  } catch {
    return false;
  }
}

/**
 * Buffer physique = css × dpr ; dessin en coordonnées logiques cssW × cssH.
 * @returns {{ ctx: CanvasRenderingContext2D, logicalW: number, logicalH: number, dpr: number }}
 */
export function setupMinimapCanvas(canvas, cssW = null, cssH = null) {
  const preferred = preferredMinimapSize();
  cssW ??= preferred.width;
  cssH ??= preferred.height;
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, logicalW: cssW, logicalH: cssH, dpr };
}

export function minimapDebugInfo(canvas) {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const styleW = canvas?.style?.width || '?';
  const styleH = canvas?.style?.height || '?';
  return `buf ${canvas?.width}×${canvas?.height} css ${styleW}×${styleH} dpr ${dpr}`;
}
