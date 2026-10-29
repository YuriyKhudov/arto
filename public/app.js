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
const DEFAULT_PARAMS = { quality: 'normal', style: 'graphite', ar: '1:1', count: 4, stylize: 250, chaos: 0, weird: 0, iw: 1, no: '', sw: 1, guards: [], taste: false };
const EXAMPLES = [
  'старый маяк в шторм, одинокая фигура на берегу',
  'портрет пожилой балерины в гримёрке',
  'венецианский канал на рассвете, лодки, туман',
  'лошадь в галопе, движение, пыль',
  'натюрморт с гранатами и медным кувшином',
  'заброшенная оранжерея, заросшая лианами',
];
const KIND = { upscale: 'Увеличено ×2', edit: 'Изменение', studio: 'Из редактора', outpaint: 'Раскрытый кадр', train: 'Обучение стиля' };

const state = {
  styles: [], edition: {}, engine: {}, jobs: [],
  params: load('atelier.params', DEFAULT_PARAMS),
  mode: 'draw', ref: null, sources: [], editCount: 1, editQuality: 'normal',
  control: null, // набросок: { url, data | jobId+index | file, mode, strength }
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
  state.guards = s.guards || [];
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
  loadMyLoras();
  Paints.bind();
  bindBoards();
  bindTrain();
  bindKnobs();
  bindPrompts();
  buildControls();
  renderExamples();
  renderEngine();
  renderFeed();
  bindEvents();
  initTiles();
  bindCompare();
  setInterval(tick, 1000);
  // «я здесь»: когда все окна Arto закрыты, программа сама выключается вместе с двигателем
  const winId = Math.random().toString(36).slice(2);
  const alive = () => fetch('/api/alive', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: winId }) }).catch(() => {});
  alive();
  setInterval(alive, 20000);
  addEventListener('pagehide', () => navigator.sendBeacon('/api/bye', winId));
  addEventListener('pageshow', (e) => { if (e.persisted) alive(); });
  // идёт рисование или обучение — спросить перед закрытием
  addEventListener('beforeunload', (e) => { if (state.jobs.some((j) => j.status === 'running')) { e.preventDefault(); e.returnValue = ''; } });
  checkUpdate();
  setInterval(checkUpdate, 3 * 3600 * 1000);
}

