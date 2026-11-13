import { generate, hitTest } from './collage.js';
const $ = selector => document.querySelector(selector);
const canvas = $('#canvas'), ctx = canvas.getContext('2d'), form = $('#settings-form');
let state, items = [], selected = null, filter = 'active', limit = 80, images = new Map(), undo = [], drag, saveQueue = Promise.resolve(), toastTimer, polling = false, wheelTimer, loading = false;
const numeric = ['width', 'height', 'rotation', 'scatter', 'border', 'shadow'];
async function api(path, data) {
  const response = await fetch(`/api/${path}`, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Ошибка сервера');
  return result;
}
function toast(message, error = false) { const el = $('#toast'); el.textContent = message; el.classList.toggle('error', error); el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => el.hidden = true, error ? 9000 : 4000); }
function report(error) { toast(error.message, true); }
function action(fn) { return async event => { try { await fn(event); } catch (e) { report(e); } }; }
function save(path, value) {
  const snapshot = structuredClone(value);
  const result = saveQueue.catch(() => {}).then(() => api(path, snapshot));
  saveQueue = result;
  result.catch(error => report(new Error(`Не удалось сохранить изменения: ${error.message}`)));
  return result;
}
function persistLayout() { return save('layout', { items }); }
function checkpoint() { undo.push(structuredClone(items)); if (undo.length > 50) undo.shift(); $('#undo').disabled = false; }
function available() { return state.photos.filter(p => p.available && !state.exclusions.includes(p.id) && (p.source === 'local' || p.community === state.settings.community)); }
function visibleItems() { const ids = new Set(available().map(p => p.id)); return items.filter(i => ids.has(i.id)); }
function readSettings() {
  const next = { ...state.settings };
  for (const name of numeric) next[name] = Number(form.elements[name].value);
  const size = Number(form.elements.photoSize.value), deviation = Number(form.elements.sizeDeviation.value);
  next.minSize = size - deviation;
  next.maxSize = size + deviation;
  next.count = 0;
  next.background = form.elements.background.value;
  if (!form.reportValidity()) throw new Error('Проверьте параметры композиции');
  if (next.minSize > next.maxSize) throw new Error('Минимальный размер должен быть не больше максимального');
  if (next.width * next.height > 32_000_000) throw new Error('Холст не должен превышать 32 мегапикселя');
  return next;
}
function fillForm() {
  for (const [name, value] of Object.entries(state.settings)) if (form.elements[name]) form.elements[name].value = value;
  form.elements.photoSize.value = Math.round((state.settings.minSize + state.settings.maxSize) / 2);
  form.elements.sizeDeviation.max = 1990;
  form.elements.sizeDeviation.value = Math.round((state.settings.maxSize - state.settings.minSize) / 2);
  updateLabels();
}
function updateLabels() {
  const size = Number(form.elements.photoSize.value);
  form.elements.sizeDeviation.max = Math.min(size - 20, 4000 - size);
  $('#photo-size-out').textContent = `${size} px`;
  $('#size-deviation-out').textContent = `±${form.elements.sizeDeviation.value} px`;
  $('#border-out').textContent = `${form.elements.border.value} px`;
  $('#shadow-out').textContent = `${form.elements.shadow.value} px`;
  $('#rotation-out').textContent = `±${form.elements.rotation.value}°`;
  $('#scatter-out').textContent = `${form.elements.scatter.value}%`;
  const preset = `${form.elements.width.value},${form.elements.height.value}`;
  $('#preset').value = ['1920,768', '1590,400'].includes(preset) ? preset : 'custom';
}
async function updateSettings(overrides = {}) {
  const next = { ...readSettings(), ...overrides };
  await save('settings', next);
  state.settings = next;
  updateLabels(); draw();
}
async function loadImages() {
  loading = true;
  const needed = new Set(visibleItems().map(item => item.id));
  for (const [id, bitmap] of images) if (!needed.has(id)) { bitmap.close(); images.delete(id); }
  const photos = available().filter(photo => needed.has(photo.id)); let index = 0;
  const worker = async () => {
    while (index < photos.length) {
      const photo = photos[index++];
      if (images.has(photo.id)) continue;
      try {
        const response = await fetch(photo.src);
        if (!response.ok) throw new Error();
        const blob = await response.blob();
        let bitmap = await createImageBitmap(blob);
        if (Math.max(bitmap.width, bitmap.height) > 1200) {
          const factor = 1200 / Math.max(bitmap.width, bitmap.height);
          const reduced = await createImageBitmap(bitmap, { resizeWidth: Math.round(bitmap.width * factor), resizeHeight: Math.round(bitmap.height * factor), resizeQuality: 'high' });
          bitmap.close(); bitmap = reduced;
        }
        images.set(photo.id, bitmap);
      } catch { photo.available = false; }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker)); loading = false;
}
async function refresh() {
  const fresh = await api('state'); state = fresh; items = fresh.layout.items;
  fillForm(); await loadImages(); renderLibrary(); draw(); updateSelection();
  $('#sync').disabled = fresh.sync.running;
  if (fresh.sync.running) pollSync();
}
function paint(context, width, height, drawSelection = false, imageMap = images) {
  const s = state.settings;
  context.clearRect(0, 0, width, height); context.fillStyle = s.background; context.fillRect(0, 0, width, height);
  for (const item of visibleItems()) {
    const image = imageMap.get(item.id); if (!image) continue;
    const h = item.width * image.height / image.width;
    context.save(); context.translate(item.x, item.y); context.rotate(item.angle * Math.PI / 180);
    context.shadowColor = '#15200d42'; context.shadowBlur = s.shadow; context.shadowOffsetY = s.shadow * .3;
    context.fillStyle = '#fff'; context.fillRect(-item.width / 2 - s.border, -h / 2 - s.border, item.width + s.border * 2, h + s.border * 2);
    context.shadowColor = 'transparent'; context.drawImage(image, -item.width / 2, -h / 2, item.width, h);
    if (drawSelection && item.id === selected) {
      const scale = canvas.width / canvas.clientWidth;
      context.strokeStyle = '#86a33e'; context.lineWidth = 2 * scale;
      context.strokeRect(-item.width / 2 - s.border, -h / 2 - s.border, item.width + s.border * 2, h + s.border * 2);
      context.fillStyle = '#d7f578'; const size = 7 * scale;
      for (const x of [-item.width / 2 - s.border, item.width / 2 + s.border]) for (const y of [-h / 2 - s.border, h / 2 + s.border]) context.fillRect(x - size / 2, y - size / 2, size, size);
    }
    context.restore();
  }
}
function draw() {
  canvas.width = state.settings.width; canvas.height = state.settings.height;
  paint(ctx, canvas.width, canvas.height, true);
  $('#empty').hidden = visibleItems().length > 0;
  $('#canvas-count').textContent = visibleItems().length;
  $('#dimensions').textContent = `${canvas.width} × ${canvas.height}`;
  $('#export').disabled = !visibleItems().length || loading;
  $('#undo').disabled = !undo.length;
}
function updateSelection() {
  const item = visibleItems().find(i => i.id === selected);
  $('#selection-controls').hidden = !item;
  $('.selection-title').textContent = item ? 'Выбранный кадр' : 'Выберите кадр на холсте';
  if (item) { $('#item-width').value = Math.round(item.width); $('#item-angle').value = Math.round(item.angle); }
}
function renderLibrary() {
  const excluded = new Set(state.exclusions), pool = state.photos.filter(p => p.source === 'local' || p.community === state.settings.community);
  $('#library-count').textContent = pool.length;
  $('#active-count').textContent = pool.filter(p => !excluded.has(p.id) && p.available).length;
  $('#excluded-count').textContent = state.exclusions.length;
  $('#missing-count').textContent = pool.filter(p => !p.available && !excluded.has(p.id)).length;
  const known = new Set(pool.map(p => p.id));
  const excludedStubs = state.exclusions.filter(id => !known.has(id)).map(id => ({ id, title: id, available: false }));
  const search = $('#search').value.toLowerCase();
  const list = [...pool, ...(filter === 'excluded' ? excludedStubs : [])].filter(p => (filter === 'excluded' ? excluded.has(p.id) : filter === 'missing' ? !p.available && !excluded.has(p.id) : p.available && !excluded.has(p.id)) && `${p.title} ${p.id}`.toLowerCase().includes(search));
  const grid = $('#library-grid'); grid.replaceChildren();
  for (const photo of list.slice(0, limit)) {
    const card = document.createElement('div'); card.className = `photo-card${excluded.has(photo.id) ? ' excluded' : ''}${selected === photo.id ? ' selected' : ''}`;
    const choose = document.createElement('button'); choose.className = 'photo-image'; choose.title = photo.available ? 'Выбрать на холсте или добавить в композицию' : 'Нет файла в кеше: выполните синхронизацию или импортируйте снова'; choose.setAttribute('aria-label', photo.title); choose.disabled = !photo.available || excluded.has(photo.id);
    if (photo.available) { const img = document.createElement('img'); img.src = photo.src; img.loading = 'lazy'; img.alt = photo.title; choose.append(img); } else choose.textContent = 'Нет файла';
    choose.onclick = action(async () => {
      if (!items.some(i => i.id === photo.id)) { checkpoint(); items.push({ id: photo.id, x: canvas.width / 2, y: canvas.height / 2, width: state.settings.maxSize, angle: 0 }); await loadImages(); await persistLayout(); }
      selected = photo.id; draw(); updateSelection(); renderLibrary();
    });
    const toggle = document.createElement('button'); toggle.className = 'photo-toggle'; toggle.textContent = excluded.has(photo.id) ? '↶' : '×'; toggle.title = excluded.has(photo.id) ? 'Вернуть в генерацию' : 'Исключить из будущих генераций'; toggle.setAttribute('aria-label', toggle.title); toggle.onclick = action(() => toggleExclusion(photo.id));
    const name = document.createElement('span'); name.className = 'photo-name'; name.textContent = photo.title; name.title = photo.title;
    card.append(choose, toggle, name); grid.append(card);
  }
  $('#load-more').hidden = list.length <= limit;
  $('#library-empty').hidden = list.length > 0;
  $('#library-empty').textContent = filter === 'excluded' ? 'Исключённых кадров нет. Нажмите × на фото, чтобы больше не использовать его в генерациях.' : filter === 'missing' ? 'Все файлы на месте.' : pool.length ? 'Ничего не найдено.' : 'Здесь будет ваша коллекция. Добавьте файлы или подключите VK — фотографии сохранятся на компьютере.';
  document.querySelectorAll('.filter').forEach(b => b.classList.toggle('active', b.dataset.filter === filter));
}
async function toggleExclusion(id) {
  const restoring = state.exclusions.includes(id);
  const next = restoring ? state.exclusions.filter(p => p !== id) : [...state.exclusions, id];
  await save('exclusions', next); state.exclusions = next;
  if (selected === id) selected = null;
  if (restoring) await loadImages();
  renderLibrary(); draw(); updateSelection();
  toast(restoring ? 'Кадр снова участвует в генерации' : 'Кадр исключён. Вернуть его можно во вкладке «Исключённые».');
}
async function shuffle() {
  if (loading) throw new Error('Дождитесь загрузки изображений');
  if (!available().length) throw new Error('Сначала добавьте фотографии');
  const seed = (state.settings.seed + 1 + Math.floor(Math.random() * 2147483647)) % 2147483648;
  await updateSettings({ seed });
  checkpoint(); items = generate(available(), state.settings); selected = null;
  await loadImages(); draw(); updateSelection(); renderLibrary(); await persistLayout();
}
form.addEventListener('submit', e => e.preventDefault());
form.addEventListener('input', event => { if (event.target.id !== 'preset') updateLabels(); });
form.addEventListener('change', action(async e => {
  if (e.target.id === 'preset') {
    if (e.target.value === 'custom') return;
    [form.elements.width.value, form.elements.height.value] = e.target.value.split(',');
  }
  await updateSettings();
}));
$('#generate').onclick = action(() => shuffle());
function point(event) { const rect = canvas.getBoundingClientRect(); return { x: (event.clientX - rect.left) * canvas.width / rect.width, y: (event.clientY - rect.top) * canvas.height / rect.height }; }
canvas.onpointerdown = event => {
  if (event.button !== 0) return;
  const p = point(event), item = [...visibleItems()].reverse().find(i => { const image = images.get(i.id); return image && hitTest(i, image.height / image.width, p.x, p.y, state.settings.border); });
  selected = item?.id || null;
  if (item) { checkpoint(); drag = { item, x: p.x - item.x, y: p.y - item.y }; canvas.setPointerCapture(event.pointerId); }
  draw(); updateSelection(); renderLibrary();
};
canvas.onpointermove = event => { if (!drag) return; const p = point(event); drag.item.x = Math.max(-10000, Math.min(20000, p.x - drag.x)); drag.item.y = Math.max(-10000, Math.min(20000, p.y - drag.y)); draw(); };
const endDrag = action(async () => { if (drag) { drag = null; await persistLayout(); } });
canvas.onpointerup = endDrag; canvas.onpointercancel = endDrag;
canvas.addEventListener('wheel', event => {
  const item = items.find(i => i.id === selected); if (!item) return;
  event.preventDefault(); if (!wheelTimer) checkpoint();
  if (event.shiftKey) item.angle = (item.angle + Math.sign(event.deltaY) * 2) % 360;
  else item.width = Math.max(10, Math.min(10000, item.width * (event.deltaY > 0 ? .95 : 1.05)));
  draw(); updateSelection(); clearTimeout(wheelTimer); wheelTimer = setTimeout(() => { wheelTimer = null; persistLayout().catch(() => {}); }, 250);
}, { passive: false });
async function editSelected(fn) { const item = items.find(i => i.id === selected); if (!item) return; checkpoint(); fn(item); draw(); updateSelection(); await persistLayout(); }
for (const key of ['width', 'angle']) $(`#item-${key}`).onchange = action(event => {
  if (!event.target.reportValidity()) return;
  return editSelected(item => item[key] = Number(event.target.value));
});
$('#to-front').onclick = action(() => editSelected(item => { items = items.filter(i => i !== item); items.push(item); }));
$('#to-back').onclick = action(() => editSelected(item => { items = items.filter(i => i !== item); items.unshift(item); }));
$('#remove').onclick = action(() => editSelected(item => { items = items.filter(i => i !== item); selected = null; }));
$('#exclude-selected').onclick = action(() => selected && toggleExclusion(selected));
$('#undo').onclick = action(async () => { if (!undo.length) return; items = undo.pop(); selected = null; await loadImages(); draw(); updateSelection(); await persistLayout(); });
window.addEventListener('keydown', event => {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName) || $('#connect-dialog').open) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); $('#undo').click(); }
  if (event.key === 'Delete' && selected) { event.preventDefault(); $('#remove').click(); }
  if (event.key === 'Escape') { selected = null; draw(); updateSelection(); }
});
$('#export').onclick = action(async () => {
  const button = $('#export'); button.disabled = true; button.textContent = 'Готовим PNG…';
  try {
    await saveQueue; await persistLayout();
    const exportItems = structuredClone(visibleItems()), s = structuredClone(state.settings);
    // Export originals one at a time to keep memory bounded, even for a large archive.
    const output = document.createElement('canvas'); output.width = s.width; output.height = s.height;
    const context = output.getContext('2d'); context.fillStyle = s.background; context.fillRect(0, 0, output.width, output.height);
    for (const item of exportItems) {
      const photo = state.photos.find(p => p.id === item.id), response = await fetch(photo.src);
      if (!response.ok) throw new Error('В кеше отсутствует фото. Синхронизируйте библиотеку перед экспортом.');
      const image = await createImageBitmap(await response.blob());
      const h = item.width * image.height / image.width;
      context.save(); context.translate(item.x, item.y); context.rotate(item.angle * Math.PI / 180);
      context.shadowColor = '#15200d42'; context.shadowBlur = s.shadow; context.shadowOffsetY = s.shadow * .3;
      context.fillStyle = '#fff'; context.fillRect(-item.width / 2 - s.border, -h / 2 - s.border, item.width + s.border * 2, h + s.border * 2);
      context.shadowColor = 'transparent'; context.drawImage(image, -item.width / 2, -h / 2, item.width, h); context.restore(); image.close();
    }
    const blob = await new Promise(resolve => output.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Браузер не смог создать PNG. Попробуйте меньший размер.');
    const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = `kero-header-${s.seed}-${s.width}x${s.height}.png`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000); toast('Обложка готова. PNG передан в загрузки браузера.');
  } finally { button.disabled = false; button.textContent = 'Скачать PNG ↗'; }
});
document.querySelectorAll('.filter').forEach(b => b.onclick = () => { filter = b.dataset.filter; limit = 80; renderLibrary(); });
$('#search').oninput = () => { limit = 80; renderLibrary(); }; $('#load-more').onclick = () => { limit += 80; renderLibrary(); };
for (const id of ['import', 'empty-import']) $(`#${id}`).onclick = () => $('#file-input').click();
$('#file-input').onchange = action(async event => {
  const files = [...event.target.files]; if (!files.length) return;
  $('#import').disabled = true; let imported = 0; const errors = [];
  try {
    await saveQueue;
    for (const file of files) {
      toast(`Импорт ${imported + errors.length + 1} / ${files.length}: ${file.name}`);
      try {
        if (file.size > 30_000_000) throw new Error('больше 30 МБ');
        const bitmap = await createImageBitmap(file); bitmap.close();
        const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = reject; reader.readAsDataURL(file); });
        await api('import', { name: file.name, data }); imported++;
      } catch (e) { errors.push(`${file.name}: ${e.message || 'не удалось прочитать изображение'}`); }
    }
    await refresh(); if (!items.length && available().length) await shuffle();
    toast(`Добавлено: ${imported}.${errors.length ? ` Ошибки: ${errors.join('; ')}` : ''}`, Boolean(errors.length));
  } finally { $('#import').disabled = false; event.target.value = ''; }
});
function openConnection() {
  const f = $('#connect-form'); f.elements.community.value = `https://vk.ru/${state.settings.community}`; f.elements.source.value = state.settings.source; f.elements.token.value = '';
  f.elements.token.placeholder = state.hasToken ? 'Токен уже задан. Оставьте пустым, чтобы сохранить.' : 'Вставьте токен VK'; $('#connect-dialog').showModal();
}
$('#connection').onclick = openConnection; $('#close-dialog').onclick = () => $('#connect-dialog').close();
$('#connect-form').onsubmit = action(async event => {
  event.preventDefault(); const f = event.target;
  const next = await save('settings', { ...state.settings, community: f.elements.community.value, source: f.elements.source.value });
  state.settings = next;
  if (f.elements.token.value.trim()) { await api('token', { token: f.elements.token.value }); state.hasToken = true; f.elements.token.value = ''; }
  $('#connect-dialog').close(); renderLibrary(); draw(); toast('Подключение сохранено. Теперь можно синхронизировать фотографии.');
});
$('#forget-token').onclick = action(async () => { await api('token', { token: '' }); state.hasToken = false; $('#connect-form').elements.token.value = ''; $('#connect-form').elements.token.placeholder = 'Вставьте токен VK'; toast('Токен удалён из памяти сервера. Если он задан в .env, удалите его и там.'); });
$('#sync').onclick = action(async () => { if (!state.hasToken) { openConnection(); return; } await saveQueue; await api('sync', {}); pollSync(); });
async function pollSync() {
  if (polling) return; polling = true; $('#sync').disabled = true;
  try {
    while (true) {
      const progress = await api('sync'), el = $('#sync-status'); el.hidden = false; el.classList.toggle('error', Boolean(progress.error || progress.failed || progress.warnings.length)); el.textContent = progress.message + (progress.warnings?.length ? '\n' + progress.warnings.join('\n') : '');
      if (!progress.running) { await saveQueue; await refresh(); if (!items.length && available().length) await shuffle(); break; }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } catch (e) { report(e); } finally { polling = false; $('#sync').disabled = false; }
}
window.addEventListener('resize', () => state && draw());
await refresh().catch(report);
