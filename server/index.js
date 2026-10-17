// Точка входа: npm start -> http://localhost:5173 (API + фронтенд)
import { normalizePublicUrl } from './config.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { openDb } from './db.js';
import { createLogger } from './log.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENV_FILE = `${ROOT}.env`;

// Первый запуск: создаём .env со случайным секретом (файл в .gitignore, в репозиторий не попадает)
if (!existsSync(ENV_FILE) && !process.env.JWT_SECRET) {
  writeFileSync(ENV_FILE, `PORT=5173\nJWT_SECRET=${randomBytes(48).toString('base64url')}\nDB_PATH=data/freshkeep.db\nLOG_FILE=logs/api.log\n`, { mode: 0o600 });
  console.log('Создан .env со случайным JWT_SECRET');
}
try { process.loadEnvFile(ENV_FILE); } catch { /* .env нет: значения берутся из окружения (хостинг, Docker) */ }

const env = process.env;
if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) {
  console.error('JWT_SECRET не задан или короче 32 символов. См. .env.example');
  process.exit(1);
}
let publicUrl;
try { publicUrl = normalizePublicUrl(env.PUBLIC_URL); } catch (e) {
  console.error(e.message);
  process.exit(1);
}
const abs = (p) => (p.startsWith('/') ? p : `${ROOT}${p}`);
const pkgVersion = JSON.parse(readFileSync(`${ROOT}package.json`, 'utf8')).version;
const commit = (env.RAILWAY_GIT_COMMIT_SHA || env.GITHUB_SHA || env.GIT_SHA || '').slice(0, 7);
const version = commit ? `${pkgVersion}+${commit}` : pkgVersion;

const log = createLogger({
  file: env.LOG_FILE === '-' ? '' : abs(env.LOG_FILE ?? 'logs/api.log'), // LOG_FILE=- : только stdout (удобно для хостингов)
  level: env.LOG_LEVEL ?? 'info',
  base: { service: 'freshkeep', version },
});

const oauth = {
  google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
  yandex: { clientId: env.YANDEX_CLIENT_ID, clientSecret: env.YANDEX_CLIENT_SECRET },
};
const enabled = Object.entries(oauth).filter(([, c]) => c.clientId && c.clientSecret).map(([id]) => id);
if (enabled.length && !publicUrl) log('warn', 'PUBLIC_URL не задан: redirect_uri OAuth строится из заголовка Host. Задайте PUBLIC_URL в продакшене', { event: 'config.warning' });

const server = createApp({
  db: openDb(abs(env.DB_PATH ?? 'data/freshkeep.db')),
  secret: env.JWT_SECRET,
  origin: env.ALLOWED_ORIGIN ?? '',
  publicUrl,
  trustProxy: env.TRUST_PROXY === '1',
  metrikaId: env.METRIKA_ID ?? '',
  metricsToken: env.METRICS_TOKEN ?? '',
  version,
  oauth,
  log,
  staticDir: `${ROOT}web`,
});
const port = Number(env.PORT ?? 5173);
server.listen(port, () => log('info', 'сервер запущен', { event: 'server.started', url: `http://localhost:${port}`, oauth: enabled, analytics: Boolean(env.METRIKA_ID) }));

// Корректное завершение: перестаём принимать соединения и выходим (хостинг шлёт SIGTERM при деплое)
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
