// Arto — локальная мастерская эскизов в духе Midjourney.
// Рисует бесплатно и офлайн на вашей видеокарте через скрытый «двигатель» ComfyUI.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Журнал ошибок запуска: data/server.log — его можно просто переслать при проблемах
const LOG_FILE = path.join(__dirname, 'data', 'server.log');
function logError(where, e) {
  const line = `[${new Date().toISOString()}] ${where}: ${e && e.stack ? e.stack : e}\n`;
  console.error(line);
  try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); fs.appendFileSync(LOG_FILE, line); } catch {}
}
process.on('uncaughtException', (e) => { logError('Ошибка', e); process.exit(1); });
process.on('unhandledRejection', (e) => logError('Ошибка (async)', e));

const { STYLES, buildPrompts, parseInlineParams, dimsFor } = require('./prompt');
const { Comfy, wfGenerate, wfUpscale, wfEdit } = require('./comfy');
const { toEnglish, preload: preloadTranslator } = require('./translate');
// библиотека картинок нужна только для сохранения фактуры — если её нет, остальное работает
const texture = () => require('./texture');

const PORT = process.env.PORT || 7777;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const IMAGES = path.join(DATA, 'images');
const GALLERY_FILE = path.join(DATA, 'gallery.json');

fs.mkdirSync(IMAGES, { recursive: true });

