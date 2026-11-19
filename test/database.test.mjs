import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, randomBytes, createHash, scryptSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../lib/database.mjs';
import { createTokenVault } from '../lib/token-vault.mjs';
import { createApp } from '../server.mjs';
import { createAccounts } from '../lib/accounts.mjs';
import { removeMigratedVKToken } from '../lib/legacy-env.mjs';
import { defaults, writeJSON, saveImage, digest, imagePath } from '../lib/storage.mjs';

const password = 'Migration password 123!', png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=', 'base64');
const hash = value => createHash('sha256').update(value).digest('hex');
const legacyUser = (login, legacyOwner = false) => { const salt = randomBytes(16).toString('hex'); return { id: randomUUID(), login, salt, passwordHash: scryptSync(password, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }).toString('hex'), createdAt: Date.now(), legacyOwner, admin: false, fullAccess: false }; };
async function rootFor(t) { const root = await mkdtemp(join(tmpdir(), 'kero-sqlite-test-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
function inspect(root, fn) { const db = new DatabaseSync(join(root, 'data/kero.sqlite'), { readOnly: true }); try { return fn(db); } finally { db.close(); } }
async function originalAccounts(root, users, extra = {}) { await writeJSON(join(root, 'data/accounts.json'), { users, sessions: {}, ...extra }); }

test('migration preserves identities, sessions, roles, libraries, preferences and shared originals exactly once', async t => {
  const root = await rootFor(t), alice = legacyUser('migration_alice', true), bob = legacyUser('migration_bob'); bob.admin = true;
  const session = randomBytes(32).toString('base64url'), invitation = randomBytes(24).toString('base64url');
  await originalAccounts(root, [alice, bob], { sessions: { [hash(session)]: { userId: alice.id, expires: Date.now() + 100000 } }, policies: { grantAllRegistered: false, openRegistration: false }, registrationKeys: [{ id: randomUUID(), hash: hash(invitation), mask: 'masked', type: 'permanent', label: 'Existing', createdAt: Date.now(), createdBy: alice.id, expiresAt: null, maxUses: null, uses: 2, revoked: false }] });
  const id = 'local_' + digest(png), metadata = await saveImage(root, id, png), photo = { id, source: 'local', title: 'Original', addedAt: 1234, ...metadata };
  await writeJSON(join(root, 'config/settings.json'), { ...defaults, rotation: 42, coverSizes: [{ width: 1920, height: 768, name: 'My size' }] });
  await writeJSON(join(root, 'cache/library.json'), { photos: { [id]: photo }, lastSync: '2026-01-01' });
  await writeJSON(join(root, 'config/favorites.json'), [id]); await writeJSON(join(root, 'config/exclusions.json'), [id]);
  const bobRoot = join(root, 'data/users', bob.id);
  await writeJSON(join(bobRoot, 'cache/library.json'), { photos: { [id]: photo }, lastSync: null });
  await writeJSON(join(bobRoot, 'config/settings.json'), { ...defaults, rotation: 70 });
  const before = await readFile(join(root, 'data/accounts.json')); let store = await openDatabase(root, { legacyToken: 'legacy-private-token' });
  try {
    assert.equal(store.stats().users, 2); assert.equal(store.stats().photos, 2); assert.equal((await readdir(join(root, 'data/blobs'))).length, 1);
    assert.equal(store.readDocument(alice.id, 'settings').rotation, 42); assert.equal(store.readDocument(bob.id, 'settings').rotation, 70);
    assert.deepEqual(store.readDocument(alice.id, 'favorites'), [id]); assert.deepEqual(store.readDocument(bob.id, 'favorites'), []);
    assert.deepEqual(store.readDocument(alice.id, 'exclusions'), [id]); assert.equal(store.readDocument(alice.id, 'library').lastSync, '2026-01-01');
    assert.equal(store.getToken(alice.id), 'legacy-private-token'); assert.equal(store.getToken(bob.id), '');
    assert.deepEqual(await readFile(join(root, 'data/accounts.json')), before); assert.deepEqual(await readFile(join(root, store.stats().backup, 'data/accounts.json')), before);
    assert.deepEqual(await readFile(imagePath(root, photo)), png);
    const accounts = await createAccounts(root, { database: store, globalAdminIds: [alice.id] });
    const req = { headers: { cookie: 'kero_session_' + hash(resolve(root)).slice(0, 12) + '=' + session } };
    assert.equal(accounts.current(req).id, alice.id); assert.equal(accounts.describe(accounts.current(req)).isGlobalAdmin, true);
    assert.equal(store.readAccounts().registrationKeys[0].uses, 2); assert.equal(store.readAccounts().users.find(user => user.id === bob.id).admin, true);
    const response = { setHeader() {} }; await accounts.authenticate({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }, response, { login: alice.login, password }, false);
    const backup = store.stats().backup; store.close();
    await writeJSON(join(root, 'data/accounts.json'), { users: [], sessions: {} });
    await writeJSON(join(root, 'config/settings.json'), { ...defaults, rotation: 99 });
    store = await openDatabase(root, { legacyToken: 'must-not-replace' });
    assert.equal(store.stats().users, 2); assert.equal(store.stats().backup, backup); assert.equal(store.readDocument(alice.id, 'settings').rotation, 42); assert.equal(store.getToken(alice.id), 'legacy-private-token');
  } finally { store.close(); }
});

test('a failed migration rolls back all records and leaves the source files recoverable', async t => {
  const root = await rootFor(t), user = legacyUser('rollback_owner', true); await originalAccounts(root, [user]);
  const path = join(root, 'config/favorites.json'); await writeJSON(path, ['invalid-photo']);
  const before = await readFile(join(root, 'data/accounts.json'));
  await assert.rejects(openDatabase(root), /ID/);
  assert.equal(inspect(root, db => db.prepare('SELECT count(*) AS n FROM users').get().n), 0);
  assert.equal(inspect(root, db => db.prepare('PRAGMA user_version').get().user_version), 0);
  assert.deepEqual(await readFile(join(root, 'data/accounts.json')), before);
  await writeJSON(path, []); const store = await openDatabase(root); assert.equal(store.stats().users, 1); store.close();
});

test('a missing database after migration cannot resurrect archived users', async t => {
  const root = await rootFor(t), user = legacyUser('archived_owner'); await originalAccounts(root, [user]);
  const store = await openDatabase(root); store.close(); await rm(join(root, 'data/kero.sqlite'));
  await assert.rejects(openDatabase(root), /Восстановите/);
});

test('the auto-generated key encrypts with fresh IVs and binds each token to its user', async t => {
  const root = await rootFor(t), vault = await createTokenVault(root);
  const first = vault.encrypt('alice', 'secret-token'), second = vault.encrypt('alice', 'secret-token');
  assert.notDeepEqual(first.iv, second.iv); assert.notDeepEqual(first.ciphertext, second.ciphertext); assert.equal(vault.decrypt('alice', first), 'secret-token');
  assert.throws(() => vault.decrypt('bob', first), /расшифровать/);
  const broken = { ...first, ciphertext: Buffer.from(first.ciphertext) }; broken.ciphertext[0] ^= 1; assert.throws(() => vault.decrypt('alice', broken), /расшифровать/);
  const expected = vault.fingerprint; vault.dispose();
  const reloaded = await createTokenVault(root, { expectedFingerprint: expected }); assert.equal(reloaded.decrypt('alice', first), 'secret-token'); reloaded.dispose();
  await rm(join(root, 'data/secrets/vk-token.key'));
  await assert.rejects(createTokenVault(root, { expectedFingerprint: expected }), /Восстановите/);
  await assert.rejects(stat(join(root, 'data/secrets/vk-token.key')), { code: 'ENOENT' });
});

test('a committed key rotation recovers from its durable staged key after an interrupted file promotion', async t => {
  const root = await rootFor(t), old = await createTokenVault(root), prepared = await old.prepareRotation();
  const record = prepared.vault.encrypt('owner', 'unchanged-token'), fingerprint = prepared.vault.fingerprint;
  old.dispose(); prepared.vault.dispose();
  const recovered = await createTokenVault(root, { expectedFingerprint: fingerprint, preferFile: true });
  assert.equal(recovered.decrypt('owner', record), 'unchanged-token'); assert.equal(hash(await readFile(join(root, 'data/secrets/vk-token.key'))), fingerprint); recovered.dispose();
});

test('rotation rolls back every token if any encrypted record is corrupt', async t => {
  const root = await rootFor(t), alice = legacyUser('rotation_one'), bob = legacyUser('rotation_two'); await originalAccounts(root, [alice, bob]);
  const store = await openDatabase(root); store.setToken(alice.id, 'alice-secret'); store.setToken(bob.id, 'bob-secret');
  const before = inspect(root, db => db.prepare('SELECT * FROM vk_tokens WHERE user_id=?').get(bob.id));
  const fingerprint = inspect(root, db => db.prepare("SELECT value FROM metadata WHERE key='token_key_fingerprint'").get().value);
  const connection = new DatabaseSync(join(root, 'data/kero.sqlite')); connection.prepare('UPDATE vk_tokens SET tag=? WHERE user_id=?').run(Buffer.alloc(16), bob.id); connection.close();
  try {
    await assert.rejects(store.rotateTokenKey(), /расшифровать/); assert.equal(store.getToken(alice.id), 'alice-secret');
    assert.equal(inspect(root, db => db.prepare("SELECT value FROM metadata WHERE key='token_key_fingerprint'").get().value), fingerprint);
    const fix = new DatabaseSync(join(root, 'data/kero.sqlite')); fix.prepare('UPDATE vk_tokens SET tag=? WHERE user_id=?').run(before.tag, bob.id); fix.close();
  } finally { store.close(); }
  const restored = await openDatabase(root); assert.equal(restored.getToken(bob.id), 'bob-secret'); restored.close();
});

test('tokens persist privately, never leak through responses, and only the global admin can rotate the key', async t => {
  const root = await rootFor(t), ids = [], calls = [], suppliedKey = randomBytes(32).toString('base64');
  let app, base;
  const start = async () => { app = await createApp(root, { encryptionKey: suppliedKey, globalAdminIds: ids, vkFactory: token => async method => {
    calls.push({ token, method }); if (token === 'leaky+secret') throw Error('Failure: ' + token + ' ' + encodeURIComponent(token));
    return method === 'utils.resolveScreenName' ? { type: 'group', object_id: 42 } : { count: 0, items: [] };
  } }); await new Promise(resolve => app.listen(0, '127.0.0.1', resolve)); base = 'http://127.0.0.1:' + app.address().port; };
  const stop = async () => { if (app?.listening) await new Promise(resolve => app.close(resolve)); };
  await start(); t.after(stop);
  const client = () => { let cookie; return { async call(path, input) { const response = await fetch(base + '/api/' + path, { method: input === undefined ? 'GET' : 'POST', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) }); const next = response.headers.get('set-cookie'); if (next) cookie = next.split(';')[0]; return response; }, async register(login) { const res = await this.call('auth/register', { login, password }); assert.equal(res.status, 200); this.user = (await res.json()).user; } }; };
  try {
    const alice = client(), bob = client(); await alice.register('token_alice'); await bob.register('token_bob'); ids.push(alice.user.id); await stop(); await start();
    assert.equal((await alice.call('token', { token: 'alice-private-token', userId: bob.user.id })).status, 200); assert.equal((await (await bob.call('state')).json()).hasToken, false);
    assert.equal((await bob.call('token', { token: 'bob-private-token' })).status, 200);
    const failed = await alice.call('token', { token: 'leaky+secret' }); assert.equal(failed.status, 400); const error = await failed.text(); assert.equal(error.includes('leaky+secret'), false); assert.equal(error.includes('leaky%2Bsecret'), false);
    assert.equal((await alice.call('token', { token: 'invalid\nvalue' })).status, 400);
    assert.equal(app.database.getToken(alice.user.id), 'alice-private-token');
    await stop(); await start(); assert.equal((await (await alice.call('state')).json()).hasToken, true); assert.equal((await (await bob.call('state')).json()).hasToken, true);
    for (const user of [alice, bob]) { assert.equal((await user.call('sync', {})).status, 202); for (let n = 0; n < 100; n++) { if (!(await (await user.call('sync')).json()).running) break; await new Promise(resolve => setTimeout(resolve, 5)); } }
    assert.ok(calls.some(call => call.token === 'alice-private-token' && call.method === 'photos.getAll')); assert.ok(calls.some(call => call.token === 'bob-private-token' && call.method === 'photos.getAll'));
    for (const path of ['state', 'auth/session', 'admin/state']) { const text = await (await alice.call(path)).text(); assert.equal(text.includes('alice-private-token'), false); assert.equal(text.includes('bob-private-token'), false); assert.equal(text.includes(suppliedKey), false); }
    await alice.call('admin/users/update', { id: bob.user.id, admin: true }); assert.equal((await bob.call('admin/token-key/rotate', { confirmed: true })).status, 403);
    assert.equal((await alice.call('admin/token-key/rotate', {})).status, 400);
    const old = inspect(root, db => db.prepare('SELECT ciphertext FROM vk_tokens WHERE user_id=?').get(alice.user.id).ciphertext);
    const rotated = await alice.call('admin/token-key/rotate', { confirmed: true }); assert.equal(rotated.status, 200); assert.equal((await rotated.json()).tokenKeyRotation.tokens, 2);
    assert.notDeepEqual(inspect(root, db => db.prepare('SELECT ciphertext FROM vk_tokens WHERE user_id=?').get(alice.user.id).ciphertext), old);
    assert.equal((await readFile(join(root, 'data/secrets/vk-token.key'))).length, 32);
    await stop(); await start(); assert.equal(app.database.getToken(alice.user.id), 'alice-private-token'); assert.equal(app.database.getToken(bob.user.id), 'bob-private-token');
    for (const file of ['kero.sqlite', 'kero.sqlite-wal']) { const bytes = await readFile(join(root, 'data', file)).catch(() => Buffer.alloc(0)); assert.equal(bytes.includes(Buffer.from('alice-private-token')), false); assert.equal(bytes.includes(Buffer.from('bob-private-token')), false); }
    for (const file of ['/data/kero.sqlite', '/data/secrets/vk-token.key']) assert.equal((await fetch(base + file)).status, 404);
    await alice.call('token', { token: '' }); await stop(); await start(); assert.equal((await (await alice.call('state')).json()).hasToken, false); assert.equal((await (await bob.call('state')).json()).hasToken, true);
    assert.equal((await alice.call('admin/users/delete', { id: bob.user.id })).status, 200); assert.equal(inspect(root, db => db.prepare('SELECT count(*) AS n FROM vk_tokens WHERE user_id=?').get(bob.user.id).n), 0);
    await assert.rejects(createApp(root), error => error.code === 'APP_ALREADY_RUNNING');
  } finally { await stop(); }
});

test('a successfully migrated legacy token is removed from env without changing other settings', async t => {
  const root = await rootFor(t), owner = legacyUser('env_owner', true); await originalAccounts(root, [owner]);
  await writeFile(join(root, '.env'), 'PORT=4321\nVK_TOKEN=old-private-token\nGLOBAL_ADMIN_IDS=' + owner.id + '\n');
  const store = await openDatabase(root, { legacyToken: 'old-private-token' });
  try { assert.equal(await removeMigratedVKToken(root, store), true); const env = await readFile(join(root, '.env'), 'utf8'); assert.equal(env.includes('old-private-token'), false); assert.ok(env.includes('PORT=4321')); assert.ok(env.includes(owner.id)); assert.equal(store.getToken(owner.id), 'old-private-token'); } finally { store.close(); }
});
