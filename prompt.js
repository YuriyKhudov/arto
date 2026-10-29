// Построение промптов: стиль-пресеты эскизов + аналоги параметров Midjourney.
//   --ar 3:2      соотношение сторон
//   --s 0..1000   stylize: насколько сильно добавлять «художественность»
//   --c 0..100    chaos: насколько четыре варианта отличаются друг от друга
//   --w 0..3000   weird: необычность, сюрреалистичность
//   --no a, b     что исключить (негативный промпт)
//   --seed N      повторяемость
//   --style id    пресет стиля (graphite, charcoal, ink, ...)
//   --iw 0..2     вес референса (насколько держаться исходной картинки)

// Техника — честная: только материал, инструмент и основа (бумага, холст).
// avoid — чего в этой технике быть не может (карандаш без краски и мазков, тушь без серых растяжек…).
// kind: drawing — графика (без «красивостей» про свет и цвет), painting — живопись. mono — без цвета.
const STYLES = [
  { id: 'raw', name: 'Raw', hint: 'Без стиля — только ваш промпт', core: '' },
  { id: 'graphite', name: 'Графит', hint: 'Карандашный штудийный рисунок', kind: 'drawing', mono: true,
    core: 'graphite pencil sketch, sketchy directional pencil strokes, parallel hatching, visible individual pencil strokes, shading built from strokes, unfinished edges, on white drawing paper',
    avoid: 'paint, painting, brush strokes, paint daubs, blotches, watercolor, gouache, oil paint, ink wash, color, colorful, smudged blobs, airbrush, smooth blending, engraving' },
  { id: 'charcoal', name: 'Уголь', hint: 'Мощный тональный рисунок углём', kind: 'drawing', mono: true,
    core: 'charcoal drawing, bold visible charcoal strokes, rich charcoal blacks, smudged charcoal tones, eraser highlights, grainy paper texture, on textured drawing paper',
    avoid: 'paint, painting, brush strokes, paint daubs, watercolor, gouache, oil paint, color, colorful, digital painting, smooth airbrush gradients' },
  { id: 'ink', name: 'Тушь и перо', hint: 'Линия, штрих, пятно туши', kind: 'drawing', mono: true,
    core: 'pen and black ink drawing, confident ink linework, varied line weight, ink hatching, solid black ink areas, on white paper',
    avoid: 'paint, painting, color, colorful, watercolor, gouache, oil paint, pencil shading, soft grey gradients, airbrush, blurry' },
  { id: 'watercolor', name: 'Акварель', hint: 'Лёгкий акварельный эскиз', kind: 'painting',
    core: 'watercolor painting, transparent watercolor washes, wet-on-wet blooms, soft bleeding edges, light pencil underdrawing, white of the paper left untouched, on cold press watercolor paper',
    avoid: 'oil paint, impasto, thick opaque paint, gouache, acrylic, digital painting, heavy black outlines' },
  { id: 'oil', name: 'Масляный этюд', hint: 'Alla prima, пастозный мазок', w: 1.6, kind: 'painting',
    core: 'thick impasto oil painting, heavy visible brushstrokes, palette knife marks, alla prima, oil paint texture on canvas',
    avoid: 'watercolor, pencil drawing, line art, flat colors, smooth digital painting, airbrush, fine detail, photorealistic' },
  { id: 'pastel', name: 'Пастель', hint: 'Сухая пастель, мягкие переходы', w: 1.6, kind: 'painting',
    core: 'soft pastel drawing, chalky grainy pastel strokes, pastel sticks marks, paper texture showing through, on colored pastel paper',
    avoid: 'oil paint, glossy paint, watercolor washes, ink lines, smooth digital painting, airbrush, photorealistic' },
  { id: 'concept', name: 'Концепт-арт', hint: 'Скетч концепт-художника', kind: 'painting',
    core: 'concept art sketch, loose digital painting, strong silhouette, clear value structure, designer sketchbook',
    avoid: '' },
  { id: 'marker', name: 'Маркеры', hint: 'Дизайнерский маркерный скетч', w: 1.45, kind: 'drawing',
    core: 'quick marker sketch, copic alcohol markers, streaky visible marker strokes, black fineliner outlines, white paper left blank around the drawing, limited grey tones with one accent color',
    avoid: 'oil paint, watercolor, painterly, digital painting, full background painting, sky gradient, photorealistic, soft shading' },
  { id: 'notan', name: 'Нотан / тон', hint: 'Тоновое пятно, 2–3 значения', w: 1.45, kind: 'drawing', mono: true,
    core: 'notan, flat graphic shapes in pure black white and one mid grey, three flat tones only, no gradients, bold abstracted masses',
    avoid: 'color, colorful, gradients, shading, hatching, texture, fine details, realistic rendering, brush strokes' },
  { id: 'thumbnail', name: 'Миниатюры', hint: 'Лист композиционных набросков', kind: 'drawing', mono: true,
    core: 'sketchbook page of small composition thumbnails, quick grey tonal sketches inside framing boxes, artist notes, layout variations',
    avoid: 'color, colorful, single finished painting, detailed rendering' },
  { id: 'linocut', name: 'Линогравюра', hint: 'Графика печати, резкий контраст', kind: 'drawing', mono: true,
    core: 'linocut print, carved gouge marks, high contrast black and white, bold graphic shapes, printmaking texture',
    avoid: 'color, grey gradients, soft shading, pencil, watercolor, paint, brush strokes' },
  { id: 'mixed', name: 'Смешанная техника', hint: 'Коллаж, слои, фактура', kind: 'painting',
    core: 'mixed media artwork, layered collage, graphite and acrylic, torn paper textures, scribbles and drips, art journal page',
    avoid: '' },
  { id: 'realism', name: 'Реализм', hint: 'Реалистичная живопись, живая кожа и свет', kind: 'painting', drawn: false,
    core: 'realistic oil painting, lifelike natural skin tones, subtle realistic lighting, accurate anatomy and proportions, fine detailed rendering, academic realism, depth of field',
    negative: 'pencil sketch, drawing, line art, lineart, graphite, charcoal, cartoon, anime, comic, illustration, flat colors, sketchy lines, monochrome, watermark, signature, text, logo, lowres, blurry, deformed, bad anatomy, extra fingers' },
];

