// HTTP API без зависимостей. Маршруты /api/*, остальное — статика фронтенда.
import { createServer } from 'node:http';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, relative, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { DUMMY_HASH, NO_PASSWORD, hashPassword, signToken, validateCredentials, verifyPassword, verifyToken } from './auth.js';
import { buildAuthUrl, exchangeCode, fetchProfile, pkcePair, resolveProviders } from './oauth.js';
import { consumeProduct, validateProduct } from '../web/src/domain/inventory.js';

const MAX_BODY = 100 * 1024;
const MAX_PRODUCTS = 500;
const MAX_SHOPPING = 500;
const GZIP_MIN = 1024;
const LOCK_AFTER = 5; // неудачных входов подряд
const LOCK_MS = 15 * 60_000;
const TICKET_TTL_MS = 60_000;
const OAUTH_COOKIE = 'fk_oauth';
const OAUTH_COOKIE_TTL = 600; // секунд на прохождение входа у провайдера
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
const COMPRESSIBLE = /^(text\/|application\/json|image\/svg)/;

class HttpError extends Error {
  constructor(status, code, message, fields) { super(message); Object.assign(this, { status, code, fields }); }
}
const fail = (status, code, message, fields) => { throw new HttpError(status, code, message, fields); };
const nameKey = (s) => s.trim().toLowerCase().replace(/\s+/g, ' ');
const isString = (v) => typeof v === 'string';
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * @param {object} options
 * @param {import('node:sqlite').DatabaseSync} options.db
 * @param {string} options.secret секрет подписи токенов и cookie
 * @param {string} [options.origin] разрешённые источники для CORS и CSRF через запятую; пусто = только свой origin, * = любой
 * @param {string} [options.publicUrl] внешний адрес приложения (https://app.example.com): redirect_uri OAuth, Secure-cookie, HSTS
 * @param {boolean} [options.trustProxy] брать адрес клиента из X-Forwarded-For (только за доверенным прокси)
 * @param {string} [options.metrikaId] номер счётчика Яндекс.Метрики; открывает его домен в CSP
 * @param {Record<string, {clientId: string, clientSecret: string, def?: object}>} [options.oauth] настройки провайдеров OAuth2
 * @param {string} [options.metricsToken] токен для /api/metrics; пусто = метрики выключены
 */
export function createApp({
  db, secret, origin = '', log = () => {}, staticDir = '', rateLimit = 10, trustProxy = false,
  publicUrl = '', metrikaId = '', version = 'dev', oauth = {}, metricsToken = '',
}) {
  const q = {
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    userById: db.prepare('SELECT id, email, token_version FROM users WHERE id = ?'),
    addUser: db.prepare('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)'),
    bumpVersion: db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?'),
    convertToOauth: db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?'),
    identity: db.prepare('SELECT user_id FROM oauth_identities WHERE provider = ? AND subject = ?'),
    addIdentity: db.prepare('INSERT INTO oauth_identities (provider, subject, user_id, created_at) VALUES (?, ?, ?, ?)'),
    products: db.prepare('SELECT * FROM products WHERE user_id = ? ORDER BY expires_at IS NULL, expires_at, name'),
    countProducts: db.prepare('SELECT COUNT(*) AS n FROM products WHERE user_id = ?'),
    product: db.prepare('SELECT * FROM products WHERE id = ?'),
    addProduct: db.prepare('INSERT INTO products (id, user_id, name, quantity, unit, storage, expires_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)'),
    updProduct: db.prepare('UPDATE products SET name=?, quantity=?, unit=?, storage=?, expires_at=?, updated_at=? WHERE id=?'),
    delProduct: db.prepare('DELETE FROM products WHERE id = ?'),
    items: db.prepare('SELECT * FROM shopping_items WHERE user_id = ? ORDER BY created_at DESC, rowid DESC'),
    countItems: db.prepare('SELECT COUNT(*) AS n FROM shopping_items WHERE user_id = ?'),
    item: db.prepare('SELECT * FROM shopping_items WHERE id = ?'),
    addItem: db.prepare('INSERT INTO shopping_items (id, user_id, name, name_key, is_bought, created_at) VALUES (?,?,?,?,0,?)'),
    updItem: db.prepare('UPDATE shopping_items SET is_bought = ? WHERE id = ?'),
    delItem: db.prepare('DELETE FROM shopping_items WHERE id = ?'),
  };

  const providers = resolveProviders(oauth);
  const allowedOrigins = origin.split(',').map((s) => s.trim()).filter(Boolean);
  const publicBase = publicUrl.replace(/\/+$/, '');
  const isHttps = publicBase.startsWith('https://');
  if (publicBase) allowedOrigins.push(new URL(publicBase).origin);
  const metrika = /^\d{1,12}$/.test(metrikaId) ? metrikaId : '';
  const startedAt = Date.now();

  // Состояние в памяти: счётчики попыток, блокировки аккаунтов, одноразовые тикеты OAuth, метрики
  const attempts = new Map();
  const locks = new Map();
  const tickets = new Map();
  const probes = new Map();
  const metrics = { requests: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 }, durationSum: 0, durationCount: 0, authFailures: 0 };
  const fileCache = new Map();

  const toProduct = (r) => ({ id: r.id, name: r.name, quantity: r.quantity, unit: r.unit, storage: r.storage, expiresAt: r.expires_at });
  const toItem = (r) => ({ id: r.id, name: r.name, isBought: !!r.is_bought });
  const validation = (errors) => fail(422, 'VALIDATION_ERROR', Object.values(errors)[0], errors);

  /** Проверка владельца: чужая запись -> 403, несуществующая -> 404 (политика доступа вместо RLS). */
  function owned(row, ctx) {
    if (!row) fail(404, 'NOT_FOUND', 'Запись не найдена');
    if (row.user_id !== ctx.user.id) fail(403, 'FORBIDDEN', 'Нет доступа к этой записи');
    return row;
  }

  /** Адрес клиента. X-Forwarded-For доверяем только при trustProxy и берём последний элемент: его дописал наш прокси. */
  function clientIp(req) {
    if (trustProxy) {
      const last = String(req.headers['x-forwarded-for'] ?? '').split(',').at(-1)?.trim();
      if (last) return last;
    }
    return req.socket.remoteAddress ?? 'unknown';
  }
  /** Короткий необратимый отпечаток адреса для логов: виден повтор, но сам адрес не хранится. */
  const ipTag = (ip) => createHmac('sha256', secret).update(ip).digest('hex').slice(0, 10);

  /** Ограничение частоты по адресу клиента и пути (ERR-13). Старые записи вычищаются, чтобы память не росла. */
  function limit(ctx) {
    const now = Date.now();
    if (attempts.size > 10_000) for (const [k, v] of attempts) if (now - v.at.at(-1) > 60_000) attempts.delete(k);
    const key = `${ctx.ip}|${ctx.path}`;
    const hits = (attempts.get(key)?.at ?? []).filter((t) => now - t < 60_000);
    if (hits.length >= rateLimit) { ctx.res.setHeader('Retry-After', '60'); fail(429, 'RATE_LIMITED', 'Слишком много попыток. Повторите через минуту'); }
    attempts.set(key, { at: [...hits, now] });
  }

  const issue = (user) => ({ token: signToken({ sub: user.id, v: user.token_version ?? 0 }, secret), user: { id: user.id, email: user.email } });

  /** Блокировка аккаунта после серии неудачных входов; считается и для несуществующих email (без перечисления). */
  function assertNotLocked(email, ctx) {
    const lock = locks.get(email);
    if (lock?.until > Date.now()) {
      ctx.res.setHeader('Retry-After', String(Math.ceil((lock.until - Date.now()) / 1000)));
      log('warn', 'вход заблокирован', { event: 'auth.locked', ip: ipTag(ctx.ip) });
      fail(429, 'ACCOUNT_LOCKED', 'Слишком много неудачных попыток. Вход заблокирован на 15 минут');
    }
  }
  function recordFailure(email, ctx) {
    const now = Date.now();
    metrics.authFailures++;
    if (locks.size > 10_000) for (const [k, v] of locks) if ((v.until ?? v.first + LOCK_MS) < now) locks.delete(k);
    const cur = locks.get(email);
    const fresh = !cur || now - cur.first > LOCK_MS;
    const entry = fresh ? { fails: 1, first: now } : { ...cur, fails: cur.fails + 1 };
    if (entry.fails >= LOCK_AFTER) entry.until = now + LOCK_MS;
    locks.set(email, entry);
    log('warn', 'неудачный вход', { event: 'auth.login_failed', ip: ipTag(ctx.ip), fails: entry.fails });
  }

  // ---------- OAuth2 ----------
  const redirectUri = (req, id) => `${publicBase || `http://${req.headers.host}`}/api/auth/oauth/${id}/callback`;
  const cookieAttrs = `HttpOnly; SameSite=Lax; Path=/api/auth/oauth${isHttps ? '; Secure' : ''}`;
  const signCookie = (data) => { const body = Buffer.from(JSON.stringify(data)).toString('base64url'); return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`; };
  function readCookie(req, provider) {
    const raw = new RegExp(`(?:^|;\\s*)${OAUTH_COOKIE}=([^;]*)`).exec(req.headers.cookie ?? '')?.[1];
    const [body, sig] = String(raw ?? '').split('.');
    if (!body || !sig || !safeEqual(sig, createHmac('sha256', secret).update(body).digest('base64url'))) return null;
    try {
      const data = JSON.parse(Buffer.from(body, 'base64url').toString());
      return data.p === provider && data.exp > Date.now() / 1000 ? data : null;
    } catch { return null; }
  }
  const redirect = (location, extra = {}) => ({ status: 302, headers: { Location: location, 'Set-Cookie': `${OAUTH_COOKIE}=; ${cookieAttrs}; Max-Age=0`, ...extra } });
  const oauthError = (code) => redirect(`/#oauth_error=${code}`);

  /** Находит или создаёт пользователя по профилю провайдера. Непроверенный email не принимаем вообще. */
  function resolveUser(provider, profile) {
    const known = q.identity.get(provider, profile.subject);
    if (known) return q.userById.get(known.user_id);
    let user = q.userByEmail.get(profile.email);
    if (user) {
      // Аккаунт с паролем мог быть заведён кем угодно на чужой email (регистрация не подтверждает почту).
      // Поэтому при привязке пароль отключается, а выданные токены отзываются: так захваченный заранее аккаунт не остаётся у злоумышленника.
      if (user.password_hash !== NO_PASSWORD) q.convertToOauth.run(NO_PASSWORD, user.id);
    } else {
      user = { id: randomUUID(), email: profile.email };
      q.addUser.run(user.id, user.email, NO_PASSWORD, new Date().toISOString());
    }
    q.addIdentity.run(provider, profile.subject, user.id, new Date().toISOString());
    return q.userById.get(user.id);
  }

  async function probe(p) {
    const hit = probes.get(p.id);
    if (hit && Date.now() - hit.at < 30_000) return hit.result;
    const t0 = performance.now();
    let result;
    try {
      const res = await fetch(p.authorizeUrl, { method: 'HEAD', signal: AbortSignal.timeout(2000), redirect: 'manual' });
      result = { status: res.status < 500 ? 'ok' : 'fail', httpStatus: res.status, ms: Math.round(performance.now() - t0) };
    } catch (e) { result = { status: 'fail', error: e.name === 'TimeoutError' ? 'timeout' : 'unreachable', ms: Math.round(performance.now() - t0) }; }
    probes.set(p.id, { at: Date.now(), result });
    return result;
  }

  /** Готовность: БД обязательна (иначе 503), внешние сервисы необязательны (деградация, но 200). */
  async function readiness() {
    const checks = {};
    const t0 = performance.now();
    try {
      const { n } = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get();
      checks.database = { status: 'ok', migrations: n, ms: Math.round(performance.now() - t0) };
    } catch {
      return { status: 'fail', checks: { database: { status: 'fail' } } };
    }
    for (const p of Object.values(providers)) checks[`oauth_${p.id}`] = await probe(p);
    const degraded = Object.values(checks).some((c) => c.status !== 'ok');
    return { status: degraded ? 'degraded' : 'ok', checks };
  }

  function metricsText() {
    const lines = ['# HELP freshkeep_requests_total HTTP-запросы по классам статуса', '# TYPE freshkeep_requests_total counter'];
    for (const [k, v] of Object.entries(metrics.requests)) lines.push(`freshkeep_requests_total{status="${k}"} ${v}`);
    lines.push('# TYPE freshkeep_request_duration_ms_sum counter', `freshkeep_request_duration_ms_sum ${Math.round(metrics.durationSum)}`,
      '# TYPE freshkeep_request_duration_ms_count counter', `freshkeep_request_duration_ms_count ${metrics.durationCount}`,
      '# TYPE freshkeep_auth_failures_total counter', `freshkeep_auth_failures_total ${metrics.authFailures}`,
      '# TYPE freshkeep_uptime_seconds gauge', `freshkeep_uptime_seconds ${Math.round((Date.now() - startedAt) / 1000)}`,
      '# TYPE freshkeep_process_resident_memory_bytes gauge', `freshkeep_process_resident_memory_bytes ${process.memoryUsage().rss}`);
    return `${lines.join('\n')}\n`;
  }

  const routes = [
    ['GET', /^\/api\/health$/, false, () => ({ status: 200, body: { status: 'ok', version, uptime: Math.round((Date.now() - startedAt) / 1000) } })],
    ['GET', /^\/api\/ready$/, false, async () => {
      const r = await readiness();
      return { status: r.status === 'fail' ? 503 : 200, body: { ...r, version } };
    }],
    ['GET', /^\/api\/metrics$/, false, (ctx) => {
      if (!metricsToken) fail(404, 'NOT_FOUND', 'Маршрут не найден');
      const m = /^Bearer (.+)$/.exec(ctx.req.headers.authorization ?? '');
      if (!m || !safeEqual(m[1], metricsToken)) fail(401, 'UNAUTHORIZED', 'Требуется токен метрик');
      return { status: 200, text: metricsText(), contentType: 'text/plain; version=0.0.4; charset=utf-8' };
    }],
    ['POST', /^\/api\/auth\/register$/, false, (ctx) => {
      limit(ctx);
      const { errors, email, password } = validateCredentials(ctx.body);
      if (Object.keys(errors).length) validation(errors);
      if (q.userByEmail.get(email)) fail(409, 'EMAIL_TAKEN', 'Этот email уже используется', { email: 'Этот email уже используется' });
      const user = { id: randomUUID(), email, token_version: 0 };
      q.addUser.run(user.id, email, hashPassword(password), new Date().toISOString());
      log('info', 'регистрация', { event: 'auth.register', method: 'password', userId: user.id });
      return { status: 201, body: issue(user) };
    }],
    ['POST', /^\/api\/auth\/login$/, false, (ctx) => {
      limit(ctx);
      const email = String(ctx.body.email ?? '').trim().toLowerCase().slice(0, 254);
      const password = isString(ctx.body.password) ? ctx.body.password.slice(0, 128) : '';
      assertNotLocked(email, ctx);
      const row = q.userByEmail.get(email);
      // Для неизвестного email проверяем пароль по заглушке: время ответа не выдаёт, зарегистрирован ли адрес
      const ok = verifyPassword(password, row?.password_hash ?? DUMMY_HASH) && Boolean(row);
      if (!ok) { recordFailure(email, ctx); fail(401, 'INVALID_CREDENTIALS', 'Неверный email или пароль'); }
      locks.delete(email);
      log('info', 'вход', { event: 'auth.login', method: 'password', userId: row.id });
      return { status: 200, body: issue(row) };
    }],
    ['POST', /^\/api\/auth\/logout$/, true, (ctx) => {
      q.bumpVersion.run(ctx.user.id); // отзывает все выданные токены пользователя
      log('info', 'выход', { event: 'auth.logout', userId: ctx.user.id });
      return { status: 204 };
    }],
    ['GET', /^\/api\/auth\/providers$/, false, () => ({ status: 200, body: { providers: Object.values(providers).map((p) => ({ id: p.id, label: p.label })) } })],
    ['GET', /^\/api\/auth\/oauth\/([a-z]+)\/start$/, false, (ctx, id) => {
      const p = providers[id];
      if (!p) fail(404, 'NOT_FOUND', 'Провайдер не найден');
      limit(ctx);
      const state = randomBytes(32).toString('base64url');
      const { verifier, challenge } = pkcePair();
      const cookie = signCookie({ p: id, s: state, v: verifier, exp: Math.floor(Date.now() / 1000) + OAUTH_COOKIE_TTL });
      return { status: 302, headers: { Location: buildAuthUrl(p, redirectUri(ctx.req, id), state, challenge), 'Set-Cookie': `${OAUTH_COOKIE}=${cookie}; ${cookieAttrs}; Max-Age=${OAUTH_COOKIE_TTL}` } };
    }],
    ['GET', /^\/api\/auth\/oauth\/([a-z]+)\/callback$/, false, async (ctx, id) => {
      const p = providers[id];
      if (!p) fail(404, 'NOT_FOUND', 'Провайдер не найден');
      limit(ctx);
      const params = new URL(ctx.req.url, 'http://x').searchParams;
      if (params.get('error')) return oauthError(params.get('error') === 'access_denied' ? 'denied' : 'failed');
      // state из адреса должен совпасть со значением в подписанной cookie, выданной именно этому браузеру (защита от CSRF и подмены)
      const saved = readCookie(ctx.req, id);
      if (!saved || !safeEqual(params.get('state') ?? '', saved.s)) return oauthError('state');
      const code = params.get('code') ?? '';
      if (!code || code.length > 2048) return oauthError('failed');
      let profile;
      try {
        const accessToken = await exchangeCode(p, redirectUri(ctx.req, id), code, saved.v);
        profile = await fetchProfile(p, accessToken);
      } catch (e) {
        log('error', 'ошибка провайдера OAuth', { event: 'oauth.provider_error', provider: id, error: e.message });
        return oauthError('failed');
      }
      if (!profile.subject) return oauthError('failed');
      if (!profile.email) return oauthError('no_email');
      if (!profile.emailVerified) return oauthError('unverified');
      const user = resolveUser(id, profile);
      const ticket = randomBytes(32).toString('base64url');
      const now = Date.now();
      for (const [k, v] of tickets) if (v.exp < now) tickets.delete(k);
      tickets.set(ticket, { userId: user.id, exp: now + TICKET_TTL_MS });
      log('info', 'вход', { event: 'auth.login', method: id, userId: user.id });
      // Токен в адрес не кладём: только одноразовый тикет во фрагменте (он не уходит на сервер и в Referer)
      return redirect(`/#oauth_ticket=${ticket}`);
    }],
    ['POST', /^\/api\/auth\/oauth\/exchange$/, false, (ctx) => {
      limit(ctx);
      const ticket = isString(ctx.body.ticket) ? ctx.body.ticket : '';
      const entry = tickets.get(ticket);
      tickets.delete(ticket); // одноразовый
      const user = entry && entry.exp > Date.now() ? q.userById.get(entry.userId) : null;
      if (!user) fail(401, 'INVALID_TICKET', 'Ссылка для входа устарела. Попробуйте войти ещё раз');
      return { status: 200, body: issue(user) };
    }],
    ['GET', /^\/api\/me$/, true, (ctx) => ({ status: 200, body: { id: ctx.user.id, email: ctx.user.email } })],
    ['GET', /^\/api\/products$/, true, (ctx) => ({ status: 200, body: q.products.all(ctx.user.id).map(toProduct) })],
    ['POST', /^\/api\/products$/, true, (ctx) => {
      const v = validateProduct(ctx.body, new Date());
      if (!v.ok) validation(v.errors);
      if (q.countProducts.get(ctx.user.id).n >= MAX_PRODUCTS) fail(422, 'LIMIT_REACHED', `Достигнут лимит: не больше ${MAX_PRODUCTS} продуктов`);
      const id = randomUUID(); const now = new Date().toISOString(); const p = v.value;
      q.addProduct.run(id, ctx.user.id, p.name, p.quantity, p.unit, p.storage, p.expiresAt, now, now);
      return { status: 201, body: toProduct(q.product.get(id)) };
    }],
    ['PATCH', /^\/api\/products\/([\w-]+)$/, true, (ctx, id) => {
      const row = owned(q.product.get(id), ctx);
      const merged = { ...toProduct(row), ...ctx.body };
      const v = validateProduct(merged, new Date());
      if (!v.ok) validation(v.errors);
      const p = v.value;
      q.updProduct.run(p.name, p.quantity, p.unit, p.storage, p.expiresAt, new Date().toISOString(), id);
      return { status: 200, body: toProduct(q.product.get(id)) };
    }],
    ['POST', /^\/api\/products\/([\w-]+)\/consume$/, true, (ctx, id) => {
      const row = owned(q.product.get(id), ctx);
      const r = consumeProduct(row, ctx.body.amount, ctx.body.unit ?? row.unit);
      if (!r.ok) validation({ amount: r.error });
      if (r.finished) { q.delProduct.run(id); return { status: 200, body: { finished: true, product: null } }; }
      q.updProduct.run(row.name, r.remaining, row.unit, row.storage, row.expires_at, new Date().toISOString(), id);
      return { status: 200, body: { finished: false, product: toProduct(q.product.get(id)) } };
    }],
    ['DELETE', /^\/api\/products\/([\w-]+)$/, true, (ctx, id) => { owned(q.product.get(id), ctx); q.delProduct.run(id); return { status: 204 }; }],
    ['GET', /^\/api\/shopping$/, true, (ctx) => ({ status: 200, body: q.items.all(ctx.user.id).map(toItem) })],
    ['POST', /^\/api\/shopping$/, true, (ctx) => {
      if (!isString(ctx.body.name)) validation({ name: 'Название должно быть строкой' });
      const name = ctx.body.name.trim().replace(/\s+/g, ' ');
      if (!name) validation({ name: 'Введите название' });
      if (name.length > 100) validation({ name: 'Не длиннее 100 символов' });
      if (q.countItems.get(ctx.user.id).n >= MAX_SHOPPING) fail(422, 'LIMIT_REACHED', `Достигнут лимит: не больше ${MAX_SHOPPING} позиций`);
      try {
        const id = randomUUID();
        q.addItem.run(id, ctx.user.id, name, nameKey(name), new Date().toISOString());
        return { status: 201, body: toItem(q.item.get(id)) };
      } catch (e) {
        if (/UNIQUE/.test(e.message)) fail(409, 'DUPLICATE', 'Уже в списке');
        throw e;
      }
    }],
    ['PATCH', /^\/api\/shopping\/([\w-]+)$/, true, (ctx, id) => {
      owned(q.item.get(id), ctx);
      if (typeof ctx.body.isBought !== 'boolean') validation({ isBought: 'Ожидается true или false' });
      q.updItem.run(ctx.body.isBought ? 1 : 0, id);
      return { status: 200, body: toItem(q.item.get(id)) };
    }],
    ['DELETE', /^\/api\/shopping\/([\w-]+)$/, true, (ctx, id) => { owned(q.item.get(id), ctx); q.delItem.run(id); return { status: 204 }; }],
  ];

  // ---------- Заголовки безопасности, CORS, CSRF ----------
  /** Политика для страниц: только свои скрипты и стили, без inline. Домен Метрики открывается только при заданном счётчике. */
  const ym = metrika ? ' https://mc.yandex.ru' : '';
  const PAGE_CSP = `default-src 'self'; script-src 'self'${ym}; style-src 'self'; img-src 'self' data:${ym}; connect-src 'self'${ym}; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;
  const API_CSP = "default-src 'none'; frame-ancestors 'none'";

  function securityHeaders(res, page) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', page ? PAGE_CSP : API_CSP);
    res.setHeader('Cache-Control', page ? 'no-cache' : 'no-store');
    if (isHttps) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  function cors(req, res) {
    const reqOrigin = req.headers.origin;
    if (allowedOrigins.includes('*')) res.setHeader('Access-Control-Allow-Origin', '*');
    else if (reqOrigin && allowedOrigins.includes(reqOrigin)) { res.setHeader('Access-Control-Allow-Origin', reqOrigin); res.setHeader('Vary', 'Origin'); }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
  }

  /** Защита от CSRF: изменяющий запрос браузера с чужого Origin отклоняется (токен и так в заголовке, а не в cookie, это второй рубеж). */
  function checkOrigin(req) {
    if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) return;
    const o = req.headers.origin;
    if (!o || allowedOrigins.includes('*')) return;
    let host = '';
    try { host = new URL(o).host; } catch { /* Origin: null и подобное */ }
    if (host && host === req.headers.host) return;
    if (allowedOrigins.includes(o)) return;
    fail(403, 'BAD_ORIGIN', 'Запрос с недопустимого источника');
  }

  async function readJson(req) {
    let size = 0; const chunks = [];
    for await (const c of req) { size += c.length; if (size > MAX_BODY) fail(413, 'PAYLOAD_TOO_LARGE', 'Слишком большой запрос'); chunks.push(c); }
    if (!chunks.length) return {};
    try { const v = JSON.parse(Buffer.concat(chunks).toString()); return v && typeof v === 'object' && !Array.isArray(v) ? v : fail(400, 'INVALID_JSON', 'Ожидается JSON-объект'); }
    catch (e) { if (e instanceof HttpError) throw e; return fail(400, 'INVALID_JSON', 'Некорректный JSON'); }
  }

  /** Отправка тела с gzip для больших ответов, если клиент его принимает. */
  function send(req, res, status, body, type, extra = {}) {
    let data = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const headers = { 'Content-Type': type, Vary: 'Accept-Encoding', ...extra };
    if (data.length >= GZIP_MIN && COMPRESSIBLE.test(type) && /\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) {
      data = gzipSync(data); headers['Content-Encoding'] = 'gzip';
    }
    headers['Content-Length'] = data.length;
    res.writeHead(status, headers).end(data);
  }

  const configJs = () => `globalThis.FRESHKEEP_API_URL = '';\nglobalThis.FRESHKEEP_METRIKA_ID = ${JSON.stringify(metrika)};\n`;

  async function serveStatic(req, res, path) {
    if (!staticDir) fail(404, 'NOT_FOUND', 'Не найдено');
    securityHeaders(res, true);
    if (path === '/config.js') { // настройки фронтенда формируются из переменных окружения
      res.setHeader('Cache-Control', 'no-store');
      return send(req, res, 200, configJs(), TYPES['.js']);
    }
    let rel;
    try { rel = decodeURIComponent(path === '/' ? '/index.html' : path); } catch { fail(400, 'BAD_REQUEST', 'Некорректный адрес'); }
    if (rel.includes('\0')) fail(400, 'BAD_REQUEST', 'Некорректный адрес');
    const root = normalize(staticDir);
    const file = normalize(join(root, rel));
    // Сравниваем с префиксом вместе с разделителем: иначе каталог «web2» рядом с «web» проходил бы проверку
    if (!file.startsWith(root + sep)) fail(403, 'FORBIDDEN', 'Доступ запрещён');
    if (relative(root, file).split(sep).some((part) => part === 'test' || part.startsWith('.'))) fail(403, 'FORBIDDEN', 'Доступ запрещён');
    let info;
    try { info = await stat(file); } catch { fail(404, 'NOT_FOUND', 'Не найдено'); }
    if (!info.isFile()) fail(404, 'NOT_FOUND', 'Не найдено');
    let entry = fileCache.get(file);
    if (!entry || entry.mtime !== info.mtimeMs || entry.size !== info.size) {
      const data = await readFile(file);
      entry = { mtime: info.mtimeMs, size: info.size, data, etag: `W/"${info.size.toString(16)}-${Math.round(info.mtimeMs).toString(16)}"` };
      fileCache.set(file, entry);
    }
    if (req.headers['if-none-match'] === entry.etag) { res.writeHead(304, { ETag: entry.etag, Vary: 'Accept-Encoding' }).end(); return; }
    send(req, res, 200, entry.data, TYPES[extname(file)] ?? 'application/octet-stream', { ETag: entry.etag });
  }

  const server = createServer(async (req, res) => {
    const t0 = performance.now();
    const ctx = { req, res, reqId: randomUUID().slice(0, 8), ip: clientIp(req), user: null, path: '', body: {} };
    try {
      res.setHeader('X-Request-Id', ctx.reqId);
      ctx.path = new URL(req.url, 'http://x').pathname;
      const isApi = ctx.path.startsWith('/api/');
      securityHeaders(res, false);
      if (isApi) cors(req, res);
      if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
      if (!isApi) {
        if (!['GET', 'HEAD'].includes(req.method)) fail(405, 'METHOD_NOT_ALLOWED', 'Метод не поддерживается');
        return await serveStatic(req, res, ctx.path);
      }
      checkOrigin(req);
      const method = req.method === 'HEAD' ? 'GET' : req.method;
      const matches = routes.filter(([, re]) => re.test(ctx.path));
      if (!matches.length) fail(404, 'NOT_FOUND', 'Маршрут не найден');
      const route = matches.find(([m]) => m === method);
      if (!route) fail(405, 'METHOD_NOT_ALLOWED', 'Метод не поддерживается');
      const [, re, needsAuth, handler] = route;
      if (needsAuth) {
        const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
        const payload = m && verifyToken(m[1], secret);
        const user = payload && q.userById.get(payload.sub);
        // Версия токена должна совпадать с текущей: после выхода или смены способа входа старые токены не действуют
        if (!user || payload.v !== user.token_version) fail(401, 'UNAUTHORIZED', 'Требуется вход');
        ctx.user = user;
      }
      if (['POST', 'PATCH'].includes(method)) ctx.body = await readJson(req);
      const out = await handler(ctx, ...re.exec(ctx.path).slice(1));
      if (out.headers) for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
      if (out.text !== undefined) return send(req, res, out.status, out.text, out.contentType);
      if (out.body === undefined) { res.writeHead(out.status).end(); return; }
      send(req, res, out.status, JSON.stringify(out.body), 'application/json; charset=utf-8');
    } catch (e) {
      const known = e instanceof HttpError;
      if (!known) log('error', 'unhandled', { event: 'http.unhandled', reqId: ctx.reqId, error: e.message, stack: e.stack });
      const body = { error: known ? { code: e.code, message: e.message, ...(e.fields && { fields: e.fields }) } : { code: 'INTERNAL', message: 'Внутренняя ошибка сервера. Попробуйте позже' } };
      if (!res.headersSent) { res.removeHeader('Content-Encoding'); res.writeHead(known ? e.status : 500, { 'Content-Type': 'application/json; charset=utf-8' }); }
      res.end(JSON.stringify(body));
    } finally {
      const status = res.statusCode;
      const ms = performance.now() - t0;
      metrics.requests[`${Math.floor(status / 100)}xx`] = (metrics.requests[`${Math.floor(status / 100)}xx`] ?? 0) + 1;
      metrics.durationSum += ms; metrics.durationCount++;
      log(status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info', 'request', { event: 'http.request', reqId: ctx.reqId, method: req.method, path: ctx.path, status, ms: Math.round(ms), ip: ipTag(ctx.ip), userId: ctx.user?.id });
    }
  });
  // Защита от медленных соединений (slowloris): заголовки и тело должны прийти быстро
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  return server;
}
