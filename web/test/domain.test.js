import { consumeProduct, consumeUnits, formatQty } from '../src/domain/inventory.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getFreshness, pluralDays, parseIsoDate } from '../src/domain/freshness.js';
import { validateProduct, filterProducts, summarize } from '../src/domain/inventory.js';
import { addShoppingItem } from '../src/domain/shopping.js';
import { matchRecipes, RECIPES } from '../src/domain/recipes.js';

const TODAY = new Date(2026, 9, 16, 15, 0);

test('US-05: цвет и подпись свежести, граничные значения', () => {
  assert.equal(getFreshness('2026-10-28', TODAY).status, 'green');
  assert.deepEqual([getFreshness('2026-10-19', TODAY).status, getFreshness('2026-10-17', TODAY).label], ['orange', '1 день']);
  assert.equal(getFreshness('2026-10-16', TODAY).label, 'сегодня');
  assert.equal(getFreshness('2026-10-14', TODAY).label, 'просрочено 2 дн.');
  assert.equal(getFreshness(null, TODAY).status, 'none');
  assert.throws(() => getFreshness('2026-02-30', TODAY), TypeError);
});

test('склонение дней и разбор дат', () => {
  assert.deepEqual([1, 2, 5, 11, 21].map(pluralDays), ['1 день', '2 дня', '5 дней', '11 дней', '21 день']);
  assert.equal(parseIsoDate('2026-02-30'), null);
});

test('US-02: валидация формы продукта (позитив и негатив)', () => {
  const ok = validateProduct({ name: '  Молоко ', quantity: '1,5', unit: 'л', storage: 'fridge', expiresAt: '2026-10-20' }, TODAY);
  assert.equal(ok.ok, true);
  assert.equal(ok.value.quantity, 1.5);
  const bad = validateProduct({ name: '', quantity: '0', unit: 'x', storage: 'fridge', expiresAt: 'abc' }, TODAY);
  assert.deepEqual(Object.keys(bad.errors).sort(), ['expiresAt', 'name', 'quantity', 'unit']);
  const expired = validateProduct({ name: 'Йогурт', quantity: '1', unit: 'шт', storage: 'fridge', expiresAt: '2026-10-01' }, TODAY);
  assert.equal(expired.ok && expired.isExpired, true);
});

test('US-05/US-13: сортировка по сроку, поиск и фильтр по месту хранения', () => {
  const products = [
    { id: 'a', name: 'Сыр', storage: 'fridge', expiresAt: '2026-10-28' },
    { id: 'b', name: 'Молоко', storage: 'fridge', expiresAt: '2026-10-16' },
    { id: 'c', name: 'Сахар', storage: 'pantry', expiresAt: null },
  ];
  assert.deepEqual(filterProducts(products, {}, TODAY).map((p) => p.id), ['b', 'a', 'c']);
  assert.deepEqual(filterProducts(products, { storage: 'pantry' }, TODAY).map((p) => p.id), ['c']);
  assert.deepEqual(filterProducts(products, { query: ' МОЛ ' }, TODAY).map((p) => p.id), ['b']);
  assert.deepEqual(summarize(products, TODAY), { red: 1, orange: 0, green: 1, none: 1 });
});

test('US-10: список покупок не допускает пустые названия и дубли', () => {
  const first = addShoppingItem([], '  Яйца ', 'x1');
  assert.equal(first.ok, true);
  assert.equal(addShoppingItem(first.items, 'яйца', 'x2').error, 'Уже в списке');
  assert.equal(addShoppingItem(first.items, '   ', 'x3').error, 'Введите название');
});

test('US-08: рецепты — порог 3 продукта, ≥50% совпадений, недостающие ингредиенты', () => {
  assert.equal(matchRecipes([{ name: 'Яйца' }], RECIPES).enough, false);
  const products = [{ name: 'Яйца' }, { name: 'Молоко 3,2%' }, { name: 'Сыр гауда' }];
  const { matches } = matchRecipes(products, RECIPES);
  assert.equal(matches[0].recipe.id, 'omelet');
  assert.equal(matches[0].have, 3);
  assert.ok(matches.every((m) => m.have / m.total >= 0.5));
});

test('US-04: съели 2 из 10 яиц — остаётся 8, продукт не удаляется', () => {
  const r = consumeProduct({ quantity: 10, unit: 'шт' }, '2');
  assert.deepEqual([r.ok, r.remaining, r.finished], [true, 8, false]);
});

test('US-04: граммы и миллилитры — 200 г из 1 кг оставляют 0,8 кг; 250 мл из 1 л — 0,75 л', () => {
  assert.equal(consumeProduct({ quantity: 1, unit: 'кг' }, '200', 'г').remaining, 0.8);
  assert.equal(consumeProduct({ quantity: 1, unit: 'л' }, '250', 'мл').remaining, 0.75);
  assert.equal(consumeProduct({ quantity: 600, unit: 'г' }, '150,5').remaining, 449.5);
  assert.deepEqual(consumeUnits('кг'), ['кг', 'г']);
  assert.equal(formatQty(0.8), '0,8');
});

test('US-04: списано всё — finished=true; больше, чем есть, или неверный ввод — ошибка', () => {
  assert.equal(consumeProduct({ quantity: 10, unit: 'шт' }, '10').finished, true);
  assert.equal(consumeProduct({ quantity: 1, unit: 'кг' }, '1000', 'г').finished, true);
  assert.match(consumeProduct({ quantity: 8, unit: 'шт' }, '9').error, /осталось 8 шт/);
  assert.equal(consumeProduct({ quantity: 8, unit: 'шт' }, '0').ok, false);
  assert.equal(consumeProduct({ quantity: 8, unit: 'шт' }, 'abc').error, 'Введите число');
  assert.equal(consumeProduct({ quantity: 8, unit: 'шт' }, '1', 'г').error, 'Неверная единица');
});
