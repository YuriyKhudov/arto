// Arto — клиент
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const FORMATS = [
  { ar: '1:1', name: 'Квадрат' },
  { ar: '4:5', name: 'Портрет' },
  { ar: '2:3', name: 'Высокий' },
  { ar: '3:2', name: 'Альбом' },
  { ar: '16:9', name: 'Широкий' },
];
const DEFAULT_PARAMS = { quality: 'normal', style: 'graphite', ar: '1:1', count: 4, stylize: 250, chaos: 0, weird: 0, iw: 1, no: '', sw: 1 };
const EXAMPLES = [
  'старый маяк в шторм, одинокая фигура на берегу',
  'портрет пожилой балерины в гримёрке',
  'венецианский канал на рассвете, лодки, туман',
  'лошадь в галопе, движение, пыль',
  'натюрморт с гранатами и медным кувшином',
  'заброшенная оранжерея, заросшая лианами',
];
const KIND = { upscale: 'Увеличено ×2', edit: 'Изменение', studio: 'Из редактора' };

const state = {
  styles: [], edition: {}, engine: {}, jobs: [],
  params: load('atelier.params', DEFAULT_PARAMS),
  mode: 'draw', ref: null, sources: [], editCount: 1, editQuality: 'normal',
  styleRefs: [], myStyles: [], // образцы стиля: { url, data | jobId+index | file, w }
  page: 'create', galFilter: 'all', galQuery: '',
  lb: { list: [], i: 0 },
};

function load(key, def) {
  try { return { ...def, ...JSON.parse(localStorage.getItem(key) || '{}') }; } catch { return { ...def }; }
}
function saveParams() { try { localStorage.setItem('atelier.params', JSON.stringify(state.params)); } catch {} }

