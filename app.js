(function() {
  'use strict';

  // ── State ───────────────────────────────────────────────
  const DB_NAME = 'journal_db';
  const DB_VER = 1;
  const STORE = 'pages';
  const PAGE_W = 560;   // reference page width; dot spacing scales proportionally with this
  const SAVE_W = 1754;  // fixed save resolution (A5 @ 150 DPI)
  const SAVE_H = 2480;

  let db = null;
  let currentPage = 0;   // in spread mode, always even-indexed (right-side page)
  let pages = {};
  let tool = 'pen';
  let penColor = '#1a1a1a';
  let penSize = 2;
  let spreadMode = false;
  const pendingSaves = new Map(); // canvas el → timeoutId
  let thumbPanelOpen = false;

  // View transform (zoom + rotation applied on top of auto-fit)
  let viewScale = 1;
  let viewRotation = 0;
  let viewTranslateX = 0, viewTranslateY = 0;
  let gestureActive = false;
  let gestureStartDist = 0, gestureStartAngle = 0, gestureStartScale = 1, gestureStartRotation = 0;
  let gestureStartMidX = 0, gestureStartMidY = 0, gestureStartTranslateX = 0, gestureStartTranslateY = 0;
  let rotationLocked = false;

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
  const journalBook = document.getElementById('journal-book');
  const journalWrap = document.getElementById('journal-wrap');
  const canvasLeft = document.getElementById('canvas-left');
  const ctxLeft = canvasLeft.getContext('2d');
  const svgLinesLeft = document.getElementById('page-lines-left');
  const pageLeft = document.getElementById('page-left');
  const cursorRing = document.getElementById('cursor-ring');

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

  // ── View transform ──────────────────────────────────────
  function applyViewTransform() {
    const identity = viewScale === 1 && viewRotation === 0 && viewTranslateX === 0 && viewTranslateY === 0;
    journalBook.style.transform = identity
      ? ''
      : `translate(${viewTranslateX}px, ${viewTranslateY}px) rotate(${viewRotation}deg) scale(${viewScale})`;
    updateCursorSize();
  }

  function resetView() {
    viewScale = 1;
    viewRotation = 0;
    viewTranslateX = 0;
    viewTranslateY = 0;
    journalBook.style.transform = '';
    updateCursorSize();
  }

  // ── Cursor ring ──────────────────────────────────────────
  function updateCursorSize() {
    let d;
    if (tool === 'eraser') d = penSize * 8;
    else if (tool === 'highlighter') d = penSize * 10;
    else d = penSize;
    d = Math.max(2, d * viewScale);
    cursorRing.style.width = d + 'px';
    cursorRing.style.height = d + 'px';
  }

  function attachCursorHandlers(targetCanvas) {
    targetCanvas.addEventListener('pointermove', e => {
      if (e.pointerType === 'touch') return;
      cursorRing.style.display = 'block';
      cursorRing.style.left = e.clientX + 'px';
      cursorRing.style.top = e.clientY + 'px';
      updateCursorSize();
    });
    targetCanvas.addEventListener('pointerleave', e => {
      if (e.pointerType === 'touch') return;
      cursorRing.style.display = 'none';
    });
  }

  attachCursorHandlers(canvas);
  attachCursorHandlers(canvasLeft);

  // ── Canvas setup ────────────────────────────────────────
  function setupCanvas(targetCanvas, targetCtx, targetContainer, targetSvg) {
    const rect = targetContainer.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    // Canvas is always the document resolution; browser CSS-scales it to fit the display.
    targetCanvas.width = SAVE_W;
    targetCanvas.height = SAVE_H;
    targetCanvas.style.width = rect.width + 'px';
    targetCanvas.style.height = rect.height + 'px';
    drawDots(targetSvg, rect.width, rect.height);
  }

  function setCanvasSize() {
    setupCanvas(canvas, ctx, pageContainer, svgLines);
    if (spreadMode) setupCanvas(canvasLeft, ctxLeft, pageLeft, svgLinesLeft);
  }

  function drawDots(svgEl, w, h) {
    svgEl.innerHTML = '';
    svgEl.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svgEl.style.width = w + 'px';
    svgEl.style.height = h + 'px';

    // Scale dot spacing with page width so dots stay aligned with
    // canvas content when the page is resized (zoom in/out on paper effect).
    const scale = w / PAGE_W;
    const gap = 30 * scale;
    const marginLeft = 30 * scale;
    const marginTop = 40 * scale;

    for (let y = marginTop; y < h - marginTop; y += gap) {
      for (let x = marginLeft; x < w - marginLeft; x += gap) {
        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('cx', x);
        dot.setAttribute('cy', y);
        dot.setAttribute('r', '1.2');
        dot.setAttribute('fill', 'var(--line-blue)');
        svgEl.appendChild(dot);
      }
    }
  }

  // ── Page load / save ────────────────────────────────────
  async function loadCanvasContent(targetCtx, targetCanvas, targetContainer, idx) {
    targetCtx.clearRect(0, 0, SAVE_W, SAVE_H);

    let dataURL = pages[idx];
    if (!dataURL) {
      dataURL = await dbGet(idx);
      if (dataURL) pages[idx] = dataURL;
    }

    if (dataURL) {
      await new Promise(resolve => {
        const img = new Image();
        img.onload = () => { targetCtx.drawImage(img, 0, 0, SAVE_W, SAVE_H); resolve(); };
        img.onerror = resolve;
        img.src = dataURL;
      });
    }
  }

  async function loadPage(idx) {
    if (spreadMode) {
      journalBook.classList.remove('spine-right');
      await loadCanvasContent(ctx, canvas, pageContainer, idx);
      const leftIdx = idx - 1;
      if (leftIdx >= 0) {
        canvasLeft.style.pointerEvents = 'auto';
        canvasLeft.style.cursor = 'none';
        await loadCanvasContent(ctxLeft, canvasLeft, pageLeft, leftIdx);
      } else {
        canvasLeft.style.pointerEvents = 'none';
        canvasLeft.style.cursor = 'default';
        ctxLeft.clearRect(0, 0, SAVE_W, SAVE_H);
      }
      pageLabel.textContent = leftIdx >= 0 ? `Pages ${leftIdx + 1}–${idx + 1}` : `Page ${idx + 1}`;
    } else {
      journalBook.classList.toggle('spine-right', idx % 2 === 1);
      await loadCanvasContent(ctx, canvas, pageContainer, idx);
      pageLabel.textContent = `Page ${idx + 1}`;
    }
  }

  function schedulePageSave(idx, targetCanvas, targetCtx) {
    if (idx < 0) return;
    if (pendingSaves.has(targetCanvas)) clearTimeout(pendingSaves.get(targetCanvas));
    pendingSaves.set(targetCanvas, setTimeout(async () => {
      pendingSaves.delete(targetCanvas);
      await saveCanvas(idx, targetCanvas, targetCtx);
    }, 600));
  }

  async function saveCanvas(idx, targetCanvas, targetCtx) {
    const data = targetCtx.getImageData(0, 0, SAVE_W, SAVE_H).data;
    const hasContent = data.some(v => v !== 0);
    if (hasContent) {
      const url = targetCanvas.toDataURL('image/png');
      pages[idx] = url;
      await dbPut(idx, url);
    } else {
      delete pages[idx];
      await dbDelete(idx);
    }
  }

  async function saveCurrentPages() {
    for (const timer of pendingSaves.values()) clearTimeout(timer);
    pendingSaves.clear();
    await saveCanvas(currentPage, canvas, ctx);
    if (spreadMode) {
      const leftIdx = currentPage - 1;
      if (leftIdx >= 0) await saveCanvas(leftIdx, canvasLeft, ctxLeft);
    }
  }

  // ── Drawing ─────────────────────────────────────────────
  function getPos(e, targetCanvas) {
    const pressure = e.pressure > 0 ? e.pressure : 0.5;
    // CSS display size of the canvas element.
    const cssW = parseFloat(targetCanvas.style.width);
    const cssH = parseFloat(targetCanvas.style.height);
    // Scale factor: CSS pixels → document (SAVE_W × SAVE_H) coordinates.
    const docScale = SAVE_W / cssW;

    let cssX, cssY;

    if (viewScale === 1 && viewRotation === 0) {
      const rect = targetCanvas.getBoundingClientRect();
      cssX = e.clientX - rect.left;
      cssY = e.clientY - rect.top;
    } else {
      // The CSS transform rotate(r)scale(s) on #journal-book is applied around its center.
      // For any rectangle, the AABB center equals the visual center, so the book's visual
      // center (which stays fixed under rotation around own center) can be read from the AABB.
      const bookRect = journalBook.getBoundingClientRect();
      const bookCx = (bookRect.left + bookRect.right) / 2;
      const bookCy = (bookRect.top + bookRect.bottom) / 2;

      const rad = viewRotation * Math.PI / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);

      function screenToBook(sx, sy) {
        const dx = (sx - bookCx) / viewScale;
        const dy = (sy - bookCy) / viewScale;
        return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos };
      }

      const canvasRect = targetCanvas.getBoundingClientRect();
      const canvasCenter = screenToBook(
        (canvasRect.left + canvasRect.right) / 2,
        (canvasRect.top + canvasRect.bottom) / 2
      );

      const pLocal = screenToBook(e.clientX, e.clientY);
      cssX = pLocal.x - (canvasCenter.x - cssW / 2);
      cssY = pLocal.y - (canvasCenter.y - cssH / 2);
    }

    return { x: cssX * docScale, y: cssY * docScale, pressure };
  }

  function applyTool(targetCtx, pos, lineScale) {
    if (tool === 'eraser') {
      targetCtx.globalCompositeOperation = 'destination-out';
      targetCtx.lineWidth = penSize * 8 * lineScale;
      targetCtx.strokeStyle = 'rgba(0,0,0,1)';
      targetCtx.globalAlpha = 1;
    } else if (tool === 'highlighter') {
      targetCtx.globalCompositeOperation = 'multiply';
      targetCtx.lineWidth = penSize * 10 * lineScale;
      targetCtx.strokeStyle = penColor;
      targetCtx.globalAlpha = 0.35;
    } else {
      targetCtx.globalCompositeOperation = 'source-over';
      targetCtx.lineWidth = Math.max(0.5, penSize * (0.5 + pos.pressure * 0.8)) * lineScale;
      targetCtx.strokeStyle = penColor;
      targetCtx.globalAlpha = 1;
    }
    targetCtx.lineCap = 'round';
    targetCtx.lineJoin = 'round';
  }

  function attachDrawHandlers(targetCanvas, targetCtx, getPageIndex) {
    let isDrawingLocal = false;
    let lastXLocal = 0, lastYLocal = 0;

    targetCanvas.addEventListener('pointerdown', e => {
      if (e.pointerType === 'touch') return;
      e.preventDefault();
      targetCanvas.setPointerCapture(e.pointerId);
      isDrawingLocal = true;
      const pos = getPos(e, targetCanvas);
      lastXLocal = pos.x; lastYLocal = pos.y;
      targetCtx.beginPath();
      targetCtx.moveTo(lastXLocal, lastYLocal);
    }, { passive: false });

    targetCanvas.addEventListener('pointermove', e => {
      if (!isDrawingLocal || e.pointerType === 'touch') return;
      e.preventDefault();
      const lineScale = SAVE_W / parseFloat(targetCanvas.style.width);
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of events) {
        const p = getPos(ev, targetCanvas);
        applyTool(targetCtx, p, lineScale);
        targetCtx.beginPath();
        targetCtx.moveTo(lastXLocal, lastYLocal);
        targetCtx.lineTo(p.x, p.y);
        targetCtx.stroke();
        lastXLocal = p.x; lastYLocal = p.y;
      }
      schedulePageSave(getPageIndex(), targetCanvas, targetCtx);
    }, { passive: false });

    targetCanvas.addEventListener('pointerup', () => {
      if (!isDrawingLocal) return;
      isDrawingLocal = false;
      targetCtx.globalCompositeOperation = 'source-over';
      targetCtx.globalAlpha = 1;
      schedulePageSave(getPageIndex(), targetCanvas, targetCtx);
    });

    targetCanvas.addEventListener('pointercancel', () => {
      isDrawingLocal = false;
      targetCtx.globalCompositeOperation = 'source-over';
      targetCtx.globalAlpha = 1;
    });
  }

  attachDrawHandlers(canvas, ctx, () => currentPage);
  attachDrawHandlers(canvasLeft, ctxLeft, () => currentPage - 1);

  // ── Touch gestures (finger swipe = page turn) ───────────
  let touchStartX = 0, touchStartY = 0, touchStartTime = 0;

  function attachSwipeHandlers(el) {
    el.addEventListener('touchstart', e => {
      if (e.touches.length >= 2) return; // gesture handler takes over
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      touchStartTime = Date.now();
    }, { passive: true });

    el.addEventListener('touchend', async e => {
      if (gestureActive || !e.changedTouches.length) return;
      const dx = e.changedTouches[0].clientX - touchStartX;
      const dy = Math.abs(e.changedTouches[0].clientY - touchStartY);
      const dt = Date.now() - touchStartTime;
      if (Math.abs(dx) > 55 && dy < 90 && dt < 500) {
        if (dx < 0) await flipPage(1);
        else await flipPage(-1);
      }
    }, { passive: true });
  }

  attachSwipeHandlers(canvas);
  attachSwipeHandlers(canvasLeft);

  // ── Pinch-to-zoom + rotation ─────────────────────────────
  journalWrap.addEventListener('touchstart', e => {
    if (e.touches.length !== 2) return;
    e.preventDefault();
    gestureActive = true;
    const t1 = e.touches[0], t2 = e.touches[1];
    gestureStartDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
    gestureStartAngle = Math.atan2(t2.clientY - t1.clientY, t2.clientX - t1.clientX) * 180 / Math.PI;
    gestureStartScale = viewScale;
    gestureStartRotation = viewRotation;
    gestureStartMidX = (t1.clientX + t2.clientX) / 2;
    gestureStartMidY = (t1.clientY + t2.clientY) / 2;
    gestureStartTranslateX = viewTranslateX;
    gestureStartTranslateY = viewTranslateY;
  }, { passive: false });

  journalWrap.addEventListener('touchmove', e => {
    if (!gestureActive || e.touches.length !== 2) return;
    e.preventDefault();
    const t1 = e.touches[0], t2 = e.touches[1];
    const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
    const angle = Math.atan2(t2.clientY - t1.clientY, t2.clientX - t1.clientX) * 180 / Math.PI;
    const midX = (t1.clientX + t2.clientX) / 2;
    const midY = (t1.clientY + t2.clientY) / 2;
    viewScale = Math.max(0.2, Math.min(5, gestureStartScale * (dist / gestureStartDist)));
    if (!rotationLocked) viewRotation = gestureStartRotation + (angle - gestureStartAngle);
    viewTranslateX = gestureStartTranslateX + (midX - gestureStartMidX);
    viewTranslateY = gestureStartTranslateY + (midY - gestureStartMidY);
    applyViewTransform();
  }, { passive: false });

  journalWrap.addEventListener('touchend', e => {
    if (e.touches.length < 2) gestureActive = false;
  }, { passive: true });

  // Scroll-wheel zoom for desktop/trackpad
  journalWrap.addEventListener('wheel', e => {
    e.preventDefault();
    viewScale = Math.max(0.2, Math.min(5, viewScale * (e.deltaY < 0 ? 1.1 : 0.9)));
    applyViewTransform();
  }, { passive: false });

  document.getElementById('btn-reset-view').addEventListener('click', resetView);

  document.getElementById('btn-lock-rotation').addEventListener('click', () => {
    rotationLocked = !rotationLocked;
    document.getElementById('btn-lock-rotation').classList.toggle('active', rotationLocked);
  });

  async function flipPage(dir) {
    if (dir === -1 && currentPage === 0) return;
    await saveCurrentPages();

    turnOverlay.classList.remove('flash-right', 'flash-left');
    void turnOverlay.offsetWidth;
    turnOverlay.classList.add(dir === 1 ? 'flash-right' : 'flash-left');

    currentPage = Math.max(0, currentPage + (spreadMode ? dir * 2 : dir));
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
    updateCursorSize();
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

  sizeSlider.addEventListener('input', () => { penSize = parseFloat(sizeSlider.value); updateCursorSize(); });

  document.getElementById('btn-clear').addEventListener('click', async () => {
    ctx.clearRect(0, 0, SAVE_W, SAVE_H);
    delete pages[currentPage];
    await dbDelete(currentPage);
    toast('Page cleared');
  });

  document.getElementById('btn-import').addEventListener('click', () => {
    document.getElementById('import-input').click();
  });

  document.getElementById('import-input').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';

    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(SAVE_W / img.naturalWidth, SAVE_H / img.naturalHeight);
      const dw = img.naturalWidth * scale;
      const dh = img.naturalHeight * scale;
      ctx.drawImage(img, (SAVE_W - dw) / 2, (SAVE_H - dh) / 2, dw, dh);
      schedulePageSave(currentPage, canvas, ctx);
      toast('Image imported');
    };
    img.onerror = () => { URL.revokeObjectURL(url); toast('Failed to load image'); };
    img.src = url;
  });

  document.getElementById('btn-export').addEventListener('click', () => {
    const link = document.createElement('a');
    link.download = `journal-page-${currentPage + 1}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
    toast('Page exported');
  });

  // ── Spread toggle ────────────────────────────────────────
  document.getElementById('btn-spread').addEventListener('click', async () => {
    await saveCurrentPages();
    spreadMode = !spreadMode;
    document.getElementById('btn-spread').classList.toggle('active', spreadMode);

    if (spreadMode) {
      // Snap to nearest even (right-side) page index
      if (currentPage % 2 === 1) currentPage++;
      journalBook.classList.add('spread');
    } else {
      journalBook.classList.remove('spread');
    }

    setCanvasSize();
    await loadPage(currentPage);
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
        await saveCurrentPages();
        currentPage = idx;
        if (spreadMode && currentPage % 2 === 1) currentPage++;
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
      await saveCurrentPages();
      setCanvasSize();
      await loadPage(currentPage);
    });
  }

  init();
})();
