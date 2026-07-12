# SunCoach — Revue critique & pistes d'amélioration
*Généré le 11 juillet 2026 — lecture croisée du brief technique v1 + vérifications web. À renvoyer par sections à Composer 2, pas en un bloc.*

## 0. Méthode

Ce document ne prend pas le brief pour argent comptant. Pour chaque hypothèse déjà posée dans le brief, je l'ai soit confirmée (avec source), soit complétée, soit contestée. Les nouvelles pistes sont marquées **[NOUVEAU]**.

---

## 1. Vérification de la stack

| Affirmation du brief | Vérifié ? | Note |
|---|---|---|
| "MediaPipe Holistic (@mediapipe/tasks-vision)" | ✅ Exact | `HolisticLandmarker` existe bien dans le package Tasks Vision, combine pose+face+mains. Mais Google qualifie encore cette tâche de "preview en accès anticipé" (early release) — moins mature que les tasks individuelles (PoseLandmarker, HandLandmarker) qui existent séparément depuis plus longtemps. |

**[NOUVEAU] Piste à évaluer** : dégrouper `HolisticLandmarker` en `PoseLandmarker` + `HandLandmarker` séparés. Deux avantages concrets :
- Chaque modèle peut être réglé indépendamment (ex : pose en `model_complexity` léger pour la vitesse, mains en modèle "full" pour la précision — impossible à découpler dans le bundle Holistic).
- Vous reprenez la main sur le calcul de la ROI des mains plutôt que de dépendre de l'heuristique interne de Holistic (voir section 3 — c'est justement cette heuristique qui pose problème).

---

## 2. Problème #1 — Minimap "écrasée" : diagnostic élargi

Les fixes déjà tentés (bbox layout, letterbox viewport, ratio CSS fixe) sont les bons réflexes mais n'épuisent pas le sujet. Deux pistes supplémentaires :

### 2a. [NOUVEAU] Vérifier le devicePixelRatio en premier — c'est gratuit à tester

Le bug canvas le plus classique : si `canvas.width`/`canvas.height` (résolution réelle) et `canvas.style.width`/`height` (taille CSS affichée) ne sont pas mis à l'échelle par le **même** facteur sur les deux axes, l'image s'écrase ou s'étire. C'est le genre de bug qui n'apparaît que sur téléphone (devicePixelRatio ≠ 1, souvent 2 ou 3 sur mobile) — cohérent avec "testé uniquement sur tel".

Test à 2 lignes à ajouter temporairement dans la bannière de version :
```js
console.log('canvas', c.width, c.height, 'style', c.style.width, c.style.height, 'dpr', window.devicePixelRatio);
```
Si le ratio largeur/hauteur diffère entre `canvas.width/height` et `canvas.style.width/height`, c'est ça le bug — pas la logique UV.

### 2b. Le vrai sujet structurel (l'hypothèse du brief est la bonne, mais incomplète)

Le brief pointe déjà : *"mismatch UV layout vs back UV [...] zones anatomiques en UV 0–1 générique"*. C'est très probablement la cause principale, et voici pourquoi le patch actuel ne suffira pas : vous avez **deux systèmes de coordonnées qui cohabitent** — un layout bbox+padding calculé depuis les 8 points réels, et des zones anatomiques (`ANATOMICAL_ZONES`) définies en UV 0–1 générique en supposant un mannequin standard. Tant que ces deux systèmes ne sont pas unifiés, n'importe quel dos qui s'écarte des proportions du mannequin générique va donner une minimap visuellement "fausse" par rapport à la peinture réelle — même si le canvas lui-même est parfaitement carré.

**[NOUVEAU] La solution propre, pas un rustine de plus** : un **warp affine par morceaux** (piecewise affine warp) via triangulation de Delaunay sur vos 8 points d'ancrage. C'est la technique standard en vision par ordinateur pour exactement ce problème — projeter un masque/template générique sur une forme détectée définie par des points de contrôle (utilisé en face-warping, virtual try-on vêtements, etc.). Concrètement :

1. Trianguler vos 8 ancres (nuque, épaules, milieux, reins, bas) → ça donne ~6-8 triangles qui pavent le dos.
2. Faire la même triangulation sur un dos "de référence" en UV 0–1.
3. Une seule fonction `warpPoint(p)` qui, pour n'importe quel point (une zone anatomique, un pixel de heatmap, un contact de main), trouve son triangle et applique la transformation affine correspondante.

