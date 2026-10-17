import { request } from 'node:http';
import { createApp } from '../app.js';
import { openDb } from '../db.js';

export const SECRET = 'test-secret-test-secret-test-secret-123';
export const make = (opts = {}) => createApp({ db: openDb(':memory:'), secret: SECRET, rateLimit: 1000, ...opts });
export const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)));

/** Низкоуровневый запрос: не следует редиректам, не распаковывает gzip — удобно проверять заголовки и размер. */
export function raw(base, method, path, { headers = {}, body } = {}) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: u.hostname, port: u.port, path, method, headers: { ...(body && { 'Content-Type': 'application/json' }), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        // Node отдаёт set-cookie массивом; тесты проверяют его регулярными выражениями, поэтому склеиваем в строку
        const headers = { ...res.headers };
        if (headers['set-cookie']) headers['set-cookie'] = headers['set-cookie'].join('; ');
        resolve({ status: res.statusCode, headers, body: Buffer.concat(chunks) });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

/** JSON-вызов API. */
export async function call(base, method, path, { token, body, headers = {} } = {}) {
  const r = await raw(base, method, path, { headers: { ...(token && { Authorization: `Bearer ${token}` }), ...headers }, body });
  const text = r.body.toString('utf8');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* не JSON */ }
  return { status: r.status, headers: r.headers, json, text };
}

export async function register(base, email, password = 'password1') {
  const r = await call(base, 'POST', '/api/auth/register', { body: { email, password } });
  return r.json.token;
}

export const egg = { name: 'Яйца', quantity: 10, unit: 'шт', storage: 'fridge', expiresAt: '2030-01-01' };
