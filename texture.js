// Сохранение фактуры: ИИ-редактор перерисовывает всю картинку и «замыливает» мазок.
// Здесь мы берём из правки только реально изменённые участки, а всё остальное
// оставляем пикселями оригинала.
const sharp = require('sharp');

async function rgb(buf, W, H, blur) {
  let s = sharp(buf).removeAlpha().resize(W, H, { fit: 'fill' });
  if (blur) s = s.blur(blur);
  return s.raw().toBuffer();
}

// «Узорчатость» места: |яркость − размытая яркость|, усреднённая по соседству (0..255)
const TEXTURE_CUT = 7;
async function detail(buf, W, H, r) {
  const g = await sharp(buf).removeAlpha().resize(W, H, { fit: 'fill' }).greyscale().raw().toBuffer();
  const gb = await sharp(g, { raw: { width: W, height: H, channels: 1 } }).blur(2.5 * r).extractChannel(0).raw().toBuffer();
  const d = Buffer.alloc(W * H);
  for (let i = 0; i < d.length; i++) d[i] = Math.min(255, Math.abs(g[i] - gb[i]) * 4);
  return sharp(d, { raw: { width: W, height: H, channels: 1 } }).blur(6 * r).extractChannel(0).raw().toBuffer();
}

// Минимум и максимум каждого канала в квадрате (2k+1)×(2k+1) — в два прохода (строки, затем столбцы)
function minMax(px, W, H, k) {
  const pass = (src, horiz, isMax) => {
    const dst = Buffer.alloc(src.length);
    const [n, m] = horiz ? [H, W] : [W, H]; // n линий длиной m
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < m; b++) {
        const from = Math.max(0, b - k), to = Math.min(m - 1, b + k);
        for (let c = 0; c < 3; c++) {
          let v = isMax ? 0 : 255;
          for (let t = from; t <= to; t++) {
            const s = src[((horiz ? a * W + t : t * W + a) * 3) + c];
            if (isMax ? s > v : s < v) v = s;
          }
          dst[((horiz ? a * W + b : b * W + a) * 3) + c] = v;
        }
      }
    }
    return dst;
  };
  return [pass(pass(px, true, false), false, false), pass(pass(px, true, true), false, true)];
}

// Порог по одному каналу (0..255) → маска изменений
async function maskStep(mask, W, H, blur, cut) {
  const b = await sharp(mask, { raw: { width: W, height: H, channels: 1 } }).blur(blur).extractChannel(0).raw().toBuffer();
  for (let i = 0; i < b.length; i++) b[i] = b[i] > cut ? 255 : 0;
  return b;
}

/**
 * @param orig   Buffer оригинала
 * @param edited Buffer результата ИИ
 * @returns { buf, mask (raw 1 канал), W, H, changed (доля 0..1) }
 */
async function preserveTexture(orig, edited, { threshold = 30 } = {}) {
  const { width: W, height: H } = await sharp(orig).metadata();
  // сравниваем слегка размытые версии — так мелкая разница в мазке не считается «изменением»
  const [ob, eb] = await Promise.all([rgb(orig, W, H, 2), rgb(edited, W, H, 2)]);
  const r = Math.max(W, H) / 1024;
  // фактура: насколько «узорчато» место (разница с размытой копией, усреднённая по соседству).
  // Нужна, когда цвет тот же, а рисунок другой: гладкая ткань ↔ узор, однотонная стена ↔ обои
  const [od, ed] = await Promise.all([detail(orig, W, H, r), detail(edited, W, H, r)]);
  // ИИ чуть сдвигает и перерисовывает линии (на 1–3 px) — для штриха это не изменение.
  // Точка «не менялась», если такой же цвет есть рядом в другой картинке (в обе стороны)
  const k = Math.max(1, Math.round(3 * r));
  const [oLo, oHi] = minMax(ob, W, H, k), [eLo, eHi] = minMax(eb, W, H, k);
  const out1 = (v, lo, hi) => (v < lo ? lo - v : v > hi ? v - hi : 0);
  let mask = Buffer.alloc(W * H);
  for (let p = 0, i = 0; p < mask.length; p++, i += 3) {
    let d = 0;
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.max(out1(eb[i + c], oLo[i + c], oHi[i + c]), out1(ob[i + c], eLo[i + c], eHi[i + c])));
    // фактура меняется «в разы» (гладко ↔ узор), а не чуть-чуть, как у перерисованных ИИ линий того же рисунка
    const t = Math.abs(od[p] - ed[p]);
    mask[p] = d > threshold || (t > TEXTURE_CUT && t > 0.6 * Math.max(od[p], ed[p])) ? 255 : 0;
  }
  mask = await maskStep(mask, W, H, 4 * r, 90);   // убрать «шум» из отдельных точек
  // закрыть «дыры»: островки «без изменений» внутри изменённого места — это совпавший цвет, а не настоящий оригинал
  mask = await maskStep(mask, W, H, 24 * r, 25);
  mask = await maskStep(mask, W, H, 24 * r, 230);
  mask = await maskStep(mask, W, H, 14 * r, 12);  // расширить, чтобы захватить края изменений
  const soft = await sharp(mask, { raw: { width: W, height: H, channels: 1 } }).blur(10 * r).extractChannel(0).raw().toBuffer();

  let changedPx = 0;
  for (let p = 0; p < mask.length; p++) if (mask[p]) changedPx++;
  const changed = changedPx / mask.length;

  const [o, e] = await Promise.all([rgb(orig, W, H, 0), rgb(edited, W, H, 0)]);
  const out = Buffer.alloc(o.length);
  for (let p = 0, i = 0; p < soft.length; p++, i += 3) {
    const a = soft[p] / 255;
    out[i] = o[i] * (1 - a) + e[i] * a;
    out[i + 1] = o[i + 1] * (1 - a) + e[i + 1] * a;
    out[i + 2] = o[i + 2] * (1 - a) + e[i + 2] * a;
  }
  const buf = await sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  return { buf, mask: soft, W, H, changed };
}

// Вклеить «patch» поверх «base» по мягкой маске (оба приводятся к W×H)
async function blendByMask(base, patch, mask, W, H) {
  const [b, q] = await Promise.all([rgb(base, W, H, 0), rgb(patch, W, H, 0)]);
  const out = Buffer.alloc(b.length);
  for (let p = 0, i = 0; p < mask.length; p++, i += 3) {
    const a = mask[p] / 255;
    out[i] = b[i] * (1 - a) + q[i] * a;
    out[i + 1] = b[i + 1] * (1 - a) + q[i + 1] * a;
    out[i + 2] = b[i + 2] * (1 - a) + q[i + 2] * a;
  }
  return sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
}

module.exports = { preserveTexture, blendByMask };
