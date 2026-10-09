// Связь с ComfyUI: он работает в фоне как «двигатель», пользователь его не видит.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CLIENT_ID = crypto.randomUUID();

class Comfy {
  constructor(cfg) {
    this.url = (cfg.url || 'http://127.0.0.1:8188').replace(/\/$/, '');
    this.path = cfg.path || '';
    this.args = cfg.args || [];
    this.status = 'starting'; // starting | ready | error
    this.message = 'Двигатель запускается…';
    this.proc = null;
  }

  async ping() {
    try {
      const r = await fetch(this.url + '/system_stats', { signal: AbortSignal.timeout(3000) });
      return r.ok;
    } catch { return false; }
  }

  // Если ComfyUI не запущен — запускаем его скрыто, без окна и без браузера.
  async ensureRunning() {
    if (await this.ping()) return this.setReady();
    if (!this.path) return this.setError('ComfyUI не найден. Запустите установку заново.');
    const py = path.join(this.path, 'python_embeded', 'python.exe');
    if (!fs.existsSync(py)) return this.setError(`Не найден ${py}`);
    const port = new URL(this.url).port || '8188';
    const logFile = fs.openSync(path.join(__dirname, 'data', 'engine.log'), 'w');
    this.proc = spawn(py, ['-s', 'ComfyUI/main.py', '--windows-standalone-build', '--disable-auto-launch', '--port', port, ...this.args], {
      cwd: this.path, windowsHide: true, stdio: ['ignore', logFile, logFile],
    });
    this.proc.on('exit', (code) => {
      this.proc = null;
      if (this.status !== 'ready') this.setError(`Двигатель остановился (код ${code}). Подробности: data/engine.log`);
      else { this.status = 'starting'; this.message = 'Двигатель перезапускается…'; this.ensureRunning(); }
    });
    this.message = 'Двигатель запускается… (первый раз до минуты)';
    for (let i = 0; i < 300; i++) {
      await sleep(1000);
      if (await this.ping()) return this.setReady();
      if (!this.proc) return;
    }
    this.setError('Двигатель не ответил за 5 минут. Подробности: data/engine.log');
  }

  setReady() { this.status = 'ready'; this.message = 'Готов к работе'; this.connectWs(); }

  // Канал событий ComfyUI: прогресс шагов для шкалы с процентами
  connectWs() {
    if (this.ws || typeof WebSocket === 'undefined') return;
    this.listeners = this.listeners || new Map();
    const ws = new WebSocket(this.url.replace(/^http/, 'ws') + '/ws?clientId=' + CLIENT_ID);
    this.ws = ws;
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      const cb = m.data?.prompt_id && this.listeners.get(m.data.prompt_id);
      if (!cb) return;
      if (m.type === 'progress') cb({ type: 'progress', value: m.data.value, max: m.data.max });
      else if (m.type === 'executing') cb({ type: 'executing', node: m.data.node });
    };
    ws.onerror = () => {};
    ws.onclose = () => { this.ws = null; setTimeout(() => this.connectWs(), 2000); };
  }
  setError(m) { this.status = 'error'; this.message = m; }

  stop() { if (this.proc) this.proc.kill(); }

  // Прервать то, что рисуется прямо сейчас
  async interrupt() {
    try { await fetch(this.url + '/interrupt', { method: 'POST' }); } catch {}
  }

  async listModels(folder) {
    const r = await fetch(`${this.url}/models/${folder}`);
    return r.ok ? r.json() : [];
  }

  // Имя модели так, как его знает ComfyUI (на Windows там обратные слэши)
  async resolve(folder, name) {
    if (!name) return name;
    const norm = (s) => s.replace(/\\/g, '/').toLowerCase();
    const list = await this.listModels(folder);
    return list.find((x) => norm(x) === norm(name)) || list.find((x) => norm(x).endsWith('/' + norm(name).split('/').pop())) || null;
  }

  async upload(buf, name) {
    const fd = new FormData();
    fd.append('image', new Blob([buf]), name);
    fd.append('subfolder', 'atelier');
    fd.append('overwrite', 'true');
    const r = await fetch(this.url + '/upload/image', { method: 'POST', body: fd });
    if (!r.ok) throw new Error('Не удалось передать картинку двигателю');
    const j = await r.json();
    return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
  }

  // Отправить граф и дождаться картинки
  async run(workflow, { onProgress, timeoutMs = 15 * 60000 } = {}) {
    try { return await this.runInner(workflow, onProgress, timeoutMs); } finally { if (this.lastId) this.listeners?.delete(this.lastId); }
  }

  async runInner(workflow, onProgress, timeoutMs) {
    const r = await fetch(this.url + '/prompt', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: CLIENT_ID }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const nodeErr = Object.values(j.node_errors || {})[0]?.errors?.[0];
      throw new Error(nodeErr ? `${nodeErr.message}: ${nodeErr.details}` : j.error?.message || `Ошибка двигателя ${r.status}`);
    }
    const id = j.prompt_id;
    this.lastId = id;
    if (onProgress && this.listeners) this.listeners.set(id, onProgress);
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      await sleep(700);
      const h = await (await fetch(`${this.url}/history/${id}`)).json().catch(() => ({}));
      const item = h[id];
      if (!item) continue;
      if (item.status?.status_str === 'error') {
        const msg = item.status.messages?.find((m) => m[0] === 'execution_error')?.[1];
        throw new Error(msg ? `${msg.exception_type}: ${msg.exception_message}`.slice(0, 400) : 'Ошибка при рисовании');
      }
      if (!item.status?.completed) continue;
      for (const out of Object.values(item.outputs || {})) {
        const img = out.images?.[0];
        if (!img) continue;
        const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder || '', type: img.type || 'output' });
        const res = await fetch(`${this.url}/view?${q}`);
        return Buffer.from(await res.arrayBuffer());
      }
      throw new Error('Двигатель не вернул изображение');
    }
    throw new Error('Слишком долго — превышено время ожидания');
  }
}

