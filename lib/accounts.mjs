import { randomBytes, randomUUID, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { readJSON, writeJSON } from './storage.mjs';

const derive = promisify(scrypt), duration = 30 * 24 * 60 * 60 * 1000;
const hash = value => createHash('sha256').update(value).digest('hex');
const cost = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
export const publicUser = user => user ? { id: user.id, login: user.login } : null;

export async function createAccounts(root, { now = Date.now } = {}) {
  const file = join(root, 'data/accounts.json');
  let database = await readJSON(file, { users: [], sessions: {} });
  const cookieName = `kero_session_${hash(resolve(root)).slice(0, 12)}`;
  const attempts = new Map();
  const persist = async next => { await writeJSON(file, next); database = next; };
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
    if (typeof input.password !== 'string' || input.password.length > 128 || input.password.length < (registering ? 12 : 1)) throw new Error('Пароль должен содержать от 12 до 128 символов');
    return { login, password: input.password };
  }
  function current(req) {
    const token = cookieToken(req);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token || '')) return null;
    const session = database.sessions[hash(token)];
    return session && session.expires > now() ? database.users.find(user => user.id === session.userId) || null : null;
  }
  return {
    current,
    async authenticate(req, res, input, registering) {
      const { login, password } = credentials(input, registering); rateLimit(req, login);
      let user = database.users.find(user => user.login === login);
      if (registering && user) throw Object.assign(new Error('Этот логин уже занят'), { status: 409 });
      const salt = registering ? randomBytes(16).toString('hex') : user?.salt || '0'.repeat(32);
      const derived = await derive(password, salt, 64, cost);
      if (!registering && (!user || !timingSafeEqual(derived, Buffer.from(user.passwordHash, 'hex')))) throw Object.assign(new Error('Неверный логин или пароль'), { status: 401 });
      const next = structuredClone(database);
      if (registering) {
        user = { id: randomUUID(), login, salt, passwordHash: derived.toString('hex'), createdAt: now(), legacyOwner: next.users.length === 0 };
        next.users.push(user);
      }
      const token = randomBytes(32).toString('base64url');
      for (const [key, session] of Object.entries(next.sessions)) if (session.expires <= now()) delete next.sessions[key];
      const previous = cookieToken(req); if (previous) delete next.sessions[hash(previous)];
      next.sessions[hash(token)] = { userId: user.id, expires: now() + duration };
      await persist(next); cookie(res, req, token, duration / 1000);
      return publicUser(user);
    },
    async logout(req, res) {
      const token = cookieToken(req), next = structuredClone(database);
      if (token) delete next.sessions[hash(token)];
      await persist(next); cookie(res, req, '', 0);
    },
  };
}
