import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createApp } from '../server.mjs';

function openBrowser(url) {
  const browser = spawn('cmd.exe', ['/d', '/c', 'start', '""', url], {
    stdio: 'ignore',
    windowsHide: true,
  });
  browser.on('error', () => console.error(`Откройте адрес вручную: ${url}`));
  browser.on('exit', code => {
    if (code) console.error(`Откройте адрес вручную: ${url}`);
  });
}

async function launch() {
  const port = Number(process.env.PORT || 3210);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('PORT должен быть целым числом от 0 до 65535.');
  }
  const app = await createApp();
  try {
    await new Promise((resolve, reject) => {
      app.once('error', reject);
      app.listen(port, '127.0.0.1', () => {
        app.removeListener('error', reject);
        resolve();
      });
    });
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    // Only reuse the occupied port if it serves this application's page.
    const url = `http://127.0.0.1:${port}`;
    let existing = false;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: 'error' });
      const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
      existing = response.ok && await response.text() === html;
    } catch { /* Another service may be using the port. */ }
    if (!existing) throw new Error(`Порт ${port} занят другой программой. Укажите другой PORT в .env.`);
    console.log(`Kero Header уже запущен: ${url}`);
    openBrowser(url);
    return;
  }
  const url = `http://127.0.0.1:${app.address().port}`;
  console.log(`Kero Header → ${url}`);
  console.log('Для работы программы оставьте это окно открытым. Остановка: Ctrl+C или закрытие окна.');
  openBrowser(url);
}

launch().catch(error => {
  console.error(`Не удалось запустить Kero Header: ${error.message}`);
  process.exitCode = 1;
});