async function tick() {
  if (state.engine.status !== 'ready' || state.engine.download) {
    try { state.engine = await api('/api/engine'); renderEngine(); } catch {}
  }
  const running = state.jobs.filter((j) => j.status === 'running');
  for (const j of running) {
    try {
      const fresh = await api('/api/jobs/' + j.id);
      const i = state.jobs.findIndex((x) => x.id === j.id);
      if (i !== -1) state.jobs[i] = fresh;
      if (fresh.type === 'train' && fresh.status === 'done') { loadMyLoras(); toast('Манера «' + (fresh.trainName || '') + '» готова — выберите её в окне «Стиль»'); }
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
  const dl = e.download ? `Докачиваю ${e.download.what}: ${e.download.pct}%` : '';
  $('span', el).innerHTML = `<b>Arto ${esc(state.edition.title)} <em>${esc(state.version || '')}</em></b>${esc(dl || (e.status === 'ready' ? 'Готов к работе' : e.message))}`;
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
  $('#guardSeg').innerHTML = (state.guards || []).map((g) => `<button data-g="${g.id}" title="${esc(g.hint)}">${esc(g.name)}</button>`).join('');
  syncControls();
}

const LEVELS = {
  stylize: (v) => (v < 100 ? 'сдержанно' : v < 300 ? 'умеренно' : v < 600 ? 'выразительно' : 'максимально'),
  chaos: (v) => (v === 0 ? 'нет' : v < 35 ? 'немного' : v < 70 ? 'заметно' : 'сильно'),
  weird: (v) => (v === 0 ? 'нет' : v < 800 ? 'чуть-чуть' : v < 1800 ? 'заметно' : 'очень'),
  iw: (v) => (v < 0.7 ? 'слабо' : v < 1.4 ? 'средне' : 'сильно'),
  sk: (v) => (v < 0.55 ? 'свободно' : v < 0.85 ? 'средне' : v < 1.1 ? 'точно' : 'очень точно'),
  sw: (v) => (v < 0.4 ? 'намёк' : v < 0.9 ? 'мягко' : v < 1.4 ? 'заметно' : 'сильно'),
};

function syncControls() {
  const p = state.params;
  if (state.styles.length && !state.styles.some((st) => st.id === p.style)) p.style = { gouache: 'oil' }[p.style] || 'graphite'; // техника убрана
  $('#style').value = p.style;
  $$('#formatSeg button').forEach((b) => b.classList.toggle('on', b.dataset.ar === p.ar));
  $$('#countSeg button').forEach((b) => b.classList.toggle('on', +b.dataset.v === +p.count));
  $$('#qualitySeg button').forEach((b) => b.classList.toggle('on', b.dataset.v === p.quality));
  $$('#guardSeg button').forEach((b) => b.classList.toggle('on', (p.guards || []).includes(b.dataset.g)));
  renderTaste();
  if (document.activeElement !== $('#countInput')) $('#countInput').value = p.count;
  $$('#editCountSeg button').forEach((b) => b.classList.toggle('on', +b.dataset.v === +state.editCount));
  for (const k of ['stylize', 'chaos', 'weird', 'iw', 'sw']) {
    $('#' + k).value = p[k];
    $('#v' + k[0].toUpperCase() + k.slice(1)).textContent = LEVELS[k](+p[k]);
  }
  $('#no').value = p.no;
  const raw = p.style === 'raw';
  for (const k of ['stylize', 'chaos', 'weird']) $('#' + k).closest('.slider').hidden = raw;
  $('#rawNote').hidden = !raw;
  $('#iwWrap').style.display = state.ref ? '' : 'none';
  renderRef();
  renderStyleRefs();
  renderSketch();
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
  $('#sketchBtn').hidden = edit;
  if (edit) $('#sketchTray').hidden = true;
  if (edit) $('#styleTray').hidden = true;
  $('#goBtn').textContent = edit ? 'Изменить' : 'Нарисовать';
  $('#prompt').placeholder = edit ? 'Что изменить? Например: сделай ночь, а в окне — тёплый свет' : 'Опишите, что нарисовать…   (Shift+Enter — новая строка: несколько строк = серия)';
  renderRef();
  renderSources();
}

function renderRef() {
  const note = $('#refNote');
  if (!state.ref || state.mode === 'edit') { note.hidden = true; $('#refThumb').hidden = true; $('#refX').hidden = true; return; }
  $('#refThumb').src = state.ref;
  $('#refThumb').hidden = false;
  $('#refX').hidden = false;
  note.hidden = false;
  note.innerHTML = `<b>Картинка-основа:</b> новые эскизы повторяют её композицию и персонажа.
    <label class="ref-power">сила <input type="range" id="iwInline" min="0" max="2" step="0.1" value="${state.params.iw}"> <em>${LEVELS.iw(+state.params.iw)}</em></label>
    <button id="refClear">× Убрать</button>`;
  $('#refClear').onclick = () => { state.ref = null; syncControls(); };
  $('#iwInline').oninput = (e) => { state.params.iw = +e.target.value; saveParams(); e.target.nextElementSibling.textContent = LEVELS.iw(state.params.iw); $('#iw').value = state.params.iw; };
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

// ---------------- «Сила просьбы» и «Проработка» для ИИ-редактора (общие для правки и редактора) ----------------
const KNOB_DEF = { cfg: 1, steps: 8 };
function editKnobs() {
  let k = {};
  try { k = JSON.parse(localStorage.getItem('arto.editKnobs') || '{}'); } catch {}
  return { cfg: +k.cfg || KNOB_DEF.cfg, steps: +k.steps || KNOB_DEF.steps };
}
window.editKnobs = editKnobs;
function bindKnobs() {
  const label = { cfg: (v) => (v <= 1 ? 'обычно' : v < 2 ? 'заметно' : v < 2.75 ? 'сильно' : 'очень сильно'), steps: (v) => (v <= 6 ? 'быстро' : v <= 10 ? 'обычно' : v <= 14 ? 'тщательно' : 'очень тщательно') };
  const sync = () => {
    const k = editKnobs();
    for (const p of ['edit', 'edAi']) {
      const c = document.getElementById(p + 'Cfg'), s = document.getElementById(p + 'Steps');
      if (!c) continue;
      c.value = k.cfg; s.value = k.steps;
      document.getElementById(p + 'CfgV').textContent = label.cfg(k.cfg);
      document.getElementById(p + 'StepsV').textContent = label.steps(k.steps);
    }
  };
  for (const p of ['edit', 'edAi']) for (const key of ['Cfg', 'Steps']) {
    const el = document.getElementById(p + key);
    if (el) el.oninput = () => { const k = editKnobs(); k[key.toLowerCase()] = +el.value; try { localStorage.setItem('arto.editKnobs', JSON.stringify(k)); } catch {} sync(); };
  }
  sync();
}

// ---------------- «Мой вкус»: ♡ и 👎 → Arto тянет к понравившемуся ----------------
function renderTaste() {
  const p = state.params;
  let liked = 0;
  for (const j of state.jobs) if ((j.params?.style || 'raw') === p.style && !j.params?.myLora) for (const im of j.images) if (im.file && im.liked) liked++;
  $('#tasteBtn').classList.toggle('on', !!p.taste);
  $('#tasteN').textContent = liked ? `(${liked})` : '';
  $('#tasteBtn').hidden = !!$('#myLora')?.value;
}

// ---------------- «моя манера» (обученная LoRA) ----------------
async function loadMyLoras() {
  try { state.myLoras = await api('/api/loras'); } catch { state.myLoras = []; }
  const cur = $('#myLora').value;
  $('#myLora').innerHTML = '<option value="">— нет —</option>' + state.myLoras.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('')
    + (state.myLoras.length ? '<option value="__del">— удалить стиль…</option>' : '');
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('arto.manner') || '{}'); } catch {}
  const want = cur || saved.id;
  if (state.myLoras.some((l) => l.id === want)) $('#myLora').value = want;
  if (!cur && saved.w) $('#myLoraPower').value = saved.w;
  renderManner();
}
const myLoraParam = () => ($('#myLora').value ? { id: $('#myLora').value, w: +$('#myLoraPower').value } : null);
// С манерой всё лишнее прячем: она сама задаёт технику и фактуру, образцы стиля только мешают
function renderManner() {
  const on = !!$('#myLora').value;
  const w = +$('#myLoraPower').value;
  $('#myLoraPowerWrap').hidden = !on;
  $('#mlShare').hidden = !on;
  $('#vMl').textContent = w < 0.65 ? 'слегка' : w <= 0.9 ? 'как в образцах' : 'сильнее';
  $('#mlNote').hidden = !on;
  $('#stRefs').hidden = on;
  $('.st-mine').hidden = on;
  $('#style').disabled = on;
  if ($('#tasteBtn')) $('#tasteBtn').hidden = on;
  $('#style').closest('.pick').classList.toggle('ml-on', on);
  try { localStorage.setItem('arto.manner', JSON.stringify({ id: $('#myLora').value, w })); } catch {}
}

function bindTrain() {
  let files = [];
  let source = 'files';
  let quality = 'normal';
  $('#myLora').onchange = async (e) => {
    if (e.target.value === '__del') {
      e.target.value = '';
      const list = state.myLoras.map((l, i) => (i + 1) + '. ' + l.name).join('\n');
      const l = state.myLoras[+prompt('Какой стиль удалить? Введите номер:\n' + list) - 1];
      if (l && confirm('Удалить стиль «' + l.name + '»?')) { await api('/api/loras/' + l.id, null, 'DELETE'); await loadMyLoras(); }
    }
    if (e.target.value) $('#styleBtn').classList.add('on');
    renderManner();
  };
  $('#myLoraPower').oninput = renderManner;
  // обмен стилями: один файл .artostyle
  $('#mlShare').onclick = () => {
    const id = $('#myLora').value;
    if (!id) return;
    const a = document.createElement('a');
    a.href = '/api/loras/' + id + '/export';
    a.click();
    toast('Сохраняю стиль в файл — его можно отправить другу. Он добавит его кнопкой «Добавить стиль из файла»');
  };
  $('#mlImport').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    toast('Добавляю стиль «' + f.name.replace(/\.artostyle$/i, '') + '»…');
    try {
      const r = await fetch('/api/loras/import', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Не получилось');
      await loadMyLoras();
      $('#myLora').value = j.id;
      $('#myLora').dispatchEvent(new Event('change'));
      toast('Стиль «' + j.name + '» добавлен — он уже выбран, можно рисовать');
    } catch (err) { toast(err.message, true); }
  };
  $('#trainOpen').onclick = async () => {
    files = [];
    $('#trCount').textContent = '';
    $('#trName').value = '';
    try { const b = await api('/api/boards'); $('#trBoard').innerHTML = b.map((x) => `<option value="${x.id}">${esc(x.name)} (${x.items.length})</option>`).join('') || '<option value="">досок нет</option>'; } catch {}
    $('#trainBox').hidden = false;
  };
  $('#trSource').onclick = (e) => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    source = b.dataset.v;
    $$('#trSource button').forEach((x) => x.classList.toggle('on', x === b));
    $('#trFilesWrap').hidden = source !== 'files';
    $('#trBoardWrap').hidden = source !== 'board';
  };
  $('#trQuality').onclick = (e) => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    quality = b.dataset.v;
    $$('#trQuality button').forEach((x) => x.classList.toggle('on', x === b));
  };
  $('#trFiles').onchange = async (e) => {
    files = [];
    for (const f of [...e.target.files].slice(0, 60)) files.push(await blobToDataUrl(f, 1280));
    $('#trCount').textContent = `выбрано: ${files.length}` + (files.length < 15 ? ' (лучше 15–30)' : '');
  };
  $('#trCancel').onclick = () => ($('#trainBox').hidden = true);
  $('#trGo').onclick = async () => {
    const name = $('#trName').value.trim() || 'Мой стиль';
    const body = { name, quality, ...(source === 'board' ? { boardId: $('#trBoard').value } : { images: files }) };
    try {
      $('#trGo').disabled = true;
      const job = await api('/api/train', body);
      $('#trainBox').hidden = true;
      addJob(job);
      toast('Обучение началось — следите за прогрессом в ленте');
    } catch (e) { toast(e.message, true); }
    $('#trGo').disabled = false;
  };
}

