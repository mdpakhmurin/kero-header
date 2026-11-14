import { generate, hitTest } from './collage.js';
import { photoSource } from './library.js';
import { createPhotoRenderer, previewDimensions, renderDimensions, smooth } from './render.js';
import { createHistory } from './history.js';
import { emptySpacePercent } from './coverage.js';
import { createPhotoViewer } from './viewer.js';
const $ = selector => document.querySelector(selector);
const canvas = $('#canvas'), ctx = canvas.getContext('2d'), form = $('#settings-form');
const preview = document.createElement('canvas'), photoRenderer = createPhotoRenderer();
const history = createHistory();
const photoViewer = createPhotoViewer($('#photo-viewer'));
let state, items = [], selected = null, filter = 'active', limit = 80, images = new Map(), drag, saveQueue = Promise.resolve(), toastTimer, polling = false, wheelTimer, loading = false, coverageTimer, coverageKey;
let savedSettings, settingsSaving = false;
const numeric = ['rotation', 'border', 'shadow'];
const numberInputs = [...form.querySelectorAll('input[data-range]')];
async function api(path, data) {
  const response = await fetch(`/api/${path}`, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Ошибка сервера');
  return result;
}
function toast(message, error = false) { const el = $('#toast'); el.textContent = message; el.classList.toggle('error', error); el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => el.hidden = true, error ? 9000 : 4000); }
function report(error) { toast(error.message, true); }
function syncMessage(progress) {
  return progress.message + (progress.warnings?.length ? '\n' + progress.warnings.join('\n') : '');
}
function action(fn) { return async event => { try { await fn(event); } catch (e) { report(e); } }; }
function save(path, value) {
  const snapshot = structuredClone(value);
  const result = saveQueue.catch(() => {}).then(() => api(path, snapshot));
  saveQueue = result;
  result.catch(error => report(new Error(`Не удалось сохранить изменения: ${error.message}`)));
  return result;
}
function checkpoint() { history.checkpoint(items); $('#undo').disabled = !history.canUndo; $('#redo').disabled = !history.canRedo; }
function available() { return state.photos.filter(p => p.available && !state.exclusions.includes(p.id) && (p.source === 'local' || p.community === state.settings.community)); }
function visibleItems() { const ids = new Set(available().map(p => p.id)); return items.filter(i => ids.has(i.id)); }
function readSettings() {
  const next = { ...state.settings };
  [next.width, next.height] = $('#preset').value.split(',').map(Number);
  for (const name of numeric) next[name] = Number(form.elements[name].value);
  next.photoSize = Number(form.elements.photoSize.value);
  next.sizeDeviation = Number(form.elements.sizeDeviation.value);
  next.count = 0;
  next.background = form.elements.background.value;
  if (!form.reportValidity()) throw new Error('Проверьте параметры композиции');
  if (next.width * next.height > 32_000_000) throw new Error('Холст не должен превышать 32 мегапикселя');
  return next;
}
function fillForm() {
  fillCoverSizes();
  for (const [name, value] of Object.entries(state.settings)) if (form.elements[name]) form.elements[name].value = value;
  form.elements.photoSize.value = state.settings.photoSize;
  form.elements.sizeDeviation.value = state.settings.sizeDeviation;
  updateLabels();
}
function updateLabels() {
  for (const input of numberInputs) {
    const range = form.elements[input.dataset.range];
    input.min = range.min; input.max = range.max; input.step = range.step || '1';
    input.value = range.value;
  }
}
function fillCoverSizes() {
  const select = $('#preset');
  select.replaceChildren();
  for (const size of state.settings.coverSizes) select.add(new Option(`${size.width} × ${size.height}`, `${size.width},${size.height}`));
  select.add(new Option('＋ Добавить размер…', 'custom'));
  select.value = `${state.settings.width},${state.settings.height}`;
}
function hasUnsavedSettings() {
  return savedSettings && JSON.stringify(state.settings) !== JSON.stringify(savedSettings);
}
function updateSaveStatus() {
  const dirty = hasUnsavedSettings(), button = $('#save-settings');
  button.disabled = !dirty || settingsSaving;
  button.textContent = settingsSaving ? 'Сохраняем…' : 'Сохранить настройки';
  $('#settings-save-status').textContent = dirty ? 'Есть несохранённые изменения' : 'Все изменения сохранены';
}
function updateSettings() {
  state.settings = readSettings();
  updateLabels(); draw(); updateSaveStatus();
}
async function loadImages(generationPhotos) {
  loading = true;
  const visible = new Set(visibleItems().map(item => item.id));
  const photos = generationPhotos ?? available().filter(photo => visible.has(photo.id));
  const needed = new Set(photos.map(photo => photo.id));
  for (const [id, bitmap] of images) if (!needed.has(id)) { photoRenderer.release(bitmap); bitmap.close(); images.delete(id); }
  let index = 0;
  const worker = async () => {
    while (index < photos.length) {
      const photo = photos[index++];
      const cached = images.get(photo.id);
      if (cached) { photo.width ||= cached.width; photo.height ||= cached.height; continue; }
      try {
        const response = await fetch(photo.src);
        if (!response.ok) throw new Error();
        const blob = await response.blob();
        let bitmap = await createImageBitmap(blob);
        photo.width = bitmap.width; photo.height = bitmap.height;
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
  const fresh = await api('state');
  const draft = state && hasUnsavedSettings() ? state.settings : null;
  savedSettings = structuredClone(fresh.settings); state = fresh;
  if (draft) state.settings = draft;
  fillForm(); updateSaveStatus(); await loadImages(); renderLibrary(); draw(); updateSelection();
  $('#sync').disabled = fresh.sync.running;
  if (fresh.sync.error) { const el = $('#sync-status'); el.hidden = false; el.classList.add('error'); el.textContent = syncMessage(fresh.sync); }
  if (fresh.sync.running) pollSync();
}
function paint(context, width, height, drawSelection = false, pixelScale = 1) {
  const s = state.settings;
  context.clearRect(0, 0, width, height); context.fillStyle = s.background; context.fillRect(0, 0, width, height);
  for (const item of visibleItems()) {
    const image = images.get(item.id); if (!image) continue;
    const h = item.width * image.height / image.width;
    photoRenderer.draw(context, item, image, s, pixelScale);
    if (drawSelection && item.id === selected) {
      const scale = width / canvas.clientWidth;
      context.save(); context.translate(item.x, item.y); context.rotate(item.angle * Math.PI / 180);
      context.strokeStyle = '#86a33e'; context.lineWidth = 2 * scale;
      context.strokeRect(-item.width / 2 - s.border, -h / 2 - s.border, item.width + s.border * 2, h + s.border * 2);
      context.fillStyle = '#d7f578'; const size = 7 * scale;
      for (const x of [-item.width / 2 - s.border, item.width / 2 + s.border]) for (const y of [-h / 2 - s.border, h / 2 + s.border]) context.fillRect(x - size / 2, y - size / 2, size, size);
      context.restore();
    }
  }
}
function draw() {
  const s = state.settings;
  canvas.style.aspectRatio = `${s.width} / ${s.height}`;
  const displaySize = previewDimensions(canvas.clientWidth || s.width, s.width, s.height, window.devicePixelRatio || 1);
  const renderSize = renderDimensions(displaySize.width, displaySize.height);
  if (canvas.width !== displaySize.width) canvas.width = displaySize.width;
  if (canvas.height !== displaySize.height) canvas.height = displaySize.height;
  if (preview.width !== renderSize.width) preview.width = renderSize.width;
  if (preview.height !== renderSize.height) preview.height = renderSize.height;
  const context = smooth(preview.getContext('2d'));
  context.setTransform(preview.width / s.width, 0, 0, preview.height / s.height, 0, 0);
  paint(context, s.width, s.height, true, preview.width / s.width);
  ctx.setTransform(1, 0, 0, 1, 0, 0); smooth(ctx);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(preview, 0, 0, canvas.width, canvas.height);
  $('#canvas-count').textContent = visibleItems().length;
  $('#dimensions').textContent = `${s.width} × ${s.height}`;
  $('#export').disabled = !visibleItems().length || loading;
  $('#undo').disabled = !history.canUndo;
  $('#redo').disabled = !history.canRedo;
  const visible = visibleItems();
  const key = JSON.stringify([s.width, s.height, s.border, visible.map(item => [item.id, item.x, item.y, item.width, item.angle, images.get(item.id)?.width, images.get(item.id)?.height])]);
  if (key !== coverageKey) {
    coverageKey = key; clearTimeout(coverageTimer);
    coverageTimer = setTimeout(() => {
      const empty = emptySpacePercent(visible, images, s);
      $('#empty-percentage').textContent = empty.toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    }, 60);
  }
}
function updateSelection() {
  const item = visibleItems().find(i => i.id === selected);
  $('#selection-controls').hidden = !item;
  $('.selection-title').textContent = item ? 'Выбранный кадр' : 'Выберите кадр на холсте';
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
    const source = photoSource(photo);
    const preview = document.createElement('button'); preview.type = 'button'; preview.className = 'photo-image';
    preview.disabled = !photo.available;
    preview.title = photo.available ? 'Посмотреть фото' : 'Нет файла в кеше: выполните синхронизацию или импортируйте снова';
    preview.setAttribute('aria-label', `Посмотреть фото: ${photo.title}`);
    preview.onclick = () => photoViewer.open(photo, list);
    if (photo.available) { const img = document.createElement('img'); img.src = photo.src; img.loading = 'lazy'; img.alt = photo.title; preview.append(img); } else preview.textContent = 'Нет файла';
    const choose = document.createElement('button'); choose.className = 'photo-toggle photo-add'; choose.type = 'button'; choose.textContent = '+'; choose.title = 'Выбрать на холсте или добавить в композицию'; choose.setAttribute('aria-label', `${choose.title}: ${photo.title}`); choose.disabled = !photo.available || excluded.has(photo.id);
    choose.onclick = action(async () => {
      if (!items.some(i => i.id === photo.id)) { checkpoint(); items.push({ id: photo.id, x: state.settings.width / 2, y: state.settings.height / 2, width: state.settings.photoSize, angle: 0 }); await loadImages(); }
      selected = photo.id; draw(); updateSelection(); renderLibrary();
    });
    const toggle = document.createElement('button'); toggle.className = 'photo-toggle'; toggle.textContent = excluded.has(photo.id) ? '↶' : '×'; toggle.title = excluded.has(photo.id) ? 'Вернуть в генерацию' : 'Исключить из будущих генераций'; toggle.setAttribute('aria-label', toggle.title); toggle.onclick = action(() => toggleExclusion(photo.id));
    card.append(preview, choose, toggle);
    if (source) {
      const link = document.createElement('a'); link.className = 'photo-toggle photo-source'; link.textContent = '↗';
      link.href = source.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.title = source.label;
      link.setAttribute('aria-label', `${source.label}: ${photo.title}`); card.append(link);
    }
    grid.append(card);
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
  updateSettings();
  const photos = available();
  await loadImages(photos);
  checkpoint(); items = generate(photos.filter(photo => photo.available), state.settings); selected = null;
  draw(); updateSelection(); renderLibrary();
}
form.addEventListener('submit', e => e.preventDefault());
form.addEventListener('input', action(event => {
  const input = event.target;
  if (input.id === 'preset') return;
  if (input.dataset.range) {
    if (!input.validity.valid) return;
    form.elements[input.dataset.range].value = input.value;
  }
  updateLabels(); updateSettings();
}));
form.addEventListener('change', action(e => {
  if (e.target.dataset.range && !e.target.reportValidity()) return;
  if (e.target.id === 'preset' && e.target.value === 'custom') {
    fillCoverSizes();
    const sizeForm = $('#size-form');
    sizeForm.elements.width.value = state.settings.width;
    sizeForm.elements.height.value = state.settings.height;
    sizeForm.elements.height.setCustomValidity('');
    $('#size-error').hidden = true;
    $('#size-dialog').showModal();
    sizeForm.elements.width.select();
    return;
  }
  updateSettings();
}));
$('#save-settings').onclick = action(async () => {
  updateSettings();
  const snapshot = structuredClone(state.settings);
  settingsSaving = true; updateSaveStatus();
  try {
    const saved = await save('settings', snapshot);
    savedSettings = structuredClone(saved);
    if (JSON.stringify(state.settings) === JSON.stringify(snapshot)) state.settings = saved;
    toast('Настройки сохранены.');
  } finally { settingsSaving = false; updateSaveStatus(); }
});
$('#close-size-dialog').onclick = $('#cancel-size').onclick = () => $('#size-dialog').close();
$('#size-form').oninput = event => {
  const sizeForm = event.currentTarget;
  sizeForm.elements.height.setCustomValidity(Number(sizeForm.elements.width.value) * Number(sizeForm.elements.height.value) > 32_000_000 ? 'Холст не должен превышать 32 мегапикселя' : '');
};
$('#size-form').onsubmit = action(event => {
  event.preventDefault();
  const sizeForm = event.currentTarget, button = sizeForm.querySelector('button[type="submit"]'), error = $('#size-error');
  const size = { width: Number(sizeForm.elements.width.value), height: Number(sizeForm.elements.height.value) };
  const coverSizes = state.settings.coverSizes.some(saved => saved.width === size.width && saved.height === size.height) ? state.settings.coverSizes : [...state.settings.coverSizes, size];
  button.disabled = true; error.hidden = true;
  try {
    if (coverSizes.length > 100) throw new Error('Можно добавить до 100 размеров обложки');
    state.settings = { ...readSettings(), ...size, coverSizes };
    fillCoverSizes(); updateLabels(); draw(); updateSaveStatus();
    $('#size-dialog').close(); toast('Размер выбран. Нажмите «Сохранить настройки», чтобы сохранить его.');
  } catch (e) { error.textContent = e.message; error.hidden = false; }
  finally { button.disabled = false; button.textContent = 'Добавить и выбрать'; }
});
$('#generate').onclick = action(() => shuffle());
function point(event) { const rect = canvas.getBoundingClientRect(); return { x: (event.clientX - rect.left) * state.settings.width / rect.width, y: (event.clientY - rect.top) * state.settings.height / rect.height }; }
canvas.onpointerdown = event => {
  if (event.button !== 0) return;
  const p = point(event), item = [...visibleItems()].reverse().find(i => { const image = images.get(i.id); return image && hitTest(i, image.height / image.width, p.x, p.y, state.settings.border); });
  selected = item?.id || null;
  if (item) { checkpoint(); drag = { item, x: p.x - item.x, y: p.y - item.y }; canvas.setPointerCapture(event.pointerId); }
  draw(); updateSelection(); renderLibrary();
};
canvas.onpointermove = event => { if (!drag) return; const p = point(event); drag.item.x = Math.max(-10000, Math.min(20000, p.x - drag.x)); drag.item.y = Math.max(-10000, Math.min(20000, p.y - drag.y)); draw(); };
const endDrag = () => { drag = null; };
canvas.onpointerup = endDrag; canvas.onpointercancel = endDrag;
canvas.addEventListener('wheel', event => {
  const item = items.find(i => i.id === selected); if (!item) return;
  event.preventDefault(); if (!wheelTimer) checkpoint();
  if (!event.shiftKey) item.angle = (item.angle + Math.sign(event.deltaY) * 4) % 360;
  else item.width = Math.max(10, Math.min(10000, item.width * (event.deltaY > 0 ? .95 : 1.05)));
  draw(); updateSelection(); clearTimeout(wheelTimer); wheelTimer = setTimeout(() => { wheelTimer = null; }, 250);
}, { passive: false });
async function editSelected(fn) { const item = items.find(i => i.id === selected); if (!item) return; checkpoint(); fn(item); draw(); updateSelection(); }
$('#to-front').onclick = action(() => editSelected(item => { items = items.filter(i => i !== item); items.push(item); }));
$('#to-back').onclick = action(() => editSelected(item => { items = items.filter(i => i !== item); items.unshift(item); }));
$('#remove').onclick = action(() => editSelected(item => { items = items.filter(i => i !== item); selected = null; }));
$('#exclude-selected').onclick = action(() => selected && toggleExclusion(selected));
async function restoreHistory(direction) {
  if (loading) throw new Error('Дождитесь загрузки изображений');
  const restored = history[direction](items);
  if (!restored) return;
  clearTimeout(wheelTimer); wheelTimer = null; drag = null;
  items = restored; selected = null;
  await loadImages(); draw(); updateSelection(); renderLibrary();
}
$('#undo').onclick = action(() => restoreHistory('undo'));
$('#redo').onclick = action(() => restoreHistory('redo'));
window.addEventListener('keydown', event => {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName) || $('#connect-dialog').open || $('#size-dialog').open || $('#photo-viewer').open) return;
  if (event.ctrlKey || event.metaKey) {
    const key = event.key.toLowerCase();
    if (key === 'y' || key === 'z' && event.shiftKey) { event.preventDefault(); $('#redo').click(); }
    else if (key === 'z') { event.preventDefault(); $('#undo').click(); }
  }
  if (event.key === 'Delete' && selected) { event.preventDefault(); $('#remove').click(); }
  if (event.key === 'Escape') { selected = null; draw(); updateSelection(); }
});
$('#export').onclick = action(async () => {
  const button = $('#export'); button.disabled = true; button.textContent = 'Готовим PNG…';
  let surface, output;
  try {
    await saveQueue;
    const exportItems = structuredClone(visibleItems()), s = structuredClone(state.settings);
    // Export originals one at a time to keep memory bounded, even for a large archive.
    const size = renderDimensions(s.width, s.height);
    surface = document.createElement('canvas'); surface.width = size.width; surface.height = size.height;
    const context = smooth(surface.getContext('2d')), scale = surface.width / s.width;
    context.setTransform(scale, 0, 0, surface.height / s.height, 0, 0);
    context.fillStyle = s.background; context.fillRect(0, 0, s.width, s.height);
    for (const item of exportItems) {
      const photo = state.photos.find(p => p.id === item.id), response = await fetch(photo.src);
      if (!response.ok) throw new Error('В кеше отсутствует фото. Синхронизируйте библиотеку перед экспортом.');
      const image = await createImageBitmap(await response.blob());
      try { photoRenderer.draw(context, item, image, s, scale); }
      finally { photoRenderer.release(image); image.close(); }
    }
    if (surface.width === s.width && surface.height === s.height) output = surface;
    else {
      output = document.createElement('canvas'); output.width = s.width; output.height = s.height;
      smooth(output.getContext('2d')).drawImage(surface, 0, 0, output.width, output.height);
    }
    const blob = await new Promise(resolve => output.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Браузер не смог создать PNG. Попробуйте меньший размер.');
    const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = `kero-header-${Date.now()}-${s.width}x${s.height}.png`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000); toast('Обложка готова. PNG передан в загрузки браузера.');
  } finally {
    if (output && output !== surface) output.width = output.height = 0;
    if (surface) surface.width = surface.height = 0;
    button.disabled = false; button.textContent = 'Скачать PNG ↗';
  }
});
document.querySelectorAll('.filter').forEach(b => b.onclick = () => { filter = b.dataset.filter; limit = 80; renderLibrary(); });
$('#search').oninput = () => { limit = 80; renderLibrary(); }; $('#load-more').onclick = () => { limit += 80; renderLibrary(); };
$('#import').onclick = () => $('#file-input').click();
$('#clear-cache').onclick = action(async () => {
  if (loading) throw new Error('Дождитесь загрузки изображений');
  if (!confirm('Удалить все изображения из локального кеша? Фото VK можно скачать повторно синхронизацией. Файлы, добавленные с компьютера, потребуется импортировать снова. Настройки и исключения сохранятся.')) return;
  const button = $('#clear-cache'); button.disabled = true;
  try {
    await saveQueue;
    const result = await api('cache/clear', {});
    items = []; history.clear(); selected = null; drag = null;
    for (const bitmap of images.values()) { photoRenderer.release(bitmap); bitmap.close(); } images.clear();
    await refresh();
    toast(`Кеш очищен. Удалено файлов: ${result.removed}.`);
  } finally { button.disabled = false; }
});
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
  $('#connection-error').hidden = true;
}
$('#sync-settings').onclick = openConnection; $('#close-dialog').onclick = () => $('#connect-dialog').close();
$('#connect-form').onsubmit = action(async event => {
  event.preventDefault(); const f = event.target;
  const button = f.querySelector('button[type="submit"]'), error = $('#connection-error');
  const candidate = f.elements.token.value.trim();
  button.disabled = true; button.textContent = candidate ? 'Проверяем доступ к VK…' : 'Сохраняем…'; error.hidden = true;
  try {
    await saveQueue;
    const next = await save('settings', { ...savedSettings, community: f.elements.community.value, source: f.elements.source.value });
    savedSettings = structuredClone(next);
    state.settings = { ...state.settings, community: next.community, source: next.source };
    updateSaveStatus();
    if (candidate) { await api('token', { token: candidate }); state.hasToken = true; f.elements.token.value = ''; $('#sync-status').hidden = true; }
    $('#connect-dialog').close(); renderLibrary(); draw(); toast(candidate ? 'VK подтвердил доступ. Токен сохранён в памяти сервера.' : 'Подключение VK сохранено.');
  } catch (e) { error.textContent = e.message; error.hidden = false; }
  finally { button.disabled = false; button.textContent = 'Сохранить подключение'; }
});
$('#forget-token').onclick = action(async () => { await api('token', { token: '' }); state.hasToken = false; $('#connect-form').elements.token.value = ''; $('#connect-form').elements.token.placeholder = 'Вставьте токен VK'; toast('Токен удалён из памяти сервера. Если он задан в .env, удалите его и там.'); });
$('#sync').onclick = action(async () => { if (!state.hasToken) { openConnection(); return; } await saveQueue; await api('sync', {}); pollSync(); });
async function pollSync() {
  if (polling) return; polling = true; $('#sync').disabled = true;
  try {
    while (true) {
      const progress = await api('sync'), el = $('#sync-status'); el.hidden = false; el.classList.toggle('error', Boolean(progress.error || progress.failed || progress.warnings.length)); el.textContent = syncMessage(progress);
      if (!progress.running) { await saveQueue; await refresh(); if (!items.length && available().length) await shuffle(); break; }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } catch (e) { report(e); } finally { polling = false; $('#sync').disabled = false; }
}
window.addEventListener('resize', () => state && draw());
await refresh().catch(report);
