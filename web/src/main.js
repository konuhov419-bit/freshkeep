// Точка входа: состояние, роутинг по hash, вызовы REST API, обработка ошибок.
import { ApiError, api, apiUrl, getToken, setToken } from './api.js';
import { getConsent, init as initAnalytics, isEnabled as analyticsEnabled, pageView, setConsent, track } from './analytics.js';
import { addDays, toIso } from './domain/freshness.js';
import { STORAGES, UNITS, consumePresets, consumeProduct, consumeUnits, filterProducts, formatQty, summarize, validateProduct } from './domain/inventory.js';
import { RECIPES, matchRecipes } from './domain/recipes.js';
import { addShoppingItem } from './domain/shopping.js';
import { esc, productCard, recipeCard, shoppingRow, statePanel } from './ui/components.js';

const app = document.getElementById('app');
const today = () => new Date();
const ROUTES = ['inventory', 'recipes', 'shopping'];
const TITLES = { inventory: 'Продукты', recipes: 'Рецепты', shopping: 'Покупки' };

const state = {
  status: 'loading', error: '', user: null, products: [], shopping: [],
  storage: 'all', query: '', toast: null, shoppingError: '',
  authMode: 'login', authError: '', authFields: {}, authEmail: '', providers: null,
};
let undo = null;
let toastTimer = 0;

const OAUTH_ERRORS = {
  denied: 'Вход отменён. Можно попробовать ещё раз или войти по паролю',
  state: 'Не удалось подтвердить запрос входа. Попробуйте ещё раз',
  failed: 'Провайдер не ответил. Попробуйте позже или войдите по паролю',
  no_email: 'Провайдер не передал адрес почты. Разрешите доступ к email и повторите',
  unverified: 'Адрес почты не подтверждён у провайдера, поэтому войти нельзя',
};

const route = () => (ROUTES.includes(location.hash.slice(2)) ? location.hash.slice(2) : 'inventory');

/** Единая обработка ошибок API: 401 -> экран входа, остальное -> уведомление. */
function handle(e) {
  if (!(e instanceof ApiError)) throw e;
  if (e.status === 401) return logout('Сессия истекла, войдите снова');
  showToast(e.status === 403 ? 'Нет доступа к этой записи' : e.message);
  render();
}

function logout(message = '') {
  setToken(null);
  Object.assign(state, { status: 'auth', user: null, products: [], shopping: [], authError: message, authFields: {} });
  render();
  loadProviders();
}

/** Список включённых провайдеров OAuth (кнопки на экране входа). Сбой не критичен: остаётся вход по паролю. */
async function loadProviders() {
  if (state.providers) return;
  try { state.providers = (await api.providers()).providers; } catch { state.providers = []; }
  if (state.status === 'auth') render();
}

/** Возврат от провайдера: обмениваем одноразовый тикет из адреса на токен либо показываем причину отказа. */
async function finishOAuth() {
  const params = new URLSearchParams(location.hash.slice(1));
  const ticket = params.get('oauth_ticket'); const error = params.get('oauth_error');
  if (!ticket && !error) return false;
  history.replaceState(null, '', location.pathname + location.search); // тикет не должен оставаться в адресной строке и истории
  if (error) { Object.assign(state, { status: 'auth', authError: OAUTH_ERRORS[error] ?? OAUTH_ERRORS.failed }); render(); loadProviders(); return true; }
  try {
    setToken((await api.oauthExchange(ticket)).token);
    track('login', { method: 'oauth' });
    await loadAll();
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    Object.assign(state, { status: 'auth', authError: e.message });
    render(); loadProviders();
  }
  return true;
}

async function loadAll() {
  if (!getToken()) return logout();
  state.status = 'loading';
  render();
  try {
    [state.user, state.products, state.shopping] = await Promise.all([api.me(), api.listProducts(), api.listShopping()]);
    state.status = 'ready';
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return logout('Сессия истекла, войдите снова');
    state.status = 'error';
    state.error = e instanceof ApiError ? e.message : 'Что-то пошло не так';
  }
  render();
}

function showToast(text, undoFn = null) {
  clearTimeout(toastTimer);
  state.toast = text;
  undo = undoFn;
  toastTimer = setTimeout(() => { state.toast = null; undo = null; render(); }, 5000);
}

