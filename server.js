const express  = require('express');
const multer   = require('multer');
const { v4: uuidv4 } = require('uuid');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const path     = require('path');
const fs       = require('fs');

const app      = express();
const PORT     = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ── Directories ───────────────────────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

// ── Database ──────────────────────────────────────────────────────────────────
const initSqlJs = require('sql.js');
const DB_PATH   = path.join(__dirname, 'signflow.db');
let db;

async function initDB() {
  const SQL = await initSqlJs();
  db = fs.existsSync(DB_PATH)
    ? new SQL.Database(fs.readFileSync(DB_PATH))
    : new SQL.Database();

  db.run(`
    CREATE TABLE IF NOT EXISTS documents (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      file_path     TEXT NOT NULL,
      original_path TEXT NOT NULL,
      created_at    TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS signers (
      id              TEXT PRIMARY KEY,
      document_id     TEXT NOT NULL,
      name            TEXT NOT NULL,
      email           TEXT,
      role            TEXT,
      row_index       INTEGER,
      token           TEXT UNIQUE NOT NULL,
      status          TEXT DEFAULT 'pending',
      signature       TEXT,
      signature_image TEXT,
      signed_at       TEXT
    );
  `);
  saveDB();
}

function saveDB() { fs.writeFileSync(DB_PATH, Buffer.from(db.export())); }

function dbAll(sql, p = []) {
  try {
    const s = db.prepare(sql);
    s.bind(p);
    const rows = [];
    while (s.step()) rows.push(s.getAsObject());
    s.free();
    return rows;
  } catch { return []; }
}
function dbGet(sql, p = []) { return dbAll(sql, p)[0] || null; }
function dbRun(sql, p = []) { db.run(sql, p); saveDB(); }

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// ── Multer ────────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => cb(null, `${uuidv4()}-${file.originalname}`)
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => cb(null, file.mimetype === 'application/pdf')
});

// ── PDF Signature Page ────────────────────────────────────────────────────────
const SIG_W  = 595;
const SIG_H  = 842;
const MARGIN = 60;
const LINE_COLOR = rgb(0.4, 0.4, 0.4);
const BLACK      = rgb(0, 0, 0);
const GRAY       = rgb(0.5, 0.5, 0.5);

function getSlot(rowIndex, total) {
  const usable  = SIG_H - 180;
  const spacing = Math.min(100, Math.floor(usable / Math.max(total, 1)));
  const blockTop = SIG_H - 120 - rowIndex * spacing;
  return {
    nameY:  blockTop,           // name label above line
    lineY:  blockTop - 18,      // the signature line itself
    sigY:   blockTop - 16,      // where drawn/typed sig sits (on the line)
    roleY:  blockTop - 34,      // role label below line
    dateY:  blockTop - 34,      // date (right-aligned, same row as role)
  };
}

