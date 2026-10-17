import { getFreshness, parseIsoDate } from './freshness.js';

export const UNITS = ['шт', 'г', 'кг', 'мл', 'л'];
export const STORAGES = { fridge: 'Холодильник', freezer: 'Морозилка', pantry: 'Шкаф' };
export const MAX_NAME = 100;
export const MAX_QUANTITY = 1_000_000;

/** FR-2.1 / US-02: проверка формы продукта. Просроченная дата — не ошибка, а предупреждение. */
export function validateProduct(input, today) {
  const errors = {};
  // Типы проверяются явно: тело запроса приходит из сети и может содержать числа, массивы и объекты вместо строк.
  const rawName = input.name ?? '';
  const name = typeof rawName === 'string' ? rawName.trim().replace(/\s+/g, ' ') : '';
  if (typeof rawName !== 'string') errors.name = 'Название должно быть строкой';
  else if (!name) errors.name = 'Укажите название';
  else if (name.length > MAX_NAME) errors.name = `Не длиннее ${MAX_NAME} символов`;

  const qtyType = ['string', 'number'].includes(typeof input.quantity);
  const rawQty = qtyType ? String(input.quantity).trim().replace(',', '.') : '';
  const quantity = Number(rawQty);
  if (!rawQty || !/^\d+(\.\d+)?$/.test(rawQty)) errors.quantity = 'Введите число';
  else if (quantity <= 0) errors.quantity = 'Количество должно быть больше 0';
  else if (!Number.isFinite(quantity) || quantity > MAX_QUANTITY) errors.quantity = `Не больше ${MAX_QUANTITY.toLocaleString('ru-RU')}`;

  if (!UNITS.includes(input.unit)) errors.unit = 'Выберите единицу';
  // hasOwn, а не «in»: иначе storage = "toString" или "__proto__" проходит проверку через цепочку прототипов
  if (!Object.hasOwn(STORAGES, input.storage ?? '')) errors.storage = 'Выберите место хранения';

  const rawExpiry = input.expiresAt ?? '';
  const expiresAt = typeof rawExpiry === 'string' ? rawExpiry.trim() || null : null;
  let isExpired = false;
  if (typeof rawExpiry !== 'string') errors.expiresAt = 'Неверная дата';
  else if (expiresAt) {
    if (!parseIsoDate(expiresAt)) errors.expiresAt = 'Неверная дата';
    else isExpired = getFreshness(expiresAt, today).daysLeft < 0;
  }
  const ok = Object.keys(errors).length === 0;
  return { ok, errors, isExpired, value: ok ? { name, quantity, unit: input.unit, storage: input.storage, expiresAt } : null };
}

/** FR-2.6 / US-13: фильтр по месту хранения и подстроке, сортировка по сроку (без срока — в конец). */
export function filterProducts(products, { storage = 'all', query = '' }, today) {
  const q = query.trim().toLowerCase();
  return products
    .filter((p) => storage === 'all' || p.storage === storage)
    .filter((p) => !q || p.name.toLowerCase().includes(q))
    .map((p) => ({ ...p, freshness: getFreshness(p.expiresAt, today) }))
    .sort((a, b) => (a.freshness.daysLeft ?? Infinity) - (b.freshness.daysLeft ?? Infinity));
}

/** Сводка для чипов над сеткой: сколько просрочено/скоро/в норме. */
export function summarize(products, today) {
  const s = { red: 0, orange: 0, green: 0, none: 0 };
  for (const p of products) s[getFreshness(p.expiresAt, today).status]++;
  return s;
}

const round3 = (n) => Math.round(n * 1000) / 1000;
/** Количество для показа: 0.8 -> «0,8», без хвостов плавающей точки. */
export const formatQty = (n) => String(round3(n)).replace('.', ',');

const SUB_UNITS = { кг: { г: 1000 }, л: { мл: 1000 } };
/** В каких единицах можно вводить списание: для кг — кг и г, для л — л и мл. */
export const consumeUnits = (unit) => [unit, ...Object.keys(SUB_UNITS[unit] ?? {})];
/** Быстрые значения для кнопок в окне «Съедено». */
export const consumePresets = (unit) => ({ шт: [1, 2, 3], г: [50, 100, 250], мл: [50, 100, 250], кг: [0.1, 0.25, 0.5], л: [0.1, 0.25, 0.5] })[unit] ?? [1];

/**
 * US-04: частичное списание. Возвращает {ok, remaining, finished, eaten} или {ok:false, error}.
 * Количество можно вводить в дробных единицах (г для кг, мл для л); запятая допустима.
 */
export function consumeProduct(product, amountRaw, amountUnit = product.unit) {
  const raw = String(amountRaw ?? '').trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(raw)) return { ok: false, error: 'Введите число' };
  let amount = Number(raw);
  if (amount <= 0) return { ok: false, error: 'Количество должно быть больше 0' };
  if (amountUnit !== product.unit) {
    const table = Object.hasOwn(SUB_UNITS, product.unit) ? SUB_UNITS[product.unit] : {};
    const factor = typeof amountUnit === 'string' && Object.hasOwn(table, amountUnit) ? table[amountUnit] : 0;
    if (!factor) return { ok: false, error: 'Неверная единица' };
    amount /= factor;
  }
  amount = round3(amount);
  if (amount > product.quantity) {
    return { ok: false, error: `Нельзя съесть больше, чем есть (осталось ${formatQty(product.quantity)} ${product.unit})` };
  }
  const remaining = round3(product.quantity - amount);
  return { ok: true, remaining, finished: remaining <= 0, eaten: amount };
}
