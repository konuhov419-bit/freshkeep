import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/** Окружение браузера: localStorage, document.createElement, window.ym — всё в памяти. */
let store; let scripts; let calls;
function env({ id = '12345678', consent } = {}) {
  store = new Map(consent ? [['freshkeep.consent', consent]] : []);
  scripts = []; calls = [];
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  globalThis.document = { createElement: () => ({}), head: { appendChild: (s) => scripts.push(s) } };
  globalThis.FRESHKEEP_METRIKA_ID = id;
  delete globalThis.ym;
}
let analytics;
beforeEach(async () => { env(); analytics = await import(`../src/analytics.js?${Math.random()}`); }); // новый экземпляр модуля: свежее состояние loaded

test('без номера счётчика аналитика выключена: ничего не загружается и не отправляется', () => {
  env({ id: '', consent: 'yes' });
  assert.equal(analytics.isEnabled(), false);
  assert.equal(analytics.init(), false);
  analytics.track('login');
  assert.equal(scripts.length, 0);
});

test('без согласия счётчик не подключается и события не уходят', () => {
  assert.equal(analytics.getConsent(), null);
  assert.equal(analytics.init(), false);
  analytics.track('login');
  assert.equal(scripts.length, 0);
  assert.equal(typeof globalThis.ym, 'undefined');
});

test('согласие подключает tag.js один раз и вызывает init с отключённым вебвизором', () => {
  analytics.setConsent('yes');
  analytics.init(); // повторный вызов не дублирует скрипт
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].src, 'https://mc.yandex.ru/metrika/tag.js');
  const [, [id, action, options]] = [0, ...globalThis.ym.a];
  assert.deepEqual([id, action, options.webvisor, options.clickmap], ['12345678', 'init', false, true]);
});

test('track отправляет цель с параметрами, pageView — просмотр экрана', () => {
  analytics.setConsent('yes');
  globalThis.ym = (...a) => calls.push(a);
  analytics.track('product_added', { storage: 'fridge', has_expiry: true });
  analytics.pageView('#/recipes');
  assert.deepEqual(calls, [['12345678', 'reachGoal', 'product_added', { storage: 'fridge', has_expiry: true }], ['12345678', 'hit', '#/recipes']]);
});

test('отказ от аналитики: события не отправляются; сбой счётчика не ломает приложение', () => {
  analytics.setConsent('no');
  globalThis.ym = (...a) => calls.push(a);
  analytics.track('login');
  assert.equal(calls.length, 0);
  analytics.setConsent('yes');
  globalThis.ym = () => { throw new Error('счётчик недоступен'); };
  assert.doesNotThrow(() => analytics.track('login'));
});

test('недоступное хранилище: согласие по умолчанию отсутствует, ошибок нет', () => {
  globalThis.localStorage = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  assert.equal(analytics.getConsent(), null);
  assert.doesNotThrow(() => analytics.setConsent('yes'));
});
