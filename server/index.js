'use strict';

const express    = require('express');
const jwt        = require('jsonwebtoken');
const cloudinary = require('cloudinary').v2;
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

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure:     true,
});

/* ══════════════════════════════════════════
   BASE DE DONNÉES JSON
   Disque local + backup Cloudinary raw
══════════════════════════════════════════ */
const DB_FOLDER = process.env.UPLOADS_DIR || path.join(__dirname, '..', 'uploads');
const DB_FILE   = path.join(DB_FOLDER, 'photos.json');
const DB_CLD_ID = 'atelier-portfolio/db/photos';

fs.mkdirSync(DB_FOLDER, { recursive: true });

async function readDB() {
  try {
    if (fs.existsSync(DB_FILE))
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch(e) {}
  try {
    const url = cloudinary.url(DB_CLD_ID, { resource_type: 'raw', format: 'json' });
    const fetch = (await import('node-fetch')).default;
    const r = await fetch(url);
    if (r.ok) {
      const data = await r.json();
      try { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); } catch(e) {}
      return data;
    }
  } catch(e) { console.warn('DB fallback failed:', String(e)); }
  return [];
}

async function writeDB(data) {
  const json = JSON.stringify(data, null, 2);
  try { fs.writeFileSync(DB_FILE, json); } catch(e) {}
  try {
    const tmp = path.join(DB_FOLDER, '_db_tmp.json');
    fs.writeFileSync(tmp, json);
    await cloudinary.uploader.upload(tmp, { public_id: DB_CLD_ID, resource_type: 'raw', overwrite: true });
    try { fs.unlinkSync(tmp); } catch(e) {}
  } catch(e) { console.warn('DB Cloudinary save failed:', String(e)); }
}

/* ══════════════════════════════════════════
   MIDDLEWARE
══════════════════════════════════════════ */
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use('/admin', express.static(path.join(__dirname, '..', 'public', 'admin')));
app.use('/',      express.static(path.join(__dirname, '..', 'public', 'expo')));

/* ══════════════════════════════════════════
   AUTH
══════════════════════════════════════════ */
function requireAuth(req, res, next) {
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Non authentifie' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch(e) { res.status(401).json({ error: 'Token invalide ou expire' }); }
}

function cldUrl(publicId, opts = {}) {
  return cloudinary.url(publicId, { fetch_format: 'auto', quality: 'auto', secure: true, ...opts });
}

/* ══════════════════════════════════════════
   ROUTES
══════════════════════════════════════════ */

// POST /api/auth/login
app.post('/api/auth/login', (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD)
    return res.status(401).json({ error: 'Mot de passe incorrect' });
  const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token });
});

// ══════════════════════════════════════════
// GET /api/admin/sign  ← NOUVEAU
// Le navigateur demande une signature pour
// uploader directement vers Cloudinary.
// Aucun fichier ne transite par Render.
// ══════════════════════════════════════════
app.get('/api/admin/sign', requireAuth, (req, res) => {
  const timestamp = Math.round(Date.now() / 1000);
  const folder    = 'atelier-portfolio/photos';
  const publicId  = crypto.randomBytes(14).toString('hex');

  const signature = cloudinary.utils.api_sign_request(
    { timestamp, folder, public_id: publicId },
    process.env.CLOUDINARY_API_SECRET
  );

  res.json({
    timestamp,
    signature,
    folder,
    public_id:  publicId,
    api_key:    process.env.CLOUDINARY_API_KEY,
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  });
});

