'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });

app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname, { index: 'index.html' }));

// List page IDs that exist on disk
app.get('/api/pages', (req, res) => {
  const ids = fs.readdirSync(DATA_DIR)
    .filter(f => /^\d+\.png$/.test(f))
    .map(f => parseInt(f, 10))
    .sort((a, b) => a - b);
  res.json(ids);
});

// Fetch a single page as PNG
app.get('/api/pages/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || id < 0) return res.status(400).end();
  const file = path.join(DATA_DIR, `${id}.png`);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.sendFile(file);
});

// Save a page (body: { data: "data:image/png;base64,..." })
app.put('/api/pages/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || id < 0) return res.status(400).end();
  const { data } = req.body;
  const PREFIX = 'data:image/png;base64,';
  if (typeof data !== 'string' || !data.startsWith(PREFIX)) {
    return res.status(400).json({ error: 'Expected data:image/png;base64, string' });
  }
  fs.writeFileSync(path.join(DATA_DIR, `${id}.png`), Buffer.from(data.slice(PREFIX.length), 'base64'));
  res.json({ ok: true });
});

// Delete a page
app.delete('/api/pages/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || id < 0) return res.status(400).end();
  try { fs.unlinkSync(path.join(DATA_DIR, `${id}.png`)); } catch (_) {}
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Journal → http://localhost:${PORT}`);
});