/* ---------- Разметка экранов ---------- */
function inventoryList() {
  const list = filterProducts(state.products, state, today());
  if (!state.products.length) return statePanel('empty', 'Тут пока пусто. Добавьте первый продукт кнопкой «+».');
  if (!list.length) return statePanel('empty', state.query ? `Ничего не найдено по запросу «${state.query}»` : 'В этом месте хранения пусто');
  return `<div class="grid">${list.map(productCard).join('')}</div>`;
}

function inventoryView() {
  const s = summarize(state.products, today());
  const chips = [['all', 'Все'], ...Object.entries(STORAGES)]
    .map(([k, v]) => `<button class="chip ${state.storage === k ? 'active' : ''}" data-action="storage" data-id="${k}" aria-pressed="${state.storage === k}">${v}</button>`).join('');
  return `<div class="summary" aria-label="Сводка по срокам">
      <span class="pill red">Просрочено/сегодня: ${s.red}</span><span class="pill orange">Скоро: ${s.orange}</span><span class="pill green">В норме: ${s.green}</span></div>
    <div class="toolbar"><button class="btn add" data-action="open-form">+ Добавить продукт</button><input id="search" type="search" placeholder="Поиск продуктов…" value="${esc(state.query)}" aria-label="Поиск">
      <div class="chips">${chips}</div></div>
    <div id="list">${inventoryList()}</div>
`;
}

function recipesView() {
  const isUrgent = (p) => { const f = filterProducts([p], {}, today())[0].freshness; return f.daysLeft !== null && f.daysLeft <= 3; };
  const { enough, matches } = matchRecipes(state.products, RECIPES, isUrgent);
  if (!enough) return statePanel('empty', 'Добавьте больше продуктов (хотя бы 3), чтобы увидеть рецепты');
  if (!matches.length) return statePanel('empty', 'Подходящих рецептов пока нет');
  return `<div class="grid recipes">${matches.map(recipeCard).join('')}</div>`;
}

function shoppingView() {
  return `<form class="add-row" data-form="shopping" novalidate>
      <input name="name" placeholder="Что купить?" aria-label="Название позиции" aria-invalid="${!!state.shoppingError}">
      <button class="btn">Добавить</button></form>
    ${state.shoppingError ? `<p class="field-error" role="alert">${esc(state.shoppingError)}</p>` : ''}
    ${state.shopping.length ? `<ul class="list">${state.shopping.map(shoppingRow).join('')}</ul>` : statePanel('empty', 'Список покупок пуст')}`;
}

function formDialog(errors = {}, v = {}) {
  const err = (k) => (errors[k] ? `<span class="field-error">${esc(errors[k])}</span>` : '');
  const opts = (items, cur) => items.map(([val, label]) => `<option value="${val}" ${cur === val ? 'selected' : ''}>${label}</option>`).join('');
  return `<form method="dialog" data-form="product" novalidate>
    <h2>Добавить продукт</h2>
    <label>Название<input name="name" value="${esc(v.name ?? '')}" aria-invalid="${!!errors.name}" autofocus>${err('name')}</label>
    <div class="two"><label>Количество<input name="quantity" inputmode="decimal" value="${esc(v.quantity ?? '1')}" aria-invalid="${!!errors.quantity}">${err('quantity')}</label>
      <label>Единица<select name="unit">${opts(UNITS.map((u) => [u, u]), v.unit ?? 'шт')}</select></label></div>
    <label>Место хранения<select name="storage">${opts(Object.entries(STORAGES), v.storage ?? 'fridge')}</select></label>
    <label>Срок годности (необязательно)<input type="date" name="expiresAt" value="${esc(v.expiresAt ?? '')}" aria-invalid="${!!errors.expiresAt}">${err('expiresAt')}</label>
    <div class="quick">${[3, 7, 14, 30].map((n) => `<button type="button" class="chip" data-action="quick" data-id="${n}">+${n} дн.</button>`).join('')}</div>
    <div class="dialog-actions"><button type="button" class="btn ghost" data-action="close-form">Отмена</button><button class="btn" value="save">Сохранить</button></div>
  </form>`;
}

