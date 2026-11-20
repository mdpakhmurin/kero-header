import { photoSource, librarySource } from './library.js';
import { touchPair, swipeDirection } from './gestures.js';

export function createViewerImageCache({ createImage = () => new Image(), maximum = 3 } = {}) {
  const entries = new Map();
  return {
    load(src) {
      if (entries.has(src)) { const ready = entries.get(src); entries.delete(src); entries.set(src, ready); return ready; }
      const image = createImage(); image.decoding = 'async';
      const ready = new Promise((resolve, reject) => {
        image.onload = async () => {
          try { await image.decode?.(); } catch { /* A loaded image can still be displayed when decode is unavailable. */ }
          image.onload = image.onerror = null; resolve(image);
        };
        image.onerror = () => { image.onload = image.onerror = null; reject(new Error('Не удалось открыть изображение')); };
        image.src = src;
      });
      entries.set(src, ready);
      ready.catch(() => { if (entries.get(src) === ready) entries.delete(src); });
      while (entries.size > maximum) entries.delete(entries.keys().next().value);
      return ready;
    },
    clear() { entries.clear(); },
  };
}

export function imageViewport(image, viewport, zoom = 1, pan = { x: 0, y: 0 }) {
  const fit = Math.min(viewport.width / image.width, viewport.height / image.height);
  const min = Math.min(1, 1 / fit), max = Math.max(8, 1 / fit);
  zoom = Math.max(min, Math.min(max, zoom));
  const maxX = Math.max(0, (image.width * fit * zoom - viewport.width) / 2);
  const maxY = Math.max(0, (image.height * fit * zoom - viewport.height) / 2);
  return { zoom, fit, min, max, x: Math.max(-maxX, Math.min(maxX, pan.x)), y: Math.max(-maxY, Math.min(maxY, pan.y)), percent: fit * zoom * 100, canPan: maxX > 0 || maxY > 0 };
}

