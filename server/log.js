import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEY = /pass(word)?|token|secret|cookie|authorization|ticket|verifier/i;
const MAX_VALUE = 500;

/** Рекурсивно скрывает значения секретных полей и обрезает длинные строки (защита логов от утечек и раздувания). */
function redact(value, depth = 0) {
  if (depth > 4 || value === null || typeof value !== 'object') return typeof value === 'string' && value.length > MAX_VALUE ? `${value.slice(0, MAX_VALUE)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? '[скрыто]' : redact(v, depth + 1)]));
}

/**
 * JSON-логгер: одна строка = одно событие, уровни debug/info/warn/error, секреты скрыты.
 * Пишет в stdout (его собирают хостинги и docker logs) и, если задан файл, в файл с ротацией по размеру.
 * @param {{file?: string, silent?: boolean, level?: string, base?: object, maxBytes?: number}} options
 */
export function createLogger({ file = '', silent = false, level: min = 'info', base = {}, maxBytes = 5 * 1024 * 1024 } = {}) {
  if (file) mkdirSync(dirname(file), { recursive: true });
  const threshold = LEVELS[min] ?? LEVELS.info;
  let size = 0;
  if (file) { try { size = statSync(file).size; } catch { /* файла ещё нет */ } }

  function write(line) {
    if (size + line.length > maxBytes) {
      try { renameSync(file, `${file}.1`); } catch { /* нечего ротировать */ }
      size = 0;
    }
    appendFileSync(file, line, { mode: 0o600 });
    size += line.length;
  }

  return (level, msg, extra = {}) => {
    if (silent || (LEVELS[level] ?? LEVELS.info) < threshold) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level, ...base, msg, ...redact(extra) });
    (level === 'error' ? console.error : console.log)(line);
    if (file) { try { write(`${line}\n`); } catch { /* диск недоступен или полон: логи остаются в stdout */ } }
  };
}