function consumeDialog(product, error = '', v = {}) {
  const units = consumeUnits(product.unit);
  const presets = consumePresets(product.unit).map((n) => `<button type="button" class="chip" data-action="preset" data-id="${n}">${formatQty(n)} ${product.unit}</button>`).join('');
  return `<form method="dialog" data-form="consume" data-id="${esc(product.id)}" novalidate>
    <h2>Съедено: ${esc(product.name)}</h2>
    <p class="meta">Сейчас в наличии: <strong>${formatQty(product.quantity)} ${esc(product.unit)}</strong></p>
    <div class="two"><label>Сколько съели<input name="amount" inputmode="decimal" value="${esc(v.amount ?? '1')}" aria-invalid="${!!error}" autofocus></label>
      <label>Единица<select name="unit">${units.map((u) => `<option ${u === (v.unit ?? product.unit) ? 'selected' : ''}>${u}</option>`).join('')}</select></label></div>
    ${error ? `<span class="field-error" role="alert">${esc(error)}</span>` : ''}
    <div class="quick">${presets}<button type="button" class="chip" data-action="preset-all">Всё</button></div>
    <div class="dialog-actions"><button type="button" class="btn ghost" data-action="close-form">Отмена</button><button class="btn" value="save">Списать</button></div>
  </form>`;
}

function authView() {
  const reg = state.authMode === 'register';
  const err = (k) => (state.authFields[k] ? `<span class="field-error">${esc(state.authFields[k])}</span>` : '');
  const oauth = state.providers?.length
    ? `<div class="oauth">${state.providers.map((p) => `<a class="btn ghost oauth-btn" href="${esc(apiUrl(`/api/auth/oauth/${p.id}/start`))}">Войти через ${esc(p.label)}</a>`).join('')}</div><p class="divider"><span>или по email</span></p>`
    : '';
  return `<div class="shell auth"><h1>🥬 FreshKeep</h1>
    <form class="card auth-form" data-form="auth" novalidate>
      <h2>${reg ? 'Регистрация' : 'Вход'}</h2>
      ${oauth}
      <label>Email<input name="email" type="email" autocomplete="email" value="${esc(state.authEmail)}" aria-invalid="${!!state.authFields.email}">${err('email')}</label>
      <label>Пароль<input name="password" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" aria-invalid="${!!state.authFields.password}">${err('password')}</label>
      ${reg ? '<p class="meta">Не короче 8 символов, с буквой и цифрой</p>' : ''}
      ${state.authError ? `<p class="field-error" role="alert">${esc(state.authError)}</p>` : ''}
      <button class="btn">${reg ? 'Создать аккаунт' : 'Войти'}</button>
      <button type="button" class="link" data-action="switch-auth">${reg ? 'Уже есть аккаунт? Войти' : 'Нет аккаунта? Зарегистрироваться'}</button>
    </form></div>`;
}

/** Баннер согласия и переключатель аналитики: счётчик подключается только после явного «Разрешить». */
function consentUi() {
  if (!analyticsEnabled()) return '';
  const consent = getConsent();
  if (consent === null) {
    return `<div class="consent" role="dialog" aria-label="Аналитика"><p>Мы используем Яндекс.Метрику, чтобы понять, какие функции полезны. Названия продуктов и личные данные не передаются.</p>
      <div class="consent-actions"><button class="btn small" data-action="consent-yes">Разрешить</button><button class="btn small ghost" data-action="consent-no">Отклонить</button></div></div>`;
  }
  return `<p class="footer-note">Аналитика: ${consent === 'yes' ? 'включена' : 'выключена'} · <button class="link inline" data-action="consent-toggle">${consent === 'yes' ? 'выключить' : 'включить'}</button></p>`;
}