// ══════════════════════════════════════════
// POST /api/admin/photos/register  ← NOUVEAU
// Après l'upload direct vers Cloudinary,
// le navigateur envoie les métadonnées
// pour qu'on les enregistre en DB.
// ══════════════════════════════════════════
app.post('/api/admin/photos/register', requireAuth, async (req, res) => {
  try {
    const { cloudinaryId, originalName, w, h } = req.body;

    if (!cloudinaryId) return res.status(400).json({ error: 'cloudinaryId manquant' });

    // Si les dimensions ne sont pas fournies par le navigateur, les récupérer via API
    let finalW = parseInt(w) || 0;
    let finalH = parseInt(h) || 0;
    if (!finalW || !finalH) {
      try {
        const info = await cloudinary.api.resource(cloudinaryId);
        finalW = info.width  || 0;
        finalH = info.height || 0;
      } catch(e) { console.warn('api.resource failed:', String(e)); }
    }

    const ratio  = finalW && finalH ? finalW / finalH : 1;
    const orient = ratio > 1.15 ? 'land' : ratio < 0.87 ? 'port' : 'sq';

    const db = await readDB();
    const photo = {
      id:           crypto.randomUUID(),
      cloudinaryId,
      name:         originalName
                      ? path.basename(originalName, path.extname(originalName))
                      : cloudinaryId.split('/').pop(),
      w: finalW, h: finalH, ratio, orient,
      order:     db.length,
      published: false,
      createdAt: new Date().toISOString(),
    };

    db.push(photo);
    await writeDB(db);

    res.json({
      id:        photo.id,
      url:       cldUrl(photo.cloudinaryId),
      thumbUrl:  cldUrl(photo.cloudinaryId, { width: 400, crop: 'limit' }),
      name:      photo.name,
      w:         photo.w,
      h:         photo.h,
      orient:    photo.orient,
      ratio:     photo.ratio,
      order:     photo.order,
      published: false,
    });
  } catch(e) {
    console.error('Register error:', String(e));
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/photos  (public)
app.get('/api/photos', async (req, res) => {
  try {
    const photos = (await readDB()).filter(p => p.published);
    res.json(photos.map(p => ({
      id: p.id, url: cldUrl(p.cloudinaryId), name: p.name,
      w: p.w, h: p.h, orient: p.orient, ratio: p.ratio, order: p.order,
    })));
  } catch(e) { res.status(500).json({ error: String(e) }); }
});

// GET /api/admin/photos
app.get('/api/admin/photos', requireAuth, async (req, res) => {
  try {
    const photos = await readDB();
    res.json(photos.map(p => ({
      id: p.id, url: cldUrl(p.cloudinaryId),
      thumbUrl: cldUrl(p.cloudinaryId, { width: 400, crop: 'limit' }),
      name: p.name, w: p.w, h: p.h, orient: p.orient, ratio: p.ratio,
      order: p.order, published: p.published, createdAt: p.createdAt,
      cloudinaryId: p.cloudinaryId,
    })));
  } catch(e) { res.status(500).json({ error: String(e) }); }
});

// PUT /api/admin/photos/:id
app.put('/api/admin/photos/:id', requireAuth, async (req, res) => {
  try {
    const db = await readDB();
    const photo = db.find(p => p.id === req.params.id);
    if (!photo) return res.status(404).json({ error: 'Photo introuvable' });
    if (req.body.name  !== undefined) photo.name  = req.body.name;
    if (req.body.order !== undefined) photo.order = req.body.order;
    await writeDB(db);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: String(e) }); }
});

// DELETE /api/admin/photos/:id
app.delete('/api/admin/photos/:id', requireAuth, async (req, res) => {
  try {
    let db = await readDB();
    const photo = db.find(p => p.id === req.params.id);
    if (!photo) return res.status(404).json({ error: 'Photo introuvable' });
    try { await cloudinary.uploader.destroy(photo.cloudinaryId); } catch(e) {}
    db = db.filter(p => p.id !== req.params.id);
    db.forEach((p, i) => p.order = i);
    await writeDB(db);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: String(e) }); }
});

// POST /api/admin/publish
app.post('/api/admin/publish', requireAuth, async (req, res) => {
  try {
    const { ids } = req.body;
    const db = await readDB();
    db.forEach(p => p.published = false);
    if (Array.isArray(ids)) {
      ids.forEach((id, i) => { const p = db.find(x => x.id === id); if (p) { p.published = true; p.order = i; } });
    } else {
      db.forEach((p, i) => { p.published = true; p.order = i; });
    }
    await writeDB(db);
    res.json({ ok: true, published: db.filter(p => p.published).length });
  } catch(e) { res.status(500).json({ error: String(e) }); }
});

// POST /api/admin/reorder
app.post('/api/admin/reorder', requireAuth, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids requis' });
    const db = await readDB();
    ids.forEach((id, i) => { const p = db.find(x => x.id === id); if (p) p.order = i; });
    db.sort((a, b) => a.order - b.order);
    await writeDB(db);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: String(e) }); }
});

// DELETE /api/admin/photos
app.delete('/api/admin/photos', requireAuth, async (req, res) => {
  try {
    const db = await readDB();
    await Promise.allSettled(db.map(p => cloudinary.uploader.destroy(p.cloudinaryId)));
    try { await cloudinary.uploader.destroy(DB_CLD_ID, { resource_type: 'raw' }); } catch(e) {}
    await writeDB([]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: String(e) }); }
});

// GET /api/health
app.get('/api/health', async (req, res) => {
  const photos = await readDB();
  res.json({ status: 'ok', photos: photos.length, storage: 'cloudinary-direct', cloud: process.env.CLOUDINARY_CLOUD_NAME || 'non configure' });
});

// Error handler global
app.use((err, req, res, next) => {
  console.error('Unhandled error:', String(err));
  res.status(500).json({ error: String(err) });
});

// Fallback SPA
app.get('/admin/*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'index.html')));
app.get('*',        (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'expo',  'index.html')));

app.listen(PORT, () => {
  console.log('✓ Atelier Portfolio — port ' + PORT);
  console.log('  Cloud  : ' + (process.env.CLOUDINARY_CLOUD_NAME || '⚠ manquant'));
  console.log('  Mode   : upload direct navigateur → Cloudinary (100Mo max/fichier)');
});
