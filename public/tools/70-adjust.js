// Коррекция: яркость, контраст, насыщенность, тепло, ч/б. Если есть выделение — только в нём.
(() => {
  const D = { brightness: 100, contrast: 100, saturate: 100, warmth: 0, gray: false };
  let v = { ...D };

  const filter = () =>
    `brightness(${v.brightness}%) contrast(${v.contrast}%) saturate(${v.saturate}%) sepia(${v.warmth}%)${v.gray ? ' grayscale(100%)' : ''}`;

  Editor.register({
    id: 'adjust', name: 'Коррекция', key: 'u', order: 70, cursor: 'default',
    hint: 'Если что-то выделено — коррекция применится только к выделенному.',
    icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 3v18" /><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/></svg>',
    options(panel, ed) {
      const row = (id, name, min, max) => `<label class="ed-field"><span>${name} <b id="${id}V">${v[id]}</b></span><input type="range" id="${id}" min="${min}" max="${max}" value="${v[id]}"></label>`;
      panel.insertAdjacentHTML('beforeend', `
        ${row('brightness', 'Яркость', 30, 170)}
        ${row('contrast', 'Контраст', 30, 200)}
        ${row('saturate', 'Насыщенность', 0, 250)}
        ${row('warmth', 'Тепло', 0, 80)}
        <label class="ed-check"><input type="checkbox" id="gray" ${v.gray ? 'checked' : ''}> Чёрно-белое</label>
        <div class="ed-row"><button class="btn primary" id="adjApply">Применить</button><button class="btn" id="adjReset">Сбросить</button></div>`);
      const upd = () => { ed.preview = ed.hasMask() ? null : filter(); };
      for (const id of ['brightness', 'contrast', 'saturate', 'warmth']) {
        panel.querySelector('#' + id).oninput = (e) => { v[id] = +e.target.value; panel.querySelector('#' + id + 'V').textContent = v[id]; upd(); };
      }
      panel.querySelector('#gray').onchange = (e) => { v.gray = e.target.checked; upd(); };
      panel.querySelector('#adjApply').onclick = () => {
        const out = ed.makeCanvas(ed.img.width, ed.img.height);
        const g = out.getContext('2d');
        g.filter = filter();
        g.drawImage(ed.img, 0, 0);
        v = { ...D };
        ed.preview = null;
        ed.applyMasked(out, 'Коррекция применена', 3);
      };
      panel.querySelector('#adjReset').onclick = () => { v = { ...D }; ed.preview = null; Editor.reselect?.(); };
      upd();
    },
    deactivate(ed) { ed.preview = null; },
  });
})();