// ---------- графы ----------
// Генерация (SD 1.5 / SDXL): текст → картинка, или картинка-основа → картинка
function wfGenerate(o) {
  const w = {
    ckpt: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: o.ckpt } },
  };
  let model = ['ckpt', 0];
  let clip = ['ckpt', 1];
  (o.loras || []).forEach((l, i) => {
    w['lora' + i] = { class_type: 'LoraLoader', inputs: { model, clip, lora_name: l.name, strength_model: l.strength, strength_clip: l.strength } };
    model = ['lora' + i, 0];
    clip = ['lora' + i, 1];
  });
  // Стиль с картинок (аналог --sref): IP-Adapter в режиме «перенос стиля» — берёт манеру, не содержимое
  if (o.styleRefs?.length && o.style) {
    const s = o.style;
    w.cv = { class_type: 'CLIPVisionLoader', inputs: { clip_name: s.clipVision } };
    w.ipa = { class_type: 'IPAdapterModelLoader', inputs: { ipadapter_file: s.ipadapter } };
    // каждый образец — свой адаптер со своим «влиянием»; общий вес делим, чтобы сумма не пересиливала промпт
    const refs = o.styleRefs.map((name, i) => ({ name, w: o.styleWeights?.[i] ?? 1 })).filter((r) => r.w > 0);
    const k = (o.styleWeight ?? 1) / Math.sqrt(Math.max(1, refs.length));
    refs.forEach((r, i) => {
      w['sl' + i] = { class_type: 'LoadImage', inputs: { image: r.name } };
      w['sp' + i] = { class_type: 'PrepImageForClipVision', inputs: { image: ['sl' + i, 0], interpolation: 'LANCZOS', crop_position: 'center', sharpening: 0 } };
      w['ipadv' + i] = {
        class_type: 'IPAdapterAdvanced',
        inputs: {
          model, ipadapter: ['ipa', 0], image: ['sp' + i, 0], clip_vision: ['cv', 0],
          weight: +(k * r.w).toFixed(3), weight_type: s.weightType || 'style transfer',
          combine_embeds: 'concat', start_at: 0, end_at: 1, embeds_scaling: 'V only',
        },
      };
      model = ['ipadv' + i, 0];
    });
  }
  w.pos = { class_type: 'CLIPTextEncode', inputs: { clip, text: o.prompt } };
  w.neg = { class_type: 'CLIPTextEncode', inputs: { clip, text: o.negative || '' } };
  let latent;
  if (o.refImage) {
    w.load = { class_type: 'LoadImage', inputs: { image: o.refImage } };
    w.scale = { class_type: 'ImageScale', inputs: { image: ['load', 0], upscale_method: 'lanczos', width: o.width, height: o.height, crop: 'center' } };
    w.enc = { class_type: 'VAEEncode', inputs: { pixels: ['scale', 0], vae: ['ckpt', 2] } };
    latent = ['enc', 0];
  } else {
    w.empty = { class_type: 'EmptyLatentImage', inputs: { width: o.width, height: o.height, batch_size: 1 } };
    latent = ['empty', 0];
  }
  w.sample = {
    class_type: 'KSampler',
    inputs: {
      model, positive: ['pos', 0], negative: ['neg', 0], latent_image: latent,
      seed: o.seed, steps: o.steps, cfg: o.cfg, sampler_name: o.sampler, scheduler: o.scheduler,
      denoise: o.refImage ? o.denoise : 1,
    },
  };
  w.decode = { class_type: 'VAEDecode', inputs: { samples: ['sample', 0], vae: ['ckpt', 2] } };
  w.save = { class_type: 'SaveImage', inputs: { images: ['decode', 0], filename_prefix: 'atelier/gen' } };
  return w;
}

