import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

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
      if (running) throw Object.assign(new Error('Приложение уже использует эту базу. Закройте работающий сервер перед повторным запуском или переносом данных.'), { code: 'APP_ALREADY_RUNNING' });
      try { if (readFileSync(file, 'utf8') === saved) unlinkSync(file); } catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
      continue;
    }
    const nonce = randomUUID();
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce })); }
    catch (error) { closeSync(fd); unlinkSync(file); throw error; }
    let released = false;
    return () => {
      if (released) return; released = true; closeSync(fd);
      try { if (JSON.parse(readFileSync(file, 'utf8')).nonce === nonce) unlinkSync(file); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    };
  }
  throw new Error('Не удалось получить блокировку приложения');
}
