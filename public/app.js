import { generateAsync, shuffleSources, manualFrames, hitTest, selectionGeometry, selectionHit, resizeSelection, rotateSelection, floatingPanelPosition } from './collage.js';
import { photoSource, librarySource, sortLibraryPhotos, selectedLibraryPhotos } from './library.js';
import { createPhotoRenderer, previewDimensions, renderDimensions, fitCanvasSize, smooth, createFrameScheduler, createTransformLayers } from './render.js';
import { createHistory, historyShortcut } from './history.js';
import { decodePreview, createPreviewCache } from './previews.js';
import { emptySpacePercent } from './coverage.js';
import { createPhotoViewer } from './viewer.js';
const $ = selector => document.querySelector(selector);
const canvas = $('#canvas'), ctx = canvas.getContext('2d'), form = $('#settings-form');
const preview = document.createElement('canvas'), photoRenderer = createPhotoRenderer();
const transformLayers = createTransformLayers(), editorFrames = createFrameScheduler(() => { try { renderEditor(); } catch (error) { report(error); } });
const canvasWrap = $('.canvas-wrap'), selectionPanel = $('#selection-panel'), selectionOutline = $('#selection-outline');
const history = createHistory();
const photoViewer = createPhotoViewer($('#photo-viewer'), {
  canAdd: photo => !loading && !generating && selectedLibraryPhotos([photo.id], state.photos, state.exclusions, state.settings.community).length > 0,
  onAdd: photo => {
    $('#photo-viewer').close(); libraryDialog.close();
    return addPhotosToCanvas([photo.id]);
  },
  onError: report,
});
const libraryDialog = $('#library-dialog'), libraryChosen = new Set();
let libraryBusy = false, librarySession = 0, libraryRendered = 0, libraryFrame = null;
let state, items = [], selected = null, filter = 'active', limit = 60, images = new Map(), drag, saveQueue = Promise.resolve(), toastTimer, polling = false, wheelTimer, loading = false, coverageTimer;
let savedSettings, settingsSaving = false;
let generating = false;
let sceneDirty = true, fullScenePending = true, sceneRevision = 0, layoutDirty = true, previewLayout;
let canvasBounds = null;
let wheelItem = null, pendingImageLoads = 0, imageLoadQueue = Promise.resolve();
let measuringLibrary = false;
const failedMeasurements = new Set();
let exporting = false, coverUploading = false, coverPayload = null, coverPreviewUrl, coverSession = 0;
let historyQueue = Promise.resolve();
let libraryOrigin = 'vk';
const librarySort = { vk: { key: 'date', direction: 'desc' }, local: { key: 'ratio', direction: 'desc' } };
const librarySizes = new Map();
const previewCache = createPreviewCache({ busy: () => loading || generating || exporting || Boolean(drag || wheelTimer) });
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
function checkpoint() {
  clearTimeout(wheelTimer); wheelTimer = null; wheelItem = null; history.checkpoint(items);
  if (!generating) { $('#undo').disabled = !history.canUndo; $('#redo').disabled = !history.canRedo; }
}
function selectedItem() { return items.find(item => item.instanceId === selected); }
function available() {
  const excluded = new Set(state.exclusions);
  return state.photos.filter(p => p.available && !excluded.has(p.id) && (librarySource(p) === 'local' || p.community === state.settings.community));
}
function visibleItems() { const ids = new Set(available().map(p => p.id)); return items.filter(i => ids.has(i.id)); }
function readSettings() {
  const next = { ...state.settings };
  [next.width, next.height] = $('#preset').value.split(',').map(Number);
  for (const name of numeric) next[name] = Number(form.elements[name].value);
  next.photoSize = Number(form.elements.photoSize.value);
  next.sizeDeviation = Number(form.elements.sizeDeviation.value);
  next.count = 0;
  next.layoutOrder = form.elements.layoutOrder.value;
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
  const order = form.elements.layoutOrder.value;
  for (const option of $('#order-menu').querySelectorAll('[role=option]')) {
    option.setAttribute('aria-selected', String(option.dataset.value === order));
    if (option.dataset.value === order) $('#order-value').textContent = option.textContent;
  }
  for (const input of numberInputs) {
    const range = form.elements[input.dataset.range];
    input.min = range.min; input.max = range.max; input.step = range.step || '1';
    input.value = range.value;
    range.style.setProperty('--range-progress', `${(Number(range.value) - Number(range.min)) / (Number(range.max) - Number(range.min)) * 100}%`);
  }
}
function closeCoverSizes(focus = false) {
  $('#preset-menu').hidePopover();
  if (focus) $('#preset-trigger').focus({ preventScroll: true });
}
function focusCoverOption(option) {
  if (!option) return;
  const menu = $('#preset-menu');
  option.focus({ preventScroll: true });
  if (option.offsetTop < menu.scrollTop) menu.scrollTop = option.offsetTop;
  else if (option.offsetTop + option.offsetHeight > menu.scrollTop + menu.clientHeight) menu.scrollTop = option.offsetTop + option.offsetHeight - menu.clientHeight;
}
function positionCoverSizes() {
  const menu = $('#preset-menu'), trigger = $('#preset-trigger'), rect = trigger.getBoundingClientRect();
  menu.style.width = `${rect.width}px`;
  const height = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, rect.bottom + height + 8 <= innerHeight ? rect.bottom + 6 : rect.top - height - 6)}px`;
}
function openCoverSizes() {
  $('#preset-menu').showPopover(); positionCoverSizes();
}
function coverSizeLabel(size) {
  const name = size.width === 1920 && size.height === 768 ? 'VK' : size.width === 1400 && size.height === 280 ? 'Пикабу' : '';
  return `${size.width} × ${size.height}${name ? ` (${name})` : ''}`;
}
function fillCoverSizes() {
  const input = $('#preset'), menu = $('#preset-menu');
  input.value = `${state.settings.width},${state.settings.height}`;
  $('#preset-value').textContent = coverSizeLabel(state.settings);
  menu.replaceChildren();
  const choices = [...state.settings.coverSizes.map(size => ({ value: `${size.width},${size.height}`, label: coverSizeLabel(size) })), { value: 'custom', label: 'Добавить размер…' }];
  for (const choice of choices) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'preset-option';
    button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(choice.value === input.value));
    button.textContent = choice.label; button.dataset.value = choice.value;
    if (choice.value === 'custom') button.classList.add('preset-option-add');
    button.onclick = () => {
      input.value = choice.value; closeCoverSizes(true);
      if (choice.value !== 'custom') {
        $('#preset-value').textContent = choice.label;
        menu.querySelectorAll('[role=option]').forEach(option => option.setAttribute('aria-selected', String(option === button)));
      }
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    menu.append(button);
  }
}
$('#preset-menu').addEventListener('beforetoggle', event => {
  if (event.newState !== 'open') return;
  const rect = $('#preset-trigger').getBoundingClientRect(), menu = $('#preset-menu');
  menu.style.width = `${rect.width}px`; menu.style.left = `${rect.left}px`; menu.style.top = `${rect.bottom + 6}px`;
});
$('#preset-menu').addEventListener('toggle', event => {
  $('#preset-trigger').setAttribute('aria-expanded', String(event.newState === 'open'));
  if (event.newState === 'open') positionCoverSizes();
});
$('#preset-trigger').onkeydown = event => {
  if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
  event.preventDefault(); openCoverSizes();
  const options = [...$('#preset-menu').querySelectorAll('[role=option]')];
  focusCoverOption(options.find(option => option.getAttribute('aria-selected') === 'true') || options[0]);
};
$('#preset-menu').onkeydown = event => {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeCoverSizes(true); return; }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const options = [...$('#preset-menu').querySelectorAll('[role=option]')], index = options.indexOf(document.activeElement);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
  focusCoverOption(options[next]);
};
window.addEventListener('resize', () => closeCoverSizes());
window.addEventListener('scroll', event => { if (!$('#preset-menu').contains(event.target)) closeCoverSizes(); }, true);
const orderMenu = $('#order-menu'), orderTrigger = $('#order-trigger');
function positionOrderMenu() {
  const rect = orderTrigger.getBoundingClientRect();
  orderMenu.style.width = `${rect.width}px`;
  orderMenu.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - rect.width - 8))}px`;
  orderMenu.style.top = `${Math.max(8, rect.bottom + orderMenu.offsetHeight + 8 <= innerHeight ? rect.bottom + 6 : rect.top - orderMenu.offsetHeight - 6)}px`;
}
function closeOrderMenu(focus = false) { orderMenu.hidePopover(); if (focus) orderTrigger.focus({ preventScroll: true }); }
orderMenu.addEventListener('toggle', event => {
  orderTrigger.setAttribute('aria-expanded', String(event.newState === 'open'));
  if (event.newState === 'open') positionOrderMenu();
});
orderMenu.querySelectorAll('[role=option]').forEach(option => option.onclick = () => {
  form.elements.layoutOrder.value = option.dataset.value;
  closeOrderMenu(true);
  form.elements.layoutOrder.dispatchEvent(new Event('change', { bubbles: true }));
});
orderTrigger.onkeydown = event => {
  if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
  event.preventDefault(); orderMenu.showPopover(); positionOrderMenu();
  orderMenu.querySelector('[aria-selected=true]').focus({ preventScroll: true });
};
orderMenu.onkeydown = event => {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeOrderMenu(true); return; }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const choices = [...orderMenu.querySelectorAll('[role=option]')], index = choices.indexOf(document.activeElement);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
  choices[next].focus({ preventScroll: true });
};
window.addEventListener('resize', () => closeOrderMenu());
window.addEventListener('scroll', event => { if (!orderMenu.contains(event.target)) closeOrderMenu(); }, true);
function hasUnsavedSettings() {
  return savedSettings && JSON.stringify(state.settings) !== JSON.stringify(savedSettings);
}
function updateSaveStatus() {
  const dirty = hasUnsavedSettings(), button = $('#save-settings');
  button.disabled = !dirty || settingsSaving;
  button.textContent = settingsSaving ? 'Сохраняем…' : 'Сохранить настройки';
}
function updateSettings() {
  state.settings = readSettings();
  updateLabels(); draw(); updateSaveStatus();
}
function loadImages(generationPhotos, onProgress) {
  pendingImageLoads++; loading = true;
  const task = imageLoadQueue.catch(() => {}).then(() => performImageLoad(generationPhotos, onProgress));
  imageLoadQueue = task;
  return task.finally(() => { pendingImageLoads--; loading = pendingImageLoads > 0; });
}
async function performImageLoad(generationPhotos, onProgress) {
  const visible = new Set(visibleItems().map(item => item.id));
  const photos = generationPhotos ?? available().filter(photo => visible.has(photo.id));
  const needed = new Set(photos.map(photo => photo.id));
  // Keep decoded previews for the next undo/redo, including a temporarily empty canvas.
  const retained = history.nearbyPhotoIds();
  for (const [id, bitmap] of images) if (!needed.has(id) && !retained.has(id)) { photoRenderer.release(bitmap); bitmap.close(); images.delete(id); }
  let index = 0, completed = 0;
  const worker = async () => {
    while (index < photos.length) {
      const photo = photos[index++];
      const cached = images.get(photo.id);
      if (cached) { const dimensions = await librarySizes.get(photo.id); if (dimensions) Object.assign(photo, dimensions); else { photo.width ||= cached.width; photo.height ||= cached.height; } onProgress?.(++completed, photos.length); continue; }
      let bitmap;
      try {
        let decoded = await previewCache.read(photo);
        if (!decoded) {
          const response = await fetch(photo.src);
          if (!response.ok) throw new Error();
          decoded = await decodePreview(await response.blob(), photo);
          previewCache.remember(photo, decoded);
        }
        bitmap = decoded.image;
        photo.width = decoded.width; photo.height = decoded.height;
        librarySizes.set(photo.id, Promise.resolve({ width: decoded.width, height: decoded.height }));
        images.set(photo.id, bitmap);
        bitmap = null;
      } catch { bitmap?.close(); photo.available = false; }
      onProgress?.(++completed, photos.length);
    }
  };
  const workers = await Promise.allSettled(Array.from({ length: 6 }, worker));
  const failed = workers.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
}
async function measureLibraryPhotos(photos, shouldContinue) {
  let index = 0;
  const needed = photos.filter(photo => photo.available && !(photo.width > 0 && photo.height > 0));
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (index < needed.length && shouldContinue()) {
      const photo = needed[index++];
      if (!librarySizes.has(photo.id)) librarySizes.set(photo.id, new Promise(resolve => {
        const image = new Image();
        const finish = value => { clearTimeout(timer); image.onload = image.onerror = null; resolve(value); };
        const timer = setTimeout(() => finish(null), 15000);
        image.onload = () => finish({ width: image.naturalWidth, height: image.naturalHeight });
        image.onerror = () => finish(null); image.src = photo.src;
      }));
      const pending = librarySizes.get(photo.id), size = await pending;
      if (size) Object.assign(photo, size);
      else {
        if (librarySizes.get(photo.id) === pending) librarySizes.delete(photo.id);
        if (shouldContinue()) failedMeasurements.add(photo.id);
      }
    }
  }));
}
function requestLibraryMeasurements(photos) {
  if (measuringLibrary) return;
  const needed = photos.filter(photo => photo.available && !(photo.width > 0 && photo.height > 0) && !failedMeasurements.has(photo.id));
  if (!needed.length) return;
  measuringLibrary = true;
  const origin = libraryOrigin, source = state.photos;
  measureLibraryPhotos(needed, () => libraryDialog.open && origin === libraryOrigin && source === state.photos && librarySort[origin].key === 'ratio')
    .catch(report).finally(() => { measuringLibrary = false; renderLibrary(); });
}
async function refresh() {
  const fresh = await api('state');
  const draft = state && hasUnsavedSettings() ? state.settings : null;
  savedSettings = structuredClone(fresh.settings); state = fresh;
  if (draft) state.settings = draft;
  failedMeasurements.clear();
  void previewCache.prune(state.photos);
  fillForm(); updateSaveStatus(); await loadImages(); renderLibrary(); draw();
  $('#sync').disabled = fresh.sync.running;
  if (fresh.sync.error) { const el = $('#sync-status'); el.hidden = false; el.classList.add('error'); el.textContent = syncMessage(fresh.sync); }
  if (fresh.sync.running) pollSync();
}
function paint(context, width, height, pixelScale, frames) {
  const s = state.settings;
  context.clearRect(0, 0, width, height); context.fillStyle = s.background; context.fillRect(0, 0, width, height);
  for (const item of frames) {
    const image = images.get(item.id); if (!image) continue;
    photoRenderer.draw(context, item, image, s, pixelScale);
  }
}
function draw({ transform = false, selectionOnly = false } = {}) {
  if (!selectionOnly) {
    sceneDirty = true;
    if (!transform) { fullScenePending = true; sceneRevision++; transformLayers.invalidate(); }
  }
  editorFrames.schedule();
}
function renderEditor() {
  if (!state) return;
  const s = state.settings;
  const pixelRatio = window.devicePixelRatio || 1;
  if (layoutDirty || previewLayout?.width !== s.width || previewLayout?.height !== s.height || previewLayout?.pixelRatio !== pixelRatio) {
    const toolbarHeight = `${$('.editor-top').offsetHeight}px`;
    if ($('.workspace').style.getPropertyValue('--editor-toolbar-height') !== toolbarHeight) $('.workspace').style.setProperty('--editor-toolbar-height', toolbarHeight);
    const padding = getComputedStyle(canvasWrap);
    const fitted = fitCanvasSize(canvasWrap.clientWidth - parseFloat(padding.paddingLeft) - parseFloat(padding.paddingRight), canvasWrap.clientHeight - parseFloat(padding.paddingTop) - parseFloat(padding.paddingBottom), s.width, s.height);
    canvas.style.width = `${fitted.width}px`; canvas.style.height = `${fitted.height}px`;
    canvas.style.aspectRatio = `${s.width} / ${s.height}`;
    const displaySize = previewDimensions(fitted.width, s.width, s.height, pixelRatio), renderSize = renderDimensions(displaySize.width, displaySize.height);
    if (canvas.width !== displaySize.width) canvas.width = displaySize.width;
    if (canvas.height !== displaySize.height) canvas.height = displaySize.height;
    if (preview.width !== renderSize.width) preview.width = renderSize.width;
    if (preview.height !== renderSize.height) preview.height = renderSize.height;
    previewLayout = { width: s.width, height: s.height, pixelRatio };
    layoutDirty = false; sceneDirty = fullScenePending = true; transformLayers.invalidate();
  }
  const visible = visibleItems();
  if (sceneDirty) {
    const context = smooth(preview.getContext('2d'));
    const layered = !fullScenePending && selected && transformLayers.render({ context, frames: visible, images, settings: s, selected, width: preview.width, height: preview.height, revision: sceneRevision, drawPhoto: photoRenderer.draw });
    if (!layered) {
      context.setTransform(preview.width / s.width, 0, 0, preview.height / s.height, 0, 0);
      paint(context, s.width, s.height, preview.width / s.width, visible);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0); smooth(ctx);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(preview, 0, 0, canvas.width, canvas.height);
    clearTimeout(coverageTimer);
    coverageTimer = setTimeout(() => {
      const empty = emptySpacePercent(visibleItems(), images, state.settings);
      $('#empty-percentage').textContent = empty.toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    }, drag || wheelTimer ? 160 : 60);
    sceneDirty = fullScenePending = false;
  }
  $('#canvas-count').textContent = visible.length;
  $('#canvas-empty-state').hidden = visible.length > 0;
  $('#community-link').href = `https://vk.ru/${encodeURIComponent(s.community)}`;
  $('#dimensions').textContent = `${s.width} × ${s.height}`;
  if (!generating) {
    $('#export').disabled = $('#install-cover').disabled = !visible.length || loading || exporting;
    $('#clear-canvas').disabled = !items.length || loading;
    $('#undo').disabled = !history.canUndo;
    $('#redo').disabled = !history.canRedo;
  }
  canvasBounds = canvas.getBoundingClientRect();
  updateSelection(visible);
  if (!drag && !wheelTimer) transformLayers.invalidate();
}
function updateSelection(visible) {
  const item = visible.find(i => i.instanceId === selected), image = item && images.get(item.id);
  selectionPanel.hidden = selectionOutline.hidden = !item || !image;
  if (!item || !image) { return; }
  const rect = canvasBounds, wrap = canvasWrap.getBoundingClientRect();
  const scale = rect.width / state.settings.width, ratio = image.height / image.width, border = state.settings.border;
  const origin = { x: rect.left - wrap.left, y: rect.top - wrap.top };
  Object.assign(selectionOutline.style, {
    left: `${origin.x + item.x * scale}px`, top: `${origin.y + item.y * scale}px`,
    width: `${(item.width + border * 2) * scale}px`, height: `${(item.width * ratio + border * 2) * scale}px`,
    transform: `translate(-50%,-50%) rotate(${item.angle}deg)`,
  });
  const geometry = selectionGeometry(item, ratio, border, scale);
  const bounds = [...geometry.corners, geometry.rotate].map(p => ({ x: origin.x + p.x * scale, y: origin.y + p.y * scale }));
  const position = floatingPanelPosition({ left: Math.min(...bounds.map(p => p.x)), right: Math.max(...bounds.map(p => p.x)), top: Math.min(...bounds.map(p => p.y)) - 7, bottom: Math.max(...bounds.map(p => p.y)) + 7 }, { width: selectionPanel.offsetWidth, height: selectionPanel.offsetHeight }, { width: canvasWrap.clientWidth, height: canvasWrap.clientHeight });
  selectionPanel.style.left = `${position.x}px`; selectionPanel.style.top = `${position.y}px`;
  const index = visible.indexOf(item);
  $('#to-back').disabled = $('#layer-backward').disabled = index === 0;
  $('#to-front').disabled = $('#layer-forward').disabled = index === visible.length - 1;
  for (const grip of selectionOutline.querySelectorAll('.selection-grip')) {
    const angle = item.angle + Math.atan2(Number(grip.dataset.sy), Number(grip.dataset.sx)) * 180 / Math.PI;
    grip.style.cursor = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][((Math.round(angle / 45) % 4) + 4) % 4];
  }
}
function photoIcon(name) {
  const paths = {
    view: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    source: '<path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
    exclude: '<circle cx="12" cy="12" r="8"/><path d="m6 6 12 12"/>',
    restore: '<path d="M3 10h11a6 6 0 0 1 0 12M3 10l5-5m-5 5 5 5"/>',
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = paths[name]; return svg;
}
function renderLibrary({ append = false } = {}) {
  if (!libraryDialog.open) return;
  if (!append && libraryFrame !== null) { cancelAnimationFrame(libraryFrame); libraryFrame = null; }
  const knownSelection = new Set([...state.photos.map(photo => photo.id), ...state.exclusions]);
  for (const id of libraryChosen) if (!knownSelection.has(id)) libraryChosen.delete(id);
  const excluded = new Set(state.exclusions), all = state.photos.filter(p => librarySource(p) === 'local' || p.community === state.settings.community);
  const pool = all.filter(p => librarySource(p) === libraryOrigin), order = librarySort[libraryOrigin];
  $('#vk-count').textContent = all.filter(p => librarySource(p) === 'vk').length;
  $('#local-count').textContent = all.filter(p => librarySource(p) === 'local').length;
  $('#library-count').textContent = pool.length;
  if (libraryOrigin === 'local' && filter === 'missing') filter = 'active';
  $('#active-label').textContent = libraryOrigin === 'local' ? 'Добавленные' : 'Доступные';
  $('#active-count').textContent = pool.filter(p => !excluded.has(p.id) && (libraryOrigin === 'local' || p.available)).length;
  $('[data-filter=missing]').hidden = libraryOrigin === 'local';
  $('#delete-files').title = libraryOrigin === 'vk' ? 'Очистить файлы из VK' : 'Очистить файлы, добавленные с компьютера';
  $('#missing-label').textContent = libraryOrigin === 'local' ? 'Нет файла' : 'Нет в кеше';
  $('#missing-label').parentElement.title = libraryOrigin === 'local' ? 'Копия файла в проекте отсутствует. Импортируйте фотографию снова.' : 'Скачанный файл отсутствует. Повторите синхронизацию VK.';
  $('#missing-count').textContent = pool.filter(p => !p.available && !excluded.has(p.id)).length;
  const known = new Set(state.photos.map(p => p.id));
  const excludedStubs = state.exclusions.filter(id => !known.has(id)).map(id => ({ id, title: id, available: false })).filter(p => librarySource(p) === libraryOrigin);
  $('#excluded-count').textContent = pool.filter(p => excluded.has(p.id)).length + excludedStubs.length;
  const list = sortLibraryPhotos([...pool, ...(filter === 'excluded' ? excludedStubs : [])].filter(p => filter === 'excluded' ? excluded.has(p.id) : filter === 'missing' ? !p.available && !excluded.has(p.id) : (libraryOrigin === 'local' || p.available) && !excluded.has(p.id)), order.key, order.direction);
  document.querySelectorAll('.source-tab').forEach(button => { const active = button.dataset.source === libraryOrigin; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
  document.querySelectorAll('[data-sort]').forEach(button => {
    const active = button.dataset.sort === order.key;
    button.classList.toggle('active', active); button.classList.toggle('ascending', active && order.direction === 'asc');
    button.setAttribute('aria-pressed', String(active));
    const label = button.dataset.sort === 'date' ? (libraryOrigin === 'vk' ? 'По дате VK' : 'По дате') : 'Пропорции';
    button.querySelector('span').textContent = label;
    const direction = button.dataset.sort === 'date' ? (order.direction === 'desc' ? 'сначала новые' : 'сначала старые') : (order.direction === 'desc' ? 'сначала широкие' : 'сначала узкие');
    button.title = active ? `${label}: ${direction}. Нажмите, чтобы изменить направление.` : label;
    button.setAttribute('aria-label', button.title);
  });
  $('#sort-date').hidden = false;
  $('#vk-actions').hidden = libraryOrigin !== 'vk';
  $('#import').hidden = libraryOrigin !== 'local';
  const grid = $('#library-grid');
  if (!append) { grid.replaceChildren(); libraryRendered = 0; }
  for (const photo of list.slice(libraryRendered, limit)) {
    const card = document.createElement('div'); card.className = `photo-card${excluded.has(photo.id) ? ' excluded' : ''}${libraryChosen.has(photo.id) ? ' selected' : ''}`;
    const source = photoSource(photo);
    const preview = document.createElement('button'); preview.type = 'button'; preview.className = 'photo-image';
    card.dataset.photoId = photo.id;
    preview.title = 'Выбрать фотографию'; preview.setAttribute('aria-label', `Выбрать фотографию: ${photo.title}`);
    preview.setAttribute('aria-pressed', String(libraryChosen.has(photo.id)));
    preview.onclick = () => {
      if (libraryChosen.has(photo.id)) libraryChosen.delete(photo.id); else libraryChosen.add(photo.id);
      card.classList.toggle('selected', libraryChosen.has(photo.id));
      preview.setAttribute('aria-pressed', String(libraryChosen.has(photo.id))); updateLibrarySelection();
    };
    if (photo.available) { const img = document.createElement('img'); img.src = photo.src; img.loading = 'lazy'; img.alt = photo.title; img.draggable = false; preview.append(img); } else preview.textContent = 'Нет файла';
    const badge = document.createElement('span'); badge.className = 'photo-select-badge'; badge.setAttribute('aria-hidden', 'true');
    badge.innerHTML = '<svg viewBox="0 0 20 20"><path d="m5 10 3 3 7-7"/></svg>';
    const actions = document.createElement('div'); actions.className = 'photo-actions';
    card.append(preview, badge, actions);
    if (source) {
      const link = document.createElement('a'); link.className = 'photo-toggle photo-source'; link.append(photoIcon('source'));
      link.href = source.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.title = source.label; link.draggable = false;
      link.setAttribute('aria-label', `${source.label}: ${photo.title}`); actions.append(link);
    }
    const view = document.createElement('button'); view.type = 'button'; view.className = 'photo-toggle photo-view';
    view.append(photoIcon('view')); view.disabled = !photo.available; view.title = 'Посмотреть фото';
    view.setAttribute('aria-label', `Посмотреть фото: ${photo.title}`); view.onclick = () => photoViewer.open(photo, list);
    actions.append(view); grid.append(card);
  }
  libraryRendered = Math.min(limit, list.length);
  const sentinel = $('#library-sentinel'); sentinel.hidden = libraryRendered >= list.length;
  libraryObserver.unobserve(sentinel);
  if (!sentinel.hidden && libraryDialog.open) libraryObserver.observe(sentinel);
  updateLibrarySelection();
  $('#library-empty').hidden = list.length > 0;
  $('#library-empty').textContent = filter === 'excluded' ? 'Исключённых кадров нет. Выберите фотографии и нажмите «Исключить» внизу.' : filter === 'missing' ? 'Все файлы на месте.' : pool.length ? 'Ничего не найдено.' : libraryOrigin === 'vk' ? 'Здесь появятся фотографии из VK. Синхронизируйте библиотеку.' : 'Здесь появятся ваши фотографии. Нажмите «Загрузить».';
  document.querySelectorAll('.filter').forEach(b => b.classList.toggle('active', b.dataset.filter === filter));
  if (order.key === 'ratio') requestLibraryMeasurements(list);
}
function updateLibrarySelection() {
  const ids = [...libraryChosen], eligible = selectedLibraryPhotos(ids, state.photos, state.exclusions, state.settings.community);
  const allExcluded = ids.length > 0 && ids.every(id => state.exclusions.includes(id));
  $('#library-selection-count').textContent = `Выбрано: ${ids.length}`;
  $('#library-add').disabled = Boolean(libraryBusy) || !ids.length || eligible.length !== ids.length;
  $('#library-add').textContent = libraryBusy === 'add' ? 'Добавляем…' : ids.length ? `Добавить (${ids.length})` : 'Добавить выбранные';
  $('#library-add').title = eligible.length === ids.length ? 'Добавить выбранные фотографии на холст' : 'Для добавления выберите доступные фотографии без исключений';
  $('#library-exclude').disabled = Boolean(libraryBusy) || !ids.length;
  $('#library-exclude').textContent = allExcluded ? 'Вернуть в генерацию' : 'Исключить';
  for (const part of libraryDialog.querySelectorAll('.library-top, .library-sources, .library-filters, .library-content')) part.inert = Boolean(libraryBusy);
}
const libraryObserver = new IntersectionObserver(entries => {
  if ($('#library-sentinel').hidden || !entries.some(entry => entry.isIntersecting) || !libraryDialog.open || libraryBusy || libraryFrame !== null) return;
  libraryFrame = requestAnimationFrame(() => { libraryFrame = null; limit += 60; renderLibrary({ append: true }); });
}, { root: $('#library-content'), rootMargin: '400px 0px' });
function openLibrary() {
  if (loading || generating || libraryBusy) return;
  closeCoverSizes(); libraryChosen.clear(); librarySession++; limit = 60;
  libraryDialog.showModal(); renderLibrary(); $('#library-content').scrollTop = 0;
}
document.querySelectorAll('[data-open-library]').forEach(button => button.onclick = openLibrary);
$('#library-close').onclick = $('#library-cancel').onclick = () => libraryDialog.close();
libraryDialog.addEventListener('close', () => {
  librarySession++; libraryChosen.clear(); libraryObserver.unobserve($('#library-sentinel'));
  if (libraryFrame !== null) { cancelAnimationFrame(libraryFrame); libraryFrame = null; }
});
async function addPhotosToCanvas(ids, shouldCommit = () => true) {
  if (loading || generating) throw new Error('Дождитесь завершения текущей операции');
  const photos = selectedLibraryPhotos(ids, state.photos, state.exclusions, state.settings.community);
  if (!photos.length || photos.length !== ids.length) throw new Error('Выберите доступные фотографии без исключений');
  const needed = new Set([...visibleItems().map(item => item.id), ...ids]);
  await loadImages(available().filter(photo => needed.has(photo.id)));
  if (!shouldCommit()) return [];
  const ready = selectedLibraryPhotos(ids, state.photos, state.exclusions, state.settings.community);
  if (!ready.length) throw new Error('Не удалось загрузить выбранные фотографии. Выполните синхронизацию или загрузите файлы снова.');
  const frames = manualFrames(ready, state.settings, items);
  checkpoint(); items.push(...frames); selected = frames.at(-1).instanceId;
  draw(); renderLibrary();
  toast(`Добавлено кадров: ${frames.length}.${ready.length < ids.length ? ' Часть файлов недоступна.' : ''}`);
  return frames;
}
$('#library-add').onclick = action(async () => {
  if (libraryBusy || !libraryChosen.size) return;
  const ids = [...libraryChosen], session = librarySession;
  libraryBusy = 'add'; updateLibrarySelection();
  try {
    const frames = await addPhotosToCanvas(ids, () => libraryDialog.open && session === librarySession);
    if (frames.length) libraryDialog.close();
  } finally { libraryBusy = false; updateLibrarySelection(); draw(); }
});
$('#library-exclude').onclick = action(async () => {
  if (libraryBusy || !libraryChosen.size) return;
  const ids = [...libraryChosen], restoring = ids.every(id => state.exclusions.includes(id));
  libraryBusy = 'exclude'; updateLibrarySelection();
  try {
    if (!restoring && !await confirmAction({ title: `Исключить фотографии (${ids.length})?`, description: 'Выбранные фотографии перестанут участвовать в генерации. Вернуть их можно во вкладке «Исключённые».', label: 'Исключить' })) return;
    const next = new Set(state.exclusions);
    for (const id of ids) { if (restoring) next.delete(id); else next.add(id); }
    await save('exclusions', [...next]); state.exclusions = [...next];
    if (selectedItem() && next.has(selectedItem().id)) selected = null;
    libraryChosen.clear(); if (restoring) await loadImages(); draw(); renderLibrary();
  } finally { libraryBusy = false; updateLibrarySelection(); }
});
function confirmAction({ title, description, label, photo }) {
  const dialog = $('#exclude-dialog'), image = $('#exclude-preview');
  $('#exclude-title').textContent = title; $('#exclude-description').textContent = description;
  dialog.querySelector('button[value=exclude]').textContent = label;
  image.hidden = !photo?.available;
  if (photo?.available) image.src = photo.src; else image.removeAttribute('src');
  dialog.returnValue = '';
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'exclude'), { once: true });
    dialog.showModal();
  });
}
async function toggleExclusion(id) {
  const restoring = state.exclusions.includes(id);
  if (!restoring && !await confirmAction({ title: 'Исключить фотографию?', description: 'Фотография больше не будет участвовать в генерации. Её можно вернуть во вкладке «Исключённые».', label: 'Исключить', photo: state.photos.find(p => p.id === id) })) return;
  const next = restoring ? state.exclusions.filter(p => p !== id) : [...state.exclusions, id];
  await save('exclusions', next); state.exclusions = next;
  if (selectedItem()?.id === id) selected = null;
  if (restoring) await loadImages();
  renderLibrary(); draw();
  toast(restoring ? 'Кадр снова участвует в генерации' : 'Кадр исключён. Вернуть его можно во вкладке «Исключённые».');
}
function generationProgress(value, message) {
  const percent = Math.max(0, Math.min(100, value));
  $('#generation-progress').classList.add('active'); $('#generation-progress').setAttribute('aria-hidden', 'false');
  $('#generation-stage').textContent = message;
  $('#generation-percent').textContent = `${Math.round(percent)}%`;
  $('#generation-bar').value = percent;
}
async function shuffle() {
  if (generating) return;
  if (loading) throw new Error('Дождитесь загрузки изображений');
  if (!available().length) throw new Error('Сначала добавьте фотографии');
  updateSettings();
  generating = true;
  const button = $('#generate'); button.setAttribute('aria-busy', 'true');
  // Lock interaction without swapping every button into its faded disabled appearance.
  $('.editor-top').inert = canvasWrap.inert = form.inert = $('.controls-footer').inert = true;
  try {
    generationProgress(0, 'Подготовка фотографий');
    await new Promise(resolve => setTimeout(resolve, 0));
    const onCanvas = visibleItems(), frameIds = new Set(onCanvas.map(item => item.id));
    const photos = onCanvas.length ? available().filter(photo => frameIds.has(photo.id)) : available();
    await loadImages(photos, (done, total) => generationProgress(total ? done / total * 35 : 35, `Подготовка фото: ${done} / ${total}`));
    const settings = structuredClone(state.settings);
    const result = await generateAsync(shuffleSources(photos.filter(photo => photo.available), onCanvas), settings, (done, total) => generationProgress(35 + (total ? done / total : 1) * 60, `Расстановка кадров: ${done} / ${total}`));
    checkpoint(); items = result.map(item => ({ ...item, instanceId: item.instanceId || crypto.randomUUID() })); selected = null;
    generationProgress(95, 'Отрисовка обложки');
    await new Promise(resolve => setTimeout(resolve, 0));
    draw(); renderLibrary(); generationProgress(100, 'Готово');
    await new Promise(resolve => setTimeout(resolve, 0));
  } finally {
    generating = false; button.removeAttribute('aria-busy'); $('#generation-progress').classList.remove('active'); $('#generation-progress').setAttribute('aria-hidden', 'true');
    $('.editor-top').inert = canvasWrap.inert = form.inert = $('.controls-footer').inert = false; draw(); updateSaveStatus();
  }
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
$('#clear-canvas').onclick = action(async () => {
  if (loading || generating || !items.length) return;
  checkpoint(); items = []; selected = null; endDrag();
  await loadImages(); draw(); renderLibrary();
});
function point(event) { const rect = canvasBounds || canvas.getBoundingClientRect(); return { x: (event.clientX - rect.left) * state.settings.width / rect.width, y: (event.clientY - rect.top) * state.settings.height / rect.height }; }
function itemAt(p) {
  const visible = visibleItems();
  for (let i = visible.length - 1; i >= 0; i--) {
    const item = visible[i], image = images.get(item.id);
    if (image && hitTest(item, image.height / image.width, p.x, p.y, state.settings.border)) return item;
  }
  return null;
}
canvasWrap.onpointerdown = event => {
  if (loading || generating || !event.isPrimary || event.button !== 0 || event.target.closest('.selection')) return;
  const p = point(event), current = visibleItems().find(i => i.instanceId === selected), image = images.get(selectedItem()?.id);
  const scale = (canvasBounds || canvas.getBoundingClientRect()).width / state.settings.width;
  const geometry = current && image && selectionGeometry(current, image.height / image.width, state.settings.border, scale);
  const grip = event.target.closest('.selection-grip');
  const handle = geometry && (grip ? { type: 'resize', ...geometry.corners.find(c => c.sx === Number(grip.dataset.sx) && c.sy === Number(grip.dataset.sy)) } : event.target.closest('#selection-rotate') ? { type: 'rotate' } : selectionHit(geometry, p, scale));
  const item = handle ? current : event.target === canvas ? itemAt(p) : null;
  const nextSelected = item?.instanceId || null;
  if (nextSelected !== selected) { clearTimeout(wheelTimer); wheelTimer = null; wheelItem = null; }
  selected = nextSelected;
  if (item) {
    event.preventDefault();
    drag = { item, start: { ...item }, point: p, handle, ratio: images.get(item.id).height / images.get(item.id).width, pointerAngle: Math.atan2(p.y - item.y, p.x - item.x), changed: false };
    canvasWrap.setPointerCapture(event.pointerId); canvasWrap.classList.add('transforming'); canvasWrap.classList.toggle('rotating', handle?.type === 'rotate');
  }
  draw({ selectionOnly: true });
};
canvasWrap.onpointermove = event => {
  if (loading || generating) return;
  const p = point(event);
  if (!drag) { const cursor = itemAt(p) ? 'move' : 'default'; if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor; return; }
  let next;
  if (drag.handle?.type === 'resize') next = resizeSelection(drag.start, drag.handle, { x: drag.handle.x + p.x - drag.point.x, y: drag.handle.y + p.y - drag.point.y }, drag.ratio, state.settings.border);
  else if (drag.handle?.type === 'rotate') next = { angle: rotateSelection(drag.start, p, drag.pointerAngle, event.shiftKey) };
  else next = { x: Math.max(-10000, Math.min(20000, drag.start.x + p.x - drag.point.x)), y: Math.max(-10000, Math.min(20000, drag.start.y + p.y - drag.point.y)) };
  if (!Object.entries(next).some(([key, value]) => Math.abs(drag.item[key] - value) > .0001)) return;
  if (!drag.changed) { checkpoint(); drag.changed = true; }
  Object.assign(drag.item, next); draw({ transform: true });
};
const endDrag = () => {
  const wasDragging = Boolean(drag);
  drag = null; canvasWrap.classList.remove('transforming', 'rotating');
  if (wasDragging) draw({ selectionOnly: true });
};
canvasWrap.onpointerup = canvasWrap.onpointercancel = canvasWrap.onlostpointercapture = endDrag;
canvas.addEventListener('wheel', event => {
  if (loading || generating || !event.deltaY) return;
  const item = items.find(i => i.instanceId === selected); if (!item) return;
  event.preventDefault(); if (!wheelTimer || wheelItem !== item.instanceId) checkpoint();
  wheelItem = item.instanceId;
  if (!event.shiftKey) item.angle = (item.angle + Math.sign(event.deltaY) * 4) % 360;
  else item.width = Math.max(10, Math.min(10000, item.width * (event.deltaY > 0 ? .95 : 1.05)));
  draw({ transform: true }); clearTimeout(wheelTimer);
  wheelTimer = setTimeout(() => { wheelTimer = null; wheelItem = null; draw({ selectionOnly: true }); }, 250);
}, { passive: false });
async function editSelected(fn, transform = false) {
  if (loading || generating) return;
  const item = selectedItem(); if (!item) return;
  endDrag(); checkpoint(); fn(item); draw({ transform });
}
selectionPanel.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); selected = null; draw({ selectionOnly: true }); }
});
for (const grip of selectionOutline.querySelectorAll('button')) grip.onkeydown = action(async event => {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
  event.preventDefault(); event.stopPropagation();
  const direction = ['ArrowLeft', 'ArrowDown'].includes(event.key) ? -1 : 1;
  await editSelected(item => {
    if (grip.id === 'selection-rotate') item.angle = (item.angle + direction * (event.shiftKey ? 15 : 1)) % 360;
    else item.width = Math.max(10, Math.min(10000, item.width + direction * (event.shiftKey ? 50 : 10)));
  }, true);
});
$('#to-front').onclick = action(() => editSelected(item => { items = items.filter(i => i !== item); items.push(item); }));
$('#to-back').onclick = action(() => editSelected(item => { items = items.filter(i => i !== item); items.unshift(item); }));
function stepLayer(item, direction) {
  const visible = visibleItems(), next = visible[visible.indexOf(item) + direction]; if (!next) return;
  const from = items.indexOf(item), to = items.indexOf(next);
  items.splice(from, 1); items.splice(to, 0, item);
}
$('#layer-backward').onclick = action(() => editSelected(item => stepLayer(item, -1)));
$('#layer-forward').onclick = action(() => editSelected(item => stepLayer(item, 1)));
$('#remove').onclick = action(async () => { await editSelected(item => { items = items.filter(i => i !== item); selected = null; }); renderLibrary(); });
$('#exclude-selected').onclick = action(() => selectedItem() && toggleExclusion(selectedItem().id));
async function restoreHistory(direction) {
  if (loading) throw new Error('Дождитесь загрузки изображений');
  const restored = history[direction](items);
  if (!restored) return;
  clearTimeout(wheelTimer); wheelTimer = null; wheelItem = null; endDrag();
  items = restored; selected = null;
  await loadImages(); draw(); renderLibrary();
}
function queueHistory(direction) {
  historyQueue = historyQueue.catch(() => {}).then(() => restoreHistory(direction));
  return historyQueue;
}
$('#undo').onclick = action(() => queueHistory('undo'));
$('#redo').onclick = action(() => queueHistory('redo'));
window.addEventListener('keydown', event => {
  if (generating || document.querySelector('dialog[open]')) return;
  if (event.key === 'Escape' && $('#preset-menu').matches(':popover-open')) { event.preventDefault(); closeCoverSizes(true); return; }
  const target = event.target;
  const editingText = target.isContentEditable || target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' && ['text', 'number', 'url', 'password', 'email', 'tel', 'search'].includes(target.type);
  if (editingText) return;
  const direction = historyShortcut(event);
  if (direction) { event.preventDefault(); action(() => queueHistory(direction))(); return; }
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return;
  if (event.key === 'Delete' && selected) { event.preventDefault(); $('#remove').click(); }
  if (event.key === 'Escape') { selected = null; draw({ selectionOnly: true }); }
});
async function renderCoverBlob() {
  const exportItems = structuredClone(visibleItems()), s = structuredClone(state.settings);
  const sources = new Map(state.photos.map(photo => [photo.id, photo.src]));
  if (!exportItems.length) throw new Error('Сначала добавьте фотографии на холст');
  let surface, output;
  try {
    await saveQueue;
    // Export originals one at a time to keep memory bounded, even for a large archive.
    const size = renderDimensions(s.width, s.height);
    surface = document.createElement('canvas'); surface.width = size.width; surface.height = size.height;
    const context = smooth(surface.getContext('2d')), scale = surface.width / s.width;
    context.setTransform(scale, 0, 0, surface.height / s.height, 0, 0);
    context.fillStyle = s.background; context.fillRect(0, 0, s.width, s.height);
    for (const item of exportItems) {
      const response = await fetch(sources.get(item.id));
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
    return blob;
  } finally {
    if (output && output !== surface) output.width = output.height = 0;
    if (surface) surface.width = surface.height = 0;
  }
}
$('#export').onclick = action(async () => {
  if (exporting || generating || loading) return;
  const button = $('#export'), s = state.settings;
  exporting = true; draw(); button.textContent = 'Готовим PNG…';
  try {
    const blob = await renderCoverBlob();
    const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = `kero-header-${Date.now()}-${s.width}x${s.height}.png`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000); toast('Обложка готова. PNG передан в загрузки браузера.');
  } finally { exporting = false; button.textContent = 'Экспорт PNG'; draw(); }
});
const coverDialog = $('#cover-dialog'), coverForm = $('#cover-form');
function updateCoverSubmit() { $('#cover-submit').disabled = !coverPayload || !state.hasToken || coverUploading; }
function showCoverError(message) { $('#cover-error').textContent = message; $('#cover-error').hidden = false; }
$('#install-cover').onclick = action(async () => {
  if (exporting || generating || loading) return;
  const session = ++coverSession;
  coverPayload = null; $('#cover-error').hidden = true;
  $('#cover-preview').hidden = true; $('#cover-preparing').hidden = false;
  coverForm.elements.community.value = `https://vk.ru/${savedSettings.community}`;
  updateCoverSubmit(); coverDialog.showModal();
  try {
    const blob = await renderCoverBlob();
    if (session !== coverSession || !coverDialog.open) return;
    if (blob.size > 30_000_000) throw new Error('Обложка больше 30 МБ. Уменьшите размер холста.');
    const encoded = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = () => reject(new Error('Не удалось подготовить обложку')); reader.readAsDataURL(blob); });
    if (session !== coverSession || !coverDialog.open) return;
    coverPayload = encoded; coverPreviewUrl = URL.createObjectURL(blob);
    $('#cover-preview').src = coverPreviewUrl; $('#cover-preview').hidden = false;
    if (!state.hasToken) showCoverError('Добавьте токен в настройках подключения VK, затем подтвердите установку.');
  } catch (error) { if (session === coverSession && coverDialog.open) showCoverError(error.message); }
  finally { if (session === coverSession) { $('#cover-preparing').hidden = true; updateCoverSubmit(); } }
});
$('#cover-close').onclick = $('#cover-cancel').onclick = () => { if (!coverUploading) coverDialog.close(); };
$('#cover-connection').onclick = openConnection;
coverDialog.addEventListener('cancel', event => { if (coverUploading) event.preventDefault(); });
coverDialog.addEventListener('close', () => {
  coverSession++; coverPayload = null;
  if (coverPreviewUrl) URL.revokeObjectURL(coverPreviewUrl);
  coverPreviewUrl = null; $('#cover-preview').removeAttribute('src');
});
coverForm.onsubmit = async event => {
  event.preventDefault();
  if (coverUploading || !coverPayload || !coverForm.reportValidity()) return;
  coverUploading = true; coverDialog.dataset.busy = 'true'; $('#cover-error').hidden = true;
  for (const element of coverForm.elements) element.disabled = true;
  $('#cover-submit').textContent = 'Устанавливаем…';
  try {
    await api('cover', { community: coverForm.elements.community.value, data: coverPayload, confirmed: true });
    coverDialog.close(); toast('Обложка сообщества установлена в VK.');
  } catch (error) { showCoverError(error.message); }
  finally {
    coverUploading = false; delete coverDialog.dataset.busy;
    for (const element of coverForm.elements) element.disabled = false;
    $('#cover-submit').textContent = 'Установить обложку'; updateCoverSubmit();
  }
};
function changeLibraryView(change) {
  change(); limit = 60; renderLibrary(); $('#library-content').scrollTop = 0;
}
document.querySelectorAll('.filter').forEach(button => button.onclick = () => {
  if (filter !== button.dataset.filter) changeLibraryView(() => { filter = button.dataset.filter; });
});
document.querySelectorAll('.source-tab').forEach(button => button.onclick = () => {
  if (libraryOrigin !== button.dataset.source) changeLibraryView(() => { libraryOrigin = button.dataset.source; });
});
document.querySelectorAll('[data-sort]').forEach(button => button.onclick = () => changeLibraryView(() => {
  const current = librarySort[libraryOrigin];
  librarySort[libraryOrigin] = { key: button.dataset.sort, direction: current.key === button.dataset.sort && current.direction === 'desc' ? 'asc' : 'desc' };
}));
$('#import').onclick = () => $('#file-input').click();
$('#delete-files').onclick = action(async () => {
  if (loading || generating) throw new Error('Дождитесь завершения текущей операции');
  const source = libraryOrigin;
  const title = source === 'vk' ? 'Очистить файлы из VK?' : 'Очистить добавленные файлы?';
  const description = source === 'vk'
    ? 'Будут удалены скачанные файлы VK, включая исключённые'
    : 'Все добавленные с компьютера фотографии, включая исключённые, будут удалены из библиотеки проекта.';
  if (!await confirmAction({ title, description, label: 'Очистить файлы' })) return;
  const button = $('#delete-files'); button.disabled = true;
  try {
    await saveQueue;
    const result = await api('files/delete', { source }), removedIds = new Set(result.ids);
    items = items.filter(item => !removedIds.has(item.id)); history.clear();
    if (!selectedItem()) selected = null; endDrag();
    for (const [id, bitmap] of images) if (removedIds.has(id)) { photoRenderer.release(bitmap); bitmap.close(); images.delete(id); }
    for (const id of removedIds) librarySizes.delete(id);
    await refresh();
    toast(`Удалено файлов: ${result.removed}.`);
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
        const bitmap = await createImageBitmap(file), dimensions = { width: bitmap.width, height: bitmap.height }; bitmap.close();
        const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = reject; reader.readAsDataURL(file); });
        const result = await api('import', { name: file.name, data }); librarySizes.set(result.id, Promise.resolve(dimensions)); imported++;
      } catch (e) { errors.push(`${file.name}: ${e.message || 'не удалось прочитать изображение'}`); }
    }
    if (imported) { libraryOrigin = 'local'; filter = 'active'; }
    await refresh();
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
    $('#connect-dialog').close(); renderLibrary(); draw(); updateCoverSubmit();
    if (coverDialog.open && state.hasToken) $('#cover-error').hidden = true;
    toast(candidate ? 'VK подтвердил доступ. Токен сохранён в памяти сервера.' : 'Подключение VK сохранено.');
  } catch (e) { error.textContent = e.message; error.hidden = false; }
  finally { button.disabled = false; button.textContent = 'Сохранить подключение'; }
});
$('#forget-token').onclick = action(async () => { await api('token', { token: '' }); state.hasToken = false; updateCoverSubmit(); $('#connect-form').elements.token.value = ''; $('#connect-form').elements.token.placeholder = 'Вставьте токен VK'; toast('Токен удалён из памяти сервера. Если он задан в .env, удалите его и там.'); });
$('#sync').onclick = action(async () => { if (!state.hasToken) { openConnection(); return; } await saveQueue; await api('sync', {}); pollSync(); });
async function pollSync() {
  if (polling) return; polling = true; $('#sync').disabled = true;
  try {
    while (true) {
      const progress = await api('sync'), el = $('#sync-status'); el.hidden = false; el.classList.toggle('error', Boolean(progress.error || progress.failed || progress.warnings.length)); el.textContent = syncMessage(progress);
      if (!progress.running) { await saveQueue; await refresh(); break; }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } catch (e) { report(e); } finally { polling = false; $('#sync').disabled = false; }
}
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => {
  if (event.target !== dialog || dialog.dataset.busy === 'true') return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
}));
const workspace = $('.workspace'), parametersPanel = $('#parameters-panel'), parametersContent = $('#parameters-content'), parametersToggle = $('#toggle-parameters'), parametersShow = $('#show-parameters');
function setParametersHidden(hidden) {
  closeCoverSizes(); closeOrderMenu();
  const focused = parametersPanel.contains(document.activeElement) || document.activeElement === parametersShow;
  workspace.classList.toggle('parameters-hidden', hidden); parametersContent.inert = hidden;
  parametersContent.setAttribute('aria-hidden', String(hidden)); parametersShow.hidden = !hidden;
  parametersToggle.setAttribute('aria-expanded', String(!hidden));
  if (focused) (hidden ? parametersShow : parametersToggle).focus({ preventScroll: true });
  try { localStorage.setItem('kero.parametersHidden', String(hidden)); } catch {}
}
parametersToggle.onclick = () => setParametersHidden(true);
parametersShow.onclick = () => setParametersHidden(false);
try { setParametersHidden(localStorage.getItem('kero.parametersHidden') === 'true'); } catch {}
function schedulePreviewResize() {
  canvasBounds = null;
  layoutDirty = true;
  if (state) draw({ selectionOnly: true });
}
const editorResizeObserver = new ResizeObserver(schedulePreviewResize);
editorResizeObserver.observe(canvasWrap); editorResizeObserver.observe($('.editor-top'));
window.addEventListener('resize', schedulePreviewResize);
window.addEventListener('scroll', () => { canvasBounds = null; }, true);
await refresh().catch(report);
