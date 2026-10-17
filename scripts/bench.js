#!/usr/bin/env node
// Замер производительности: вес первой и повторной загрузки страницы, задержка и размер GET /api/products.
// Запуск: node scripts/bench.js http://localhost:5173 [число_продуктов]
import { request } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = new URL(process.argv[2] ?? 'http://localhost:5173');
const N = Number(process.argv[3] ?? 400);
const WEB = fileURLToPath(new URL('../web', import.meta.url));

const unzip = (r) => (r.headers['content-encoding'] === 'gzip' ? gunzipSync(r.body) : r.body).toString('utf8');

function get(path, headers = {}, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const req = request({ hostname: BASE.hostname, port: BASE.port, path, method, headers: { 'Accept-Encoding': 'gzip', ...headers, ...(body && { 'Content-Type': 'application/json' }) } }, (res) => {
      let bytes = 0;
      const chunks = [];
      res.on('data', (c) => { bytes += c.length; chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, bytes, ms: performance.now() - t0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
const pct = (arr, p) => [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))];
const round = (n) => Math.round(n * 10) / 10;

const assets = ['/'];
(function walk(dir, prefix) {
  for (const f of readdirSync(dir)) {
    const full = join(dir, f);
    if (statSync(full).isDirectory()) { if (f !== 'test') walk(full, `${prefix}${f}/`); } else if (/\.(js|css)$/.test(f)) assets.push(`${prefix}${f}`);
  }
})(WEB, '/');

const first = await Promise.all(assets.map((a) => get(a)));
const etags = Object.fromEntries(assets.map((a, i) => [a, first[i].headers.etag]));
const second = await Promise.all(assets.map((a) => get(a, etags[a] ? { 'If-None-Match': etags[a] } : {})));
const out = {
  assets: assets.length,
  firstVisitBytes: first.reduce((s, r) => s + r.bytes, 0),
  firstVisitGzip: first.filter((r) => r.headers['content-encoding'] === 'gzip').length,
  repeatVisitBytes: second.reduce((s, r) => s + r.bytes, 0),
  repeatVisit304: second.filter((r) => r.status === 304).length,
};

const email = `bench${Date.now()}@example.com`;
const reg = await get('/api/auth/register', {}, 'POST', { email, password: 'password1' });
const token = JSON.parse(unzip(reg)).token;
const auth = { Authorization: `Bearer ${token}` };
for (let i = 0; i < N; i++) await get('/api/products', auth, 'POST', { name: `Продукт номер ${i}`, quantity: 1 + (i % 5), unit: 'шт', storage: 'fridge', expiresAt: '2030-01-01' });
const list = await get('/api/products', auth);
out.productsInList = JSON.parse(unzip(list) || '[]').length;
out.listBytes = list.bytes;
const times = [];
for (let i = 0; i < 200; i++) times.push((await get('/api/products', auth)).ms);
out.listLatencyMs = { p50: round(pct(times, 0.5)), p95: round(pct(times, 0.95)) };
console.log(JSON.stringify(out, null, 2));