async function stampPDF(docId) {
  const doc     = dbGet('SELECT * FROM documents WHERE id = ?', [docId]);
  const signers = dbAll('SELECT * FROM signers WHERE document_id = ? ORDER BY row_index', [docId]);
  if (!doc) return;

  const pdfDoc     = await PDFDocument.load(fs.readFileSync(path.join(UPLOADS_DIR, doc.original_path)));
  const regular    = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold       = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const italic     = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);
  const sigPage    = pdfDoc.addPage([SIG_W, SIG_H]);
  const lineW      = SIG_W - MARGIN * 2;

  sigPage.drawText('SIGNATURE PAGE', { x: MARGIN, y: SIG_H - 60, size: 16, font: bold, color: BLACK });
  sigPage.drawText(doc.name,         { x: MARGIN, y: SIG_H - 80, size: 10, font: regular, color: GRAY });
  sigPage.drawLine({ start: { x: MARGIN, y: SIG_H - 90 }, end: { x: SIG_W - MARGIN, y: SIG_H - 90 }, thickness: 0.5, color: LINE_COLOR });

  for (const s of signers) {
    const slot = getSlot(s.row_index, signers.length);

    // Signature line
    sigPage.drawLine({ start: { x: MARGIN, y: slot.lineY }, end: { x: MARGIN + lineW, y: slot.lineY }, thickness: 0.75, color: LINE_COLOR });

    // Name above line
    sigPage.drawText(s.name || 'Signatory', { x: MARGIN, y: slot.nameY, size: 9, font: regular, color: GRAY });

    // Role below line
    if (s.role) sigPage.drawText(s.role, { x: MARGIN, y: slot.roleY, size: 8, font: regular, color: GRAY });

    // Status badge (top right)
    const statusText  = s.status === 'approved' ? '[Signed]' : '[Pending]';
    const statusColor = s.status === 'approved' ? rgb(0.1, 0.6, 0.3) : rgb(0.7, 0.4, 0);
    sigPage.drawText(statusText, { x: SIG_W - MARGIN - 60, y: slot.nameY, size: 8, font: bold, color: statusColor });

    // Date bottom right
    if (s.signed_at) {
      const d = new Date(s.signed_at + 'Z').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
      sigPage.drawText(d, { x: SIG_W - MARGIN - 80, y: slot.dateY, size: 8, font: regular, color: GRAY });
    }

    // Actual signature — drawn image or typed text, centred on the line
    if (s.status === 'approved') {
      if (s.signature_image && s.signature_image.startsWith('data:image/png;base64,')) {
        try {
          const img   = await pdfDoc.embedPng(Buffer.from(s.signature_image.replace('data:image/png;base64,', ''), 'base64'));
          const maxH  = 32;
          const scale = maxH / img.height;
          const imgW  = Math.min(lineW * 0.45, img.width * scale);
          const imgH  = maxH;
          // centre horizontally on the line, sit on top of line
          const imgX  = MARGIN + (lineW / 2) - (imgW / 2);
          sigPage.drawImage(img, { x: imgX, y: slot.lineY + 2, width: imgW, height: imgH });
        } catch (e) { console.error('img embed error', e.message); }
      } else if (s.signature && s.signature !== '[drawn]') {
        let fontSize = 20;
        while (italic.widthOfTextAtSize(s.signature, fontSize) > lineW * 0.45 && fontSize > 8) fontSize -= 0.5;
        const textW = italic.widthOfTextAtSize(s.signature, fontSize);
        const textX = MARGIN + (lineW / 2) - (textW / 2);
        sigPage.drawText(s.signature, { x: textX, y: slot.sigY, size: fontSize, font: italic, color: rgb(0.05, 0.15, 0.45) });
      }
    }
  }

  const now = new Date().toLocaleString('en-US', { timeZone: 'UTC' });
  sigPage.drawText(`Generated by SignFlow · ${now} UTC`, { x: MARGIN, y: 30, size: 7, font: regular, color: rgb(0.7, 0.7, 0.7) });

  fs.writeFileSync(path.join(UPLOADS_DIR, doc.file_path), await pdfDoc.save());
}

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /api/documents
app.post('/api/documents', upload.single('pdf'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'PDF required' });

    let signers;
    try { signers = JSON.parse(req.body.signers); }
    catch { return res.status(400).json({ error: 'Invalid signers JSON' }); }

    if (!Array.isArray(signers) || signers.length === 0)
      return res.status(400).json({ error: 'At least one signer required' });

    const docId    = uuidv4();
    const origFile = req.file.filename;
    const signFile = `signed-${origFile}`;

    fs.copyFileSync(path.join(UPLOADS_DIR, origFile), path.join(UPLOADS_DIR, signFile));
    dbRun('INSERT INTO documents (id, name, file_path, original_path) VALUES (?, ?, ?, ?)',
      [docId, req.file.originalname, signFile, origFile]);

    const created = signers.map((s, i) => {
      const id    = uuidv4();
      const token = uuidv4();
      const row   = s.rowIndex !== undefined ? s.rowIndex : i;
      dbRun('INSERT INTO signers (id, document_id, name, email, role, row_index, token) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, docId, s.name, s.email || '', s.role || '', row, token]);
      return { id, name: s.name, email: s.email || '', role: s.role || '', rowIndex: row, token, approvalLink: `${BASE_URL}/approve/${token}` };
    });

    stampPDF(docId).catch(console.error);
    res.json({ success: true, documentId: docId, signers: created });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// GET /api/documents
app.get('/api/documents', (req, res) => {
  const docs = dbAll('SELECT * FROM documents ORDER BY created_at DESC');
  res.json(docs.map(d => ({ ...d, signers: dbAll('SELECT * FROM signers WHERE document_id = ? ORDER BY row_index', [d.id]) })));
});

// GET /api/documents/:id
app.get('/api/documents/:id', (req, res) => {
  const doc = dbGet('SELECT * FROM documents WHERE id = ?', [req.params.id]);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  res.json({ ...doc, signers: dbAll('SELECT * FROM signers WHERE document_id = ? ORDER BY row_index', [doc.id]) });
});

// GET /api/documents/:id/download
app.get('/api/documents/:id/download', async (req, res) => {
  const doc = dbGet('SELECT * FROM documents WHERE id = ?', [req.params.id]);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  await stampPDF(req.params.id);
  const fp = path.join(UPLOADS_DIR, doc.file_path);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'File missing' });
  res.download(fp, `signed-${doc.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`);
});

// GET /api/documents/:id/view — opens PDF inline in browser tab
app.get('/api/documents/:id/view', async (req, res) => {
  const doc = dbGet('SELECT * FROM documents WHERE id = ?', [req.params.id]);
  if (!doc) return res.status(404).send('Document not found');
  await stampPDF(req.params.id);
  const fp = path.join(UPLOADS_DIR, doc.file_path);
  if (!fs.existsSync(fp)) return res.status(404).send('File not found on disk');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${doc.name}"`);
  res.setHeader('Content-Length', fs.statSync(fp).size);
  fs.createReadStream(fp).pipe(res);
});

// GET /api/approve/:token
app.get('/api/approve/:token', (req, res) => {
  const signer = dbGet('SELECT * FROM signers WHERE token = ?', [req.params.token]);
  if (!signer) return res.status(404).json({ error: 'Link not found' });
  if (signer.status === 'approved') return res.status(409).json({ error: 'already_signed' });
  const doc = dbGet('SELECT * FROM documents WHERE id = ?', [signer.document_id]);
  res.json({ signer, document: doc });
});

// POST /api/approve/:token
app.post('/api/approve/:token', async (req, res) => {
  try {
    const signer = dbGet('SELECT * FROM signers WHERE token = ?', [req.params.token]);
    if (!signer) return res.status(404).json({ error: 'Link not found' });
    if (signer.status === 'approved') return res.status(409).json({ error: 'already_signed' });

    const { signature, signatureImage } = req.body;
    if (!signature) return res.status(400).json({ error: 'Signature required' });

    dbRun(`UPDATE signers SET status='approved', signature=?, signature_image=?, signed_at=datetime('now') WHERE token=?`,
      [signature, signatureImage || null, req.params.token]);

    await stampPDF(signer.document_id);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// SPA catch-all for /approve/:token routes
app.get('/approve/:token', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

// ── Start ─────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`\n✅  SignFlow → http://localhost:${PORT}\n`));
}).catch(err => { console.error(err); process.exit(1); });
