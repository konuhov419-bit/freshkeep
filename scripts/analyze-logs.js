#!/usr/bin/env node
// Анализ JSON-логов приложения: ошибки, медленные маршруты, подозрительная активность.
//   node scripts/analyze-logs.js logs/api.log            — отчёт для человека
//   node scripts/analyze-logs.js logs/api.log --json     — тот же отчёт в JSON (для скриптов и промптов к AI)
//   cat logs/api.log | node scripts/analyze-logs.js -    — чтение из stdin
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SLOW_MS = 500;
const BRUTE_FORCE_AT = 5;
const pct = (arr, p) => [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))] ?? 0;
/** Идентификаторы в пути заменяются на :id, чтобы /api/products/1 и /api/products/2 считались одним маршрутом. */
export const normalizePath = (p = '') => p.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ':id').replace(/\/\d+(?=\/|$)/g, '/:id');

/**
 * @param {string[]} lines строки журнала (JSON на строку); нераспознанные строки считаются повреждёнными
 * @returns {{summary: object, findings: {severity: 'high'|'medium'|'low', title: string, details: string, advice: string}[]}}
 */
export function analyze(lines) {
  const events = []; let broken = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { broken++; }
  }
  const requests = events.filter((e) => e.event === 'http.request');
  const byLevel = {}; const byStatus = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
  for (const e of events) byLevel[e.level] = (byLevel[e.level] ?? 0) + 1;
  const routes = new Map();
  for (const r of requests) {
    byStatus[`${Math.floor(r.status / 100)}xx`] = (byStatus[`${Math.floor(r.status / 100)}xx`] ?? 0) + 1;
    const key = `${r.method} ${normalizePath(r.path)}`;
    const cur = routes.get(key) ?? { route: key, count: 0, ms: [], errors5xx: 0, errors4xx: 0 };
    cur.count++; cur.ms.push(r.ms ?? 0);
    if (r.status >= 500) cur.errors5xx++; else if (r.status >= 400) cur.errors4xx++;
    routes.set(key, cur);
  }
  const routeStats = [...routes.values()].map((r) => ({ route: r.route, count: r.count, p50: pct(r.ms, 0.5), p95: pct(r.ms, 0.95), errors5xx: r.errors5xx, errors4xx: r.errors4xx }));
  const times = [];
  const failsByIp = new Map(); const oauthErrors = new Map(); const unhandled = new Map();
  for (const e of events) {
    if (e.event === 'auth.login_failed') failsByIp.set(e.ip ?? '?', (failsByIp.get(e.ip ?? '?') ?? 0) + 1);
    if (e.event === 'oauth.provider_error') oauthErrors.set(e.provider ?? '?', (oauthErrors.get(e.provider ?? '?') ?? 0) + 1);
    if (e.event === 'http.unhandled') unhandled.set(String(e.error).slice(0, 120), (unhandled.get(String(e.error).slice(0, 120)) ?? 0) + 1);
    if (e.ts) times.push(Date.parse(e.ts));
  }
  const locked = events.filter((e) => e.event === 'auth.locked').length;
  const total = requests.length;
  const rate5xx = total ? byStatus['5xx'] / total : 0;

  const findings = [];
  const add = (severity, title, details, advice) => findings.push({ severity, title, details, advice });
  for (const [msg, n] of unhandled) add('high', 'Необработанные ошибки сервера', `${n} × «${msg}»`, 'Найдите событие http.unhandled по reqId в журнале (там stack), воспроизведите запросом и добавьте проверку входных данных или обработку ошибки.');
  if (total >= 20 && rate5xx > 0.02) add('high', 'Высокая доля 5xx', `${(rate5xx * 100).toFixed(1)}% запросов (${byStatus['5xx']} из ${total})`, 'Проверьте /api/ready (БД, диск) и свежие развёртывания: ошибки могли начаться после выкладки.');
  for (const [ip, n] of failsByIp) if (n >= BRUTE_FORCE_AT) add('medium', 'Возможный подбор пароля', `клиент ${ip}: ${n} неудачных входов`, 'Блокировка аккаунта и лимит запросов включены. При повторении ограничьте адрес на уровне прокси или включите CAPTCHA.');
  if (locked) add('medium', 'Срабатывали блокировки входа', `${locked} отклонённых попыток во время блокировки`, 'Убедитесь, что это не легитимные пользователи (повторяющиеся обращения) и не распределённый подбор.');
  for (const [provider, n] of oauthErrors) add('medium', `Сбои провайдера OAuth: ${provider}`, `${n} ошибок обмена кода или запроса профиля`, 'Проверьте Client ID и Secret, совпадение redirect_uri в консоли провайдера и доступность провайдера из /api/ready.');
  for (const r of routeStats) if (r.count >= 5 && r.p95 > SLOW_MS) add('low', 'Медленный маршрут', `${r.route}: p95 ${r.p95} мс при ${r.count} запросах`, 'Проверьте индексы БД и объём ответа; включите сжатие и пагинацию.');
  const notFound = new Map();
  for (const r of requests) if (r.status === 404) notFound.set(normalizePath(r.path), (notFound.get(normalizePath(r.path)) ?? 0) + 1);
  for (const [path, n] of notFound) if (n >= 10) add('low', 'Много 404 на одном адресе', `${path}: ${n} раз`, 'Это либо битая ссылка во фронтенде, либо сканирование адресов; сверьте с реферером и частотой.');
  if (broken) add('low', 'Повреждённые строки журнала', `${broken} строк не удалось разобрать как JSON`, 'Проверьте, что в журнал не пишет сторонний процесс, и что ротация не обрезает строки.');

  const order = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return {
    summary: {
      events: events.length, requests: total, byLevel, byStatus,
      period: times.length ? { from: new Date(Math.min(...times)).toISOString(), to: new Date(Math.max(...times)).toISOString() } : null,
      logins: events.filter((e) => e.event === 'auth.login').length,
      slowestRoutes: routeStats.sort((a, b) => b.p95 - a.p95).slice(0, 5),
    },
    findings,
  };
}

function format({ summary, findings }) {
  const s = summary;
  const out = [`Событий: ${s.events}, HTTP-запросов: ${s.requests}`, `Уровни: ${JSON.stringify(s.byLevel)}`, `Статусы: ${JSON.stringify(s.byStatus)}`, `Успешных входов: ${s.logins}`];
  if (s.period) out.push(`Период: ${s.period.from} … ${s.period.to}`);
  out.push('', 'Самые медленные маршруты (p95, мс):', ...s.slowestRoutes.map((r) => `  ${String(r.p95).padStart(5)}  ${r.route} (${r.count})`));
  out.push('', findings.length ? 'Находки:' : 'Находок нет.');
  for (const f of findings) out.push(`  [${f.severity}] ${f.title}: ${f.details}`, `         → ${f.advice}`);
  return out.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file = 'logs/api.log', flag] = process.argv.slice(2);
  const text = readFileSync(file === '-' ? 0 : file, 'utf8');
  const report = analyze(text.split('\n'));
  console.log(flag === '--json' ? JSON.stringify(report, null, 2) : format(report));
}
