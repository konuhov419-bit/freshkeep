import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { call, listen, make, raw, register } from './helpers.js';

/** Поддельный провайдер OAuth2: проверяет client_id/secret, redirect_uri и PKCE так же строго, как настоящий. */
const codes = new Map(); // code -> { profile, challenge, redirectUri }
const seen = { tokenCalls: [] };
let fake; let fakeBase;
before(async () => {
  fake = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'HEAD') { res.writeHead(200).end(); return; }
    if (url.pathname === '/token') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const f = Object.fromEntries(new URLSearchParams(body));
        seen.tokenCalls.push(f);
        const entry = codes.get(f.code);
        const pkceOk = entry && createHash('sha256').update(f.code_verifier ?? '').digest('base64url') === entry.challenge;
        const ok = entry && f.client_id === 'cid' && f.client_secret === 'csecret' && f.redirect_uri === entry.redirectUri && f.grant_type === 'authorization_code' && pkceOk;
        if (entry?.tokenFails) { res.writeHead(500).end('{}'); return; }
        res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' }).end(JSON.stringify(ok ? { access_token: `at-${f.code}` } : { error: 'invalid_grant' }));
        if (ok) codes.delete(f.code);
      });
      return;
    }
    if (url.pathname === '/userinfo') {
      const code = /^Bearer at-(.+)$/.exec(req.headers.authorization ?? '')?.[1];
      const entry = code && codes.get(`used:${code}`);
      res.writeHead(entry ? 200 : 401, { 'Content-Type': 'application/json' }).end(JSON.stringify(entry ?? {}));
      return;
    }
    res.writeHead(404).end();
  });
  fakeBase = await listen(fake);
  // после обмена кода профиль доступен по access_token: переносим запись под «used:»
  const origDelete = codes.delete.bind(codes);
  codes.delete = (k) => { const e = codes.get(k); if (e) codes.set(`used:${k}`, e.profile); return origDelete(k); };
});
after(() => fake.close());

const cfg = () => ({ google: { clientId: 'cid', clientSecret: 'csecret', def: { authorizeUrl: `${fakeBase}/authorize`, tokenUrl: `${fakeBase}/token`, userInfoUrl: `${fakeBase}/userinfo` } } });
const servers = [];
async function app(extra = {}) {
  const logs = [];
  const s = make({ oauth: cfg(), publicUrl: '', log: (...a) => logs.push(a), ...extra });
  servers.push(s);
  return { base: await listen(s), logs };
}
after(() => servers.forEach((s) => s.close()));

const cookieOf = (res) => /fk_oauth=([^;]*)/.exec(res.headers['set-cookie'] ?? '')?.[1];
const hashOf = (res) => new URLSearchParams(new URL(res.headers.location, 'http://x').hash.slice(1));

/** Проходит «start» как браузер, возвращает параметры authorize-запроса и cookie. */
async function start(base) {
  const r = await raw(base, 'GET', '/api/auth/oauth/google/start');
  const loc = new URL(r.headers.location);
  return { r, loc, cookie: cookieOf(r), state: loc.searchParams.get('state'), challenge: loc.searchParams.get('code_challenge'), redirectUri: loc.searchParams.get('redirect_uri') };
}
const callback = (base, { code, state, cookie, error }) => raw(base, 'GET', `/api/auth/oauth/google/callback?${error ? `error=${error}&` : ''}${code ? `code=${code}&` : ''}${state ? `state=${state}` : ''}`, { headers: cookie ? { Cookie: `fk_oauth=${cookie}` } : {} });
let n = 0;
const profile = (over = {}) => ({ sub: `sub-${++n}`, email: `user${n}@example.com`, email_verified: true, name: 'Анна', ...over });
function grant(s, p, extra = {}) { const code = `code-${++n}`; codes.set(code, { profile: p, challenge: s.challenge, redirectUri: s.redirectUri, ...extra }); return code; }

