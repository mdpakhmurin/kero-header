export const PREVIEW_EDGE = 1200;

const CACHE_NAME = 'kero-previews-v1', CACHE_BUDGET = 128 * 1024 * 1024;
export function previewCacheKey(photo) {
  if (!/^[a-f0-9]{64}$/.test(photo.version || '')) return null;
  return `/__previews/v1/${encodeURIComponent(photo.id)}?version=${photo.version}`;
}

// Storage is optional (private browsing, quota limits, etc.). Never let a cache
// failure prevent editing. Only lossless, resized previews are stored here.
export function createPreviewCache({ storage = globalThis.caches, busy = () => false } = {}) {
  let opened, timer, writing = false;
  const pending = new Map();
  const open = () => opened ||= Promise.resolve().then(() => storage?.open(CACHE_NAME)).catch(() => null);
  async function trim(cache, allowed) {
    let bytes = 0;
    for (const key of (await cache.keys()).reverse()) {
      const relative = new URL(key.url).pathname + new URL(key.url).search;
      if (allowed && !allowed.has(relative)) { await cache.delete(key); continue; }
      const response = await cache.match(key);
      bytes += Number(response?.headers.get('X-Preview-Bytes')) || CACHE_BUDGET + 1;
      if (bytes > CACHE_BUDGET) await cache.delete(key);
    }
  }
  function schedule() {
    if (!timer && !writing && pending.size) timer = setTimeout(flush, 500);
  }
  async function flush() {
    timer = null;
    if (busy()) { schedule(); return; }
    writing = true;
    let cache, written = 0;
    try {
      cache = await open();
      while (cache && pending.size && !busy()) {
        const [key, entry] = pending.entries().next().value; pending.delete(key);
        const { image, width, height } = entry;
        if (!image.width || !image.height) continue; // Released by undo / another composition.
        const canvas = document.createElement('canvas');
        try {
          canvas.width = image.width; canvas.height = image.height;
          canvas.getContext('2d').drawImage(image, 0, 0);
          const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
          if (blob && blob.size <= CACHE_BUDGET) {
            await cache.put(key, new Response(blob, { headers: { 'Content-Type': 'image/png', 'X-Original-Width': String(width), 'X-Original-Height': String(height), 'X-Preview-Bytes': String(blob.size) } }));
            if (++written % 16 === 0) await trim(cache);
          }
        } finally { canvas.width = canvas.height = 0; }
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      if (!cache) pending.clear();
    } catch { pending.clear(); }
    finally { try { if (cache) await trim(cache); } catch { /* Quota / storage restrictions. */ } writing = false; schedule(); }
  }
  return {
    async read(photo, decode = blob => createImageBitmap(blob)) {
      const key = previewCacheKey(photo); if (!key) return null;
      let cache;
      try {
        cache = await open(); const response = await cache?.match(key); if (!response) return null;
        const width = Number(response.headers.get('X-Original-Width')), height = Number(response.headers.get('X-Original-Height'));
        if (!(width > 0 && height > 0)) throw new Error('Invalid preview');
        return { image: await decode(await response.blob()), width, height };
      } catch { await cache?.delete(key).catch(() => {}); return null; }
    },
    remember(photo, decoded) {
      const key = previewCacheKey(photo); if (!key) return;
      pending.set(key, decoded); schedule();
    },
    async prune(photos) {
      const allowed = new Set(photos.filter(photo => photo.available).map(previewCacheKey).filter(Boolean));
      for (const key of pending.keys()) if (!allowed.has(key)) pending.delete(key);
      try { const cache = await open(); if (cache) await trim(cache, allowed); } catch { /* Optional cache. */ }
    },
  };
}

// Ask the decoder for the final size instead of decoding a full-resolution
// bitmap and then decoding/resizing it a second time.
export async function decodePreview(blob, photo, decode = createImageBitmap) {
  const known = photo.width > 0 && photo.height > 0;
  const factor = known ? Math.min(1, PREVIEW_EDGE / Math.max(photo.width, photo.height)) : 1;
  let image = await decode(blob, factor < 1 ? {
    resizeWidth: Math.max(1, Math.round(photo.width * factor)),
    resizeHeight: Math.max(1, Math.round(photo.height * factor)),
    resizeQuality: 'high',
  } : undefined);
  const width = known ? photo.width : image.width, height = known ? photo.height : image.height;
  try {
    if (!known && Math.max(width, height) > PREVIEW_EDGE) {
      const scale = PREVIEW_EDGE / Math.max(width, height);
      const reduced = await decode(image, { resizeWidth: Math.max(1, Math.round(width * scale)), resizeHeight: Math.max(1, Math.round(height * scale)), resizeQuality: 'high' });
      image.close(); image = reduced;
    }
    return { image, width, height };
  } catch (error) { image.close(); throw error; }
}