// ---------------- набросок / контур с фото ----------------
function renderSketch() {
  const c = state.control;
  $('#sketchBadge').hidden = !c;
  $('#sketchBtn').classList.toggle('on', !!c || !$('#sketchTray').hidden);
  const mode = c?.mode || state.sketchMode || 'sketch';
  $$('#sketchMode button').forEach((b) => b.classList.toggle('on', b.dataset.m === mode));
  const power = c?.strength ?? 0.8;
  $('#sketchPower').value = power;
  $('#vSketch').textContent = LEVELS.sk(power);
  $('#sketchSlot').innerHTML = c
    ? `<div class="src sk-img"><img src="${c.url}" alt=""><button id="sketchRm" title="Убрать">×</button></div>`
    : `<label class="src add sk-img"><input type="file" accept="image/*" hidden id="sketchInput"><span>+</span><small>набросок или фото</small></label>`;
  if ($('#sketchRm')) $('#sketchRm').onclick = () => { state.control = null; renderSketch(); };
  if ($('#sketchInput')) $('#sketchInput').onchange = async (e) => { const f = e.target.files[0]; if (f) setControl({ url: await blobToDataUrl(f, 1536) }); };
}

function setControl(c) {
  if (!c.file && c.jobId == null) c.data = c.url;
  state.control = { mode: state.sketchMode || 'sketch', strength: 0.8, ...state.control, ...c };
  $('#sketchTray').hidden = false;
  renderSketch();
}

