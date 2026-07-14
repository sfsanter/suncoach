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

## Labo minimap `?lab=1`

Ouvre `http://localhost:<port>/?lab=1`, puis :

1. choisis une capture fixe où le dos est visible ;
2. place les 8 points dans l’ordre indiqué ;
3. déplace un point en le faisant glisser si nécessaire ;
4. vérifie le contour, les zones et la fausse heatmap.

Ce labo ne charge ni MediaPipe ni la machine à états. Il sert à valider le
mapping et le rendu sans confondre un défaut de minimap avec un défaut de pose.

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

## Mode replay vidéo (`?replay=1`)

Rejoue une vidéo enregistrée sur iPhone **sur le Mac**, sans caméra live — même pipeline session que la prod.

### Ouvrir le replay

1. Place la vidéo H.264 sur le Mac (ex. `IMG_3783.mp4` à la racine du projet).
2. Sers le dossier (la vidéo doit être accessible en HTTP) :

```bash
npm run build
npx serve . -p 4173
```

3. Ouvre dans le navigateur :

```
http://localhost:4173/dist/?replay=1
```

Avec overlay debug :

```
http://localhost:4173/dist/?replay=1&debug=1
```

### Charger la vidéo

- **Sélecteur de fichier** (recommandé) : bouton **CHOISIR UNE VIDÉO** — fonctionne toujours, y compris sans serveur.
- **Auto-load** : si `IMG_3783.mp4` est servi à la racine du site (`localhost`), il est détecté automatiquement.
- **URL explicite** : `?replay=1&video=monclip.MOV` (fichier servi par le même origin).

La vidéo n’est **pas** versionnée dans git (`.gitignore` : `*.MOV`, `*.mov`).

### Contrôles session replay

- **⏸ PAUSE / ▶ LECTURE** — pause la vidéo ; la pose affichée continue d’être analysée.
- **↺ DÉBUT** — retour à t=0.
- Pas de boucle automatique : revenir à la face en cours de session casserait le protocole.
- Barre de timeline avec repères visuels (0s, 2s, 7s, …), sans déclenchement par timecode.

### Scénario IMG_3783 → phases app

| Temps vidéo | Action utilisateur | Phase SunCoach |
|-------------|-------------------|----------------|
| 0.00–0.02 | Place le téléphone | `placement` |
| 0.02–0.07 | Recule, corps entier, bras | `locking` (scan IA) |
| 0.07–0.09 | Se retourne (face caméra) | `adjusting` (8 points photo) |
| 0.09–0.12 | Avance, dos à la caméra | `reposition` |
| 0.12–0.34 | Crème sur le dos | `coverage` (dos) |
| 0.34–fin | Crème torse, fin | `coverage` (torse) |

### Codec / compatibilité

- Safari et Chrome macOS lisent en général les `.MOV` iPhone (H.264 + AAC).
- Si la vidéo ne charge pas : convertir avec `ffmpeg -i IMG_3783.MOV -c:v libx264 -c:a aac replay.mp4`.
- Le mode LAN `?test=1` est masqué quand `?replay=1` est actif.

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
