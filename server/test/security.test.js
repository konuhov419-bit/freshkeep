import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../log.js';
import { SECRET, call, egg, listen, make, raw, register } from './helpers.js';

const servers = [];
const start = async (opts) => { const s = make(opts); servers.push(s); return { s, base: await listen(s) }; };
after(() => servers.forEach((s) => s.close()));

test('заголовки безопасности есть и у API, и у статики (CSP, nosniff, frame, no-store)', async () => {
  const web = mkdtempSync(join(tmpdir(), 'web-'));
  writeFileSync(join(web, 'index.html'), '<h1>ok</h1>');
  const { base } = await start({ staticDir: web });
  const api = await call(base, 'GET', '/api/health');
  assert.equal(api.headers['cache-control'], 'no-store');
  assert.equal(api.headers['x-content-type-options'], 'nosniff');
  assert.equal(api.headers['x-frame-options'], 'DENY');
  assert.match(api.headers['content-security-policy'], /default-src 'none'/);
  const page = await call(base, 'GET', '/');
  assert.match(page.headers['content-security-policy'], /style-src 'self'; /);
  assert.ok(!page.headers['content-security-policy'].includes('unsafe-inline'));
  assert.ok(!page.headers['content-security-policy'].includes('mc.yandex.ru'));
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  assert.equal(api.headers['strict-transport-security'], undefined);
  rmSync(web, { recursive: true });
});

test('HSTS включается для https; CSP открывает Метрику только если задан счётчик', async () => {
  const { base } = await start({ publicUrl: 'https://app.example.com', metrikaId: '12345678', staticDir: mkdtempSync(join(tmpdir(), 'web-')) });
  const r = await call(base, 'GET', '/api/health');
  assert.match(r.headers['strict-transport-security'], /max-age=31536000/);
  const cfg = await call(base, 'GET', '/config.js');
  assert.match(cfg.text, /FRESHKEEP_METRIKA_ID = "12345678"/);
  assert.match(cfg.headers['content-security-policy'], /script-src 'self' https:\/\/mc\.yandex\.ru/);
});

test('CSRF: изменяющий запрос с чужого Origin блокируется, со своего и без Origin проходит', async () => {
  const { base } = await start({ origin: 'https://ok.example.com' });
  const t = await register(base, 'csrf@test.com');
  const evil = await call(base, 'POST', '/api/products', { token: t, body: egg, headers: { Origin: 'https://evil.example.com' } });
  assert.deepEqual([evil.status, evil.json.error.code], [403, 'BAD_ORIGIN']);
  assert.equal((await call(base, 'POST', '/api/products', { token: t, body: egg, headers: { Origin: base } })).status, 201);
  assert.equal((await call(base, 'POST', '/api/products', { token: t, body: egg, headers: { Origin: 'https://ok.example.com' } })).status, 201);
  assert.equal((await call(base, 'POST', '/api/products', { token: t, body: egg })).status, 201);
  assert.equal((await call(base, 'GET', '/api/products', { token: t, headers: { Origin: 'https://evil.example.com' } })).status, 200); // чтение не изменяет данные, а CORS не отдаёт ответ чужому сайту
});

test('отзыв токенов: после выхода старый токен не работает, повторный вход выдаёт рабочий', async () => {
  const { base } = await start();
  const t = await register(base, 'revoke@test.com');
  assert.equal((await call(base, 'GET', '/api/me', { token: t })).status, 200);
  assert.equal((await call(base, 'POST', '/api/auth/logout', { token: t })).status, 204);
  assert.equal((await call(base, 'GET', '/api/me', { token: t })).status, 401);
  const again = await call(base, 'POST', '/api/auth/login', { body: { email: 'revoke@test.com', password: 'password1' } });
  assert.equal((await call(base, 'GET', '/api/me', { token: again.json.token })).status, 200);
});

