import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, unlinkSync, ftruncateSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

function processIdentity(pid) {
  if (process.platform !== 'linux') return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const started = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
    return `${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${started}`;
  } catch { return null; }
}

export function acquireAppLock(root) {
  const directory = join(root, 'data'), file = join(directory, 'app.lock');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd;
    try { fd = openSync(file, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let saved;
      try { saved = readFileSync(file, 'utf8'); } catch (failure) { if (failure.code === 'ENOENT') continue; throw failure; }
      let owner; try { owner = JSON.parse(saved); } catch { throw new Error('Не удалось прочитать блокировку приложения. Убедитесь, что сервер остановлен, и удалите data/app.lock.'); }
      if (!Number.isInteger(owner.pid) || owner.pid < 1) throw new Error('Некорректная блокировка приложения data/app.lock');
      let running = true;
      try { process.kill(owner.pid, 0); } catch (failure) { if (failure.code === 'ESRCH') running = false; }
      const identity = running && processIdentity(owner.pid);
      if (owner.instanceId && identity && identity !== owner.instanceId) running = false;
      if (running) throw Object.assign(new Error('Приложение уже использует эту базу. Закройте работающий сервер перед повторным запуском или переносом данных.'), { code: 'APP_ALREADY_RUNNING' });
      try { if (readFileSync(file, 'utf8') === saved) unlinkSync(file); } catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
      continue;
    }
    const nonce = randomUUID();
    const record = { pid: process.pid, nonce, instanceId: processIdentity(process.pid) };
    try { writeFileSync(fd, JSON.stringify(record)); }
    catch (error) { closeSync(fd); unlinkSync(file); throw error; }
    let released = false;
    const release = () => {
      if (released) return; released = true; closeSync(fd);
      try { if (JSON.parse(readFileSync(file, 'utf8')).nonce === nonce) unlinkSync(file); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    };
    release.nonce = nonce;
    release.setPort = port => { if (!released) { ftruncateSync(fd, 0); writeSync(fd, JSON.stringify({ ...record, port }), 0, 'utf8'); } };
    return release;
  }
  throw new Error('Не удалось получить блокировку приложения');
}
