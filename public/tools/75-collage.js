// Сборка композиции из картинок на холсте редактора.
(() => {
  let draft;

  function drawPiece(g, piece) {
    g.save();
    g.translate(piece.x, piece.y);
    g.rotate(piece.angle * Math.PI / 180);
    g.drawImage(piece.image, -piece.w / 2, -piece.h / 2, piece.w, piece.h);
    g.restore();
  }

  function rotate(x, y, angle) {
    const a = angle * Math.PI / 180;
    return { x: x * Math.cos(a) - y * Math.sin(a), y: x * Math.sin(a) + y * Math.cos(a) };
  }

  function contains(piece, p) {
    const local = rotate(p.x - piece.x, p.y - piece.y, -piece.angle);
    return Math.abs(local.x) <= piece.w / 2 && Math.abs(local.y) <= piece.h / 2;
  }

  function handles(piece, scale) {
    const x = piece.w / 2, y = piece.h / 2;
    return [[-x, -y], [x, -y], [x, y], [-x, y], [0, -y - 24 / scale]];
  }

  function paintStrokes(g, strokes) {
    g.lineCap = g.lineJoin = 'round';
    for (const { points, color, width } of strokes) {
      g.strokeStyle = color;
      g.lineWidth = width;
      g.beginPath();
      g.moveTo(points[0].x, points[0].y);
      g.lineTo(points[0].x + 0.01, points[0].y);
      for (const p of points.slice(1)) g.lineTo(p.x, p.y);
      g.stroke();
    }
  }

  function inside(ed, p) {
    return p.x >= 0 && p.x < ed.img.width && p.y >= 0 && p.y < ed.img.height;
  }

  function paintComposition(g, ed, state) {
    g.imageSmoothingQuality = 'high';
    state.pieces.filter((piece) => inside(ed, piece)).forEach((piece) => drawPiece(g, piece));
    paintStrokes(g, state.strokes);
  }

  function readImage(file) {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.src = url;
    return image.decode().then(() => image).finally(() => URL.revokeObjectURL(url));
  }

  function reference(ed, piece) {
    const { image } = piece;
    const scale = Math.min(1, 1024 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = ed.makeCanvas(Math.max(1, Math.round(image.naturalWidth * scale)),
      Math.max(1, Math.round(image.naturalHeight * scale)));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  }

  function renderPreview(g, ed, state) {
    g.save();
    g.translate(ed.offset.x, ed.offset.y);
    g.scale(ed.scale, ed.scale);
    g.save();
    g.beginPath();
    g.rect(0, 0, ed.img.width, ed.img.height);
    g.clip();
    paintComposition(g, ed, state);
    g.restore();
    g.save();
    g.beginPath();
    g.rect(-ed.offset.x / ed.scale, -ed.offset.y / ed.scale,
      ed.img.width + 2 * ed.offset.x / ed.scale, ed.img.height + 2 * ed.offset.y / ed.scale);
    g.rect(0, 0, ed.img.width, ed.img.height);
    g.clip('evenodd');
    for (const piece of state.pieces.filter((piece) => !inside(ed, piece))) drawPiece(g, piece);
    g.restore();
    for (const [index, pin] of state.pins.entries()) {
      const p = pin.piece ? { x: pin.piece.x + pin.dx, y: pin.piece.y + pin.dy } : pin;
      const r = 10 / ed.scale;
      g.beginPath();
      g.arc(p.x, p.y, r, 0, Math.PI * 2);
      g.fillStyle = state.outline;
      g.fill();
      g.fillStyle = state.outlineShadow;
      g.font = `${12 / ed.scale}px sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(index + 1, p.x, p.y);
    }
    const piece = state.selected;
    if (piece) {
      g.translate(piece.x, piece.y);
      g.rotate(piece.angle * Math.PI / 180);
      g.lineWidth = 3 / ed.scale;
      g.strokeStyle = state.outlineShadow;
      g.strokeRect(-piece.w / 2, -piece.h / 2, piece.w, piece.h);
      g.lineWidth = 1 / ed.scale;
      g.strokeStyle = state.outline;
      g.strokeRect(-piece.w / 2, -piece.h / 2, piece.w, piece.h);
      g.beginPath();
      g.moveTo(0, -piece.h / 2);
      g.lineTo(0, -piece.h / 2 - 24 / ed.scale);
      g.stroke();
      g.fillStyle = state.outline;
      for (const [x, y] of handles(piece, ed.scale)) {
        g.beginPath();
        g.arc(x, y, 5 / ed.scale, 0, Math.PI * 2);
        g.fill();
        g.stroke();
      }
    }
    g.restore();
  }

  Editor.register({
    id: 'collage', name: 'Коллаж', order: 75, cursor: 'move',
    hint: 'Углы меняют размер, верхняя ручка поворачивает. Картинки за рамкой служат образцами для ИИ.',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="3" y="4" width="12" height="11" rx="2"/><rect x="9" y="9" width="12" height="11" rx="2"/><path d="m10 17 4-4 3 3 2-2 2 2"/></svg>',
    options(panel, ed) {
      panel.insertAdjacentHTML('beforeend', `
        <input id="collageFiles" type="file" accept="image/*" multiple hidden>
        <div class="ed-row">
          <button class="btn" id="collageAdd" type="button">Добавить картинки</button>
          <button class="btn" id="collageReset" type="button">Начать заново</button>
        </div>
        <div class="ed-chips" id="collageModes">
          <button type="button" data-mode="move" title="Перемещать, менять размер и поворачивать">Стрелка</button>
          <button type="button" data-mode="pen" title="Рисовать на холсте (B)">Перо</button>
          <button type="button" data-mode="note" title="Поставить заметку (N)">Заметка</button>
        </div>
        <div id="collagePen" class="ed-row" hidden>
          <label class="ed-field">Цвет<input id="collageColor" type="color" value="#303030"></label>
          <label class="ed-field">Толщина<input id="collageWidth" type="range" min="1" max="32" value="5"></label>
        </div>
        <div id="collagePins" class="ed-collage-piece"></div>
        <label class="ed-field" id="collagePinEditor" hidden>Заметка на холсте
          <textarea id="collagePinText" rows="2" maxlength="300"></textarea>
          <button class="btn" id="collagePinRemove" type="button">Убрать заметку</button>
        </label>
        <div id="collagePiece" class="ed-collage-piece" hidden>
          <p class="ed-hint" id="collageName"></p>
          <label class="ed-field"><span>Размер</span><input id="collageSize" type="range" min="5" max="300"></label>
          <label class="ed-field"><span>Поворот</span><input id="collageAngle" type="range" min="-180" max="180"></label>
          <div class="ed-row">
            <button class="btn" id="collageFront" type="button">На передний план</button>
            <button class="btn" id="collageRemove" type="button">Убрать</button>
          </div>
        </div>
        <label class="ed-field" id="collageInstructionField">Какой должна стать вся картинка
          <textarea id="collageInstruction" rows="3" maxlength="800" placeholder="Например, акварель на тёплой бумаге"></textarea>
        </label>
        <details id="collageSettings">
          <summary>Настройки ИИ</summary>
          <p class="ed-hint" id="collageModel"></p>
          <label class="ed-field"><span>CFG <b id="collageStrengthValue">1</b></span>
            <input id="collageStrength" type="range" min="1" max="10" step="0.25" value="1">
          </label>
          <label class="ed-field"><span>Steps <b id="collageStepsValue"></b></span>
            <input id="collageSteps" type="range" min="4" max="80" step="1">
          </label>
        </details>
        <div class="ed-row">
          <button class="btn" id="collageApply" type="button">Применить коллаж</button>
          <button class="btn primary" id="collageDraw" type="button">Перерисовать с ИИ</button>
        </div>
        <button class="btn" id="collageRestore" type="button" aria-describedby="collageRestoreHint">Вернуть композицию</button>
        <p class="ed-hint" id="collageRestoreHint">Станет доступно после перерисовки с ИИ.</p>`);
      const get = (id) => panel.querySelector('#collage' + id);
      const files = get('Files'), size = get('Size'), angle = get('Angle');
      const apply = get('Apply'), draw = get('Draw'), add = get('Add'), reset = get('Reset');
      const canEdit = !!window.ATELIER?.canEdit;
      get('InstructionField').hidden = get('Settings').hidden = draw.hidden = !canEdit;
      const lite = window.ATELIER?.edition === 'lite';
      get('Model').textContent = lite ? 'Модель Lite · FLUX.2 Klein' : (window.ATELIER?.editKind === 'qwen2511' ? 'Модель Pro · Qwen-Image-Edit 2511' : 'Модель Pro · Qwen-Image 2.1');
      get('Strength').value = window.ATELIER?.editDefaults?.cfg ?? 1;
      get('Steps').value = window.ATELIER?.editDefaults?.steps ?? (lite ? 4 : 8);
      for (const name of ['Strength', 'Steps']) {
        const input = get(name);
        input.oninput = () => { get(name + 'Value').textContent = input.value; };
        input.oninput();
      }
      const restore = get('Restore');
      let beforeRedraw;
      const colors = getComputedStyle(panel);
      const state = draft = {
        pieces: [], strokes: [], pins: [], selected: null, pin: null, drag: null, busy: false, mode: 'move',
        outline: colors.getPropertyValue('--accent-2').trim(),
        outlineShadow: colors.getPropertyValue('--bg').trim(),
        hasDraft() { return !!(state.pieces.length || state.strokes.length || state.pins.length || get('Instruction').value.trim()); },
        refresh() {
          const piece = state.selected;
          get('Piece').hidden = !piece;
          add.disabled = state.busy;
          restore.hidden = get('RestoreHint').hidden = !canEdit;
          restore.disabled = state.busy || !beforeRedraw;
          get('RestoreHint').textContent = beforeRedraw
            ? 'Вернёт картинки и заметки перед последней перерисовкой.'
            : 'Станет доступно после перерисовки с ИИ.';
          reset.disabled = state.busy || !(state.hasDraft() || ed.hasCanvasChanges);
          apply.disabled = state.busy || !(state.pieces.some((p) => inside(ed, p)) || state.strokes.length);
          draw.disabled = state.busy || !(state.pieces.length || state.strokes.length || state.pins.length || get('Instruction').value.trim());
          get('Pen').hidden = state.mode !== 'pen';
          get('PinEditor').hidden = !state.pin;
          get('Modes').querySelectorAll('button').forEach((button) => {
            button.classList.toggle('on', button.dataset.mode === state.mode);
            button.setAttribute('aria-pressed', String(button.dataset.mode === state.mode));
          });
          if (piece) {
            get('Name').textContent = piece.name;
            size.value = piece.size;
            angle.value = piece.angle;
          }
          ed.redraw();
        },
      };
      state.setMode = (mode) => {
        state.mode = mode;
        state.drag = null;
        state.pin = null;
        if (mode !== 'move') state.selected = null;
        state.refresh();
      };
      state.editPin = (pin) => {
        state.pin = pin;
        state.selected = null;
        state.refresh();
        get('PinText').value = pin.text;
        get('PinText').focus();
      };
      state.refreshPins = () => {
        get('Pins').replaceChildren(...state.pins.map((pin, i) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'btn';
          button.textContent = `${i + 1}. ${pin.text || 'Заметка'}`;
          button.onclick = () => state.editPin(pin);
          return button;
        }));
      };
      state.addPin = (p) => {
        const existing = state.pins.find((pin) => {
          const x = pin.piece ? pin.piece.x + pin.dx : pin.x;
          const y = pin.piece ? pin.piece.y + pin.dy : pin.y;
          return Math.hypot(p.x - x, p.y - y) <= 12 / ed.scale;
        });
        if (existing) return state.editPin(existing);
        const piece = state.pieces.findLast((item) => contains(item, p));
        const pin = { x: p.x, y: p.y, text: '', piece, dx: piece ? p.x - piece.x : 0, dy: piece ? p.y - piece.y : 0 };
        state.pins.push(pin);
        state.refreshPins();
        state.editPin(pin);
      };
      state.newStroke = (p) => {
        const stroke = { color: get('Color').value, width: +get('Width').value, points: [p] };
        state.strokes.push(stroke);
        state.drag = { stroke };
        state.refresh();
      };
      get('Modes').onclick = (e) => {
        const button = e.target.closest('[data-mode]');
        if (button) state.setMode(button.dataset.mode);
      };
      get('PinText').oninput = (e) => { state.pin.text = e.target.value; state.refreshPins(); };
      get('PinText').onkeydown = (e) => {
        if (e.key !== 'Enter' || e.shiftKey) return;
        e.preventDefault();
        state.pin = null;
        state.refresh();
      };
      get('PinRemove').onclick = () => {
        state.pins.splice(state.pins.indexOf(state.pin), 1);
        state.pin = null;
        state.refreshPins();
        state.refresh();
      };
      get('Instruction').oninput = () => state.refresh();

      add.onclick = () => files.click();
      files.onchange = () => {
        const selectedFiles = [...files.files];
        files.value = '';
        state.addFiles(selectedFiles);
      };
      state.addFiles = async (selectedFiles) => {
        if (!selectedFiles.length || state.busy) return;
        state.busy = true;
        state.refresh();
        for (const file of selectedFiles) {
          try {
            const image = await readImage(file);
            if (draft !== state) return;
            const { width, height } = ed.img;
            const scale = 0.5 * Math.min(width / image.naturalWidth, height / image.naturalHeight);
            const shift = (state.pieces.length % 5) * 0.05;
            const w = image.naturalWidth * scale, h = image.naturalHeight * scale;
            state.setMode('move');
            state.selected = { image, name: file.name, x: width * (0.4 + shift),
              y: height * (0.4 + shift), w, h, baseW: w, baseH: h, size: 100, angle: 0 };
            state.pieces.push(state.selected);
          } catch {
            if (draft !== state) return;
            ed.toast('Не удалось открыть картинку «' + file.name + '»', true);
          }
        }
        state.busy = false;
        state.refresh();
      };
      size.oninput = () => {
        const piece = state.selected;
        piece.size = +size.value;
        piece.w = piece.baseW * piece.size / 100;
        piece.h = piece.baseH * piece.size / 100;
        ed.redraw();
      };
      angle.oninput = () => { state.selected.angle = +angle.value; ed.redraw(); };
      get('Front').onclick = () => {
        state.pieces.splice(state.pieces.indexOf(state.selected), 1);
        state.pieces.push(state.selected);
        state.refresh();
      };
      get('Remove').onclick = () => {
        state.pieces.splice(state.pieces.indexOf(state.selected), 1);
        state.pins = state.pins.filter((pin) => pin.piece !== state.selected);
        state.refreshPins();
        state.selected = null;
        state.refresh();
      };
      const clearDraft = () => {
        state.pieces = [];
        state.strokes = [];
        state.pins = [];
        state.selected = state.drag = state.pin = null;
        state.refreshPins();
      };
      reset.onclick = () => {
        if (!confirm('Начать коллаж заново? Картинки, штрихи, заметки и описание будут удалены.')) return;
        clearDraft();
        beforeRedraw = null;
        get('Instruction').value = '';
        ed.resetCanvas();
        state.setMode('move');
      };
      restore.onclick = () => {
        if ((state.hasDraft() || ed.img !== beforeRedraw.result) &&
            !confirm('Вернуть композицию перед перерисовкой? Текущие изменения будут заменены.')) return;
        const { base, pieces, strokes, pins, instruction } = beforeRedraw;
        state.pieces = pieces;
        state.strokes = strokes;
        state.pins = pins;
        state.selected = null;
        beforeRedraw = null;
        get('Instruction').value = instruction;
        ed.commit(base, 'Композиция восстановлена', false);
        state.refreshPins();
        state.setMode('move');
      };
      const commit = () => {
        const out = ed.clone(ed.img);
        paintComposition(out.getContext('2d'), ed, state);
        clearDraft();
        ed.commit(out, 'Коллаж применён', false);
        state.refresh();
      };
      apply.onclick = commit;
      draw.onclick = async () => {
        if (!ed.canRunAi) return ed.toast('Дождитесь окончания предыдущей правки', true);
        const referencePieces = [...state.pieces.filter((p) => !inside(ed, p)), ...state.pieces.filter((p) => inside(ed, p))].slice(0, 2);
        const instruction = [
          'Use image 1 as a rough composition guide. Create a single seamless image. Keep the positions and proportions of the main elements, integrate them into the scene and remove visible cutout edges.',
          get('Instruction').value.trim(),
          ...referencePieces.map((piece, index) => inside(ed, piece)
            ? `Image ${index + 2} shows the element centered at ${Math.round(100 * piece.x / ed.img.width)}% from the left, ${Math.round(100 * piece.y / ed.img.height)}% from the top.`
            : `Image ${index + 2} is a visual reference. Use it according to the instructions.`),
          ...state.pins.map((pin) => {
            if (!pin.text.trim()) return '';
            if (pin.piece && !inside(ed, pin.piece)) {
              const index = referencePieces.indexOf(pin.piece);
              return index < 0 ? '' : `Reference image ${index + 2}: ${pin.text}`;
            }
            const x = pin.piece ? pin.piece.x + pin.dx : pin.x;
            const y = pin.piece ? pin.piece.y + pin.dy : pin.y;
            return `At ${Math.round(100 * x / ed.img.width)}% from the left, ${Math.round(100 * y / ed.img.height)}% from the top: ${pin.text}`;
          }),
        ].filter(Boolean).join('\n');
        const references = referencePieces.map((piece) => reference(ed, piece));
        const saved = {
          base: ed.img, pieces: state.pieces, strokes: state.strokes, pins: state.pins,
          instruction: get('Instruction').value,
        };
        const composition = ed.clone(ed.img);
        paintComposition(composition.getContext('2d'), ed, state);
        const knobs = { cfg: +get('Strength').value, steps: +get('Steps').value };
        state.busy = true;
        state.setMode('move');
        get('Instruction').disabled = true;
        const result = await ed.redrawCollage(instruction, references, composition, knobs);
        if (draft !== state) return;
        if (result) {
          beforeRedraw = { ...saved, result };
          clearDraft();
          get('Instruction').value = '';
        }
        get('Instruction').disabled = false;
        state.busy = false;
        state.refresh();
      };
      state.refresh();
    },
    activate(ed) {
      const state = draft;
      ed.overlay = (g) => renderPreview(g, ed, state);
    },
    deactivate() { draft = null; },
    hasDraft() { return draft?.hasDraft(); },
    canvasRestored() { draft?.refresh(); },
    addImages(files) { draft.addFiles(files); },
    context(p, e, ed) {
      e.preventDefault();
      if (!draft.busy && (inside(ed, p) || draft.pieces.some((piece) => contains(piece, p)))) draft.addPin(p);
    },
    keyDown(e) {
      if (e.ctrlKey || e.altKey || e.metaKey) return false;
      const mode = { v: 'move', b: 'pen', n: 'note', м: 'move', и: 'pen', т: 'note' }[e.key.toLowerCase()];
      if (!mode) return false;
      draft.setMode(mode);
      return true;
    },
    down(p, e, ed) {
      if (e.button !== 0 || draft.busy) return;
      if (draft.mode === 'pen') {
        if (inside(ed, p)) draft.newStroke(p);
        return;
      }
      if (draft.mode === 'note') {
        if (inside(ed, p) || draft.pieces.some((piece) => contains(piece, p))) draft.addPin(p);
        return;
      }
      const selected = draft.selected;
      if (selected) {
        const local = rotate(p.x - selected.x, p.y - selected.y, -selected.angle);
        const corners = handles(selected, ed.scale);
        const handle = corners.findIndex(([x, y]) => Math.hypot(local.x - x, local.y - y) <= 9 / ed.scale);
        if (handle === 4) {
          draft.drag = { rotateFrom: Math.atan2(p.y - selected.y, p.x - selected.x), angle: selected.angle };
          return;
        }
        if (handle >= 0) {
          const [x, y] = corners[(handle + 2) % 4];
          const anchor = rotate(x, y, selected.angle);
          draft.drag = { anchor: { x: selected.x + anchor.x, y: selected.y + anchor.y },
            size: selected.size, w: selected.w, h: selected.h, dx: -2 * x, dy: -2 * y };
          return;
        }
      }
      draft.selected = draft.pieces.findLast((piece) => contains(piece, p)) || null;
      const piece = draft.selected;
      draft.drag = piece ? { x: piece.x - p.x, y: piece.y - p.y } : null;
      draft.refresh();
    },
    move(p, e, ed) {
      const drag = draft.drag;
      if (!drag || !e.buttons) return;
      const piece = draft.selected;
      if (drag.stroke) {
        drag.stroke.points.push(p);
      } else if (drag.anchor) {
        const local = rotate(p.x - drag.anchor.x, p.y - drag.anchor.y, -piece.angle);
        const ratio = (local.x * drag.dx + local.y * drag.dy) / (drag.w ** 2 + drag.h ** 2);
        piece.size = Math.max(5, Math.min(300, drag.size * ratio));
        piece.w = piece.baseW * piece.size / 100;
        piece.h = piece.baseH * piece.size / 100;
        const center = rotate(drag.dx * piece.size / drag.size / 2, drag.dy * piece.size / drag.size / 2, piece.angle);
        piece.x = drag.anchor.x + center.x;
        piece.y = drag.anchor.y + center.y;
      } else if (drag.rotateFrom !== undefined) {
        const degrees = drag.angle + (Math.atan2(p.y - piece.y, p.x - piece.x) - drag.rotateFrom) * 180 / Math.PI;
        piece.angle = ((degrees + 540) % 360) - 180;
      } else {
        piece.x = Math.max(-ed.offset.x / ed.scale, Math.min(ed.img.width + ed.offset.x / ed.scale, p.x + drag.x));
        piece.y = Math.max(-ed.offset.y / ed.scale, Math.min(ed.img.height + ed.offset.y / ed.scale, p.y + drag.y));
      }
      draft.refresh();
    },
    up() { draft.drag = null; },
  });

})();