// общие настройки (обновляются с программой) + личные настройки этого ПК (data/local.json)
const readCfg = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return {}; } };
const mergeCfg = (a, b) => {
  for (const [k, v] of Object.entries(b || {})) a[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' ? mergeCfg({ ...a[k] }, v) : v;
  return a;
};
const config = mergeCfg(readCfg(path.join(ROOT, 'atelier.config.json')), readCfg(path.join(DATA, 'local.json')));
const updater = require('./update');
const edition = { id: config.edition, ...config.editions[config.edition] };
const comfy = new Comfy(config.comfy);
comfy.ensureRunning();
preloadTranslator();

// ---------- хранилище ----------
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
let gallery = readJSON(GALLERY_FILE, []);
function saveGallery() {
  fs.writeFileSync(GALLERY_FILE + '.tmp', JSON.stringify(gallery));
  fs.renameSync(GALLERY_FILE + '.tmp', GALLERY_FILE);
}

function sniffExt(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'webp';
  return 'png';
}
function dataUriToBuffer(uri) {
  const m = /^data:[^;]+;base64,(.*)$/s.exec(uri || '');
  return m ? Buffer.from(m[1], 'base64') : null;
}
const newId = () => Date.now().toString(36) + crypto.randomBytes(3).toString('hex');

function saveImage(name, buf) {
  const file = `${name}.${sniffExt(buf)}`;
  fs.writeFileSync(path.join(IMAGES, file), buf);
  return file;
}

// ---------- очередь видеокарты: задания выполняются по одному ----------
let gpuChain = Promise.resolve();
const onGpu = (fn) => (gpuChain = gpuChain.then(fn, fn));

const modelCache = {};
async function model(folder, name) {
  const key = folder + '|' + name;
  if (!modelCache[key]) {
    const found = await comfy.resolve(folder, name);
    if (!found) throw new Error(`Не найдена модель «${name}». Переустановите Arto.`);
    modelCache[key] = found;
  }
  return modelCache[key];
}

// ---------- задания ----------
const active = new Map();
let running = null; // задание, которое сейчас на видеокарте

// Временные задания (ИИ-правки внутри редактора) не попадают в ленту
const temp = new Map();

function finishJob(job) {
  job.status = job.images.some((i) => i.file) ? 'done' : job.cancelled ? 'cancelled' : 'error';
  if (job.cancelled && job.status === 'cancelled') {
    // ничего не успело нарисоваться — задание просто исчезает
    active.delete(job.id);
    temp.set(job.id, job);
    setTimeout(() => temp.delete(job.id), 10 * 60000);
    return;
  }
  job.finishedAt = Date.now();
  active.delete(job.id);
  if (job.temp) {
    temp.set(job.id, job);
    setTimeout(() => {
      temp.delete(job.id);
      for (const f of jobFiles(job)) fs.rm(path.join(IMAGES, f), () => {});
    }, 30 * 60000);
    return;
  }
  gallery.unshift(job);
  saveGallery();
}

// ---------- прогресс: проценты и «осталось ~N с» ----------
// Средняя длительность одной картинки по видам работ — уточняется после каждого запуска
const avgSec = { imagine: 6, variation: 6, upscale: 3, edit: 40 };

function tracker(img, kind) {
  const t0 = Date.now();
  let sampleStart = null;
  img.progress = { stage: 'loading', pct: 2, eta: Math.ceil(avgSec[kind] || 10) };
  const fn = (ev) => {
    const el = (Date.now() - t0) / 1000;
    if (ev.type === 'progress' && ev.max > 0) {
      if (!sampleStart) sampleStart = Date.now();
      const f = ev.value / ev.max;
      const se = (Date.now() - sampleStart) / 1000;
      const rem = f > 0 && se > 0 ? (se / f) * (1 - f) + 0.8 : Math.max(1, (avgSec[kind] || 10) - el);
      img.progress = { stage: 'drawing', pct: Math.round(10 + 85 * f), eta: Math.max(1, Math.ceil(rem)) };
    } else if (!sampleStart) {
      const left = (avgSec[kind] || 10) - el;
      // модель грузится с диска — сколько это займёт, заранее не известно
      img.progress = left > 0
        ? { stage: 'loading', pct: Math.min(9, 2 + Math.floor(el)), eta: Math.ceil(left) }
        : { stage: 'model', pct: Math.min(9, 2 + Math.floor(el / 5)), eta: null, slow: true };
    }
  };
  fn.done = () => {
    const total = (Date.now() - t0) / 1000;
    // загрузку модели (долгие разовые запуски) в среднее не берём
    if (total < (avgSec[kind] || 10) * 4) avgSec[kind] = +(0.7 * (avgSec[kind] || total) + 0.3 * total).toFixed(1);
  };
  return fn;
}

function startJob(job, runOne) {
  active.set(job.id, job);
  (async () => {
    job.images.forEach((img, i) => { img.progress = { stage: 'queued', pct: 0, eta: null, pos: i }; });
    for (const img of job.images) {
      await onGpu(async () => {
        if (job.cancelled) { img.error = 'Отменено'; img.cancelled = true; delete img.progress; return; }
        running = job;
        const prog = tracker(img, job.type);
        try {
          if (comfy.status !== 'ready') throw new Error(comfy.message);
          img.file = saveImage(`${job.id}_${img.index}`, await runOne(img, prog));
          prog.done();
        } catch (e) {
          img.error = e.message;
          console.error(`[${job.id}#${img.index}]`, e.message);
        }
        if (job.cancelled && !img.file) { img.error = 'Отменено'; img.cancelled = true; }
        delete img.progress;
        running = null;
      });
    }
    finishJob(job);
  })();
  return job;
}

function baseJob(type, extra) {
  return {
    id: newId(), type, createdAt: Date.now(), status: 'running', edition: edition.id, variation: null, ...extra,
  };
}

// Нарисовать (в т.ч. от картинки-основы и вариации)
async function createImagine({ prompt, params, ref, variation, styles = [] }) {
  const inline = parseInlineParams(prompt);
  const p = { ...params, ...inline.params };
  const count = Math.max(1, Math.min(32, Math.round(+p.count) || 4));
  const seed = p.seed !== '' && p.seed != null && Number.isFinite(+p.seed) ? +p.seed : Math.floor(Math.random() * 2 ** 31);
  const subjectEn = await toEnglish(inline.text);
  const noEn = await toEnglish(p.no);
  const built = buildPrompts({ subject: subjectEn, style: p.style, stylize: +p.stylize, chaos: +p.chaos, weird: +p.weird, no: noEn, seed, count });
  // Качество: черновик — меньше и быстрее; высокое — больше шагов и сразу увеличение ×2
  const q = ['draft', 'normal', 'high'].includes(p.quality) ? p.quality : 'normal';
  const g0 = edition.generate;
  const g = {
    ...g0,
    base: q === 'draft' ? Math.round(g0.base * 0.75 / 64) * 64 : g0.base,
    steps: q === 'draft' ? Math.max(3, Math.round(g0.steps / 2)) : q === 'high' ? Math.round(g0.steps * 1.5) : g0.steps,
  };
  const [width, height] = dimsFor(p.ar, g.base);
  const refBuf = ref ? (Buffer.isBuffer(ref) ? ref : dataUriToBuffer(ref)) : null;
  const denoise = variation ? variation.strength : Math.max(0.15, Math.min(0.95, 1 - (+p.iw || 1) / 2.2));

  const job = baseJob(variation ? 'variation' : 'imagine', {
    variation: variation || null,
    prompt: inline.text,
    rawPrompt: prompt,
    params: { ...p, seed, count, width, height, quality: q },
    usedReference: !!refBuf,
    styleFiles: [],
    negative: built.negative,
    images: built.prompts.map((fp, i) => ({ index: i, finalPrompt: fp, seed: seed + i, file: null, error: null, liked: false })),
  });
  if (refBuf && !variation) job.sources = [saveImage(`${job.id}_src0`, refBuf)];
  job.styleFiles = styles.slice(0, 3).map((st, i) => saveImage(`${job.id}_style${i}`, st.buf));
  job.styleWeights = styles.slice(0, 3).map((st) => st.w);
  const sw = Number.isFinite(+p.sw) ? Math.max(0, Math.min(2, +p.sw)) : 1;

  let refName = null;
  let styleNames = null;
  return startJob(job, async (img, prog) => {
    if (refBuf && !refName) refName = await comfy.upload(refBuf, `${job.id}_ref.${sniffExt(refBuf)}`);
    if (job.styleFiles.length && !styleNames) {
      styleNames = await Promise.all(job.styleFiles.map((f) => comfy.upload(fs.readFileSync(path.join(IMAGES, f)), f)));
    }
    const sr = edition.styleRef;
    const style = styleNames && sr ? { ...sr, ipadapter: await model('ipadapter', sr.ipadapter), clipVision: await model('clip_vision', sr.clipVision) } : null;
    const out = await comfy.run(wfGenerate({
      ckpt: await model('checkpoints', g.ckpt), loras: [],
      prompt: img.finalPrompt, negative: built.negative, width, height, seed: img.seed,
      steps: g.steps, cfg: g.cfg, sampler: g.sampler, scheduler: g.scheduler,
      refImage: refName, denoise,
      styleRefs: styleNames, styleWeights: job.styleWeights, style, styleWeight: sw,
    }), { onProgress: prog });
    if (q !== 'high') return out;
    const up = await comfy.upload(out, `${job.id}_hq${img.index}.png`);
    return comfy.run(wfUpscale({ image: up, model: await model('upscale_models', edition.upscale) }));
  });
}

// Размер PNG прямо из заголовка (без библиотек)
function pngSize(buf) {
  return buf[0] === 0x89 && buf[1] === 0x50 ? [buf.readUInt32BE(16), buf.readUInt32BE(20)] : null;
}

const FIX_INSTRUCTION = 'Fix the anatomy: correct hands, fingers, limbs, joints, face and body proportions, and remove all artifacts, glitches and defects. Keep the composition, pose, colors, lighting and painting style exactly the same.';

// Увеличение ×2: simple — просто увеличить; art — дорисовать детали на большом размере; fix — исправить анатомию и дефекты, затем увеличить
function createUpscale(src, index, mode = 'simple') {
  if (mode === 'fix' && !edition.edit) throw new Error('Исправление анатомии доступно только в версии Pro.');
  const s = src.images[index];
  const job = baseJob('upscale', {
    variation: { jobId: src.id, index, mode },
    prompt: src.prompt, rawPrompt: src.rawPrompt, params: { ...src.params, upMode: mode }, negative: src.negative,
    styleFiles: src.styleFiles, styleWeights: src.styleWeights, before: s.file,
    images: [{ index: 0, finalPrompt: s.finalPrompt, seed: s.seed, file: null, error: null, liked: false }],
  });
  return startJob(job, async (img, prog) => {
    let buf = fs.readFileSync(path.join(IMAGES, s.file));
    const upModel = await model('upscale_models', edition.upscale);

    if (mode === 'fix') {
      const e = edition.edit;
      const name = await comfy.upload(buf, `${job.id}_fix.${sniffExt(buf)}`);
      const fixed = await comfy.run(wfEdit({
        images: [name], instruction: FIX_INSTRUCTION, seed: s.seed || 1,
        edit: {
          ...e,
          unet: await model('diffusion_models', e.unet), clip: await model('text_encoders', e.clip),
          vae: await model('vae', e.vae), lora: e.lora ? await model('loras', e.lora) : null,
        },
      }), { onProgress: prog });
      buf = await keepTexture(buf, fixed, { retexture: true, prompt: s.finalPrompt || src.prompt, negative: src.negative, seed: s.seed || 1 });
    }

    const name = await comfy.upload(buf, `${job.id}_in.${sniffExt(buf)}`);
    const up = await comfy.run(wfUpscale({ image: name, model: upModel }), { onProgress: mode === 'simple' ? prog : undefined });
    if (mode !== 'art') return up;

    // художественное: перерисовать увеличенную картинку моделью-художником с малой силой (композиция сохраняется)
    const g = edition.generate;
    const [w0, h0] = pngSize(buf) || [src.params.width || 1024, src.params.height || 1024];
    const k = (g.base * 1.5) / Math.max(w0, h0) * (Math.max(w0, h0) / Math.sqrt(w0 * h0));
    const W = Math.round((w0 * k) / 64) * 64, H = Math.round((h0 * k) / 64) * 64;
    const upName = await comfy.upload(up, `${job.id}_up.png`);
    return comfy.run(wfGenerate({
      ckpt: await model('checkpoints', g.ckpt), loras: [],
      prompt: (s.finalPrompt || src.prompt || '') + ', highly detailed, crisp brushwork, refined details, correct anatomy',
      negative: [src.negative, 'bad anatomy, deformed, extra fingers, extra limbs, blurry, artifacts, noise, jpeg artifacts'].filter(Boolean).join(', '),
      width: W, height: H, seed: s.seed || 1,
      steps: Math.max(10, g.steps + 4), cfg: g.cfg, sampler: g.sampler, scheduler: g.scheduler,
      refImage: upName, denoise: 0.35,
    }), { onProgress: prog });
  });
}

// ---------- сохранение фактуры ----------
// ИИ-редактор перерисовывает всю картинку и сглаживает мазок. Берём из правки только изменённые места;
// при retexture — ещё и «перемазываем» их моделью-художником в манере оригинала (оригинал = образец стиля).
async function keepTexture(orig, edited, { retexture = false, prompt = '', negative = '', seed = 1, prog } = {}) {
  let r;
  try { r = await texture().preserveTexture(orig, edited); } catch (e) { logError('Сохранение фактуры', e); return edited; }
  if (r.changed > 0.6) return edited;          // изменилась почти вся картинка (новый стиль, ночь…) — так и задумано
  if (!retexture || r.changed < 0.002) return r.buf;
  const g = edition.generate;
  const sr = edition.styleRef;
  const W = Math.max(64, Math.round(r.W / 64) * 64), H = Math.max(64, Math.round(r.H / 64) * 64);
  const comp = await comfy.upload(r.buf, `tex_${Date.now()}_c.png`);
  const st = sr ? await comfy.upload(orig, `tex_${Date.now()}_s.${sniffExt(orig)}`) : null;
  const re = await comfy.run(wfGenerate({
    ckpt: await model('checkpoints', g.ckpt), loras: [],
    prompt: (prompt || 'artwork') + ', same medium and technique, expressive brushwork, rich tactile texture, visible strokes',
    negative: [negative, 'smooth, airbrushed, plastic, blurry, cgi, 3d render'].filter(Boolean).join(', '),
    width: W, height: H, seed, steps: Math.max(10, g.steps + 4), cfg: g.cfg, sampler: g.sampler, scheduler: g.scheduler,
    refImage: comp, denoise: 0.3,
    styleRefs: st ? [st] : null, styleWeights: [1], styleWeight: 0.8,
    style: st ? { ...sr, ipadapter: await model('ipadapter', sr.ipadapter), clipVision: await model('clip_vision', sr.clipVision) } : null,
  }), { onProgress: prog });
  return texture().blendByMask(r.buf, re, r.mask, r.W, r.H);
}

// Изменить по команде (аналог Nano Banana)
function createEdit({ instruction, sources, count, from, isTemp, preserve = true, quality = 'normal' }) {
  if (!edition.edit) throw new Error('Редактирование доступно только в версии Pro.');
  const n = Math.max(1, Math.min(4, +count || 1));
  const seed = Math.floor(Math.random() * 2 ** 31);
  const job = baseJob('edit', {
    temp: !!isTemp,
    variation: from || null,
    prompt: instruction, rawPrompt: instruction, params: { count: n, seed, preserve, quality: quality === 'draft' ? 'draft' : 'normal' },
    images: Array.from({ length: n }, (_, i) => ({ index: i, finalPrompt: instruction, seed: seed + i, file: null, error: null, liked: false })),
  });
  job.sources = sources.map((buf, i) => saveImage(`${job.id}_src${i}`, buf));
  if (sources.length === 1) job.before = job.sources[0];
  let names = null;
  return startJob(job, async (img, prog) => {
    if (!names) names = await Promise.all(sources.map((buf, i) => comfy.upload(buf, `${job.id}_src${i}.${sniffExt(buf)}`)));
    const e = edition.edit;
    const out = await comfy.run(wfEdit({
      images: names, instruction, seed: img.seed,
      edit: {
        ...e,
        // черновик: ИИ работает на картинке вдвое меньшей площади — примерно вдвое быстрее
        unet: await model('diffusion_models', e.unet),
        clip: await model('text_encoders', e.clip),
        vae: await model('vae', e.vae),
        lora: e.lora ? await model('loras', e.lora) : null,
      },
    }), { onProgress: prog });
    return preserve && sources.length === 1 ? keepTexture(sources[0], out) : out;
  });
}

// ---------- HTTP ----------
function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req, limit = 60 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Слишком большой файл')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon' };

