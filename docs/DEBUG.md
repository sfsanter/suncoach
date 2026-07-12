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

## Transmission vers le Mac

Panneau test activé avec `?test=1` (ex. `https://sfsanter.github.io/suncoach/?test=1` ou `?test=1&debug=1`).

### 1. Sur le Mac

```bash
node test-receiver.mjs
```

Le script affiche les adresses IPv4 locales (ex. `192.168.1.42`) et écoute le port **39281**.

### 2. Sur le téléphone

1. Ouvre l’URL avec `?test=1`.
2. Depuis l’accueil : **PANNEAU TEST DEBUG**, ou **TEST** pendant une session.
3. Saisis l’IP du Mac et le port (39281 par défaut).
4. Lance une session, puis **CAPTURER ÉTAT DEBUG**.
5. **ENVOYER AU MAC** — ou **COPIER JSON** / **TÉLÉCHARGER JSON** en secours.

### 3. Vérifier sur le Mac

Les captures arrivent dans `test-captures/` :

- `YYYY-MM-DD_HH-mm-ss.json` — bundle debug (`engine.getDebugBundle()` + métadonnées)
- `YYYY-MM-DD_HH-mm-ss.jpg` — snapshot JPEG de la minimap (si session active)

### Test curl local

```bash
curl -s http://127.0.0.1:39281/
curl -X POST http://127.0.0.1:39281/capture \
  -H 'Content-Type: application/json' \
  -d '{"build":"test","url":"http://example","capturedAt":"2026-07-12T10:00:00Z"}'
```
