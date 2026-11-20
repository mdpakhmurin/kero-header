export function librarySource(photo) {
  return photo.source || (photo.id.startsWith('local_') ? 'local' : 'vk');
}

export function createFavoritesView() {
  let scope = null, retained = new Set();
  const reset = () => { scope = null; retained.clear(); };
  return {
    ids(favorites, nextScope) {
      if (nextScope == null) { reset(); return new Set(favorites); }
      if (scope !== nextScope) { retained.clear(); scope = nextScope; }
      for (const id of favorites) retained.add(id);
      return new Set(retained);
    },
    reset,
  };
}

export function canvasLayerOrder(frames, favorites, enabled) {
  if (!enabled) return frames;
  const ids = new Set(favorites);
  return [...frames.filter(frame => !ids.has(frame.id)), ...frames.filter(frame => ids.has(frame.id))];
}

export function photoTime(photo) {
  const time = Number(librarySource(photo) === 'local' ? photo.addedAt / 1000 : photo.date);
  return Number.isFinite(time) && time > 0 ? time : null;
}

export function photoTitle(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 200 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Название — от 1 до 200 символов без переносов');
  return value.trim();
}

function titleExtension(title) { return /\.[a-z][a-z0-9]{0,11}$/i.exec(title || '')?.[0] || ''; }
export function photoNameParts(photo) {
  const extension = photo.nameExtension ?? titleExtension(photo.title);
  const title = photo.customTitle || photo.title || '';
  return { name: extension && title.toLowerCase().endsWith(extension.toLowerCase()) ? title.slice(0, -extension.length) : title, extension };
}
export function photoDisplayName(photo) { const { name, extension } = photoNameParts(photo); return name + extension; }
export function renamedPhotoTitle(photo, value) {
  const title = photoTitle(value), { extension } = photoNameParts(photo);
  if (titleExtension(title).toLowerCase() !== extension.toLowerCase()) throw new Error('Расширение файла менять нельзя');
  const name = extension ? title.slice(0, -extension.length).trim() : title;
  if (!name) throw new Error('Введите название фотографии');
  return photoTitle(name + extension);
}

export function orderPhotos(photos, key, direction = 'desc') {
  if (key === 'newest' || key === 'oldest') return sortLibraryPhotos(photos, 'date', key === 'oldest' ? 'asc' : 'desc');
  return sortLibraryPhotos(photos, key, direction);
}

export function selectedLibraryPhotos(ids, photos, exclusions, community) {
  const chosen = new Set(ids), excluded = new Set(exclusions);
  return photos.filter(photo => chosen.has(photo.id) && photo.available && !excluded.has(photo.id) && (librarySource(photo) === 'local' || photo.community === community));
}

export function sortLibraryPhotos(photos, key = 'date', direction = 'desc') {
  const value = photo => {
    const n = key === 'ratio' ? (photo.width > 0 && photo.height > 0 ? Number(photo.width) / Number(photo.height) : null) : photoTime(photo);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return [...photos].sort((a, b) => {
    if (key === 'name') return String(a.title || '').localeCompare(String(b.title || ''), 'ru', { numeric: true, sensitivity: 'base' }) * (direction === 'asc' ? 1 : -1) || a.id.localeCompare(b.id);
    const av = value(a), bv = value(b);
    if (av === null && bv !== null) return 1;
    if (bv === null && av !== null) return -1;
    return (av !== null && bv !== null ? (av - bv) * (direction === 'asc' ? 1 : -1) : 0) || a.id.localeCompare(b.id);
  });
}

export function photoSource(photo) {
  if (/^https:\/\/(?:vk\.ru|vk\.com)\/wall-?\d+_\d+$/.test(photo.postPage || '')) {
    return { href: photo.postPage, label: 'Открыть пост VK' };
  }
  const vk = /^vk_(-?\d+)_(\d+)$/.exec(photo.id);
  if (vk) return { href: `https://vk.ru/photo${vk[1]}_${vk[2]}`, label: 'Открыть фото VK' };
  if (photo.available && /^local_[a-f0-9]{64}$/.test(photo.id)) {
    return { href: photo.src?.startsWith('blob:') ? photo.src : `/images/${photo.id}`, label: 'Открыть изображение' };
  }
  return null;
}
