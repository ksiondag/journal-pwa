'use strict';

const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const file = process.argv[2];
if (!file) {
  console.error('Usage: node import-backup.js <journal-backup.json> [journal-id]');
  process.exit(1);
}

const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!backup.pages || typeof backup.pages !== 'object') {
  console.error('Invalid backup file.');
  process.exit(1);
}

const db = new Database(path.join(__dirname, 'journal.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
if (!cols.includes('password_hash')) {
  db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
}

// Resolve target journal: use provided ID, or the first journal in the DB
let journalId = process.argv[3] || null;
if (journalId) {
  if (!db.prepare('SELECT id FROM journals WHERE id = ?').get(journalId)) {
    console.error(`Journal ${journalId} not found.`);
    process.exit(1);
  }
} else {
  const journal = db.prepare('SELECT id FROM journals LIMIT 1').get();
  if (!journal) {
    console.error('No journals found. Start the server once to create the default journal.');
    process.exit(1);
  }
  journalId = journal.id;
}

const PREFIX = 'data:image/png;base64,';
const upsert = db.prepare(`
  INSERT INTO pages (id, journal_id, page_number, data)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(journal_id, page_number)
  DO UPDATE SET data = excluded.data, updated_at = datetime('now')
`);

let count = 0;
db.transaction(() => {
  for (const [key, data] of Object.entries(backup.pages)) {
    const pageNumber = parseInt(key, 10);
    if (isNaN(pageNumber) || pageNumber < 0) continue;
    if (typeof data !== 'string' || !data.startsWith(PREFIX)) continue;
    upsert.run(crypto.randomUUID(), journalId, pageNumber, Buffer.from(data.slice(PREFIX.length), 'base64'));
    count++;
  }
})();

console.log(`Imported ${count} page${count !== 1 ? 's' : ''} → journal ${journalId}`);
