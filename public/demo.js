import { defaults, validateSettings } from './settings.js';

export function initialMode(search, remembered) {
  const mode = new URLSearchParams(search).get('mode');
  return ['local', 'demo'].includes(mode) ? mode : remembered === 'demo' ? 'demo' : 'local';
}

// Every runtime read/write passes through this boundary. Demo deliberately has
// no network fallback, including when storage is unavailable or an API is unknown.
export function createClient({ demoMode, demo, fetcher = globalThis.fetch }) {
  return {
    async request(path, data) {
      if (demoMode) return demo.request(path, data);
      const response = await fetcher(`/api/${path}`, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      const result = await response.json();
      if (!response.ok) throw Object.assign(new Error(result.error || 'Ошибка сервера'), { status: response.status });
      return result;
    },
    async photoBlob(photo) {
      if (demoMode) return demo.photoBlob(photo.id);
      const response = await fetcher(photo.src);
      if (!response.ok) throw new Error('Не удалось прочитать фотографию. Обновите библиотеку.');
      return response.blob();
    },
  };
}

export function createBrowserStore(factory = globalThis.indexedDB) {
  let opened;
  function open() {
    return opened ||= new Promise((resolve, reject) => {
      if (!factory) { reject(new Error('Браузер не поддерживает локальное хранилище фотографий')); return; }
      const request = factory.open('kero-demo-v1', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('meta');
        request.result.createObjectStore('photos', { keyPath: 'id' });
      };
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
      request.onerror = () => reject(new Error('Не удалось открыть хранилище браузера. Проверьте разрешения сайта.'));
      request.onblocked = () => reject(new Error('Закройте другие вкладки демо-редактора и попробуйте снова'));
    });
  }
  async function transaction(names, mode, run) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(names, mode); let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(new Error(tx.error?.name === 'QuotaExceededError' ? 'В хранилище браузера недостаточно места. Удалите ненужные фотографии.' : 'Не удалось сохранить данные в браузере'));
      try { run(name => tx.objectStore(name), value => { result = value; }); }
      catch (error) { tx.abort(); reject(error); }
    });
  }
  return {
    read() {
      return transaction(['meta', 'photos'], 'readonly', (store, result) => {
        const data = {}; result(data);
        for (const key of ['settings', 'exclusions']) store('meta').get(key).onsuccess = event => { data[key] = event.target.result; };
        store('photos').getAll().onsuccess = event => { data.photos = event.target.result; };
      });
    },
    saveMeta(key, value) { return transaction(['meta'], 'readwrite', store => store('meta').put(value, key)); },
    putPhoto(photo) {
      return transaction(['photos'], 'readwrite', store => {
        const photos = store('photos');
        photos.get(photo.id).onsuccess = event => photos.put({ ...photo, addedAt: event.target.result?.addedAt || photo.addedAt });
      });
    },
    clearPhotos() {
      return transaction(['meta', 'photos'], 'readwrite', (store, result) => {
        store('photos').getAllKeys().onsuccess = event => result(event.target.result);
        store('photos').clear(); store('meta').put([], 'exclusions');
      });
    },
  };
}

function imageType(bytes) {
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte)) return 'image/png';
  const ascii = new TextDecoder().decode(bytes);
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export function createDemoBackend({ store = createBrowserStore(), urls = globalThis.URL, digest = bytes => crypto.subtle.digest('SHA-256', bytes), now = Date.now } = {}) {
  const originals = new Map(), objectUrls = new Map();
  async function state() {
    const data = await store.read(), photos = data.photos || [], ids = new Set(photos.map(photo => photo.id));
    for (const [id, url] of objectUrls) if (!ids.has(id)) { urls.revokeObjectURL(url); objectUrls.delete(id); }
    originals.clear();
    return {
      settings: validateSettings(data.settings || defaults), exclusions: data.exclusions || [], lastSync: null, hasToken: false,
      sync: { running: false, message: '', warnings: [] },
      photos: photos.map(({ blob, ...photo }) => {
        originals.set(photo.id, blob);
        if (!objectUrls.has(photo.id)) objectUrls.set(photo.id, urls.createObjectURL(blob));
        return { ...photo, source: 'local', available: true, src: objectUrls.get(photo.id), version: photo.id.slice(6) };
      }),
    };
  }
  async function importPhoto({ file, dimensions }) {
    if (!(file instanceof Blob) || file.size > 30_000_000) throw new Error('Максимум 30 МБ на фотографию');
    const bytes = new Uint8Array(await file.arrayBuffer()), mime = imageType(bytes.subarray(0, 12));
    if (!mime) throw new Error('Поддерживаются JPEG, PNG и WebP');
    if (!(dimensions?.width > 0 && dimensions?.height > 0)) throw new Error('Не удалось определить размер фотографии');
    const hash = Array.from(new Uint8Array(await digest(bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
    const id = `local_${hash}`;
    await store.putPhoto({ id, source: 'local', title: String(file.name || 'Изображение').slice(0, 200), width: dimensions.width, height: dimensions.height, addedAt: now(), mime, bytes: file.size, blob: file.slice(0, file.size, mime) });
    return { id };
  }
  return {
    async request(path, data) {
      if (path === 'state' && data === undefined) return state();
      if (path === 'settings') { const settings = validateSettings(data); await store.saveMeta('settings', settings); return settings; }
      if (path === 'exclusions') {
        if (!Array.isArray(data) || data.length > 100000 || !data.every(id => /^local_[a-f0-9]{64}$/.test(id))) throw new Error('Некорректный список исключений');
        const exclusions = [...new Set(data)].sort(); await store.saveMeta('exclusions', exclusions); return exclusions;
      }
      if (path === 'import') return importPhoto(data);
      if (path === 'files/delete' && data?.source === 'local') { const ids = await store.clearPhotos(); return { ids, removed: ids.length }; }
      throw new Error('Эта функция недоступна в демо-режиме');
    },
    async photoBlob(id) {
      const blob = originals.get(id);
      if (!blob) throw new Error('Фотография отсутствует в хранилище браузера');
      return blob;
    },
    dispose() { for (const url of objectUrls.values()) urls.revokeObjectURL(url); objectUrls.clear(); originals.clear(); },
  };
}
