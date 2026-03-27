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
const DATA_DIR    = process.env.DATA_DIR || __dirname;
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ── Database ──────────────────────────────────────────────────────────────────
const initSqlJs = require('sql.js');
const DB_PATH   = path.join(DATA_DIR, 'signflow.db');
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
    const s = db.prepare(sql); s.bind(p);
    const rows = []; while (s.step()) rows.push(s.getAsObject()); s.free();
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

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => cb(null, `${uuidv4()}-${file.originalname}`)
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => cb(null, file.mimetype === 'application/pdf')
});

// ── PDF Text Extraction (pdfjs-dist) ──────────────────────────────────────────
// Returns array of { str, x, y, pageIndex, pageHeight }
async function extractTextItems(pdfPath) {
  // pdfjs-dist requires a canvas shim in Node — use legacy build
  const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
  pdfjsLib.GlobalWorkerOptions.workerSrc = false;

  const data     = new Uint8Array(fs.readFileSync(pdfPath));
  const pdfDoc   = await pdfjsLib.getDocument({ data, useWorkerFetch: false, isEvalSupported: false, useSystemFonts: true }).promise;
  const allItems = [];

  for (let p = 1; p <= pdfDoc.numPages; p++) {
    const page    = await pdfDoc.getPage(p);
    const vp      = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    for (const item of content.items) {
      if (!item.str || !item.str.trim()) continue;
      allItems.push({
        str:        item.str.trim(),
        x:          item.transform[4],
        y:          item.transform[5],
        pageIndex:  p - 1,           // 0-based
        pageHeight: vp.height,
      });
    }
  }
  return allItems;
}

