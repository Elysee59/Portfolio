# Atelier Portfolio

Portfolio photographique éditorial avec stockage **Cloudinary** (images) + **Render.com** (serveur gratuit).

```
votre-app.onrender.com/        → exposition publique  ← lien pour bio Instagram/TikTok
votre-app.onrender.com/admin   → interface admin      ← votre espace de gestion
```

---

## Créer votre compte Cloudinary (gratuit)

1. Allez sur **https://cloudinary.com** → Sign Up (gratuit)
2. Plan gratuit : **25 Go de stockage**, **25 Go de bande passante/mois** — largement suffisant
3. Dans le dashboard, notez vos 3 valeurs :
   - **Cloud Name**
   - **API Key**
   - **API Secret**

---

## Déployer sur Render.com (gratuit, HTTPS auto)

### 1. Pousser sur GitHub

```bash
# Dans le dossier du projet :
git init
git add .
git commit -m "Atelier Portfolio v2 — Cloudinary"
git branch -M main
# Créer un repo sur github.com puis :
git remote add origin https://github.com/VOUS/atelier-portfolio.git
git push -u origin main
```

### 2. Créer le service sur Render

1. **https://render.com** → New → Web Service
2. Connecter le repo GitHub
3. Render détecte le Dockerfile automatiquement
4. Plan : **Free**

### 3. Variables d'environnement dans Render

Dashboard → votre service → **Environment** → Add Environment Variable :

| Variable                | Valeur                                             |
|-------------------------|----------------------------------------------------|
| `ADMIN_PASSWORD`        | votre mot de passe admin (ex: `MonPortfolio2024`)  |
| `JWT_SECRET`            | chaîne aléatoire (voir commande ci-dessous)        |
| `CLOUDINARY_CLOUD_NAME` | votre Cloud Name (depuis Cloudinary dashboard)     |
| `CLOUDINARY_API_KEY`    | votre API Key                                      |
| `CLOUDINARY_API_SECRET` | votre API Secret                                   |

**Générer un JWT_SECRET :**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 4. Déployer

Render lance le build automatiquement. En ~3 minutes vous avez :
- `https://votre-app.onrender.com` → page publique
- `https://votre-app.onrender.com/admin` → interface admin

### 5. Nom de domaine (optionnel)

Render → votre service → **Custom Domains** → ajouter `portfolio.votredomaine.com`
HTTPS Let's Encrypt activé automatiquement.

---

## Développement local

```bash
npm install

# Créer un fichier .env à la racine :
cat > .env << EOL
ADMIN_PASSWORD=atelier2024
JWT_SECRET=secret_local_dev
CLOUDINARY_CLOUD_NAME=votre_cloud_name
CLOUDINARY_API_KEY=votre_api_key
CLOUDINARY_API_SECRET=votre_api_secret
EOL

# Lancer
node -r dotenv/config server/index.js
# ou avec Docker :
docker compose up
```

---

## Utilisation quotidienne

```
1. votre-app.onrender.com/admin
2. Entrer votre mot de passe
3. Glisser-déposer vos photos (JPG, PNG, WebP, HEIC...)
   → stockées instantanément sur Cloudinary
4. Réordonner par glisser-déposer
5. Cliquer "Publier l'exposition"
   → visible immédiatement sur la page publique
```

---

## Architecture

```
atelier-portfolio/
├── server/index.js      ← API Node.js + intégration Cloudinary
├── public/
│   ├── expo/index.html  ← page publique (WebGL, layout éditorial)
│   └── admin/index.html ← interface admin (upload, ordre, publication)
├── Dockerfile
├── docker-compose.yml
├── render.yaml
└── package.json
```

**Flux des données :**
```
Admin uploade photo
  → multer-storage-cloudinary → Cloudinary (stockage permanent)
  → server enregistre { id, cloudinaryId, nom, dimensions } dans photos.json
  → photos.json sauvegardé aussi sur Cloudinary (raw) → survit aux redémarrages

Visiteur ouvre la page publique
  → GET /api/photos → serveur retourne les URLs Cloudinary (avec fetch_format:auto)
  → Cloudinary sert les images en WebP/AVIF si supporté → chargement rapide
```

---

## Ce qui est gratuit

| Service      | Plan gratuit                          |
|--------------|---------------------------------------|
| Render.com   | 750h/mois (1 service = toujours actif)|
| Cloudinary   | 25 Go stockage, 25 Go bande passante  |
| HTTPS        | Inclus automatiquement                |
| Sous-domaine | `xxxx.onrender.com` inclus            |
