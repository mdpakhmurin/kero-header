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
