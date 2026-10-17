// src/daily-digest.ts
// FR-3.1–FR-3.6: формирование ежедневного push-дайджеста о сроках годности.

export type ProductStatus = 'active' | 'consumed' | 'discarded';

export interface DigestProduct {
  id: string;
  name: string;
  /** Срок годности, ISO-дата «ГГГГ-ММ-ДД» или null, если срок не указан. */
  expiresAt: string | null;
  status: ProductStatus;
  isDeleted: boolean;
  /** Дата последнего уведомления по продукту, «ГГГГ-ММ-ДД» (FR-3.6). */
  lastNotifiedOn: string | null;
}

export interface NotificationSettings {
  isEnabled: boolean;
  /** За сколько дней предупреждать (FR-3.3): 1, 2, 3 или 5. */
  daysBefore: number;
}

export interface Digest {
  title: string;
  body: string;
  productIds: string[];
}

const MAX_NAMES_IN_BODY = 3;
const DIGEST_TITLE = 'Скоро истекает срок годности';

/** Локальная дата в формате «ГГГГ-ММ-ДД». */
export function toDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Календарных дней от `today` до даты `isoDate` (отрицательно, если дата прошла). */
function daysUntil(isoDate: string, today: Date): number {
  const [y, m, d] = isoDate.split('-').map(Number);
  if (!y || !m || !d) throw new TypeError(`Некорректная дата: ${isoDate}`);
  const target = Date.UTC(y, m - 1, d);
  const start = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((target - start) / 86_400_000);
}

/**
 * Формирует одно push-сообщение со всеми продуктами, срок которых истекает
 * в пределах `daysBefore` дней (включая уже просроченные).
 *
 * @param products продукты одного пользователя/домохозяйства.
 * @param settings настройки уведомлений пользователя.
 * @param today текущая дата (передаётся параметром, чтобы функция была чистой).
 * @returns дайджест или `null`, если отправлять нечего или уведомления выключены.
 * @throws TypeError, если у продукта некорректная дата срока годности.
 */
export function buildDailyDigest(
  products: readonly DigestProduct[],
  settings: NotificationSettings,
  today: Date,
): Digest | null {
  if (!settings.isEnabled) return null;
  const todayKey = toDateKey(today);

  const due = products
    .filter((p) => p.status === 'active' && !p.isDeleted) // FR-3.4
    .filter((p) => p.expiresAt !== null)
    .filter((p) => p.lastNotifiedOn !== todayKey) // FR-3.6
    .map((p) => ({ product: p, days: daysUntil(p.expiresAt as string, today) }))
    .filter(({ days }) => days <= settings.daysBefore) // FR-3.1
    .sort((a, b) => a.days - b.days || a.product.name.localeCompare(b.product.name, 'ru'));

  if (due.length === 0) return null;

  const names = due.map(({ product }) => product.name);
  const shown = names.slice(0, MAX_NAMES_IN_BODY).join(', ');
  const rest = names.length - MAX_NAMES_IN_BODY;
  const body = rest > 0 ? `${shown} и ещё ${rest}` : shown;

  return { title: DIGEST_TITLE, body, productIds: due.map(({ product }) => product.id) };
}
