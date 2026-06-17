'use strict';

const Database = require('better-sqlite3');
const bcrypt   = require('bcryptjs');
const crypto   = require('crypto');
const path     = require('path');

const [username, password] = process.argv.slice(2);

if (!username || !password) {
  console.error('Usage: node create-user.js <username> <password>');
  process.exit(1);
}
if (password.length < 8) {
  console.error('Password must be at least 8 characters');
  process.exit(1);
}

const db = new Database(path.join(__dirname, 'journal.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Ensure password_hash column exists (migration for older databases)
const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
if (!cols.includes('password_hash')) {
  db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
}

if (db.prepare('SELECT id FROM users WHERE name = ?').get(username)) {
  console.error(`User "${username}" already exists`);
  process.exit(1);
}

bcrypt.hash(password, 12).then(hash => {
  const userId = crypto.randomUUID();
  db.transaction(() => {
    db.prepare('INSERT INTO users (id, name, password_hash) VALUES (?, ?, ?)').run(userId, username, hash);
    db.prepare('INSERT INTO journals (id, user_id, name) VALUES (?, ?, ?)').run(
      crypto.randomUUID(), userId, 'My Journal'
    );
  })();
  console.log(`Created user "${username}" (id: ${userId})`);
});
