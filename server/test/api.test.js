import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.js';
import { openDb } from '../db.js';

const SECRET = 'test-secret-test-secret-test-secret-123';
let server, base;
const make = (opts = {}) => createApp({ db: openDb(':memory:'), secret: SECRET, origin: 'http://allowed.test', rateLimit: 1000, ...opts });
const listen = (s) => new Promise((r) => s.listen(0, () => r(`http://127.0.0.1:${s.address().port}`)));

before(async () => { server = make(); base = await listen(server); });
after(() => server.close());

async function call(method, path, { token, body, headers = {}, raw } = {}, b = base) {
  const res = await fetch(b + path, { method, headers: { ...(body && { 'Content-Type': 'application/json' }), ...(token && { Authorization: `Bearer ${token}` }), ...headers }, body: raw ?? (body && JSON.stringify(body)) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
}
async function user(email) {
  const r = await call('POST', '/api/auth/register', { body: { email, password: 'password1' } });
  return r.json.token;
}
const egg = { name: 'Яйца', quantity: 10, unit: 'шт', storage: 'fridge', expiresAt: '2030-01-01' };

test('health работает без авторизации', async () => {
  const r = await call('GET', '/api/health');
  assert.deepEqual([r.status, r.json.status], [200, 'ok']);
});

test('регистрация и вход: валидация, дубликат, неверный пароль', async () => {
  const bad = await call('POST', '/api/auth/register', { body: { email: 'no-at', password: 'short' } });
  assert.equal(bad.status, 422);
  assert.ok(bad.json.error.fields.email && bad.json.error.fields.password);
  const ok = await call('POST', '/api/auth/register', { body: { email: 'A@Test.com ', password: 'password1' } });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.user.email, 'a@test.com');
  assert.ok(!JSON.stringify(ok.json).includes('password'));
  assert.equal((await call('POST', '/api/auth/register', { body: { email: 'a@test.com', password: 'password1' } })).status, 409);
  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'a@test.com', password: 'wrong-pass1' } })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'nobody@test.com', password: 'password1' } })).json.error.message, 'Неверный email или пароль');
  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'a@test.com', password: 'password1' } })).status, 200);
});

test('401: без токена, с неверным токеном и с токеном удалённого формата', async () => {
  assert.equal((await call('GET', '/api/products')).status, 401);
  assert.equal((await call('GET', '/api/products', { token: 'abc.def.ghi' })).status, 401);
  assert.equal((await call('GET', '/api/me', { headers: { Authorization: 'Basic xxx' } })).status, 401);
});

test('CRUD продуктов: создание, список, правка, удаление, 404', async () => {
  const t = await user('crud@test.com');
  const created = await call('POST', '/api/products', { token: t, body: egg });
  assert.equal(created.status, 201);
  const id = created.json.id;
  assert.equal((await call('GET', '/api/products', { token: t })).json.length, 1);
  const patched = await call('PATCH', `/api/products/${id}`, { token: t, body: { quantity: 8 } });
  assert.equal(patched.json.quantity, 8);
  assert.equal((await call('DELETE', `/api/products/${id}`, { token: t })).status, 204);
  assert.equal((await call('DELETE', `/api/products/${id}`, { token: t })).status, 404);
});

test('422: ошибки валидации продукта приходят по полям', async () => {
  const t = await user('val@test.com');
  const r = await call('POST', '/api/products', { token: t, body: { name: '', quantity: '0', unit: 'x', storage: 'fridge', expiresAt: '2026-02-30' } });
  assert.equal(r.status, 422);
  assert.deepEqual(Object.keys(r.json.error.fields).sort(), ['expiresAt', 'name', 'quantity', 'unit']);
});

test('частичное списание: 10 яиц − 2 = 8; больше, чем есть — 422; всё — запись удалена', async () => {
  const t = await user('eat@test.com');
  const id = (await call('POST', '/api/products', { token: t, body: egg })).json.id;
  const r = await call('POST', `/api/products/${id}/consume`, { token: t, body: { amount: '2' } });
  assert.deepEqual([r.json.finished, r.json.product.quantity], [false, 8]);
  const over = await call('POST', `/api/products/${id}/consume`, { token: t, body: { amount: '9' } });
  assert.equal(over.status, 422);
  assert.match(over.json.error.message, /осталось 8 шт/);
  const all = await call('POST', `/api/products/${id}/consume`, { token: t, body: { amount: '8' } });
  assert.equal(all.json.finished, true);
  assert.equal((await call('GET', '/api/products', { token: t })).json.length, 0);
});

