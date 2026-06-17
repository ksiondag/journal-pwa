(function() {
  'use strict';

  // iOS Safari fires gesturestart/change/end before touchstart for pinch/rotate,
  // bypassing our touch handlers. Block them so the browser never gets to zoom.
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(type =>
    document.addEventListener(type, e => e.preventDefault(), { passive: false })
  );

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
    const brush = BRUSH_DEFS[tool];
    const d = Math.max(2, penSize * (brush ? brush.baseSize : 1) * viewScale);
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
      serverSave(idx, url);
    } else {
      delete pages[idx];
      await dbDelete(idx);
      serverDeletePage(idx);
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

  // ── Brush engine ─────────────────────────────────────────

  function hexToRgb(hex) {
    const c = hex.replace('#', '');
    const s = c.length === 3 ? c.split('').map(v => v+v).join('') : c;
    return [parseInt(s.slice(0,2),16), parseInt(s.slice(2,4),16), parseInt(s.slice(4,6),16)];
  }

  function lerp(a, b, t) { return a + (b - a) * t; }

  const BRUSH_DEFS = {
    pen: {
      spacing: 0.06,
      sizePressure: 0.7,
      opacityPressure: 0,
      baseOpacity: 1,
      baseSize: 1,
      scatter: 0,
      hardness: 0.82,
      blendMode: 'source-over',
    },
    pencil: {
      spacing: 0.18,
      sizePressure: 0.35,
      opacityPressure: 0.5,
      baseOpacity: 0.75,
      baseSize: 1.2,
      scatter: 0.7,
      hardness: 0.2,
      blendMode: 'source-over',
    },
    highlighter: {
      spacing: 0.04,
      sizePressure: 0,
      opacityPressure: 0,
      baseOpacity: 0.28,
      baseSize: 10,
      scatter: 0,
      hardness: 0.92,
      blendMode: 'multiply',
    },
    eraser: {
      spacing: 0.06,
      sizePressure: 0,
      opacityPressure: 0,
      baseOpacity: 1,
      baseSize: 8,
      scatter: 0,
      hardness: 1.0,
      blendMode: 'destination-out',
    },
  };

  function stampDab(ctx, x, y, diameter, opacity, brush) {
    const r = diameter / 2;
    if (r < 0.3) return;
    ctx.save();
    ctx.globalCompositeOperation = brush.blendMode;
    ctx.globalAlpha = opacity;
    const [cr, cg, cb] = brush.blendMode === 'destination-out' ? [0,0,0] : hexToRgb(penColor);
    if (brush.hardness >= 0.99) {
      ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
    } else {
      const grad = ctx.createRadialGradient(x, y, r * brush.hardness, x, y, r);
      grad.addColorStop(0, `rgba(${cr},${cg},${cb},1)`);
      grad.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      ctx.fillStyle = grad;
    }
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Catmull-Rom: evaluate point+pressure at t through segment P1→P2
  function cmEval(p0, p1, p2, p3, t) {
    const t2 = t*t, t3 = t2*t;
    const f = (a,b,c,d) => 0.5*((2*b)+(-a+c)*t+(2*a-5*b+4*c-d)*t2+(-a+3*b-3*c+d)*t3);
    return { x: f(p0.x,p1.x,p2.x,p3.x), y: f(p0.y,p1.y,p2.y,p3.y), pressure: f(p0.pressure,p1.pressure,p2.pressure,p3.pressure) };
  }

  // Walk P1→P2 Catmull-Rom segment, stamp dabs, return updated carry distance
  function renderSplineSegment(ctx, p0, p1, p2, p3, brush, lineScale, carry) {
    const baseDiam = penSize * brush.baseSize * lineScale;
    const spacing = Math.max(1, baseDiam * brush.spacing);
    const STEPS = 30;
    let prev = cmEval(p0, p1, p2, p3, 0);

    for (let i = 1; i <= STEPS; i++) {
      const cur = cmEval(p0, p1, p2, p3, i / STEPS);
      const segLen = Math.hypot(cur.x - prev.x, cur.y - prev.y);
      carry += segLen;

      while (carry >= spacing) {
        carry -= spacing;
        const frac = segLen > 0 ? 1 - carry / segLen : 1;
        const pressure = Math.max(0.01, lerp(prev.pressure, cur.pressure, frac));
        const px = lerp(prev.x, cur.x, frac);
        const py = lerp(prev.y, cur.y, frac);
        const diam = Math.max(1, baseDiam * lerp(1, pressure, brush.sizePressure));
        const opacity = brush.baseOpacity * lerp(1, pressure, brush.opacityPressure);

        let sx = px, sy = py;
        if (brush.scatter > 0) {
          const ang = Math.atan2(cur.y - prev.y, cur.x - prev.x) + Math.PI / 2;
          const amt = (Math.random() - 0.5) * diam * brush.scatter;
          sx += Math.cos(ang) * amt;
          sy += Math.sin(ang) * amt;
        }

        stampDab(ctx, sx, sy, diam, opacity, brush);
      }
      prev = cur;
    }
    return carry;
  }

  function attachDrawHandlers(targetCanvas, targetCtx, getPageIndex) {
    let isDrawingLocal = false;
    let strokeTool = tool;
    let strokePts = [];
    let distCarry = 0;

    function getLineScale() { return SAVE_W / parseFloat(targetCanvas.style.width); }

    function flushSegment(idx) {
      const brush = BRUSH_DEFS[strokeTool] || BRUSH_DEFS.pen;
      const n = strokePts.length - 1;
      distCarry = renderSplineSegment(
        targetCtx,
        strokePts[Math.max(0, idx - 1)],
        strokePts[idx],
        strokePts[idx + 1],
        strokePts[Math.min(n, idx + 2)],
        brush, getLineScale(), distCarry
      );
    }

    targetCanvas.addEventListener('pointerdown', e => {
      if (e.pointerType === 'touch') return;
      e.preventDefault();
      targetCanvas.setPointerCapture(e.pointerId);
      isDrawingLocal = true;
      strokeTool = (e.pointerType === 'pen' && (e.buttons & 32)) ? 'eraser' : tool;
      strokePts = [getPos(e, targetCanvas)];
      distCarry = 0;
    }, { passive: false });

    targetCanvas.addEventListener('pointermove', e => {
      if (!isDrawingLocal || e.pointerType === 'touch') return;
      e.preventDefault();
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of events) {
        strokePts.push(getPos(ev, targetCanvas));
        if (strokePts.length >= 3) flushSegment(strokePts.length - 3);
      }
      schedulePageSave(getPageIndex(), targetCanvas, targetCtx);
    }, { passive: false });

    function finishStroke() {
      if (!isDrawingLocal) return;
      isDrawingLocal = false;
      const brush = BRUSH_DEFS[strokeTool] || BRUSH_DEFS.pen;
      if (strokePts.length === 1) {
        const p = strokePts[0];
        const diam = Math.max(1, penSize * brush.baseSize * getLineScale() * lerp(1, p.pressure, brush.sizePressure));
        stampDab(targetCtx, p.x, p.y, diam, brush.baseOpacity, brush);
      } else if (strokePts.length >= 2) {
        flushSegment(strokePts.length - 2);
      }
      targetCtx.globalCompositeOperation = 'source-over';
      targetCtx.globalAlpha = 1;
      schedulePageSave(getPageIndex(), targetCanvas, targetCtx);
    }

    targetCanvas.addEventListener('pointerup', finishStroke);
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
  document.getElementById('btn-pencil').dataset.tool = 'pencil';
  document.getElementById('btn-eraser').dataset.tool = 'eraser';
  document.getElementById('btn-highlighter').dataset.tool = 'highlighter';
  document.getElementById('btn-pen').classList.add('active');

  document.getElementById('btn-pen').addEventListener('click', () => setTool('pen'));
  document.getElementById('btn-pencil').addEventListener('click', () => setTool('pencil'));
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
    serverDeletePage(currentPage);
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

  document.getElementById('btn-backup').addEventListener('click', async () => {
    await saveCurrentPages();
    const keys = await dbGetAllKeys();
    const backup = { version: 1, pages: {} };
    for (const key of keys) {
      const data = await dbGet(key);
      if (data) backup.pages[key] = data;
    }
    const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = `journal-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.href = url;
    link.click();
    URL.revokeObjectURL(url);
    toast(`Backed up ${keys.length} page${keys.length !== 1 ? 's' : ''}`);
  });

  document.getElementById('btn-restore').addEventListener('click', () => {
    document.getElementById('restore-input').click();
  });

  document.getElementById('restore-input').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';

    let backup;
    try {
      backup = JSON.parse(await file.text());
    } catch {
      toast('Invalid backup file');
      return;
    }

    if (!backup.pages || typeof backup.pages !== 'object') {
      toast('Invalid backup file');
      return;
    }

    if (!confirm('Restore journal? All current pages will be replaced.')) return;

    await saveCurrentPages();

    const existingKeys = await dbGetAllKeys();
    for (const key of existingKeys) {
      await dbDelete(key);
      serverDeletePage(key);
    }
    pages = {};

    let count = 0;
    for (const [key, data] of Object.entries(backup.pages)) {
      const id = parseInt(key, 10);
      if (!isNaN(id) && typeof data === 'string' && data.startsWith('data:')) {
        await dbPut(id, data);
        serverSave(id, data);
        count++;
      }
    }

    currentPage = 0;
    await loadPage(currentPage);
    toast(`Restored ${count} page${count !== 1 ? 's' : ''}`);
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

  // ── Server sync ──────────────────────────────────────────
  const serverDot = document.getElementById('server-dot');

  function setServerStatus(online) {
    serverDot.className = online ? 'online' : 'offline';
    serverDot.title = online ? 'Server: connected' : 'Server: offline (local only)';
  }

  async function serverSave(id, dataURL) {
    try {
      const res = await fetch(`/api/pages/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: dataURL }),
      });
      if (res.ok) setServerStatus(true);
    } catch (_) {
      setServerStatus(false);
    }
  }

  function serverDeletePage(id) {
    fetch(`/api/pages/${id}`, { method: 'DELETE' }).catch(() => {});
  }

  async function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  async function syncFromServer() {
    let serverIds;
    try {
      const res = await fetch('/api/pages');
      if (!res.ok) throw new Error();
      serverIds = await res.json();
      setServerStatus(true);
    } catch (_) {
      setServerStatus(false);
      return;
    }

    const localKeys = new Set(await dbGetAllKeys());
    const serverSet = new Set(serverIds);

    // Download pages from server that aren't in local DB
    for (const id of serverIds) {
      if (!localKeys.has(id)) {
        try {
          const res = await fetch(`/api/pages/${id}`);
          if (!res.ok) continue;
          const dataURL = await blobToDataURL(await res.blob());
          await dbPut(id, dataURL);
          pages[id] = dataURL;
        } catch (_) {}
      }
    }

    // Push local pages that aren't on the server yet (made while offline)
    for (const id of localKeys) {
      if (!serverSet.has(id)) {
        const dataURL = pages[id] || await dbGet(id);
        if (dataURL) serverSave(id, dataURL);
      }
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
    if (e.key === 'c' || e.key === 'C') setTool('pencil');
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
    await syncFromServer();
    await loadPage(0);

    window.addEventListener('resize', async () => {
      await saveCurrentPages();
      setCanvasSize();
      await loadPage(currentPage);
    });
  }

  init();
})();
