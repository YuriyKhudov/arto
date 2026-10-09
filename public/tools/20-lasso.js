// Лассо: обведите область — она добавится к выделению (с Alt — вычтется)
(() => {
  let pts = [];
  let subtract = false;

  Editor.register({
    id: 'lasso', name: 'Лассо', key: 'l', order: 20,
    hint: 'Обведите область мышкой. С зажатым Alt — убрать из выделения.',
    icon: '<svg viewBox="0 0 24 24"><path d="M7 18c-2-1-4-3-4-6 0-4 4-8 9-8s9 3 9 7-4 7-9 7c-1 0-2 0-3-.3"/><circle cx="7" cy="19" r="1.6"/></svg>',
    down(p, e, ed) {
      pts = [p];
      subtract = e.altKey;
      ed.overlay = (g) => {
        if (pts.length < 2) return;
        g.beginPath();
        pts.forEach((q, i) => {
          const x = ed.offset.x + q.x * ed.scale;
          const y = ed.offset.y + q.y * ed.scale;
          i ? g.lineTo(x, y) : g.moveTo(x, y);
        });
        g.closePath();
        g.setLineDash([6, 4]);
        g.strokeStyle = subtract ? '#ff8f80' : '#fff';
        g.lineWidth = 1.5;
        g.stroke();
        g.setLineDash([]);
      };
    },
    move(p, e, ed) {
      const l = pts[pts.length - 1];
      if (Math.hypot(p.x - l.x, p.y - l.y) * ed.scale > 3) { pts.push(p); ed.redraw(); }
    },
    up(p, e, ed) {
      ed.overlay = null;
      if (pts.length > 2) {
        const g = ed.mask.getContext('2d');
        g.globalCompositeOperation = subtract ? 'destination-out' : 'source-over';
        g.fillStyle = '#fff';
        g.beginPath();
        pts.forEach((q, i) => (i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y)));
        g.closePath();
        g.fill();
        g.globalCompositeOperation = 'source-over';
      }
      pts = [];
      ed.maskDone();
    },
  });
})();