function render() {
  if (state.status === 'auth') { app.innerHTML = authView() + consentUi(); return; }
  const r = route();
  let body;
  if (state.status === 'loading') body = statePanel('loading');
  else if (state.status === 'error') body = statePanel('error', state.error);
  else body = { inventory: inventoryView, recipes: recipesView, shopping: shoppingView }[r]();
  const nav = ROUTES.map((k) => `<a href="#/${k}" class="${r === k ? 'active' : ''}" ${r === k ? 'aria-current="page"' : ''}>${TITLES[k]}</a>`).join('');
  app.innerHTML = `<div class="shell"><nav class="nav"><strong class="brand">🥬 FreshKeep</strong>${nav}<button class="logout" data-action="logout" title="${esc(state.user?.email ?? '')}">Выйти</button></nav>
    <main><h1>${r === 'inventory' ? 'Что в холодильнике?' : TITLES[r]}</h1>${body}</main>
    ${state.toast ? `<div class="toast" role="status">${esc(state.toast)}${undo ? ' <button data-action="undo">Отменить</button>' : ''}</div>` : ''}
    ${consentUi()}
    <dialog id="dlg" aria-label="Диалог"></dialog></div>`;
}

/* ---------- Действия ---------- */
const dlg = () => document.getElementById('dlg');
function openForm(errors, values) { dlg().innerHTML = formDialog(errors, values); if (!dlg().open) dlg().showModal(); }
function openConsume(id, error, values) {
  const product = state.products.find((p) => p.id === id);
  if (!product) return;
  dlg().innerHTML = consumeDialog(product, error, values);
  if (!dlg().open) dlg().showModal();
}

async function submitAuth(form) {
  const values = Object.fromEntries(new FormData(form));
  state.authEmail = values.email;
  try {
    const res = await (state.authMode === 'register' ? api.register(values) : api.login(values));
    setToken(res.token);
    track(state.authMode === 'register' ? 'sign_up' : 'login', { method: 'password' });
    Object.assign(state, { authError: '', authFields: {} });
    await loadAll();
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    Object.assign(state, { authFields: e.fields ?? {}, authError: e.fields ? '' : e.message });
    render();
  }
}

async function submitProduct(form) {
  const values = Object.fromEntries(new FormData(form));
  const res = validateProduct(values, today());
  if (!res.ok) return openForm(res.errors, values);
  try {
    const created = await api.createProduct(res.value);
    track('product_added', { storage: res.value.storage, has_expiry: Boolean(res.value.expiresAt) });
    state.products = [created, ...state.products];
    dlg().close();
    showToast(res.isExpired ? 'Добавлено (срок уже истёк)' : 'Продукт добавлен');
    render();
  } catch (e) {
    if (e instanceof ApiError && e.status === 422 && e.fields) return openForm(e.fields, values);
    dlg().close();
    handle(e);
  }
}

/** Удаление продукта; toShopping — «закончился»: добавляем в покупки (дубль 409 игнорируем). */
async function removeProduct(id, { toShopping }) {
  const item = state.products.find((p) => p.id === id);
  if (!item) return;
  try {
    await api.deleteProduct(id);
    track(toShopping ? 'product_finished' : 'product_deleted');
    let added = null;
    if (toShopping) {
      try { added = await api.addShopping(item.name); } catch (e) { if (!(e instanceof ApiError && e.status === 409)) throw e; }
    }
    state.products = state.products.filter((p) => p.id !== id);
    if (added) state.shopping = [added, ...state.shopping];
    showToast(toShopping ? `«${item.name}» закончилось и добавлено в покупки` : `«${item.name}» удалено`, async () => {
      try {
        const { id: _old, ...fields } = item;
        state.products = [await api.createProduct(fields), ...state.products];
        if (added) { await api.removeShopping(added.id); state.shopping = state.shopping.filter((s) => s.id !== added.id); }
      } catch (e) { handle(e); }
    });
    render();
  } catch (e) { handle(e); }
}

async function submitConsume(form) {
  const id = form.dataset.id;
  const product = state.products.find((p) => p.id === id);
  const values = Object.fromEntries(new FormData(form));
  const check = consumeProduct(product, values.amount, values.unit);
  if (!check.ok) return openConsume(id, check.error, values);
  dlg().close();
  if (check.finished) return removeProduct(id, { toShopping: true });
  try {
    const { product: updated } = await api.consume(id, values.amount, values.unit);
    track('product_consumed', { partial: true });
    state.products = state.products.map((p) => (p.id === id ? updated : p));
    showToast(`Съедено ${formatQty(check.eaten)} ${product.unit} · «${product.name}»: осталось ${formatQty(updated.quantity)} ${product.unit}`, async () => {
      try { const back = await api.patchProduct(id, { quantity: product.quantity }); state.products = state.products.map((p) => (p.id === id ? back : p)); } catch (e) { handle(e); }
    });
    render();
  } catch (e) {
    if (e instanceof ApiError && e.status === 422) return openConsume(id, e.message, values);
    handle(e);
  }
}

