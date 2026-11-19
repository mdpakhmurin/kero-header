import { readFile, open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';

export async function removeMigratedVKToken(root, database) {
  const owner = database.legacyTokenOwner(); if (!owner) return false;
  const file = join(root, '.env'); let source;
  try { source = await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  const configured = parseEnv(source).VK_TOKEN;
  if (!configured || /[\r\n]/.test(configured) || database.getToken(owner) !== configured) return false;
  const next = source.replace(/^(?:export[ \t]+)?VK_TOKEN[ \t]*=[^\r\n]*(?:\r?\n|$)/gm, '# Личный токен VK перенесён в зашифрованное хранилище.\n');
  if (next === source) return false;
  const temp = `${file}.${randomUUID()}.tmp`, handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(next); await handle.sync(); } finally { await handle.close(); }
  await rename(temp, file); if (process.env.VK_TOKEN === configured) delete process.env.VK_TOKEN; return true;
}

export async function updateNumericAdminIds(root, database) {
  const file = join(root, '.env'); let source;
  try { source = await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  const configured = parseEnv(source).GLOBAL_ADMIN_IDS; if (!configured?.trim()) return false;
  const ids = configured.split(',').map(value => value.trim()).filter(Boolean).map(value => database.resolveUserId(value));
  if (ids.some(id => id === undefined)) throw new Error('Не удалось перенести GLOBAL_ADMIN_IDS: проверьте ID глобальных администраторов');
  const value = [...new Set(ids)].join(','); if (value === configured) return false;
  const next = source.replace(/^(?:export[ \t]+)?GLOBAL_ADMIN_IDS[ \t]*=[^\r\n]*(?:\r?\n|$)/gm, `GLOBAL_ADMIN_IDS=${value}\n`);
  if (next === source) return false;
  const temp = `${file}.${randomUUID()}.tmp`, handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(next); await handle.sync(); } finally { await handle.close(); }
  await rename(temp, file); if (process.env.GLOBAL_ADMIN_IDS === configured) process.env.GLOBAL_ADMIN_IDS = value;
  return true;
}