export function createPhotoViewer(dialog, { onAdd, canAdd = () => true, onError = () => {}, isFavorite = () => false, onFavorite, onRename, onRemove } = {}) {
  let image = dialog.querySelector('#viewer-image');
  const message = dialog.querySelector('#viewer-message'), imageCache = createViewerImageCache();
  image.hidden = true;
  const strip = dialog.querySelector('#viewer-strip'), position = dialog.querySelector('#viewer-position');
  const previous = dialog.querySelector('#viewer-previous'), next = dialog.querySelector('#viewer-next');
  const source = dialog.querySelector('#viewer-source');
  const add = dialog.querySelector('#viewer-add');
  const favorite = dialog.querySelector('#viewer-favorite');
  const rename = dialog.querySelector('#viewer-rename'), remove = dialog.querySelector('#viewer-delete');
  const wrap = dialog.querySelector('.viewer-image-wrap'), zoomOut = dialog.querySelector('#viewer-zoom-out'), zoomIn = dialog.querySelector('#viewer-zoom-in');
  const zoomPercent = dialog.querySelector('#viewer-zoom-percent'), fitButton = dialog.querySelector('#viewer-fit');
  const zoomControls = [zoomOut, zoomIn, zoomPercent, fitButton];
  let photos = [], index = 0, thumbs = [];
  let zoom = 1, pan = { x: 0, y: 0 }, drag = null;
  let adding = false, addedPhoto = null;
  let savingFavorite = false;
  let showVersion = 0, changing = false, messageTimer;
  let editingFile = false;
  function renderFileActions() {
    rename.hidden = !onRename; remove.hidden = !onRemove;
    rename.disabled = remove.disabled = editingFile || changing || !photos[index];
  }
  for (const [button, callback] of [[rename, onRename], [remove, onRemove]]) button.onclick = async () => {
    if (editingFile || !photos[index] || !callback) return;
    editingFile = true; renderFileActions();
    try { await callback(photos[index]); } catch (failure) { onError(failure); }
    finally { editingFile = false; renderFileActions(); renderAdd(); }
  };
  function renderCaption() {
    const photo = photos[index]; if (!photo) return;
    const dimensions = !changing && !image.hidden && image.naturalWidth ? ` · ${image.naturalWidth} × ${image.naturalHeight} px` : '';
    dialog.querySelector('#viewer-photo-name').textContent = (photo.title || 'Фото из VK') + dimensions;
  }
  function renderFavorite() {
    const photo = photos[index], selected = photo && isFavorite(photo);
    favorite.hidden = !onFavorite; favorite.disabled = !photo; favorite.setAttribute('aria-busy', String(savingFavorite));
    favorite.classList.toggle('active', Boolean(selected)); favorite.setAttribute('aria-pressed', String(Boolean(selected)));
    favorite.title = selected ? 'Удалить из избранного' : 'Добавить в избранное'; favorite.setAttribute('aria-label', favorite.title);
  }
  favorite.onclick = async () => {
    const photo = photos[index]; if (savingFavorite || !photo || !onFavorite) return;
    savingFavorite = true; renderFavorite();
    try { await onFavorite(photo); } catch (failure) { onError(failure); }
    finally { savingFavorite = false; renderFavorite(); }
  };
  function renderAdd() {
    const photo = photos[index];
    add.hidden = typeof onAdd !== 'function';
    add.disabled = adding || !photo || !canAdd(photo);
    add.title = adding ? 'Добавляем фото…' : photo?.id === addedPhoto ? 'Добавить ещё копию на холст' : 'Добавить фото на холст';
    add.setAttribute('aria-label', add.title);
    add.setAttribute('aria-busy', String(adding));
  }
  add.onclick = async () => {
    const photo = photos[index];
    if (adding || !photo || !canAdd(photo) || !onAdd) return;
    adding = true; renderAdd();
    try { await onAdd(photo); addedPhoto = photo.id; }
    catch (error) { onError(error); }
    finally { adding = false; renderAdd(); }
  };

  function geometry() {
    if (changing || !image.naturalWidth || !wrap.clientWidth || !wrap.clientHeight || image.hidden) return null;
    return imageViewport({ width: image.naturalWidth, height: image.naturalHeight }, { width: wrap.clientWidth, height: wrap.clientHeight }, zoom, pan);
  }
  function renderZoom() {
    const view = geometry(); if (!view) return;
    zoom = view.zoom; pan = { x: view.x, y: view.y };
    image.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;
    zoomPercent.textContent = `${view.percent.toLocaleString('ru-RU', { maximumFractionDigits: view.percent < 10 ? 1 : 0 })}%`;
    zoomOut.disabled = zoom <= view.min + .001; zoomIn.disabled = zoom >= view.max - .001;
    zoomPercent.disabled = fitButton.disabled = false;
    wrap.classList.toggle('can-pan', view.canPan);
    fitButton.classList.toggle('active', Math.abs(zoom - 1) < .001);
  }
  function setZoom(target, point) {
    const before = geometry(); if (!before) return;
    const next = Math.max(before.min, Math.min(before.max, target));
    if (point) {
      const ratio = next / zoom;
      pan = { x: point.x - (point.x - pan.x) * ratio, y: point.y - (point.y - pan.y) * ratio };
    }
    zoom = next; renderZoom();
  }
  function fit() { zoom = 1; pan = { x: 0, y: 0 }; renderZoom(); }
  zoomOut.onclick = () => setZoom(zoom / 1.25);
  zoomIn.onclick = () => setZoom(zoom * 1.25);
  zoomPercent.onclick = () => { const view = geometry(); if (view) setZoom(1 / view.fit); };
  fitButton.onclick = fit;
  image.draggable = false;
  wrap.addEventListener('wheel', event => {
    if (event.target.closest('.viewer-zoom-toolbar') || !geometry()) return;
    event.preventDefault();
    const rect = wrap.getBoundingClientRect();
    setZoom(zoom * Math.exp(-event.deltaY * .0015), { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 });
  }, { passive: false });
  const touches = new Map();
  wrap.onpointerdown = event => {
    const view = geometry();
    if (event.button !== 0 || event.target.closest('.viewer-zoom-toolbar') || !view) return;
    if (event.pointerType === 'touch') {
      event.preventDefault(); touches.set(event.pointerId, { x: event.clientX, y: event.clientY }); wrap.setPointerCapture(event.pointerId);
      if (touches.size === 2) { drag = { pair: touchPair(touches.values()), zoom, pan: { ...pan } }; return; }
      if (touches.size > 2) return;
      drag = { x: event.clientX, y: event.clientY, pan: { ...pan }, swipe: !view.canPan, time: Date.now() }; return;
    }
    if (!event.isPrimary || !view.canPan) return;
    event.preventDefault(); drag = { x: event.clientX, y: event.clientY, pan: { ...pan } };
    wrap.setPointerCapture(event.pointerId); wrap.classList.add('dragging');
  };
  wrap.onpointermove = event => {
    if (touches.has(event.pointerId)) touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (!drag) return;
    if (drag.pair) {
      const pair = touchPair(touches.values()), view = geometry(); if (!pair || !view) return;
      const rect = wrap.getBoundingClientRect(), target = Math.max(view.min, Math.min(view.max, drag.zoom * pair.distance / drag.pair.distance)), scale = target / drag.zoom;
      const origin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      pan = { x: pair.x - origin.x + (drag.pan.x - drag.pair.x + origin.x) * scale, y: pair.y - origin.y + (drag.pan.y - drag.pair.y + origin.y) * scale };
      zoom = target; renderZoom(); return;
    }
    if (drag.swipe) return;
    pan = { x: drag.pan.x + event.clientX - drag.x, y: drag.pan.y + event.clientY - drag.y }; renderZoom();
  };
  const endDrag = () => { drag = null; touches.clear(); wrap.classList.remove('dragging'); };
  wrap.onpointerup = event => {
    const direction = drag?.swipe ? swipeDirection(drag, { x: event.clientX, y: event.clientY, time: Date.now() }) : 0;
    endDrag(); if (direction) show(index + direction);
  };
  wrap.onpointercancel = wrap.onlostpointercapture = endDrag;
  window.addEventListener('resize', () => { if (dialog.open) renderZoom(); });

  async function show(target) {
    if (!photos.length) return;
    thumbs[index]?.classList.remove('active');
    thumbs[index]?.removeAttribute('aria-current');
    index = Math.max(0, Math.min(photos.length - 1, target));
    const photo = photos[index];
    const version = ++showVersion; changing = true; clearTimeout(messageTimer); message.hidden = true;
    renderAdd(); renderFavorite(); renderFileActions(); renderCaption();
    position.textContent = `${index + 1} / ${photos.length}`;
    previous.disabled = index === 0; next.disabled = index === photos.length - 1;
    endDrag(); wrap.setAttribute('aria-busy', 'true');
    messageTimer = setTimeout(() => {
      message.classList.toggle('loading', !image.hidden); message.textContent = 'Загружаем фото…'; message.hidden = false;
    }, 180);
    const link = librarySource(photo) === 'vk' ? photoSource(photo) : null;
    source.hidden = !link;
    if (link) { source.href = link.href; source.title = link.label; source.setAttribute('aria-label', link.label); }
    thumbs[index].classList.add('active'); thumbs[index].setAttribute('aria-current', 'true');
    thumbs[index].scrollIntoView({ block: 'nearest', inline: 'center' });
    try {
      const prepared = await imageCache.load(photo.src);
      if (version !== showVersion || !dialog.open) return;
      clearTimeout(messageTimer); message.hidden = true; changing = false; wrap.setAttribute('aria-busy', 'false');
      prepared.id = 'viewer-image'; prepared.alt = photo.title; prepared.draggable = false; prepared.hidden = false; prepared.style.transform = '';
      if (prepared !== image) image.replaceWith(prepared); image = prepared;
      renderCaption(); renderFileActions();
      fit();
      for (const neighbor of [photos[index - 1], photos[index + 1]]) if (neighbor) imageCache.load(neighbor.src).catch(() => {});
    } catch {
      if (version !== showVersion || !dialog.open) return;
      clearTimeout(messageTimer); changing = false; wrap.setAttribute('aria-busy', 'false'); image.hidden = true;
      message.classList.remove('loading'); message.hidden = false; message.textContent = 'Не удалось открыть изображение. Обновите библиотеку или выполните синхронизацию.';
      zoomControls.forEach(control => control.disabled = true);
      renderFileActions();
    }
  }

  previous.onclick = () => show(index - 1);
  next.onclick = () => show(index + 1);
  dialog.querySelector('#viewer-close').onclick = () => dialog.close();
  dialog.addEventListener('keydown', event => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (['+', '=', '-', '0'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      if (event.key === '0') fit(); else setZoom(zoom * (event.key === '-' ? .8 : 1.25));
      return;
    }
    const target = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: photos.length - 1 }[event.key];
    if (target === undefined) return;
    event.preventDefault(); event.stopPropagation(); show(target);
  });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
  dialog.addEventListener('close', () => {
    endDrag(); showVersion++; changing = false; clearTimeout(messageTimer); imageCache.clear();
    image.onload = image.onerror = null; image.removeAttribute('src');
    image.hidden = true; message.hidden = true;
    strip.replaceChildren(); photos = []; thumbs = [];
    addedPhoto = null;
  });

  function renderThumbs() {
      strip.replaceChildren();
      thumbs = photos.map((candidate, i) => {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'viewer-thumb';
        button.setAttribute('aria-label', `Фото ${i + 1}: ${candidate.title}`); button.title = candidate.title;
        const thumbnail = document.createElement('img'); thumbnail.src = candidate.src; thumbnail.alt = ''; thumbnail.loading = 'lazy'; thumbnail.draggable = false;
        button.append(thumbnail); button.onclick = () => show(i); strip.append(button);
        return button;
      });
  }
  return {
    refreshFavorites: renderFavorite,
    refreshPhoto(update) {
      for (const photo of photos) if (photo.id === update.id) Object.assign(photo, update);
      photos.forEach((photo, i) => { thumbs[i].title = photo.title; thumbs[i].setAttribute('aria-label', `Фото ${i + 1}: ${photo.title}`); });
      if (photos[index]?.id === update.id) { image.alt = update.title; renderCaption(); }
    },
    remove(ids) {
      if (!dialog.open) return;
      const removed = new Set(ids), current = photos[index]?.id;
      photos = photos.filter(photo => !removed.has(photo.id));
      if (!photos.length) { dialog.close(); return; }
      const keep = photos.findIndex(photo => photo.id === current);
      renderThumbs(); show(keep >= 0 ? keep : Math.min(index, photos.length - 1));
    },
    open(photo, collection) {
      photos = collection.filter(candidate => candidate.available && candidate.src);
      const start = photos.findIndex(candidate => candidate.id === photo.id);
      if (start < 0) return;
      renderThumbs(); dialog.showModal(); show(start);
    },
  };
}
