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

const { STYLES, GUARDS, buildPrompts, parseInlineParams, dimsFor } = require('./prompt');
const { Comfy, wfGenerate, wfUpscale, wfEdit, wfOutpaint, wfOutpaintUnion, wfTrainLora } = require('./comfy');
const { toEnglish, preload: preloadTranslator } = require('./translate');
// библиотека картинок нужна только для сохранения фактуры — если её нет, остальное работает
const texture = () => require('./texture');
const facefix = () => require('./facefix');

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
  if (Array.isArray(name)) {
    for (const n of name) { try { return await model(folder, n); } catch {} }
    throw new Error(`Не найдена модель «${name[0]}». Запустите install.bat — он докачает только недостающие модели, работы сохранятся.`);
  }
  const key = folder + '|' + name;
  if (!modelCache[key]) {
    const found = await comfy.resolve(folder, name);
    if (!found) throw new Error(`Не найдена модель «${name}». Запустите install.bat — он докачает только недостающие модели, работы сохранятся.`);
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
const avgSec = { imagine: 6, variation: 6, upscale: 3, edit: 40, outpaint: 10, train: 1500 };

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
          // двигатель ещё запускается — подождать (до 5 минут), а не падать с ошибкой
          if (comfy.status === 'starting') img.progress = { stage: 'starting', pct: 0, eta: null };
          for (let t = 0; comfy.status === 'starting' && t < 300 && !job.cancelled; t++) await new Promise((r) => setTimeout(r, 1000));
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
// Набросок: тёмные линии на светлой бумаге → светлые линии на тёмном (так ждёт ControlNet), плюс контраст
async function prepareSketch(buf) {
  const sharp = require('sharp');
  return sharp(buf).flatten({ background: '#ffffff' }).grayscale().normalize().negate().linear(1.6, -60).png().toBuffer();
}

async function createImagine({ prompt, params, ref, variation, styles = [], control = null }) {
  const inline = parseInlineParams(prompt);
  const p = { ...params, ...inline.params };
  const count = Math.max(1, Math.min(32, Math.round(+p.count) || 4));
  const seed = p.seed !== '' && p.seed != null && Number.isFinite(+p.seed) ? +p.seed : Math.floor(Math.random() * 2 ** 31);
  const subjectEn = await toEnglish(inline.text);
  const noEn = await toEnglish(p.no);
  const mlEntry = p.myLora && myLoras.find((x) => x.id === p.myLora.id);
  // своя манера сама задаёт технику, свет и фактуру: «эстетический слой» и техника Arto её забивают (проверено)
  if (mlEntry) styles = [];
  const built = buildPrompts({ subject: (mlEntry ? mlEntry.trigger + ' style artwork, ' : '') + subjectEn, style: mlEntry ? 'raw' : p.style, stylize: mlEntry ? 0 : +p.stylize, chaos: mlEntry ? 0 : +p.chaos, weird: mlEntry ? 0 : +p.weird, no: noEn, seed, count, guards: p.guards });
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
    mannerName: mlEntry ? mlEntry.name : undefined,
    styleFiles: [],
    negative: built.negative,
    images: built.prompts.map((fp, i) => ({ index: i, finalPrompt: fp, seed: seed + i, file: null, error: null, liked: false })),
  });
  if (refBuf && !variation) job.sources = [saveImage(`${job.id}_src0`, refBuf)];
  job.styleFiles = styles.slice(0, 3).map((st, i) => saveImage(`${job.id}_style${i}`, st.buf));
  if (control?.buf && edition.control) {
    job.control = {
      file: saveImage(`${job.id}_control`, control.buf),
      mode: control.mode === 'photo' ? 'photo' : 'sketch',
      strength: Math.max(0.1, Math.min(1.5, +control.strength || 0.8)),
    };
  }
  job.styleWeights = styles.slice(0, 3).map((st) => st.w);
  const sw0 = Number.isFinite(+p.sw) ? Math.max(0, Math.min(2, +p.sw)) : 1;
  // ползунок 0…2 → реальная сила: выше ~1.2 стиль с картинок начинает тащить содержимое образца и «перемазывать» технику (проверено)
  const sw = sw0 * (edition.styleRef?.weightScale ?? 1);

  let refName = null;
  let styleNames = null;
  let controlName = null;
  return startJob(job, async (img, prog) => {
    if (refBuf && !refName) refName = await comfy.upload(refBuf, `${job.id}_ref.${sniffExt(refBuf)}`);
    if (job.styleFiles.length && !styleNames) {
      styleNames = await Promise.all(job.styleFiles.map((f) => comfy.upload(fs.readFileSync(path.join(IMAGES, f)), f)));
    }
    if (job.control && !controlName) {
      const raw = fs.readFileSync(path.join(IMAGES, job.control.file));
      const buf = job.control.mode === 'sketch' ? await prepareSketch(raw) : raw;
      controlName = await comfy.upload(buf, `${job.id}_cn.png`);
    }
    const cc = edition.control;
    const control = job.control && controlName ? {
      image: controlName, mode: job.control.mode, strength: job.control.strength,
      end: job.control.mode === 'photo' ? 0.75 : 0.85,
      union: !!cc.union,
      model: await model('controlnet', cc.union || (job.control.mode === 'photo' ? cc.photo : cc.sketch)),
    } : null;
    const sr = edition.styleRef;
    // endAt — доля шагов; при рисовании от картинки (denoise < 1) шаги начинаются не с нуля — пересчитать
    const d = refName ? denoise : 1;
    const style = styleNames && sr ? { ...sr, endAt: sr.endAt != null ? (1 - d) + d * sr.endAt : undefined, ipadapter: await model('ipadapter', sr.ipadapter), clipVision: await model('clip_vision', sr.clipVision) } : null;
    const ml = p.myLora && myLoras.find((x) => x.id === p.myLora.id);
    const loras = ml ? [{ name: await model('loras', ml.file), strength: Math.max(0, Math.min(1.5, +p.myLora.w || 0.8)) }] : [];
    const out = await comfy.run(wfGenerate({
      ckpt: await model('checkpoints', g.ckpt), loras,
      prompt: img.finalPrompt, negative: built.negative, width, height, seed: img.seed,
      steps: g.steps, cfg: g.cfg, sampler: g.sampler, scheduler: g.scheduler,
      refImage: refName, denoise,
      styleRefs: styleNames, styleWeights: job.styleWeights, style, styleWeight: sw, control,
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

// Запустить ИИ-редактор на загруженных картинках. Pro — Qwen-Image-Edit, Lite — FLUX.2 klein.
// Понятная модели инструкция: английский + «остальное не трогай»; варианты отличаются силой изменения
const VARIETY = ['', ' Make the change clearly visible.', ' Keep the change subtle and natural.', ' Make the change bold and expressive.'];
async function editInstruction(text, variant = 0) {
  if (text === FIX_INSTRUCTION) return text;
  let en = (await toEnglish(text)).trim().replace(/[.!\s]+$/, '');
  if (!en) en = text;
  return `Edit the image: ${en}. Keep everything that is not mentioned unchanged.${VARIETY[variant % VARIETY.length]}`;
}

async function runEdit({ names, firstBuf, instruction, seed, prog, inpaint = null }) {
  const e = edition.edit;
  const opts = {
    images: names, instruction, seed, inpaint,
    edit: {
      ...e,
      unet: await model('diffusion_models', e.unet),
      clip: await model('text_encoders', e.clip),
      vae: await model('vae', e.vae),
      lora: e.lora ? await model('loras', e.lora) : null,
    },
  };
  if (e.kind === 'flux2') {
    // klein понимает в основном английский; размер — ~1 Мп с пропорциями исходника, кратно 16
    const [w0, h0] = (firstBuf && pngSize(firstBuf)) || [1024, 1024];
    const k = Math.sqrt(((e.megapixels || 1) * 1024 * 1024) / (w0 * h0));
    opts.width = Math.max(256, Math.round((w0 * k) / 16) * 16);
    opts.height = Math.max(256, Math.round((h0 * k) / 16) * 16);
  }
  return comfy.run(wfEdit(opts), { onProgress: prog });
}

const FIX_INSTRUCTION = 'Fix only anatomical mistakes that are already visible (malformed hands or fingers, wrong proportions, distorted face) and remove glitches and artifacts. Do not add, remove or move any objects, people or body parts. Keep the composition, pose, framing, colors, lighting and painting style exactly the same.';

// Увеличение ×2: simple — просто увеличить; art — дорисовать детали на большом размере; fix — исправить анатомию и дефекты, затем увеличить
function createUpscale(src, index, mode = 'simple') {
  if (mode === 'fix' && !edition.edit) throw new Error('ИИ-редактор не настроен. Запустите install.bat ещё раз.');
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
      const name = await comfy.upload(buf, `${job.id}_fix.${sniffExt(buf)}`);
      const fixed = await runEdit({ names: [name], firstBuf: buf, instruction: FIX_INSTRUCTION, seed: s.seed || 1, prog });
      buf = await keepTexture(buf, fixed, { retexture: true, prompt: s.finalPrompt || src.prompt, negative: src.negative, seed: s.seed || 1, maxChange: 0.35 });
    }

    const name = await comfy.upload(buf, `${job.id}_in.${sniffExt(buf)}`);
    const up = await comfy.run(wfUpscale({ image: name, model: upModel }), { onProgress: mode === 'simple' ? prog : undefined });
    // лица — отдельно и крупно: так исправляются кривые глаза, асимметрия, «поплывшие» черты
    if (mode === 'fix') return fixFaces(up, { src, s, prog, findOn: buf });
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

// ---------- раскрыть кадр ----------
// mode: wide | tall | all | ar (тогда ar = '16:9' и т.п.); amount — на сколько расширить (0.25…0.6)
function createOutpaint(src, index, { mode = 'wide', amount = 0.4, ar = null } = {}) {
  const s = src.images[index];
  const orig = fs.readFileSync(path.join(IMAGES, s.file));
  const [W0, H0] = pngSize(orig) || [src.params.width || 1024, src.params.height || 1024];
  const g = edition.generate;
  // размеры холста после расширения (в пикселях оригинала)
  let L = 0, T = 0, Rr = 0, B = 0;
  const a = Math.max(0.15, Math.min(0.8, +amount || 0.4));
  if (mode === 'wide') L = Rr = (W0 * a) / 2;
  else if (mode === 'tall') T = B = (H0 * a) / 2;
  else if (mode === 'all') { L = Rr = (W0 * a) / 2; T = B = (H0 * a) / 2; }
  else if (mode === 'ar' && ar) {
    const [x, y] = String(ar).split(':').map(Number);
    const r = x / y;
    if (r > W0 / H0) L = Rr = (H0 * r - W0) / 2; else T = B = (W0 / r - H0) / 2;
  }
  // держим общий размер в разумных пределах для модели: ~1.3 базовой площади
  const total = (W0 + L + Rr) * (H0 + T + B);
  const k = Math.min(1, Math.sqrt(((g.base * 1.3) ** 2) / total));
  const r8 = (v) => Math.max(0, Math.round((v * k) / 8) * 8);
  const w = r8(W0), h = r8(H0), left = r8(L), right = r8(Rr), top = r8(T), bottom = r8(B);
  if (!left && !right && !top && !bottom) throw new Error('Картинка уже в этом формате');
  const job = baseJob('outpaint', {
    variation: { jobId: src.id, index, mode },
    prompt: src.prompt, rawPrompt: src.rawPrompt, params: { ...src.params, width: w + left + right, height: h + top + bottom, outMode: mode, outAr: ar },
    negative: src.negative, before: s.file,
    images: [0, 1].map((i) => ({ index: i, finalPrompt: s.finalPrompt, seed: (s.seed || 1) + 101 + i, file: null, error: null, liked: false })),
  });
  const sharp = require('sharp');
  const Wt = w + left + right, Ht = h + top + bottom;
  const feather = Math.round(Math.min(w, h) * 0.1); // ширина мягкого перехода внутрь оригинала
  // маска: 255 — поле (рисовать), внутри оригинала у края — плавный спуск к 0
  const mask = Buffer.alloc(Wt * Ht);
  for (let y = 0; y < Ht; y++) for (let x = 0; x < Wt; x++) {
    const ix = x - left, iy = y - top;
    let v = 255;
    if (ix >= 0 && iy >= 0 && ix < w && iy < h) {
      const d = Math.min(left ? ix : 1e9, right ? w - 1 - ix : 1e9, top ? iy : 1e9, bottom ? h - 1 - iy : 1e9);
      v = d >= feather ? 0 : Math.round(255 * (1 - d / feather));
    }
    mask[y * Wt + x] = v;
  }
  let names = null;
  let base = null;
  return startJob(job, async (img, prog) => {
    if (!names) {
      const inner = await sharp(orig).removeAlpha().resize(w, h, { fit: 'fill' }).toBuffer();
      // зеркально продолжить края и размыть их — модель видит цвета и фон, но не копирует детали
      const ext = await sharp(inner).extend({ top, bottom, left, right, extendWith: 'copy' }).blur(45).toBuffer();
      base = await sharp(ext).composite([{ input: inner, left, top }]).png().toBuffer();
      const maskPng = await sharp(mask, { raw: { width: Wt, height: Ht, channels: 1 } }).toColourspace('srgb').png().toBuffer();
      names = [await comfy.upload(base, `${job.id}_base.png`), await comfy.upload(maskPng, `${job.id}_mask.png`)];
    }
    // основной способ — ИИ-редактор: он видит всю картинку и продолжает сцену без швов
    const sides = [left || right ? 'left and right' : '', top || bottom ? 'top and bottom' : ''].filter(Boolean).join(' and ');
    // нет модели ControlNet Union (не докачана) — тихо переходим к ИИ-редактору
    const cu = edition.control?.union ? await model('controlnet', edition.control.union).catch(() => null) : null;
    if (!names[2] && cu) {
      // для ControlNet repaint: оригинал на чёрном поле + жёсткая маска полей
      const inner2 = await sharp(orig).removeAlpha().resize(w, h, { fit: 'fill' }).toBuffer();
      const black = await sharp(inner2).extend({ top, bottom, left, right, background: '#000000' }).png().toBuffer();
      const hard = Buffer.alloc(Wt * Ht, 255);
      for (let y = top; y < top + h; y++) hard.fill(0, y * Wt + left, y * Wt + left + w);
      const hardPng = await sharp(hard, { raw: { width: Wt, height: Ht, channels: 1 } }).toColourspace('srgb').png().toBuffer();
      names[2] = await comfy.upload(black, `${job.id}_cn.png`);
      names[3] = await comfy.upload(hardPng, `${job.id}_hard.png`);
    }
    const out = cu
      // лучший способ: та же модель-художник + ControlNet Union «repaint» — стиль совпадает, сцена продолжается
      ? await comfy.run(wfOutpaintUnion({
        ckpt: await model('checkpoints', g.ckpt), union: cu,
        cnImage: names[2], image: names[0], mask: names[3],
        prompt: (s.finalPrompt || src.prompt || '') + ', wide view, the scene continues naturally beyond the frame',
        negative: [src.negative, 'frame, border, seam, split image, collage, blank area, blurry'].filter(Boolean).join(', '),
        seed: img.seed, steps: Math.max(12, g.steps + 4), cfg: g.cfg, sampler: g.sampler, scheduler: g.scheduler,
      }), { onProgress: prog })
      : edition.edit?.kind === 'flux2'
      // Lite: klein смотрит на оригинал и рисует только поля по маске — середина не меняется
      ? await runEdit({
        names: [names[4] || (names[4] = await comfy.upload(await sharp(orig).removeAlpha().png().toBuffer(), `${job.id}_orig.png`))],
        firstBuf: base, seed: img.seed, prog, inpaint: { image: names[0], mask: names[1] },
        instruction: (img.index % 2 === 0
          ? 'A wider view of the same picture: continue the existing background, surface and lighting beyond the frame, no new objects. '
          : 'A wider view of the same picture: the scene naturally continues beyond the frame with new fitting details. ')
          + 'Painted in exactly the same art style, technique, colors and paper as the reference. ' + (s.finalPrompt || src.prompt || ''),
      })
      : edition.edit
      ? await runEdit({
        names: [names[0]], firstBuf: base, seed: img.seed, prog,
        instruction: img.index % 2 === 0
          // вариант «спокойно»: продолжить фон и фактуру, ничего не добавлять
          ? `The ${sides} margins of this image are plain blurred color. Repaint them by seamlessly continuing the existing background, texture, surface and lighting of the picture, matching its colors and art technique exactly. Add no new objects. Do not leave any blur. Keep the sharp center image exactly as it is.`
          // вариант «с деталями»: придумать, что за краем кадра
          : `The ${sides} margins of this image are plain blurred color. Replace them with new sharp, detailed content that naturally continues the scene beyond the original frame, painted in exactly the same art style and technique as the center. Do not leave any blur. Keep the sharp center image exactly as it is.`,
      })
      // запасной способ, если ИИ-редактор не настроен — модель-художник дорисовывает поля по маске
      : await comfy.run(wfOutpaint({
        ckpt: await model('checkpoints', g.ckpt), image: names[0], mask: names[1],
        prompt: (s.finalPrompt || src.prompt || '') + ', seamless continuation of the scene, same style and lighting',
        negative: [src.negative, 'frame, border, seam, split image, collage, blank area'].filter(Boolean).join(', '),
        seed: img.seed, steps: Math.max(10, g.steps + 4), cfg: g.cfg, sampler: g.sampler, scheduler: g.scheduler,
      }), { onProgress: prog });
    // оригинал — поверх, с той же мягкой маской: в центре пиксель в пиксель, у краёв — плавно
    try { return await texture().blendByMask(base, out, mask, Wt, Ht); } catch (e) { logError('Раскрыть кадр: вклейка', e); return out; }
  });
}

// ---------- лица: найти, перерисовать крупно той же моделью-художником, вклеить с мягким краем ----------
// (как ADetailer / FaceDetailer: на маленьком лице модели не хватает пикселей, поэтому глаза и черты «плывут»)
async function fixFaces(buf, { src, s, prog, findOn = null }) {
  const sharp = require('sharp');
  let faces;
  const { width: W, height: H } = await sharp(buf).metadata();
  try {
    await facefix().ensure();
    // искать лучше на исходной картинке (до увеличения лица чётче), координаты — пересчитать
    const k = findOn ? W / (await sharp(findOn).metadata()).width : 1;
    faces = (await facefix().detect(findOn || buf)).map((f) => ({ x: f.x * k, y: f.y * k, w: f.w * k, h: f.h * k, score: f.score }));
  } catch (e) { logError('Поиск лиц', e); return buf; }
  // только явные, прорисованные лица: размытое лицо в свободной манере (уверенность ниже) — замысел художника, не трогаем
  faces = faces.filter((f) => f.score >= 0.8 && Math.max(f.w, f.h) >= Math.min(W, H) * 0.03).slice(0, 4);
  if (!faces.length) return buf;
  const g = edition.generate;
  const ml = src.params?.myLora && myLoras.find((x) => x.id === src.params.myLora.id);
  const loras = ml ? [{ name: await model('loras', ml.file), strength: Math.max(0, Math.min(1.5, +src.params.myLora.w || 0.8)) }] : [];
  const ckpt = await model('checkpoints', g.ckpt);
  for (let i = 0; i < faces.length; i++) {
    const box = facefix().cropBox(faces[i], W, H);
    const crop = await sharp(buf).extract({ left: box.x, top: box.y, width: box.side, height: box.side }).resize(g.base, g.base).png().toBuffer();
    const name = await comfy.upload(crop, `face_${Date.now()}_${i}.png`);
    const out = await comfy.run(wfGenerate({
      ckpt, loras,
      prompt: (s.finalPrompt || src.prompt || '') + ', symmetrical face, well-aligned eyes, natural facial proportions, same technique',
      negative: [src.negative, 'asymmetrical face, deformed face, crooked eyes, uneven eyes, cross-eyed, distorted features, malformed nose, blurry face'].filter(Boolean).join(', '),
      width: g.base, height: g.base, seed: (s.seed || 1) + i, steps: Math.max(10, g.steps + 4), cfg: g.cfg, sampler: g.sampler, scheduler: g.scheduler,
      refImage: name, denoise: 0.45,
    }), { onProgress: prog });
    buf = await facefix().paste(buf, out, box);
  }
  return buf;
}

// ---------- сохранение фактуры ----------
// ИИ-редактор перерисовывает всю картинку и сглаживает мазок. Берём из правки только изменённые места;
// при retexture — ещё и «перемазываем» их моделью-художником в манере оригинала (оригинал = образец стиля).
async function keepTexture(orig, edited, { retexture = false, prompt = '', negative = '', seed = 1, prog, maxChange = null } = {}) {
  let r;
  try { r = await texture().preserveTexture(orig, edited); } catch (e) { logError('Сохранение фактуры', e); return edited; }
  // правка, которая не должна менять стиль (исправление анатомии), перерисовала почти всё — отбрасываем её
  if (maxChange != null && r.changed > maxChange) return orig;
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
    style: st ? { ...sr, endAt: 1, ipadapter: await model('ipadapter', sr.ipadapter), clipVision: await model('clip_vision', sr.clipVision) } : null, // фактура — до последнего шага
  }), { onProgress: prog });
  return texture().blendByMask(r.buf, re, r.mask, r.W, r.H);
}

// Изменить по команде (аналог Nano Banana)
function createEdit({ instruction, sources, count, from, isTemp, preserve = true, quality = 'normal' }) {
  if (!edition.edit) throw new Error('ИИ-редактор не настроен. Запустите install.bat ещё раз.');
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
    const en = await editInstruction(instruction, img.index);
    img.finalPrompt = en; // «как ИИ понял запрос» — видно в подробностях
    const out = await runEdit({ names, firstBuf: sources[0], instruction: en, seed: img.seed, prog });
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
const jobFiles = (job) => [...job.images.map((i) => i.file), ...(job.sources || []), ...(job.styleFiles || []), job.before, job.control?.file].filter(Boolean);
const fileInUse = (file) => gallery.some((j) => jobFiles(j).includes(file)) || [...active.values()].some((j) => jobFiles(j).includes(file));

// Образцы стиля: data URI, картинка из ленты {jobId,index} или сохранённый стиль {styleId}
// элемент: { data: dataURI } | { jobId, index } | { file } (из «Моих стилей»), плюс w — влияние 0..2
function styleBuffers(list) {
  const out = [];
  for (const s of list || []) {
    const w = Number.isFinite(+s?.w) ? Math.max(0, Math.min(2, +s.w)) : 1;
    let buf = null;
    if (s?.data) buf = dataUriToBuffer(s.data);
    else if (s?.file && /^[\w.-]+$/.test(s.file)) buf = fs.existsSync(path.join(IMAGES, s.file)) ? fs.readFileSync(path.join(IMAGES, s.file)) : null;
    else if (s?.jobId != null) buf = imageBuf(s.jobId, s.index);
    if (buf) out.push({ buf, w });
  }
  return out.slice(0, 3);
}
// набросок из запроса: { data } | { jobId, index } | { file }, плюс mode и strength
function controlFrom(c) {
  if (!c) return null;
  const [buf] = styleBuffers([c]).map((x) => x.buf);
  return buf ? { buf, mode: c.mode, strength: c.strength } : null;
}
const jobControl = (job) => (job.control ? { buf: fs.readFileSync(path.join(IMAGES, job.control.file)), mode: job.control.mode, strength: job.control.strength } : null);
const jobStyles = (job) => (job.styleFiles || []).map((f, i) => ({ buf: fs.readFileSync(path.join(IMAGES, f)), w: job.styleWeights?.[i] ?? 1 }));

// ---------- «Мои стили» (аналог кодов --sref) ----------
const STYLES_FILE = path.join(DATA, 'styles.json');
let myStyles = readJSON(STYLES_FILE, []);
const saveStyles = () => fs.writeFileSync(STYLES_FILE, JSON.stringify(myStyles, null, 1));

// ---------- «Мои тюбики» (палитра мастерской) ----------
const MYPAINTS_FILE = path.join(DATA, 'mypaints.json');
let myPaints = readJSON(MYPAINTS_FILE, {});

// ---------- «моя манера»: обученные LoRA ----------
const LORAS_FILE = path.join(DATA, 'loras.json');
let myLoras = readJSON(LORAS_FILE, []);
const saveLoras = () => fs.writeFileSync(LORAS_FILE, JSON.stringify(myLoras, null, 1));

function createTrain({ name, sources, quality = 'normal' }) {
  const g = edition.generate;
  const id = newId();
  const slug = 'arto' + id.slice(-6);           // слово-ключ манеры в промпте
  const size = Math.min(768, g.base);           // учим на 768 px (Pro) / 576 px (Lite) — для манеры хватает, и помещается в видеопамять
  const n = sources.length;
  // ~2–3 с на шаг на видеокарте уровня RTX 4080: быстро 15–25 мин, качественно 25–50 мин
  const steps = quality === 'fast' ? Math.min(600, Math.max(300, n * 20)) : Math.min(1200, Math.max(600, n * 40));
  const job = baseJob('train', {
    prompt: 'Обучение стиля «' + name + '»', rawPrompt: '', params: { steps, count: 1, width: size, height: size },
    images: [{ index: 0, finalPrompt: '', seed: 1, file: null, error: null, liked: false }],
    trainName: name,
  });
  job.sources = sources.slice(0, 8).map((buf, i) => saveImage(`${job.id}_src${i}`, buf));
  return startJob(job, async (img, prog) => {
    const sharp = require('sharp');
    const folder = 'arto_train_' + id;
    // 1) подготовить картинки: квадрат по центру нужного размера
    for (let i = 0; i < sources.length; i++) {
      const buf = await sharp(sources[i]).removeAlpha().resize(size, size, { fit: 'cover', position: 'attention' }).png().toBuffer();
      await comfy.upload(buf, `${String(i).padStart(3, '0')}.png`, folder);
    }
    // 2) обучение: сначала выгрузить из видеокарты всё лишнее (например, ИИ-редактор)
    await comfy.free();
    const prefix = `loras/arto/${slug}`;
    await comfy.run(wfTrainLora({
      ckpt: await model('checkpoints', g.ckpt), folder, caption: `${slug} style artwork`, steps, seed: 7, prefix,
    }), { onProgress: prog, timeoutMs: 4 * 3600 * 1000, expectImage: false });
    // 3) перенести файл LoRA из output ComfyUI в его папку моделей
    const outDir = path.join(config.comfy.path, 'ComfyUI', 'output', 'loras', 'arto');
    const made = fs.readdirSync(outDir).filter((f) => f.startsWith(slug)).sort().pop();
    if (!made) throw new Error('Обучение завершилось, но файл стиля не найден');
    const dstDir = path.join(config.comfy.path, 'ComfyUI', 'models', 'loras', 'arto');
    fs.mkdirSync(dstDir, { recursive: true });
    const file = slug + '.safetensors';
    fs.copyFileSync(path.join(outDir, made), path.join(dstDir, file));
    const entry = { id, name, file, trigger: slug, images: n, steps, createdAt: Date.now(), edition: edition.id };
    myLoras.unshift(entry);
    saveLoras();
    modelCache['loras|' + file] = undefined;
    // 4) пробная картинка в новой манере
    return comfy.run(wfGenerate({
      ckpt: await model('checkpoints', g.ckpt), loras: [{ name: await model('loras', file), strength: 1 }],
      prompt: `${slug} style artwork, a quiet still life with a vase and fruit on a table`, negative: '',
      width: size, height: size, seed: 11, steps: g.steps, cfg: g.cfg, sampler: g.sampler, scheduler: g.scheduler,
    }));
  });
}

// ---------- доски настроения ----------
const BOARDS_FILE = path.join(DATA, 'boards.json');
let boards = readJSON(BOARDS_FILE, []);
const saveBoards = () => fs.writeFileSync(BOARDS_FILE, JSON.stringify(boards, null, 1));

// ---------- «Мои промпты» ----------
const PROMPTS_FILE = path.join(DATA, 'prompts.json');
let myPrompts = readJSON(PROMPTS_FILE, []);
const savePrompts = () => fs.writeFileSync(PROMPTS_FILE, JSON.stringify(myPrompts, null, 1));

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
        guards: GUARDS.map(({ id, name, hint }) => ({ id, name, hint })),
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
      return send(res, 200, await createImagine({ prompt: String(body.prompt), params: body.params || {}, ref: body.ref || null, styles: styleBuffers(body.styles), control: controlFrom(body.control) }));
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
        prompt: src.prompt, params: { ...src.params, seed: '', count: 4 }, ref: buf, styles: jobStyles(src), control: jobControl(src),
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
      return send(res, 200, await createImagine({ prompt: src.rawPrompt || src.prompt, params: { ...src.params, seed: '' }, styles: jobStyles(src), control: jobControl(src) }));
    }
    if (p === '/api/upscale' && req.method === 'POST') {
      const { jobId, index, mode } = await readBody(req);
      const src = findJob(jobId);
      if (!src?.images[index]?.file) return send(res, 404, { error: 'Изображение не найдено' });
      return send(res, 200, createUpscale(src, index, ['simple', 'art', 'fix'].includes(mode) ? mode : 'simple'));
    }
    if (p === '/api/outpaint' && req.method === 'POST') {
      const { jobId, index, mode, amount, ar } = await readBody(req);
      const src = findJob(jobId);
      if (!src?.images[index]?.file) return send(res, 404, { error: 'Изображение не найдено' });
      return send(res, 200, createOutpaint(src, index, { mode, amount, ar }));
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

    if (p === '/api/loras' && req.method === 'GET') return send(res, 200, myLoras.filter((x) => !x.edition || x.edition === edition.id));
    if (p === '/api/train' && req.method === 'POST') {
      const body = await readBody(req, 300 * 1024 * 1024);
      let bufs = [];
      if (body.boardId) {
        const b = boards.find((x) => x.id === body.boardId);
        bufs = (b?.items || []).map((it) => fs.readFileSync(path.join(IMAGES, it.file)));
      } else bufs = (body.images || []).map(dataUriToBuffer).filter(Boolean);
      if (bufs.length < 5) return send(res, 400, { error: 'Нужно хотя бы 5 картинок (лучше 15–30)' });
      return send(res, 200, createTrain({ name: String(body.name || 'Мой стиль').slice(0, 50), sources: bufs.slice(0, 60), quality: body.quality }));
    }
    const lm = /^\/api\/loras\/([\w-]+)$/.exec(p);
    if (lm && req.method === 'DELETE') {
      const e = myLoras.find((x) => x.id === lm[1]);
      if (!e) return send(res, 404, { error: 'Не найдено' });
      myLoras = myLoras.filter((x) => x !== e);
      saveLoras();
      try { fs.rmSync(path.join(config.comfy.path, 'ComfyUI', 'models', 'loras', 'arto', e.file), { force: true }); } catch {}
      return send(res, 200, { ok: true });
    }
    if (p === '/api/boards' && req.method === 'GET') return send(res, 200, boards);
    if (p === '/api/boards' && req.method === 'POST') {
      const body = await readBody(req);
      const b = { id: newId(), name: String(body.name || 'Новая доска').slice(0, 60), createdAt: Date.now(), items: [] };
      boards.unshift(b);
      saveBoards();
      return send(res, 200, b);
    }
    const bm = /^\/api\/boards\/([\w-]+)(?:\/items(?:\/(\d+))?)?$/.exec(p);
    if (bm) {
      const b = boards.find((x) => x.id === bm[1]);
      if (!b) return send(res, 404, { error: 'Доска не найдена' });
      const isItems = p.includes('/items');
      if (!isItems && req.method === 'PATCH') { const body = await readBody(req); if (body.name) b.name = String(body.name).slice(0, 60); saveBoards(); return send(res, 200, b); }
      if (!isItems && req.method === 'DELETE') {
        boards = boards.filter((x) => x !== b);
        saveBoards();
        for (const it of b.items) fs.rm(path.join(IMAGES, it.file), () => {});
        return send(res, 200, { ok: true });
      }
      if (isItems && req.method === 'POST') {
        // своя копия картинки — доска не зависит от удаления работы в ленте
        const body = await readBody(req);
        const buf = body.jobId ? imageBuf(body.jobId, body.index) : dataUriToBuffer(body.data);
        if (!buf) return send(res, 400, { error: 'Картинка не найдена' });
        const it = { file: saveImage(`board_${b.id}_${newId()}`, buf), note: '', from: body.jobId ? { jobId: body.jobId, index: body.index } : null, prompt: body.jobId ? findJob(body.jobId)?.prompt || '' : '' };
        b.items.push(it);
        saveBoards();
        return send(res, 200, b);
      }
      if (isItems && bm[2] != null) {
        const it = b.items[+bm[2]];
        if (!it) return send(res, 404, { error: 'Не найдено' });
        if (req.method === 'PATCH') { const body = await readBody(req); it.note = String(body.note || '').slice(0, 500); saveBoards(); return send(res, 200, b); }
        if (req.method === 'DELETE') { b.items.splice(+bm[2], 1); saveBoards(); fs.rm(path.join(IMAGES, it.file), () => {}); return send(res, 200, b); }
      }
    }
    if (p === '/api/mypaints' && req.method === 'GET') return send(res, 200, myPaints);
    if (p === '/api/mypaints' && req.method === 'POST') {
      const body = await readBody(req);
      if (typeof body.series !== 'string' || !Array.isArray(body.nums)) return send(res, 400, { error: 'Неверные данные' });
      myPaints[body.series] = body.nums.map(String).slice(0, 500);
      fs.writeFileSync(MYPAINTS_FILE, JSON.stringify(myPaints));
      return send(res, 200, { ok: true });
    }
    // ---------- «Мои промпты»: только то, что художник сохранил сам ----------
    if (p === '/api/prompts' && req.method === 'GET') return send(res, 200, myPrompts);
    if (p === '/api/prompts' && req.method === 'POST') {
      const body = await readBody(req);
      const src = body.jobId ? findJob(body.jobId) : null;
      const text = String(body.prompt || src?.rawPrompt || src?.prompt || '').trim();
      if (!text) return send(res, 400, { error: 'Нет текста запроса' });
      const pr = {
        id: newId(), createdAt: Date.now(),
        title: String(body.title || '').trim().slice(0, 80) || text.slice(0, 40),
        prompt: text,
        kind: src?.type === 'edit' ? 'edit' : 'draw',
        params: src?.params ? (({ style, ar, quality, stylize, chaos, weird, no, count }) => ({ style, ar, quality, stylize, chaos, weird, no, count }))(src.params) : {},
        thumb: null,
      };
      // превью — своя маленькая копия, чтобы не пропала при удалении работы
      const img = src?.images?.find((i) => i.file);
      if (img) {
        try {
          const buf = await require('sharp')(path.join(IMAGES, img.file)).resize(320, 320, { fit: 'cover' }).jpeg({ quality: 82 }).toBuffer();
          pr.thumb = `prompt_${pr.id}.jpg`;
          fs.writeFileSync(path.join(IMAGES, pr.thumb), buf);
        } catch (e) { logError('Превью промпта', e); }
      }
      myPrompts.unshift(pr);
      savePrompts();
      return send(res, 200, pr);
    }
    const pm = /^\/api\/prompts\/([\w-]+)$/.exec(p);
    if (pm) {
      const pr = myPrompts.find((x) => x.id === pm[1]);
      if (!pr) return send(res, 404, { error: 'Не найдено' });
      if (req.method === 'PATCH') {
        const body = await readBody(req);
        if (typeof body.title === 'string') pr.title = body.title.trim().slice(0, 80) || pr.title;
        if (typeof body.prompt === 'string' && body.prompt.trim()) pr.prompt = body.prompt.trim();
        savePrompts();
        return send(res, 200, pr);
      }
      if (req.method === 'DELETE') {
        myPrompts = myPrompts.filter((x) => x !== pr);
        savePrompts();
        if (pr.thumb) fs.rm(path.join(IMAGES, pr.thumb), () => {});
        return send(res, 200, { ok: true });
      }
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
