// Обрезка
(() => {
  let rect = null;
  let start = null;
  let ratio = 0; // 0 — свободно

  const normalize = (a, b, img) => {
    let w = b.x - a.x;
    let h = b.y - a.y;
    if (ratio) {
      const s = Math.max(Math.abs(w), Math.abs(h) * ratio);
      w = Math.sign(w || 1) * s;
      h = Math.sign(h || 1) * (s / ratio);
    }
    let x = Math.min(a.x, a.x + w), y = Math.min(a.y, a.y + h);
    w = Math.abs(w); h = Math.abs(h);
    x = Math.max(0, x); y = Math.max(0, y);
    w = Math.min(w, img.width - x); h = Math.min(h, img.height - y);
    return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
  };

  Editor.register({
    id: 'crop', name: 'Обрезка', key: 'c', order: 50, cursor: 'crosshair',
    hint: 'Протяните рамку по картинке, затем нажмите «Обрезать».',
    icon: '<svg viewBox="0 0 24 24"><path d="M6 2v16h16"/><path d="M2 6h16v16"/></svg>',
    options(panel, ed) {
      panel.insertAdjacentHTML('beforeend', `
        <div class="ed-field"><span>Пропорции</span>
          <div class="ed-chips" id="cropRatio">
            ${[['Свободно', 0], ['1:1', 1], ['4:5', 0.8], ['3:2', 1.5], ['16:9', 16 / 9], ['2:3', 2 / 3]].map(([n, r]) => `<button data-r="${r}" class="${r === ratio ? 'on' : ''}">${n}</button>`).join('')}
          </div></div>
        <div class="ed-row"><button class="btn primary" id="cropApply">Обрезать</button><button class="btn" id="cropReset">Сбросить</button></div>`);
      panel.querySelector('#cropRatio').onclick = (e) => {
        const b = e.target.closest('[data-r]');
        if (!b) return;
        ratio = +b.dataset.r;
        panel.querySelectorAll('#cropRatio button').forEach((x) => x.classList.toggle('on', x === b));
      };
      panel.querySelector('#cropApply').onclick = () => {
        if (!rect || rect.w < 8 || rect.h < 8) return ed.toast('Сначала протяните рамку', true);
        const out = ed.makeCanvas(rect.w, rect.h);
        out.getContext('2d').drawImage(ed.img, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
        rect = null;
        ed.overlay = null;
        ed.commit(out, 'Обрезано', false);
      };
      panel.querySelector('#cropReset').onclick = () => { rect = null; ed.overlay = null; ed.redraw(); };
    },
    activate(ed) {
      ed.overlay = (g) => {
        if (!rect) return;
        const o = ed.offset, s = ed.scale;
        const W = ed.img.width * s, H = ed.img.height * s;
        g.fillStyle = 'rgba(0,0,0,.6)';
        g.beginPath();
        g.rect(o.x, o.y, W, H);
        g.rect(o.x + rect.x * s, o.y + rect.y * s, rect.w * s, rect.h * s);
        g.fill('evenodd');
        g.strokeStyle = '#fff';
        g.lineWidth = 1.5;
        g.strokeRect(o.x + rect.x * s, o.y + rect.y * s, rect.w * s, rect.h * s);
        g.fillStyle = '#fff';
        g.font = '12px Segoe UI, sans-serif';
        g.fillText(`${rect.w} × ${rect.h}`, o.x + rect.x * s + 6, o.y + rect.y * s - 6);
      };
    },
    deactivate() { rect = null; },
    down(p) { start = p; rect = null; },
    move(p, e, ed) { if (start) { rect = normalize(start, p, ed.img); ed.redraw(); } },
    up() { start = null; },
  });
})();