async function api(path, body, method) {
  const res = await fetch(path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Ошибка ${res.status}`);
  return json;
}

function toast(msg, err) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), err ? 7000 : 3000);
}

// ---------------- старт ----------------
async function init() {
  const s = await api('/api/state');
  state.styles = s.styles;
  state.edition = s.edition;
  state.version = s.version;
  state.engine = s.engine;
  state.jobs = s.jobs;
  if (!state.edition.canEdit) $('#modes').hidden = true;
  $('#lbEdit').hidden = !state.edition.canEdit;
  window.ATELIER = { canEdit: state.edition.canEdit };
  window.toast = toast;
  window.onEditorSaved = (job) => { state.jobs.unshift(job); renderFeed(); };
  Editor.bindUI();
  Editor.loadTools();
  loadMyStyles();
  buildControls();
  renderExamples();
  renderEngine();
  renderFeed();
  bindEvents();
  initTiles();
  bindCompare();
  setInterval(tick, 1000);
  checkUpdate();
  setInterval(checkUpdate, 3 * 3600 * 1000);
}

async function tick() {
  if (state.engine.status !== 'ready') {
    try { state.engine = await api('/api/engine'); renderEngine(); } catch {}
  }
  const running = state.jobs.filter((j) => j.status === 'running');
  for (const j of running) {
    try {
      const fresh = await api('/api/jobs/' + j.id);
      const i = state.jobs.findIndex((x) => x.id === j.id);
      if (i !== -1) state.jobs[i] = fresh;
      if (fresh.status === 'error') toast('Не получилось: ' + (fresh.images.find((x) => x.error)?.error || ''), true);
      if (fresh.status === 'cancelled') { state.jobs = state.jobs.filter((x) => x.id !== j.id); toast('Отменено'); }
    } catch {}
  }
  if (running.length) {
    renderFeed();
    running.forEach((j) => updateProgress(state.jobs.find((x) => x.id === j.id) || j));
    if (state.page === 'gallery') renderGallery();
  }
}

function renderEngine() {
  const e = state.engine;
  const el = $('#engine');
  el.className = 'engine ' + e.status;
  el.title = e.message;
  $('span', el).innerHTML = `<b>Arto ${esc(state.edition.title)} <em>${esc(state.version || '')}</em></b>${esc(e.status === 'ready' ? 'Готов к работе' : e.message)}`;
}

// ---------------- обновления ----------------
async function checkUpdate() {
  try {
    const u = await api('/api/update');
    $('#updateBox').hidden = !u.available;
    if (!u.available) return;
    $('#updVer').textContent = u.latest;
    $('#updNotes').textContent = (u.notes || '').replace(/^##.*\n?/, '').replace(/^[-*]\s*/gm, '• ').slice(0, 400);
  } catch {}
}

async function doUpdate() {
  const btn = $('#updGo');
  btn.disabled = true;
  btn.textContent = 'Обновляю…';
  try {
    await api('/api/update', {});
    btn.textContent = 'Перезапуск…';
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      try { await api('/api/engine'); location.reload(); return; } catch {}
    }
  } catch (e) {
    toast(e.message, true);
    btn.disabled = false;
    btn.textContent = 'Обновить';
  }
}

// ---------------- управление ----------------
function buildControls() {
  $('#style').innerHTML = state.styles.map((st) => `<option value="${st.id}">${esc(st.name)} — ${esc(st.hint)}</option>`).join('');
  $('#formatSeg').innerHTML = FORMATS.map((f) => {
    const [a, b] = f.ar.split(':').map(Number);
    const k = 16 / Math.max(a, b);
    return `<button data-ar="${f.ar}" title="${f.ar}"><i style="width:${a * k}px;height:${b * k}px"></i>${f.name}</button>`;
  }).join('');
  syncControls();
}

const LEVELS = {
  stylize: (v) => (v < 100 ? 'сдержанно' : v < 300 ? 'умеренно' : v < 600 ? 'выразительно' : 'максимально'),
  chaos: (v) => (v === 0 ? 'нет' : v < 35 ? 'немного' : v < 70 ? 'заметно' : 'сильно'),
  weird: (v) => (v === 0 ? 'нет' : v < 800 ? 'чуть-чуть' : v < 1800 ? 'заметно' : 'очень'),
  iw: (v) => (v < 0.7 ? 'слабо' : v < 1.4 ? 'средне' : 'сильно'),
  sw: (v) => (v < 0.4 ? 'намёк' : v < 0.9 ? 'мягко' : v < 1.4 ? 'заметно' : 'сильно'),
};

function syncControls() {
  const p = state.params;
  $('#style').value = p.style;
  $$('#formatSeg button').forEach((b) => b.classList.toggle('on', b.dataset.ar === p.ar));
  $$('#countSeg button').forEach((b) => b.classList.toggle('on', +b.dataset.v === +p.count));
  $$('#qualitySeg button').forEach((b) => b.classList.toggle('on', b.dataset.v === p.quality));
  if (document.activeElement !== $('#countInput')) $('#countInput').value = p.count;
  $$('#editCountSeg button').forEach((b) => b.classList.toggle('on', +b.dataset.v === +state.editCount));
  for (const k of ['stylize', 'chaos', 'weird', 'iw', 'sw']) {
    $('#' + k).value = p[k];
    $('#v' + k[0].toUpperCase() + k.slice(1)).textContent = LEVELS[k](+p[k]);
  }
  $('#no').value = p.no;
  $('#iwWrap').style.display = state.ref ? '' : 'none';
  renderRef();
  renderStyleRefs();
}

function setMode(mode) {
  state.mode = mode;
  $$('#modes button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  const edit = mode === 'edit';
  $('#drawbar').hidden = edit;
  $('#editbar').hidden = !edit;
  $('#more').hidden = true;
  $('#sources').hidden = !edit;
  $('#refBtn').hidden = edit;
  $('#styleBtn').hidden = edit;
  if (edit) $('#styleTray').hidden = true;
  $('#goBtn').textContent = edit ? 'Изменить' : 'Нарисовать';
  $('#prompt').placeholder = edit ? 'Что изменить? Например: сделай ночь, а в окне — тёплый свет' : 'Опишите, что нарисовать…';
  renderRef();
  renderSources();
}

function renderRef() {
  const note = $('#refNote');
  if (!state.ref || state.mode === 'edit') { note.hidden = true; $('#refThumb').hidden = true; return; }
  $('#refThumb').src = state.ref;
  $('#refThumb').hidden = false;
  note.hidden = false;
  note.innerHTML = 'Картинка-основа подключена — эскизы будут строиться от неё. <button id="refClear">Убрать</button>';
  $('#refClear').onclick = () => { state.ref = null; syncControls(); };
}

function renderSources() {
  const box = $('#sources');
  box.innerHTML = state.sources.map((s, i) => `<div class="src"><img src="${s.url}" alt=""><button data-rm="${i}" title="Убрать">×</button></div>`).join('')
    + (state.sources.length < 3 ? `<label class="src add" title="Добавить картинку"><input type="file" accept="image/*" hidden id="srcInput"><span>+</span><small>${state.sources.length ? 'ещё' : 'картинка'}</small></label>` : '')
    + (state.sources.length ? '' : '<p class="src-hint">Добавьте картинку, которую нужно изменить — кнопкой «+», перетаскиванием или Ctrl+V. Или откройте любую работу и нажмите «Изменить».</p>');
  box.onclick = (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { state.sources.splice(+rm.dataset.rm, 1); renderSources(); }
  };
  const inp = $('#srcInput');
  if (inp) inp.onchange = (e) => { const f = e.target.files[0]; if (f) addImage(f); };
}

// ---------------- стиль с картинок (аналог --sref) ----------------
function renderStyleRefs() {
  const n = state.styleRefs.length;
  $('#styleBadge').hidden = !n;
  $('#styleBadge').textContent = n;
  $('#styleBtn').classList.toggle('on', n > 0 || !$('#styleTray').hidden);
  const box = $('#styleSlots');
  box.innerHTML = state.styleRefs.map((r, i) => `
    <div class="st-slot">
      <div class="src"><img src="${r.url}" alt=""><button data-rm="${i}" title="Убрать">×</button></div>
      <input type="range" min="0" max="2" step="0.1" value="${r.w}" data-w="${i}" title="Влияние этой картинки">
      <small>влияние <b>${Math.round(r.w * 100)}%</b></small>
    </div>`).join('')
    + (n < 3 ? `<label class="st-slot add"><div class="src add"><input type="file" accept="image/*" hidden id="styleInput"><span>+</span><small>${n ? 'ещё' : 'образец'}</small></div></label>` : '')
    + (n ? '' : '<p class="src-hint">Добавьте 1–3 картинки, чей стиль нравится: свои работы, картины мастеров, фото фактур. Можно перетащить сюда или нажать «Взять стиль» у любой работы.</p>');
  box.onclick = (e) => { const rm = e.target.closest('[data-rm]'); if (rm) { state.styleRefs.splice(+rm.dataset.rm, 1); renderStyleRefs(); } };
  box.oninput = (e) => {
    const i = e.target.dataset.w;
    if (i == null) return;
    state.styleRefs[i].w = +e.target.value;
    e.target.nextElementSibling.querySelector('b').textContent = Math.round(state.styleRefs[i].w * 100) + '%';
  };
  const inp = $('#styleInput');
  if (inp) inp.onchange = async (e) => { const f = e.target.files[0]; if (f) addStyleRef({ url: await blobToDataUrl(f, 1024) }); };
}

function addStyleRef(r) {
  if (state.styleRefs.length >= 3) return toast('Можно не больше трёх образцов стиля', true);
  if (!r.file && r.jobId == null) r.data = r.url;
  state.styleRefs.push({ w: 1, ...r });
  if (state.styleRefs.length === 1 && state.params.style !== 'raw') {
    state.params.style = 'raw';
    saveParams();
    toast('Техника переключена на «Raw» — стиль задают картинки. Можно выбрать любую.');
  }
  $('#styleTray').hidden = false;
  syncControls();
}

const styleRefPayload = () => state.styleRefs.map((r) => ({
  w: r.w, ...(r.file ? { file: r.file } : r.jobId != null ? { jobId: r.jobId, index: r.index } : { data: r.data }),
}));

async function loadMyStyles() {
  try { state.myStyles = await api('/api/styles'); } catch { state.myStyles = []; }
  $('#myStyles').innerHTML = '<option value="">Мои стили…</option>'
    + state.myStyles.map((s) => `<option value="${s.id}">${esc(s.name)} (${s.files.length})</option>`).join('')
    + (state.myStyles.length ? '<option value="__del">— удалить стиль…</option>' : '');
}

async function blobToDataUrl(blob, max = 2048) {
  const img = await createImageBitmap(blob);
  const k = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * k);
  c.height = Math.round(img.height * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

// Картинка, пришедшая снаружи (файл, вставка, перетаскивание)
async function addImage(blob) {
  const url = await blobToDataUrl(blob);
  if (state.mode === 'edit') {
    if (state.sources.length >= 3) return toast('Можно не больше трёх картинок', true);
    state.sources.push({ url, data: url });
    renderSources();
  } else if (!$('#styleTray').hidden) {
    addStyleRef({ url: await blobToDataUrl(blob, 1024) });
  } else {
    state.ref = url;
    syncControls();
    toast('Картинка-основа добавлена');
  }
}

// ---------------- действия ----------------
async function go() {
  const text = $('#prompt').value.trim();
  if (!text) { $('#prompt').focus(); return; }
  if (state.engine.status !== 'ready') return toast(state.engine.message, true);
  // просят реализм, а выбрана рисовальная техника — предложить «Реализм»
  if (state.mode === 'draw' && /реалист|фотореал|как фото|realistic|photoreal/i.test(text)
      && !['realism', 'raw', 'oil'].includes(state.params.style)) {
    if (confirm(`В запросе есть «реалистичный», а выбрана техника «${styleName(state.params.style)}» — она превратит всё в рисунок.\n\nПереключить на «Реализм»?`)) {
      state.params.style = 'realism';
      saveParams();
      syncControls();
    }
  }
  const btn = $('#goBtn');
  btn.disabled = true;
  try {
    let job;
    if (state.mode === 'edit') {
      if (!state.sources.length) { toast('Сначала добавьте картинку', true); btn.disabled = false; return; }
      job = await api('/api/edit', { instruction: text, count: state.editCount, quality: state.editQuality, sources: state.sources.map((s) => s.ref || s.data) });
    } else {
      job = await api('/api/imagine', { prompt: text, params: state.params, ref: state.ref, styles: styleRefPayload() });
    }
    addJob(job);
    $('#prompt').value = '';
    autosize();
  } catch (e) { toast(e.message, true); }
  btn.disabled = false;
}

async function action(act, job, index) {
  try {
    switch (act) {
      case 'vary-subtle':
      case 'vary-strong':
        addJob(await api('/api/vary', { jobId: job.id, index, mode: act === 'vary-strong' ? 'strong' : 'subtle' }));
        break;
      case 'cancel':
        await api('/api/jobs/' + job.id + '/cancel', {});
        toast('Отменяю…');
        return;
      case 'reroll':
        addJob(await api('/api/reroll', { jobId: job.id }));
        break;
      case 'upscale':
      case 'upscale-art':
      case 'upscale-fix':
        addJob(await api('/api/upscale', { jobId: job.id, index, mode: { upscale: 'simple', 'upscale-art': 'art', 'upscale-fix': 'fix' }[act] }));
        break;
      case 'edit':
        closeLightbox();
        setMode('edit');
        state.sources = [{ url: '/images/' + job.images[index].file, ref: { jobId: job.id, index } }];
        renderSources();
        $('main').scrollTo({ top: 0, behavior: 'smooth' });
        $('#prompt').focus();
        return;
      case 'studio':
        closeLightbox();
        document.querySelector('#edTitle').value = job.prompt || '';
        await Editor.open({ src: '/images/' + job.images[index].file, source: { jobId: job.id, index } });
        return;
      case 'reuse':
        closeLightbox();
        setMode(job.type === 'edit' ? 'edit' : 'draw');
        $('#prompt').value = job.rawPrompt || job.prompt;
        if (job.styleFiles?.length) {
          state.styleRefs = job.styleFiles.map((f, i) => ({ url: '/images/' + f, file: f, w: job.styleWeights?.[i] ?? 1 }));
          $('#styleTray').hidden = false;
          syncControls();
        }
        autosize();
        $('#prompt').focus();
        return;
      case 'as-style':
        closeLightbox();
        setMode('draw');
        addStyleRef({ url: '/images/' + job.images[index].file, jobId: job.id, index });
        $('main').scrollTo({ top: 0, behavior: 'smooth' });
        return;
      case 'as-ref':
        closeLightbox();
        setMode('draw');
        state.ref = await blobToDataUrl(await (await fetch('/images/' + job.images[index].file)).blob());
        syncControls();
        $('#prompt').focus();
        return;
      case 'like':
        await api(`/api/jobs/${job.id}/${index}/like`, {});
        job.images[index].liked = !job.images[index].liked;
        refreshAll();
        return;
      case 'delete':
        if (!confirm('Удалить эту картинку?')) return;
        await api(`/api/jobs/${job.id}/${index}/delete`, {});
        job.images[index].file = null;
        job.images[index].deleted = true;
        if (job.images.every((i) => !i.file)) state.jobs = state.jobs.filter((j) => j !== job);
        if (!$('#lightbox').hidden) {
          state.lb.list = state.lb.list.filter((x) => x.job.images[x.index].file);
          if (!state.lb.list.length) closeLightbox();
          else state.lb.i = Math.min(state.lb.i, state.lb.list.length - 1);
        }
        refreshAll();
        return;
      case 'delete-job':
        if (!confirm('Удалить все картинки этого запроса?')) return;
        await api('/api/jobs/' + job.id, null, 'DELETE');
        state.jobs = state.jobs.filter((j) => j !== job);
        refreshAll();
        return;
    }
    closeLightbox();
    showPage('create');
    $('main').scrollTo({ top: 0, behavior: 'smooth' });
  } catch (e) { toast(e.message, true); }
}

function refreshAll() {
  renderFeed();
  if (state.page === 'gallery') renderGallery();
  if (!$('#lightbox').hidden) renderLightbox();
}

function addJob(job) {
  state.jobs.unshift(job);
  showPage('create');
  renderFeed();
  $('main').scrollTo({ top: 0, behavior: 'smooth' });
}

// ---------------- лента ----------------
const rendered = new Map();
const jobSig = (j) => j.status + '|' + j.images.map((i) => (i.file || '') + (i.error ? 'E' : '') + (i.liked ? 'L' : '')).join(',');

function renderFeed() {
  const feed = $('#feed');
  $('#feedEmpty').hidden = state.jobs.length > 0;
  const keep = new Set();
  let prev = null;
  for (const job of state.jobs) {
    keep.add(job.id);
    const sig = jobSig(job);
    let r = rendered.get(job.id);
    if (!r || r.sig !== sig) {
      const holder = document.createElement('div');
      holder.innerHTML = jobHTML(job);
      const node = holder.firstElementChild;
      bindJob(node, job.id);
      if (r) r.el.replaceWith(node);
      r = { sig, el: node };
      rendered.set(job.id, r);
    }
    if (prev ? prev.nextElementSibling !== r.el : feed.firstElementChild !== r.el) {
      if (prev) prev.after(r.el); else feed.prepend(r.el);
    }
    prev = r.el;
  }
  for (const [id, r] of rendered) if (!keep.has(id)) { r.el.remove(); rendered.delete(id); }
}

const styleName = (id) => state.styles.find((s) => s.id === id)?.name || id;
const formatName = (ar) => FORMATS.find((f) => f.ar === ar)?.name || ar;

function chipsHTML(job) {
  if (job.type === 'studio') return '';
  if (job.type === 'edit') return `<span class="chip">${job.sources?.length > 1 ? 'из ' + job.sources.length + ' картинок' : 'по картинке'}</span>${job.params?.quality === 'draft' ? '<span class="chip">черновик</span>' : ''}`;
  const p = job.params;
  const chips = [styleName(p.style), formatName(p.ar || '1:1')];
  if (p.quality === 'draft') chips.push('черновик');
  if (p.quality === 'high') chips.push('высокое качество');
  if (+p.chaos) chips.push('разнообразие: ' + LEVELS.chaos(+p.chaos));
  if (+p.weird) chips.push('странность: ' + LEVELS.weird(+p.weird));
  if (p.no) chips.push('без: ' + p.no);
  if (job.usedReference) chips.push('от картинки');
  return chips.map((c) => `<span class="chip">${esc(c)}</span>`).join('');
}

function cellHTML(job, img, i) {
  const fixed = job.type === 'imagine' || job.type === 'variation';
  const ratio = fixed ? `style="aspect-ratio:${job.params.width}/${job.params.height}"` : '';
  if (img.file) {
    return `<div class="cell" data-i="${i}" ${ratio}>
      <img src="/images/${esc(img.file)}" loading="lazy" onload="this.classList.add('loaded')" alt="">
      ${img.liked ? '<span class="liked">♥</span>' : ''}
      <div class="quick">
        ${state.edition.canEdit ? '<button data-q="edit">Изменить</button>' : ''}
        <button data-q="studio">Редактор</button>
        ${job.type !== 'upscale' ? '<button data-q="vary-subtle">Похожие</button><button data-q="upscale">×2</button>' : ''}
        <button data-q="like" title="Любимое">${img.liked ? '♥' : '♡'}</button>
      </div>
    </div>`;
  }
  if (img.cancelled) return `<div class="cell gone" ${ratio}>отменено</div>`;
  if (img.error) return `<div class="cell failed" ${ratio} title="${esc(img.error)}"><b>Не получилось</b><small>${esc(img.error.slice(0, 140))}</small></div>`;
  if (img.deleted) return `<div class="cell gone" ${ratio}>удалено</div>`;
  return `<div class="cell pending" data-p="${i}" ${ratio || 'style="aspect-ratio:1"'}>${progressHTML(img.progress)}</div>`;
}

// Шкала прогресса: этап, проценты, сколько осталось
const STAGES = { queued: 'в очереди', loading: 'готовлюсь', model: 'загружаю модель', drawing: 'рисую' };
function progressHTML(p) {
  p = p || { stage: 'queued', pct: 0 };
  const eta = p.slow ? 'до минуты' : p.eta ? (p.eta >= 60 ? `~${Math.floor(p.eta / 60)} мин ${p.eta % 60} с` : `~${p.eta} с`) : '';
  return `<div class="prog">
      <span class="prog-stage">${STAGES[p.stage] || 'рисую'}</span>
      <div class="prog-bar"><i style="width:${p.pct || 0}%"></i></div>
      <span class="prog-num"><b>${p.pct || 0}%</b>${eta ? ' · ' + eta : ''}</span>
    </div>`;
}

// Обновить шкалы без перерисовки готовых картинок
function updateProgress(job) {
  const node = rendered.get(job.id)?.el;
  if (!node) return;
  job.images.forEach((img, i) => {
    const cell = node.querySelector(`.cell.pending[data-p="${i}"]`);
    if (cell) cell.innerHTML = progressHTML(img.progress);
  });
  const done = job.images.filter((i) => i.file || i.error).length;
  const t = node.querySelector('.time');
  if (t && job.status === 'running') t.textContent = `Рисую… ${done} из ${job.images.length}`;
}

function jobHTML(job) {
  let kind = KIND[job.type] || '';
  if (job.type === 'upscale') kind = { art: 'Художественное ×2', fix: 'Исправлено и увеличено ×2' }[job.params?.upMode] || kind;
  if (job.type === 'variation') kind = job.variation?.mode === 'strong' ? 'Смелые вариации' : 'Похожие варианты';
  const n = job.images.length;
  const done = job.images.filter((i) => i.file || i.error).length;
  const time = new Date(job.createdAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const styleThumbs = job.styleFiles?.length
    ? `<div class="job-sources"><span>стиль:</span>${job.styleFiles.map((s) => `<img src="/images/${esc(s)}" alt="">`).join('')}</div>` : '';
  const sources = job.type === 'edit' && job.sources?.length
    ? `<div class="job-sources"><span>было:</span>${job.sources.map((s) => `<img src="/images/${esc(s)}" alt="">`).join('')}</div>` : '';
  return `<article class="job" data-id="${job.id}" title="${esc(job.prompt)}">
    <div class="grid" style="--cols:${n === 1 ? 1 : n <= 4 ? 2 : 4}">${job.images.map((img, i) => cellHTML(job, img, i)).join('')}</div>
    <div class="job-info">
      ${kind ? `<div class="job-kind">${kind}</div>` : ''}
      <p class="job-prompt">${esc(job.prompt)}</p>
      ${sources}${styleThumbs}
      <div class="chips">${chipsHTML(job)}</div>
      <div class="job-actions">
        ${job.status === 'running'
          ? '<button class="btn cancel" data-a="cancel">■ Отменить</button>'
          : '<button class="btn" data-a="reroll">↻ Ещё раз</button>'}
        <button class="btn" data-a="reuse">Повторить текст</button>
        ${job.status === 'running' ? '' : '<button class="btn danger" data-a="delete-job" title="Удалить">✕</button>'}
      </div>
      <div class="time">${job.status === 'running' ? `Рисую… ${done} из ${n}` : time}</div>
    </div>
  </article>`;
}

function bindJob(node, id) {
  node.addEventListener('click', (e) => {
    const job = state.jobs.find((j) => j.id === id);
    if (!job) return;
    const q = e.target.closest('[data-q]');
    const a = e.target.closest('[data-a]');
    const cell = e.target.closest('.cell[data-i]');
    if (q && cell) { e.stopPropagation(); return action(q.dataset.q, job, +cell.dataset.i); }
    if (a) return action(a.dataset.a, job);
    if (cell) openLightbox(allImages(), job, +cell.dataset.i);
  });
}

const allImages = () => state.jobs.flatMap((job) => job.images.map((_, index) => ({ job, index }))).filter((x) => x.job.images[x.index].file);

// ---------------- мои работы ----------------
function galleryList() {
  const q = state.galQuery.toLowerCase();
  return allImages().filter(({ job, index }) => {
    if (state.galFilter === 'liked' && !job.images[index].liked) return false;
    if (state.galFilter === 'upscale' && job.type !== 'upscale') return false;
    return !q || job.prompt.toLowerCase().includes(q);
  });
}

function renderGallery() {
  const list = galleryList();
  $('#galEmpty').hidden = list.length > 0;
  $('#masonry').innerHTML = list.map(({ job, index }, k) => {
    const img = job.images[index];
    return `<div class="cell" data-k="${k}"><img src="/images/${esc(img.file)}" loading="lazy" onload="this.classList.add('loaded')" alt="">${img.liked ? '<span class="liked">♥</span>' : ''}</div>`;
  }).join('');
  $('#masonry').onclick = (e) => {
    const cell = e.target.closest('.cell');
    if (!cell) return;
    const item = list[+cell.dataset.k];
    openLightbox(list, item.job, item.index);
  };
}

// ---------------- просмотр ----------------
function openLightbox(list, job, index) {
  state.lb.list = list;
  state.lb.i = Math.max(0, list.findIndex((x) => x.job.id === job.id && x.index === index));
  $('#lightbox').hidden = false;
  renderLightbox();
}
function closeLightbox() { $('#lightbox').hidden = true; }

function renderLightbox() {
  const cur = state.lb.list[state.lb.i];
  if (!cur) return closeLightbox();
  const { job, index } = cur;
  const img = job.images[index];
  $('#lbImg').src = '/images/' + img.file;
  // до / после: исходная картинка правки, увеличения или работы из редактора
  const before = job.before
    || (job.type === 'edit' && job.sources?.length === 1 ? job.sources[0] : null)
    || ((job.type === 'studio' || job.type === 'upscale') && job.variation ? findFile(job.variation) : null);
  setCompare(before ? '/images/' + before : null);
  $('#lbPrompt').textContent = job.prompt;
  $('#lbChips').innerHTML = chipsHTML(job);
  $('#lbFinal').textContent = img.finalPrompt;
  $('#lbNeg').textContent = job.negative ? 'Избегать: ' + job.negative : '';
  $('#lbDownload').href = '/images/' + img.file;
  $('#lbDownload').download = `atelier_${job.prompt.slice(0, 40).replace(/[^\p{L}\p{N}]+/gu, '_')}_${img.seed}.${img.file.split('.').pop()}`;
  $('#lbLike').textContent = img.liked ? '♥' : '♡';
  $('#lbLike').title = img.liked ? 'Убрать из любимых' : 'В любимые';
  $('#lbUpscale').hidden = job.type === 'upscale';
  $('#lbUpFix').hidden = !state.edition.canEdit;
  $('#lbPrev').style.visibility = state.lb.i > 0 ? '' : 'hidden';
  $('#lbNext').style.visibility = state.lb.i < state.lb.list.length - 1 ? '' : 'hidden';
}

function findFile(ref) {
  return state.jobs.find((j) => j.id === ref.jobId)?.images[ref.index]?.file || null;
}

// Вертикальная линия сравнения: слева «до», справа «после»
function setCompare(src) {
  const on = !!src;
  ['#lbBefore', '#lbLine', '#lbTagB', '#lbTagA'].forEach((s) => ($(s).hidden = !on));
  $('#lbCmp').classList.toggle('on', on);
  if (on) { $('#lbBefore').src = src; setSplit(0.5); }
}
function setSplit(x) {
  $('#lbCmp').style.setProperty('--x', (Math.max(0, Math.min(1, x)) * 100).toFixed(2) + '%');
}
function bindCompare() {
  const box = $('#lbCmp');
  let drag = false;
  const move = (e) => { const r = box.getBoundingClientRect(); setSplit((e.clientX - r.left) / r.width); };
  box.addEventListener('pointerdown', (e) => {
    if (!box.classList.contains('on')) return;
    drag = true; box.setPointerCapture(e.pointerId); move(e); e.stopPropagation();
  });
  box.addEventListener('pointermove', (e) => { if (drag) move(e); });
  box.addEventListener('pointerup', () => { drag = false; });
  box.addEventListener('click', (e) => e.stopPropagation());
}

function lbStep(d) {
  const n = state.lb.i + d;
  if (n < 0 || n >= state.lb.list.length) return;
  state.lb.i = n;
  renderLightbox();
}

// ---------------- навигация и события ----------------
function showPage(page) {
  state.page = page;
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  $$('.page').forEach((p) => (p.hidden = p.id !== 'page-' + page));
  if (page === 'gallery') renderGallery();
}

function renderExamples() {
  $('#examples').innerHTML = EXAMPLES.map((e) => `<button>${esc(e)}</button>`).join('');
  $('#examples').onclick = (e) => {
    if (e.target.tagName !== 'BUTTON') return;
    $('#prompt').value = e.target.textContent;
    autosize();
    $('#prompt').focus();
  };
}

function autosize() {
  const t = $('#prompt');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 180) + 'px';
}

function segHandler(sel, fn) {
  $(sel).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) { fn(b); syncControls(); }
  });
}

// ---------------- размер плиток ----------------
function setTile(px) {
  px = Math.max(60, Math.min(420, Math.round(px / 10) * 10));
  document.documentElement.style.setProperty('--tile', px + 'px');
  document.body.classList.toggle('compact', px < 180);
  $('#tileSize').value = px;
  try { localStorage.setItem('arto.tile', px); } catch {}
}

function initTiles() {
  let px = 300;
  try { px = +localStorage.getItem('arto.tile') || 300; } catch {}
  setTile(px);
  $('#tileSize').addEventListener('input', (e) => setTile(+e.target.value));
  // Ctrl + колесо — быстро менять размер, как масштаб
  $('main').addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setTile(+$('#tileSize').value * (e.deltaY > 0 ? 0.9 : 1.1));
  }, { passive: false });
}

function bindEvents() {
  $('#updGo').onclick = doUpdate;
  $$('.nav-btn[data-page]').forEach((b) => (b.onclick = () => showPage(b.dataset.page)));
  $('#openInEditor').onchange = (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) { $('#edTitle').value = f.name.replace(/.[^.]+$/, ''); Editor.open({ src: URL.createObjectURL(f) }); }
  };
  $('#modes').onclick = (e) => { const b = e.target.closest('[data-mode]'); if (b) setMode(b.dataset.mode); };
  $('#goBtn').onclick = go;
  $('#prompt').addEventListener('input', autosize);
  $('#prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); }
  });
  $('#moreBtn').onclick = () => {
    $('#more').hidden = !$('#more').hidden;
    $('#moreBtn').classList.toggle('on', !$('#more').hidden);
  };
  $('#style').onchange = (e) => { state.params.style = e.target.value; saveParams(); };
  segHandler('#formatSeg', (b) => { state.params.ar = b.dataset.ar; saveParams(); });
  segHandler('#countSeg', (b) => { state.params.count = +b.dataset.v; saveParams(); });
  segHandler('#qualitySeg', (b) => { state.params.quality = b.dataset.v; saveParams(); });
  $('#countInput').addEventListener('input', (e) => {
    const v = Math.round(+e.target.value);
    if (v >= 1 && v <= 32) { state.params.count = v; saveParams(); $$('#countSeg button').forEach((b) => b.classList.toggle('on', +b.dataset.v === v)); }
  });
  $('#countInput').addEventListener('change', (e) => { e.target.value = state.params.count; });
  segHandler('#editCountSeg', (b) => { state.editCount = +b.dataset.v; });
  for (const k of ['stylize', 'chaos', 'weird', 'iw']) {
    $('#' + k).addEventListener('input', (e) => { state.params[k] = +e.target.value; saveParams(); syncControls(); });
  }
  $('#no').addEventListener('input', (e) => { state.params.no = e.target.value; saveParams(); });
  $('#styleBtn').onclick = () => { $('#styleTray').hidden = !$('#styleTray').hidden; $('#more').hidden = true; renderStyleRefs(); };
  $('#sw').addEventListener('input', (e) => { state.params.sw = +e.target.value; saveParams(); syncControls(); });
  $('#saveStyle').onclick = async () => {
    if (!state.styleRefs.length) return toast('Сначала добавьте картинки стиля', true);
    const name = prompt('Как назвать этот стиль?', 'Мой стиль');
    if (!name) return;
    try {
      const st = await api('/api/styles', { name, items: styleRefPayload() });
      await loadMyStyles();
      $('#myStyles').value = st.id;
      toast('Стиль «' + st.name + '» сохранён');
    } catch (e) { toast(e.message, true); }
  };
  $('#myStyles').onchange = async (e) => {
    const v = e.target.value;
    if (v === '__del') {
      e.target.value = '';
      const names = state.myStyles.map((s, i) => (i + 1) + '. ' + s.name).join('\n');
      const st = state.myStyles[+prompt('Какой стиль удалить? Введите номер:\n' + names) - 1];
      if (st && confirm('Удалить стиль «' + st.name + '»?')) { await api('/api/styles/' + st.id, null, 'DELETE'); await loadMyStyles(); }
      return;
    }
    const st = state.myStyles.find((x) => x.id === v);
    if (!st) return;
    state.styleRefs = st.files.map((f, i) => ({ url: '/images/' + f, file: f, w: st.weights?.[i] ?? 1 }));
    syncControls();
  };
  $('#resetParams').onclick = () => { state.params = { ...DEFAULT_PARAMS }; saveParams(); syncControls(); };

  $('#refInput').onchange = (e) => { const f = e.target.files[0]; if (f) addImage(f); e.target.value = ''; };
  document.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (item && $('#editor').hidden) { e.preventDefault(); addImage(item.getAsFile()); }
  });
  let depth = 0;
  window.addEventListener('dragenter', (e) => { if (e.dataTransfer.types.includes('Files')) { depth++; $('#dropOverlay').hidden = false; } });
  window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; $('#dropOverlay').hidden = true; } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    $('#dropOverlay').hidden = true;
    const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/'));
    if (!f) return;
    if (!$('#editor').hidden) Editor.open({ src: URL.createObjectURL(f) });
    else addImage(f);
  });

  $('#galFilter').onclick = (e) => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    state.galFilter = b.dataset.v;
    $$('#galFilter button').forEach((x) => x.classList.toggle('on', x === b));
    renderGallery();
  };
  $('#galSearch').addEventListener('input', (e) => { state.galQuery = e.target.value; renderGallery(); });

  $('#lbClose').onclick = closeLightbox;
  $('#lbPrev').onclick = () => lbStep(-1);
  $('#lbNext').onclick = () => lbStep(1);
  $('#lightbox').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (b) { const { job, index } = state.lb.list[state.lb.i]; action(b.dataset.act, job, index); }
    else if (e.target.classList.contains('lb-stage')) closeLightbox();
  });
  document.addEventListener('keydown', (e) => {
    if ($('#lightbox').hidden) return;
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowLeft') lbStep(-1);
    if (e.key === 'ArrowRight') lbStep(1);
  });
}

init().catch((e) => toast('Не удалось загрузить: ' + e.message, true));
