import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDailyDigest, toDateKey } from '../src/daily-digest.ts';
import type { DigestProduct, NotificationSettings } from '../src/daily-digest.ts';

const TODAY = new Date(2026, 9, 15, 9, 0); // 15.10.2026 09:00
const SETTINGS: NotificationSettings = { isEnabled: true, daysBefore: 2 };

function product(overrides: Partial<DigestProduct> & { id: string }): DigestProduct {
  return {
    name: overrides.id,
    expiresAt: '2026-10-16',
    status: 'active',
    isDeleted: false,
    lastNotifiedOn: null,
    ...overrides,
  };
}

test('FR-3.1: включает продукты, срок которых истекает в пределах daysBefore', () => {
  const digest = buildDailyDigest(
    [
      product({ id: 'a', name: 'Молоко', expiresAt: '2026-10-15' }),
      product({ id: 'b', name: 'Йогурт', expiresAt: '2026-10-17' }),
      product({ id: 'c', name: 'Сыр', expiresAt: '2026-10-18' }), // 3 дня > 2
    ],
    SETTINGS,
    TODAY,
  );
  assert.deepEqual(digest?.productIds, ['a', 'b']);
});

test('FR-3.1: граница — ровно daysBefore дней включается', () => {
  const digest = buildDailyDigest([product({ id: 'a', expiresAt: '2026-10-17' })], SETTINGS, TODAY);
  assert.deepEqual(digest?.productIds, ['a']);
});

test('FR-3.1: просроченные продукты тоже попадают в дайджест', () => {
  const digest = buildDailyDigest([product({ id: 'a', expiresAt: '2026-10-10' })], SETTINGS, TODAY);
  assert.deepEqual(digest?.productIds, ['a']);
});

test('FR-3.2: несколько продуктов объединяются в одно сообщение', () => {
  const digest = buildDailyDigest(
    [
      product({ id: 'a', name: 'Молоко', expiresAt: '2026-10-15' }),
      product({ id: 'b', name: 'Йогурт', expiresAt: '2026-10-16' }),
    ],
    SETTINGS,
    TODAY,
  );
  assert.equal(digest?.body, 'Молоко, Йогурт');
  assert.equal(digest?.title, 'Скоро истекает срок годности');
});

test('FR-3.2: при более чем трёх продуктах тело сокращается', () => {
  const items = ['Молоко', 'Йогурт', 'Кефир', 'Творог', 'Сметана'].map((name, i) =>
    product({ id: String(i), name, expiresAt: '2026-10-16' }),
  );
  const digest = buildDailyDigest(items, SETTINGS, TODAY);
  assert.match(digest?.body ?? '', /и ещё 2$/);
  assert.equal(digest?.productIds.length, 5);
});

test('FR-3.4: удалённые, съеденные и выброшенные продукты исключаются', () => {
  const digest = buildDailyDigest(
    [
      product({ id: 'deleted', isDeleted: true }),
      product({ id: 'eaten', status: 'consumed' }),
      product({ id: 'thrown', status: 'discarded' }),
      product({ id: 'ok' }),
    ],
    SETTINGS,
    TODAY,
  );
  assert.deepEqual(digest?.productIds, ['ok']);
});

test('FR-3.6: продукт, о котором уже уведомляли сегодня, исключается', () => {
  const digest = buildDailyDigest(
    [product({ id: 'a', lastNotifiedOn: toDateKey(TODAY) }), product({ id: 'b', lastNotifiedOn: '2026-10-14' })],
    SETTINGS,
    TODAY,
  );
  assert.deepEqual(digest?.productIds, ['b']);
});

test('FR-3.3: выключенные уведомления дают null', () => {
  assert.equal(buildDailyDigest([product({ id: 'a' })], { ...SETTINGS, isEnabled: false }, TODAY), null);
});

test('нечего отправлять: пустой список и продукты без срока дают null', () => {
  assert.equal(buildDailyDigest([], SETTINGS, TODAY), null);
  assert.equal(buildDailyDigest([product({ id: 'a', expiresAt: null })], SETTINGS, TODAY), null);
});

test('сортировка: сначала самые срочные', () => {
  const digest = buildDailyDigest(
    [
      product({ id: 'late', name: 'Сыр', expiresAt: '2026-10-17' }),
      product({ id: 'soon', name: 'Молоко', expiresAt: '2026-10-15' }),
    ],
    SETTINGS,
    TODAY,
  );
  assert.deepEqual(digest?.productIds, ['soon', 'late']);
});

test('время суток не влияет на результат', () => {
  const evening = new Date(2026, 9, 15, 23, 59);
  const digest = buildDailyDigest([product({ id: 'a', expiresAt: '2026-10-17' })], SETTINGS, evening);
  assert.deepEqual(digest?.productIds, ['a']);
});

test('некорректная дата срока годности выбрасывает TypeError', () => {
  assert.throws(
    () => buildDailyDigest([product({ id: 'a', expiresAt: 'не-дата' })], SETTINGS, TODAY),
    TypeError,
  );
});
