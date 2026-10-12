// Arto — «Палитра и краски»: главные цвета картинки → настоящие тюбики «Невской палитры» и рецепты смесей.
// Смешивание — субтрактивное приближение (взвешенное геометрическое среднее отражений), как у красок, а не света.
const Paints = (() => {
  let data = null;
  let seriesId = localStorage.getItem('arto.paintSeries') || 'master-class-oil';
  let img = null; // картинка в модальном окне
  let rows = []; // [{ target: [r,g,b], picked }]

  // ---------- цвет ----------
  const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const toHex = (c) => '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const unlin = (v) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
  function lab([r, g, b]) {
    const R = lin(r), G = lin(g), B = lin(b);
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    const x = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047), y = f(0.2126 * R + 0.7152 * G + 0.0722 * B), z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  }
  // CIEDE2000 — разница цветов «как видит глаз»
  function dE([L1, a1, b1], [L2, a2, b2]) {
    const rad = Math.PI / 180;
    const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cm = (C1 + C2) / 2;
    const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
    const a1p = a1 * (1 + G), a2p = a2 * (1 + G);
    const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
    const h = (a, b) => { const v = Math.atan2(b, a) / rad; return v < 0 ? v + 360 : v; };
    const h1 = h(a1p, b1), h2 = h(a2p, b2);
    const dL = L2 - L1, dC = C2p - C1p;
    let dh = h2 - h1; if (C1p * C2p === 0) dh = 0; else if (dh > 180) dh -= 360; else if (dh < -180) dh += 360;
    const dH = 2 * Math.sqrt(C1p * C2p) * Math.sin((dh / 2) * rad);
    const Lm = (L1 + L2) / 2, Cpm = (C1p + C2p) / 2;
    let hm = h1 + h2; if (C1p * C2p !== 0) hm = Math.abs(h1 - h2) > 180 ? (h1 + h2 < 360 ? (h1 + h2 + 360) / 2 : (h1 + h2 - 360) / 2) : (h1 + h2) / 2;
    const T = 1 - 0.17 * Math.cos((hm - 30) * rad) + 0.24 * Math.cos(2 * hm * rad) + 0.32 * Math.cos((3 * hm + 6) * rad) - 0.2 * Math.cos((4 * hm - 63) * rad);
    const SL = 1 + (0.015 * (Lm - 50) ** 2) / Math.sqrt(20 + (Lm - 50) ** 2), SC = 1 + 0.045 * Cpm, SH = 1 + 0.015 * Cpm * T;
    const RT = -2 * Math.sqrt(Cpm ** 7 / (Cpm ** 7 + 25 ** 7)) * Math.sin(60 * Math.exp(-(((hm - 275) / 25) ** 2)) * rad);
    return Math.sqrt((dL / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + RT * (dC / SC) * (dH / SH));
  }

  // ---------- подбор смеси ----------
  function prepare(series) {
    const base = series.colors.map((c) => {
      const rgb = hexToRgb(c.mass);
      return { ...c, rgb, log: rgb.map((v) => Math.log(Math.max(0.004, lin(v)))) };
    });
    // «цена» краски для рецепта: базовые — бесплатно, экзотика (туманности, неон…) — дорого
    const BASIC = /белила|кадмий|охра|сиена|умбра|ультрамарин|кобальт синий|церулеум|берлинская|изумрудная зелёная|окись хрома|краплак|марс чёрный|сажа|кость|серая пейна|индиго|неаполитанская жёлтая|английская красная|венецианская красная|сепия|ван-дик|лимонная|кармин|алая|зелень соковая/i;
    const EXOTIC = /туманност|тени|неон|пион|кварц|магнолия|мечта|туф|дюны|мокко|маррон|гранит|порфирит|шпинель/i;
    base.forEach((c) => { c.cost = BASIC.test(c.name) ? 0 : EXOTIC.test(c.name) ? 3 : 1; });
    const isWhite = (c) => /^10[01]$/.test(c.num);
    const white = base.find((c) => c.num === '101') || base.find(isWhite);
    const paper = { log: [0.9, 0.89, 0.86].map(Math.log) }; // белая бумага для акварели
    return { series, paints: base.filter((c) => !isWhite(c)), lighten: series.kind === 'oil' ? white : paper };
  }

  // Lab прямо из линейного RGB (без лишних пересчётов — это самое «горячее» место)
  function labLin(R, G, B) {
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    const x = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047), y = f(0.2126 * R + 0.7152 * G + 0.0722 * B), z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  }

  function mixLin(parts, lighten, t) {
    let a = 0, b = 0, c = 0;
    for (const [p, w] of parts) { const k = w * (1 - t); a += p.log[0] * k; b += p.log[1] * k; c += p.log[2] * k; }
    if (t) { a += lighten.log[0] * t; b += lighten.log[1] * t; c += lighten.log[2] * t; }
    return [Math.exp(a), Math.exp(b), Math.exp(c)];
  }

  const RATIOS = [[1, 1], [2, 1], [1, 2], [3, 1], [1, 3]];
  const LIGHT = [0, 0.25, 0.5, 0.75, 0.88];

  function bestRecipe(target, P) {
    const tLab = lab(target);
    // 1) быстрый перебор по простой разнице Lab, держим 25 лучших
    const top = [];
    const consider = (parts, t, extra) => {
      const m = mixLin(parts, P.lighten, t);
      const L = labLin(m[0], m[1], m[2]);
      const quick = Math.hypot(L[0] - tLab[0], L[1] - tLab[1], L[2] - tLab[2]) + extra;
      if (top.length < 25 || quick < top[top.length - 1].quick) {
        top.push({ parts, t, extra, lab: L, lin: m, quick });
        top.sort((x, y) => x.quick - y.quick);
        if (top.length > 25) top.pop();
      }
    };
    // штрафы: смесь сложнее одного тюбика, экзотические краски — реже в мастерской
    for (const p of P.paints) for (const t of LIGHT) consider([[p, 1]], t, p.cost + (t ? 0.6 : 0));
    const n = P.paints.length;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const cost = 4 + P.paints[i].cost + P.paints[j].cost;
      for (const [a, b] of RATIOS) {
        const parts = [[P.paints[i], a / (a + b)], [P.paints[j], b / (a + b)]];
        for (const t of LIGHT) consider(parts, t, cost + (t ? 0.6 : 0));
      }
    }
    // 2) точная оценка лучших кандидатов по CIEDE2000
    let best = null;
    for (const c of top) {
      const d = dE(tLab, c.lab);
      if (!best || d + c.extra < best.d + best.extra) best = { ...c, d };
    }
    best.rgb = best.lin.map(unlin);
    // доли → «части» целыми числами
    const min = Math.min(...best.parts.map(([, w]) => w));
    best.items = best.parts.map(([p, w]) => ({ paint: p, n: Math.round(w / min) }));
    return best;
  }

  // ---------- главные цвета картинки (k-средних) ----------
  function extract(image, k = 6) {
    const c = document.createElement('canvas');
    const s = 72 / Math.max(image.naturalWidth, image.naturalHeight);
    c.width = Math.max(1, Math.round(image.naturalWidth * s));
    c.height = Math.max(1, Math.round(image.naturalHeight * s));
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(image, 0, 0, c.width, c.height);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const px = [];
    for (let i = 0; i < d.length; i += 4) px.push([d[i], d[i + 1], d[i + 2]]);
    const L = px.map(lab);
    // начальные центры — равномерно по яркости, чтобы результат был стабильным
    const order = L.map((v, i) => i).sort((a, b) => L[a][0] - L[b][0]);
    let cent = Array.from({ length: k }, (_, i) => L[order[Math.floor(((i + 0.5) / k) * order.length)]].slice());
    let assign = new Array(L.length).fill(0);
    for (let it = 0; it < 12; it++) {
      for (let i = 0; i < L.length; i++) {
        let bi = 0, bd = Infinity;
        for (let j = 0; j < k; j++) { const dd = (L[i][0] - cent[j][0]) ** 2 + (L[i][1] - cent[j][1]) ** 2 + (L[i][2] - cent[j][2]) ** 2; if (dd < bd) { bd = dd; bi = j; } }
        assign[i] = bi;
      }
      const sum = Array.from({ length: k }, () => [0, 0, 0, 0]);
      assign.forEach((j, i) => { sum[j][0] += L[i][0]; sum[j][1] += L[i][1]; sum[j][2] += L[i][2]; sum[j][3]++; });
      cent = sum.map((s2, j) => (s2[3] ? [s2[0] / s2[3], s2[1] / s2[3], s2[2] / s2[3]] : cent[j]));
    }
    const groups = Array.from({ length: k }, () => ({ rgb: [0, 0, 0], n: 0 }));
    assign.forEach((j, i) => { groups[j].rgb[0] += px[i][0]; groups[j].rgb[1] += px[i][1]; groups[j].rgb[2] += px[i][2]; groups[j].n++; });
    return groups.filter((gr) => gr.n / px.length > 0.03).sort((a, b) => b.n - a.n)
      .map((gr) => ({ rgb: gr.rgb.map((v) => v / gr.n), share: gr.n / px.length }));
  }

  // ---------- интерфейс ----------
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const similarity = (d) => (d < 4 ? 'почти точно' : d < 8 ? 'очень похоже' : d < 14 ? 'похоже' : 'примерно');
  const lightWord = (kind, t) => (!t ? '' : kind === 'oil'
    ? (t <= 0.25 ? 'немного белил' : t <= 0.5 ? 'белил — столько же, сколько краски' : t <= 0.75 ? 'много белил' : 'очень много белил')
    : (t <= 0.25 ? 'чуть развести водой' : t <= 0.5 ? 'развести водой' : t <= 0.75 ? 'сильно развести водой' : 'лёгкая лессировка, очень много воды'));
  const partsWord = (n) => (n === 1 ? 'часть' : n < 5 ? 'части' : 'частей');

  function render() {
    const series = data.series.find((s) => s.id === seriesId) || data.series[0];
    const P = prepare(series);
    $('#pnSeries').innerHTML = data.series.map((s) => `<button data-s="${s.id}" class="${s.id === series.id ? 'on' : ''}">${esc(s.title)}</button>`).join('');
    const buy = new Map();
    $('#pnRows').innerHTML = rows.map((r, i) => {
      const rec = bestRecipe(r.target, P);
      rec.items.forEach((it) => buy.set(it.paint.num, it.paint));
      if (rec.t && series.kind === 'oil') buy.set(P.lighten.num, P.lighten);
      const recipe = rec.items.map((it) => `
        <div class="pn-paint">
          <i style="background:${it.paint.mass}"></i>
          <div><b>№ ${it.paint.num} ${esc(it.paint.name)}</b><small>${esc(it.paint.en)}</small></div>
          ${rec.items.length > 1 ? `<span class="pn-parts">${it.n} ${partsWord(it.n)}</span>` : ''}
        </div>`).join('');
      const light = lightWord(series.kind, rec.t);
      return `<div class="pn-row">
        <div class="pn-swatches" title="Слева — цвет картинки, справа — что получится">
          <i style="background:${toHex(r.target)}"></i><i style="background:${toHex(rec.rgb)}"></i>
        </div>
        <div class="pn-recipe">
          ${recipe}
          ${light ? `<div class="pn-light">+ ${light}${series.kind === 'oil' ? ` <small>(№ ${P.lighten.num} ${esc(P.lighten.name)})</small>` : ''}</div>` : ''}
          <div class="pn-meta">${similarity(rec.d)}${r.picked ? ' · выбрано пипеткой' : r.share ? ` · ${Math.round(r.share * 100)}% картинки` : ''}</div>
        </div>
        <button class="pn-x" data-rm="${i}" title="Убрать">×</button>
      </div>`;
    }).join('') || '<p class="muted">Нажмите на картинку, чтобы подобрать цвет.</p>';
    const list = [...buy.values()].sort((a, b) => +a.num - +b.num);
    $('#pnBuy').innerHTML = list.length
      ? `<b>Понадобятся тюбики (${list.length}):</b> ` + list.map((p) => `<span class="pn-tube"><i style="background:${p.mass}"></i>№ ${p.num} ${esc(p.name)}</span>`).join('')
      : '';
    $('#pnBuy').dataset.text = list.map((p) => `№ ${p.num} ${p.name}`).join('\n');
  }

  async function open(src) {
    if (!data) data = await (await fetch('data/paints.json')).json();
    img = new Image();
    img.src = src;
    await img.decode();
    $('#pnImg').src = src;
    rows = extract(img).map((c) => ({ target: c.rgb, share: c.share }));
    $('#paints').hidden = false;
    render();
  }

  function pick(e) {
    const r = e.target.getBoundingClientRect();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const x = Math.floor(((e.clientX - r.left) / r.width) * c.width), y = Math.floor(((e.clientY - r.top) / r.height) * c.height);
    // среднее по маленькому кружку — чтобы не попасть в один шумный пиксель
    const rad = Math.max(2, Math.round(c.width / 200));
    const d = g.getImageData(Math.max(0, x - rad), Math.max(0, y - rad), rad * 2, rad * 2).data;
    const s = [0, 0, 0]; let n = 0;
    for (let i = 0; i < d.length; i += 4) { s[0] += d[i]; s[1] += d[i + 1]; s[2] += d[i + 2]; n++; }
    rows.unshift({ target: s.map((v) => v / n), picked: true });
    render();
    $('#pnRows').scrollTop = 0;
  }

  function bind() {
    $('#pnClose').onclick = () => ($('#paints').hidden = true);
    $('#paints').addEventListener('click', (e) => { if (e.target.id === 'paints') $('#paints').hidden = true; });
    $('#pnImg').addEventListener('click', pick);
    $('#pnSeries').onclick = (e) => {
      const b = e.target.closest('[data-s]');
      if (!b) return;
      seriesId = b.dataset.s;
      try { localStorage.setItem('arto.paintSeries', seriesId); } catch {}
      render();
    };
    $('#pnRows').onclick = (e) => { const b = e.target.closest('[data-rm]'); if (b) { rows.splice(+b.dataset.rm, 1); render(); } };
    $('#pnCopy').onclick = async () => {
      const t = $('#pnBuy').dataset.text;
      if (!t) return;
      try { await navigator.clipboard.writeText(t); window.toast?.('Список тюбиков скопирован'); } catch { window.toast?.('Не удалось скопировать', true); }
    };
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#paints').hidden) $('#paints').hidden = true; });
  }

  return { open, bind, _test: { bestRecipe, prepare, lab, dE, hexToRgb } };
})();
