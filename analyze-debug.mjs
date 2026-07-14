/**
 * Lit un export debug SunCoach et affiche un résumé lisible.
 * Usage : node analyze-debug.mjs suncoach-debug-....json
 */
import { readFileSync } from 'fs';

const path = process.argv[2];
if (!path) {
  console.error('Usage: node analyze-debug.mjs <fichier.json>');
  process.exit(1);
}

const b = JSON.parse(readFileSync(path, 'utf8'));

console.log('=== SunCoach — analyse diagnostic ===\n');
console.log('Exporté:', b.exportedAt ?? '?');
console.log('Build:', b.buildId ?? '?');
console.log('Phase:', b.phase ?? b.state ?? '?');
console.log('HUD:', b.hudStatus ?? '?');
console.log('Couverture:', b.paintedPct != null ? `${b.paintedPct}%` : `${Math.round((b.paintedRatio ?? 0) * 100)}%`);
console.log('Vidéo:', b.videoTime != null ? `${b.videoTime.toFixed(1)}s / ${(b.videoDuration ?? 0).toFixed(1)}s` : 'n/a');
console.log('Taille vidéo:', b.videoSize ? `${b.videoSize.w}×${b.videoSize.h}` : 'n/a');
console.log('Warp actif:', b.warpActive ? 'oui' : 'non');
console.log('Points contour:', b.outlinePointCount ?? 0);
console.log('Zones couvertes:', `${b.zonesCovered ?? 0}/${b.zonesTotal ?? 7}`);
console.log('Mode coach:', b.coachMode ?? '?');
console.log('Minimap:', b.minimap?.debugInfo ?? 'n/a');

if (b.draftAnchorsPx) {
  console.log('\n--- Ancres brouillon (px) ---');
  for (const [k, v] of Object.entries(b.draftAnchorsPx)) {
    console.log(`  ${k}: ${Math.round(v.x)}, ${Math.round(v.y)}`);
  }
}
if (b.calibrationAnchors) {
  console.log('\n--- Ancres calibrées (UV) ---');
  for (const [k, v] of Object.entries(b.calibrationAnchors)) {
    console.log(`  ${k}: u=${v.u?.toFixed(3)} v=${v.v?.toFixed(3)}`);
  }
}

console.log('\n→ Copie ce bloc et envoie-le dans le chat Cursor.');