test('граммы: 200 г из 1 кг оставляют 0,8 кг', async () => {
  const t = await user('gram@test.com');
  const id = (await call('POST', '/api/products', { token: t, body: { ...egg, name: 'Рис', quantity: 1, unit: 'кг' } })).json.id;
  const r = await call('POST', `/api/products/${id}/consume`, { token: t, body: { amount: '200', unit: 'г' } });
  assert.equal(r.json.product.quantity, 0.8);
});

test('изоляция данных: чужую запись нельзя ни прочитать, ни изменить, ни удалить (403)', async () => {
  const a = await user('owner@test.com');
  const b = await user('other@test.com');
  const id = (await call('POST', '/api/products', { token: a, body: egg })).json.id;
  assert.equal((await call('GET', '/api/products', { token: b })).json.length, 0);
  for (const [m, p, body] of [['PATCH', `/api/products/${id}`, { quantity: 1 }], ['DELETE', `/api/products/${id}`], ['POST', `/api/products/${id}/consume`, { amount: '1' }]]) {
    assert.equal((await call(m, p, { token: b, body })).status, 403, `${m} ${p}`);
  }
  assert.equal((await call('GET', '/api/products', { token: a })).json[0].quantity, 10);
});

test('список покупок: добавление, дубль 409, отметка, удаление', async () => {
  const t = await user('shop@test.com');
  const item = await call('POST', '/api/shopping', { token: t, body: { name: '  Творог ' } });
  assert.equal(item.status, 201);
  assert.equal((await call('POST', '/api/shopping', { token: t, body: { name: 'творог' } })).status, 409);
  assert.equal((await call('POST', '/api/shopping', { token: t, body: { name: ' ' } })).status, 422);
  assert.equal((await call('PATCH', `/api/shopping/${item.json.id}`, { token: t, body: { isBought: true } })).json.isBought, true);
  assert.equal((await call('PATCH', `/api/shopping/${item.json.id}`, { token: t, body: { isBought: 'yes' } })).status, 422);
  assert.equal((await call('DELETE', `/api/shopping/${item.json.id}`, { token: t })).status, 204);
});

test('CORS: разрешённый источник получает заголовок, чужой — нет; preflight отвечает 204', async () => {
  const ok = await call('OPTIONS', '/api/products', { headers: { Origin: 'http://allowed.test' } });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'http://allowed.test');
  assert.match(ok.headers.get('access-control-allow-headers'), /Authorization/);
  const bad = await call('GET', '/api/health', { headers: { Origin: 'http://evil.test' } });
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
});

test('некорректный JSON и неизвестные маршруты', async () => {
  const t = await user('json@test.com');
  assert.equal((await call('POST', '/api/products', { token: t, raw: '{oops', headers: { 'Content-Type': 'application/json' } })).json.error.code, 'INVALID_JSON');
  assert.equal((await call('GET', '/api/nope')).status, 404);
  assert.equal((await call('PUT', '/api/products')).status, 405);
});

test('429: перебор паролей ограничивается', async () => {
  const s = make({ rateLimit: 3 });
  const b = await listen(s);
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await call('POST', '/api/auth/login', { body: { email: 'x@test.com', password: 'password1' } }, b)).status);
  s.close();
  assert.deepEqual(codes, [401, 401, 401, 429, 429]);
});

test('500: внутренняя ошибка не раскрывает детали и пишется в лог', async () => {
  const logs = [];
  const db = openDb(':memory:');
  const s = createApp({ db, secret: SECRET, log: (...a) => logs.push(a), rateLimit: 1000 });
  const b = await listen(s);
  const token = (await call('POST', '/api/auth/register', { body: { email: 'e@test.com', password: 'password1' } }, b)).json.token;
  db.exec('DROP TABLE products');
  const r = await call('GET', '/api/products', { token }, b);
  s.close();
  assert.equal(r.status, 500);
  assert.equal(r.json.error.code, 'INTERNAL');
  assert.ok(!JSON.stringify(r.json).includes('products'));
  assert.ok(logs.some(([lvl, msg]) => lvl === 'error' && msg === 'unhandled'));
});

test('логи не содержат паролей и токенов', async () => {
  const logs = [];
  const s = make({ log: (...a) => logs.push(JSON.stringify(a)) });
  const b = await listen(s);
  await call('POST', '/api/auth/register', { body: { email: 'log@test.com', password: 'SuperSecret123' } }, b);
  s.close();
  assert.ok(logs.length && !logs.join('').includes('SuperSecret123'));
});

test('статика: фронтенд отдаётся, выход за пределы каталога запрещён', async () => {
  const s = make({ staticDir: new URL('../../web', import.meta.url).pathname });
  const b = await listen(s);
  assert.equal((await fetch(b + '/')).status, 200);
  assert.notEqual((await fetch(b + '/..%2fserver%2fapp.js')).status, 200);
  s.close();
});