const controlPayload = () => state.control && ({
  mode: state.control.mode, strength: state.control.strength,
  ...(state.control.file ? { file: state.control.file } : state.control.jobId != null ? { jobId: state.control.jobId, index: state.control.index } : { data: state.control.data }),
});

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
    </div>`).join('')
    + (n < 3 ? `<label class="st-slot add"><div class="src add"><input type="file" accept="image/*" hidden id="styleInput"><span>+</span><small>${n ? 'ещё' : 'образец'}</small></div></label>` : '')
    + (n ? '' : '<p class="src-hint">Добавьте 1–3 картинки, чей стиль нравится: свои работы, картины мастеров, фото фактур. Можно перетащить сюда или нажать «Взять стиль» у любой работы.</p>');
  box.onclick = (e) => { const rm = e.target.closest('[data-rm]'); if (rm) { state.styleRefs.splice(+rm.dataset.rm, 1); renderStyleRefs(); } };
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

const styleRefPayload = () => ($('#myLora').value ? [] : state.styleRefs).map((r) => ({
  w: 1, ...(r.file ? { file: r.file } : r.jobId != null ? { jobId: r.jobId, index: r.index } : { data: r.data }),
}));

async function loadMyStyles() {
  try { state.myStyles = await api('/api/styles'); } catch { state.myStyles = []; }
  $('#myStyles').innerHTML = '<option value="">Мои подборки…</option>'
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
  } else if (!$('#sketchTray').hidden) {
    setControl({ url: await blobToDataUrl(blob, 1536), jobId: undefined, file: undefined });
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
  // просят реализм, а выбрана рисовальная техника — только подсказка, рисуем с настройками художника
  if (state.mode === 'draw' && !$('#myLora').value && /реалист|фотореал|как фото|realistic|photoreal/i.test(text)
      && !['realism', 'raw', 'oil'].includes(state.params.style)) {
    toast(`Рисую в технике «${styleName(state.params.style)}». Нужен реализм — выберите технику «Реализм».`);
  }
  const btn = $('#goBtn');
  btn.disabled = true;
  try {
    let job;
    if (state.mode === 'edit') {
      if (!state.sources.length) { toast('Сначала добавьте картинку', true); btn.disabled = false; return; }
      job = await api('/api/edit', { instruction: text, count: state.editCount, quality: state.editQuality, sources: state.sources.map((s) => s.ref || s.data), ...editKnobs() });
    } else {
      const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
      if (lines.length > 1) {
        const seriesSeed = Math.floor(Math.random() * 2 ** 31);
        const seriesId = Date.now().toString(36);
        for (let i = lines.length - 1; i >= 0; i--) {
          const j = await api('/api/imagine', { prompt: lines[i], params: { ...state.params, myLora: myLoraParam(), seed: seriesSeed, series: { id: seriesId, n: i + 1, of: lines.length } }, ref: state.ref, styles: styleRefPayload(), control: controlPayload() });
          addJob(j);
        }
        $('#prompt').value = '';
        autosize();
        btn.disabled = false;
        toast(`Серия из ${lines.length} работ поставлена в очередь`);
        return;
      }
      job = await api('/api/imagine', { prompt: text, params: { ...state.params, myLora: myLoraParam() }, ref: state.ref, styles: styleRefPayload(), control: controlPayload() });
    }
    addJob(job);
    $('#prompt').value = '';
    autosize();
  } catch (e) { toast(e.message, true); }
  btn.disabled = false;
}

async function action(act, job, index) {
  if (act.startsWith('out-ar:')) {
    try { addJob(await api('/api/outpaint', { jobId: job.id, index, mode: 'ar', ar: act.slice(7) })); closeLightbox(); } catch (e) { toast(e.message, true); }
    return;
  }
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
      case 'out-wide': case 'out-tall': case 'out-all': // два варианта: «спокойно» и «с деталями»
        addJob(await api('/api/outpaint', { jobId: job.id, index, mode: act.slice(4), amount: 0.45 }));
        break;
      case 'to-board':
        openBoardPick(job, index);
        return;
      case 'save-prompt':
        openSavePrompt(job);
        return;
      case 'paints':
        await Paints.open('/images/' + job.images[index].file);
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
        if (job.control) { state.control = { url: '/images/' + job.control.file, file: job.control.file, mode: job.control.mode, strength: job.control.strength }; $('#sketchTray').hidden = false; }
        if (job.styleFiles?.length) {
          state.styleRefs = job.styleFiles.map((f, i) => ({ url: '/images/' + f, file: f, w: job.styleWeights?.[i] ?? 1 }));
          $('#styleTray').hidden = false;
          syncControls();
        }
        autosize();
        $('#prompt').focus();
        return;
      case 'as-sketch':
        closeLightbox();
        setMode('draw');
        state.sketchMode = 'photo';
        state.control = null;
        setControl({ url: '/images/' + job.images[index].file, jobId: job.id, index, mode: 'photo' });
        $('main').scrollTo({ top: 0, behavior: 'smooth' });
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
      case 'dislike': {
        await api(`/api/jobs/${job.id}/${index}/${act}`, {});
        const im = job.images[index];
        if (act === 'like') { im.liked = !im.liked; if (im.liked) im.disliked = false; }
        else { im.disliked = !im.disliked; if (im.disliked) im.liked = false; }
        refreshAll();
        renderTaste();
        if (im.disliked) toast('Понял — такое не нравится. С «Моим вкусом» Arto будет уводить от похожего');
        return;
      }
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
const jobSig = (j) => j.status + '|' + j.images.map((i) => (i.file || '') + (i.error ? 'E' : '') + (i.liked ? 'L' : '') + (i.disliked ? 'D' : '')).join(',');

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
  if (job.type === 'train') return `<span class="chip">${job.sources?.length || ''} образцов · ${job.params.steps} шагов</span>`;
  if (job.type === 'edit') return `<span class="chip">${job.sources?.length > 1 ? 'из ' + job.sources.length + ' картинок' : 'по картинке'}</span>${job.params?.quality === 'draft' ? '<span class="chip">черновик</span>' : ''}`;
  const p = job.params;
  const chips = [p.myLora ? null : styleName(p.style), formatName(p.ar || '1:1')].filter(Boolean);
  if (p.quality === 'draft') chips.push('черновик');
  if (p.quality === 'high') chips.push('высокое качество');
  if (+p.chaos) chips.push('разнообразие: ' + LEVELS.chaos(+p.chaos));
  if (+p.weird) chips.push('странность: ' + LEVELS.weird(+p.weird));
  for (const id of p.guards || []) { const g = (state.guards || []).find((x) => x.id === id); if (g) chips.push('следить: ' + g.name.toLowerCase()); }
  if (p.no) chips.push('без: ' + p.no);
  if (job.usedReference) chips.push('от картинки');
  if (job.control) chips.push(job.control.mode === 'photo' ? 'по контуру фото' : 'по наброску');
  if (p.myLora) { const ml = (state.myLoras || []).find((x) => x.id === p.myLora.id); chips.push(job.mannerName || ml ? 'мой стиль: ' + (job.mannerName || ml.name) : 'мой стиль'); }
  if (job.tasteFiles?.length) chips.push('мой вкус');
  if (p.series) chips.unshift(`серия ${p.series.n}/${p.series.of}`);
  return chips.map((c) => `<span class="chip">${esc(c)}</span>`).join('');
}

function cellHTML(job, img, i) {
  const fixed = job.type === 'imagine' || job.type === 'variation' || job.type === 'outpaint';
  const ratio = fixed ? `style="aspect-ratio:${job.params.width}/${job.params.height}"` : '';
  if (img.file) {
    return `<div class="cell${img.disliked ? ' disliked' : ''}" data-i="${i}" ${ratio}>
      <img src="/images/${esc(img.file)}" loading="lazy" onload="this.classList.add('loaded')" alt="">
      ${img.liked ? '<span class="liked">♥</span>' : ''}
      <div class="quick">
        ${state.edition.canEdit ? '<button data-q="edit">Изменить</button>' : ''}
        <button data-q="studio">Редактор</button>
        ${job.type !== 'upscale' ? '<button data-q="vary-subtle">Похожие</button><button data-q="upscale">×2</button>' : ''}
        <button data-q="like" title="Нравится">${img.liked ? '♥' : '♡'}</button>
        <button data-q="dislike" title="Не то">${img.disliked ? '👎' : '<span class="dim">👎</span>'}</button>
      </div>
    </div>`;
  }
  if (img.cancelled) return `<div class="cell gone" ${ratio}>отменено</div>`;
  if (img.error) return `<div class="cell failed" ${ratio} title="${esc(img.error)}"><b>Не получилось</b><small>${esc(img.error.slice(0, 140))}</small></div>`;
  if (img.deleted) return `<div class="cell gone" ${ratio}>удалено</div>`;
  return `<div class="cell pending" data-p="${i}" ${ratio || 'style="aspect-ratio:1"'}>${progressHTML(img.progress, job.type)}</div>`;
}

// Шкала прогресса: этап, проценты, сколько осталось
const STAGES = { queued: 'в очереди', starting: 'запускаю двигатель', loading: 'готовлюсь', model: 'загружаю модель', drawing: 'рисую' };
function progressHTML(p, kind) {
  p = p || { stage: 'queued', pct: 0 };
  const eta = p.slow ? 'до минуты' : p.eta ? (p.eta >= 60 ? `~${Math.floor(p.eta / 60)} мин ${p.eta % 60} с` : `~${p.eta} с`) : '';
  return `<div class="prog">
      <span class="prog-stage">${kind === 'train' && p.stage === 'drawing' ? 'обучаю' : STAGES[p.stage] || 'рисую'}</span>
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
    if (cell) cell.innerHTML = progressHTML(img.progress, job.type);
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
        ${job.type === 'studio' || job.type === 'upscale' ? '' : '<button class="btn star" data-a="save-prompt" title="Сохранить запрос в «Мои промпты»">☆</button>'}
        ${job.status === 'running' ? '' : '<button class="btn danger" data-a="delete-job" title="Удалить">✕</button>'}
      </div>
      <div class="time">${job.status === 'running' ? (job.type === 'train' ? 'Обучаю…' : `Рисую… ${done} из ${n}`) : time}</div>
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
  $('#lbDislike').classList.toggle('on', !!img.disliked);
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

