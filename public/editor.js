// Arto — редактор изображений.
// Ядро: холст картинки, холст выделения (маски), история, панель инструментов.
// Инструменты лежат в public/tools/*.js и регистрируются через Editor.register({...}).
// Как написать свой инструмент — см. AGENTS.md.

const Editor = (() => {
  const $ = (s) => document.querySelector(s);
  const tools = [];
  const ed = {
    img: null,    // canvas: текущая картинка в полном размере
    mask: null,   // canvas того же размера: белое = выделено
    view: null,   // canvas на экране
    scale: 1, ox: 0, oy: 0,
    tool: null,
    history: [], future: [],
    source: null, // { jobId, index } — откуда открыта картинка
    overlay: null, // функция дорисовки поверх (например, рамка обрезки)
    original: null, // картинка при открытии — для «До / после»
    compare: null,  // null — выключено, иначе положение линии 0..1
  };

  // ---------- регистрация инструментов ----------
  function register(tool) {
    if (tools.some((t) => t.id === tool.id)) return;
    tools.push({ group: 'tools', order: 50, ...tool });
    tools.sort((a, b) => a.order - b.order);
    if (!$('#editor').hidden) renderToolbar();
  }

  async function loadTools() {
    const list = await (await fetch('/api/tools')).json();
    await Promise.all(list.map((src) => new Promise((ok) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = ok;
      s.onerror = () => { console.error('Не загрузился инструмент', src); ok(); };
      document.body.append(s);
    })));
  }

  // ---------- холсты ----------
  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  function clone(c) {
    const n = makeCanvas(c.width, c.height);
    n.getContext('2d').drawImage(c, 0, 0);
    return n;
  }

  function fit() {
    const box = $('#edStage');
    const dpr = window.devicePixelRatio || 1;
    const W = box.clientWidth, H = box.clientHeight;
    ed.view.width = W * dpr; ed.view.height = H * dpr;
    ed.view.style.width = W + 'px'; ed.view.style.height = H + 'px';
    const pad = 24;
    ed.scale = Math.min((W - pad * 2) / ed.img.width, (H - pad * 2) / ed.img.height, 4);
    ed.ox = (W - ed.img.width * ed.scale) / 2;
    ed.oy = (H - ed.img.height * ed.scale) / 2;
    redraw();
  }

  let maskTint = null;
  function maskChanged() { maskTint = null; redraw(); }

  function redraw() {
    if (!ed.img) return;
    const dpr = window.devicePixelRatio || 1;
    const g = ed.view.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, ed.view.width, ed.view.height);
    g.save();
    g.translate(ed.ox, ed.oy);
    g.scale(ed.scale, ed.scale);
    g.imageSmoothingQuality = 'high';
    if (ed.preview) g.filter = ed.preview;
    g.drawImage(ed.img, 0, 0);
    g.filter = 'none';
    if (ed.compare != null && ed.original) {
      // левее линии — оригинал (растянут под текущий размер, если картинку обрезали)
      const cx = ed.img.width * ed.compare;
      g.save();
      g.beginPath();
      g.rect(0, 0, cx, ed.img.height);
      g.clip();
      g.drawImage(ed.original, 0, 0, ed.img.width, ed.img.height);
      g.restore();
    }
    if (hasMask()) {
      if (!maskTint) {
        maskTint = makeCanvas(ed.mask.width, ed.mask.height);
        const t = maskTint.getContext('2d');
        t.fillStyle = 'rgba(232, 120, 90, 0.45)';
        t.fillRect(0, 0, maskTint.width, maskTint.height);
        t.globalCompositeOperation = 'destination-in';
        t.drawImage(ed.mask, 0, 0);
      }
      g.drawImage(maskTint, 0, 0);
    }
    g.restore();
    if (ed.compare != null) {
      const x = ed.ox + ed.img.width * ed.compare * ed.scale;
      const top = ed.oy, bottom = ed.oy + ed.img.height * ed.scale;
      g.fillStyle = '#fff';
      g.fillRect(x - 1, top, 2, bottom - top);
      g.beginPath();
      g.arc(x, (top + bottom) / 2, 14, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#111';
      g.font = '600 13px Segoe UI, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('‹›', x, (top + bottom) / 2 + 1);
      g.textAlign = 'left';
      g.fillStyle = 'rgba(0,0,0,.6)';
      g.fillRect(ed.ox + 8, top + 8, 34, 20);
      g.fillRect(ed.ox + ed.img.width * ed.scale - 58, top + 8, 50, 20);
      g.fillStyle = '#fff';
      g.font = '12px Segoe UI, sans-serif';
      g.fillText('до', ed.ox + 16, top + 19);
      g.fillText('после', ed.ox + ed.img.width * ed.scale - 50, top + 19);
    }
    if (ed.overlay && ed.compare == null) ed.overlay(g);
    if (ed.tool?.drawCursor && ed.pointer) ed.tool.drawCursor(g, ed.pointer, api);
  }

  // ---------- выделение ----------
  let maskEmptyCache = true;
  function hasMask() { return !maskEmptyCache; }
  function updateMaskFlag() {
    const d = ed.mask.getContext('2d').getImageData(0, 0, ed.mask.width, ed.mask.height).data;
    maskEmptyCache = true;
    for (let i = 3; i < d.length; i += 16) if (d[i] > 0) { maskEmptyCache = false; break; }
    $('#edMaskInfo').hidden = maskEmptyCache;
  }
  function clearMask() {
    ed.mask.getContext('2d').clearRect(0, 0, ed.mask.width, ed.mask.height);
    updateMaskFlag(); maskChanged();
  }
  function invertMask() {
    const m = ed.mask.getContext('2d');
    const inv = makeCanvas(ed.mask.width, ed.mask.height);
    const g = inv.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, inv.width, inv.height);
    g.globalCompositeOperation = 'destination-out';
    g.drawImage(ed.mask, 0, 0);
    m.clearRect(0, 0, ed.mask.width, ed.mask.height);
    m.drawImage(inv, 0, 0);
    updateMaskFlag(); maskChanged();
  }
  // Маска с мягким краем — чтобы правки «вплавлялись» в картинку
  function softMask(feather = 6) {
    const c = makeCanvas(ed.mask.width, ed.mask.height);
    const g = c.getContext('2d');
    g.filter = `blur(${feather}px)`;
    g.drawImage(ed.mask, 0, 0);
    return c;
  }
  // Нарисовать result поверх текущей картинки только в выделенной области (или везде, если выделения нет)
  function applyMasked(result, label, feather) {
    const out = clone(ed.img);
    const g = out.getContext('2d');
    if (hasMask()) {
      const layer = makeCanvas(out.width, out.height);
      const l = layer.getContext('2d');
      l.drawImage(result, 0, 0, out.width, out.height);
      l.globalCompositeOperation = 'destination-in';
      l.drawImage(softMask(feather), 0, 0);
      g.drawImage(layer, 0, 0);
    } else {
      g.clearRect(0, 0, out.width, out.height);
      g.drawImage(result, 0, 0, out.width, out.height);
    }
    commit(out, label);
    // правка внесена — выделение больше не нужно (Ctrl+Z вернёт его вместе с картинкой)
    if (hasMask()) {
      ed.mask.getContext('2d').clearRect(0, 0, ed.mask.width, ed.mask.height);
      updateMaskFlag();
      maskChanged();
    }
  }

  // ---------- история ----------
  function snapshot() { return { img: ed.img, mask: clone(ed.mask) }; }
  function commit(newImg, label, keepMask = true) {
    ed.history.push(snapshot());
    if (ed.history.length > 40) ed.history.shift();
    ed.future = [];
    if (newImg.width !== ed.img.width || newImg.height !== ed.img.height || !keepMask) {
      ed.mask = makeCanvas(newImg.width, newImg.height);
      updateMaskFlag();
    }
    ed.img = newImg;
    maskTint = null;
    ed.dirty = true;
    fit();
    syncButtons();
    if (label) toast(label);
  }
  function restore(s) {
    ed.img = s.img;
    ed.mask = s.mask;
    updateMaskFlag();
    maskTint = null;
    fit();
    syncButtons();
  }
  function undo() { if (!ed.history.length) return; ed.future.push(snapshot()); restore(ed.history.pop()); }
  function redo() { if (!ed.future.length) return; ed.history.push(snapshot()); restore(ed.future.pop()); }
  function syncButtons() {
    $('#edUndo').disabled = !ed.history.length;
    $('#edRedo').disabled = !ed.future.length;
  }

  // ---------- указатель ----------
  function toImage(e) {
    const r = ed.view.getBoundingClientRect();
    return { x: (e.clientX - r.left - ed.ox) / ed.scale, y: (e.clientY - r.top - ed.oy) / ed.scale, sx: e.clientX - r.left, sy: e.clientY - r.top };
  }
  function bindPointer() {
    let down = false;
    ed.view.addEventListener('pointerdown', (e) => {
      if (ed.compare != null) {
        down = 'cmp';
        ed.view.setPointerCapture(e.pointerId);
        ed.compare = Math.max(0, Math.min(1, toImage(e).x / ed.img.width));
        redraw();
        return;
      }
      if (!ed.tool?.down) return;
      down = true;
      ed.view.setPointerCapture(e.pointerId);
      ed.tool.down(toImage(e), e, api);
    });
    ed.view.addEventListener('pointermove', (e) => {
      ed.pointer = toImage(e);
      if (down === 'cmp') { ed.compare = Math.max(0, Math.min(1, ed.pointer.x / ed.img.width)); redraw(); return; }
      if (down && ed.tool?.move) ed.tool.move(ed.pointer, e, api);
      else if (ed.tool?.drawCursor) redraw();
    });
    ed.view.addEventListener('pointerup', (e) => {
      if (!down) return;
      if (down === 'cmp') { down = false; return; }
      down = false;
      if (ed.tool?.up) ed.tool.up(toImage(e), e, api);
    });
    ed.view.addEventListener('pointerleave', () => { ed.pointer = null; redraw(); });
  }

  // ---------- интерфейс ----------
  function renderToolbar() {
    const bar = $('#edTools');
    bar.innerHTML = tools.map((t) => `<button class="ed-tool ${ed.tool === t ? 'on' : ''}" data-id="${t.id}" title="${t.name}${t.key ? ' (' + t.key.toUpperCase() + ')' : ''}">${t.icon || ''}<span>${t.name}</span></button>`).join('');
  }

  function selectTool(id) {
    const t = tools.find((x) => x.id === id);
    if (!t) return;
    if (t.action) { t.action(api); return; } // разовое действие (повернуть, отразить…)
    if (ed.tool?.deactivate) ed.tool.deactivate(api);
    ed.overlay = null;
    ed.preview = null;
    ed.tool = t;
    ed.view.style.cursor = t.cursor || 'crosshair';
    const panel = $('#edOptions');
    panel.innerHTML = `<div class="ed-opt-title">${t.name}</div>${t.hint ? `<p class="ed-hint">${t.hint}</p>` : ''}`;
    if (t.options) t.options(panel, api);
    if (t.activate) t.activate(api);
    renderToolbar();
    redraw();
  }

  async function open({ src, source }) {
    const img = await loadImage(src);
    ed.img = makeCanvas(img.naturalWidth, img.naturalHeight);
    ed.img.getContext('2d').drawImage(img, 0, 0);
    ed.mask = makeCanvas(ed.img.width, ed.img.height);
    ed.history = []; ed.future = [];
    ed.original = clone(ed.img);
    ed.compare = null;
    document.querySelector('#edCompare').classList.remove('on');
    ed.source = source || null;
    ed.dirty = false;
    maskEmptyCache = true;
    $('#edMaskInfo').hidden = true;
    $('#editor').hidden = false;
    document.body.classList.add('editing');
    renderToolbar();
    syncButtons();
    fit();
    if (!ed.tool) selectTool(tools.find((t) => !t.action)?.id);
    else selectTool(ed.tool.id);
    $('#edAiBox').hidden = !window.ATELIER?.canEdit;
  }

  function close() {
    if (ed.dirty && !confirm('Закрыть редактор? Несохранённые изменения пропадут.')) return;
    $('#editor').hidden = true;
    document.body.classList.remove('editing');
  }

  function loadImage(src) {
    return new Promise((ok, fail) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = fail;
      i.src = src;
    });
  }

  function toast(msg, err) { window.toast ? window.toast(msg, err) : console.log(msg); }

  // ---------- ИИ-правка выделенного ----------
  async function aiEdit(instruction) {
    if (!instruction.trim()) return toast('Напишите, что сделать', true);
    const btns = document.querySelectorAll('#edAiBox button:not(#edAiCancel)');
    btns.forEach((b) => (b.disabled = true));
    const status = $('#edAiStatus');
    status.hidden = false;
    const cancelBtn = $('#edAiCancel');
    cancelBtn.hidden = false;
    let jobId = null;
    cancelBtn.onclick = async () => {
      if (!jobId) return;
      cancelBtn.disabled = true;
      status.textContent = 'Отменяю…';
      await fetch('/api/jobs/' + jobId + '/cancel', { method: 'POST' });
    };
    status.textContent = 'ИИ работает… (первый раз после рисования — до пары минут)';
    try {
      const r = await fetch('/api/edit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instruction, sources: [ed.img.toDataURL('image/png')], count: 1, temp: true, quality: ed.aiQuality || 'normal' }),
      });
      let job = await r.json();
      if (!r.ok) throw new Error(job.error);
      jobId = job.id;
      while (job.status === 'running') {
        await new Promise((ok) => setTimeout(ok, 1200));
        job = await (await fetch('/api/jobs/' + job.id)).json();
        const p = job.images[0]?.progress;
        if (p) status.textContent = `ИИ: ${({ queued: 'в очереди', loading: 'готовлюсь', model: 'загружаю модель', drawing: 'рисую' })[p.stage] || 'работаю'} — ${p.pct || 0}%${p.slow ? ' · до минуты' : p.eta ? ' · ~' + p.eta + ' с' : ''}`;
      }
      const res = job.images[0];
      if (job.cancelled || res.cancelled) { toast('Отменено — можно поправить текст и попробовать снова'); return; }
      if (!res.file) throw new Error(res.error || 'Не получилось');
      const out = await loadImage('/images/' + res.file);
      applyMasked(out, hasMask() ? 'Готово — изменено выделенное' : 'Готово', 10);
    } catch (e) {
      toast(e.message, true);
    } finally {
      status.hidden = true;
      cancelBtn.hidden = true;
      cancelBtn.disabled = false;
      btns.forEach((b) => (b.disabled = false));
    }
  }

  async function save() {
    const r = await fetch('/api/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: ed.img.toDataURL('image/png'), title: $('#edTitle').value || 'Правка в редакторе', from: ed.source }),
    });
    const job = await r.json();
    if (!r.ok) return toast(job.error, true);
    ed.dirty = false;
    toast('Сохранено в «Мои работы»');
    if (window.onEditorSaved) window.onEditorSaved(job);
  }

  function download() {
    const a = document.createElement('a');
    a.href = ed.img.toDataURL('image/png');
    a.download = 'atelier_edit.png';
    a.click();
  }

  function bindUI() {
    ed.view = $('#edCanvas');
    bindPointer();
    $('#edTools').onclick = (e) => { const b = e.target.closest('[data-id]'); if (b) selectTool(b.dataset.id); };
    $('#edUndo').onclick = undo;
    $('#edRedo').onclick = redo;
    $('#edSave').onclick = save;
    $('#edDownload').onclick = download;
    $('#edCompare').onclick = () => {
      ed.compare = ed.compare == null ? 0.5 : null;
      $('#edCompare').classList.toggle('on', ed.compare != null);
      ed.view.style.cursor = ed.compare != null ? 'ew-resize' : ed.tool?.cursor || 'crosshair';
      redraw();
    };
    $('#edClose').onclick = close;
    $('#edClearMask').onclick = clearMask;
    $('#edInvertMask').onclick = invertMask;
    $('#edAiGo').onclick = () => aiEdit($('#edAiText').value);
    $('#edAiRemove').onclick = () => {
      if (!hasMask()) return toast('Сначала выделите, что убрать — кистью или лассо', true);
      aiEdit('Remove the objects in the marked area completely and seamlessly fill it with the surrounding background, keeping the same drawing style.');
    };
    $('#edAiText').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#edAiGo').click(); } });
    window.addEventListener('resize', () => { if (!$('#editor').hidden) fit(); });
    document.addEventListener('keydown', (e) => {
      if ($('#editor').hidden || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
      if (e.ctrlKey && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (e.ctrlKey && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
      if (e.ctrlKey && e.key.toLowerCase() === 'd') { e.preventDefault(); clearMask(); return; }
      if (e.key === 'Escape') return close();
      const t = tools.find((x) => x.key && x.key === e.key.toLowerCase());
      if (t && !e.ctrlKey) selectTool(t.id);
    });
  }

  // То, что видят инструменты
  const api = {
    get img() { return ed.img; },
    get mask() { return ed.mask; },
    get scale() { return ed.scale; },
    get offset() { return { x: ed.ox, y: ed.oy }; },
    set overlay(fn) { ed.overlay = fn; },
    set preview(filter) { ed.preview = filter; redraw(); },
    makeCanvas, clone, redraw, commit, applyMasked, softMask,
    hasMask, clearMask, invertMask, maskChanged,
    maskDone() { updateMaskFlag(); maskChanged(); },
    toast,
  };

  const reselect = () => ed.tool && selectTool(ed.tool.id);
  return { register, loadTools, open, close, bindUI, reselect, api };
})();
