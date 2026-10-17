// Клиент REST API. Все сетевые ошибки приводятся к ApiError с понятным текстом (ERR-7/8/10/11).
const TOKEN_KEY = 'freshkeep.token';
const base = () => globalThis.FRESHKEEP_API_URL ?? '';

export class ApiError extends Error {
  /** @param {number} status 0 = нет сети; @param {string} code @param {Record<string,string>=} fields */
  constructor(status, code, message, fields) { super(message); Object.assign(this, { status, code, fields }); }
}

/** Полный адрес API-маршрута: нужен для ссылок (вход через OAuth), которые открываются как обычные переходы. */
export const apiUrl = (path) => base() + path;

export const getToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
export const setToken = (t) => { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* хранилище недоступно */ } };

const FALLBACK = { 401: 'Требуется вход', 403: 'Нет доступа', 404: 'Не найдено', 429: 'Слишком много попыток. Повторите позже' };

export async function request(method, path, body) {
  const token = getToken();
  let res;
  try {
    res = await fetch(base() + path, {
      method,
      headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...(token && { Authorization: `Bearer ${token}` }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Нет соединения с сервером. Проверьте интернет и повторите');
  }
  if (res.status === 204) return null;
  let data = null;
  try { data = await res.json(); } catch { /* тело не JSON (например, страница прокси) */ }
  if (!res.ok) {
    const e = data?.error;
    const message = e?.message ?? (res.status >= 500 ? 'Ошибка сервера. Попробуйте позже' : FALLBACK[res.status] ?? 'Запрос не выполнен');
    throw new ApiError(res.status, e?.code ?? 'ERROR', message, e?.fields);
  }
  return data;
}

export const api = {
  register: (v) => request('POST', '/api/auth/register', v),
  login: (v) => request('POST', '/api/auth/login', v),
  logout: () => request('POST', '/api/auth/logout'),
  providers: () => request('GET', '/api/auth/providers'),
  oauthExchange: (ticket) => request('POST', '/api/auth/oauth/exchange', { ticket }),
  me: () => request('GET', '/api/me'),
  listProducts: () => request('GET', '/api/products'),
  createProduct: (p) => request('POST', '/api/products', p),
  patchProduct: (id, patch) => request('PATCH', `/api/products/${id}`, patch),
  consume: (id, amount, unit) => request('POST', `/api/products/${id}/consume`, { amount, unit }),
  deleteProduct: (id) => request('DELETE', `/api/products/${id}`),
  listShopping: () => request('GET', '/api/shopping'),
  addShopping: (name) => request('POST', '/api/shopping', { name }),
  toggleShopping: (id, isBought) => request('PATCH', `/api/shopping/${id}`, { isBought }),
  removeShopping: (id) => request('DELETE', `/api/shopping/${id}`),
};