test('список провайдеров: только настроенные (нужны Client ID и Secret)', async () => {
  const { base } = await app({ oauth: { ...cfg(), yandex: { clientId: 'only-id' } } });
  assert.deepEqual((await call(base, 'GET', '/api/auth/providers')).json.providers, [{ id: 'google', label: 'Google' }]);
  assert.deepEqual((await call((await app({ oauth: {} })).base, 'GET', '/api/auth/providers')).json.providers, []);
});

test('start: редирект на провайдера со state и PKCE (S256), cookie HttpOnly + SameSite=Lax', async () => {
  const { base } = await app();
  const s = await start(base);
  assert.equal(s.r.status, 302);
  assert.equal(s.loc.origin + s.loc.pathname, `${fakeBase}/authorize`);
  for (const [k, v] of [['response_type', 'code'], ['client_id', 'cid'], ['code_challenge_method', 'S256'], ['scope', 'openid email profile']]) assert.equal(s.loc.searchParams.get(k), v);
  assert.ok(s.state.length >= 30 && s.challenge.length >= 40);
  assert.match(s.redirectUri, /\/api\/auth\/oauth\/google\/callback$/);
  assert.match(s.r.headers['set-cookie'], /HttpOnly/);
  assert.match(s.r.headers['set-cookie'], /SameSite=Lax/);
  assert.ok(!s.r.headers['set-cookie'].includes('Secure')); // http: Secure ставится только для https
  const second = await start(base);
  assert.notEqual(second.state, s.state);
});

test('успешный вход: тикет -> токен -> /api/me; тикет одноразовый; повторный вход не создаёт дубликат', async () => {
  const { base, logs } = await app();
  const p = profile();
  const s = await start(base);
  const done = await callback(base, { code: grant(s, p), state: s.state, cookie: s.cookie });
  assert.equal(done.status, 302);
  assert.match(done.headers['set-cookie'], /Max-Age=0/); // cookie очищается
  const ticket = hashOf(done).get('oauth_ticket');
  assert.ok(ticket && !done.headers.location.includes('access_token'));
  const ex = await call(base, 'POST', '/api/auth/oauth/exchange', { body: { ticket } });
  assert.equal(ex.status, 200);
  const me = await call(base, 'GET', '/api/me', { token: ex.json.token });
  assert.equal(me.json.email, p.email);
  assert.equal((await call(base, 'POST', '/api/auth/oauth/exchange', { body: { ticket } })).status, 401);
  // тот же аккаунт Google второй раз -> тот же пользователь
  const s2 = await start(base);
  const again = await callback(base, { code: grant(s2, p), state: s2.state, cookie: s2.cookie });
  const ex2 = await call(base, 'POST', '/api/auth/oauth/exchange', { body: { ticket: hashOf(again).get('oauth_ticket') } });
  assert.equal((await call(base, 'GET', '/api/me', { token: ex2.json.token })).json.id, me.json.id);
  // PKCE: провайдер получил verifier, соответствующий challenge; секреты не попали в логи
  assert.ok(seen.tokenCalls.at(-1).code_verifier.length >= 40);
  assert.ok(!JSON.stringify(logs).includes('csecret') && !JSON.stringify(logs).includes(ticket));
  assert.ok(logs.some(([, , x]) => x.event === 'auth.login' && x.method === 'google'));
});

test('ошибки: отказ пользователя, неверный state, нет cookie, чужой провайдер, нет code', async () => {
  const { base } = await app();
  const s = await start(base);
  assert.equal(hashOf(await callback(base, { error: 'access_denied', state: s.state, cookie: s.cookie })).get('oauth_error'), 'denied');
  assert.equal(hashOf(await callback(base, { error: 'server_error' })).get('oauth_error'), 'failed');
  assert.equal(hashOf(await callback(base, { code: grant(s, profile()), state: 'forged-state', cookie: s.cookie })).get('oauth_error'), 'state');
  assert.equal(hashOf(await callback(base, { code: grant(s, profile()), state: s.state })).get('oauth_error'), 'state'); // нет cookie: CSRF/подмена
  const c2 = await start(base);
  assert.equal(hashOf(await callback(base, { state: c2.state, cookie: c2.cookie })).get('oauth_error'), 'failed'); // нет code
  assert.equal((await raw(base, 'GET', '/api/auth/oauth/github/start')).status, 404);
  assert.equal((await raw(base, 'GET', '/api/auth/oauth/github/callback?code=1&state=2')).status, 404);
});