// stylize — «художественность» (накопительно). Только то, что не спорит с техникой:
// живописи можно про свет и настроение, графике — только композиция и уверенная рука.
const STYLIZE_TIERS = {
  painting: [
    [25, 'artful composition with a clear focal point'],
    [350, 'expressive light and shadow'],
    [600, 'bold artistic interpretation'],
  ],
  drawing: [
    [25, 'artful composition with a clear focal point'],
    [150, 'confident draftsmanship, strong value design'],
    [350, 'expressive mark-making, elegant negative space'],
  ],
};

// chaos: случайные модификаторы для каждого из вариантов
const CHAOS_POOLS = [
  ['dramatic low angle', 'bird\'s eye view', 'tight close-up crop', 'wide panoramic composition', 'asymmetric off-center composition', 'strong diagonal composition', 'figure small in vast space', 'frontal symmetric composition'],
  ['backlit silhouette', 'harsh side light', 'soft diffused light', 'rim light', 'moody twilight', 'single candle light', 'overcast flat light', 'golden hour glow'],
  ['melancholic mood', 'restless energy', 'quiet contemplation', 'tension and suspense', 'dreamy calm', 'joyful movement', 'solemn monumentality'],
  ['muted earth palette', 'cold blue greys', 'warm ochres and siennas', 'single accent of red', 'complementary orange and teal', 'desaturated greens'],
];
const PALETTE_POOL = 3; // номер пула палитр — монохромным техникам не подходит

const WEIRD_POOL = [
  'surreal dreamlike distortion', 'unexpected juxtaposition', 'impossible architecture', 'elongated mannerist proportions',
  'floating objects', 'eerie uncanny atmosphere', 'symbolist allegory', 'fragmented cubist planes', 'melting forms',
  'botanical growths emerging', 'mythological undertone', 'visionary esoteric symbolism', 'Escher-like paradox',
];

const DEFAULT_NEGATIVE = 'photo, photograph, photography, photorealistic, realistic, 3d render, frame, border, cgi, plastic, glossy, watermark, signature, text, logo, lowres, blurry, deformed';