// ---------------- доски настроения ----------------
let boards = [];
let pickFor = null;

async function loadBoards() {
  try { boards = await api('/api/boards'); } catch (e) { return toast(e.message, true); }
  renderBoards();
}

function renderBoards() {
  const b = boards.find((x) => x.id === state.board);
  if (!b) {
    $('#bdTitle').textContent = 'Доски настроения';
    $('#bdActions').innerHTML = '<button class="btn primary" data-bd="new">+ Новая доска</button>';
    $('#bdBody').innerHTML = boards.length
      ? '<div class="bd-grid">' + boards.map((x) => `<button class="bd-card" data-open="${x.id}">
          <div class="bd-cover">${x.items.slice(0, 4).map((it) => `<img src="/images/${esc(it.file)}" alt="" loading="lazy">`).join('') || '<span>пусто</span>'}</div>
          <b>${esc(x.name)}</b><small>${x.items.length} ${x.items.length === 1 ? 'картинка' : x.items.length < 5 ? 'картинки' : 'картинок'}</small></button>`).join('') + '</div>'
      : '<div class="empty small"><p>Соберите удачные работы в подборки: «Осенний цикл», «Портреты»…<br>Создайте доску, а потом в окне просмотра любой работы нажмите «На доску».</p></div>';
    return;
  }
  $('#bdTitle').innerHTML = `<button class="link-btn" data-bd="back">← Доски</button> <span contenteditable="true" spellcheck="false" class="bd-name" title="Нажмите, чтобы переименовать">${esc(b.name)}</span>`;
  $('#bdActions').innerHTML = '<button class="btn" data-bd="collage">Скачать коллажем</button><button class="btn danger" data-bd="del">Удалить доску</button>';
  $('#bdBody').innerHTML = b.items.length
    ? '<div class="bd-wall">' + b.items.map((it, i) => `<figure class="bd-item" data-i="${i}">
        <img src="/images/${esc(it.file)}" alt="" loading="lazy">
        <button class="bd-x" data-rm="${i}" title="Убрать с доски">×</button>
        <figcaption contenteditable="true" spellcheck="false" data-note="${i}" data-ph="добавить заметку…">${esc(it.note)}</figcaption></figure>`).join('') + '</div>'
    : '<div class="empty small"><p>Доска пуста. Откройте любую работу и нажмите «На доску».</p></div>';
}

