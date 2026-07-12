# Debug SunCoach

## URL `?debug=1`

Ajoute `?debug=1` à l'URL du site (ex. `https://user.github.io/suncoach/?debug=1`).

### Minimap (coin bas-droit)

Overlay jaune en haut à gauche de la minimap :

- dimensions buffer / CSS / DPR (`minimapDebugInfo`)
- état session (`placement`, `locking`, `coverage`, …)
- mode coach (`precise` / `degraded`)
- warp actif (`on` / `off`)

Activé dans `engine.js` → `_drawMinimap` via `isDebugMinimap()` (`minimapCanvas.js`).

### Canvas DPR

`setupMinimapCanvas` (appelé dans `App.jsx` + `engine.start`) :

- buffer physique = CSS × `devicePixelRatio`
- dessin en coordonnées logiques 110×150

## Harness Node

Sans DOM, sans MediaPipe :

```bash
node debug-harness.mjs
```

### Ce que le harness vérifie

1. `applyCalibration(SYNTHETIC_ANCHORS_PX, SYNTHETIC_FRAME)`
2. 8 ancres UV produites
3. `buildBackWarp` → outline 8 points
4. `customBackOutlineUV()` cohérent
5. `nearBackShape(0.5, 0.5)` via `warp.insideGeneric`
6. `CoverageGrid.isBody` pixels > 0

### Sortie attendue

```
=== SunCoach debug harness ===
anchors: 8 / 8
layout aspect: ...
warp outline pts: 8
customBackOutlineUV pts: 8
getBackWarp: active
insideGeneric center: true
body pixels: ...
OK — harness passed
```

## Build local

```bash
npm run build
```

Le `__BUILD_ID__` injecté par Vite apparaît sur l'accueil et sous la minimap.

## Ce que le debug ne couvre pas

- Tracking mains Holistic (nécessite téléphone + caméra)
- Scan IA `BodySegmenter` (GPU navigateur)
- Voix TTS (`speechSynthesis`)

Ces points restent des tests manuels sur appareil réel.