test('JWT: токен с alg=none или чужой подписью отклоняется', async () => {
  const { base } = await start();
  await register(base, 'jwt@test.com');
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'x', exp })}.`;
  const header = b64({ alg: 'HS512', typ: 'JWT' }); const body = b64({ sub: 'x', v: 0, exp });
  const hs512 = `${header}.${body}.${createHmac('sha256', SECRET).update(`${header}.${body}`).digest('base64url')}`;
  const wrong = `${b64({ alg: 'HS256', typ: 'JWT' })}.${body}.${createHmac('sha256', 'other-secret').update('x').digest('base64url')}`;
  for (const token of [none, hs512, wrong]) assert.equal((await call(base, 'GET', '/api/me', { token })).status, 401);
});

test('пароль: длиннее 128 символов отклоняется; после 5 неудачных входов аккаунт блокируется на 15 минут', async () => {
  const { base } = await start();
  const long = await call(base, 'POST', '/api/auth/register', { body: { email: 'long@test.com', password: `a1${'x'.repeat(200)}` } });
  assert.equal(long.status, 422);
  await register(base, 'lock@test.com');
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await call(base, 'POST', '/api/auth/login', { body: { email: 'lock@test.com', password: 'wrong-pass1' } })).status);
  assert.deepEqual(codes, [401, 401, 401, 401, 401, 429]);
  const good = await call(base, 'POST', '/api/auth/login', { body: { email: 'lock@test.com', password: 'password1' } });
  assert.equal(good.status, 429);
  assert.equal(good.headers['retry-after'], '900');
  await register(base, 'free@test.com');
  assert.equal((await call(base, 'POST', '/api/auth/login', { body: { email: 'free@test.com', password: 'password1' } })).status, 200);
});

test('вход с неизвестным email занимает столько же времени, сколько с неверным паролем (нет перечисления по времени)', async () => {
  const { base } = await start();
  await register(base, 'timing@test.com');
  const time = async (email) => { const t0 = performance.now(); await call(base, 'POST', '/api/auth/login', { body: { email, password: 'wrong-pass1' } }); return performance.now() - t0; };
  const unknown = []; const known = [];
  for (let i = 0; i < 4; i++) { unknown.push(await time(`nobody${i}@test.com`)); known.push(await time('timing@test.com')); }
  const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  assert.ok(median(unknown) > 5, `неизвестный email отвечает слишком быстро: ${median(unknown)} мс`);
  assert.ok(median(unknown) / median(known) > 0.4, `${median(unknown)} против ${median(known)} мс`);
});

test('защита от rate limit за прокси: адрес берётся из X-Forwarded-For только при TRUST_PROXY', async () => {
  const { base } = await start({ rateLimit: 2, trustProxy: true });
  const login = (ip) => call(base, 'POST', '/api/auth/login', { body: { email: 'a@test.com', password: 'password1' }, headers: { 'X-Forwarded-For': ip } });
  assert.deepEqual([(await login('1.1.1.1')).status, (await login('1.1.1.1')).status, (await login('1.1.1.1')).status], [401, 401, 429]);
  assert.equal((await login('2.2.2.2')).status, 401); // другой клиент не блокируется
});

test('SQL-инъекции: нагрузки сохраняются как текст, таблицы целы', async () => {
  const { base } = await start();
  const t = await register(base, 'sqli@test.com');
  const inj = "'); DROP TABLE products;--";
  assert.equal((await call(base, 'POST', '/api/products', { token: t, body: { ...egg, name: inj } })).status, 201);
  assert.equal((await call(base, 'POST', '/api/shopping', { token: t, body: { name: "x' OR '1'='1" } })).status, 201);
  assert.equal((await call(base, 'POST', '/api/auth/login', { body: { email: "' OR '1'='1' --", password: "' OR '1'='1" } })).status, 401);
  assert.equal((await call(base, 'GET', "/api/products/1'%20OR%20'1'='1", { token: t })).status, 404);
  const list = await call(base, 'GET', '/api/products', { token: t });
  assert.equal(list.json[0].name, inj);
});

test('валидация типов: нестроковые поля, ключи прототипа и огромные числа дают 422, а не 500', async () => {
  const { base } = await start();
  const t = await register(base, 'types@test.com');
  const bad = [{ ...egg, name: 5 }, { ...egg, storage: 'toString' }, { ...egg, unit: '__proto__' }, { ...egg, expiresAt: 20260101 }, { ...egg, quantity: '9'.repeat(400) }, { ...egg, quantity: '1e3' }];
  for (const body of bad) assert.equal((await call(base, 'POST', '/api/products', { token: t, body })).status, 422, JSON.stringify(body).slice(0, 60));
  const id = (await call(base, 'POST', '/api/products', { token: t, body: { ...egg, unit: 'кг', quantity: 1 } })).json.id;
  assert.equal((await call(base, 'POST', `/api/products/${id}/consume`, { token: t, body: { amount: '1', unit: '__proto__' } })).status, 422);
  assert.equal((await call(base, 'POST', `/api/products/${id}/consume`, { token: t, body: { amount: '9'.repeat(40) } })).status, 422);
  assert.equal((await call(base, 'POST', '/api/shopping', { token: t, body: { name: ['x'] } })).status, 422);
});

test('квота: не больше 500 продуктов на пользователя', async () => {
  const { base } = await start();
  const t = await register(base, 'quota@test.com');
  for (let i = 0; i < 500; i++) await call(base, 'POST', '/api/products', { token: t, body: { ...egg, name: `П${i}` } });
  const r = await call(base, 'POST', '/api/products', { token: t, body: egg });
  assert.deepEqual([r.status, r.json.error.code], [422, 'LIMIT_REACHED']);
});

test('статика: битая кодировка даёт 400, соседний каталог с похожим именем и /test/ недоступны, \\0 отклоняется', async () => {
  const root = mkdtempSync(join(tmpdir(), 'site-'));
  mkdirSync(join(root, 'web')); mkdirSync(join(root, 'web2')); mkdirSync(join(root, 'web', 'test'));
  writeFileSync(join(root, 'web', 'index.html'), 'ok'); writeFileSync(join(root, 'web2', 'secret.txt'), 'SECRET'); writeFileSync(join(root, 'web', 'test', 'a.js'), 'x');
  const { base } = await start({ staticDir: join(root, 'web') });
  assert.equal((await raw(base, 'GET', '/%E0%A4%A')).status, 400);
  assert.equal((await raw(base, 'GET', '/..%2fweb2%2fsecret.txt')).status, 403);
  assert.equal((await raw(base, 'GET', '/test/a.js')).status, 403);
  assert.equal((await raw(base, 'GET', '/index.html%00.png')).status, 400);
  assert.equal((await raw(base, 'GET', '/index.html')).status, 200);
  assert.equal((await raw(base, 'GET', '/nope.html')).status, 404);
  rmSync(root, { recursive: true });
});

test('мониторинг: /api/health и /api/ready; /api/ready отвечает 503 при недоступной БД', async () => {
  const s = make({ version: '1.2.3+abc' }); servers.push(s);
  const base = await listen(s);
  const health = await call(base, 'GET', '/api/health');
  assert.deepEqual([health.status, health.json.status, health.json.version], [200, 'ok', '1.2.3+abc']);
  const ready = await call(base, 'GET', '/api/ready');
  assert.equal(ready.status, 200);
  assert.equal(ready.json.checks.database.status, 'ok');
  assert.ok(ready.json.checks.database.migrations >= 5);
});

test('/api/ready: недоступная БД -> 503, недоступный внешний сервис -> degraded (200)', async () => {
  const { openDb } = await import('../db.js');
  const { createApp } = await import('../app.js');
  const db = openDb(':memory:');
  const s = createApp({ db, secret: SECRET, rateLimit: 1000, oauth: { google: { clientId: 'id', clientSecret: 'secret', def: { authorizeUrl: 'http://127.0.0.1:9/authorize' } } } });
  servers.push(s);
  const base = await listen(s);
  const degraded = await call(base, 'GET', '/api/ready');
  assert.deepEqual([degraded.status, degraded.json.status, degraded.json.checks.oauth_google.status], [200, 'degraded', 'fail']);
  db.close();
  const down = await call(base, 'GET', '/api/ready');
  assert.deepEqual([down.status, down.json.status], [503, 'fail']);
});

test('метрики: выключены без токена, защищены токеном, формат Prometheus', async () => {
  assert.equal((await call((await start()).base, 'GET', '/api/metrics')).status, 404);
  const { base } = await start({ metricsToken: 'metrics-token-123' });
  await call(base, 'GET', '/api/health'); await call(base, 'GET', '/api/products');
  assert.equal((await call(base, 'GET', '/api/metrics')).status, 401);
  assert.equal((await call(base, 'GET', '/api/metrics', { token: 'wrong' })).status, 401);
  const ok = await call(base, 'GET', '/api/metrics', { token: 'metrics-token-123' });
  assert.equal(ok.status, 200);
  assert.match(ok.headers['content-type'], /text\/plain/);
  assert.match(ok.text, /freshkeep_requests_total\{status="2xx"\} \d+/);
  assert.match(ok.text, /freshkeep_requests_total\{status="4xx"\} \d+/);
});

test('оптимизация: gzip для больших ответов и ETag/304 для статики', async () => {
  const web = mkdtempSync(join(tmpdir(), 'web-'));
  writeFileSync(join(web, 'app.js'), 'const x = 1;\n'.repeat(500));
  const { base } = await start({ staticDir: web });
  const first = await raw(base, 'GET', '/app.js', { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(first.headers['content-encoding'], 'gzip');
  assert.ok(first.body.length < 500);
  assert.equal((await raw(base, 'GET', '/app.js', { headers: { 'Accept-Encoding': 'gzip', 'If-None-Match': first.headers.etag } })).status, 304);
  assert.equal((await raw(base, 'GET', '/app.js')).headers['content-encoding'], undefined);
  const t = await register(base, 'gz@test.com');
  for (let i = 0; i < 30; i++) await call(base, 'POST', '/api/products', { token: t, body: { ...egg, name: `Продукт ${i}` } });
  const list = await raw(base, 'GET', '/api/products', { headers: { 'Accept-Encoding': 'gzip', Authorization: `Bearer ${t}` } });
  assert.equal(list.headers['content-encoding'], 'gzip');
  rmSync(web, { recursive: true });
});

test('логгер: скрывает секреты, пишет JSON с базовыми полями, файл с правами 0600', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'log-'));
  const file = join(dir, 'api.log');
  const log = createLogger({ file, base: { service: 'freshkeep', version: 't' } });
  const out = console.log; console.log = () => {};
  try { log('info', 'login', { event: 'auth.login', password: 'SuperSecret123', accessToken: 'abc', cookie: 'x=y', userId: 'u1' }); } finally { console.log = out; }
  await new Promise((r) => setTimeout(r, 100));
  const text = readFileSync(file, 'utf8');
  assert.ok(!text.includes('SuperSecret123') && !text.includes('abc') && !text.includes('x=y'));
  const line = JSON.parse(text.trim());
  assert.deepEqual([line.service, line.version, line.level, line.event, line.password, line.userId], ['freshkeep', 't', 'info', 'auth.login', '[скрыто]', 'u1']);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  rmSync(dir, { recursive: true });
});

test('логгер: ротация по размеру — старый файл уходит в .1, текущий не превышает лимит', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'log-'));
  const file = join(dir, 'api.log');
  const log = createLogger({ file, maxBytes: 600 });
  const out = console.log; console.log = () => {};
  try { for (let i = 0; i < 12; i++) log('info', 'request', { n: i, pad: 'x'.repeat(60) }); } finally { console.log = out; }
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(existsSync(`${file}.1`) && statSync(`${file}.1`).size > 0);
  assert.ok(statSync(file).size <= 600);
  rmSync(dir, { recursive: true });
});