// Увеличение ×2 моделью-апскейлером
function wfUpscale(o) {
  return {
    load: { class_type: 'LoadImage', inputs: { image: o.image } },
    um: { class_type: 'UpscaleModelLoader', inputs: { model_name: o.model } },
    up: { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: ['um', 0], image: ['load', 0] } },
    save: { class_type: 'SaveImage', inputs: { images: ['up', 0], filename_prefix: 'atelier/up' } },
  };
}

// Редактирование по команде (Qwen-Image-Edit 2511 — аналог Nano Banana)
function wfEdit(o) {
  const e = o.edit;
  const w = {
    unet: { class_type: 'UNETLoader', inputs: { unet_name: e.unet, weight_dtype: e.dtype || 'default' } },
    clip: { class_type: 'CLIPLoader', inputs: { clip_name: e.clip, type: 'qwen_image' } },
    vae: { class_type: 'VAELoader', inputs: { vae_name: e.vae } },
  };
  let model = ['unet', 0];
  if (e.lora) {
    w.lora = { class_type: 'LoraLoaderModelOnly', inputs: { model, lora_name: e.lora, strength_model: 1 } };
    model = ['lora', 0];
  }
  w.shift = { class_type: 'ModelSamplingAuraFlow', inputs: { model, shift: 3.1 } };
  w.norm = { class_type: 'CFGNorm', inputs: { model: ['shift', 0], strength: 1 } };
  const imgs = {};
  o.images.forEach((name, i) => {
    w['load' + i] = { class_type: 'LoadImage', inputs: { image: name } };
    w['px' + i] = { class_type: 'ImageScaleToTotalPixels', inputs: { image: ['load' + i, 0], upscale_method: 'lanczos', megapixels: e.megapixels || 1, resolution_steps: 8 } };
    imgs['image' + (i + 1)] = ['px' + i, 0];
  });
  w.pos = { class_type: 'TextEncodeQwenImageEditPlus', inputs: { clip: ['clip', 0], prompt: o.instruction, vae: ['vae', 0], ...imgs } };
  w.neg = { class_type: 'TextEncodeQwenImageEditPlus', inputs: { clip: ['clip', 0], prompt: '', vae: ['vae', 0], ...imgs } };
  w.posR = { class_type: 'FluxKontextMultiReferenceLatentMethod', inputs: { conditioning: ['pos', 0], reference_latents_method: 'index_timestep_zero' } };
  w.negR = { class_type: 'FluxKontextMultiReferenceLatentMethod', inputs: { conditioning: ['neg', 0], reference_latents_method: 'index_timestep_zero' } };
  w.enc = { class_type: 'VAEEncode', inputs: { pixels: ['px0', 0], vae: ['vae', 0] } };
  w.sample = {
    class_type: 'KSampler',
    inputs: {
      model: ['norm', 0], positive: ['posR', 0], negative: ['negR', 0], latent_image: ['enc', 0],
      seed: o.seed, steps: e.steps || 4, cfg: e.cfg || 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1,
    },
  };
  w.decode = { class_type: 'VAEDecode', inputs: { samples: ['sample', 0], vae: ['vae', 0] } };
  w.save = { class_type: 'SaveImage', inputs: { images: ['decode', 0], filename_prefix: 'atelier/edit' } };
  return w;
}

module.exports = { Comfy, wfGenerate, wfUpscale, wfEdit };
