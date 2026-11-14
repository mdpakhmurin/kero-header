import { photoSource } from './library.js';

export function imageViewport(image, viewport, zoom = 1, pan = { x: 0, y: 0 }) {
  const fit = Math.min(viewport.width / image.width, viewport.height / image.height);
  const min = Math.min(1, 1 / fit), max = Math.max(8, 1 / fit);
  zoom = Math.max(min, Math.min(max, zoom));
  const maxX = Math.max(0, (image.width * fit * zoom - viewport.width) / 2);
  const maxY = Math.max(0, (image.height * fit * zoom - viewport.height) / 2);
  return { zoom, fit, min, max, x: Math.max(-maxX, Math.min(maxX, pan.x)), y: Math.max(-maxY, Math.min(maxY, pan.y)), percent: fit * zoom * 100, canPan: maxX > 0 || maxY > 0 };
}

export function createPhotoViewer(dialog, { onAdd, canAdd = () => true, onError = () => {} } = {}) {
  const image = dialog.querySelector('#viewer-image'), message = dialog.querySelector('#viewer-message');
  const strip = dialog.querySelector('#viewer-strip'), position = dialog.querySelector('#viewer-position');
  const previous = dialog.querySelector('#viewer-previous'), next = dialog.querySelector('#viewer-next');
  const source = dialog.querySelector('#viewer-source');
  const add = dialog.querySelector('#viewer-add'), addLabel = dialog.querySelector('#viewer-add-label');
  const wrap = dialog.querySelector('.viewer-image-wrap'), zoomOut = dialog.querySelector('#viewer-zoom-out'), zoomIn = dialog.querySelector('#viewer-zoom-in');
  const zoomPercent = dialog.querySelector('#viewer-zoom-percent'), fitButton = dialog.querySelector('#viewer-fit');
  const zoomControls = [zoomOut, zoomIn, zoomPercent, fitButton];
  let photos = [], index = 0, thumbs = [];
  let zoom = 1, pan = { x: 0, y: 0 }, drag = null;
  let adding = false, addedPhoto = null;
  function renderAdd() {
    const photo = photos[index];
    add.hidden = typeof onAdd !== 'function';
    add.disabled = adding || !photo || !canAdd(photo);
    addLabel.textContent = adding ? 'Добавляем…' : photo?.id === addedPhoto ? 'Добавить ещё' : 'Добавить';
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
    if (!image.naturalWidth || !wrap.clientWidth || !wrap.clientHeight || image.hidden) return null;
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
  wrap.onpointerdown = event => {
    if (!event.isPrimary || event.button !== 0 || event.target.closest('.viewer-zoom-toolbar') || !geometry()?.canPan) return;
    event.preventDefault(); drag = { x: event.clientX, y: event.clientY, pan: { ...pan } };
    wrap.setPointerCapture(event.pointerId); wrap.classList.add('dragging');
  };
  wrap.onpointermove = event => {
    if (!drag) return;
    pan = { x: drag.pan.x + event.clientX - drag.x, y: drag.pan.y + event.clientY - drag.y }; renderZoom();
  };
  const endDrag = () => { drag = null; wrap.classList.remove('dragging'); };
  wrap.onpointerup = wrap.onpointercancel = endDrag;
  window.addEventListener('resize', () => { if (dialog.open) renderZoom(); });

  function show(target) {
    if (!photos.length) return;
    thumbs[index]?.classList.remove('active');
    thumbs[index]?.removeAttribute('aria-current');
    index = Math.max(0, Math.min(photos.length - 1, target));
    const photo = photos[index];
    renderAdd();
    const caption = dialog.querySelector('#viewer-photo-name');
    const name = photo.source === 'vk' ? 'Фото из VK' : photo.title;
    caption.textContent = name;
    position.textContent = `${index + 1} / ${photos.length}`;
    previous.disabled = index === 0; next.disabled = index === photos.length - 1;
    image.hidden = true; message.hidden = false; message.textContent = 'Загружаем фото…';
    zoom = 1; pan = { x: 0, y: 0 }; endDrag(); image.style.transform = '';
    zoomControls.forEach(control => control.disabled = true); zoomPercent.textContent = '—';
    image.alt = photo.title;
    image.onload = () => {
      image.hidden = false; message.hidden = true;
      caption.textContent = `${name} · ${image.naturalWidth} × ${image.naturalHeight} px`;
      fit();
    };
    image.onerror = () => { image.hidden = true; message.hidden = false; message.textContent = 'Не удалось открыть изображение. Обновите библиотеку или выполните синхронизацию.'; };
    image.src = photo.src;
    const link = photoSource(photo);
    source.hidden = !link;
    if (link) { source.href = link.href; source.title = link.label; source.setAttribute('aria-label', link.label); }
    thumbs[index].classList.add('active'); thumbs[index].setAttribute('aria-current', 'true');
    thumbs[index].scrollIntoView({ block: 'nearest', inline: 'center' });
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
    endDrag();
    image.onload = image.onerror = null; image.removeAttribute('src');
    strip.replaceChildren(); photos = []; thumbs = [];
    addedPhoto = null;
  });

  return {
    open(photo, collection) {
      photos = collection.filter(candidate => candidate.available && candidate.src);
      const start = photos.findIndex(candidate => candidate.id === photo.id);
      if (start < 0) return;
      strip.replaceChildren();
      thumbs = photos.map((candidate, i) => {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'viewer-thumb';
        button.setAttribute('aria-label', `Фото ${i + 1}: ${candidate.title}`); button.title = candidate.title;
        const thumbnail = document.createElement('img'); thumbnail.src = candidate.src; thumbnail.alt = ''; thumbnail.loading = 'lazy'; thumbnail.draggable = false;
        button.append(thumbnail); button.onclick = () => show(i); strip.append(button);
        return button;
      });
      dialog.showModal(); show(start);
    },
  };
}
