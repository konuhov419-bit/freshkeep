#!/usr/bin/env node
// Локальная демонстрация OAuth2 без реальных ключей: приложение + поддельный провайдер «Google» (порт 5199).
// Провайдер проверяет client_id, client_secret, redirect_uri и PKCE так же строго, как настоящий.
//   npm run dev:oauth   ->   http://localhost:5173   (данные в памяти, сбрасываются при остановке)
// Только для разработки: в продакшене используйте реальные Client ID и Secret (см. docs в integration_documentation.md).
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { createLogger } from '../server/log.js';

const APP_PORT = Number(process.env.PORT ?? 5173);
const FAKE_PORT = Number(process.env.MOCK_PORT ?? 5199);
const APP = `http://localhost:${APP_PORT}`;
const FAKE = `http://localhost:${FAKE_PORT}`;
const codes = new Map(); // code -> { challenge, redirectUri }
const tokens = new Set();

const page = (body) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mock Google</title>
<body style="font-family:system-ui;max-width:420px;margin:48px auto;padding:0 16px"><h2>Mock Google</h2>${body}`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const provider = createServer((req, res) => {
  const url = new URL(req.url, FAKE);
  if (url.pathname === '/authorize') {
    const q = Object.fromEntries(url.searchParams);
    // Как у настоящего провайдера: redirect_uri должен быть заранее зарегистрирован (иначе открытый редирект)
    if (q.client_id !== 'mock-id' || !String(q.redirect_uri).startsWith(`${APP}/api/auth/oauth/`)) { res.writeHead(400).end(page('<p>Ошибка: неверный client_id или redirect_uri</p>')); return; }
    const code = randomBytes(16).toString('hex');
    codes.set(code, { challenge: q.code_challenge, redirectUri: q.redirect_uri });
    const back = (extra) => `${q.redirect_uri}?${new URLSearchParams({ ...extra, state: q.state })}`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page(`<p>Приложение <b>FreshKeep</b> запрашивает доступ к email и профилю.</p>
      <p><a id="allow" href="${esc(back({ code }))}">Разрешить (demo.user@example.com)</a></p>
      <p><a id="deny" href="${esc(back({ error: 'access_denied' }))}">Отклонить</a></p>`));
    return;
  }
  if (url.pathname === '/token' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const f = Object.fromEntries(new URLSearchParams(body));
      const entry = codes.get(f.code);
      const ok = entry && f.client_id === 'mock-id' && f.client_secret === 'mock-secret' && f.redirect_uri === entry.redirectUri
        && createHash('sha256').update(f.code_verifier ?? '').digest('base64url') === entry.challenge;
      codes.delete(f.code);
      const token = ok ? randomBytes(16).toString('hex') : '';
      if (ok) tokens.add(token);
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' }).end(JSON.stringify(ok ? { access_token: token } : { error: 'invalid_grant' }));
    });
    return;
  }
  if (url.pathname === '/userinfo') {
    const ok = tokens.has(/^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]);
    res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' }).end(JSON.stringify(ok ? { sub: 'mock-1', email: 'demo.user@example.com', email_verified: true, name: 'Demo User' } : {}));
    return;
  }
  res.writeHead(req.method === 'HEAD' ? 200 : 404).end();
});

const app = createApp({
  db: openDb(':memory:'),
  secret: randomBytes(32).toString('hex'),
  publicUrl: APP,
  metrikaId: process.env.METRIKA_ID ?? '',
  log: createLogger({}),
  staticDir: fileURLToPath(new URL('../web', import.meta.url)),
  oauth: { google: { clientId: 'mock-id', clientSecret: 'mock-secret', def: { authorizeUrl: `${FAKE}/authorize`, tokenUrl: `${FAKE}/token`, userInfoUrl: `${FAKE}/userinfo` } } },
});
provider.listen(FAKE_PORT, () => app.listen(APP_PORT, () => console.log(`Приложение: ${APP}\nПоддельный Google: ${FAKE}\nНажмите «Войти через Google» на экране входа.`)));
