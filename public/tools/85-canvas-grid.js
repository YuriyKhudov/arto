// Сетка для переноса на холст: подгонка под размер холста в см, клетки с подписями, печать в нужном DPI
(() => {
  const S = JSON.parse(localStorage.getItem('ed.grid') || 'null') || { w: 50, h: 70, cell: 5, color: '#e8452c', labels: true };
  const remember = () => { try { localStorage.setItem('ed.grid', JSON.stringify(S)); } catch {} };

  // область картинки с пропорциями холста (по центру)
  function fitRect(img) {
    const r = S.w / S.h;
    let w = img.width, h = img.width / r;
    if (h > img.height) { h = img.height; w = h * r; }
    return { x: (img.width - w) / 2, y: (img.height - h) / 2, w, h };
  }

  function drawGrid(g, rect, k, lineW) {
    const cols = Math.round(S.w / S.cell), rows = Math.round(S.h / S.cell);
    const cw = rect.w / (S.w / S.cell), ch = rect.h / (S.h / S.cell);
    g.save();
    g.strokeStyle = S.color;
    g.fillStyle = S.color;
    g.lineWidth = lineW;
    g.globalAlpha = 0.85;
    g.beginPath();
    for (let i = 0; i <= cols; i++) { const x = rect.x + Math.min(i * cw, rect.w); g.moveTo(x, rect.y); g.lineTo(x, rect.y + rect.h); }
    for (let j = 0; j <= rows; j++) { const y = rect.y + Math.min(j * ch, rect.h); g.moveTo(rect.x, y); g.lineTo(rect.x + rect.w, y); }
    g.stroke();
    if (S.labels) {
      // буквы по горизонтали, цифры по вертикали — как в шахматах: «В4»
      const L = 'АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЭЮЯ';
      g.globalAlpha = 1;
      g.font = `600 ${Math.max(10, Math.min(cw, ch) * 0.22)}px Segoe UI, sans-serif`;
      g.textBaseline = 'top';
      for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
        const x = rect.x + i * cw, y = rect.y + j * ch;
        if (x >= rect.x + rect.w - 1 || y >= rect.y + rect.h - 1) continue;
        g.fillText((L[i] || 'Z' + i) + (j + 1), x + lineW * 2 + 2 * k, y + lineW * 2 + 2 * k);
      }
    }
    g.restore();
  }

  function render(ed) {
    // обрезанная под холст картинка + сетка, в масштабе ~150 точек на дюйм
    const rect = fitRect(ed.img);
    const dpi = 150;
    const W = Math.round((S.w / 2.54) * dpi), H = Math.round((S.h / 2.54) * dpi);
    const scale = Math.min(W / rect.w, 4);
    const out = ed.makeCanvas(Math.round(rect.w * scale), Math.round(rect.h * scale));
    const g = out.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(ed.img, rect.x, rect.y, rect.w, rect.h, 0, 0, out.width, out.height);
    drawGrid(g, { x: 0, y: 0, w: out.width, h: out.height }, out.width / 1000, Math.max(2, out.width / 600));
    return out;
  }

  Editor.register({
    id: 'canvas-grid', name: 'Сетка', key: 'g', order: 78, cursor: 'default',
    hint: 'Перенос на холст по клеткам: введите размер холста и клетки — Arto подгонит картинку и расчертит её.',
    icon: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="1"/><path d="M9 3v18M15 3v18M3 9h18M3 15h18"/></svg>',
    options(panel, ed) {
      panel.insertAdjacentHTML('beforeend', `
        <div class="ed-row">
          <label class="ed-field"><span>Холст, ширина (см)</span><input type="number" id="grW" min="5" max="500" value="${S.w}"></label>
          <label class="ed-field"><span>высота (см)</span><input type="number" id="grH" min="5" max="500" value="${S.h}"></label>
        </div>
        <div class="ed-row"><button class="btn" id="grSwap">⇄ Повернуть холст</button></div>
        <label class="ed-field"><span>Клетка (см)</span><input type="number" id="grCell" min="1" max="50" step="0.5" value="${S.cell}"></label>
        <label class="ed-field"><span>Цвет линий</span><input type="color" id="grColor" value="${S.color}"></label>
        <label class="ed-check"><input type="checkbox" id="grLabels" ${S.labels ? 'checked' : ''}> Подписать клетки (А1, Б2…)</label>
        <p class="ed-hint" id="grInfo"></p>
        <div class="ed-row"><button class="btn primary" id="grSave">Скачать с сеткой</button></div>
        <p class="ed-hint">Картинка подгоняется под пропорции холста по центру. Скачанный файл можно печатать по клеткам.</p>`);
      const q = (s) => panel.querySelector(s);
      const upd = () => {
        S.w = +q('#grW').value || S.w; S.h = +q('#grH').value || S.h; S.cell = +q('#grCell').value || S.cell;
        S.color = q('#grColor').value; S.labels = q('#grLabels').checked;
        remember();
        q('#grInfo').textContent = `Клеток: ${Math.round(S.w / S.cell)} × ${Math.round(S.h / S.cell)}`;
        ed.redraw();
      };
      ['#grW', '#grH', '#grCell', '#grColor', '#grLabels'].forEach((s) => (q(s).oninput = upd));
      q('#grSwap').onclick = () => { [q('#grW').value, q('#grH').value] = [q('#grH').value, q('#grW').value]; upd(); };
      q('#grSave').onclick = () => {
        const a = document.createElement('a');
        a.href = render(ed).toDataURL('image/png');
        a.download = `arto_setka_${S.w}x${S.h}cm.png`;
        a.click();
        ed.toast('Файл с сеткой скачан');
      };
      upd();
    },
    activate(ed) {
      ed.overlay = (g) => {
        const rect = fitRect(ed.img);
        const k = ed.scale;
        const o = ed.offset;
        // затемнить то, что не войдёт в холст
        g.save();
        g.fillStyle = 'rgba(0,0,0,.6)';
        g.beginPath();
        g.rect(o.x, o.y, ed.img.width * k, ed.img.height * k);
        g.rect(o.x + rect.x * k, o.y + rect.y * k, rect.w * k, rect.h * k);
        g.fill('evenodd');
        g.restore();
        drawGrid(g, { x: o.x + rect.x * k, y: o.y + rect.y * k, w: rect.w * k, h: rect.h * k }, 1, 1.2);
      };
      ed.redraw();
    },
    deactivate(ed) { ed.overlay = null; },
  });
})();
