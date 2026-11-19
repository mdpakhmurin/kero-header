import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { stopApp } from '../lib/shutdown.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=', 'base64');
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'kero-shutdown-test-')), servers = [];
  t.after(async () => { for (const server of servers) if (server.listening) await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  async function start() { const app = await createApp(root, options); servers.push(app); await new Promise(resolve => app.listen(0, '127.0.0.1', resolve)); return { app, base: `http://127.0.0.1:${app.address().port}` }; }
  return { root, start, ...await start() };
}

test('stop utility closes only the server identified by the private local control key', async t => {
  const f = await fixture(t), status = JSON.parse(await readFile(join(f.root, 'data/app.lock'), 'utf8'));
  assert.equal(status.port, f.app.address().port);
  const post = (value, headers = {}) => fetch(f.base + '/__local/stop', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) });
  assert.equal((await post({ nonce: 'incorrect' })).status, 403); assert.equal(f.app.listening, true);
  assert.equal((await post({ nonce: status.nonce }, { Origin: 'https://other.example' })).status, 403); assert.equal(f.app.listening, true);
  assert.equal((await fetch(f.base + '/data/app.lock')).status, 404);
  assert.equal(await stopApp(f.root), true); assert.equal(f.app.listening, false);
  await assert.rejects(stat(join(f.root, 'data/app.lock')), { code: 'ENOENT' });
  assert.equal(await stopApp(f.root), false);
  const restarted = await f.start(); assert.equal(restarted.app.listening, true); assert.equal(await stopApp(f.root), true);
});

test('stop utility waits for background synchronization before closing SQLite', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { vkFactory: () => async method => method === 'utils.resolveScreenName' ? { type: 'group', object_id: 42 } : method === 'photos.getAll' ? { count: 1, items: [{ owner_id: -42, id: 1, sizes: [{ width: 1, height: 1, url: 'https://example.com/image.png' }] }] } : { count: 0, items: [] }, imageDownloader: async () => { await gate; return png; } });
  let cookie;
  const post = async (path, input) => { const res = await fetch(f.base + '/api/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(input) }); const next = res.headers.get('set-cookie'); if (next) cookie = next.split(';')[0]; return res; };
  try {
    assert.equal((await post('auth/register', { login: 'shutdown_user', password: 'Shutdown test password' })).status, 200);
    assert.equal((await post('token', { token: 'test-vk-token' })).status, 200); assert.equal((await post('sync', {})).status, 202);
    let stopped = false; const stopping = stopApp(f.root).then(result => { stopped = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(stopped, false);
    release(); assert.equal(await stopping, true);
    const restarted = await f.start(); assert.equal(restarted.app.database.stats().photos, 1); assert.equal(restarted.app.database.getToken(1), 'test-vk-token');
    assert.equal(await stopApp(f.root), true);
  } finally { release(); }
});
