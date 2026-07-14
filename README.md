# SunCoach

Assistant vocal pour mettre de la crème solaire **dans le dos**, sans oublier une zone.
Interface façon NERV ([@mdrbx/nerv-ui](https://github.com/mdrbx/nerv-ui)).

Pose ton téléphone, mets-toi dos à la caméra, et laisse-toi guider à la voix : l'app
suit tes mains, découpe ton dos en 7 zones anatomiques, et te dit où il manque de la crème.

## Flux réel (Holistic + Segmenter)

1. **Placement** — distance ~2 m, dos à la caméra, épaules et hanches visibles.
2. **Scan IA** — `HolisticLandmarker` + segmenter optionnel : photo figée, masque dos moyenné.
3. **Ajustement** — 8 points glissables sur la photo (épaules/nuque au départ → contour du dos).
4. **Reposition** — retour dos caméra ; score de pose continu (pas de seuil binaire).
5. **Couverture libre** — frotte tout le dos ; heatmap orange → vert, bips radar, voix sur les zones manquantes.

Tout tourne **100 % dans le navigateur** (WASM/GPU). La vidéo ne quitte jamais l'appareil.

## Technique

| Couche | Fichiers |
|--------|----------|
| UI | `src/App.jsx`, `@mdrbx/nerv-ui` |
| Moteur | `src/lib/engine.js` |
| Pose + mains | `src/lib/pose.js` — `HolisticLandmarker` |
| Segmentation IA | `src/lib/bodySegmenter.js`, `src/lib/segmentation.js` |
| Schéma dos | `src/lib/backWarp.js`, `src/lib/anchorShape.js`, `src/lib/sessionCore.js` |
| Couverture | `src/lib/coverage.js`, `src/lib/zones.js`, `src/lib/handGate.js` |
| Voix / sons | `src/lib/voice.js`, `src/lib/tips.js` |

- **Warp** : les 8 points photo → UV générique (zones anatomiques + heatmap).
- **Mode dégradé** : si confiance main basse, peinture par zone via `grid.paintZone`.
- **Debug** : `?debug=1` sur l'URL, ou `node debug-harness.mjs` (voir `docs/DEBUG.md`).
- **Labos** :
  - `?lab=1` — minimap image fixe + 8 points
  - `?vidhands=1` — vidéo : tracking dos/mains + couverture (voir `AGENTS.md` → prochaine session)
  - `?frames=1` — frames Hands figées

## Développement

```bash
npm install
npm run build          # dist/
node debug-harness.mjs # logique session sans DOM
npm run preview        # ouvre ensuite le port affiché
```

La caméra exige HTTPS ou `localhost`. Pour le diagnostic Mac, utilise le bouton
**CHOISIR UNE VIDÉO** avec un MP4 H.264. Les repères temporels affichés sont une
légende : les phases sont déclenchées uniquement par la pose détectée.

Le fichier vidéo ne modifie pas les règles du protocole : il remplace seulement
la source caméra. Pour travailler uniquement sur la forme du dos, utilise le
labo minimap plutôt que le replay complet.

## Déploiement

GitHub Actions sur `main` → `dist/` → GitHub Pages. Détails : [DEPLOI.md](./DEPLOI.md).

## Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) — états, figé/live, fichiers
- [AGENTS.md](./AGENTS.md) — règles agents, hiérarchie, vagues
- [docs/DEBUG.md](./docs/DEBUG.md) — `?debug=1`, harness
