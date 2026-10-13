// Поиск лиц на картинке (офлайн, маленькая модель YOLO в models/face) — для «Исправить и увеличить».
// Лицо вырезается с запасом, перерисовывается моделью-художником крупно и вклеивается обратно с мягким краем.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const MODEL = path.join(__dirname, 'models', 'face', 'face_detect_v0_s_yv11.onnx');
const SIZE = 640;
const THRESHOLD = 0.3;
let session = null;

const URL_MODEL = 'https://huggingface.co/deepghs/real_face_detection/resolve/main/face_detect_v0_s_yv11/model.onnx';

// Модель ставит install.bat; если её нет (обновились без переустановки) — один раз докачиваем (~38 МБ)
let fetching = null;
async function ensure() {
  if (fs.existsSync(MODEL)) return true;
  fetching = fetching || (async () => {
    const r = await fetch(URL_MODEL);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    fs.mkdirSync(path.dirname(MODEL), { recursive: true });
    fs.writeFileSync(MODEL + '.part', Buffer.from(await r.arrayBuffer()));
    fs.renameSync(MODEL + '.part', MODEL);
  })().catch((e) => { fetching = null; throw e; });
  await fetching;
  return true;
}

async function load() {
  if (!session) {
    const ort = require('onnxruntime-node');
    session = await ort.InferenceSession.create(MODEL);
  }
  return session;
}

const iou = (a, b) => {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a.w * a.h + b.w * b.h - inter);
};

// → [{ x, y, w, h, score }] в пикселях исходной картинки, крупные первыми
async function detect(buf) {
  const ort = require('onnxruntime-node');
  const s = await load();
  const { width: W, height: H } = await sharp(buf).metadata();
  // вписать в 640×640 с серыми полями (как при обучении YOLO)
  const k = Math.min(SIZE / W, SIZE / H);
  const w = Math.round(W * k), h = Math.round(H * k);
  const px = await sharp(buf).removeAlpha().resize(w, h)
    .extend({ top: 0, left: 0, right: SIZE - w, bottom: SIZE - h, background: '#727272' })
    .raw().toBuffer();
  const input = new Float32Array(3 * SIZE * SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) {
    input[i] = px[i * 3] / 255;
    input[SIZE * SIZE + i] = px[i * 3 + 1] / 255;
    input[2 * SIZE * SIZE + i] = px[i * 3 + 2] / 255;
  }
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, SIZE, SIZE]) });
  const t = out[s.outputNames[0]];
  const n = t.dims[2], d = t.data; // [1, 5, N]: cx, cy, w, h, уверенность
  let boxes = [];
  for (let i = 0; i < n; i++) {
    const score = d[4 * n + i];
    if (score < THRESHOLD) continue;
    const cx = d[i] / k, cy = d[n + i] / k, bw = d[2 * n + i] / k, bh = d[3 * n + i] / k;
    boxes.push({ x: cx - bw / 2, y: cy - bh / 2, w: bw, h: bh, score });
  }
  boxes.sort((a, b) => b.score - a.score);
  const keep = [];
  for (const b of boxes) if (keep.every((k2) => iou(k2, b) < 0.4)) keep.push(b);
  return keep.sort((a, b) => b.w * b.h - a.w * a.h);
}

// Область вокруг лица с запасом (лоб, волосы, подбородок) — квадрат, не выходящий за картинку
function cropBox(f, W, H, pad = 1.9) {
  const side = Math.min(Math.max(f.w, f.h) * pad, W, H);
  const cx = f.x + f.w / 2, cy = f.y + f.h / 2;
  const x = Math.round(Math.max(0, Math.min(W - side, cx - side / 2)));
  const y = Math.round(Math.max(0, Math.min(H - side, cy - side / 2)));
  return { x, y, side: Math.round(side) };
}

// Мягкая овальная маска размером side×side: в центре 255, к краям плавно 0
async function ovalMask(side) {
  const r = side / 2;
  const svg = `<svg width="${side}" height="${side}"><rect width="100%" height="100%" fill="black"/>
    <ellipse cx="${r}" cy="${r}" rx="${r * 0.72}" ry="${r * 0.8}" fill="white"/></svg>`;
  return sharp(Buffer.from(svg)).blur(Math.max(2, side * 0.06)).extractChannel(0).raw().toBuffer();
}

// Вклеить перерисованное лицо (patch — любой размер) в base по маске
async function paste(base, patch, box) {
  const { width: W, height: H } = await sharp(base).metadata();
  const { side } = box;
  const [p, m, b] = await Promise.all([
    sharp(patch).removeAlpha().resize(side, side).raw().toBuffer(),
    ovalMask(side),
    sharp(base).removeAlpha().raw().toBuffer(),
  ]);
  for (let yy = 0; yy < side; yy++) {
    for (let xx = 0; xx < side; xx++) {
      const a = m[yy * side + xx] / 255;
      if (!a) continue;
      const bi = ((box.y + yy) * W + box.x + xx) * 3, pi = (yy * side + xx) * 3;
      for (let c = 0; c < 3; c++) b[bi + c] = b[bi + c] * (1 - a) + p[pi + c] * a;
    }
  }
  return sharp(b, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
}

module.exports = { ensure, detect, cropBox, paste };
