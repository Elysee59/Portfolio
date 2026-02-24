'use strict';

const express    = require('express');
const multer     = require('multer');
const jwt        = require('jsonwebtoken');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const path       = require('path');
const crypto     = require('crypto');
const fs         = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

/* ══════════════════════════════════════════
   CONFIG
══════════════════════════════════════════ */
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'atelier2024';
const JWT_SECRET     = process.env.JWT_SECRET     || crypto.randomBytes(32).toString('hex');

// Cloudinary — variables d'env obligatoires en prod
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure:     true,
});

/* ══════════════════════════════════════════
   BASE DE DONNÉES JSON
   Stockée sur disque local pour la liste/ordre/état publié.
   Les binaires images sont sur Cloudinary.
   → Sur Render Free : la DB est en mémoire (tableau JS).
     Elle résiste aux redémarrages si on ajoute un disque.
     Sans disque = la liste est perdue au redémarrage,
     mais les images restent sur Cloudinary.
   Solution robuste : on stocke la DB aussi dans Cloudinary
   (comme fichier JSON dans un dossier privé).
══════════════════════════════════════════ */
const DB_FOLDER    = process.env.UPLOADS_DIR || path.join(__dirname, '..', 'uploads');
const DB_FILE      = path.join(DB_FOLDER, 'photos.json');
const DB_CLD_ID    = 'atelier-portfolio/db/photos'; // public_id dans Cloudinary

fs.mkdirSync(DB_FOLDER, { recursive: true });

// Lire depuis disque d'abord, sinon depuis Cloudinary (fallback)
async function readDB() {
  // 1. Essayer le fichier local
  try {
    if (fs.existsSync(DB_FILE)) {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch(e) {}

  // 2. Fallback : récupérer depuis Cloudinary (raw upload)
  try {
    const url = cloudinary.url(DB_CLD_ID, { resource_type: 'raw', format: 'json' });
    const { default: fetch } = await import('node-fetch');
    const r = await fetch(url);
    if (r.ok) {
      const data = await r.json();
      // Mettre en cache localement
      fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
      return data;
    }
  } catch(e) {
    console.warn('Cloudinary DB fallback failed:', e.message);
  }

  return [];
}

// Écrire sur disque ET sauvegarder sur Cloudinary
async function writeDB(data) {
  const json = JSON.stringify(data, null, 2);

  // 1. Disque local
  try { fs.writeFileSync(DB_FILE, json); } catch(e) {}

  // 2. Cloudinary (raw) — la DB survit aux redémarrages même sans disque
  try {
    const tmp = path.join(DB_FOLDER, '_db_tmp.json');
    fs.writeFileSync(tmp, json);
    await cloudinary.uploader.upload(tmp, {
      public_id:     DB_CLD_ID,
      resource_type: 'raw',
      overwrite:     true,
    });
    fs.unlinkSync(tmp);
  } catch(e) {
    console.warn('Cloudinary DB save failed:', e.message);
  }
}

/* ══════════════════════════════════════════
   MULTER → CLOUDINARY
   Les images uploadées vont directement dans
   Cloudinary, sans jamais toucher le disque local.
══════════════════════════════════════════ */
const cldStorage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => ({
    folder:         'atelier-portfolio/photos',
    // Conserver le format original (pas de conversion)
    format:         undefined,
    // ID unique
    public_id:      crypto.randomBytes(14).toString('hex'),
    // Pas de transformation à l'upload — on garde l'original
    transformation: [],
    // Accès public
    type:           'upload',
  }),
});

const upload = multer({
  storage: cldStorage,
  limits:  { fileSize: 40 * 1024 * 1024 }, // 40 Mo max
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(jpeg|jpg|png|webp|gif|avif|heic)$/.test(file.mimetype);
    cb(ok ? null : new Error('Type de fichier non supporté'), ok);
  },
});

/* ══════════════════════════════════════════
   MIDDLEWARE
══════════════════════════════════════════ */
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/admin', express.static(path.join(__dirname, '..', 'public', 'admin')));
app.use('/',      express.static(path.join(__dirname, '..', 'public', 'expo')));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

