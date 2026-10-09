// Построение промптов: стиль-пресеты эскизов + аналоги параметров Midjourney.
//   --ar 3:2      соотношение сторон
//   --s 0..1000   stylize: насколько сильно добавлять «художественность»
//   --c 0..100    chaos: насколько четыре варианта отличаются друг от друга
//   --w 0..3000   weird: необычность, сюрреалистичность
//   --no a, b     что исключить (негативный промпт)
//   --seed N      повторяемость
//   --style id    пресет стиля (graphite, charcoal, ink, ...)
//   --iw 0..2     вес референса (насколько держаться исходной картинки)

const STYLES = [
  { id: 'raw', name: 'Raw', hint: 'Без стиля — только ваш промпт', core: '' },
  { id: 'graphite', name: 'Графит', hint: 'Карандашный штудийный рисунок',
    core: 'graphite pencil sketch, expressive hatching and cross-hatching, visible construction lines, soft smudged tonal shading, on textured off-white drawing paper' },
  { id: 'charcoal', name: 'Уголь', hint: 'Мощный тональный рисунок углём',
    core: 'charcoal drawing, bold gestural strokes, deep velvety blacks, smudged edges and eraser highlights, raw energetic mark-making, on grainy paper' },
  { id: 'ink', name: 'Тушь и перо', hint: 'Линия, штрих, пятно туши',
    core: 'pen and ink drawing, confident calligraphic linework, ink wash and splatter, varied line weight, dynamic hatching, sumi ink on cream paper' },
  { id: 'sanguine', name: 'Сангина', hint: 'Красный мел на тонированной бумаге',
    core: 'sanguine red chalk drawing on toned paper, white chalk highlights, old master study, delicate contour lines, Renaissance sketchbook page' },
  { id: 'watercolor', name: 'Акварель', hint: 'Лёгкий акварельный эскиз',
    core: 'loose watercolor sketch, wet-on-wet blooms, transparent washes, pencil underdrawing showing through, granulating pigments, white of the paper left untouched' },
  { id: 'gouache', name: 'Гуашь', hint: 'Плотный этюд гуашью',
    core: 'gouache study, flat opaque color shapes, painterly brushwork, limited palette, simplified forms, matte finish, visible paper edges' },
  { id: 'oil', name: 'Масляный этюд', hint: 'Alla prima, пастозный мазок',
    core: 'alla prima oil sketch, thick impasto brushstrokes, palette knife marks, loose unfinished edges, plein air study, rich broken color' },
  { id: 'pastel', name: 'Пастель', hint: 'Сухая пастель, мягкие переходы',
    core: 'soft pastel drawing, chalky textured strokes, layered vibrant pigment, Degas-like mark-making, on colored pastel paper' },
  { id: 'concept', name: 'Концепт-арт', hint: 'Скетч концепт-художника',
    core: 'concept art sketch, loose painterly rendering, strong silhouette, atmospheric perspective, designer sketchbook, rough thumbnails energy' },
  { id: 'marker', name: 'Маркеры', hint: 'Дизайнерский маркерный скетч',
    core: 'alcohol marker rendering, fineliner contours, bold grey marker shading, quick industrial design sketch, crisp highlights with white gel pen' },
  { id: 'notan', name: 'Нотан / тон', hint: 'Тоновое пятно, 2–3 значения',
    core: 'notan value study, three-value composition, bold black white and mid grey shapes, abstracted masses, strong design of light and shadow' },
  { id: 'thumbnail', name: 'Миниатюры', hint: 'Лист композиционных набросков',
    core: 'sketchbook page of small composition thumbnails, quick tonal value sketches with framing boxes, artist notes, exploring layout variations' },
  { id: 'linocut', name: 'Линогравюра', hint: 'Графика печати, резкий контраст',
    core: 'linocut print, carved gouge marks, high contrast black and white, bold graphic shapes, hand-pulled printmaking texture' },
  { id: 'mixed', name: 'Смешанная техника', hint: 'Коллаж, слои, фактура',
    core: 'mixed media sketch, layered collage, graphite and acrylic, torn paper textures, scribbles and drips, experimental art journal page' },
];

// stylize — «эстетический слой» в духе Midjourney (накопительно).
// Признаки фирменного вида MJ: гармоничная ограниченная палитра, кинематографичный свет,
// атмосферная глубина, выразительная композиция с ясным центром внимания,
// проработанный фокус и свободные, «растворяющиеся» края, богатая фактура.
const STYLIZE_TIERS = [
  [25, 'artful composition with a clear focal point'],
  [75, 'harmonious limited color palette, atmospheric depth, beautiful soft light'],
  [100, 'detailed focal area dissolving into loose expressive edges, rich tactile texture, elegant negative space'],
  [200, 'expressive light and shadow, dramatic chiaroscuro, masterful draftsmanship, strong value design'],
  [350, 'evocative mood, poetic storytelling, painterly sophistication, sketchbook of a master artist'],
  [550, 'breathtaking artistic vision, museum-quality masterpiece, bold stylization, sublime atmosphere'],
  [800, 'highly stylized visionary interpretation, lyrical abstraction, dreamlike grandeur'],
];

