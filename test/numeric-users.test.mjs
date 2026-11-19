import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, copyFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID, createHash, scryptSync } from 'node:crypto';
import { parseEnv } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../lib/database.mjs';
import { createTokenVault } from '../lib/token-vault.mjs';
import { createAccounts } from '../lib/accounts.mjs';
import { updateNumericAdminIds } from '../lib/legacy-env.mjs';
import { writeJSON, saveImage, defaults, digest } from '../lib/storage.mjs';
import { writeFile } from 'node:fs/promises';

const password = 'Numeric account migration password!', hash = value => createHash('sha256').update(value).digest('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=', 'base64');
function inspect(root, fn) { const db = new DatabaseSync(join(root, 'data/kero.sqlite')); try { return fn(db); } finally { db.close(); } }
async function oldDatabase(t) {
  const root = await mkdtemp(join(tmpdir(), 'kero-numeric-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const salt = randomBytes(16).toString('hex'), passwordHash = scryptSync(password, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }).toString('hex');
  const owner = { id: randomUUID(), login: 'numeric_owner', salt, passwordHash, createdAt: Date.now(), legacyOwner: true, fullAccess: false, admin: false };
  const other = { ...owner, id: randomUUID(), login: 'numeric_other', legacyOwner: false, admin: true };
  const session = randomBytes(32).toString('base64url'), keyId = randomUUID();
  await writeJSON(join(root, 'data/accounts.json'), {
    users: [owner, other], sessions: { [hash(session)]: { userId: owner.id, expires: Date.now() + 100000 } }, legacyClaimed: true,
    policies: { grantAllRegistered: false, openRegistration: true },
    registrationKeys: [{ id: keyId, hash: hash('numeric-invitation'), mask: 'masked', label: 'Existing key', type: 'single', createdAt: Date.now(), createdBy: owner.id, expiresAt: null, maxUses: 1, uses: 0, revoked: false }],
  });
  const photoId = 'local_' + digest(png), photo = { id: photoId, source: 'local', title: 'Retained photo', ...await saveImage(root, photoId, png) };
  await writeJSON(join(root, 'cache/library.json'), { photos: { [photoId]: photo }, lastSync: '2026-01-01' });
  await writeJSON(join(root, 'config/settings.json'), { ...defaults, rotation: 47 });
  await writeJSON(join(root, 'config/favorites.json'), [photoId]);
  const otherRoot = join(root, 'data/users', other.id);
  await writeJSON(join(otherRoot, 'cache/library.json'), { photos: { [photoId]: photo }, lastSync: null });
  await writeJSON(join(otherRoot, 'config/settings.json'), { ...defaults, rotation: 71 });
  await writeJSON(join(otherRoot, 'config/exclusions.json'), [photoId]);
  await writeFile(join(root, '.env'), `PORT=4321\nGLOBAL_ADMIN_IDS=${owner.id}\n`);
  const initial = await openDatabase(root, { encryptionKey: '', legacyToken: 'owner-vk-secret' });
  const backup = initial.stats().numericIdsBackup; initial.close();
  await copyFile(join(root, backup), join(root, 'data/kero.sqlite'));
  const vault = await createTokenVault(root, { encryptionKey: '' }), token = vault.encrypt(other.id, 'other-vk-secret');
  inspect(root, db => db.prepare('INSERT INTO vk_tokens VALUES(?,?,?,?,?)').run(other.id, token.version, token.iv, token.ciphertext, token.tag)); vault.dispose();
  assert.equal(inspect(root, db => db.prepare('PRAGMA user_version').get().user_version), 1);
  return { root, owner, other, photoId, keyId, session };
}

test('UUID SQLite users become integer primary keys with every relationship and encrypted token preserved', async t => {
  const f = await oldDatabase(t), encryptionKey = await readFile(join(f.root, 'data/secrets/vk-token.key'));
  const previousCipher = inspect(f.root, db => db.prepare('SELECT ciphertext FROM vk_tokens WHERE user_id=?').get(f.owner.id).ciphertext);
  await writeFile(join(f.root, 'data/accounts.json'), 'obsolete JSON must not be read');
  const store = await openDatabase(f.root, { encryptionKey: '' });
  try {
    const saved = store.readAccounts(); assert.deepEqual(saved.users.map(user => user.id), [1, 2]);
    assert.equal(store.resolveUserId(f.owner.id), 1); assert.equal(store.resolveUserId(f.other.id), 2);
    assert.equal(saved.users[0].passwordHash, f.owner.passwordHash); assert.equal(saved.users[1].admin, true);
    assert.equal(saved.sessions[hash(f.session)].userId, 1); assert.equal(saved.registrationKeys.find(key => key.id === f.keyId).createdBy, 1);
    assert.equal(store.readDocument(1, 'settings').rotation, 47); assert.equal(store.readDocument(2, 'settings').rotation, 71);
    assert.deepEqual(store.readDocument(1, 'favorites'), [f.photoId]); assert.deepEqual(store.readDocument(2, 'exclusions'), [f.photoId]);
    assert.equal(store.readDocument(1, 'library').photos[f.photoId].hash, digest(png));
    assert.equal(store.getToken(1), 'owner-vk-secret'); assert.equal(store.getToken(2), 'other-vk-secret');
    assert.notDeepEqual(inspect(f.root, db => db.prepare('SELECT ciphertext FROM vk_tokens WHERE user_id=1').get().ciphertext), previousCipher);
    assert.deepEqual(await readFile(join(f.root, 'data/secrets/vk-token.key')), encryptionKey);
    assert.equal(inspect(f.root, db => db.prepare("SELECT type FROM pragma_table_info('users') WHERE name='id'").get().type), 'INTEGER');
    assert.equal(inspect(f.root, db => db.prepare('PRAGMA foreign_key_check').all().length), 0);
    const service = await createAccounts(f.root, { database: store, globalAdminIds: [f.owner.id] });
    const req = { headers: { cookie: `kero_session_${hash(resolve(f.root)).slice(0, 12)}=${f.session}` } };
    assert.equal(service.current(req).id, 1); assert.equal(service.describe(service.current(req)).isGlobalAdmin, true);
    assert.equal(await updateNumericAdminIds(f.root, store), true);
    const env = parseEnv(await readFile(join(f.root, '.env'), 'utf8')); assert.equal(env.GLOBAL_ADMIN_IDS, '1'); assert.equal(env.PORT, '4321');
    const register = login => service.authenticate({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }, { setHeader() {} }, { login, password }, true);
    const third = await register('numeric_third'); assert.equal(third.id, 3);
    await service.deleteUser(service.current(req), third.id);
    assert.equal((await register('numeric_fourth')).id, 4);
  } finally { store.close(); }
  const restarted = await openDatabase(f.root, { encryptionKey: '' });
  try { assert.deepEqual(restarted.readAccounts().users.map(user => user.id), [1, 2, 4]); assert.equal(restarted.getToken(2), 'other-vk-secret'); }
  finally { restarted.close(); }
});

test('an undecryptable UUID token stops ID migration without changing the old schema or records', async t => {
  const f = await oldDatabase(t);
  const record = inspect(f.root, db => db.prepare('SELECT * FROM vk_tokens WHERE user_id=?').get(f.other.id));
  inspect(f.root, db => db.prepare('UPDATE vk_tokens SET tag=? WHERE user_id=?').run(Buffer.alloc(16), f.other.id));
  await assert.rejects(openDatabase(f.root, { encryptionKey: '' }), /расшифровать/);
  assert.equal(inspect(f.root, db => db.prepare('PRAGMA user_version').get().user_version), 1);
  assert.deepEqual(inspect(f.root, db => db.prepare('SELECT id FROM users ORDER BY rowid').all().map(row => row.id)), [f.owner.id, f.other.id]);
  inspect(f.root, db => db.prepare('UPDATE vk_tokens SET tag=? WHERE user_id=?').run(record.tag, f.other.id));
  const recovered = await openDatabase(f.root, { encryptionKey: '' });
  try { assert.equal(recovered.getToken(1), 'owner-vk-secret'); assert.equal(recovered.getToken(2), 'other-vk-secret'); }
  finally { recovered.close(); }
});