Tout — `ANATOMICAL_ZONES`, la peinture heatmap, le contour — passe alors par **la même** fonction de mapping. Fini le doublon layout-custom vs UV-générique. C'est plus de travail qu'un patch de padding, mais ça règle la classe de bug entière plutôt qu'un symptôme.

### 2c. Debug peu coûteux, sans dépendre du tel

Ajouter un mode debug qui dessine les 8 points bruts + le bbox calculé directement sur la minimap (juste des cercles + un rectangle en overlay). Un seul screenshot tel suffit alors à voir si le problème vient de la détection des points, du calcul du layout, ou du rendu — au lieu de deviner à l'aveugle à chaque push.

---

## 3. Problème #3 — Tracking mains en haut du dos

### 3a. La cause racine est documentée, pas juste "une limite floue de MediaPipe"

Une recherche publiée (Moryossef, Université de Zurich / sign.mt, spécialiste reconnu en traitement de la langue des signes) identifie précisément ce défaut : l'heuristique de MediaPipe Holistic pour recadrer la région des mains à partir des points de pose a été conçue en supposant que le plan de la main est parallèle à la caméra. Or une main qui remonte dans le dos est presque toujours de profil / très raccourcie / tournée par rapport à la caméra — exactement le cas que l'heuristique gère mal. Ce n'est donc pas un manque de réglage de votre côté : c'est une limite connue du recadrage interne de Holistic.

Un correctif open source partiel existe : `sign-language-processing/mediapipe-hand-crop-fix` sur GitHub — il enrichit le calcul de la ROI avec plus de points clés et la dimension z. À évaluer si vous dégroupez Holistic (voir 1).

### 3b. [NOUVEAU] Exploiter les scores de confiance déjà présents dans l'API

Chaque landmark MediaPipe expose un score `visibility` et `presence` (0–1, probabilité que le point soit visible et non occlus). Actuellement `handGate.js` semble faire du gating binaire (crédible / pas crédible). Proposition : exposer ce score en continu comme un état de confiance qui pilote un **mode dégradé explicite** — quand la confiance s'effondre (typique en haut du dos), basculer automatiquement d'un coaching "position précise peinte au pixel" vers un coaching "zone générale + geste" moins précis mais qui ne ment pas à l'utilisateur. Mieux vaut un feedback grossier mais honnête qu'un point qui saute partout.

### 3c. [NOUVEAU] Piste plus lourde, à garder en réserve

Fusionner la vision avec les capteurs de mouvement du téléphone (accéléromètre/gyroscope, `DeviceMotionEvent`/`DeviceOrientationEvent`) pour au moins détecter *qu'*un geste de frottement a lieu dans une zone approximative, même quand la caméra perd la main. Ce n'est pas un fix rapide — c'est un axe à explorer seulement si le mode dégradé (3b) ne suffit pas à rendre l'expérience acceptable.

---

## 4. Problème #2 — Reposition trop stricte

Ici, je pense que le brief se trompe de diagnostic : ce n'est pas vraiment un problème de précision de tracking, c'est un problème de **seuil binaire dans l'UX**. Un match de pose "réussi/échoué" (même en mode approx) crée mécaniquement une frustration, quel que soit le réglage du seuil — parce que l'utilisateur ne sait jamais *pourquoi* ça échoue ni de combien il est loin.

**[NOUVEAU] Proposition** : ne jamais bloquer complètement l'entrée en coverage. À la place, calculer un score de correspondance continu (distance à la pose de référence) et moduler l'intensité du feedback vocal en fonction — "encore un peu à gauche" plutôt qu'un simple pass/fail. Le bouton "C'EST BON" reste en filet de sécurité, mais devient rarement nécessaire si le système guide en continu au lieu de juger en tout-ou-rien.

---

## 5. Problème #4 — Déploiement stale

Confirmé par la recherche : c'est une classe de bug extrêmement fréquente et documentée, pas une spécificité de votre setup — trois couches de cache différentes s'accumulent (navigateur, CDN Fastly de GitHub Pages, et parfois un run GitHub Actions qui échoue silencieusement sans que "push origin main" ne le signale). Checklist pour couper court au diagnostic :

1. **Vérifier l'onglet Actions du repo directement** (pas juste recharger le tel) — un build qui échoue silencieusement donnera l'impression que "rien n'a été pris en compte" alors que le déploiement n'a simplement pas eu lieu.
2. **Contourner tous les caches d'un coup** : `curl -H "Cache-Control: no-cache" https://sfsanter.github.io/suncoach/` pour voir ce qui est réellement servi, sans dépendre du comportement du navigateur du tel.
3. **Point spécifique à Vite** : les chunks JS/CSS sont hashés (donc jamais de cache stale sur eux), mais **`index.html` lui, ne l'est pas** — c'est presque toujours lui qui reste coincé en cache CDN/navigateur. Ajouter des meta no-cache dédiées sur `index.html` ou un query-string de version generée au build réglerait spécifiquement ce point, sans toucher au reste.
4. Hard-refresh / navigation privée en dernier recours de vérification rapide, pas comme solution.

