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
  └── engine.js          ← point d'entrée session
        ├── pose.js      HolisticLandmarker
        ├── segmentation.js + bodySegmenter.js
        ├── sessionCore.js   applyCalibration (partagé harness)
        │     ├── anchorShape.js
        │     ├── backWarp.js
        │     └── coverage.js
        ├── handGate.js
        ├── backCalibration.js  (gestes anchor-assist, pas calibrage live 8 étapes)
        └── minimapCanvas.js
```

**Règle de dépendance** : `sessionCore` et `backWarp` ne doivent pas importer `engine` ni `pose` MediaPipe.

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
- Play/Pause · Tracer 8 points · Start tracking (lock une fois)
- Suivi dos : `torsoAffine.js` (similarité d’abord, garde anti-tube vertical)
- Hands : `handLandmarker.js` (VIDEO) + UV via `toWarpPixel = xf.inv`
- Couverture : `CoverageGrid(THOROUGH_PIXEL_NEED)` · heat live + minimap · % touché / validé

**Entrée de travail :**
```
npm run build && npm run preview
→ http://localhost:…/?vidhands=1
```
Vidéo test locale : `public/IMG_3805.mp4` (gitignorée — H.264). Sinon bouton VIDÉO.
Accueil : bouton labo vidéo / `?frames=1` / `?lab=1`.

**Prochaine brique (demandée, pas encore faite) :**
> Contour **progressif** assez **haut** sur le **haut du dos** (nuque / trapèzes) —
> aujourd’hui le polygone / masque coupe trop bas ou trop plat en haut.
> Valider dans `VideoHandLab` (overlay + minimap) avant de porter dans `engine.js`.

### Notes design (session 2026-07-14 — à retester, pas encore implémenté)

**Couverture trop stricte (feedback Laurent)**  
- `THOROUGH_PIXEL_NEED` (~×3,5 vs défaut) : le % **validé** reste à **0 %** longtemps alors que visuellement c’est déjà bien frotté.  
- Le % **touché** est plus fidèle à ce qu’on voit ; le validé est un filtre dur (« mieux trop que pas »).  
- **Action prochaine** : recalibrer aux tests (baisser un peu le seuil / pondérer touché vs validé / entre-deux). Ne pas toucher au produit Holistic tant que le labo n’a pas un réglage OK.

**Segmentation dos**  
- Segmenter **la personne** (MediaPipe-style) : possible, déjà exploré côté produit (`bodySegmenter`).  
- Segmenter **uniquement la surface crème du dos** : pas de modèle léger fiable en navigateur → toujours **heuristique** (pose ∩ masque ∩ 8 points).  
- Rôle utile : cadre / silhouette, pas remplacement des 8 points ni de la carte UV.

**Couleur similaire pour les bords (piste retenue à mix)**  
- Objectif : **affiner les bords** (nuque, flancs, haut du dos), pas remplacer le tracking.  
- Mix : 8 points + warp = forme globale → bande de bord → pixels **proches en couleur** de la peau (échantillon figé au **lock**, Lab/HSV).  
- Region growing / flood borné par polygone élargi, ou correcteur local sur le contour.  
- Pièges : ombre, crème blanche, main qui passe, lumière qui change → **échantillon lock**, pas tracking couleur 60 fps.  
- Bon combo cible pour la brique haut-du-dos : warp/8 pts + (option) mask personne + **couleur en correcteur de bord**.

**Hors scope immédiat :** brancher Hands+affine+couverture dans la session produit (`engine.js` Holistic) — uniquement après OK labo haut du dos + seuil couverture.

**Fichiers clés labo :**
| Fichier | Rôle |
|---------|------|
| `src/VideoHandLab.jsx` | UI + tick tracking/peinture |
| `src/lib/torsoAffine.js` | attach dos MediaPipe |
| `src/lib/handLandmarker.js` | Hands VIDEO |
| `src/lib/coverage.js` | heat, `THOROUGH_PIXEL_NEED` |
| `src/lib/poseVideo.js` | PoseLandmarker VIDEO |
| `src/lib/backWarp.js` | UV ↔ pixels (contour) |
| `src/lib/bodySegmenter.js` | mask personne (piste, pas labo vidhands) |
