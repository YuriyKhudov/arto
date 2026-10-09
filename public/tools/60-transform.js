// Повороты и отражение — разовые действия (action), без панели настроек
(() => {
  function rotate(ed, dir) {
    const src = ed.img;
    const out = ed.makeCanvas(src.height, src.width);
    const g = out.getContext('2d');
    g.translate(out.width / 2, out.height / 2);
    g.rotate((dir * Math.PI) / 2);
    g.drawImage(src, -src.width / 2, -src.height / 2);
    ed.commit(out, null, false);
  }

  Editor.register({
    id: 'rotate-left', name: 'Повернуть', order: 60,
    icon: '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
    action: (ed) => rotate(ed, -1),
  });

  Editor.register({
    id: 'flip', name: 'Отразить', order: 62,
    icon: '<svg viewBox="0 0 24 24"><path d="M12 3v18"/><path d="M8 7L3 12l5 5z"/><path d="M16 7l5 5-5 5z"/></svg>',
    action: (ed) => {
      const out = ed.makeCanvas(ed.img.width, ed.img.height);
      const g = out.getContext('2d');
      g.translate(out.width, 0);
      g.scale(-1, 1);
      g.drawImage(ed.img, 0, 0);
      ed.commit(out, null, false);
    },
  });
})();
