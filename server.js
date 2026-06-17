'use strict';

const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const db = new Database(path.join(__dirname, 'journal.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
`);

// Seed a default user + journal on first run
db.transaction(() => {
  let user = db.prepare('SELECT id FROM users LIMIT 1').get();
  if (!user) {
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run(id, 'Default User');
    user = { id };
  }
  if (!db.prepare('SELECT id FROM journals WHERE user_id = ? LIMIT 1').get(user.id)) {
    db.prepare('INSERT INTO journals (id, user_id, name) VALUES (?, ?, ?)').run(
      crypto.randomUUID(), user.id, 'My Journal'
    );
  }
})();

app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname, { index: 'index.html' }));

// ── Users ──────────────────────────────────────────────────────────────────

app.get('/api/users', (req, res) => {
  res.json(db.prepare('SELECT id, name, created_at FROM users ORDER BY created_at').all());
});

app.post('/api/users', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run(id, name);
  res.status(201).json({ id, name });
});

// ── Journals ───────────────────────────────────────────────────────────────

app.get('/api/journals', (req, res) => {
  res.json(db.prepare(`
    SELECT j.id, j.name, j.user_id, u.name AS user_name, j.created_at
    FROM journals j JOIN users u ON u.id = j.user_id
    ORDER BY j.created_at
  `).all());
});

app.post('/api/journals', (req, res) => {
  const { userId, name = 'New Journal' } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(userId)) {
    return res.status(404).json({ error: 'user not found' });
  }
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO journals (id, user_id, name) VALUES (?, ?, ?)').run(id, userId, name);
  res.status(201).json({ id, userId, name });
});

// ── Pages ──────────────────────────────────────────────────────────────────

app.get('/api/journals/:journalId/pages', (req, res) => {
  res.json(db.prepare(`
    SELECT id, page_number, updated_at FROM pages
    WHERE journal_id = ? ORDER BY page_number
  `).all(req.params.journalId));
});

app.get('/api/journals/:journalId/pages/:pageNumber', (req, res) => {
  const n = parseInt(req.params.pageNumber, 10);
  if (isNaN(n) || n < 0) return res.status(400).end();
  const row = db.prepare(
    'SELECT data FROM pages WHERE journal_id = ? AND page_number = ?'
  ).get(req.params.journalId, n);
  if (!row) return res.status(404).end();
  res.set('Content-Type', 'image/png').send(row.data);
});

app.put('/api/journals/:journalId/pages/:pageNumber', (req, res) => {
  const { journalId } = req.params;
  const n = parseInt(req.params.pageNumber, 10);
  if (isNaN(n) || n < 0) return res.status(400).end();
  if (!db.prepare('SELECT id FROM journals WHERE id = ?').get(journalId)) {
    return res.status(404).json({ error: 'journal not found' });
  }
  const PREFIX = 'data:image/png;base64,';
  const { data } = req.body;
  if (typeof data !== 'string' || !data.startsWith(PREFIX)) {
    return res.status(400).json({ error: 'expected data:image/png;base64, string' });
  }
  const buf = Buffer.from(data.slice(PREFIX.length), 'base64');
  const existing = db.prepare(
    'SELECT id FROM pages WHERE journal_id = ? AND page_number = ?'
  ).get(journalId, n);
  if (existing) {
    db.prepare("UPDATE pages SET data = ?, updated_at = datetime('now') WHERE id = ?")
      .run(buf, existing.id);
    res.json({ id: existing.id, page_number: n });
  } else {
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO pages (id, journal_id, page_number, data) VALUES (?, ?, ?, ?)')
      .run(id, journalId, n, buf);
    res.status(201).json({ id, page_number: n });
  }
});

app.delete('/api/journals/:journalId/pages/:pageNumber', (req, res) => {
  const n = parseInt(req.params.pageNumber, 10);
  if (isNaN(n) || n < 0) return res.status(400).end();
  db.prepare('DELETE FROM pages WHERE journal_id = ? AND page_number = ?')
    .run(req.params.journalId, n);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Journal → http://localhost:${PORT}`);
});
