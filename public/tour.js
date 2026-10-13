// «Как пользоваться»: пошаговые подсказки по каждой возможности Arto.
// Подсвечивает кнопку, пишет, что нажать, и показывает пример результата. Работает офлайн.
// Новая подсказка — просто ещё один элемент в TOURS: { id, name, desc, steps: [{ el, title, text, img, before }] }.
const Tour = (() => {
  const q = (s) => (typeof s === 'function' ? s() : document.querySelector(s));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const show = (sel) => { const n = q(sel); if (n) n.hidden = false; };
  const hide = (sel) => { const n = q(sel); if (n) n.hidden = true; };

  // ---- подготовка экрана перед шагом ----
  const toCreate = () => { closeLightbox(); hide('#paints'); hide('#trainBox'); showPage('create'); setMode('draw'); };
  const firstImage = () => allImages()[0];
  async function openImage() {
    const x = firstImage();
    if (!x) return;
    if ($('#lightbox').hidden) openLightbox(allImages(), x.job, x.index);
    await wait(150);
  }
  const openTray = (id) => () => { toCreate(); hide('#sketchTray'); hide('#styleTray'); hide('#more'); show(id); id === '#sketchTray' ? renderSketch() : renderStyleRefs(); };
  const NEED_IMAGE = 'Сначала нарисуйте хотя бы одну картинку — эта подсказка показывает, что можно сделать с готовой работой.';

  const TOURS = [
    {
      id: 'first', name: 'Первая картинка', desc: 'Как нарисовать картинку по описанию',
      steps: [
        { el: '#prompt', before: toCreate, title: 'Опишите, что нарисовать', text: 'Пишите по-русски, своими словами. Например: «старый рыбак у лодки на закате» или «кот спит на подоконнике, утренний свет».' },
        { el: '#style', title: 'Выберите технику', text: 'Уголь, акварель, масло, реализм и другие. Arto нарисует именно в этой технике.' },
        { el: '#formatSeg', title: 'Формат', text: 'Квадрат, горизонталь или вертикаль — как лист бумаги или холст.' },
        { el: '#qualitySeg', title: 'Качество', text: '«Черновик» — быстро прикинуть идею. «Высокое» — дольше, но деталей больше.' },
        { el: '#countSeg', title: 'Сколько вариантов', text: 'Сколько разных картинок нарисовать за раз. Можно вписать своё число — до 32.' },
        { el: '#guardSeg', title: 'Следить за', text: 'Подскажите Arto, что рисуете, — он будет внимательнее к типичным ошибкам. «Люди» — руки, пальцы, лица. «Животные» — лапы и хвосты. «Пейзаж» — горизонт. Можно включить несколько.' },
        { el: '#goBtn', title: 'Нарисовать', text: 'Нажмите эту кнопку или Enter. Картинки появятся ниже, в ленте. На плитке видно проценты и сколько осталось ждать, а «■ Отменить» остановит рисование.' },
        { el: '#feed', title: 'Что получится', text: 'Готовые картинки — в ленте. Нажмите на любую, чтобы открыть крупно: там все действия — изменить, увеличить, раскрыть кадр, подобрать краски. «↻ Ещё раз» — новые варианты того же запроса.' },
        { el: '#moreBtn', title: 'Тонкие настройки', text: 'Если захочется больше: насколько смело фантазировать, разнообразие вариантов и чего не должно быть на картинке. Можно не трогать — по умолчанию всё настроено.' },
      ],
    },
    {
      id: 'edit', name: 'Изменить картинку словами', desc: 'Сказать ИИ, что поправить: «сделай вечер», «добавь шляпу»',
      steps: [
        { el: '#modes [data-mode="edit"]', before: toCreate, title: 'Режим «Изменить картинку»', text: 'Переключитесь сюда, чтобы менять готовую картинку словами.' },
        { el: '#sources', before: () => setMode('edit'), title: 'Добавьте картинку', text: 'Нажмите «+», перетащите файл или вставьте Ctrl+V. Можно до трёх картинок — например, человека и платье, которое надо на него надеть.' },
        { el: '#prompt', title: 'Напишите, что поменять', text: '«Сделай вечер», «добавь соломенную шляпу», «улыбка мягче», «убери человека справа». Всё, о чём не сказано, останется как было.' },
        { el: '#editCountSeg', title: 'Несколько вариантов', text: 'Попросите 2 или 4 варианта — ИИ сделает их по-разному, выберете лучший.' },
        { el: '#goBtn', title: 'Готово', text: 'Нажмите — результат появится в ленте. Открыв его, можно двигать ползунок «до / после» и сравнивать с оригиналом.' },
        { el: '#lbEdit', before: openImage, need: true, title: 'Ещё быстрее', text: 'Любую картинку из ленты можно изменить прямо отсюда: откройте её и нажмите «Изменить словами».' },
      ],
      done: () => { closeLightbox(); setMode('draw'); },
    },
    {
      id: 'sketch', name: 'По наброску или фото', desc: 'Arto нарисует картину по вашим линиям или по позе с фотографии',
      steps: [
        { el: '#sketchBtn', before: toCreate, title: 'Значок с линией', text: 'Нажмите его, чтобы открыть панель наброска.' },
        { el: '#sketchSlot', before: openTray('#sketchTray'), title: 'Загрузите набросок', text: 'Нажмите сюда или перетащите свой эскиз — даже простые каракули. Arto сохранит ваши линии и композицию.', img: 'tour/sketch.jpg' },
        { el: '#sketchMode', title: 'Набросок или фото', text: '«Набросок» — Arto раскрасит и дорисует ваши линии. «Контур с фото» — возьмёт позу и композицию с фотографии, а нарисует в вашей технике.', img: 'tour/photo.jpg' },
        { el: '#sketchDraw', title: 'Нарисовать прямо здесь', text: 'Нет наброска под рукой? Нажмите — откроется лист, рисуйте мышкой или пером.' },
        { el: '#sketchPower', title: 'Точность', text: 'Чем больше — тем точнее Arto держится ваших линий. Меньше — больше свободы.' },
        { el: '#prompt', title: 'Опишите и рисуйте', text: 'Напишите, что изображено, выберите технику и нажмите «Нарисовать».' },
      ],
      done: () => hide('#sketchTray'),
    },
    {
      id: 'style', name: 'Стиль с картинок', desc: 'Рисовать в манере понравившихся работ',
      steps: [
        { el: '#styleBtn', before: toCreate, title: 'Значок палитры', text: 'Нажмите его, чтобы открыть панель стиля.' },
        { el: '#styleSlots', before: openTray('#styleTray'), title: 'Картинки-образцы', text: 'Добавьте 1–4 картинки, манеру которых хотите взять: мазок, цвет, настроение. Сюжет с них не копируется.' },
        { el: '#sw', title: 'Больше или меньше стиля', text: 'Один ползунок: вправо — картинка ближе к образцам, влево — свободнее.' },
        { el: '#saveStyle', title: 'Сохранить подборку', text: 'Удачный набор образцов можно сохранить и потом выбрать одним нажатием в «Мои подборки».' },
        { el: '[data-act="as-style"]', before: openImage, need: true, title: 'Из ленты', text: 'Любую свою картинку можно сделать образцом: откройте её и нажмите «Взять стиль».' },
      ],
      done: () => { closeLightbox(); hide('#styleTray'); },
    },
    {
      id: 'manner', name: 'Мой стиль', desc: 'Научить Arto рисовать вашей рукой — на ваших картинах',
      steps: [
        { el: '#styleBtn', before: toCreate, title: 'Значок палитры', text: 'Обучение своему стилю — в панели стиля. Нажмите значок палитры.', img: 'tour/manner.jpg' },
        { el: '#trainOpen', before: openTray('#styleTray'), title: 'Обучить на моих картинах', text: 'Нажмите эту кнопку. Подготовьте 15–30 фотографий своих работ в одной манере, но с разными сюжетами: портреты, пейзажи, предметы.' },
        { el: '#trName', before: () => { $('#trainOpen').click(); }, title: 'Название', text: 'Как назвать стиль, например «Мои пейзажи маслом».' },
        { el: '#trSource', title: 'Откуда картинки', text: '«Файлы с компьютера» — выберите сразу все работы в папке. «С доски» — если уже собрали их на доску настроения.' },
        { el: '#trQuality', title: 'Быстро или качественно', text: 'Лучше «Качественно». Пока идёт обучение, видеокарта занята — рисовать не получится.' },
        { el: '#trGo', title: 'Начать обучение', text: 'В ленте появится плитка «обучаю» с процентами. В конце Arto сам нарисует пробную картинку в вашем стиле.' },
        { el: '#myLora', before: () => hide('#trainBox'), title: 'Рисовать в своём стиле', text: 'Когда обучение закончится, выберите свой стиль в этом списке и просто опишите, что нарисовать. Технику выбирать не нужно — её задаёт ваш стиль. Рядом будет один ползунок: меньше или больше стиля. Обычно лучше всего — «как в образцах».' },
      ],
      done: () => { hide('#trainBox'); hide('#styleTray'); },
    },
    {
      id: 'image', name: 'Что можно сделать с картинкой', desc: 'Похожие варианты, увеличение, раскрыть кадр, на доску',
      steps: [
        { el: '#lbImg', before: openImage, need: true, title: 'Картинка открыта', text: 'Нажмите на любую картинку в ленте — она откроется крупно. Стрелки ← → на клавиатуре листают.' },
        { el: '[data-act="vary-subtle"]', title: 'Ещё похожих', text: '4 новых варианта рядом с этой картинкой. «Смелые вариации» — та же идея, но с заметными отличиями.' },
        { el: '#lbUpscale', title: 'Увеличить ×2', text: '«Простое» — быстро, ничего не меняет. «Художественное» — дорисует детали и фактуру. «Исправить и увеличить» — ИИ поправит руки, пальцы, пропорции и отдельно, крупно — лица, сохранив стиль.' },
        { el: '#lbOutpaint', title: 'Раскрыть кадр', text: 'Сделать картинку шире, выше или под нужный формат. Сцена продолжится за край в той же манере, а сама картинка не изменится. Получится два варианта.', img: 'tour/outpaint.jpg' },
        { el: '[data-act="as-sketch"]', title: 'Новое из этой картинки', text: '«Рисовать по контуру» — новая картина по линиям этой. «Взять стиль» — новое в этой манере. «Взять за основу» — новое от этой картинки.' },
        { el: '[data-act="to-board"]', title: 'На доску', text: 'Собирайте понравившиеся картинки в подборки настроения.' },
        { el: '#lbDownload', title: 'Скачать', text: 'Сохранить картинку себе на компьютер. ♡ — отметить любимую, потом их легко найти в «Мои работы».' },
      ],
      done: () => closeLightbox(),
    },
    {
      id: 'paints', name: 'Палитра и краски', desc: 'Какие тюбики взять и как смешать цвета картинки',
      steps: [
        { el: '[data-act="paints"]', before: openImage, need: true, title: 'Палитра и краски', text: 'Откройте любую картинку и нажмите эту кнопку.' },
        { el: '#pnSeries', before: async () => { const x = firstImage(); if ($('#paints').hidden) await action('paints', x.job, x.index); await wait(300); }, title: 'Ваши краски', text: 'Выберите серию: масло или акварель «Невской палитры», «Малевичъ», «Гамма». Номера — как на тюбиках.' },
        { el: '#pnRows', title: 'Цвета и рецепты', text: 'Главные цвета картинки и для каждого — какие тюбики смешать и в какой пропорции.' },
        { el: '#pnImg', title: 'Пипетка', text: 'Нажмите на любое место картинки — получите рецепт именно этого цвета.' },
        { el: '#pnMine', title: 'Мои тюбики', text: 'Отметьте, какие краски у вас есть. Галочка «только мои тюбики» — рецепты только из них.' },
        { el: '#pnBuy', title: 'Список покупок', text: 'Каких тюбиков не хватает — одной кнопкой, удобно взять в магазин.' },
      ],
      done: () => { hide('#paints'); closeLightbox(); },
    },
    {
      id: 'editor', name: 'Редактор', desc: 'Выделение, лассо, кисть, нотан, сетка для холста',
      steps: [
        { el: '[data-act="studio"]', before: openImage, need: true, title: 'Открыть в редакторе', text: 'Откройте картинку и нажмите эту кнопку. Свою картинку с компьютера можно открыть пунктом «Редактор» слева.' },
        {
          el: '#edTools', title: 'Инструменты',
          before: async () => { const x = firstImage(); if ($('#editor').hidden) await action('studio', x.job, x.index); await wait(400); },
          text: 'Выделение кистью, лассо, кисть, обрезка, поворот, коррекция цвета, нотан и сетка. Наведите мышь на значок — появится подсказка.',
        },
        { el: '[data-id="lasso"]', title: 'Выделить область', text: 'Обведите лассо или закрасьте кистью выделения место, которое хотите поменять. Остальное останется нетронутым.' },
        { el: () => (window.ATELIER?.canEdit === false ? null : $('#edAiBox')), title: 'ИИ по выделению', text: 'Напишите, что сделать с выделенным: «другая причёска», «убери». ИИ поменяет только там. Можно попросить несколько вариантов.' },
        { el: '[data-id="notan"]', title: 'Нотан', text: 'Разложить картинку на 2–4 тона — проверить, читается ли композиция светом и тенью.' },
        { el: '[data-id="canvas-grid"]', title: 'Сетка для холста', text: 'Укажите размер холста — Arto наложит сетку, чтобы точно перенести рисунок по клеткам.' },
        { el: '#edCompare', title: 'До / после', text: 'Сравнить с тем, что было. Отменить шаг — Ctrl+Z.' },
        { el: '#edSave', title: 'Сохранить', text: 'Готовая картинка попадёт в ленту.' },
      ],
      done: () => { if (!$('#editor').hidden) $('#edClose').click(); },
    },
    {
      id: 'boards', name: 'Доски, серии и промпты', desc: 'Подборки настроения, серии в одном стиле, сохранённые запросы',
      steps: [
        { el: '.nav-btn[data-page="boards"]', before: toCreate, title: 'Доски настроения', text: 'Собирайте свои и чужие картинки в подборки, пишите заметки. Доску можно взять как стиль или для обучения «Моего стиля».' },
        { el: '#prompt', before: toCreate, title: 'Серия в одном стиле', text: 'Напишите несколько строк — по одной на картинку (новая строка: Shift+Enter). Arto нарисует их все в единой манере, как иллюстрации к одной книге.' },
        { el: () => $('#feed .job .star'), title: 'Сохранить удачный запрос', text: 'Звёздочка ☆ у работы сохраняет запрос со всеми настройками.' },
        { el: '.nav-btn[data-page="prompts"]', title: 'Мои промпты', text: 'Здесь все сохранённые запросы — запускайте их снова одним нажатием.' },
      ],
    },
  ];

  // ---- отрисовка ----
  let cur = null; // { tour, i }
  let spot, card, blockers;
  function build() {
    if (spot) return;
    spot = document.createElement('div');
    spot.className = 'tour-spot';
    card = document.createElement('div');
    card.className = 'tour-card';
    blockers = [0, 1, 2, 3].map(() => { const b = document.createElement('div'); b.className = 'tour-block'; document.body.append(b); return b; });
    document.body.append(spot, card);
    card.onclick = (e) => {
      const a = e.target.closest('[data-t]')?.dataset.t;
      if (a === 'next') step(1);
      if (a === 'back') step(-1);
      if (a === 'close') stop();
      if (a === 'menu') { stop(); menu(); }
    };
    addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    document.addEventListener('keydown', (e) => {
      if (!cur) return;
      if (e.key === 'Escape') { e.stopPropagation(); stop(); }
      if (e.key === 'ArrowRight') step(1);
      if (e.key === 'ArrowLeft') step(-1);
    }, true);
  }

  const visible = (n) => n && n.isConnected && !n.closest('[hidden]') && n.getClientRects().length > 0;

  async function render() {
    const { tour, i } = cur;
    const s = tour.steps[i];
    if (s.need && !firstImage()) { s._el = null; draw(s, NEED_IMAGE); return; }
    try { await s.before?.(); } catch (e) { console.warn('tour', e); }
    // окна (краски, редактор) открываются не мгновенно — подождать, пока нужная часть появится
    for (let k = 0; k < 25 && !visible(q(s.el)); k++) await wait(100);
    if (cur?.tour.steps[cur.i] !== s) return; // пока ждали, нажали «Дальше» или закрыли
    const el = q(s.el);
    s._el = visible(el) ? el : null;
    s._el?.scrollIntoView({ block: 'center', behavior: 'instant' });
    draw(s);
  }

  function draw(s, override) {
    const { tour, i } = cur;
    const last = i === tour.steps.length - 1;
    card.innerHTML = `
      <div class="tour-head"><span class="tour-n">${esc(tour.name)} · ${i + 1} из ${tour.steps.length}</span><button class="tour-x" data-t="close" title="Закрыть">×</button></div>
      <b class="tour-title">${esc(s.title)}</b>
      <p>${esc(override || s.text)}</p>
      ${s.img && !override ? `<img src="${s.img}" alt="">` : ''}
      <div class="tour-foot">
        ${i ? '<button class="btn" data-t="back">← Назад</button>' : '<button class="btn" data-t="menu">Все подсказки</button>'}
        ${last ? '<button class="btn primary" data-t="menu">Готово ✓</button>' : '<button class="btn primary" data-t="next">Дальше →</button>'}
      </div>`;
    const img = card.querySelector('img');
    if (img) img.onload = place;
    place();
  }

  function place() {
    if (!cur) return;
    const el = cur.tour.steps[cur.i]._el;
    const W = innerWidth, H = innerHeight, pad = 8;
    let r = el ? el.getBoundingClientRect() : null;
    if (r) r = { left: r.left - pad, top: r.top - pad, width: r.width + pad * 2, height: r.height + pad * 2 };
    const hole = r || { left: W / 2, top: H / 2, width: 0, height: 0 };
    Object.assign(spot.style, { left: hole.left + 'px', top: hole.top + 'px', width: hole.width + 'px', height: hole.height + 'px' });
    spot.classList.toggle('empty', !r);
    // клики — только по подсвеченной кнопке, остальное прикрыто
    const [t, b, l, rr] = blockers;
    Object.assign(t.style, { left: 0, top: 0, width: W + 'px', height: Math.max(0, hole.top) + 'px' });
    Object.assign(b.style, { left: 0, top: hole.top + hole.height + 'px', width: W + 'px', height: Math.max(0, H - hole.top - hole.height) + 'px' });
    Object.assign(l.style, { left: 0, top: hole.top + 'px', width: Math.max(0, hole.left) + 'px', height: hole.height + 'px' });
    Object.assign(rr.style, { left: hole.left + hole.width + 'px', top: hole.top + 'px', width: Math.max(0, W - hole.left - hole.width) + 'px', height: hole.height + 'px' });
    // карточка — под элементом, над ним или сбоку; без элемента — по центру
    const cw = card.offsetWidth, ch = card.offsetHeight, gap = 14;
    let x, y;
    if (!r) { x = (W - cw) / 2; y = (H - ch) / 2; }
    else if (r.top + r.height + gap + ch < H) { x = r.left; y = r.top + r.height + gap; }
    else if (r.top - gap - ch > 0) { x = r.left; y = r.top - gap - ch; }
    else if (r.left + r.width + gap + cw < W) { x = r.left + r.width + gap; y = r.top; }
    else { x = r.left - gap - cw; y = r.top; }
    card.style.left = Math.max(12, Math.min(W - cw - 12, x)) + 'px';
    card.style.top = Math.max(12, Math.min(H - ch - 12, y)) + 'px';
  }

  async function step(d) {
    if (!cur) return;
    const n = cur.i + d;
    if (n < 0 || n >= cur.tour.steps.length) return;
    cur.i = n;
    await render();
  }

  function start(id) {
    const tour = TOURS.find((t) => t.id === id);
    if (!tour) return;
    hide('#tourMenu');
    build();
    cur = { tour, i: 0 };
    document.body.classList.add('touring');
    render();
  }

  function stop() {
    if (!cur) return;
    const t = cur.tour;
    cur = null;
    document.body.classList.remove('touring');
    try { t.done?.(); } catch {}
  }

  function menu() {
    try { localStorage.setItem('arto.tourSeen', '1'); } catch {}
    $('#tourList').innerHTML = TOURS.map((t, i) => `<button class="tour-item" data-id="${t.id}"><span class="tour-num">${i + 1}</span><span><b>${esc(t.name)}</b><small>${esc(t.desc)}</small></span></button>`).join('');
    show('#tourMenu');
  }

  function init() {
    $('#helpBtn').onclick = menu;
    $('#tourList').onclick = (e) => { const b = e.target.closest('[data-id]'); if (b) start(b.dataset.id); };
    $('#tourClose').onclick = () => hide('#tourMenu');
    // первый запуск — предложить подсказки один раз
    let seen = false;
    try { seen = !!localStorage.getItem('arto.tourSeen'); } catch {}
    if (!seen) setTimeout(menu, 800);
  }

  return { init, start, menu, TOURS };
})();
Tour.init();
