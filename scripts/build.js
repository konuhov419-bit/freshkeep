#!/usr/bin/env node
// Сборка: собирает каталог dist/ (server, web, migrations) и build-info.json, проверяет обязательные файлы.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = `${ROOT}dist/`;
const REQUIRED = ['server/index.js', 'server/app.js', 'web/index.html', 'web/src/main.js', 'migrations/001_init.sql', 'package.json'];

for (const f of REQUIRED) if (!existsSync(ROOT + f)) { console.error(`Сборка прервана: нет файла ${f}`); process.exit(1); }

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
for (const dir of ['server', 'web', 'migrations']) cpSync(`${ROOT}${dir}`, `${DIST}${dir}`, { recursive: true, filter: (src) => !/[\\/]test([\\/]|$)/.test(src) });
cpSync(`${ROOT}package.json`, `${DIST}package.json`);

let commit = process.env.GITHUB_SHA ?? '';
if (!commit) { try { commit = execSync('git rev-parse HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { commit = 'dev'; } }
const info = { name: 'freshkeep', version: JSON.parse(readFileSync(`${ROOT}package.json`, 'utf8')).version, commit: commit.slice(0, 7), builtAt: new Date().toISOString() };
writeFileSync(`${DIST}build-info.json`, JSON.stringify(info, null, 2) + '\n');
console.log(`Сборка готова: dist/ (${info.version}, ${info.commit})`);