// chaos: случайные модификаторы для каждого из вариантов
const CHAOS_POOLS = [
  ['dramatic low angle', 'bird\'s eye view', 'tight close-up crop', 'wide panoramic composition', 'asymmetric off-center composition', 'strong diagonal composition', 'figure small in vast space', 'frontal symmetric composition'],
  ['backlit silhouette', 'harsh side light', 'soft diffused light', 'rim light', 'moody twilight', 'single candle light', 'overcast flat light', 'golden hour glow'],
  ['melancholic mood', 'restless energy', 'quiet contemplation', 'tension and suspense', 'dreamy calm', 'joyful movement', 'solemn monumentality'],
  ['muted earth palette', 'monochrome sepia', 'cold blue greys', 'warm ochres and siennas', 'single accent of red', 'complementary orange and teal', 'desaturated greens'],
  ['very loose and fast', 'meticulous and precise', 'fragmented unfinished edges', 'rhythmic repeating strokes', 'heavy texture'],
];

const WEIRD_POOL = [
  'surreal dreamlike distortion', 'unexpected juxtaposition', 'impossible architecture', 'elongated mannerist proportions',
  'floating objects', 'eerie uncanny atmosphere', 'symbolist allegory', 'fragmented cubist planes', 'melting forms',
  'botanical growths emerging', 'mythological undertone', 'visionary esoteric symbolism', 'Escher-like paradox',
];

const DEFAULT_NEGATIVE = 'photo, photograph, photography, photorealistic, realistic, 3d render, frame, border, cgi, plastic, glossy, watermark, signature, text, logo, lowres, blurry, deformed';

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }

function buildPrompts({ subject, style = 'graphite', stylize = 100, chaos = 0, weird = 0, no = '', seed = 0, count = 4 }) {
  const st = STYLES.find((s) => s.id === style) || STYLES[0];
  // Техника — в начало и с повышенным весом: иначе модели скатываются в фото
  const [medium, ...details] = st.core.split(', ');
  const base = st.core ? [`(${medium}:1.3) of ${subject.trim()}`, details.join(', ')] : [subject.trim()];
  for (const [t, text] of STYLIZE_TIERS) if (stylize >= t) base.push(text);
  if (st.core) base.push('(hand-drawn traditional artwork:1.2)');

  const prompts = [];
  for (let i = 0; i < count; i++) {
    const rng = mulberry32(seed * 31 + i * 7919 + 1);
    const parts = [...base];
    const nChaos = Math.ceil((chaos / 100) * CHAOS_POOLS.length);
    const pools = [...CHAOS_POOLS].sort(() => rng() - 0.5).slice(0, nChaos);
    for (const pool of pools) if (rng() < 0.35 + chaos / 150) parts.push(pick(rng, pool));
    const nWeird = weird > 0 ? Math.min(4, Math.ceil(weird / 750)) : 0;
    const used = new Set();
    for (let k = 0; k < nWeird; k++) {
      const w = pick(rng, WEIRD_POOL);
      if (!used.has(w)) { used.add(w); parts.push(w); }
    }
    prompts.push(parts.filter(Boolean).join(', '));
  }

  const negative = [style === 'raw' ? '' : DEFAULT_NEGATIVE, no].filter((x) => x && x.trim()).join(', ');
  return { prompts, negative };
}

// Разбор параметров в стиле Midjourney прямо из текста промпта
const ALIASES = { aspect: 'ar', stylize: 's', chaos: 'c', weird: 'w', style: 'style', no: 'no', seed: 'seed', iw: 'iw' };
const KEYMAP = { ar: 'ar', s: 'stylize', c: 'chaos', w: 'weird', style: 'style', no: 'no', seed: 'seed', iw: 'iw' };

function parseInlineParams(raw) {
  const params = {};
  const idx = raw.search(/\s--\w/);
  const text = (idx === -1 ? raw : raw.slice(0, idx)).trim();
  if (idx !== -1) {
    const re = /--(\w+)\s*([^-][^]*?)?(?=\s--\w|$)/g;
    let m;
    while ((m = re.exec(raw.slice(idx)))) {
      let k = m[1].toLowerCase();
      k = ALIASES[k] || k;
      const key = KEYMAP[k];
      if (!key) continue;
      const v = (m[2] || '').trim();
      if (key === 'style' && v === 'raw') params.style = 'raw';
      else if (['stylize', 'chaos', 'weird', 'seed', 'iw'].includes(key)) { if (v !== '' && !isNaN(+v)) params[key] = +v; }
      else params[key] = v;
    }
  }
  return { text, params };
}

function parseRatio(ar) {
  const m = /^(\d+(?:\.\d+)?)\s*[:x]\s*(\d+(?:\.\d+)?)$/.exec(String(ar || '1:1'));
  return m ? +m[1] / +m[2] : 1;
}

function dimsFor(ar, base = 1024) {
  const r = Math.max(0.25, Math.min(4, parseRatio(ar)));
  const area = base * base;
  const w = Math.round(Math.sqrt(area * r) / 64) * 64;
  const h = Math.round(Math.sqrt(area / r) / 64) * 64;
  return [w, h];
}

function nearestRatio(ar, allowed) {
  const r = parseRatio(ar);
  return allowed.reduce((best, a) => (Math.abs(Math.log(parseRatio(a) / r)) < Math.abs(Math.log(parseRatio(best) / r)) ? a : best), allowed[0]);
}

module.exports = { STYLES, buildPrompts, parseInlineParams, dimsFor, nearestRatio, DEFAULT_NEGATIVE };