async function collage(b) {
  // лист-коллаж: картинки рядами по 4, с названием доски
  const imgs = await Promise.all(b.items.map((it) => new Promise((ok) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => ok(null); im.src = '/images/' + it.file; })));
  const list = imgs.filter(Boolean);
  if (!list.length) return toast('Доска пуста', true);
  const cols = Math.min(4, list.length), cw = 480, gap = 16, head = 90;
  const rows = [];
  for (let i = 0; i < list.length; i += cols) rows.push(list.slice(i, i + cols));
  const rowH = rows.map((r) => Math.min(...r.map((im) => (cw * im.naturalHeight) / im.naturalWidth)));
  const W = cols * cw + (cols + 1) * gap, H = head + rowH.reduce((a, h) => a + h + gap, gap);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#121214'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#ecebe8'; g.font = '600 40px Georgia, serif'; g.fillText(b.name, gap * 2, 58);
  let y = head;
  rows.forEach((r, ri) => {
    r.forEach((im, ci) => {
      const h = rowH[ri], x = gap + ci * (cw + gap);
      const s = Math.max(cw / im.naturalWidth, h / im.naturalHeight);
      const sw = cw / s, sh = h / s;
      g.drawImage(im, (im.naturalWidth - sw) / 2, (im.naturalHeight - sh) / 2, sw, sh, x, y, cw, h);
    });
    y += rowH[ri] + gap;
  });
  const a = document.createElement('a');
  a.href = c.toDataURL('image/jpeg', 0.92);
  a.download = 'arto_doska_' + b.name.replace(/[^\p{L}\p{N}]+/gu, '_') + '.jpg';
  a.click();
}

async function openBoardPick(job, index) {
  pickFor = { jobId: job.id, index };
  try { boards = await api('/api/boards'); } catch {}
  $('#bpList').innerHTML = boards.map((b) => `<button class="btn" data-pick="${b.id}">${esc(b.name)} <small>${b.items.length}</small></button>`).join('') || '<p class="muted">Досок пока нет — создайте первую.</p>';
  $('#bpNew').value = '';
  $('#boardPick').hidden = false;
}

