import { photoSource } from './library.js';

export function createPhotoViewer(dialog) {
  const image = dialog.querySelector('#viewer-image'), message = dialog.querySelector('#viewer-message');
  const strip = dialog.querySelector('#viewer-strip'), position = dialog.querySelector('#viewer-position');
  const previous = dialog.querySelector('#viewer-previous'), next = dialog.querySelector('#viewer-next');
  const source = dialog.querySelector('#viewer-source');
  let photos = [], index = 0, thumbs = [];

  function show(target) {
    if (!photos.length) return;
    thumbs[index]?.classList.remove('active');
    thumbs[index]?.removeAttribute('aria-current');
    index = Math.max(0, Math.min(photos.length - 1, target));
    const photo = photos[index];
    position.textContent = `${index + 1} / ${photos.length}`;
    previous.disabled = index === 0; next.disabled = index === photos.length - 1;
    image.hidden = true; message.hidden = false; message.textContent = 'Загружаем фото…';
    image.alt = photo.title;
    image.onload = () => { image.hidden = false; message.hidden = true; };
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
    image.onload = image.onerror = null; image.removeAttribute('src');
    strip.replaceChildren(); photos = []; thumbs = [];
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
        const thumbnail = document.createElement('img'); thumbnail.src = candidate.src; thumbnail.alt = ''; thumbnail.loading = 'lazy';
        button.append(thumbnail); button.onclick = () => show(i); strip.append(button);
        return button;
      });
      dialog.showModal(); show(start);
    },
  };
}
