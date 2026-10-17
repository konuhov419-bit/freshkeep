// Чистые функции: данные -> HTML-строка. Тестируются без DOM.
import { STORAGES, formatQty } from '../domain/inventory.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Экранирование пользовательского ввода (защита от XSS). */
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

const ICON = { fridge: '🧊', freezer: '❄️', pantry: '🥫' };

export function productCard(p) {
  const f = p.freshness;
  return `<article class="card ${f.status}" data-id="${esc(p.id)}">
    <div class="card-top"><span class="emo" aria-hidden="true">${ICON[p.storage] ?? '🛒'}</span>
      <span class="badge ${f.status}">${esc(f.label)}</span></div>
    <h3>${esc(p.name)}</h3>
    <p class="meta">${esc(STORAGES[p.storage] ?? '')} · ${esc(formatQty(p.quantity))} ${esc(p.unit)}</p>
    <div class="bar" role="presentation"><i class="w${Math.round(f.ratio * 20) * 5}"></i></div>
    <div class="card-actions">
      <button class="btn small" data-action="eat" data-id="${esc(p.id)}">Съедено…</button>
      <button class="btn small ghost" data-action="delete" data-id="${esc(p.id)}" aria-label="Удалить ${esc(p.name)}">Удалить</button>
    </div></article>`;
}

/** Состояния экрана: loading / error / empty (ERR-5, ERR-7, ERR-8). */
export function statePanel(kind, message = '') {
  if (kind === 'loading') return `<div class="state" role="status"><div class="skeleton-grid">${'<div class="skeleton"></div>'.repeat(4)}</div><p>Загружаем продукты…</p></div>`;
  if (kind === 'error') return `<div class="state error" role="alert"><p>${esc(message || 'Что-то пошло не так')}</p><button class="btn" data-action="retry">Повторить</button></div>`;
  return `<div class="state"><p>${esc(message)}</p></div>`;
}

export function recipeCard({ recipe, have, total, missing }) {
  const miss = missing.length
    ? `<p class="meta">Не хватает: ${missing.map(esc).join(', ')}</p><button class="btn small" data-action="add-missing" data-id="${esc(recipe.id)}">Добавить недостающее в покупки</button>`
    : '<p class="meta ok-text">Все ингредиенты есть</p>';
  return `<article class="card"><h3>${esc(recipe.title)}</h3>
    <p class="meta">${recipe.minutes} мин · есть ${have} из ${total}</p>${miss}</article>`;
}

export function shoppingRow(item) {
  return `<li class="row ${item.isBought ? 'done' : ''}">
    <label><input type="checkbox" data-action="toggle" data-id="${esc(item.id)}" ${item.isBought ? 'checked' : ''}> <span>${esc(item.name)}</span></label>
    <button class="btn small ghost" data-action="remove-item" data-id="${esc(item.id)}" aria-label="Удалить ${esc(item.name)}">✕</button></li>`;
}