---

## 6. Prior art / marché

Recherche des apps solaires existantes : aucune ne fait de guidage temps réel par pose sur son propre dos. Les apps du marché (SunSense, SunCare, Sunscreened, etc.) utilisent soit une caméra sensible UV en accessoire matériel (visualisation après-coup, pas de guidage geste par geste), soit une simple analyse de selfie statique. Le principe de SunCoach — guider le geste en direct via tracking de pose — est donc un territoire réellement inexploré : bonne nouvelle pour l'originalité, mauvaise nouvelle pour trouver une lib ou un playbook tout fait à copier. Les difficultés rencontrées (section 3) ne viennent pas d'un mauvais réglage — personne n'a encore résolu proprement ce cas d'usage.

---

## 7. [NOUVEAU] Suggestion transversale : un harnais de test hors-caméra

Contrainte actuelle : test uniquement sur tel après push. Mais les problèmes #1 (minimap) et #3 (tracking) sont, une fois les landmarks/ancres connus, des problèmes de **traitement de données**, pas de capture live. Proposition : enregistrer une fois une courte séquence de référence (photo figée + set d'ancres + quelques positions de main simulées), puis rejouer cette séquence localement à travers `engine.js` (headless, sans caméra) pour itérer sur la logique minimap/heatmap/zones bien plus vite que le cycle push→attendre→recharger sur tel. Ça ne remplace pas le test tel pour les problèmes #2 et #3 (qui dépendent réellement du geste live), mais ça réduit drastiquement le nombre de push nécessaires pour le problème #1 — ce qui sert directement votre propre règle "changements minimaux, un fix à la fois, push entre chaque test".

---

## 8. Comment découper ça pour Composer 2

Composer 2 gère mieux une tâche à la fois. Ordre suggéré, à copier-coller séparément :

1. **Section 2c** (overlay debug minimap) — diagnostic pur, aucun risque de régression, à faire en premier.
2. **Section 2a** (check devicePixelRatio) — 5 minutes, élimine ou confirme une piste.
3. **Section 2b** (warp triangulé) — le vrai chantier, à ne lancer qu'une fois 2a/2c aient confirmé que le problème est bien le mismatch UV et pas autre chose.
4. **Section 3b** (mode dégradé par confiance) — indépendant du reste, peut se faire en parallèle.
5. **Section 4** (seuil continu reposition) — indépendant, UX pure.
6. **Section 5** (checklist déploiement) — à traiter à part, hors logique produit.

Ne pas donner la section 3c (fusion capteurs) à Composer 2 sans en discuter d'abord — c'est un choix d'architecture, pas un fix.

---

## 9. Implémentation concrète (code prêt à adapter)

Même ordre que la section 8. Chaque bloc indique le fichier cible.

### 9.1 — Overlay debug minimap (`engine.js`, dans `_drawMinimap`)

```js
// À appeler juste après le rendu normal de la minimap, derrière un flag
const DEBUG_ANCHORS = true; // passer à false avant de livrer

function _drawDebugOverlay(ctx, customAnchorsByName, layoutBbox) {
  if (!DEBUG_ANCHORS) return;
  ctx.save();
  ctx.strokeStyle = 'red';
  ctx.lineWidth = 1;
  ctx.strokeRect(layoutBbox.x, layoutBbox.y, layoutBbox.w, layoutBbox.h);
  Object.entries(customAnchorsByName).forEach(([name, p]) => {
    ctx.fillStyle = 'yellow';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'white';
    ctx.font = '8px sans-serif';
    ctx.fillText(name, p.x + 4, p.y);
  });
  ctx.restore();
}
```
Un seul screenshot tel après ça te dit immédiatement si les 8 points sont bien où tu penses qu'ils sont, et si le bbox correspond visuellement à la silhouette peinte à côté.

### 9.2 — Fix devicePixelRatio (`engine.js` ou `App.jsx`, setup du canvas minimap)

```js
function setupMinimapCanvas(canvas, cssWidth = 110, cssHeight = 150) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // dessiner ensuite en coordonnées "logiques" 110x150
  return ctx;
}
```
⚠️ `setTransform` doit être réappliqué à chaque fois que `canvas.width`/`height` sont réassignés (ça réinitialise le contexte). La grille interne 36×48 de `coverage.js` n'a pas besoin de changer — c'est juste la résolution du buffer de données, indépendante de la taille d'affichage.

