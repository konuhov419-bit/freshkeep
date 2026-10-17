import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, api, request } from '../src/api.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const respond = (status, body) => { globalThis.fetch = async () => new Response(body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body), { status }); };
const failWith = async (fn) => { try { await fn(); } catch (e) { return e; } assert.fail('ожидалась ошибка'); };

test('ERR-7: нет сети -> ApiError со статусом 0 и понятным текстом', async () => {
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  const e = await failWith(() => api.listProducts());
  assert.ok(e instanceof ApiError);
  assert.deepEqual([e.status, e.code], [0, 'NETWORK']);
  assert.match(e.message, /Нет соединения/);
});

test('ERR-8: 500 без тела и с HTML-ответом не показывает технических деталей', async () => {
  respond(500, '<html>Bad gateway</html>');
  const e = await failWith(() => request('GET', '/api/products'));
  assert.equal(e.status, 500);
  assert.equal(e.message, 'Ошибка сервера. Попробуйте позже');
});

test('ERR-10/11/13: 401, 403, 429 с запасными текстами; сообщение сервера приоритетнее', async () => {
  respond(401, { error: { code: 'UNAUTHORIZED', message: 'Требуется вход' } });
  assert.equal((await failWith(() => api.me())).status, 401);
  respond(403, '');
  assert.equal((await failWith(() => api.me())).message, 'Нет доступа');
  respond(429, undefined);
  assert.match((await failWith(() => api.me())).message, /Слишком много попыток/);
});

test('ERR-1: 422 передаёт ошибки по полям, успешный ответ возвращает JSON, 204 — null', async () => {
  respond(422, { error: { code: 'VALIDATION_ERROR', message: 'Укажите название', fields: { name: 'Укажите название' } } });
  assert.deepEqual((await failWith(() => api.createProduct({}))).fields, { name: 'Укажите название' });
  respond(200, [{ id: '1' }]);
  assert.deepEqual(await api.listProducts(), [{ id: '1' }]);
  respond(204);
  assert.equal(await api.deleteProduct('1'), null);
});
