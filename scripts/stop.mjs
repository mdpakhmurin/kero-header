import { fileURLToPath } from 'node:url';
import { stopApp } from '../lib/shutdown.mjs';

try {
  const stopped = await stopApp(fileURLToPath(new URL('../', import.meta.url)));
  console.log(stopped ? 'Редактор остановлен.' : 'Редактор уже остановлен.');
} catch (error) { console.error(`Не удалось остановить редактор: ${error.message}`); process.exitCode = 1; }
