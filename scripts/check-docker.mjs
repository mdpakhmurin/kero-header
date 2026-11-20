import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';

const project = `kero-test-${randomUUID().slice(0, 8)}`, port = process.env.DOCKER_TEST_PORT || '33210', base = `http://127.0.0.1:${port}`;
const options = { cwd: fileURLToPath(new URL('../', import.meta.url)), env: { ...process.env, PORT: port, BIND_ADDRESS: '127.0.0.1', PUBLIC_ORIGIN: base, GLOBAL_ADMIN_IDS: '1', COMPOSE_PROJECT_NAME: project } };
try { execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'pipe' }); }
catch { throw new Error('Для проверки контейнера установите и запустите Docker с Docker Compose.'); }
const compose = (args, capture = false) => execFileSync('docker', ['compose', '-p', project, ...args], { ...options, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
async function ready() {
  for (let i = 0; i < 120; i++) { try { if ((await fetch(base + '/api/auth/session', { signal: AbortSignal.timeout(1000) })).ok) return; } catch {} await sleep(250); }
  throw new Error('Container did not become ready');
}
let cookie;
const call = async (path, input) => {
  const response = await fetch(base + '/api/' + path, { method: input === undefined ? 'GET' : 'POST', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  const next = response.headers.get('set-cookie'); if (next) cookie = next.split(';')[0]; assert.ok(response.ok, `API ${path}: ${response.status}`); return response.json();
};
try {
  if (process.platform === 'linux') execFileSync('sh', ['launch/docker/linux/start.sh'], { ...options, stdio: 'inherit' });
  else compose(['up', '--build', '-d']);
  await ready();
  assert.equal((await call('auth/register', { login: 'docker_smoke', password: 'Docker test password 123!' })).user.id, 1);
  const photo = await call('import', { name: 'test.png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=' });
  await call('favorites', [photo.id]); const state = await call('state'); await call('settings', { ...state.settings, rotation: 17 });
  const keyHash = () => compose(['exec', '-T', 'editor', 'node', '-e', "console.log(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync('/app/data/secrets/vk-token.key')).digest('hex'))"], true).trim();
  const before = keyHash();
  compose(['restart']); await ready(); assert.equal((await call('state')).settings.rotation, 17); assert.equal(keyHash(), before);
  compose(['kill', '-s', 'SIGKILL']); compose(['up', '-d']); await ready();
  const after = await call('state'); assert.equal(after.photos[0].available, true); assert.deepEqual(after.favorites, [photo.id]); assert.equal(keyHash(), before);
  assert.equal((await fetch(base + '/data/kero.sqlite')).status, 404);
  console.log('Docker: запуск, регистрация, сохранение данных и ключа, обычный и аварийный перезапуск проверены.');
} finally {
  if (process.platform === 'linux') {
    try { execFileSync('sh', ['launch/docker/linux/stop.sh'], { ...options, stdio: 'inherit' }); }
    finally { compose(['down', '--volumes', '--remove-orphans']); }
  } else compose(['down', '--volumes', '--remove-orphans']);
}
