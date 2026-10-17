import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePublicUrl } from '../config.js';

test('PUBLIC_URL: корректный адрес, слеш на конце и пробелы убираются, пусто допустимо', () => {
  assert.equal(normalizePublicUrl('https://freshkeep.up.railway.app/'), 'https://freshkeep.up.railway.app');
  assert.equal(normalizePublicUrl('  http://localhost:5173 '), 'http://localhost:5173');
  assert.equal(normalizePublicUrl(''), '');
  assert.equal(normalizePublicUrl(undefined), '');
});

test('PUBLIC_URL: без протокола — понятная ошибка с примером (ошибка из деплоя на Railway)', () => {
  assert.throws(() => normalizePublicUrl('freshkeep-production.up.railway.app'), /с протоколом, например https:\/\//);
});

test('PUBLIC_URL: чужой протокол и путь отклоняются', () => {
  assert.throws(() => normalizePublicUrl('ftp://example.com'), /https:\/\//);
  assert.throws(() => normalizePublicUrl('https://example.com/app'), /без пути/);
});
