import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export function hashPassword(password) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, 64).toString('hex')}`;
}

/** Хеш-заглушка: при входе с неизвестным email сравниваем с ней, чтобы время ответа не выдавало, есть ли такой аккаунт. */
export const DUMMY_HASH = hashPassword('заглушка-для-постоянного-времени-1');

/** Хеш аккаунтов, созданных через OAuth: не соответствует формату scrypt, поэтому вход по паролю невозможен. */
export const NO_PASSWORD = 'oauth!';

export function verifyPassword(password, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password, Buffer.from(salt, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
const sign = (data, secret) => createHmac('sha256', secret).update(data).digest('base64url');

/** Токен формата JWT (HS256). */
export function signToken(payload, secret, ttlSeconds = 7 * 24 * 3600) {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds });
  return `${head}.${body}.${sign(`${head}.${body}`, secret)}`;
}

/** @returns {object|null} payload или null, если подпись неверна / срок истёк / формат некорректен */
export function verifyToken(token, secret) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return null;
  try {
    // Принимаем только HS256: токены с alg=none или другим алгоритмом отклоняются до проверки подписи
    if (JSON.parse(Buffer.from(parts[0], 'base64url').toString()).alg !== 'HS256') return null;
  } catch { return null; }
  const a = Buffer.from(parts[2]);
  const e = Buffer.from(sign(`${parts[0]}.${parts[1]}`, secret));
  if (a.length !== e.length || !timingSafeEqual(a, e)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    return payload.exp > Date.now() / 1000 ? payload : null;
  } catch { return null; }
}

/** FR-1.1: email корректный, пароль ≥ 8 символов с буквой и цифрой. */
export function validateCredentials({ email, password }) {
  const errors = {};
  const mail = String(email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail) || mail.length > 254) errors.email = 'Введите корректный email';
  const pw = String(password ?? '');
  // Верхняя граница защищает от DoS: scrypt над мегабайтным «паролем» нагружает процессор
  if (pw.length < 8 || pw.length > 128 || !/[A-Za-zА-Яа-я]/.test(pw) || !/\d/.test(pw)) errors.password = 'Пароль: от 8 до 128 символов, с буквой и цифрой';
  return { errors, email: mail, password: pw };
}
