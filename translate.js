// Офлайн-перевод русского текста на английский (модели рисования и редактирования лучше понимают английский).
// 1) «Словарь художника» — слова, которые машинный перевод путает, подставляются точно.
// 2) Перевод — NLLB-200 (Meta, ~870 МБ, папка models/); если не загрузился — запасной opus-mt (~110 МБ).
const path = require('path');

// корень слова (регулярка) → точный английский; длинные фразы — раньше коротких
const GLOSSARY = [
  // взгляд, выражение лица, настроение
  [/томн\S*\s+взгляд\S*/gi, 'languid sultry gaze'], [/томн\S*/gi, 'languid'],
  [/чувственн\S*/gi, 'sensual'], [/соблазнительн\S*/gi, 'seductive'], [/развратн\S*/gi, 'lewd'], [/страстн\S*/gi, 'passionate'],
  [/лукав\S*/gi, 'sly'], [/кокетлив\S*/gi, 'flirtatious'], [/игрив\S*/gi, 'playful'], [/надменн\S*/gi, 'haughty'],
  [/задумчив\S*/gi, 'pensive'], [/мечтательн\S*/gi, 'dreamy'], [/печальн\S*/gi, 'sorrowful'], [/тоскливн?\S*/gi, 'melancholic'],
  [/умиротворённ\S*|умиротворенн\S*/gi, 'serene'], [/дерзк\S*/gi, 'defiant'], [/робк\S*/gi, 'shy'], [/смущённ\S*|смущенн\S*/gi, 'embarrassed'],
  [/полуулыбк\S*/gi, 'half smile'], [/прищур\S*/gi, 'squinting eyes'], [/с поволокой/gi, 'with heavy-lidded eyes'],
  // свет и композиция
  [/контражур\S*/gi, 'backlit contre-jour'], [/контров\S*\s+свет\S*/gi, 'rim backlight'], [/светотен\S*/gi, 'chiaroscuro'],
  [/полутен\S*/gi, 'half-tones'], [/рефлекс\S*/gi, 'reflected light'], [/ракурс\S*/gi, 'foreshortening'],
  [/крупн\S*\s+план\S*/gi, 'close-up'], [/общ\S*\s+план\S*/gi, 'wide shot'], [/в полный рост/gi, 'full-length figure'],
  [/по пояс/gi, 'waist-up'], [/вид сверху/gi, 'top-down view'], [/вид снизу/gi, 'low angle view'],
  // техники и приёмы
  [/лессировк\S*/gi, 'glazing'], [/пастозн\S*/gi, 'impasto'], [/мазк\S*|мазок/gi, 'brushstrokes'], [/подмалёвк\S*|подмалевк\S*|подмалёвок|подмалевок/gi, 'underpainting'],
  [/гризайл\S*/gi, 'grisaille'], [/сангин\S*/gi, 'sanguine chalk'], [/штриховк\S*/gi, 'hatching'], [/растушёвк\S*|растушевк\S*/gi, 'blending'],
  [/набросок|наброск\S*/gi, 'quick sketch'], [/этюд\S*/gi, 'study'], [/эскиз\S*/gi, 'sketch'], [/по-сырому|по сырому/gi, 'wet-on-wet'],
  [/алла прима|а-ля прима/gi, 'alla prima'], [/мастихин\S*/gi, 'palette knife'], [/акварел\S*/gi, 'watercolor'], [/гуаш\S*/gi, 'gouache'],
  [/уголь|углём|углем/gi, 'charcoal'], [/тушь\S*|тушью/gi, 'ink'], [/пастел\S*/gi, 'pastel'], [/графит\S*/gi, 'graphite'],
  [/обнажённ\S*|обнаженн\S*/gi, 'nude'], [/натурщиц\S*/gi, 'female model'], [/натурщик\S*/gi, 'male model'],
];

function applyGlossary(text) {
  let t = text;
  for (const [re, en] of GLOSSARY) t = t.replace(re, en);
  return t;
}

let translator = null;
let kind = null; // 'nllb' | 'opus'
let loading = null;

async function load() {
  if (translator) return translator;
  if (!loading) {
    loading = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = path.join(__dirname, 'models');
      try {
        translator = await pipeline('translation', 'Xenova/nllb-200-distilled-600M', { dtype: 'q8' });
        kind = 'nllb';
      } catch (e) {
        console.error('NLLB не загрузился, беру запасной переводчик:', e.message);
        translator = await pipeline('translation', 'Xenova/opus-mt-ru-en', { dtype: 'q8' });
        kind = 'opus';
      }
      return translator;
    })().catch((e) => { loading = null; throw e; });
  }
  return loading;
}

const hasCyrillic = (s) => /[а-яё]/i.test(s || '');

async function toEnglish(text) {
  if (!hasCyrillic(text)) return text;
  const pre = applyGlossary(text);
  if (!hasCyrillic(pre)) return pre;
  try {
    const tr = await load();
    const opts = kind === 'nllb' ? { src_lang: 'rus_Cyrl', tgt_lang: 'eng_Latn', max_new_tokens: 256 } : { max_new_tokens: 200 };
    // NLLB хорошо держит длинную фразу целиком; opus — лучше по частям
    const parts = kind === 'nllb' ? pre.split(/\n+/) : pre.split(/\s*[,;\n]\s*/);
    const out = [];
    for (const p of parts.filter(Boolean)) {
      if (!hasCyrillic(p)) { out.push(p); continue; }
      const r = await tr(p, opts);
      out.push(r[0].translation_text.replace(/[.\s]+$/, ''));
    }
    return out.join(kind === 'nllb' ? '. ' : ', ');
  } catch (e) {
    console.error('Перевод не удался:', e.message);
    return text;
  }
}

module.exports = { toEnglish, preload: () => load().catch(() => {}), applyGlossary };
