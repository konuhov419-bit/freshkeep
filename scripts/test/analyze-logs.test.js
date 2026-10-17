import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, normalizePath } from '../analyze-logs.js';

const req = (over = {}) => JSON.stringify({ ts: '2026-10-17T10:00:00Z', level: 'info', event: 'http.request', method: 'GET', path: '/api/products', status: 200, ms: 10, ...over });
const ev = (event, over = {}) => JSON.stringify({ ts: '2026-10-17T10:00:00Z', level: 'warn', event, ...over });

test('пути нормализуются: идентификаторы заменяются на :id', () => {
  assert.equal(normalizePath('/api/products/3f2c1a9e-1b2c-4d5e-8f90-a1b2c3d4e5f6/consume'), '/api/products/:id/consume');
  assert.equal(normalizePath('/api/shopping/42'), '/api/shopping/:id');
});

test('сводка: уровни, классы статусов, входы, период', () => {
  const r = analyze([req(), req({ status: 401, level: 'warn' }), ev('auth.login', { level: 'info' }), '']);
  assert.deepEqual([r.summary.requests, r.summary.byStatus['2xx'], r.summary.byStatus['4xx'], r.summary.logins], [2, 1, 1, 1]);
  assert.equal(r.summary.byLevel.warn, 1);
  assert.equal(r.findings.length, 0);
});

test('необработанные ошибки и высокая доля 5xx: находки high с советом', () => {
  const lines = [...Array(30).fill(0).map(() => req()), ...Array(5).fill(0).map(() => req({ status: 500, level: 'error' })), ev('http.unhandled', { level: 'error', error: 'database is not open', reqId: 'abc' })];
  const { findings } = analyze(lines);
  assert.deepEqual(findings.map((f) => [f.severity, f.title]).slice(0, 2), [['high', 'Необработанные ошибки сервера'], ['high', 'Высокая доля 5xx']]);
  assert.match(findings[0].details, /database is not open/);
  assert.match(findings[0].advice, /reqId/);
});

test('подбор пароля: 5 неудачных входов с одного адреса — находка; с разных — нет', () => {
  const same = analyze(Array(5).fill(0).map(() => ev('auth.login_failed', { ip: 'aaa' })));
  assert.equal(same.findings[0].title, 'Возможный подбор пароля');
  const spread = analyze(['a', 'b', 'c', 'd', 'e'].map((ip) => ev('auth.login_failed', { ip })));
  assert.equal(spread.findings.length, 0);
});

test('сбои OAuth, блокировки, медленные маршруты, повреждённые строки', () => {
  const lines = [ev('oauth.provider_error', { level: 'error', provider: 'google' }), ev('auth.locked'), 'это не JSON', ...Array(6).fill(0).map((_, i) => req({ path: `/api/products/${i + 1}`, ms: 900 }))];
  const titles = analyze(lines).findings.map((f) => f.title);
  assert.ok(titles.includes('Сбои провайдера OAuth: google'));
  assert.ok(titles.includes('Срабатывали блокировки входа'));
  assert.ok(titles.includes('Медленный маршрут'));
  assert.ok(titles.includes('Повреждённые строки журнала'));
});
