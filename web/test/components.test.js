import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc, productCard, recipeCard, shoppingRow, statePanel } from '../src/ui/components.js';
import { getFreshness } from '../src/domain/freshness.js';

const TODAY = new Date(2026, 9, 16);
const product = (over = {}) => ({ id: 'p1', name: 'Молоко', quantity: 1, unit: 'л', storage: 'fridge', freshness: getFreshness('2026-10-16', TODAY), ...over });

test('карточка продукта: название, срок, место хранения, кнопки действий', () => {
  const html = productCard(product());
  for (const part of ['Молоко', 'сегодня', 'Холодильник', 'data-action="eat"', 'data-action="delete"', 'class="card red"']) assert.ok(html.includes(part), part);
});

test('защита от XSS: пользовательский ввод экранируется', () => {
  assert.equal(esc('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  const html = productCard(product({ name: '<script>alert(1)</script>' }));
  assert.ok(!html.includes('<script>'));
  assert.ok(!shoppingRow({ id: '1', name: '"><b>', isBought: false }).includes('"><b>'));
});

test('состояния loading / error / empty: роль, текст и кнопка повтора', () => {
  assert.match(statePanel('loading'), /role="status"/);
  const err = statePanel('error', 'Сервер недоступен');
  assert.ok(err.includes('role="alert"') && err.includes('data-action="retry"') && err.includes('Сервер недоступен'));
  assert.match(statePanel('empty', 'Тут пока пусто'), /Тут пока пусто/);
});

test('карточка рецепта: недостающие ингредиенты и кнопка «в покупки»', () => {
  const html = recipeCard({ recipe: { id: 'r', title: 'Сырники', minutes: 30 }, have: 2, total: 4, missing: ['мука', 'сахар'] });
  assert.ok(html.includes('есть 2 из 4') && html.includes('мука, сахар') && html.includes('add-missing'));
  assert.ok(recipeCard({ recipe: { id: 'r', title: 'X', minutes: 5 }, have: 1, total: 1, missing: [] }).includes('Все ингредиенты есть'));
});
