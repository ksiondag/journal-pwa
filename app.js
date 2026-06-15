(function() {
  'use strict';

  // ── State ───────────────────────────────────────────────
  const DB_NAME = 'journal_db';
  const DB_VER = 1;
  const STORE = 'pages';

  let db = null;
  let currentPage = 0;
  let pages = {}; // cache: pageIndex -> dataURL
  let tool = 'pen';
  let penColor = '#1a1a1a';
  let penSize = 2;
  let isDrawing = false;
  let lastX = 0, lastY = 0;
  let pendingSave = null;
  let thumbPanelOpen = false;

  // ── Elements ────────────────────────────────────────────
  const canvas = document.getElementById('draw-canvas');
  const ctx = canvas.getContext('2d');
  const svgLines = document.getElementById('page-lines');
  const pageLabel = document.getElementById('page-label');
  const colorInput = document.getElementById('color-input');
  const colorSwatch = document.getElementById('color-swatch');
  const sizeSlider = document.getElementById('size-slider');
  const turnOverlay = document.getElementById('turn-overlay');
  const thumbPanel = document.getElementById('thumb-panel');
  const thumbList = document.getElementById('thumb-list');
  const pageContainer = document.getElementById('page-container');

  // ── IndexedDB ───────────────────────────────────────────
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = e => e.target.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = e => resolve(e.target.result);
      req.onerror = () => reject(req.error);
    });
  }

  function dbGet(id) {
    return new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result ? req.result.data : null);
      req.onerror = () => resolve(null);
    });
  }

  function dbPut(id, data) {
    return new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ id, data });
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
  }

  function dbDelete(id) {
    return new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
  }

  function dbGetAllKeys() {
    return new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAllKeys();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  }

  // ── Canvas setup ────────────────────────────────────────
  function setCanvasSize() {
    const rect = pageContainer.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    drawRuledLines(rect.width, rect.height);
  }

  function drawRuledLines(w, h) {
    svgLines.innerHTML = '';
    svgLines.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svgLines.style.width = w + 'px';
    svgLines.style.height = h + 'px';

    const lineGap = 30;
    const marginTop = 50;

    for (let y = marginTop; y < h - 24; y += lineGap) {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', '0'); line.setAttribute('x2', w);
      line.setAttribute('y1', y); line.setAttribute('y2', y);
      line.setAttribute('stroke', 'var(--line-blue)');
      line.setAttribute('stroke-width', '0.8');
      svgLines.appendChild(line);
    }
    const redLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    redLine.setAttribute('x1', '56'); redLine.setAttribute('x2', '56');
    redLine.setAttribute('y1', '0'); redLine.setAttribute('y2', h);
    redLine.setAttribute('stroke', 'var(--line-red)');
    redLine.setAttribute('stroke-width', '1');
    svgLines.appendChild(redLine);
  }

  // ── Page load / save ────────────────────────────────────
  async function loadPage(idx) {
    const rect = pageContainer.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);

    let dataURL = pages[idx];
    if (!dataURL) {
      dataURL = await dbGet(idx);
      if (dataURL) pages[idx] = dataURL;
    }

    if (dataURL) {
      await new Promise(resolve => {
        const img = new Image();
        img.onload = () => { ctx.drawImage(img, 0, 0, rect.width, rect.height); resolve(); };
        img.onerror = resolve;
        img.src = dataURL;
      });
    }
    pageLabel.textContent = `Page ${idx + 1}`;
  }

  function scheduleSave() {
    if (pendingSave) clearTimeout(pendingSave);
    pendingSave = setTimeout(() => { savePage(currentPage); }, 600);
  }

  async function savePage(idx) {
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const hasContent = data.some(v => v !== 0);
    if (hasContent) {
      const url = canvas.toDataURL('image/png');
      pages[idx] = url;
      await dbPut(idx, url);
    } else {
      delete pages[idx];
      await dbDelete(idx);
    }
  }

  // ── Drawing ─────────────────────────────────────────────
  function getPos(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      pressure: e.pressure > 0 ? e.pressure : 0.5
    };
  }

  function applyTool(pos) {
    if (tool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.lineWidth = penSize * 8;
      ctx.strokeStyle = 'rgba(0,0,0,1)';
      ctx.globalAlpha = 1;
    } else if (tool === 'highlighter') {
      ctx.globalCompositeOperation = 'multiply';
      ctx.lineWidth = penSize * 10;
      ctx.strokeStyle = penColor;
      ctx.globalAlpha = 0.35;
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.lineWidth = Math.max(0.5, penSize * (0.5 + pos.pressure * 0.8));
      ctx.strokeStyle = penColor;
      ctx.globalAlpha = 1;
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }

  canvas.addEventListener('pointerdown', e => {
    if (e.pointerType === 'touch') return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    isDrawing = true;
    const pos = getPos(e);
    lastX = pos.x; lastY = pos.y;
    ctx.beginPath();
    ctx.moveTo(lastX, lastY);
  }, { passive: false });

  canvas.addEventListener('pointermove', e => {
    if (!isDrawing || e.pointerType === 'touch') return;
    e.preventDefault();

    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of events) {
      const p = getPos(ev);
      applyTool(p);
      ctx.beginPath();
      ctx.moveTo(lastX, lastY);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      lastX = p.x; lastY = p.y;
    }
    scheduleSave();
  }, { passive: false });

  canvas.addEventListener('pointerup', () => {
    if (!isDrawing) return;
    isDrawing = false;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    scheduleSave();
  });

  canvas.addEventListener('pointercancel', () => {
    isDrawing = false;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  });

  // ── Touch gestures (finger swipe = page turn) ───────────
  let touchStartX = 0, touchStartY = 0, touchStartTime = 0;

  canvas.addEventListener('touchstart', e => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    touchStartTime = Date.now();
  }, { passive: true });

  canvas.addEventListener('touchend', async e => {
    if (!e.changedTouches.length) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = Math.abs(e.changedTouches[0].clientY - touchStartY);
    const dt = Date.now() - touchStartTime;
    if (Math.abs(dx) > 55 && dy < 90 && dt < 500) {
      if (dx < 0) await flipPage(1);
      else await flipPage(-1);
    }
  }, { passive: true });

  async function flipPage(dir) {
    if (dir === -1 && currentPage === 0) return;
    await savePage(currentPage);
    turnOverlay.classList.remove('flash-right', 'flash-left');
    void turnOverlay.offsetWidth;
    turnOverlay.classList.add(dir === 1 ? 'flash-right' : 'flash-left');
    currentPage += dir;
    await loadPage(currentPage);
  }

  document.getElementById('btn-next').addEventListener('click', () => flipPage(1));
  document.getElementById('btn-prev').addEventListener('click', () => flipPage(-1));

  // ── Toolbar ─────────────────────────────────────────────
  function setTool(t) {
    tool = t;
    document.querySelectorAll('.tool-btn[data-tool]').forEach(b => b.classList.remove('active'));
    const btn = document.querySelector(`.tool-btn[data-tool="${t}"]`);
    if (btn) btn.classList.add('active');
  }

  document.getElementById('btn-pen').dataset.tool = 'pen';
  document.getElementById('btn-eraser').dataset.tool = 'eraser';
  document.getElementById('btn-highlighter').dataset.tool = 'highlighter';
  document.getElementById('btn-pen').classList.add('active');

  document.getElementById('btn-pen').addEventListener('click', () => setTool('pen'));
  document.getElementById('btn-eraser').addEventListener('click', () => setTool('eraser'));
  document.getElementById('btn-highlighter').addEventListener('click', () => setTool('highlighter'));

  colorInput.addEventListener('input', () => {
    penColor = colorInput.value;
    colorSwatch.style.background = penColor;
  });
  colorSwatch.style.background = penColor;

  sizeSlider.addEventListener('input', () => { penSize = parseFloat(sizeSlider.value); });

  document.getElementById('btn-clear').addEventListener('click', async () => {
    const rect = pageContainer.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    delete pages[currentPage];
    await dbDelete(currentPage);
    toast('Page cleared');
  });

  document.getElementById('btn-export').addEventListener('click', () => {
    const exp = document.createElement('canvas');
    exp.width = canvas.width;
    exp.height = canvas.height;
    const ectx = exp.getContext('2d');
    ectx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim() || '#FAF7F0';
    ectx.fillRect(0, 0, exp.width, exp.height);
    ectx.drawImage(canvas, 0, 0);
    const link = document.createElement('a');
    link.download = `journal-page-${currentPage + 1}.png`;
    link.href = exp.toDataURL('image/png');
    link.click();
    toast('Page exported');
  });

  // ── Thumbnails ──────────────────────────────────────────
  document.getElementById('btn-thumbs').addEventListener('click', async () => {
    thumbPanelOpen = !thumbPanelOpen;
    thumbPanel.classList.toggle('open', thumbPanelOpen);
    if (thumbPanelOpen) await renderThumbs();
  });
  document.getElementById('thumb-close').addEventListener('click', () => {
    thumbPanelOpen = false;
    thumbPanel.classList.remove('open');
  });

  async function renderThumbs() {
    thumbList.innerHTML = '';
    const keys = await dbGetAllKeys();
    const allPages = new Set([...keys, currentPage]);
    const sorted = [...allPages].sort((a, b) => a - b);

    // Add a blank new page at the end
    const maxPage = sorted.length ? Math.max(...sorted) : 0;
    sorted.push(maxPage + 1);

    for (const idx of sorted) {
      const item = document.createElement('div');
      item.className = 'thumb-item' + (idx === currentPage ? ' active-thumb' : '');

      const tc = document.createElement('canvas');
      tc.width = 100; tc.height = 70;
      const tctx = tc.getContext('2d');
      tctx.fillStyle = '#FAF7F0';
      tctx.fillRect(0, 0, 100, 70);

      const dataURL = pages[idx] || await dbGet(idx);
      if (dataURL) {
        await new Promise(r => {
          const img = new Image();
          img.onload = () => { tctx.drawImage(img, 0, 0, 100, 70); r(); };
          img.onerror = r;
          img.src = dataURL;
        });
      }

      const numEl = document.createElement('span');
      numEl.className = 'thumb-num';
      numEl.textContent = idx + 1;

      item.appendChild(tc);
      item.appendChild(numEl);
      item.addEventListener('click', async () => {
        await savePage(currentPage);
        currentPage = idx;
        await loadPage(currentPage);
        thumbPanelOpen = false;
        thumbPanel.classList.remove('open');
      });
      thumbList.appendChild(item);
    }
  }

  // ── Toast ────────────────────────────────────────────────
  let toastTimer;
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2000);
  }

  // ── Service worker ───────────────────────────────────────
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // ── Keyboard shortcuts ───────────────────────────────────
  document.addEventListener('keydown', async e => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); await flipPage(1); }
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); await flipPage(-1); }
    if (e.key === 'p' || e.key === 'P') setTool('pen');
    if (e.key === 'e' || e.key === 'E') setTool('eraser');
    if (e.key === 'h' || e.key === 'H') setTool('highlighter');
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
      toast('Undo coming soon — save often!');
    }
  });

  // ── Init ─────────────────────────────────────────────────
  async function init() {
    db = await openDB();
    setCanvasSize();
    await loadPage(0);

    window.addEventListener('resize', async () => {
      await savePage(currentPage);
      setCanvasSize();
      await loadPage(currentPage);
    });
  }

  init();
})();
