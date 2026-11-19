import { randomBytes, randomUUID, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { openDatabase } from './database.mjs';

const derive = promisify(scrypt), duration = 30 * 24 * 60 * 60 * 1000;
const hash = value => createHash('sha256').update(value).digest('hex');
const cost = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
export const publicUser = user => user ? { id: user.id, login: user.login } : null;

export async function createAccounts(root, { now = Date.now, globalAdminIds = [], database: suppliedDatabase } = {}) {
  const store = suppliedDatabase || await openDatabase(root);
  const stored = store.readAccounts();
  let database = { ...stored, policies: { grantAllRegistered: true, openRegistration: true, ...stored.policies }, registrationKeys: stored.registrationKeys || [], legacyClaimed: stored.legacyClaimed ?? stored.users.length > 0 };
  if (['grantAllRegistered', 'openRegistration'].some(key => typeof database.policies[key] !== 'boolean')) throw new Error('Некорректные настройки доступа в базе');
  const globalAdmins = new Set(globalAdminIds.map(id => String(id).trim().toLowerCase()).filter(Boolean));
  if ([...globalAdmins].some(id => !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))) throw new Error('GLOBAL_ADMIN_IDS должен содержать ID пользователей через запятую');
  const cookieName = `kero_session_${hash(resolve(root)).slice(0, 12)}`;
  const attempts = new Map();
  const persist = async next => { store.saveAccounts(next, database); database = next; };
  const cookieToken = req => (req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  function cookie(res, req, value, age) {
    res.setHeader('Set-Cookie', `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${req.socket.encrypted ? '; Secure' : ''}`);
  }
  function rateLimit(req, login) {
    const keys = [`ip:${req.socket.remoteAddress}`, `login:${login}`];
    for (const key of keys) {
      let entry = attempts.get(key);
      if (!entry || entry.expires < now()) { entry = { count: 0, expires: now() + 15 * 60 * 1000 }; attempts.set(key, entry); }
      if (++entry.count > (key.startsWith('ip:') ? 60 : 15)) throw Object.assign(new Error('Слишком много попыток. Попробуйте через 15 минут.'), { status: 429 });
    }
    if (attempts.size > 10000) for (const [key, value] of attempts) if (value.expires < now()) attempts.delete(key);
  }
  function credentials(input, registering) {
    const login = typeof input.login === 'string' ? input.login.trim().toLowerCase() : '';
    if (!/^[a-z0-9_.-]{3,32}$/.test(login)) throw new Error('Логин: от 3 до 32 латинских букв, цифр, точек, дефисов или подчёркиваний');
    if (typeof input.password !== 'string' || input.password.length > 128 || input.password.length < (registering ? 8 : 1)) throw new Error('Пароль должен содержать от 8 до 128 символов');
    return { login, password: input.password };
  }
  function current(req) {
    const token = cookieToken(req);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token || '')) return null;
    const session = database.sessions[hash(token)];
    return session && session.expires > now() ? database.users.find(user => user.id === session.userId) || null : null;
  }
  function describe(user) {
    if (!user) return null;
    user = database.users.find(saved => saved.id === user.id); if (!user) return null;
    const isGlobalAdmin = globalAdmins.has(user.id), isAdmin = isGlobalAdmin || user.admin === true;
    return { ...publicUser(user), isGlobalAdmin, isAdmin, hasFullAccess: isAdmin || database.policies.grantAllRegistered || user.fullAccess === true };
  }
  function assertAdmin(actor) {
    if (!describe(actor)?.isAdmin) throw Object.assign(new Error('Недостаточно прав администратора'), { status: 403 });
  }
  function targetUser(id) {
    const user = database.users.find(user => user.id === id);
    if (!user) throw Object.assign(new Error('Пользователь не найден'), { status: 404 });
    return user;
  }
  function activeKey(key) { return !key.revoked && (!key.expiresAt || key.expiresAt > now()) && (!key.maxUses || key.uses < key.maxUses); }
  function registrationKey(data, input) {
    if (data.policies.openRegistration) return null;
    const code = typeof input.registrationKey === 'string' && input.registrationKey.length <= 128 ? input.registrationKey.trim() : '';
    const key = code && data.registrationKeys.find(key => key.hash === hash(code));
    if (!key || !activeKey(key)) throw Object.assign(new Error('Нужен действующий ключ регистрации'), { publicCode: 'REGISTRATION_KEY_REQUIRED' });
    return key;
  }
  function adminState(actor) {
    assertAdmin(actor);
    return { policies: structuredClone(database.policies), users: database.users.map(user => ({ ...describe(user), accessGranted: user.fullAccess === true, adminGranted: user.admin === true, createdAt: user.createdAt })), keys: database.registrationKeys.map(({ hash, ...key }) => ({ ...key, active: activeKey(key) })) };
  }
  function assertDelete(actor, id) {
    assertAdmin(actor); const target = targetUser(id);
    if (actor.id === target.id) throw new Error('Нельзя удалить свой аккаунт');
    if (describe(target).isGlobalAdmin || !describe(actor).isGlobalAdmin && describe(target).isAdmin) throw Object.assign(new Error('Нельзя удалить этого администратора'), { status: 403 });
    return target;
  }
  return {
    close: () => { if (!suppliedDatabase) store.close(); },
    current, describe, adminState, assertDelete,
    registrationPolicy: () => ({ openRegistration: database.policies.openRegistration }),
    async updatePolicy(actor, input) {
      assertAdmin(actor);
      if (Object.keys(input).some(key => !['grantAllRegistered', 'openRegistration'].includes(key)) || Object.values(input).some(value => typeof value !== 'boolean')) throw new Error('Некорректная настройка доступа');
      const next = structuredClone(database); Object.assign(next.policies, input); await persist(next); return adminState(targetUser(actor.id));
    },
    async updateUser(actor, input) {
      assertAdmin(actor); const target = targetUser(input.id), global = describe(actor).isGlobalAdmin;
      if (describe(target).isGlobalAdmin) throw Object.assign(new Error('Права глобального администратора задаются только на сервере'), { status: 403 });
      if (!global && (describe(target).isAdmin || Object.hasOwn(input, 'admin'))) throw Object.assign(new Error('Назначать и изменять администраторов может только глобальный администратор'), { status: 403 });
      if (Object.keys(input).some(key => !['id', 'admin', 'fullAccess'].includes(key)) || ['admin', 'fullAccess'].some(key => Object.hasOwn(input, key) && typeof input[key] !== 'boolean')) throw new Error('Некорректные права пользователя');
      const next = structuredClone(database), edited = next.users.find(user => user.id === target.id);
      for (const key of ['admin', 'fullAccess']) if (Object.hasOwn(input, key)) edited[key] = input[key];
      await persist(next); return adminState(targetUser(actor.id));
    },
    async deleteUser(actor, id) {
      const target = assertDelete(actor, id), next = structuredClone(database);
      next.users = next.users.filter(user => user.id !== id);
      for (const [key, session] of Object.entries(next.sessions)) if (session.userId === id) delete next.sessions[key];
      await persist(next); return publicUser(target);
    },
    async createKey(actor, input) {
      assertAdmin(actor);
      if (!['single', 'temporary', 'permanent'].includes(input.type)) throw new Error('Выберите тип ключа');
      if (input.type === 'temporary' && (!Number.isInteger(input.hours) || input.hours < 1 || input.hours > 8760)) throw new Error('Срок ключа — от 1 до 8760 часов');
      if (input.label !== undefined && (typeof input.label !== 'string' || input.label.length > 80 || /[\r\n\x00]/.test(input.label))) throw new Error('Название ключа — до 80 символов');
      if (database.registrationKeys.filter(activeKey).length >= 1000) throw new Error('Сначала отзовите ненужные ключи');
      const code = `kr_${randomBytes(24).toString('base64url')}`, next = structuredClone(database);
      const inactive = next.registrationKeys.filter(key => !activeKey(key)).slice(-200);
      next.registrationKeys = [...next.registrationKeys.filter(activeKey), ...inactive, { id: randomUUID(), hash: hash(code), mask: `${code.slice(0, 7)}…${code.slice(-4)}`, label: (input.label || '').trim(), type: input.type, createdAt: now(), createdBy: actor.id, expiresAt: input.type === 'temporary' ? now() + input.hours * 3600000 : null, maxUses: input.type === 'single' ? 1 : null, uses: 0, revoked: false }];
      await persist(next); return { code, ...adminState(targetUser(actor.id)) };
    },
    async revokeKey(actor, id) {
      assertAdmin(actor); const next = structuredClone(database), key = next.registrationKeys.find(key => key.id === id);
      if (!key) throw new Error('Ключ не найден'); key.revoked = true;
      await persist(next); return adminState(targetUser(actor.id));
    },
    async authenticate(req, res, input, registering) {
      const { login, password } = credentials(input, registering); rateLimit(req, login);
      if (registering) registrationKey(database, input);
      let user = database.users.find(user => user.login === login);
      if (registering && user) throw Object.assign(new Error('Этот логин уже занят'), { status: 409 });
      const salt = registering ? randomBytes(16).toString('hex') : user?.salt || '0'.repeat(32);
      const derived = await derive(password, salt, 64, cost);
      if (!registering && (!user || !timingSafeEqual(derived, Buffer.from(user.passwordHash, 'hex')))) throw Object.assign(new Error('Неверный логин или пароль'), { status: 401 });
      const next = structuredClone(database);
      if (registering) {
        const key = registrationKey(next, input); if (key) key.uses++;
        user = { id: randomUUID(), login, salt, passwordHash: derived.toString('hex'), createdAt: now(), legacyOwner: !next.legacyClaimed, admin: false, fullAccess: false };
        next.legacyClaimed = true;
        next.users.push(user);
      }
      const token = randomBytes(32).toString('base64url');
      for (const [key, session] of Object.entries(next.sessions)) if (session.expires <= now()) delete next.sessions[key];
      const previous = cookieToken(req); if (previous) delete next.sessions[hash(previous)];
      next.sessions[hash(token)] = { userId: user.id, expires: now() + duration };
      await persist(next); cookie(res, req, token, duration / 1000);
      return describe(user);
    },
    async logout(req, res) {
      const token = cookieToken(req), next = structuredClone(database);
      if (token) delete next.sessions[hash(token)];
      await persist(next); cookie(res, req, '', 0);
    },
  };
}
