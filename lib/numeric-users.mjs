import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function migrateNumericUsers({ db, root, vault, schema, clearStatements }) {
  const users = db.prepare('SELECT * FROM users ORDER BY rowid').all();
  const mapping = new Map(users.map((user, index) => [user.id, index + 1]));
  const mapped = id => {
    const result = mapping.get(id); if (!result) throw new Error('Нарушена привязка данных к пользователю'); return result;
  };
  const tables = ['sessions', 'registration_keys', 'workspaces', 'photos', 'photo_preferences', 'vk_tokens'];
  const rows = Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  const encrypted = rows.vk_tokens.map(record => ({ userId: mapped(record.user_id), ...vault.encrypt(mapped(record.user_id), vault.decrypt(record.user_id, record)) }));
  let backup;
  if (users.length) {
    await mkdir(join(root, 'data/backups'), { recursive: true, mode: 0o700 });
    backup = join('data/backups', `before-numeric-ids-${Date.now()}-${randomUUID().slice(0, 8)}.sqlite`);
    db.prepare('VACUUM INTO ?').run(join(root, backup));
  }
  db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
  try {
    for (const table of [...tables, 'users']) db.exec(`DROP TABLE ${table}`);
    db.exec(schema); clearStatements();
    const insertUser = db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?)');
    for (const user of users) insertUser.run(mapped(user.id), user.login, user.salt, user.password_hash, user.created_at, user.legacy_owner, user.admin, user.full_access);
    const session = db.prepare('INSERT INTO sessions VALUES(?,?,?)');
    for (const row of rows.sessions) session.run(row.token_hash, mapped(row.user_id), row.expires_at);
    const registration = db.prepare('INSERT INTO registration_keys VALUES(?,?,?,?,?,?,?,?,?,?,?)');
    for (const row of rows.registration_keys) registration.run(row.id, row.code_hash, row.mask, row.label, row.type, row.created_at, mapping.get(row.created_by) ?? null, row.expires_at, row.max_uses, row.uses, row.revoked);
    const workspace = db.prepare('INSERT INTO workspaces VALUES(?,?,?)');
    for (const row of rows.workspaces) workspace.run(mapped(row.user_id), row.settings_json, row.library_meta_json);
    const photo = db.prepare('INSERT INTO photos VALUES(?,?,?,?,?,?)');
    for (const row of rows.photos) photo.run(mapped(row.user_id), row.photo_id, row.blob_hash, row.mime, row.stored, row.metadata_json);
    const preference = db.prepare('INSERT INTO photo_preferences VALUES(?,?,?,?)');
    for (const row of rows.photo_preferences) preference.run(mapped(row.user_id), row.photo_id, row.excluded, row.favorite);
    const token = db.prepare('INSERT INTO vk_tokens VALUES(?,?,?,?,?)');
    for (const row of encrypted) token.run(row.userId, row.version, row.iv, row.ciphertext, row.tag);
    const metadata = db.prepare('INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    metadata.run('numeric_user_ids', JSON.stringify(Object.fromEntries(mapping)));
    if (backup) metadata.run('numeric_ids_backup', backup);
    const owner = db.prepare("SELECT value FROM metadata WHERE key='legacy_token_owner'").get()?.value;
    if (owner && mapping.has(owner)) metadata.run('legacy_token_owner', String(mapped(owner)));
    else if (owner) db.prepare("DELETE FROM metadata WHERE key='legacy_token_owner'").run();
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Проверка связей пользователей не пройдена');
    db.exec('PRAGMA user_version=2; COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  finally { db.exec('PRAGMA foreign_keys=ON'); clearStatements(); }
}