test('ошибки провайдера: токен не выдан (400/500), нет email, поддельный code', async () => {
  const { base, logs } = await app();
  const s1 = await start(base);
  assert.equal(hashOf(await callback(base, { code: 'unknown-code', state: s1.state, cookie: s1.cookie })).get('oauth_error'), 'failed');
  const s2 = await start(base);
  assert.equal(hashOf(await callback(base, { code: grant(s2, profile(), { tokenFails: true }), state: s2.state, cookie: s2.cookie })).get('oauth_error'), 'failed');
  const s3 = await start(base);
  assert.equal(hashOf(await callback(base, { code: grant(s3, profile({ email: undefined })), state: s3.state, cookie: s3.cookie })).get('oauth_error'), 'no_email');
  assert.ok(logs.filter(([lvl, , x]) => lvl === 'error' && x.event === 'oauth.provider_error').length >= 2);
});

test('привязка к существующему аккаунту: по подтверждённому email — да, по неподтверждённому — нет', async () => {
  const { base } = await app();
  const t = await register(base, 'linked@example.com');
  const myId = (await call(base, 'GET', '/api/me', { token: t })).json.id;
  const s = await start(base);
  const ok = await callback(base, { code: grant(s, profile({ email: 'linked@example.com' })), state: s.state, cookie: s.cookie });
  const ex = await call(base, 'POST', '/api/auth/oauth/exchange', { body: { ticket: hashOf(ok).get('oauth_ticket') } });
  assert.equal((await call(base, 'GET', '/api/me', { token: ex.json.token })).json.id, myId);
  await register(base, 'victim@example.com');
  const s2 = await start(base);
  const bad = await callback(base, { code: grant(s2, profile({ email: 'victim@example.com', email_verified: false })), state: s2.state, cookie: s2.cookie });
  assert.equal(hashOf(bad).get('oauth_error'), 'unverified');
});

test('аккаунт, созданный через OAuth, не имеет пароля: вход по паролю невозможен', async () => {
  const { base } = await app();
  const p = profile({ email: 'oauth-only@example.com' });
  const s = await start(base);
  await callback(base, { code: grant(s, p), state: s.state, cookie: s.cookie });
  for (const password of ['oauth$', '', 'password1']) assert.equal((await call(base, 'POST', '/api/auth/login', { body: { email: p.email, password } })).status, 401);
});

test('cookie получает Secure при https, редирект_uri берётся из PUBLIC_URL', async () => {
  const { base } = await app({ publicUrl: 'https://app.example.com' });
  const r = await raw(base, 'GET', '/api/auth/oauth/google/start');
  assert.match(r.headers['set-cookie'], /Secure/);
  assert.equal(new URL(r.headers.location).searchParams.get('redirect_uri'), 'https://app.example.com/api/auth/oauth/google/callback');
});

test('предзахват аккаунта: при привязке OAuth пароль отключается, выданные ранее токены отзываются', async () => {
  const { base } = await app();
  const email = 'prehijack@example.com';
  // Злоумышленник заранее регистрирует чужой email со своим паролем (регистрация почту не подтверждает)
  const attackerToken = await register(base, email, 'attacker-pass1');
  // Настоящий владелец почты входит через провайдера и привязывается к этому аккаунту
  const s = await start(base);
  const done = await callback(base, { code: grant(s, profile({ email })), state: s.state, cookie: s.cookie });
  const ex = await call(base, 'POST', '/api/auth/oauth/exchange', { body: { ticket: hashOf(done).get('oauth_ticket') } });
  assert.equal((await call(base, 'GET', '/api/me', { token: ex.json.token })).status, 200);
  assert.equal((await call(base, 'GET', '/api/me', { token: attackerToken })).status, 401); // сессия злоумышленника отозвана
  assert.equal((await call(base, 'POST', '/api/auth/login', { body: { email, password: 'attacker-pass1' } })).status, 401); // пароль больше не работает
});
