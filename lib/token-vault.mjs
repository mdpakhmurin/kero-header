import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, open, rename } from 'node:fs/promises';
import { join } from 'node:path';

const fingerprintOf = key => createHash('sha256').update(key).digest('hex');
async function durableKey(file, bytes) {
  const temp = file + '.' + randomUUID() + '.tmp', handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await rename(temp, file);
}
export async function createTokenVault(root, { encryptionKey = process.env.TOKEN_ENCRYPTION_KEY, expectedFingerprint, preferFile = false } = {}) {
  const directory = join(root, 'data/secrets'), file = join(directory, 'vk-token.key'), staged = join(directory, 'vk-token.next.key');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let key;
  if (encryptionKey && !preferFile) {
    if (!/^[A-Za-z0-9+/]{43}=$/.test(encryptionKey)) throw new Error('TOKEN_ENCRYPTION_KEY должен быть 32-байтовым ключом в Base64');
    key = Buffer.from(encryptionKey, 'base64');
  } else {
    for (const candidate of [file, staged, join(directory, 'vk-token.previous.key')]) {
      let bytes; try { bytes = await readFile(candidate); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (bytes.length === 32 && (!expectedFingerprint && candidate === file || fingerprintOf(bytes) === expectedFingerprint)) {
        key = bytes;
        if (candidate !== file) await durableKey(file, key);
        break;
      }
      bytes.fill(0);
    }
    if (!key) {
      if (expectedFingerprint) throw new Error('Не найден подходящий ключ шифрования токенов VK. Восстановите data/secrets из резервной копии.');
      try { await readFile(file); throw new Error('Некорректный файл ключа шифрования токенов VK'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const generated = randomBytes(32), handle = await open(file, 'wx', 0o600);
      try { await handle.writeFile(generated); await handle.sync(); key = generated; } finally { await handle.close(); }
    }
  }
  if (key.length !== 32) { key.fill(0); throw new Error('Некорректный ключ шифрования токенов VK'); }
  if (expectedFingerprint && fingerprintOf(key) !== expectedFingerprint) { key.fill(0); throw new Error('Ключ шифрования не соответствует базе. Восстановите прежний ключ токенов VK.'); }
  function buildVault(secret) {
    const fingerprint = fingerprintOf(secret); let disposed = false;
    const assertLive = () => { if (disposed) throw new Error('Хранилище токенов закрыто'); };
    const aad = userId => Buffer.from('kero:vk-token:v1:' + userId, 'utf8');
    return {
      fingerprint,
      encrypt(userId, token) {
        assertLive(); const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', secret, iv); cipher.setAAD(aad(userId));
        const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]); return { version: 1, iv, ciphertext, tag: cipher.getAuthTag() };
      },
      decrypt(userId, record) {
        assertLive();
        try {
          if (record.version !== 1) throw new Error();
          const cipher = createDecipheriv('aes-256-gcm', secret, record.iv); cipher.setAAD(aad(userId)); cipher.setAuthTag(record.tag);
          return Buffer.concat([cipher.update(record.ciphertext), cipher.final()]).toString('utf8');
        } catch { throw new Error('Не удалось расшифровать личный токен VK. Проверьте ключ шифрования и целостность базы.'); }
      },
      async prepareRotation() {
        assertLive();
        // The old key stays valid until the database commits. A staged key can recover a committed rotation.
        await durableKey(file, secret); await durableKey(join(directory, 'vk-token.previous.key'), secret);
        const next = randomBytes(32); await durableKey(staged, next);
        return { vault: buildVault(next), promote: () => rename(staged, file) };
      },
      dispose() { if (!disposed) { secret.fill(0); disposed = true; } },
    };
  }
  return buildVault(key);
}
export function redactToken(message, token) {
  let result = String(message || 'Ошибка подключения VK');
  for (const secret of [token, token && encodeURIComponent(token)]) if (secret) result = result.replaceAll(secret, '[токен скрыт]');
  return result;
}
