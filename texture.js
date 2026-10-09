// Сохранение фактуры: ИИ-редактор перерисовывает всю картинку и «замыливает» мазок.
// Здесь мы берём из правки только реально изменённые участки, а всё остальное
// оставляем пикселями оригинала.
const sharp = require('sharp');

async function rgb(buf, W, H, blur) {
  let s = sharp(buf).removeAlpha().resize(W, H, { fit: 'fill' });
  if (blur) s = s.blur(blur);
  return s.raw().toBuffer();
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
  let mask = Buffer.alloc(W * H);
  for (let p = 0, i = 0; p < mask.length; p++, i += 3) {
    const d = Math.max(Math.abs(ob[i] - eb[i]), Math.abs(ob[i + 1] - eb[i + 1]), Math.abs(ob[i + 2] - eb[i + 2]));
    mask[p] = d > threshold ? 255 : 0;
  }
  const r = Math.max(W, H) / 1024;
  mask = await maskStep(mask, W, H, 4 * r, 90);   // убрать «шум» из отдельных точек
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