/* ══════════════════════════════════════════
   AUTH
══════════════════════════════════════════ */
function requireAuth(req, res, next) {
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Non authentifié' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch(e) { res.status(401).json({ error: 'Token invalide ou expiré' }); }
}

/* ══════════════════════════════════════════
   HELPER — URL Cloudinary optimisée
   → Sert l'image dans sa résolution originale,
     mais en format auto (webp si supporté)
     et avec compression qualité auto.
══════════════════════════════════════════ */
function cldUrl(publicId, opts = {}) {
  return cloudinary.url(publicId, {
    fetch_format: 'auto',   // webp/avif si le navigateur supporte
    quality:      'auto',   // compression automatique Cloudinary
    secure:       true,
    ...opts,
  });
}

/* ══════════════════════════════════════════
   ROUTES API
══════════════════════════════════════════ */

// ── POST /api/auth/login
app.post('/api/auth/login', (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD)
    return res.status(401).json({ error: 'Mot de passe incorrect' });
  const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token });
});

// ── GET /api/photos  (public)
app.get('/api/photos', async (req, res) => {
  const photos = (await readDB()).filter(p => p.published);
  res.json(photos.map(p => ({
    id:     p.id,
    url:    cldUrl(p.cloudinaryId),
    name:   p.name,
    w:      p.w,
    h:      p.h,
    orient: p.orient,
    ratio:  p.ratio,
    order:  p.order,
  })));
});

// ── GET /api/admin/photos  (admin)
app.get('/api/admin/photos', requireAuth, async (req, res) => {
  const photos = await readDB();
  res.json(photos.map(p => ({
    id:          p.id,
    url:         cldUrl(p.cloudinaryId),
    // URL miniature pour la grille admin (400px de large)
    thumbUrl:    cldUrl(p.cloudinaryId, { width: 400, crop: 'limit' }),
    name:        p.name,
    w:           p.w,
    h:           p.h,
    orient:      p.orient,
    ratio:       p.ratio,
    order:       p.order,
    published:   p.published,
    createdAt:   p.createdAt,
    cloudinaryId: p.cloudinaryId,
  })));
});

// ── POST /api/admin/photos  (upload → Cloudinary)
app.post('/api/admin/photos', requireAuth, upload.array('photos', 50), async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'Aucun fichier reçu' });

  const db    = await readDB();
  const added = [];

  for (const file of req.files) {
    try {
      // Cloudinary renvoie les dimensions dans file
      const w     = file.width  || file.resource?.width  || 0;
      const h     = file.height || file.resource?.height || 0;
      // Si Cloudinary ne renvoie pas les dimensions, les lire depuis l'objet
      const fw    = w || (file.resource_type === 'image' ? parseInt(file.filename) : 0);
      const fh    = h;
      const ratio = fw && fh ? fw / fh : 1;
      const orient = ratio > 1.15 ? 'land' : ratio < 0.87 ? 'port' : 'sq';

      // Récupérer les vraies dimensions via l'API Cloudinary si manquantes
      let finalW = fw, finalH = fh;
      if (!finalW || !finalH) {
        try {
          const info = await cloudinary.api.resource(file.filename, { resource_type: 'image' });
          finalW = info.width; finalH = info.height;
        } catch(e) {}
      }
      const finalRatio  = finalW && finalH ? finalW / finalH : 1;
      const finalOrient = finalRatio > 1.15 ? 'land' : finalRatio < 0.87 ? 'port' : 'sq';

      const photo = {
        id:           crypto.randomUUID(),
        cloudinaryId: file.filename,       // public_id Cloudinary
        name:         path.basename(file.originalname, path.extname(file.originalname)),
        w:            finalW,
        h:            finalH,
        ratio:        finalRatio,
        orient:       finalOrient,
        order:        db.length + added.length,
        published:    false,
        createdAt:    new Date().toISOString(),
      };

      db.push(photo);
      added.push({
        id:       photo.id,
        url:      cldUrl(photo.cloudinaryId),
        thumbUrl: cldUrl(photo.cloudinaryId, { width: 400, crop: 'limit' }),
        name:     photo.name,
        w:        photo.w,
        h:        photo.h,
        orient:   photo.orient,
        ratio:    photo.ratio,
        order:    photo.order,
        published: false,
      });
    } catch(e) {
      console.error('Upload error:', e.message);
    }
  }

  await writeDB(db);
  res.json({ added, total: db.length });
});