### 9.3 — Warp triangulé unifié (nouveau fichier `backWarp.js`, utilisé par `anchorShape.js`, `coverage.js`, `engine.js`)

```js
// Ordre du contour déjà défini dans le brief — ne pas changer sans retoucher les 8 points
const CONTOUR_ORDER = [
  'nuque', 'epaule_g', 'milieu_g', 'rein_g',
  'bas', 'rein_d', 'milieu_d', 'epaule_d',
];

function centroid(points) {
  const n = points.length;
  const s = points.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y }), { x: 0, y: 0 });
  return { x: s.x / n, y: s.y / n };
}

// Triangulation en éventail depuis le centroïde : pas de lib externe, topologie
// garantie identique entre le dos réel et le gabarit générique (dépend seulement
// de CONTOUR_ORDER, jamais recalculée point par point comme le ferait un vrai Delaunay).
function buildFanTriangles(anchorsByName) {
  const ordered = CONTOUR_ORDER.map((name) => anchorsByName[name]);
  const c = centroid(ordered);
  const triangles = [];
  for (let i = 0; i < ordered.length; i++) {
    const a = ordered[i];
    const b = ordered[(i + 1) % ordered.length];
    triangles.push([c, a, b]);
  }
  return triangles; // toujours 8 triangles, même ordre quel que soit le dos
}

function affineFromTriangle(srcTri, dstTri) {
  const [s0, s1, s2] = srcTri;
  const [d0, d1, d2] = dstTri;
  const x1 = s1.x - s0.x, y1 = s1.y - s0.y;
  const x2 = s2.x - s0.x, y2 = s2.y - s0.y;
  const det = x1 * y2 - x2 * y1;
  if (Math.abs(det) < 1e-9) return null; // ancres alignées, triangle dégénéré
  return (p) => {
    const px = p.x - s0.x, py = p.y - s0.y;
    const a = (px * y2 - py * x2) / det;
    const b = (py * x1 - px * y1) / det;
    return {
      x: d0.x + a * (d1.x - d0.x) + b * (d2.x - d0.x),
      y: d0.y + a * (d1.y - d0.y) + b * (d2.y - d0.y),
    };
  };
}

function pointInTriangle(p, [a, b, c]) {
  const d1 = (p.x - b.x) * (a.y - b.y) - (a.x - b.x) * (p.y - b.y);
  const d2 = (p.x - c.x) * (b.y - c.y) - (b.x - c.x) * (p.y - c.y);
  const d3 = (p.x - a.x) * (c.y - a.y) - (c.x - a.x) * (p.y - a.y);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

// ⚠️ À AJUSTER : ces UV doivent correspondre à la convention déjà utilisée par
// ANATOMICAL_ZONES dans zones.js — copier les mêmes proportions, pas ces valeurs au hasard.
const GENERIC_UV_ANCHORS = {
  nuque:    { x: 0.50, y: 0.04 },
  epaule_g: { x: 0.14, y: 0.14 },
  epaule_d: { x: 0.86, y: 0.14 },
  milieu_g: { x: 0.08, y: 0.50 },
  milieu_d: { x: 0.92, y: 0.50 },
  rein_g:   { x: 0.18, y: 0.82 },
  rein_d:   { x: 0.82, y: 0.82 },
  bas:      { x: 0.50, y: 0.96 },
};

// UNE seule fonction, utilisée par la peinture heatmap, les zones anatomiques ET le contour.
export function buildBackWarp(customAnchorsByName, genericAnchorsByName = GENERIC_UV_ANCHORS) {
  const customTris = buildFanTriangles(customAnchorsByName);
  const genericTris = buildFanTriangles(genericAnchorsByName);

  function mapVia(triSetA, triSetB, point) {
    for (let i = 0; i < triSetA.length; i++) {
      if (pointInTriangle(point, triSetA[i])) {
        const warp = affineFromTriangle(triSetA[i], triSetB[i]);
        if (warp) return warp(point);
      }
    }
    return null; // hors silhouette
  }

  return {
    // pixel réel (photo figée) -> UV générique — pour peindre la heatmap au bon endroit relatif
    toGenericUv: (pixelPoint) => mapVia(customTris, genericTris, pixelPoint),
    // UV générique -> pixel réel — pour placer une zone anatomique sur CE dos précis
    fromGenericUv: (uvPoint) => mapVia(genericTris, customTris, uvPoint),
  };
}
```