function bindBoards() {
  const add = async (boardId) => {
    try { await api('/api/boards/' + boardId + '/items', pickFor); $('#boardPick').hidden = true; toast('Добавлено на доску'); } catch (e) { toast(e.message, true); }
  };
  $('#bpList').onclick = (e) => { const b = e.target.closest('[data-pick]'); if (b) add(b.dataset.pick); };
  $('#bpCreate').onclick = async () => {
    const name = $('#bpNew').value.trim() || 'Новая доска';
    const b = await api('/api/boards', { name });
    add(b.id);
  };
  $('#bpCancel').onclick = () => ($('#boardPick').hidden = true);
  $('#boardPick').addEventListener('click', (e) => { if (e.target.id === 'boardPick') $('#boardPick').hidden = true; });

  $('#page-boards').addEventListener('click', async (e) => {
    const open = e.target.closest('[data-open]');
    if (open) { state.board = open.dataset.open; renderBoards(); return; }
    const a = e.target.closest('[data-bd]');
    const b = boards.find((x) => x.id === state.board);
    if (a?.dataset.bd === 'new') {
      const name = prompt('Название доски', 'Новая доска');
      if (!name) return;
      const nb = await api('/api/boards', { name });
      boards.unshift(nb); state.board = nb.id; renderBoards();
    }
    if (a?.dataset.bd === 'back') { state.board = null; renderBoards(); }
    if (a?.dataset.bd === 'collage' && b) collage(b);
    if (a?.dataset.bd === 'del' && b && confirm('Удалить доску «' + b.name + '»? Работы в ленте останутся.')) {
      await api('/api/boards/' + b.id, null, 'DELETE'); state.board = null; loadBoards();
    }
    const rm = e.target.closest('[data-rm]');
    if (rm && b) { const nb = await api('/api/boards/' + b.id + '/items/' + rm.dataset.rm, null, 'DELETE'); Object.assign(b, nb); renderBoards(); }
    const fig = e.target.closest('.bd-item');
    if (fig && e.target.tagName === 'IMG' && b) {
      const it = b.items[+fig.dataset.i];
      const job = it.from && state.jobs.find((j) => j.id === it.from.jobId);
      if (job) openLightbox(allImages(), job, it.from.index);
    }
  });
  $('#page-boards').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.target.classList.contains('bd-name') || e.target.dataset.note != null)) { e.preventDefault(); e.target.blur(); } });
  $('#page-boards').addEventListener('focusout', async (e) => {
    const b = boards.find((x) => x.id === state.board);
    if (!b) return;
    if (e.target.classList.contains('bd-name')) {
      const n = e.target.textContent.trim();
      if (n && n !== b.name) { b.name = n; await api('/api/boards/' + b.id, { name: n }, 'PATCH'); }
    }
    if (e.target.dataset.note != null) {
      const i = +e.target.dataset.note;
      const t = e.target.textContent.trim();
      if (t !== b.items[i].note) { b.items[i].note = t; await api('/api/boards/' + b.id + '/items/' + i, { note: t }, 'PATCH'); }
    }
  });
}

// ---------------- «Мои промпты» ----------------
let prompts = [];
let saveFor = null;

function openSavePrompt(job) {
  saveFor = job;
  $('#spTitle').value = (job.prompt || '').slice(0, 40);
  $('#spText').textContent = job.rawPrompt || job.prompt;
  $('#savePrompt').hidden = false;
  $('#spTitle').focus();
  $('#spTitle').select();
}

async function loadPrompts() {
  try { prompts = await api('/api/prompts'); } catch (e) { return toast(e.message, true); }
  renderPrompts();
}

function renderPrompts() {
  const q = ($('#prSearch').value || '').toLowerCase();
  const list = prompts.filter((p) => !q || (p.title + ' ' + p.prompt).toLowerCase().includes(q));
  $('#prEmpty').hidden = prompts.length > 0;
  $('#prList').innerHTML = list.map((p) => {
    const chips = p.kind === 'edit'
      ? ['изменение картинки']
      : [styleName(p.params.style || 'raw'), formatName(p.params.ar || '1:1'), p.params.quality === 'draft' ? 'черновик' : p.params.quality === 'high' ? 'высокое качество' : ''].filter(Boolean);
    return `<div class="pr-row" data-id="${p.id}">
      <div class="pr-thumb">${p.thumb ? `<img src="/images/${esc(p.thumb)}" alt="" loading="lazy">` : '<span>✎</span>'}</div>
      <div class="pr-main">
        <div class="pr-title" contenteditable="true" spellcheck="false" title="Нажмите, чтобы переименовать">${esc(p.title)}</div>
        <div class="pr-text">${esc(p.prompt)}</div>
        <div class="chips">${chips.map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</div>
      </div>
      <div class="pr-actions">
        <button class="btn primary" data-pa="use">Использовать</button>
        <button class="btn danger" data-pa="del" title="Удалить">✕</button>
      </div>
    </div>`;
  }).join('');
}

function usePrompt(p) {
  showPage('create');
  setMode(p.kind === 'edit' ? 'edit' : 'draw');
  if (p.kind !== 'edit') {
    for (const [k, v] of Object.entries(p.params || {})) if (v != null && v !== '') state.params[k] = v;
    saveParams();
    syncControls();
  }
  $('#prompt').value = p.prompt;
  autosize();
  $('#prompt').focus();
  toast('Запрос вставлен — нажмите «' + (p.kind === 'edit' ? 'Изменить' : 'Нарисовать') + '»');
}

