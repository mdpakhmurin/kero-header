import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export async function stopApp(root, { timeoutMs = 60000 } = {}) {
  const file = join(root, 'data/app.lock');
  async function status() {
    let text; try { text = await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    try { return JSON.parse(text); } catch { throw new Error('Не удалось прочитать состояние редактора. Повторите остановку.'); }
  }
  const owner = await status(); if (!owner) return false;
  if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error('Некорректное состояние редактора');
  try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  if (!Number.isInteger(owner.port) || owner.port < 1 || owner.port > 65535 || typeof owner.nonce !== 'string') throw new Error('Перезапустите редактор, чтобы включить остановку через stop.cmd.');
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${owner.port}/__local/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nonce: owner.nonce }), signal: AbortSignal.timeout(5000), redirect: 'error' });
  } catch { throw new Error('Не удалось связаться с редактором. Он может уже завершать работу.'); }
  if (!response.ok || (await response.json()).stopping !== true) throw new Error('Редактор не подтвердил остановку');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await status(); if (!current || current.nonce !== owner.nonce) return true;
    await sleep(100);
  }
  throw new Error('Редактор ещё завершает текущие операции. Дождитесь их окончания.');
}
