/** Export diagnostic JSON (mode ?debug=1) — un clic, pas de réponses manuelles. */

export function buildDebugPayload(engine, { phase, hud, videoEl } = {}) {
  const base = engine?.getDebugBundle?.() ?? {};
  return {
    ...base,
    exportedAt: new Date().toISOString(),
    buildId: typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : null,
    phase: phase ?? base.state ?? null,
    hudStatus: hud?.status ?? null,
    paintedPct: hud?.pct != null ? Math.round(hud.pct * 100) : null,
    videoTime: videoEl?.currentTime ?? null,
    videoDuration: videoEl?.duration ?? null,
    videoSize: videoEl
      ? { w: videoEl.videoWidth, h: videoEl.videoHeight }
      : null,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
  };
}

export function downloadDebugJson(payload) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `suncoach-debug-${stamp}.json`;
  a.click();
  // Firefox peut annuler le téléchargement si l'URL est révoquée immédiatement.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