async function submitShopping(form) {
  const name = new FormData(form).get('name');
  const check = addShoppingItem(state.shopping, name, 'tmp');
  state.shoppingError = check.error ?? '';
  if (check.ok) {
    try { state.shopping = [await api.addShopping(name), ...state.shopping]; track('shopping_added'); }
    catch (e) { if (e instanceof ApiError && [409, 422].includes(e.status)) state.shoppingError = e.message; else return handle(e); }
  }
  render();
  if (state.shoppingError) document.querySelector('[name=name]')?.focus();
}

const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { handle(e); } };
const ACTIONS = {
  retry: loadAll,
  logout: async () => { track('logout'); try { await api.logout(); } catch { /* токен всё равно удаляется на этом устройстве */ } logout(); },
  'consent-yes': () => { setConsent('yes'); render(); },
  'consent-no': () => { setConsent('no'); render(); },
  'consent-toggle': () => { setConsent(getConsent() === 'yes' ? 'no' : 'yes'); render(); },
  'switch-auth': () => { state.authMode = state.authMode === 'login' ? 'register' : 'login'; Object.assign(state, { authError: '', authFields: {} }); render(); },
  storage: (id) => { state.storage = id; render(); },
  'open-form': () => openForm(),
  'close-form': () => dlg().close(),
  quick: (id) => { dlg().querySelector('[name=expiresAt]').value = toIso(addDays(today(), Number(id))); },
  eat: (id) => openConsume(id),
  preset: (id) => { dlg().querySelector('[name=amount]').value = id.replace('.', ','); },
  'preset-all': () => {
    const f = dlg().querySelector('form'); const p = state.products.find((x) => x.id === f.dataset.id);
    f.querySelector('[name=unit]').value = p.unit; f.querySelector('[name=amount]').value = formatQty(p.quantity);
  },
  delete: (id) => removeProduct(id, { toShopping: false }),
  undo: async () => { const fn = undo; state.toast = null; undo = null; render(); await fn?.(); render(); },
  toggle: guard(async (id) => {
    const item = state.shopping.find((i) => i.id === id);
    const updated = await api.toggleShopping(id, !item.isBought);
    state.shopping = state.shopping.map((i) => (i.id === id ? updated : i)); render();
  }),
  'remove-item': guard(async (id) => { await api.removeShopping(id); state.shopping = state.shopping.filter((i) => i.id !== id); render(); }),
  'add-missing': guard(async (id) => {
    const rec = RECIPES.find((r) => r.id === id);
    const { missing } = matchRecipes(state.products, [rec]).matches[0] ?? { missing: [] };
    let added = 0;
    for (const m of missing) {
      try { state.shopping = [await api.addShopping(m[0].toUpperCase() + m.slice(1)), ...state.shopping]; added++; }
      catch (e) { if (!(e instanceof ApiError && e.status === 409)) throw e; }
    }
    track('recipe_to_shopping', { count: added });
    showToast(`Добавлено в покупки: ${added}`); render();
  }),
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (el && ACTIONS[el.dataset.action]) ACTIONS[el.dataset.action](el.dataset.id);
});
document.addEventListener('change', (e) => { if (e.target.dataset.action === 'toggle') ACTIONS.toggle(e.target.dataset.id); });
document.addEventListener('input', (e) => {
  if (e.target.id !== 'search') return;
  state.query = e.target.value;
  document.getElementById('list').innerHTML = inventoryList(); // перерисовываем только список, чтобы не терять фокус
});
document.addEventListener('submit', (e) => {
  const kind = e.target.dataset.form;
  if (!kind) return;
  e.preventDefault();
  ({ auth: submitAuth, product: submitProduct, consume: submitConsume, shopping: submitShopping })[kind]?.(e.target);
});
window.addEventListener('hashchange', () => { render(); pageView(location.hash || '#/inventory'); });
initAnalytics();
finishOAuth().then((handled) => { if (!handled) loadAll(); });
