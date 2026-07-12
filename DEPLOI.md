# Déploiement SunCoach (GitHub Pages)

## Réglage obligatoire (une fois)

1. **Settings → Pages** du repo
2. **Build and deployment → Source** : **GitHub Actions** (pas « Deploy from a branch »)
3. Sauvegarder

## Publier

Chaque push sur `main` lance **Deploy to GitHub Pages** (`.github/workflows/deploy.yml`).

```bash
git push origin main
```

Attendre le run vert dans **Actions** (2–3 min).

## Vérifier la version live

### Sur l'accueil du site

- Bannière : **SUNCOACH · NETTOYAGE V3 — DOCS + DEBUG**
- Sous-texte : **BUILD …** (horodatage ISO, généré par `vite.config.js`)

### Via curl (sans navigateur)

```bash
# Remplacer par l'URL GitHub Pages du repo
curl -sL 'https://<user>.github.io/suncoach/' | grep -o 'NETTOYAGE V3'
curl -sL 'https://<user>.github.io/suncoach/' | grep -o 'BUILD [^<]*'
```

Si la bannière ou le BUILD ne correspondent pas au dernier commit :

1. Vérifier que le workflow Actions est vert
2. Vider le cache navigateur ou forcer rechargement
3. Les meta cache dans `index.html` :
   - `Cache-Control: no-cache, no-store, must-revalidate`
   - `Pragma: no-cache`
   - `Expires: 0`

## Test local (build uniquement)

```bash
npm ci
npm run build
node debug-harness.mjs
npx vite preview   # optionnel, sert dist/ en local
```

**Ne pas** utiliser `npm run dev` pour valider le déploiement — le BUILD affiché vient du build Vite.

## Rollback

Revenir à un commit précédent sur `main` et pousser ; le workflow redéploie automatiquement.
