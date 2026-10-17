/**
 * Проверяет PUBLIC_URL. Возвращает адрес без слеша на конце или бросает понятную ошибку на русском.
 * Пустое значение допустимо (адрес тогда берётся из заголовка Host).
 * @param {string | undefined} value
 * @returns {string}
 */
export function normalizePublicUrl(value) {
  const raw = (value ?? '').trim();
  if (!raw) return '';
  let url;
  try { url = new URL(raw); } catch {
    throw new Error(`PUBLIC_URL="${raw}" не похож на адрес. Нужен полный адрес с протоколом, например https://freshkeep.up.railway.app`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`PUBLIC_URL должен начинаться с https:// (получено ${url.protocol})`);
  if (url.pathname !== '/' || url.search || url.hash) throw new Error('PUBLIC_URL должен быть адресом без пути, например https://freshkeep.up.railway.app');
  return url.origin;
}
