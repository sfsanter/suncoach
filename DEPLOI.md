# Déployer SunCoach sur GitHub Pages

## Réglage obligatoire (une seule fois)

1. Ouvre **Settings → Pages** du repo
2. **Build and deployment → Source** : choisis **GitHub Actions** (pas « Deploy from a branch »)
3. Sauvegarde

## Publier une mise à jour

Chaque push sur `main` lance le workflow **Deploy to GitHub Pages**.

Vérifie sur l’accueil du site :
- bannière **VERSION LIVE — MODE LIBRE**
- texte **BUILD … — MODE LIBRE**

Si tu entends encore « zone suivante », le site sert une vieille version : va dans **Actions**, ouvre le dernier run vert, et attends 2–3 minutes.

## Test local immédiat

```bash
npm install
npm run dev
```