// «Следить за»: защита от типичных ошибок по сюжету. При низком CFG (Turbo/LCM) негатив действует слабо,
// поэтому кроме коротких запретов (neg) — маленькая подсказка в само описание (pos).
const GUARDS = [
  { id: 'people', name: 'Люди', hint: 'лица, руки, пальцы, пропорции тела',
    pos: 'natural proportions, correct anatomy',
    neg: '(bad anatomy:1.2), (extra fingers:1.2), missing fingers, fused fingers, malformed hands, extra arms, extra legs, deformed face, asymmetrical eyes, cross-eyed, long neck, duplicate person' },
  { id: 'animals', name: 'Животные', hint: 'лапы, хвосты, головы, морды',
    pos: 'anatomically correct animal',
    neg: '(extra legs:1.2), missing legs, (extra head:1.2), extra tail, fused animals, deformed paws, malformed muzzle, mutated body, human face on animal' },
  { id: 'landscape', name: 'Пейзаж', hint: 'горизонт, перспектива, повторы',
    pos: 'level horizon, coherent depth',
    neg: 'tilted horizon, crooked horizon, two suns, floating rocks, repeated identical trees, cluttered composition, muddy colors, oversaturated sky' },
  { id: 'stilllife', name: 'Натюрморт', hint: 'форма предметов, тени, перспектива',
    pos: 'solid well-formed objects, consistent light',
    neg: 'warped objects, melted objects, lopsided vase, floating objects, objects merging together, inconsistent shadows, distorted perspective, duplicated fruit' },
  { id: 'buildings', name: 'Здания', hint: 'прямые линии, окна, перспектива',
    pos: 'correct perspective, straight architectural lines',
    neg: 'warped buildings, crooked walls, melted windows, impossible geometry, distorted perspective, floating buildings, broken architecture' },
  { id: 'nopeople', name: 'Без людей', hint: 'на картинке не будет людей',
    pos: '', neg: '(people:1.3), person, human, figure, crowd, silhouette of a person' },
  { id: 'notext', name: 'Без надписей', hint: 'никаких букв, подписей, логотипов',
    pos: '', neg: '(text:1.3), letters, words, writing, caption, signature, watermark, logo, numbers' },
];

// убранные техники → ближайшая (старые работы и сохранённые настройки не ломаются)
const RETIRED = { gouache: 'oil', sanguine: 'graphite' };

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }

function buildPrompts({ subject, style = 'graphite', stylize = 100, chaos = 0, weird = 0, no = '', seed = 0, count = 4, guards = [] }) {
  const gs = GUARDS.filter((g) => (guards || []).includes(g.id));
  const st = STYLES.find((s) => s.id === (RETIRED[style] || style)) || STYLES[0];
  // «Без стиля» — только текст художника: никаких своих добавок (красивостей, разнообразия, странности)
  if (st.id === 'raw') { stylize = 0; chaos = 0; weird = 0; }
  // Техника — в начало и с повышенным весом: иначе модели скатываются в фото
  const [medium, ...details] = st.core.split(', ');
  const base = st.core ? [`(${medium}:${st.w || 1.3}) of ${subject.trim()}`, details.join(', ')] : [subject.trim()];
  for (const [t, text] of STYLIZE_TIERS[st.kind] || []) if (stylize >= t) base.push(text);
  if (st.core && st.drawn !== false) base.push('(hand-drawn traditional artwork:1.2)');
  for (const g of gs) if (g.pos) base.push(g.pos);

  const prompts = [];
  for (let i = 0; i < count; i++) {
    const rng = mulberry32(seed * 31 + i * 7919 + 1);
    const parts = [...base];
    const nChaos = Math.ceil((chaos / 100) * CHAOS_POOLS.length);
    const pools = CHAOS_POOLS.filter((_, k) => !(st.mono && k === PALETTE_POOL)).sort(() => rng() - 0.5).slice(0, nChaos);
    for (const pool of pools) if (rng() < 0.35 + chaos / 150) parts.push(pick(rng, pool));
    const nWeird = weird > 0 ? Math.min(4, Math.ceil(weird / 750)) : 0;
    const used = new Set();
    for (let k = 0; k < nWeird; k++) {
      const w = pick(rng, WEIRD_POOL);
      if (!used.has(w)) { used.add(w); parts.push(w); }
    }
    prompts.push(parts.filter(Boolean).join(', '));
  }

  const baseNeg = style === 'raw' ? '' : [st.negative || DEFAULT_NEGATIVE, st.avoid].filter(Boolean).join(', ');
  const negative = [baseNeg, ...gs.map((g) => g.neg), no].filter((x) => x && x.trim()).join(', ');
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

module.exports = { STYLES, RETIRED, GUARDS, buildPrompts, parseInlineParams, dimsFor, nearestRatio, DEFAULT_NEGATIVE };
