# 🧴☀️ SunCoach

Assistant vocal pour mettre de la crème solaire **dans le dos**, sans oublier une zone.
Interface façon NERV (Neon Genesis Evangelion) grâce à [@mdrbx/nerv-ui](https://github.com/mdrbx/nerv-ui).

Pose ton téléphone, mets-toi dos à la caméra, et laisse-toi guider à la voix : l'app
suit tes mains grâce à [MediaPipe Pose](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker),
découpe ton dos en zones, et te dit où il manque de la crème — avec des conseils de
mouvements pour les zones difficiles (omoplates, milieu du dos…).

## Utilisation

1. Ouvre la page sur ton téléphone, monte le volume.
2. Cale le téléphone à hauteur de poitrine, recule d'environ 2 mètres, dos à la caméra.
3. Suis la voix. Des bips façon « radar de recul » t'indiquent si ta main approche
   d'une zone à couvrir. Un jingle sonne quand tout le dos est couvert.

## Technique

- React + Vite, UI : composants [@mdrbx/nerv-ui](https://www.npmjs.com/package/@mdrbx/nerv-ui) (Tailwind CSS).
- Détection de pose : MediaPipe Tasks Vision (`PoseLandmarker`, modèle lite) en
  WebAssembly/GPU, directement dans le navigateur.
- Voix : Web Speech API (`speechSynthesis`, fr-FR). Sons : WebAudio.
- Déploiement : GitHub Actions → GitHub Pages à chaque push sur `main`.
- Confidentialité : la vidéo est analysée localement, **rien n'est envoyé sur internet**.

## Développement local

```bash
npm install
npm run dev     # serveur de dev (la caméra exige HTTPS ou localhost)
npm run build   # build de production dans dist/
```
