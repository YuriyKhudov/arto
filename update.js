// Обновление Arto из репозитория GitHub.
// Проверка: файл VERSION в ветке main. Установка: архив ветки → замена файлов программы.
// Работы (data/), модели, библиотеки и личные настройки (data/local.json) не трогаются.
//   node update.js          — проверить и установить
//   node update.js --check  — только проверить
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const KEEP = new Set(['data', 'models', 'node_modules', 'runtime', 'engine', '.git', '.claude']);

function config() {
  const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return {}; } };
  return { ...read(path.join(ROOT, 'atelier.config.json')).update, ...read(path.join(ROOT, 'data', 'local.json')).update };
}

const localVersion = () => { try { return fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim(); } catch { return '0.0.0'; } };
const newer = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

async function check() {
  const { repo, branch = 'main' } = config();
  if (!repo) return { available: false, current: localVersion(), reason: 'Адрес обновлений не настроен' };
  const raw = `https://raw.githubusercontent.com/${repo}/${branch}`;
  const res = await fetch(`${raw}/VERSION?t=${Date.now()}`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Не удалось проверить обновления (${res.status})`);
  const latest = (await res.text()).trim();
  let notes = '';
  try {
    const ch = await (await fetch(`${raw}/CHANGELOG.md?t=${Date.now()}`, { signal: AbortSignal.timeout(10000) })).text();
    notes = (ch.split(/\n(?=## )/).find((s) => s.startsWith('## ')) || '').trim();
  } catch {}
  return { available: newer(latest, localVersion()), current: localVersion(), latest, notes };
}

function copyTree(src, dst) {
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) { fs.mkdirSync(d, { recursive: true }); copyTree(s, d); }
    else fs.copyFileSync(s, d);
  }
}

async function apply(log = console.log) {
  const info = await check();
  if (!info.available) { log(`У вас последняя версия (${info.current}).`); return info; }
  const { repo, branch = 'main' } = config();
  const tmp = path.join(ROOT, 'data', 'update');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });

  log(`Скачиваю версию ${info.latest}…`);
  const res = await fetch(`https://codeload.github.com/${repo}/zip/refs/heads/${branch}`, { signal: AbortSignal.timeout(300000) });
  if (!res.ok) throw new Error(`Не удалось скачать обновление (${res.status})`);
  const zip = path.join(tmp, 'arto.zip');
  fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', tmp]);
  const top = fs.readdirSync(tmp, { withFileTypes: true }).find((e) => e.isDirectory());
  if (!top) throw new Error('Архив обновления пустой');
  const src = path.join(tmp, top.name);

  const oldPkg = fs.existsSync(path.join(ROOT, 'package.json')) ? fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8') : '';
  log('Обновляю файлы программы…');
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (KEEP.has(e.name)) continue;
    const s = path.join(src, e.name), d = path.join(ROOT, e.name);
    if (e.isDirectory()) { fs.mkdirSync(d, { recursive: true }); copyTree(s, d); }
    else fs.copyFileSync(s, d);
  }

  if (fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8') !== oldPkg) {
    log('Обновляю библиотеки…');
    const npm = fs.existsSync(path.join(ROOT, 'runtime', 'npm.cmd')) ? path.join(ROOT, 'runtime', 'npm.cmd') : 'npm.cmd';
    execFileSync(npm, ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: ROOT, stdio: 'inherit', shell: true });
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  log(`Готово: Arto обновлён до версии ${info.latest}.`);
  return { ...info, updated: true };
}

module.exports = { check, apply, localVersion };

if (require.main === module) {
  (process.argv.includes('--check') ? check().then((i) => console.log(i)) : apply())
    .catch((e) => { console.error('Ошибка обновления:', e.message); process.exit(1); });
}