// ── PUT /api/admin/photos/:id
app.put('/api/admin/photos/:id', requireAuth, async (req, res) => {
  const db    = await readDB();
  const photo = db.find(p => p.id === req.params.id);
  if (!photo) return res.status(404).json({ error: 'Photo introuvable' });
  if (req.body.name  !== undefined) photo.name  = req.body.name;
  if (req.body.order !== undefined) photo.order = req.body.order;
  await writeDB(db);
  res.json({ ok: true });
});

// ── DELETE /api/admin/photos/:id
app.delete('/api/admin/photos/:id', requireAuth, async (req, res) => {
  let db    = await readDB();
  const photo = db.find(p => p.id === req.params.id);
  if (!photo) return res.status(404).json({ error: 'Photo introuvable' });

  // Supprimer de Cloudinary
  try { await cloudinary.uploader.destroy(photo.cloudinaryId, { resource_type: 'image' }); }
  catch(e) { console.warn('Cloudinary delete failed:', e.message); }

  db = db.filter(p => p.id !== req.params.id);
  db.forEach((p, i) => p.order = i);
  await writeDB(db);
  res.json({ ok: true });
});

// ── POST /api/admin/publish
app.post('/api/admin/publish', requireAuth, async (req, res) => {
  const { ids } = req.body;
  const db = await readDB();
  db.forEach(p => p.published = false);
  if (Array.isArray(ids)) {
    ids.forEach((id, i) => {
      const p = db.find(x => x.id === id);
      if (p) { p.published = true; p.order = i; }
    });
  } else {
    db.forEach((p, i) => { p.published = true; p.order = i; });
  }
  await writeDB(db);
  res.json({ ok: true, published: db.filter(p => p.published).length });
});

// ── POST /api/admin/reorder
app.post('/api/admin/reorder', requireAuth, async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids requis' });
  const db = await readDB();
  ids.forEach((id, i) => { const p = db.find(x => x.id === id); if (p) p.order = i; });
  db.sort((a, b) => a.order - b.order);
  await writeDB(db);
  res.json({ ok: true });
});

// ── DELETE /api/admin/photos  (tout effacer)
app.delete('/api/admin/photos', requireAuth, async (req, res) => {
  const db = await readDB();
  // Supprimer toutes les images Cloudinary en parallèle
  await Promise.allSettled(
    db.map(p => cloudinary.uploader.destroy(p.cloudinaryId, { resource_type: 'image' }))
  );
  // Supprimer aussi la DB sur Cloudinary
  try { await cloudinary.uploader.destroy(DB_CLD_ID, { resource_type: 'raw' }); } catch(e) {}
  await writeDB([]);
  res.json({ ok: true });
});

// ── GET /api/health
app.get('/api/health', async (req, res) => {
  const photos = await readDB();
  res.json({ status: 'ok', photos: photos.length, storage: 'cloudinary' });
});

/* ══════════════════════════════════════════
   FALLBACK SPA
══════════════════════════════════════════ */
app.get('/admin/*', (req, res) =>
  res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'index.html')));
app.get('*', (req, res) =>
  res.sendFile(path.join(__dirname, '..', 'public', 'expo', 'index.html')));

/* ══════════════════════════════════════════
   DÉMARRAGE
══════════════════════════════════════════ */
app.listen(PORT, () => {
  console.log(`✓ Atelier Portfolio (Cloudinary) — port ${PORT}`);
  console.log(`  Cloud : ${process.env.CLOUDINARY_CLOUD_NAME || '⚠ CLOUDINARY_CLOUD_NAME manquant'}`);
  console.log(`  Public → http://localhost:${PORT}`);
  console.log(`  Admin  → http://localhost:${PORT}/admin`);
});
