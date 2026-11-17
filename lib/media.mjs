import { mkdir, readFile, writeFile, rename, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const hashData = data => createHash('sha256').update(data).digest('hex');
const extensions = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
export async function createMediaStore(root) {
  const directory = join(root, 'data/blobs'), users = join(root, 'data/users');
  const libraries = new Map(), leases = new Map(); let queue = Promise.resolve();
  const locked = task => { const result = queue.catch(() => {}).then(task); queue = result; return result; };
  const path = photo => join(directory, /^[a-f0-9]{64}$/.test(photo.hash || '') ? `${photo.hash}.${extensions[photo.mime] || 'img'}` : 'missing');
  for (const user of await readdir(users, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
    if (!user.isDirectory()) continue;
    const userRoot = join(users, user.name);
    try { libraries.set(userRoot, JSON.parse(await readFile(join(userRoot, 'cache/library.json'), 'utf8')).photos); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return {
    path,
    put(userRoot, id, data, mime) {
      return locked(async () => {
        const photo = { hash: hashData(data), mime, bytes: data.length, stored: true }, file = path(photo);
        await mkdir(directory, { recursive: true });
        let valid = false;
        try { valid = hashData(await readFile(file)) === photo.hash; } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (!valid) { const temp = `${file}.${randomUUID()}.tmp`; await writeFile(temp, data); await rename(temp, file); }
        leases.set(`${userRoot}:${id}`, photo.hash);
        return photo;
      });
    },
    commit(userRoot, library) {
      return locked(() => {
        libraries.set(userRoot, structuredClone(library.photos));
        for (const [id, photo] of Object.entries(library.photos)) if (leases.get(`${userRoot}:${id}`) === photo.hash) leases.delete(`${userRoot}:${id}`);
      });
    },
    reuse(userRoot, photo) {
      return locked(async () => {
        for (const photos of libraries.values()) {
          const candidate = photos[photo.id];
          if (!candidate || candidate.stored === false || candidate.width !== photo.width || candidate.height !== photo.height) continue;
          try {
            if (hashData(await readFile(path(candidate))) !== candidate.hash) continue;
            leases.set(`${userRoot}:${photo.id}`, candidate.hash);
            return { hash: candidate.hash, mime: candidate.mime, bytes: candidate.bytes, stored: true };
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        return null;
      });
    },
    collect() {
      return locked(async () => {
        const used = new Set([...leases.values()]);
        for (const photos of libraries.values()) for (const photo of Object.values(photos)) if (photo.stored !== false && photo.hash) used.add(photo.hash);
        for (const file of await readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
          const match = /^([a-f0-9]{64})\.(?:jpg|png|webp|img)$/.exec(file.name);
          if (file.isFile() && match && !used.has(match[1])) await unlink(join(directory, file.name));
        }
      });
    },
  };
}
