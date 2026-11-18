import { join } from 'node:path';
import { stat, unlink } from 'node:fs/promises';
import { defaults, validateSettings, readJSON, writeJSON, readImage, saveImage, imagePath, useSharedImages, validId, migrateImageFiles, migrateLocalDates } from './storage.mjs';

export async function loadWorkspace(root, { shared, legacyRoot, inheritLegacy = false, token = '' } = {}) {
  if (shared) useSharedImages(root, shared);
  let exists = false;
  try { await stat(join(root, 'cache/library.json')); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (shared && !exists) {
    const settings = validateSettings(inheritLegacy ? await readJSON(join(legacyRoot, 'config/settings.json'), defaults) : defaults);
    const exclusions = inheritLegacy ? await readJSON(join(legacyRoot, 'config/exclusions.json'), []) : [];
    const favorites = inheritLegacy ? await readJSON(join(legacyRoot, 'config/favorites.json'), []) : [];
    const library = inheritLegacy ? await readJSON(join(legacyRoot, 'cache/library.json'), { photos: {}, lastSync: null }) : { photos: {}, lastSync: null };
    const migrated = [];
    if (inheritLegacy) {
      await migrateImageFiles(legacyRoot, library); await migrateLocalDates(legacyRoot, library);
      for (const photo of Object.values(library.photos)) {
        if (!validId(photo.id)) throw new Error('Повреждён индекс существующей библиотеки');
        const originalPath = imagePath(legacyRoot, photo);
        try {
          Object.assign(photo, await saveImage(root, photo.id, await readImage(legacyRoot, photo)));
          migrated.push(originalPath);
        } catch (error) {
          if (error.code !== 'ENOENT' && !/Поддерживаются JPEG/.test(error.message)) throw error;
          photo.stored = false;
        }
      }
    }
    await writeJSON(join(root, 'config/settings.json'), settings);
    await writeJSON(join(root, 'config/exclusions.json'), exclusions);
    await writeJSON(join(root, 'config/favorites.json'), favorites);
    await writeJSON(join(root, 'cache/library.json'), library);
    for (const path of migrated) await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  const settings = validateSettings(await readJSON(join(root, 'config/settings.json'), defaults));
  const exclusions = await readJSON(join(root, 'config/exclusions.json'), []);
  const favorites = await readJSON(join(root, 'config/favorites.json'), []);
  const library = await readJSON(join(root, 'cache/library.json'), { photos: {}, lastSync: null });
  if (!shared) { await migrateImageFiles(root, library); await migrateLocalDates(root, library); }
  else await shared.commit(root, library);
  return { root, settings, exclusions, favorites, library, token, sync: { running: false, message: '', warnings: [] }, shared };
}