// ── Role → Signature Position Finder ─────────────────────────────────────────
// Strategies (tried in order):
//   1. Find "Signed:" text on the same line as the role → stamp just after it
//   2. Find the role text itself → stamp to the right on the same line
//   3. Fall back to bottom-of-last-page stamping
function normalise(str) {
  return str.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

function findSigPosition(items, role) {
  if (!role) return null;
  const normRole = normalise(role);

  // Build role keywords (skip short words)
  const keywords = normRole.split(' ').filter(w => w.length > 3);
  if (keywords.length === 0) return null;

  // Score each text item by keyword overlap with role
  function roleScore(str) {
    const n = normalise(str);
    return keywords.filter(k => n.includes(k)).length / keywords.length;
  }

  // Find best role match (score >= 0.5)
  const candidates = items
    .map(item => ({ ...item, score: roleScore(item.str) }))
    .filter(item => item.score >= 0.5)
    .sort((a, b) => b.score - a.score);

  if (candidates.length === 0) return null;
  const roleItem = candidates[0];

  // ── Strategy 1: find "Signed:" on the same line (within 6pt vertically) ──
  const YTOL = 8; // points tolerance for "same line"
  const signedItem = items.find(item => {
    if (item.pageIndex !== roleItem.pageIndex) return false;
    const normStr = normalise(item.str);
    return (normStr === 'signed' || normStr === 'signed:' || normStr.startsWith('signed')) &&
           Math.abs(item.y - roleItem.y) < YTOL;
  });

  if (signedItem) {
    return {
      pageIndex:  signedItem.pageIndex,
      pageHeight: signedItem.pageHeight,
      x:          signedItem.x + 46,
      y:          signedItem.y - 6,   // half row height down to vertically centre
      boxH:       12,
      boxW:       75,
    };
  }

  // ── Strategy 2: place to the right of the role text itself ──
  const sameLineItems = items.filter(i =>
    i.pageIndex === roleItem.pageIndex && Math.abs(i.y - roleItem.y) < YTOL
  ).sort((a, b) => a.x - b.x);

  const rightmostX = Math.max(...sameLineItems.map(i => i.x));
  const pageW = 595;

  return {
    pageIndex:  roleItem.pageIndex,
    pageHeight: roleItem.pageHeight,
    x:          Math.min(rightmostX + 20, pageW * 0.55),
    y:          roleItem.y + 1,
    boxH:       12,
    boxW:       90,
  };
}

// ── PDF Stamping ──────────────────────────────────────────────────────────────
const LINE_COLOR = rgb(0.4, 0.4, 0.4);
const BLACK      = rgb(0, 0, 0);
const GRAY       = rgb(0.5, 0.5, 0.5);

async function stampPDF(docId) {
  const doc     = dbGet('SELECT * FROM documents WHERE id = ?', [docId]);
  const signers = dbAll('SELECT * FROM signers WHERE document_id = ? ORDER BY row_index', [docId]);
  if (!doc) return;

  const origPath = path.join(UPLOADS_DIR, doc.original_path);
  const outPath  = path.join(UPLOADS_DIR, doc.file_path);

  // ── Extract text positions from original PDF ──────────────────────────────
  let textItems = [];
  try {
    textItems = await extractTextItems(origPath);
  } catch (e) {
    console.warn('Text extraction failed, falling back to bottom-of-page:', e.message);
  }

  // ── Load PDF with pdf-lib for writing ─────────────────────────────────────
  const pdfDoc  = await PDFDocument.load(fs.readFileSync(origPath));
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold    = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const italic  = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);
  const pages   = pdfDoc.getPages();

  // Track which signers were placed inline vs need fallback
  const placed = new Set();

  // ── Try to place each approved signer inline ──────────────────────────────
  for (const s of signers) {
    if (s.status !== 'approved') continue;

    const pos = findSigPosition(textItems, s.role);
    if (!pos) continue;

    const page   = pages[pos.pageIndex];
    const { width, height } = page.getSize();

    // pdfjs y is from bottom of page (same as pdf-lib), so we use directly
    const sigX  = pos.x;
    const boxH  = pos.boxH || 12;
    const boxW  = pos.boxW || 75;

    // Draw signature — pos.y is the Signed: text baseline, use it directly
    if (s.signature_image && s.signature_image.startsWith('data:image/png;base64,')) {
      try {
        const img   = await pdfDoc.embedPng(Buffer.from(s.signature_image.replace('data:image/png;base64,', ''), 'base64'));
        const scale = boxH / img.height;
        const imgW  = Math.min(boxW, img.width * scale);
        page.drawImage(img, { x: sigX, y: pos.y - boxH + 6, width: imgW, height: boxH });
      } catch (e) {
        console.error('sig image embed error:', e.message);
        _drawTypedSig(page, italic, s.name, sigX, pos.y, 10);
      }
    } else if (s.signature && s.signature !== '[drawn]') {
      _drawTypedSig(page, italic, s.signature, sigX, pos.y + 4, 10);
    } else {
      _drawTypedSig(page, italic, s.name, sigX, pos.y + 4, 10);
    }

    placed.add(s.id);
  }

  // ── Fallback: stamp any unplaced signers at bottom of last page ───────────
  const unplaced = signers.filter(s => !placed.has(s.id));
  if (unplaced.length > 0) {
    const lastPage = pages[pages.length - 1];
    const { width } = lastPage.getSize();
    const margin = 48;
    const lineW  = width - margin * 2;
    const blockH = 80;

    const startY = 20 + unplaced.length * blockH + 30;

    lastPage.drawLine({
      start: { x: margin, y: startY }, end: { x: width - margin, y: startY },
      thickness: 0.5, color: LINE_COLOR,
    });
    lastPage.drawText('SIGNATURES', { x: margin, y: startY + 8, size: 7, font: bold, color: GRAY });

    for (const s of unplaced) {
      const idx    = unplaced.indexOf(s);
      const blockY = startY - 18 - idx * blockH;

      lastPage.drawText(s.name || 'Signatory', { x: margin, y: blockY, size: 9, font: bold, color: BLACK });
      if (s.role) lastPage.drawText(s.role, { x: margin, y: blockY - 13, size: 7, font: regular, color: GRAY });

      const statusText  = s.status === 'approved' ? '[Signed]' : '[Pending]';
      const statusColor = s.status === 'approved' ? rgb(0.1, 0.6, 0.3) : rgb(0.7, 0.4, 0);
      lastPage.drawText(statusText, {
        x: width - margin - bold.widthOfTextAtSize(statusText, 8),
        y: blockY, size: 8, font: bold, color: statusColor,
      });
      if (s.signed_at) {
        const d = new Date(s.signed_at + 'Z').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
        lastPage.drawText(d, {
          x: width - margin - regular.widthOfTextAtSize(d, 7),
          y: blockY - 13, size: 7, font: regular, color: GRAY,
        });
      }

      const lineY = blockY - 30;
      lastPage.drawLine({
        start: { x: margin, y: lineY }, end: { x: margin + lineW * 0.55, y: lineY },
        thickness: 0.5, color: LINE_COLOR,
      });

      if (s.status === 'approved') {
        if (s.signature_image && s.signature_image.startsWith('data:image/png;base64,')) {
          try {
            const img   = await pdfDoc.embedPng(Buffer.from(s.signature_image.replace('data:image/png;base64,', ''), 'base64'));
            const maxH  = 26, scale = maxH / img.height;
            lastPage.drawImage(img, { x: margin + 4, y: lineY + 2, width: Math.min(lineW * 0.5, img.width * scale), height: maxH });
          } catch (e) { console.error('fallback sig embed:', e.message); }
        } else if (s.signature && s.signature !== '[drawn]') {
          _drawTypedSig(lastPage, italic, s.signature, margin + 4, lineY + 3);
        }
      }
    }
  }

  // Footer on last page
  const lastPage = pages[pages.length - 1];
  const now = new Date().toLocaleString('en-US', { timeZone: 'UTC' });
  lastPage.drawText(`SignFlow · ${now} UTC`, {
    x: 48, y: 8, size: 6, font: regular, color: rgb(0.75, 0.75, 0.75),
  });

  fs.writeFileSync(outPath, await pdfDoc.save());
}

function _drawTypedSig(page, font, text, x, y, maxSize = 10) {
  let fontSize = maxSize;
  while (font.widthOfTextAtSize(text, fontSize) > 78 && fontSize > 5) fontSize -= 0.5;
  page.drawText(text, { x, y, size: fontSize, font, color: rgb(0.05, 0.15, 0.45) });
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

// GET /api/documents/:id/view
app.get('/api/documents/:id/view', async (req, res) => {
  const doc = dbGet('SELECT * FROM documents WHERE id = ?', [req.params.id]);
  if (!doc) return res.status(404).send('Not found');
  await stampPDF(req.params.id);
  const fp = path.join(UPLOADS_DIR, doc.file_path);
  if (!fs.existsSync(fp)) return res.status(404).send('File missing');
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

// SPA catch-all
app.get('/approve/:token', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

// ── Start ─────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`\n✅  SignFlow → http://localhost:${PORT}\n`));
}).catch(err => { console.error(err); process.exit(1); });
