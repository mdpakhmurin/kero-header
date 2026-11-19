import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, writeFile, stat, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaults, validateSettings, validId, digest, imageType, readImage } from './storage.mjs';
import { createTokenVault } from './token-vault.mjs';

const schema = `
CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, login TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, password_hash TEXT NOT NULL,
 created_at INTEGER NOT NULL, legacy_owner INTEGER NOT NULL CHECK(legacy_owner IN(0,1)),
 admin INTEGER NOT NULL CHECK(admin IN(0,1)), full_access INTEGER NOT NULL CHECK(full_access IN(0,1))
) STRICT;
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL) STRICT;
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS registration_keys (
 id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, mask TEXT NOT NULL, label TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN('single','temporary','permanent')),
 created_at INTEGER NOT NULL, created_by TEXT, expires_at INTEGER, max_uses INTEGER, uses INTEGER NOT NULL, revoked INTEGER NOT NULL CHECK(revoked IN(0,1))
) STRICT;
CREATE TABLE IF NOT EXISTS workspaces (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, settings_json TEXT NOT NULL, library_meta_json TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS photos (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, photo_id TEXT NOT NULL,
 blob_hash TEXT, mime TEXT, stored INTEGER NOT NULL CHECK(stored IN(0,1)), metadata_json TEXT NOT NULL,
 PRIMARY KEY(user_id,photo_id)
) STRICT;
CREATE INDEX IF NOT EXISTS photos_blob ON photos(blob_hash) WHERE stored=1;
CREATE TABLE IF NOT EXISTS photo_preferences (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, photo_id TEXT NOT NULL,
 excluded INTEGER NOT NULL DEFAULT 0 CHECK(excluded IN(0,1)), favorite INTEGER NOT NULL DEFAULT 0 CHECK(favorite IN(0,1)),
 PRIMARY KEY(user_id,photo_id)
) STRICT;
CREATE TABLE IF NOT EXISTS vk_tokens (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, version INTEGER NOT NULL,
 iv BLOB NOT NULL CHECK(length(iv)=12), ciphertext BLOB NOT NULL, tag BLOB NOT NULL CHECK(length(tag)=16)
) STRICT;`;
const exists = async path => { try { await stat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export async function openDatabase(root, { encryptionKey, legacyToken = '' } = {}) {
  const directory = join(root, 'data'), file = join(directory, 'kero.sqlite'), marker = join(directory, 'migrations/sqlite-v1.done');
  if (!await exists(file) && await exists(marker)) throw new Error('База SQLite отсутствует. Восстановите data/kero.sqlite из резервной копии; старые JSON повторно не импортируются.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file), statements = new Map(); let vault, closed = false;
  const sql = query => { if (!statements.has(query)) statements.set(query, db.prepare(query)); return statements.get(query); };
  const transaction = fn => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  const metadata = key => sql('SELECT value FROM metadata WHERE key=?').get(key)?.value;
  const putMeta = (key, value) => sql('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  function readAccounts() {
    return {
      policies: JSON.parse(metadata('policies') || '{"grantAllRegistered":true,"openRegistration":true}'), legacyClaimed: metadata('legacy_claimed') === 'true',
      users: sql('SELECT * FROM users ORDER BY rowid').all().map(row => ({ id: row.id, login: row.login, salt: row.salt, passwordHash: row.password_hash, createdAt: row.created_at, legacyOwner: Boolean(row.legacy_owner), admin: Boolean(row.admin), fullAccess: Boolean(row.full_access) })),
      sessions: Object.fromEntries(sql('SELECT * FROM sessions').all().map(row => [row.token_hash, { userId: row.user_id, expires: row.expires_at }])),
      registrationKeys: sql('SELECT * FROM registration_keys ORDER BY rowid').all().map(row => ({ id: row.id, hash: row.code_hash, mask: row.mask, label: row.label, type: row.type, createdAt: row.created_at, createdBy: row.created_by, expiresAt: row.expires_at, maxUses: row.max_uses, uses: row.uses, revoked: Boolean(row.revoked) })),
    };
  }
  function saveAccountsData(next, previous = readAccounts()) {
    const beforeUsers = new Map(previous.users.map(user => [user.id, user])), afterUsers = new Set(next.users.map(user => user.id));
    for (const user of next.users) if (!same(user, beforeUsers.get(user.id))) sql(`INSERT INTO users VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET login=excluded.login,salt=excluded.salt,password_hash=excluded.password_hash,created_at=excluded.created_at,legacy_owner=excluded.legacy_owner,admin=excluded.admin,full_access=excluded.full_access`).run(user.id, user.login, user.salt, user.passwordHash, user.createdAt, Number(Boolean(user.legacyOwner)), Number(Boolean(user.admin)), Number(Boolean(user.fullAccess)));
    for (const user of previous.users) if (!afterUsers.has(user.id)) sql('DELETE FROM users WHERE id=?').run(user.id);
    for (const key of Object.keys(previous.sessions)) if (!next.sessions[key]) sql('DELETE FROM sessions WHERE token_hash=?').run(key);
    for (const [key, session] of Object.entries(next.sessions)) if (!same(session, previous.sessions[key])) sql('INSERT INTO sessions VALUES(?,?,?) ON CONFLICT(token_hash) DO UPDATE SET user_id=excluded.user_id,expires_at=excluded.expires_at').run(key, session.userId, session.expires);
    const previousKeys = new Map(previous.registrationKeys.map(key => [key.id, key])), nextKeys = new Set(next.registrationKeys.map(key => key.id));
    for (const key of previous.registrationKeys) if (!nextKeys.has(key.id)) sql('DELETE FROM registration_keys WHERE id=?').run(key.id);
    for (const key of next.registrationKeys) if (!same(key, previousKeys.get(key.id))) sql(`INSERT INTO registration_keys VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET code_hash=excluded.code_hash,mask=excluded.mask,label=excluded.label,type=excluded.type,created_at=excluded.created_at,created_by=excluded.created_by,expires_at=excluded.expires_at,max_uses=excluded.max_uses,uses=excluded.uses,revoked=excluded.revoked`).run(key.id, key.hash, key.mask, key.label || '', key.type, key.createdAt, key.createdBy || null, key.expiresAt ?? null, key.maxUses ?? null, key.uses, Number(Boolean(key.revoked)));
    putMeta('policies', JSON.stringify(next.policies)); putMeta('legacy_claimed', String(next.legacyClaimed));
  }
  function saveWorkspaceData(userId, changes) {
    sql('INSERT OR IGNORE INTO workspaces VALUES(?,?,?)').run(userId, JSON.stringify(defaults), '{"lastSync":null}');
    if (changes.settings !== undefined) sql('UPDATE workspaces SET settings_json=? WHERE user_id=?').run(JSON.stringify(validateSettings(changes.settings)), userId);
    if (changes.library !== undefined) {
      const { photos, ...meta } = changes.library;
      const previous = new Map(sql('SELECT photo_id,metadata_json FROM photos WHERE user_id=?').all(userId).map(row => [row.photo_id, row.metadata_json]));
      for (const id of previous.keys()) if (!Object.hasOwn(photos, id)) sql('DELETE FROM photos WHERE user_id=? AND photo_id=?').run(userId, id);
      for (const [id, photo] of Object.entries(photos)) {
        if (!validId(id) || photo.id !== id) throw new Error('Повреждён индекс библиотеки');
        const json = JSON.stringify(photo); if (previous.get(id) === json) continue;
        sql(`INSERT INTO photos VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,photo_id) DO UPDATE SET blob_hash=excluded.blob_hash,mime=excluded.mime,stored=excluded.stored,metadata_json=excluded.metadata_json`).run(userId, id, photo.hash || null, photo.mime || null, Number(photo.stored !== false), json);
      }
      sql('UPDATE workspaces SET library_meta_json=? WHERE user_id=?').run(JSON.stringify(meta), userId);
    }
    for (const [name, column] of [['exclusions', 'excluded'], ['favorites', 'favorite']]) if (changes[name] !== undefined) {
      sql(`UPDATE photo_preferences SET ${column}=0 WHERE user_id=?`).run(userId);
      for (const id of new Set(changes[name])) {
        if (!validId(id)) throw new Error('Некорректный ID фотографии');
        sql(`INSERT INTO photo_preferences(user_id,photo_id,${column}) VALUES(?,?,1) ON CONFLICT(user_id,photo_id) DO UPDATE SET ${column}=1`).run(userId, id);
      }
      sql('DELETE FROM photo_preferences WHERE user_id=? AND excluded=0 AND favorite=0').run(userId);
    }
  }
  function readDocument(userId, kind, fallback) {
    const workspace = sql('SELECT * FROM workspaces WHERE user_id=?').get(userId);
    if (!workspace) return structuredClone(fallback);
    if (kind === 'settings') return JSON.parse(workspace.settings_json);
    if (kind === 'library') return { ...JSON.parse(workspace.library_meta_json), photos: Object.fromEntries(sql('SELECT photo_id,metadata_json FROM photos WHERE user_id=? ORDER BY rowid').all(userId).map(row => [row.photo_id, JSON.parse(row.metadata_json)])) };
    const column = kind === 'exclusions' ? 'excluded' : kind === 'favorites' ? 'favorite' : null;
    if (!column) throw new Error('Неизвестный вид данных');
    return sql(`SELECT photo_id FROM photo_preferences WHERE user_id=? AND ${column}=1 ORDER BY photo_id`).all(userId).map(row => row.photo_id);
  }
  function setTokenData(userId, token) {
    if (!token) { sql('DELETE FROM vk_tokens WHERE user_id=?').run(userId); return; }
    const record = vault.encrypt(userId, token);
    sql('INSERT INTO vk_tokens VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET version=excluded.version,iv=excluded.iv,ciphertext=excluded.ciphertext,tag=excluded.tag').run(userId, record.version, record.iv, record.ciphertext, record.tag);
  }
  const store = {
    root, file, transaction, readAccounts,
    legacyTokenOwner: () => metadata('legacy_token_owner'),
    saveAccounts: (next, previous) => transaction(() => saveAccountsData(next, previous)),
    workspaceExists: userId => Boolean(sql('SELECT 1 FROM workspaces WHERE user_id=?').get(userId)),
    readDocument,
    writeDocument: (userId, kind, value) => transaction(() => saveWorkspaceData(userId, { [kind]: value })),
    saveWorkspace: (userId, changes) => transaction(() => saveWorkspaceData(userId, changes)),
    initializeWorkspace(userId, inheritLegacy) {
      if (store.workspaceExists(userId)) return;
      transaction(() => {
        const template = inheritLegacy && metadata('legacy_workspace');
        saveWorkspaceData(userId, template ? JSON.parse(template) : { settings: defaults });
        if (inheritLegacy) sql('DELETE FROM metadata WHERE key=?').run('legacy_workspace');
      });
    },
    libraries: () => sql('SELECT user_id FROM workspaces').all().map(row => ({ userId: row.user_id, library: readDocument(row.user_id, 'library') })),
    usedHashes() {
      const hashes = new Set(sql('SELECT DISTINCT blob_hash FROM photos WHERE stored=1 AND blob_hash IS NOT NULL').all().map(row => row.blob_hash));
      const legacy = metadata('legacy_workspace'); if (legacy) for (const photo of Object.values(JSON.parse(legacy).library.photos)) if (photo.stored !== false && photo.hash) hashes.add(photo.hash);
      return hashes;
    },
    getToken(userId) { const record = sql('SELECT * FROM vk_tokens WHERE user_id=?').get(userId); return record ? vault.decrypt(userId, record) : ''; },
    setToken: (userId, token) => transaction(() => setTokenData(userId, token)),
    async rotateTokenKey() {
      const prepared = await vault.prepareRotation(), records = sql('SELECT * FROM vk_tokens').all();
      const rotatedAt = Date.now();
      try {
        transaction(() => {
          for (const record of records) {
            const encrypted = prepared.vault.encrypt(record.user_id, vault.decrypt(record.user_id, record));
            sql('UPDATE vk_tokens SET version=?,iv=?,ciphertext=?,tag=? WHERE user_id=?').run(encrypted.version, encrypted.iv, encrypted.ciphertext, encrypted.tag, record.user_id);
          }
          putMeta('token_key_fingerprint', prepared.vault.fingerprint); putMeta('token_key_rotated', 'true'); putMeta('token_key_rotated_at', String(rotatedAt));
        });
      } catch (error) { prepared.vault.dispose(); throw error; }
      const previous = vault; vault = prepared.vault; previous.dispose();
      let recoveryPending = false; try { await prepared.promote(); } catch { recoveryPending = true; }
      return { rotatedAt, tokens: records.length, recoveryPending };
    },
    stats: () => ({ users: sql('SELECT count(*) AS n FROM users').get().n, photos: sql('SELECT count(*) AS n FROM photos').get().n, tokens: sql('SELECT count(*) AS n FROM vk_tokens').get().n, backup: metadata('json_backup') || null }),
    close() { if (!closed) { db.close(); vault?.dispose(); closed = true; } },
  };
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    const version = sql('PRAGMA user_version').get().user_version;
    if (version > 1) throw new Error('База создана более новой версией приложения');
    if (!version && await exists(marker)) throw new Error('Нельзя повторно импортировать старые JSON: восстановите базу SQLite из копии.');
    db.exec(schema);
    vault = await createTokenVault(root, { encryptionKey, expectedFingerprint: metadata('token_key_fingerprint'), preferFile: metadata('token_key_rotated') === 'true' });
    if (!version) {
      const files = new Map();
      async function legacyJSON(relative, fallback) {
        const path = join(root, relative);
        try { const bytes = await readFile(path); files.set(relative, bytes); return JSON.parse(bytes.toString('utf8')); }
        catch (error) { if (error.code === 'ENOENT') return structuredClone(fallback); if (error instanceof SyntaxError) throw new Error(`Не удалось перенести повреждённый JSON: ${relative}`); throw error; }
      }
      const saved = await legacyJSON('data/accounts.json', { users: [], sessions: {} });
      const accounts = { ...saved, policies: { grantAllRegistered: true, openRegistration: true, ...saved.policies }, legacyClaimed: saved.legacyClaimed ?? saved.users.length > 0, registrationKeys: saved.registrationKeys || [] };
      if (Object.values(accounts.policies).some(value => typeof value !== 'boolean')) throw new Error('Некорректные настройки доступа в старых данных');
      async function workspaceSnapshot(prefix) {
        return {
          settings: validateSettings(await legacyJSON(join(prefix, 'config/settings.json'), defaults)),
          exclusions: await legacyJSON(join(prefix, 'config/exclusions.json'), []), favorites: await legacyJSON(join(prefix, 'config/favorites.json'), []),
          library: await legacyJSON(join(prefix, 'cache/library.json'), { photos: {}, lastSync: null }),
        };
      }
      const template = await workspaceSnapshot('');
      // Copy legacy originals before committing metadata; originals remain available for recovery.
      for (const [id, photo] of Object.entries(template.library.photos)) {
        if (!validId(id) || photo.id !== id) throw new Error('Повреждён индекс старой библиотеки');
        try {
          const bytes = await readImage(root, photo), mime = imageType(bytes); if (!mime) throw new Error('Неподдерживаемое изображение старой библиотеки');
          const hash = digest(bytes), ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[mime], target = join(directory, 'blobs', `${hash}.${ext}`);
          await mkdir(dirname(target), { recursive: true });
          let valid = false; try { valid = digest(await readFile(target)) === hash; } catch (error) { if (error.code !== 'ENOENT') throw error; }
          if (!valid) { const temp = `${target}.${randomUUID()}.tmp`; await writeFile(temp, bytes, { mode: 0o600 }); await rename(temp, target); }
          Object.assign(photo, { hash, mime, bytes: bytes.length, stored: true });
        } catch (error) { if (error.code !== 'ENOENT') throw error; photo.stored = false; }
      }
      const workspaces = [];
      for (const user of accounts.users) {
        if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(user.id)) throw new Error('Некорректный ID в старых аккаунтах');
        const prefix = join('data/users', user.id);
        const personalFiles = await Promise.all(['cache/library.json', 'config/settings.json', 'config/exclusions.json', 'config/favorites.json'].map(relative => exists(join(root, prefix, relative))));
        if (personalFiles.some(Boolean)) workspaces.push([user.id, await workspaceSnapshot(prefix)]);
        else if (user.legacyOwner) workspaces.push([user.id, template]);
      }
      let backup;
      if (files.size) {
        backup = join('data/migrations', `json-backup-${Date.now()}-${randomUUID().slice(0, 8)}`);
        for (const [relative, bytes] of files) { const destination = join(root, backup, relative); await mkdir(dirname(destination), { recursive: true, mode: 0o700 }); await writeFile(destination, bytes, { mode: 0o600 }); }
      }
      transaction(() => {
        saveAccountsData(accounts);
        for (const [userId, snapshot] of workspaces) saveWorkspaceData(userId, snapshot);
        if (!accounts.legacyClaimed) putMeta('legacy_workspace', JSON.stringify(template));
        const owner = accounts.users.find(user => user.legacyOwner);
        if (legacyToken && owner) { setTokenData(owner.id, legacyToken); putMeta('legacy_token_owner', owner.id); }
        putMeta('token_key_fingerprint', vault.fingerprint);
        if (backup) putMeta('json_backup', backup);
        db.exec('PRAGMA user_version=1');
      });
    }
    // Check all saved credentials at startup, without exposing their values.
    for (const row of sql('SELECT * FROM vk_tokens').all()) vault.decrypt(row.user_id, row);
    await mkdir(dirname(marker), { recursive: true, mode: 0o700 });
    if (!await exists(marker)) await writeFile(marker, 'SQLite migration completed. Restore the database instead of reimporting JSON.\n', { flag: 'wx', mode: 0o600 });
    return store;
  } catch (error) { store.close(); throw error; }
}
