// Кисть: рисовать прямо по картинке (например, набросать деталь, а потом попросить ИИ доработать)
(() => {
  const S = {
    size: +(localStorage.getItem('ed.paintSize') || 12),
    color: localStorage.getItem('ed.paintColor') || '#1a1a1a',
    alpha: +(localStorage.getItem('ed.paintAlpha') || 100),
  };
  const remember = () => { try { localStorage.setItem('ed.paintSize', S.size); localStorage.setItem('ed.paintColor', S.color); localStorage.setItem('ed.paintAlpha', S.alpha); } catch {} };
  let work = null;
  let stroke = null;
  let last = null;

  Editor.register({
    id: 'paint', name: 'Кисть', key: 'b', order: 40,
    hint: 'Рисуйте поверх. Набросайте деталь от руки, выделите её и попросите ИИ: «доработай в том же стиле».',
    icon: '<svg viewBox="0 0 24 24"><path d="M3 21c3 0 5-1.5 5-4a2.5 2.5 0 0 0-5 0"/><path d="M8.5 14.5L20 3l1 1L9.5 15.5"/></svg>',
    options(panel) {
      panel.insertAdjacentHTML('beforeend', `
        <label class="ed-field"><span>Цвет</span><input type="color" id="pColor" value="${S.color}"></label>
        <div class="ed-swatches">${['#1a1a1a', '#5a4632', '#8c2f1f', '#c9a24a', '#e8e2d6', '#ffffff', '#2f4a6b', '#3e5a3a'].map((c) => `<button style="background:${c}" data-c="${c}"></button>`).join('')}</div>
        <label class="ed-field"><span>Размер <b id="pSizeV">${S.size}</b></span><input type="range" id="pSize" min="1" max="200" value="${S.size}"></label>
        <label class="ed-field"><span>Плотность <b id="pAlphaV">${S.alpha}%</b></span><input type="range" id="pAlpha" min="5" max="100" value="${S.alpha}"></label>`);
      const q = (s) => panel.querySelector(s);
      q('#pColor').oninput = (e) => { S.color = e.target.value; remember(); };
      q('.ed-swatches').onclick = (e) => { const c = e.target.dataset.c; if (c) { S.color = c; q('#pColor').value = c; remember(); } };
      q('#pSize').oninput = (e) => { S.size = +e.target.value; q('#pSizeV').textContent = S.size; remember(); };
      q('#pAlpha').oninput = (e) => { S.alpha = +e.target.value; q('#pAlphaV').textContent = S.alpha + '%'; remember(); };
    },
    down(p, e, ed) {
      work = ed.clone(ed.img);
      stroke = ed.makeCanvas(work.width, work.height);
      last = p;
      this.move(p, e, ed);
    },
    move(p, e, ed) {
      if (!stroke) return;
      const g = stroke.getContext('2d');
      g.strokeStyle = g.fillStyle = S.color;
      g.lineWidth = S.size;
      g.lineCap = g.lineJoin = 'round';
      g.beginPath();
      g.moveTo(last.x, last.y);
      g.lineTo(p.x + 0.01, p.y);
      g.stroke();
      last = p;
      ed.overlay = (v) => {
        v.save();
        v.translate(ed.offset.x, ed.offset.y);
        v.scale(ed.scale, ed.scale);
        v.globalAlpha = S.alpha / 100;
        v.drawImage(stroke, 0, 0);
        v.restore();
      };
      ed.redraw();
    },
    up(p, e, ed) {
      if (!stroke) return;
      const g = work.getContext('2d');
      g.globalAlpha = S.alpha / 100;
      g.drawImage(stroke, 0, 0);
      ed.overlay = null;
      stroke = null;
      ed.commit(work);
    },
    drawCursor(g, p, ed) {
      g.beginPath();
      g.arc(ed.offset.x + p.x * ed.scale, ed.offset.y + p.y * ed.scale, Math.max(2, (S.size / 2) * ed.scale), 0, Math.PI * 2);
      g.strokeStyle = 'rgba(255,255,255,.8)';
      g.lineWidth = 1;
      g.stroke();
    },
  });
})();
