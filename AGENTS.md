# AGENTS.md — SunCoach

Guide pour agents Cursor travaillant sur ce dépôt.

## Règles absolues

1. **Ne jamais** lancer `npm run dev` dans une tâche agent (sauf demande explicite utilisateur).
2. **Ne jamais** utiliser le navigateur MCP / screenshots automatisés pour valider.
3. **OK** : `npm run build`, `node debug-harness.mjs`, `curl` sur l'URL déployée.
4. **Ne pas** modifier le fichier plan (`*plan*`) si présent — implémenter, pas éditer le plan.
5. **Ne pas** committer sauf demande explicite.
6. **100 % local** : pas d'API externe pour la vidéo ; MediaPipe WASM uniquement.

## Hiérarchie des modules

```
App.jsx
  └── engine.js          ← point d’entrée session
        ├── pose.js      PoseTracker = PoseLandmarker + HandLandmarker (+ BodySegmenter lock)
        ├── poseVideo.js / handLandmarker.js / torsoAffine.js  ← stack labo couverture
        ├── segmentation.js + bodySegmenter.js
        ├── sessionCore.js   applyCalibration (partagé harness)
        │     ├── anchorShape.js
        │     ├── backWarp.js
        │     └── coverage.js
        ├── handGate.js      ContactVelocityGate seulement (plus de cascade Holistic paint)
        ├── backCalibration.js
        └── minimapCanvas.js
```

**Couverture (source de vérité)** = `?vidhands=1` : affine `xf.inv` + `contactsFromHandLandmarker` + `nearBackShape`.  
**Interdit en paint** : Holistic hands, `warpToLocked`, cascade poignet/coude.

## Vagues de travail (nettoyage V3)

| Vague | Objectif | Fichiers |
|-------|----------|----------|
| 0 Infra | debug minimap, DPR canvas, BUILD banner | `engine.js`, `App.jsx`, `index.html` |
| 1 Cleanup | supprimer dead code, `contourTrace.js` | `coverage.js`, `zones.js`, `tips.js`, `backCalibration.js` |
| 1 Core | `sessionCore.applyCalibration`, harness | `sessionCore.js`, `debug-harness.mjs` |
| 2 backWarp | wiring warp outline + body mask | `backWarp.js`, `coverage.js`, `engine.js` |
| 3 Tracking | coach dégradé, reposition continu | `handGate.js`, `engine.js`, `anchorShape.js` |
| Docs | README, ARCHITECTURE, DEPLOI, DEBUG | `*.md` |

## Validation agent

```bash
cd /Users/laurent/Desktop/suncoach
npm run build
node debug-harness.mjs
```

Les deux doivent réussir avant de considérer une vague terminée.

## Tests humains téléphone (obligatoires)

Voir section **phase0-tel-validate** dans le résumé de livraison agent :

- Accueil : bannière NETTOYAGE V3 + BUILD récent
- Session complète : scan → 8 points → reposition → couverture
- `?debug=1` : overlay jaune minimap
- Done screen : contour warp (pas mannequin générique)

## Fichiers supprimés (ne pas recréer)

- `contourTrace.js` — remplacé par calibration photo + `backWarp`
- Ancien calibrage geste 8 étapes live (`evaluateCalibrationStep`, etc.)

## Conventions code

- Français pour voix / HUD utilisateur
- Imports ESM `.js` explicites
- Pas de sur-abstraction : diff minimal, réutiliser `applyCalibration` partout

## Prochaine session — attaque directe

**État validé (labo `?vidhands=1`) — ne pas casser :**
- Play · **stand-still** (~1,5 s) → pause + tracer · Start tracking (lock peau)
- Suivi dos : `torsoAffine.js` (similarité d’abord, garde anti-tube vertical)
- Hands : `handLandmarker.js` (VIDEO) + UV via `toWarpPixel = xf.inv`
- Couverture : `CoverageGrid(THOROUGH_PIXEL_NEED=0.42)` · heat live + minimap · % touché / validé · sévérité centre
- Contour haut : `buildDensifiedPolygon` dans `backWarp.js` (arcs nuque↔épaules, tip générique y=0)
- Bords peau : `skinEdgeRefine.js` au START TRACKING (échantillon Lab + snap ancres, une fois)
- Stand-still : `standStill.js` pendant PLAY avant les 8 points

**Entrée de travail :**
```
npm run build && npm run preview
→ http://localhost:…/?vidhands=1
```
Vidéo test locale : `public/IMG_3805.mp4` (gitignorée — H.264). Sinon bouton VIDÉO.
Accueil : bouton labo vidéo / `?frames=1` / `?lab=1`.

**Prochaine brique :**
> Soak téléphone / replay session. Stand-still + peauxnap dans le flux produit si besoin.
> Voix coach v2 (note ci-dessous).

### Notes design

**Couverture session** — portée depuis le labo (2026-07-15) : Pose+Hands+affine. `?vidhands=1` = non-régression.

**Couleur bords** — lock une fois (`refineBackAnchorsFromFrame`).

**Stand-still** — validé labo (~1,5 s → pause + tracer). Clic manuel = backup.

**Voix coach v2 (à faire plus tard — brief Laurent 2026-07-15)**  
Aujourd’hui : `voice.js` = Web Speech API, phrases figées / un peu robotiques.  
Objectif : plus **fluide** et **joli à l’oreille** que la version produit actuelle.

Piste retenue (hybride) :
1. Le moteur décide l’**intention** (ex. `gap:colonne`, `standstill`, `reposition`) — règles, pas LLM.
2. Un **petit reformulateur** (templates riches OU petit LLM) produit 1 phrase naturelle FR, avec cooldown / anti-répétition.
3. Synthèse : monter en gamme TTS (**voix neurales** navigateur si dispo, ou TTS cloud optionnel) — c’est souvent **plus audible** qu’un LLM seul sur du vieux `speechSynthesis`.

Contraintes SunCoach : aujourd’hui « 100 % local » (AGENTS) → LLM/TTS cloud = option explicite / mode connecté, ou rester local (templates + meilleure voix système). Latence coach : reformulation doit rester < ~300–500 ms ou phrases pré-générées / cache par intention.

Ne pas brancher ça avant port moteur labo → session.

**Hors scope immédiat :** anti-phone-shake fin + voix v2 tant que port `engine.js` pas cadré.

**Fichiers clés labo :**
| Fichier | Rôle |
|---------|------|
| `src/VideoHandLab.jsx` | UI + tick tracking/peinture |
| `src/lib/torsoAffine.js` | attach dos MediaPipe |
| `src/lib/handLandmarker.js` | Hands VIDEO |
| `src/lib/coverage.js` | heat, `THOROUGH_PIXEL_NEED` |
| `src/lib/poseVideo.js` | PoseLandmarker VIDEO |
| `src/lib/backWarp.js` | UV ↔ pixels (contour densifié) |
| `src/lib/skinEdgeRefine.js` | snap couleur bords au lock |
| `src/lib/standStill.js` | dos immobile → pause + prompt tracer |
| `src/lib/bodySegmenter.js` | mask personne (piste, pas labo vidhands) |
