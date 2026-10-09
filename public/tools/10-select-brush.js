// Выделение кистью и ластик выделения
(() => {
  const S = { size: +(localStorage.getItem('ed.selSize') || 60) };

  const sizeOption = (panel) => {
    panel.insertAdjacentHTML('beforeend', `
      <label class="ed-field"><span>Размер <b id="selSizeV">${S.size}</b></span>
      <input type="range" id="selSize" min="4" max="300" value="${S.size}"></label>`);
    panel.querySelector('#selSize').oninput = (e) => {
      S.size = +e.target.value;
      panel.querySelector('#selSizeV').textContent = S.size;
      try { localStorage.setItem('ed.selSize', S.size); } catch {}
    };
  };

  const cursor = (g, p, ed) => {
    g.beginPath();
    g.arc(ed.offset.x + p.x * ed.scale, ed.offset.y + p.y * ed.scale, (S.size / 2) * ed.scale, 0, Math.PI * 2);
    g.strokeStyle = 'rgba(255,255,255,.9)';
    g.lineWidth = 1.5;
    g.stroke();
  };

  function makeBrush(erase) {
    let last = null;
    const dab = (p, ed) => {
      const g = ed.mask.getContext('2d');
      g.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
      g.strokeStyle = g.fillStyle = '#fff';
      g.lineWidth = S.size;
      g.lineCap = g.lineJoin = 'round';
      g.beginPath();
      if (last) { g.moveTo(last.x, last.y); g.lineTo(p.x, p.y); g.stroke(); }
      else { g.arc(p.x, p.y, S.size / 2, 0, Math.PI * 2); g.fill(); }
      g.globalCompositeOperation = 'source-over';
      last = p;
      ed.maskChanged();
    };
    return {
      down: (p, e, ed) => { last = null; dab(p, ed); },
      move: (p, e, ed) => dab(p, ed),
      up: (p, e, ed) => { last = null; ed.maskDone(); },
      drawCursor: cursor,
      options: sizeOption,
    };
  }

  Editor.register({
    id: 'select-brush', name: 'Выделить', key: 'q', order: 10,
    hint: 'Закрасьте область, которую нужно изменить. Потом напишите ИИ, что с ней сделать, или примените коррекцию.',
    icon: '<svg viewBox="0 0 24 24"><path d="M4 20c2 0 4-1 4-3s-1-3-3-3-3 2-3 4"/><path d="M8 14l10-10 2 2-10 10"/></svg>',
    ...makeBrush(false),
  });

  Editor.register({
    id: 'select-eraser', name: 'Ластик', key: 'e', order: 30,
    hint: 'Стирает лишнее из выделения.',
    icon: '<svg viewBox="0 0 24 24"><path d="M16 3l5 5-11 11H5l-2-2z"/><path d="M10 19h11"/></svg>',
    ...makeBrush(true),
  });
})();
