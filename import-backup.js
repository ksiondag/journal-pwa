'use strict';

const fs = require('fs');
const path = require('path');

const file = process.argv[2];
if (!file) {
  console.error('Usage: node import-backup.js <journal-backup.json>');
  process.exit(1);
}

const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!backup.pages || typeof backup.pages !== 'object') {
  console.error('Invalid backup file.');
  process.exit(1);
}

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const PREFIX = 'data:image/png;base64,';
let count = 0;
for (const [key, data] of Object.entries(backup.pages)) {
  const id = parseInt(key, 10);
  if (isNaN(id) || id < 0 || typeof data !== 'string' || !data.startsWith(PREFIX)) continue;
  fs.writeFileSync(path.join(DATA_DIR, `${id}.png`), Buffer.from(data.slice(PREFIX.length), 'base64'));
  count++;
}

console.log(`Imported ${count} page${count !== 1 ? 's' : ''} → data/`);
