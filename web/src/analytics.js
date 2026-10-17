// Аналитика: Яндекс.Метрика с согласием пользователя. События не содержат персональных данных и названий продуктов.
const CONSENT_KEY = 'freshkeep.consent';
let loaded = false;

const counterId = () => globalThis.FRESHKEEP_METRIKA_ID || '';
/** Включена ли аналитика в конфигурации (задан номер счётчика). */
export const isEnabled = () => Boolean(counterId());

/** @returns {'yes'|'no'|null} решение пользователя; null — ещё не спрашивали */
export function getConsent() {
  try { return localStorage.getItem(CONSENT_KEY); } catch { return null; }
}

export function setConsent(value) {
  try { localStorage.setItem(CONSENT_KEY, value); } catch { /* хранилище недоступно: согласие действует до перезагрузки */ }
  if (value === 'yes') init();
}

/** Подключает счётчик, только если задан номер и получено согласие. Повторные вызовы безопасны. */
export function init() {
  const id = counterId();
  if (!id || loaded || getConsent() !== 'yes') return false;
  loaded = true;
  const g = globalThis;
  g.ym = g.ym || function ym() { (g.ym.a = g.ym.a || []).push(arguments); }; // очередь вызовов до загрузки tag.js
  g.ym.l = Date.now();
  const script = document.createElement('script');
  script.async = true;
  script.src = 'https://mc.yandex.ru/metrika/tag.js';
  document.head.appendChild(script);
  g.ym(id, 'init', { clickmap: true, trackLinks: true, accurateTrackBounce: true, webvisor: false });
  return true;
}

/**
 * Отправляет цель (событие). Не бросает исключений: сбой аналитики не должен ломать приложение.
 * @param {string} name имя цели из каталога событий (docs)
 * @param {Record<string, string|number|boolean>=} params параметры без персональных данных
 */
export function track(name, params) {
  const id = counterId();
  if (!id || getConsent() !== 'yes' || typeof globalThis.ym !== 'function') return;
  try { globalThis.ym(id, 'reachGoal', name, params); } catch { /* игнорируем */ }
}

/** Просмотр экрана в одностраничном приложении (смена hash-маршрута). */
export function pageView(path) {
  const id = counterId();
  if (!id || getConsent() !== 'yes' || typeof globalThis.ym !== 'function') return;
  try { globalThis.ym(id, 'hit', path); } catch { /* игнорируем */ }
}
