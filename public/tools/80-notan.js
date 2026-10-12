// Тональный разбор (нотан): картинка в 2, 3 или 5 тонов — проверить композицию и светотень до красок
(() => {
  const S = { levels: 3, simplify: 4 };

  function notan(src, levels, simplify) {
    const w = src.width, h = src.height;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.filter = simplify ? `blur(${simplify * Math.max(w, h) / 1000}px)` : 'none'; // упростить мелкие детали
    g.drawImage(src, 0, 0);
    g.filter = 'none';
    const d = g.getImageData(0, 0, w, h);
    const p = d.data;
    // пороги по распределению яркости — тона делят картинку поровну, а не по фиксированным границам
    const lum = new Uint8Array(w * h);
    const hist = new Uint32Array(256);
    for (let i = 0, j = 0; i < p.length; i += 4, j++) { const v = Math.round(0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2]); lum[j] = v; hist[v]++; }
    const cuts = [];
    let acc = 0, k = 1;
    for (let v = 0; v < 256 && k < levels; v++) { acc += hist[v]; if (acc >= (k * lum.length) / levels) { cuts.push(v); k++; } }
    const tones = Array.from({ length: levels }, (_, i) => Math.round(20 + (215 * i) / (levels - 1)));
    for (let i = 0, j = 0; i < p.length; i += 4, j++) {
      let t = 0;
      while (t < cuts.length && lum[j] > cuts[t]) t++;
      p[i] = p[i + 1] = p[i + 2] = tones[t];
    }
    g.putImageData(d, 0, 0);
    return c;
  }

  let cache = null;
  const refresh = (ed) => {
    cache = notan(ed.img, S.levels, S.simplify);
    ed.overlay = (g) => {
      g.save();
      g.translate(ed.offset.x, ed.offset.y);
      g.scale(ed.scale, ed.scale);
      g.drawImage(cache, 0, 0);
      g.restore();
    };
    ed.redraw();
  };

  Editor.register({
    id: 'notan', name: 'Нотан', key: 'n', order: 75, cursor: 'default',
    hint: 'Тональный разбор: работа в 2, 3 или 5 тонах. Хорошая композиция читается даже в двух тонах.',
    icon: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 15l5-5 4 4 3-3 6 6" /><path d="M3 3h9v9H3z" fill="currentColor" opacity=".5"/></svg>',
    options(panel, ed) {
      panel.insertAdjacentHTML('beforeend', `
        <div class="ed-field"><span>Тонов</span>
          <div class="ed-chips" id="ntLevels">${[2, 3, 5].map((n) => `<button data-n="${n}" class="${n === S.levels ? 'on' : ''}">${n}</button>`).join('')}</div></div>
        <label class="ed-field"><span>Упростить детали <b id="ntSimpV">${S.simplify}</b></span><input type="range" id="ntSimp" min="0" max="12" value="${S.simplify}"></label>
        <div class="ed-row"><button class="btn" id="ntApply" title="Заменить картинку разбором (Ctrl+Z вернёт)">Сделать картинкой</button></div>
        <p class="ed-hint">Это только просмотр — выберите другой инструмент, и картинка вернётся.</p>`);
      panel.querySelector('#ntLevels').onclick = (e) => {
        const b = e.target.closest('[data-n]');
        if (!b) return;
        S.levels = +b.dataset.n;
        panel.querySelectorAll('#ntLevels button').forEach((x) => x.classList.toggle('on', x === b));
        refresh(ed);
      };
      panel.querySelector('#ntSimp').oninput = (e) => { S.simplify = +e.target.value; panel.querySelector('#ntSimpV').textContent = S.simplify; refresh(ed); };
      panel.querySelector('#ntApply').onclick = () => { ed.overlay = null; ed.commit(ed.clone(cache), 'Нотан готов'); refresh(ed); };
    },
    activate(ed) { refresh(ed); },
    deactivate(ed) { ed.overlay = null; cache = null; },
  });
})();
