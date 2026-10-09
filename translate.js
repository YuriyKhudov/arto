// Офлайн-перевод русского промпта на английский (модели рисования понимают в основном английский).
// Модель opus-mt-ru-en (~110 МБ) лежит в папке models/ и работает без интернета.
const path = require('path');

let translator = null;
let loading = null;

async function load() {
  if (translator) return translator;
  if (!loading) {
    loading = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = path.join(__dirname, 'models');
      translator = await pipeline('translation', 'Xenova/opus-mt-ru-en', { dtype: 'q8' });
      return translator;
    })().catch((e) => { loading = null; throw e; });
  }
  return loading;
}

const hasCyrillic = (s) => /[а-яё]/i.test(s || '');

// Переводит по фразам через запятую — так короткие промпты переводятся точнее
async function toEnglish(text) {
  if (!hasCyrillic(text)) return text;
  try {
    const tr = await load();
    const parts = text.split(/\s*[,;\n]\s*/).filter(Boolean);
    const out = [];
    for (const p of parts) {
      if (!hasCyrillic(p)) { out.push(p); continue; }
      const r = await tr(p, { max_new_tokens: 200 });
      out.push(r[0].translation_text.replace(/[.\s]+$/, ''));
    }
    return out.join(', ');
  } catch (e) {
    console.error('Перевод не удался:', e.message);
    return text;
  }
}

module.exports = { toEnglish, preload: () => load().catch(() => {}) };
