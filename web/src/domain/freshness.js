// FR-2.7: статус свежести продукта. Чистая функция: текущая дата приходит параметром.
const DAY = 86_400_000;
const utc = (d) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());

/** Склонение: 1 день, 2 дня, 5 дней, 11 дней, 21 день. */
export function pluralDays(n) {
  const a = Math.abs(n), m100 = a % 100, m10 = a % 10;
  if (m100 >= 11 && m100 <= 14) return `${a} дней`;
  if (m10 === 1) return `${a} день`;
  if (m10 >= 2 && m10 <= 4) return `${a} дня`;
  return `${a} дней`;
}

/** «ГГГГ-ММ-ДД» -> локальная дата или null, если строка не является реальной датой. */
export function parseIsoDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? '');
  if (!m) return null;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const date = new Date(y, mo - 1, d);
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d ? date : null;
}

export function toIso(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

export function addDays(date, n) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
}

/**
 * @param {string|null} expiresAt «ГГГГ-ММ-ДД» или пусто
 * @param {Date} today
 * @returns {{status:'green'|'orange'|'red'|'none', daysLeft:number|null, label:string, ratio:number}}
 *   ratio — доля свежести 0..1 для полосы на карточке (по шкале 14 дней).
 */
export function getFreshness(expiresAt, today) {
  if (!expiresAt) return { status: 'none', daysLeft: null, label: 'без срока', ratio: 1 };
  const date = parseIsoDate(expiresAt);
  if (!date) throw new TypeError(`Некорректная дата: ${expiresAt}`);
  const daysLeft = Math.round((utc(date) - utc(today)) / DAY);
  const ratio = Math.min(1, Math.max(0.05, daysLeft / 14));
  if (daysLeft < 0) return { status: 'red', daysLeft, label: `просрочено ${Math.abs(daysLeft)} дн.`, ratio: 0.05 };
  if (daysLeft === 0) return { status: 'red', daysLeft, label: 'сегодня', ratio: 0.05 };
  if (daysLeft <= 3) return { status: 'orange', daysLeft, label: pluralDays(daysLeft), ratio };
  return { status: 'green', daysLeft, label: pluralDays(daysLeft), ratio };
}