**Branchement** : dans `confirmAdjustment()` (à côté de `setMinimapLayout()`), appeler `const backWarp = buildBackWarp(customAnchorsByName)` et stocker `backWarp` sur l'engine. Remplacer ensuite tous les appels à `_toPaintUv()` et toute conversion manuelle UV dans `coverage.js` par `backWarp.toGenericUv(...)` / `backWarp.fromGenericUv(...)`. C'est le changement qui élimine le double système de coordonnées.

### 9.4 — Mode dégradé par confiance (`handGate.js` + `engine.js`)

```js
// handGate.js
export function handConfidence(handLandmarks, poseLandmarks, wristIdx, elbowIdx) {
  const wristVis = poseLandmarks?.[wristIdx]?.visibility ?? 0;
  const elbowVis = poseLandmarks?.[elbowIdx]?.visibility ?? 0;
  if (handLandmarks?.length) {
    const avg = handLandmarks.reduce((s, l) => s + (l.visibility ?? l.presence ?? 0), 0) / handLandmarks.length;
    return avg;
  }
  return wristVis * 0.6 + elbowVis * 0.4; // repli sur poignet/coude si la main est perdue
}
```

```js
// engine.js — bascule avec hystérésis pour éviter le clignotement frame à frame
const CONF_HIGH = 0.6;
const CONF_LOW = 0.35;

function updateCoachMode(confidence, currentMode) {
  if (currentMode === 'precise' && confidence < CONF_LOW) return 'degraded';
  if (currentMode === 'degraded' && confidence > CONF_HIGH) return 'precise';
  return currentMode;
}
```
En mode `precise` : peindre le point exact via `backWarp`. En mode `degraded` : allumer toute la zone anatomique la plus proche (via `ANATOMICAL_ZONES`, pas un pixel précis) et faire dire à `voice.js` une consigne de zone ("côté gauche, plus haut") plutôt qu'une consigne de position. Un feedback grossier mais honnête vaut mieux qu'un point qui saute.

### 9.5 — Reposition à seuil continu (`anchorShape.js` / logique de reposition)

```js
function comparePoseSignatureContinuous(liveSig, lockedSig, keyJoints, maxAcceptableDiff) {
  const diffs = keyJoints.map((j) => distance(liveSig[j], lockedSig[j]));
  const meanDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  return Math.max(0, Math.min(1, 1 - meanDiff / maxAcceptableDiff)); // 0 = loin, 1 = aligné
}

function shouldEnterCoverage(score, stableFrames, framesRequired = 15) {
  const next = score > 0.5 ? stableFrames + 1 : 0;
  return { entered: next > framesRequired, stableFrames: next };
}
```
`voice.js` interpole ses instructions directionnelles sur ce score continu au lieu de basculer entre deux modes strict/approx — le bouton "C'EST BON" reste en filet de sécurité.

### 9.6 — Déploiement (pas de code métier, juste de la robustesse de build)

`index.html` :
```html
<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate" />
<meta http-equiv="Pragma" content="no-cache" />
<meta http-equiv="Expires" content="0" />
```

Vérification directe sans dépendre du tel :
```bash
curl -s -H "Cache-Control: no-cache" https://sfsanter.github.io/suncoach/ | grep -o 'BUILD[^<]*'
```
Si le BUILD ID renvoyé ne correspond pas au dernier commit, le problème est confirmé côté build/CDN, pas côté cache navigateur — inutile de continuer à vider le cache du tel.

### 9.7 — Harnais de test hors-caméra (nouveau fichier `debug-harness.mjs`, à la racine)

```js
// node debug-harness.mjs — rejoue une séquence figée sans navigateur ni caméra
import { SunCoachEngine } from './src/lib/engine.js';

const fixedAnchors = { /* un jeu d'ancres capturé une fois sur tel, collé ici en dur */ };
const scriptedFrames = [ /* positions de main simulées, frame par frame */ ];

const engine = new SunCoachEngine({ headless: true });
engine.confirmAdjustment(fixedAnchors);
scriptedFrames.forEach((frame) => engine.processHandFrame(frame));
console.log(engine.getHeatmapSnapshot());
```
Condition pour que ça marche : `engine.js` ne doit pas dépendre directement du DOM (canvas, `<video>`) dans sa logique de calcul — seulement dans son rendu. Si ce n'est pas encore le cas, c'est le premier refactor à faire : séparer "calcul" (transformable, testable ici) de "dessin" (reste dans le navigateur). Ça vaut le coup rien que pour accélérer l'itération sur 9.3.

