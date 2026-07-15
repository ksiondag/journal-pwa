'use strict';

const express  = require('express');
const Database = require('better-sqlite3');
const bcrypt   = require('bcryptjs');
const session  = require('express-session');
const rateLimit = require('express-rate-limit');
const crypto   = require('crypto');
const fs       = require('fs');
const path     = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1); // nginx reverse proxy

// ── Database ───────────────────────────────────────────────────────────────

const db = new Database(path.join(__dirname, 'journal.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    password_hash TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS journals (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id),
    name       TEXT NOT NULL DEFAULT 'My Journal',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS pages (
    id          TEXT PRIMARY KEY,
    journal_id  TEXT NOT NULL REFERENCES journals(id) ON DELETE CASCADE,
    page_number INTEGER NOT NULL,
    data        BLOB NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(journal_id, page_number)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    sid     TEXT PRIMARY KEY,
    data    TEXT NOT NULL,
    expires INTEGER NOT NULL
  );
`);

// Migration: add password_hash column to existing databases
const userCols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
if (!userCols.includes('password_hash')) {
  db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
}

// Migration: add device_id column to existing databases (attribution for sync conflicts)
const pageCols = db.prepare('PRAGMA table_info(pages)').all().map(c => c.name);
if (!pageCols.includes('device_id')) {
  db.exec('ALTER TABLE pages ADD COLUMN device_id TEXT');
}

// ── Session store (SQLite-backed) ──────────────────────────────────────────

class SQLiteStore extends session.Store {
  get(sid, cb) {
    try {
      const row = db.prepare('SELECT data, expires FROM sessions WHERE sid = ?').get(sid);
      if (!row || row.expires < Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.data));
    } catch (e) { cb(e); }
  }

  set(sid, sess, cb) {
    try {
      const expires = sess.cookie?.expires
        ? new Date(sess.cookie.expires).getTime()
        : Date.now() + 7 * 24 * 60 * 60 * 1000;
      db.prepare(`
        INSERT INTO sessions (sid, data, expires) VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires = excluded.expires
      `).run(sid, JSON.stringify(sess), expires);
      cb(null);
    } catch (e) { cb(e); }
  }

  destroy(sid, cb) {
    try {
      db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      cb(null);
    } catch (e) { cb(e); }
  }
}

// Prune expired sessions hourly
setInterval(
  () => db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()),
  60 * 60 * 1000
).unref();

// ── Session secret (auto-generated, persisted across restarts) ─────────────

const secretFile = path.join(__dirname, '.session-secret');
const SESSION_SECRET = (() => {
  if (fs.existsSync(secretFile)) return fs.readFileSync(secretFile, 'utf8').trim();
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretFile, s, { mode: 0o600 });
  return s;
})();

// ── Middleware ─────────────────────────────────────────────────────────────

app.use(express.json({ limit: '50mb' }));

app.use(session({
  store: new SQLiteStore(),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production', // requires HTTPS in prod
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts — try again in 15 minutes' },
});

// ── Static files ───────────────────────────────────────────────────────────

// Serve static assets (app.js, style.css, icons…) without auth.
// index.html is served explicitly so we can enforce auth.
app.use(express.static(__dirname, { index: false }));

app.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/guest', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/', (req, res) => {
  if (!req.session.userId) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Auth helpers ───────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (req.session.userId) return next();
  res.status(401).json({ error: 'not authenticated' });
}

function ownJournal(req, res) {
  const j = db.prepare('SELECT id FROM journals WHERE id = ? AND user_id = ?')
    .get(req.params.journalId, req.session.userId);
  if (!j) { res.status(403).json({ error: 'forbidden' }); return null; }
  return j;
}

// ── Auth routes ────────────────────────────────────────────────────────────

app.post('/auth/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  const user = db.prepare('SELECT id, name, password_hash FROM users WHERE name = ?').get(username.trim());
  // Always run bcrypt compare to prevent timing attacks on username enumeration
  const hash = user?.password_hash || '$2a$12$invalidhashpaddingtomatchlength000000000000000000000000';
  const valid = user?.password_hash ? await bcrypt.compare(password, hash) : false;

  if (!valid) return res.status(401).json({ error: 'invalid username or password' });

  req.session.userId = user.id;
  req.session.username = user.name;
  res.json({ id: user.id, username: user.name });
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/auth/me', requireAuth, (req, res) => {
  res.json({ id: req.session.userId, username: req.session.username });
});

// ── Journals ───────────────────────────────────────────────────────────────

app.get('/api/journals', requireAuth, (req, res) => {
  res.json(db.prepare(
    'SELECT id, name, created_at FROM journals WHERE user_id = ? ORDER BY created_at'
  ).all(req.session.userId));
});

app.post('/api/journals', requireAuth, (req, res) => {
  const { name = 'New Journal' } = req.body;
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO journals (id, user_id, name) VALUES (?, ?, ?)').run(id, req.session.userId, name);
  res.status(201).json({ id, name });
});

// ── Pages ──────────────────────────────────────────────────────────────────

function hashBuffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

app.post('/api/journals/:journalId/sync', requireAuth, (req, res) => {
  if (!ownJournal(req, res)) return;
  const clientPages = req.body.pages && typeof req.body.pages === 'object' ? req.body.pages : {};

  const serverRows = db.prepare(
    'SELECT page_number, data, updated_at, device_id FROM pages WHERE journal_id = ?'
  ).all(req.params.journalId);
  const serverNumbers = new Set(serverRows.map(r => r.page_number));

  const download = {};
  const upload = [];
  const conflicts = {};

  for (const row of serverRows) {
    const client = clientPages[row.page_number];
    if (!client) {
      download[row.page_number] = {
        data: `data:image/png;base64,${row.data.toString('base64')}`,
        updated_at: row.updated_at,
        device_id: row.device_id,
      };
      continue;
    }
    if (client.hash === hashBuffer(row.data)) continue; // identical content — already synced
    conflicts[row.page_number] = {
      data: `data:image/png;base64,${row.data.toString('base64')}`,
      updated_at: row.updated_at,
      device_id: row.device_id,
    };
  }

  for (const key of Object.keys(clientPages)) {
    const n = parseInt(key, 10);
    if (!serverNumbers.has(n)) upload.push(n);
  }

  res.json({ download, upload, conflicts });
});

app.get('/api/journals/:journalId/pages/:pageNumber', requireAuth, (req, res) => {
  if (!ownJournal(req, res)) return;
  const n = parseInt(req.params.pageNumber, 10);
  if (isNaN(n) || n < 0) return res.status(400).end();
  const row = db.prepare(
    'SELECT data FROM pages WHERE journal_id = ? AND page_number = ?'
  ).get(req.params.journalId, n);
  if (!row) return res.status(404).end();
  res.set('Content-Type', 'image/png').send(row.data);
});

app.put('/api/journals/:journalId/pages/:pageNumber', requireAuth, (req, res) => {
  if (!ownJournal(req, res)) return;
  const n = parseInt(req.params.pageNumber, 10);
  if (isNaN(n) || n < 0) return res.status(400).end();

  const PREFIX = 'data:image/png;base64,';
  const { data, device_id } = req.body;
  if (typeof data !== 'string' || !data.startsWith(PREFIX)) {
    return res.status(400).json({ error: 'expected data:image/png;base64, string' });
  }

  const buf = Buffer.from(data.slice(PREFIX.length), 'base64');
  const { journalId } = req.params;
  const deviceId = typeof device_id === 'string' ? device_id : null;

  const existing = db.prepare(
    'SELECT id FROM pages WHERE journal_id = ? AND page_number = ?'
  ).get(journalId, n);

  if (existing) {
    db.prepare("UPDATE pages SET data = ?, device_id = ?, updated_at = datetime('now') WHERE id = ?")
      .run(buf, deviceId, existing.id);
    res.json({ id: existing.id, page_number: n });
  } else {
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO pages (id, journal_id, page_number, data, device_id) VALUES (?, ?, ?, ?, ?)')
      .run(id, journalId, n, buf, deviceId);
    res.status(201).json({ id, page_number: n });
  }
});

app.delete('/api/journals/:journalId/pages/:pageNumber', requireAuth, (req, res) => {
  if (!ownJournal(req, res)) return;
  const n = parseInt(req.params.pageNumber, 10);
  if (isNaN(n) || n < 0) return res.status(400).end();
  db.prepare('DELETE FROM pages WHERE journal_id = ? AND page_number = ?')
    .run(req.params.journalId, n);
  res.json({ ok: true });
});

app.patch('/api/journals/:journalId', requireAuth, (req, res) => {
  if (!ownJournal(req, res)) return;
  const { name } = req.body;
  if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'name required' });
  db.prepare('UPDATE journals SET name = ? WHERE id = ?').run(name.trim(), req.params.journalId);
  res.json({ id: req.params.journalId, name: name.trim() });
});

app.delete('/api/journals/:journalId', requireAuth, (req, res) => {
  if (!ownJournal(req, res)) return;
  db.prepare('DELETE FROM journals WHERE id = ?').run(req.params.journalId);
  res.json({ ok: true });
});

// ── Start ──────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Journal → http://localhost:${PORT}`);
  if (process.env.NODE_ENV !== 'production') {
    console.log('  Set NODE_ENV=production when running behind HTTPS');
  }
  const hasAccounts = db.prepare('SELECT 1 FROM users WHERE password_hash IS NOT NULL LIMIT 1').get();
  if (!hasAccounts) {
    console.log(`  No accounts yet — register at http://localhost:${PORT}/login`);
  }
});