function bindPrompts() {
  $('#spCancel').onclick = () => ($('#savePrompt').hidden = true);
  $('#savePrompt').addEventListener('click', (e) => { if (e.target.id === 'savePrompt') $('#savePrompt').hidden = true; });
  const save = async () => {
    try {
      await api('/api/prompts', { jobId: saveFor.id, title: $('#spTitle').value });
      $('#savePrompt').hidden = true;
      toast('Сохранено в «Мои промпты»');
    } catch (e) { toast(e.message, true); }
  };
  $('#spSave').onclick = save;
  $('#spTitle').addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') $('#savePrompt').hidden = true; });
  $('#prSearch').addEventListener('input', renderPrompts);
  $('#prList').addEventListener('click', async (e) => {
    const row = e.target.closest('.pr-row');
    const b = e.target.closest('[data-pa]');
    if (!row || !b) return;
    const p = prompts.find((x) => x.id === row.dataset.id);
    if (b.dataset.pa === 'use') usePrompt(p);
    if (b.dataset.pa === 'del' && confirm('Удалить «' + p.title + '» из «Моих промптов»?')) {
      await api('/api/prompts/' + p.id, null, 'DELETE');
      loadPrompts();
    }
  });
  // переименование прямо в строке
  $('#prList').addEventListener('keydown', (e) => { if (e.target.classList.contains('pr-title') && e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });
  $('#prList').addEventListener('focusout', async (e) => {
    if (!e.target.classList.contains('pr-title')) return;
    const p = prompts.find((x) => x.id === e.target.closest('.pr-row').dataset.id);
    const t = e.target.textContent.trim();
    if (p && t && t !== p.title) { p.title = t; await api('/api/prompts/' + p.id, { title: t }, 'PATCH'); toast('Переименовано'); }
  });
}

// ---------------- навигация и события ----------------
function showPage(page) {
  state.page = page;
  document.body.dataset.page = page;
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  $$('.page').forEach((p) => (p.hidden = p.id !== 'page-' + page));
  if (page === 'gallery') renderGallery();
  if (page === 'prompts') loadPrompts();
  if (page === 'boards') { state.board = null; loadBoards(); }
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
  $('#style').onchange = (e) => { state.params.style = e.target.value; saveParams(); syncControls(); };
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
  $('#sketchBtn').onclick = () => { $('#sketchTray').hidden = !$('#sketchTray').hidden; $('#styleTray').hidden = true; $('#more').hidden = true; renderSketch(); };
  $('#sketchMode').onclick = (e) => {
    const b = e.target.closest('[data-m]');
    if (!b) return;
    state.sketchMode = b.dataset.m;
    if (state.control) state.control.mode = b.dataset.m;
    renderSketch();
  };
  $('#sketchPower').addEventListener('input', (e) => {
    const v = +e.target.value;
    if (state.control) state.control.strength = v;
    $('#vSketch').textContent = LEVELS.sk(v);
  });
  // чистый лист в редакторе — набросать композицию кистью
  $('#sketchDraw').onclick = () => {
    const ar = (state.params.ar || '1:1').split(':').map(Number);
    const k = 1024 / Math.max(ar[0], ar[1]);
    const c = document.createElement('canvas');
    c.width = Math.round(ar[0] * k); c.height = Math.round(ar[1] * k);
    const g = c.getContext('2d'); g.fillStyle = '#ffffff'; g.fillRect(0, 0, c.width, c.height);
    $('#edTitle').value = 'Набросок';
    Editor.open({ src: c.toDataURL('image/png'), blank: true });
  };
  window.onEditorToSketch = (dataUrl) => {
    state.sketchMode = 'sketch';
    state.control = null;
    setMode('draw');
    showPage('create');
    setControl({ url: dataUrl, mode: 'sketch' });
    $('#prompt').focus();
    toast('Набросок готов — опишите, что это, и нажмите «Нарисовать»');
  };
  $('#styleBtn').onclick = () => { $('#styleTray').hidden = !$('#styleTray').hidden; $('#sketchTray').hidden = true; $('#more').hidden = true; renderStyleRefs(); };
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
      if (st && confirm('Удалить подборку «' + st.name + '»?')) { await api('/api/styles/' + st.id, null, 'DELETE'); await loadMyStyles(); }
      return;
    }
    const st = state.myStyles.find((x) => x.id === v);
    if (!st) return;
    state.styleRefs = st.files.map((f, i) => ({ url: '/images/' + f, file: f, w: st.weights?.[i] ?? 1 }));
    syncControls();
  };
  $('#tasteBtn').onclick = () => {
    state.params.taste = !state.params.taste;
    saveParams();
    syncControls();
    if (state.params.taste && !$('#tasteN').textContent) toast('Отмечайте ♡ то, что нравится, и 👎 то, что не то, — Arto начнёт учитывать ваш вкус в этой технике');
  };
  $('#guardSeg').onclick = (e) => {
    const b = e.target.closest('[data-g]');
    if (!b) return;
    const set = new Set(state.params.guards || []);
    set.has(b.dataset.g) ? set.delete(b.dataset.g) : set.add(b.dataset.g);
    state.params.guards = [...set];
    saveParams();
    syncControls();
  };
  $('#resetParams').onclick = () => { state.params = { ...DEFAULT_PARAMS }; saveParams(); syncControls(); };

  $('#refX').onclick = (e) => { e.preventDefault(); e.stopPropagation(); state.ref = null; syncControls(); };
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