function serveFile(res, base, rel) {
  const file = path.normalize(path.join(base, rel));
  if (!file.startsWith(base)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': STATIC_TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': base === IMAGES ? 'public, max-age=31536000, immutable' : 'no-cache' });
    res.end(data);
  });
}

const findJob = (id) => active.get(id) || temp.get(id) || gallery.find((j) => j.id === id);
const jobFiles = (job) => [...job.images.map((i) => i.file), ...(job.sources || []), ...(job.styleFiles || []), job.before].filter(Boolean);
const fileInUse = (file) => gallery.some((j) => jobFiles(j).includes(file)) || [...active.values()].some((j) => jobFiles(j).includes(file));

// Образцы стиля: data URI, картинка из ленты {jobId,index} или сохранённый стиль {styleId}
// элемент: { data: dataURI } | { jobId, index } | { file } (из «Моих стилей»), плюс w — влияние 0..2
function styleBuffers(list) {
  const out = [];
  for (const s of list || []) {
    const w = Number.isFinite(+s?.w) ? Math.max(0, Math.min(2, +s.w)) : 1;
    let buf = null;
    if (s?.data) buf = dataUriToBuffer(s.data);
    else if (s?.file && /^[w.-]+$/.test(s.file)) buf = fs.existsSync(path.join(IMAGES, s.file)) ? fs.readFileSync(path.join(IMAGES, s.file)) : null;
    else if (s?.jobId != null) buf = imageBuf(s.jobId, s.index);
    if (buf) out.push({ buf, w });
  }
  return out.slice(0, 3);
}
const jobStyles = (job) => (job.styleFiles || []).map((f, i) => ({ buf: fs.readFileSync(path.join(IMAGES, f)), w: job.styleWeights?.[i] ?? 1 }));

