# Architecture SunCoach

## Machine à états (`engine.js`)

```
idle → placement → locking → adjusting → reposition → coverage → done
```

| État | Caméra live | Masque / schéma | UI |
|------|-------------|-----------------|-----|
| `placement` | oui | segmentation légère (morpho) | overlay pose |
| `locking` | oui | accumulation masque IA | overlay scan % |
| `adjusting` | pause visuelle | masque figé | `PointAdjustScreen` (8 points) |
| `reposition` | oui | masque figé | HUD score pose |
| `coverage` | oui | warp + masque figé | minimap + overlay |

## Figé vs live

| Donnée | Figé (scan + calibration) | Live (chaque frame) |
|--------|---------------------------|---------------------|
| `calibrationFrame` | clone au lock | — |
| `frozenMask` / `frozenPoseP` | au lock | — |
| `calibrationAnchors` + `backWarp` | à `confirmAdjustment` | — |
| `lockedPoseSignature` | au lock | comparé en reposition |
| Pose / mains | — | `HolisticLandmarker` |
| Contacts peinture | warp depuis repère figé | `warpToLocked(live → locked)` |

Le schéma minimap **ne bouge plus** après validation des 8 points. Seule la pose live est projetée dedans.

## Fichiers clés

```
src/
  App.jsx              écrans home / session / done
  lib/
    engine.js          boucle session, rendu, couverture
    pose.js            HolisticLandmarker (pose + mains + seg légère)
    bodySegmenter.js   segmenter IA (scan locking uniquement)
    segmentation.js    silhouette, contour, overlay
    maskLock.js        moyenne masque + extractContour (TRACE_BINS)
    anchorShape.js     8 points px, layout, comparePoseSignature
    backWarp.js        warp affine par éventail → UV générique
    sessionCore.js     applyCalibration (testable Node)
    backCalibration.js ANCHOR_ORDER, gestes anchor-assistés
    coverage.js        heatmap, bodyMask, paintZone, zones
    handGate.js        crédibilité main, coachMode dégradé
    minimapCanvas.js   DPR canvas, ?debug=1
    zones.js           7 zones anatomiques
    tips.js            voix gaps + reposition
    voice.js           TTS + beeper
debug-harness.mjs      tests hors DOM
```

## Pipeline calibration

```
draftAnchorsPx (photo)
  → applyCalibration() [sessionCore]
      → pixelsToBackAnchors
      → buildMinimapLayout
      → buildBackWarp → setBackWarp
      → setCustomBackAnchors
  → reposition (comparePoseSignature continu)
  → coverage (paint via warp.insideGeneric)
```

## Open issues

- **Nuque hors masque IA** : extension heuristique dans `insideBackShape` si `tracedContour`.
- **Dos très oblique** : `BackOrientation` avertit mais ne bloque pas.
- **Mains dos tourné** : mode `degraded` + `anchorAssistedContacts` pour le haut du dos.
- **Safari iOS** : vérifier wake lock et `speechSynthesis` après verrouillage écran.
- **Cache GitHub Pages** : meta `Cache-Control` + `Expires` dans `index.html` ; vérifier BUILD sur accueil.
