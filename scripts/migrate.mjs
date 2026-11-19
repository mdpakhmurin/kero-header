import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { openDatabase } from '../lib/database.mjs';
import { acquireAppLock } from '../lib/app-lock.mjs';
import { removeMigratedVKToken, updateNumericAdminIds } from '../lib/legacy-env.mjs';
import { stat } from 'node:fs/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
try { process.loadEnvFile(join(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
let database, release;
try {
  release = acquireAppLock(root);
  database = await openDatabase(root, { legacyToken: process.env.VK_TOKEN || '' });
  const removed = await removeMigratedVKToken(root, database), info = database.stats();
  await updateNumericAdminIds(root, database);
  console.log(`SQLite готова: ${info.users} пользователей, ${info.photos} записей фотографий, ${info.tokens} личных токенов VK.`);
  if (info.backup && await stat(join(root, info.backup)).catch(() => false)) console.log(`Копия прежних JSON: ${join(root, info.backup)}`);
  if (info.numericIdsBackup) console.log(`Копия базы перед сменой ID: ${join(root, info.numericIdsBackup)}`);
  if (removed) console.log('Прежний токен VK перенесён в личное зашифрованное хранилище и удалён из .env.');
} catch (error) { console.error(`Перенос не выполнен: ${error.message}`); process.exitCode = 1; }
finally { database?.close(); release?.(); }
