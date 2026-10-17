#!/usr/bin/env node
// Линтер и проверка форматирования без зависимостей (работает локально и в CI одинаково).
//   node scripts/lint.js            — правила кода + синтаксис + неиспользуемые импорты
//   node scripts/lint.js --format   — только форматирование (пробелы, отступы, переводы строк)
//   node scripts/lint.js --fix      — автоисправление форматирования
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKIP = new Set(['node_modules', '.git', 'data', 'logs', 'dist', 'screenshots']);
const mode = process.argv[2] ?? '';
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(js|css|html|json|md|ya?ml|sql)$/.test(name)) files.push(p);
  }
})(ROOT);

const problems = [];
const report = (file, line, rule, msg) => problems.push(`${relative(ROOT, file)}:${line} [${rule}] ${msg}`);
const LOG_OK = /^(server\/(index|log)\.js|scripts\/|server\/test\/|web\/test\/)/;

for (const file of files) {
  const rel = relative(ROOT, file);
  let text = readFileSync(file, 'utf8');
  const isCode = file.endsWith('.js');

  // --- форматирование ---
  if (mode === '--fix') {
    const fixed = text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n*$/, '\n');
    if (fixed !== text) { writeFileSync(file, fixed); text = fixed; }
  }
  if (text.includes('\r')) report(file, 1, 'format/crlf', 'используйте переводы строк LF');
  if (!text.endsWith('\n')) report(file, text.split('\n').length, 'format/eof', 'файл должен заканчиваться переводом строки');
  text.split('\n').forEach((line, i) => {
    if (/[ \t]+$/.test(line)) report(file, i + 1, 'format/trailing-space', 'пробелы в конце строки');
    if (/^\t/.test(line) && !file.endsWith('.md')) report(file, i + 1, 'format/tab', 'используйте пробелы вместо табуляции');
  });
  if (mode === '--format' || mode === '--fix' || !isCode || rel === 'scripts/lint.js') continue;

  // --- правила кода ---
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '');
    if (/\bvar\s+\w/.test(code)) report(file, i + 1, 'no-var', 'используйте const или let');
    if (/\bdebugger\b/.test(code)) report(file, i + 1, 'no-debugger', 'уберите debugger');
    if (/\b(eval|new Function)\s*\(/.test(code)) report(file, i + 1, 'no-eval', 'eval и new Function запрещены (инъекция кода)');
    if (/\bconsole\.log\b/.test(code) && !LOG_OK.test(rel)) report(file, i + 1, 'no-console', 'используйте логгер вместо console.log');
    if (/[^=!<>]==[^=]/.test(code.replace(/(['"`]).*?\1/g, '""')) && !/== null/.test(code)) report(file, i + 1, 'eqeqeq', 'используйте === вместо ==');
    if (/(API_KEY|SECRET|PASSWORD|TOKEN)\w*\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i.test(code) && !rel.includes('test')) report(file, i + 1, 'no-secrets', 'похоже на секрет в коде');
  });

  // --- неиспользуемые импорты ---
  for (const m of text.matchAll(/^import\s+(?:type\s+)?\{([^}]+)\}\s+from/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.split(' as ').pop().trim();
      if (!name) continue;
      const uses = text.match(new RegExp(`\\b${name}\\b`, 'g'))?.length ?? 0;
      if (uses < 2) report(file, text.slice(0, m.index).split('\n').length, 'no-unused-imports', `импорт «${name}» не используется`);
    }
  }

  // --- синтаксис ---
  try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); }
  catch (e) { report(file, 1, 'syntax', String(e.stderr ?? e.message).split('\n').find((l) => /Error/.test(l)) ?? 'ошибка синтаксиса'); }
}

if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\nНайдено проблем: ${problems.length}`);
  process.exit(1);
}
console.log(`OK: проверено файлов ${files.length}${mode ? ` (${mode})` : ''}`);
