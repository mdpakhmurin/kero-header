export function librarySource(photo) {
  return photo.source || (photo.id.startsWith('local_') ? 'local' : 'vk');
}

export function photoTime(photo) {
  const time = Number(librarySource(photo) === 'local' ? photo.addedAt / 1000 : photo.date);
  return Number.isFinite(time) && time > 0 ? time : null;
}

export function selectedLibraryPhotos(ids, photos, exclusions, community) {
  const chosen = new Set(ids), excluded = new Set(exclusions);
  return photos.filter(photo => chosen.has(photo.id) && photo.available && !excluded.has(photo.id) && (librarySource(photo) === 'local' || photo.community === community));
}

export function sortLibraryPhotos(photos, key = 'date', direction = 'desc') {
  const value = photo => {
    const n = key === 'area' ? Number(photo.width) * Number(photo.height) : photoTime(photo);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return [...photos].sort((a, b) => {
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
    return { href: `/images/${photo.id}`, label: 'Открыть изображение' };
  }
  return null;
}