// ---------- «Мои стили» (аналог кодов --sref) ----------
const STYLES_FILE = path.join(DATA, 'styles.json');
let myStyles = readJSON(STYLES_FILE, []);
const saveStyles = () => fs.writeFileSync(STYLES_FILE, JSON.stringify(myStyles, null, 1));

function imageBuf(jobId, index) {
  const img = findJob(jobId)?.images[index];
  return img?.file ? fs.readFileSync(path.join(IMAGES, img.file)) : null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (p === '/api/state' && req.method === 'GET') {
      return send(res, 200, {
        styles: STYLES.map(({ id, name, hint }) => ({ id, name, hint })),
        edition: { id: edition.id, title: edition.title, canEdit: !!edition.edit },
        version: updater.localVersion(),
        engine: { status: comfy.status, message: comfy.message },
        jobs: [...active.values()].filter((j) => !j.temp).reverse().concat(gallery),
      });
    }
    if (p === '/api/update' && req.method === 'GET') {
      try { return send(res, 200, await updater.check()); } catch (e) { return send(res, 200, { available: false, current: updater.localVersion(), error: e.message }); }
    }
    if (p === '/api/update' && req.method === 'POST') {
      if (active.size) return send(res, 409, { error: 'Дождитесь окончания рисования, потом обновите' });
      const r = await updater.apply();
      send(res, 200, r);
      if (r.updated) restartSelf();
      return;
    }
    if (p === '/api/engine') return send(res, 200, { status: comfy.status, message: comfy.message, queue: active.size });
    if (p === '/api/tools' && req.method === 'GET') {
      // Подключаемые инструменты редактора: каждый файл в public/tools/ — отдельный инструмент
      const files = fs.readdirSync(path.join(PUBLIC, 'tools')).filter((f) => f.endsWith('.js')).sort();
      return send(res, 200, files.map((f) => 'tools/' + f));
    }

    if (p === '/api/imagine' && req.method === 'POST') {
      const body = await readBody(req);
      if (!String(body.prompt || '').trim()) return send(res, 400, { error: 'Опишите, что нарисовать' });
      return send(res, 200, await createImagine({ prompt: String(body.prompt), params: body.params || {}, ref: body.ref || null, styles: styleBuffers(body.styles) }));
    }
    if (p === '/api/vary' && req.method === 'POST') {
      const { jobId, index, mode } = await readBody(req);
      const src = findJob(jobId);
      const buf = imageBuf(jobId, index);
      if (!buf) return send(res, 404, { error: 'Изображение не найдено' });
      const strong = mode === 'strong';
      if (src.type === 'edit') {
        return send(res, 200, createEdit({ instruction: src.prompt, sources: [buf], count: 4, from: { jobId, index, mode } }));
      }
      return send(res, 200, await createImagine({
        prompt: src.prompt, params: { ...src.params, seed: '', count: 4 }, ref: buf, styles: jobStyles(src),
        variation: { jobId, index, mode, strength: strong ? 0.72 : 0.45 },
      }));
    }
    if (p === '/api/reroll' && req.method === 'POST') {
      const { jobId } = await readBody(req);
      const src = findJob(jobId);
      if (!src) return send(res, 404, { error: 'Не найдено' });
      if (src.type === 'edit') {
        const sources = (src.sources || []).map((f) => fs.readFileSync(path.join(IMAGES, f)));
        return send(res, 200, createEdit({ instruction: src.prompt, sources, count: src.images.length }));
      }
      return send(res, 200, await createImagine({ prompt: src.rawPrompt || src.prompt, params: { ...src.params, seed: '' }, styles: jobStyles(src) }));
    }
    if (p === '/api/upscale' && req.method === 'POST') {
      const { jobId, index, mode } = await readBody(req);
      const src = findJob(jobId);
      if (!src?.images[index]?.file) return send(res, 404, { error: 'Изображение не найдено' });
      return send(res, 200, createUpscale(src, index, ['simple', 'art', 'fix'].includes(mode) ? mode : 'simple'));
    }
    if (p === '/api/edit' && req.method === 'POST') {
      // источники: картинки из галереи {jobId,index} и/или загруженные (data URI), до 3 штук
      const body = await readBody(req);
      const instruction = String(body.instruction || '').trim();
      if (!instruction) return send(res, 400, { error: 'Напишите, что изменить' });
      const sources = [];
      for (const s of body.sources || []) {
        const buf = typeof s === 'string' ? dataUriToBuffer(s) : imageBuf(s.jobId, s.index);
        if (buf) sources.push(buf);
      }
      if (!sources.length) return send(res, 400, { error: 'Добавьте картинку, которую нужно изменить' });
      const from = body.sources?.[0]?.jobId ? body.sources[0] : null;
      return send(res, 200, createEdit({ instruction, sources: sources.slice(0, 3), count: body.count, from, isTemp: !!body.temp, preserve: body.preserve !== false, quality: body.quality }));
    }
    if (p === '/api/save' && req.method === 'POST') {
      // результат из редактора → новая работа в ленте
      const body = await readBody(req);
      const buf = dataUriToBuffer(body.image);
      if (!buf) return send(res, 400, { error: 'Нет изображения' });
      const job = baseJob('studio', {
        status: 'done', finishedAt: Date.now(), variation: body.from || null,
        prompt: String(body.title || 'Правка в редакторе'), rawPrompt: '', params: {},
        images: [{ index: 0, finalPrompt: '', seed: 0, file: null, error: null, liked: false }],
      });
      job.images[0].file = saveImage(`${job.id}_0`, buf);
      gallery.unshift(job);
      saveGallery();
      return send(res, 200, job);
    }

    if (p === '/api/styles' && req.method === 'GET') return send(res, 200, myStyles);
    if (p === '/api/styles' && req.method === 'POST') {
      const body = await readBody(req);
      const items = styleBuffers(body.items);
      if (!items.length) return send(res, 400, { error: 'Добавьте хотя бы одну картинку стиля' });
      const id = newId();
      const st = {
        id, name: String(body.name || 'Мой стиль').slice(0, 60), createdAt: Date.now(),
        files: items.map((it, i) => saveImage(`style_${id}_${i}`, it.buf)),
        weights: items.map((it) => it.w),
      };
      myStyles.unshift(st);
      saveStyles();
      return send(res, 200, st);
    }
    let m;
    if ((m = /^\/api\/styles\/([\w-]+)$/.exec(p)) && req.method === 'DELETE') {
      const st = myStyles.find((x) => x.id === m[1]);
      if (!st) return send(res, 404, { error: 'Не найдено' });
      myStyles = myStyles.filter((x) => x !== st);
      saveStyles();
      for (const f of st.files) fs.rm(path.join(IMAGES, f), () => {});
      return send(res, 200, { ok: true });
    }
    if ((m = /^\/api\/jobs\/([\w-]+)\/cancel$/.exec(p)) && req.method === 'POST') {
      const job = active.get(m[1]);
      if (!job) return send(res, 200, { ok: true });
      job.cancelled = true;
      if (running === job) await comfy.interrupt();
      return send(res, 200, { ok: true });
    }
    if ((m = /^\/api\/jobs\/([\w-]+)$/.exec(p))) {
      const job = findJob(m[1]);
      if (!job) return send(res, 404, { error: 'Не найдено' });
      if (req.method === 'GET') return send(res, 200, job);
      if (req.method === 'DELETE') {
        if (active.has(job.id)) return send(res, 409, { error: 'Ещё рисуется' });
        gallery = gallery.filter((j) => j.id !== job.id);
        for (const f of jobFiles(job)) if (!fileInUse(f)) fs.rm(path.join(IMAGES, f), () => {});
        saveGallery();
        return send(res, 200, { ok: true });
      }
    }
    if ((m = /^\/api\/jobs\/([\w-]+)\/(\d+)\/(like|delete)$/.exec(p)) && req.method === 'POST') {
      const job = gallery.find((j) => j.id === m[1]);
      const img = job?.images[+m[2]];
      if (!img) return send(res, 404, { error: 'Не найдено' });
      if (m[3] === 'like') img.liked = !img.liked;
      else {
        const f = img.file;
        img.file = null;
        img.deleted = true;
        if (job.images.every((i) => !i.file)) {
          gallery = gallery.filter((j) => j.id !== job.id);
          for (const s of job.sources || []) if (!fileInUse(s)) fs.rm(path.join(IMAGES, s), () => {});
        }
        if (f && !fileInUse(f)) fs.rm(path.join(IMAGES, f), () => {});
      }
      saveGallery();
      return send(res, 200, { ok: true });
    }
    if (p.startsWith('/images/')) return serveFile(res, IMAGES, decodeURIComponent(p.slice(8)));
    if (p.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    return serveFile(res, PUBLIC, p === '/' ? 'index.html' : decodeURIComponent(p.slice(1)));
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: e.message });
  }
});

// Перезапуск после обновления: новый процесс сервера, старый завершается
function restartSelf() {
  restarting = true;
  setTimeout(() => {
    server.close();
    const { spawn } = require('child_process');
    spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true }).unref();
    process.exit(0);
  }, 500);
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { console.log('Arto уже запущен — открываю окно.'); process.exit(0); }
  throw e;
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Arto ${edition.title}:  http://localhost:${PORT}\n  Работы сохраняются в: ${IMAGES}\n`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { comfy.stop(); process.exit(0); });
process.on('exit', () => { if (!restarting) comfy.stop(); });
let restarting = false;
