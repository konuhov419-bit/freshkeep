const norm = (s) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** FR-5.1 / US-10: добавление позиции без дублей. Возвращает {ok, items, error}. */
export function addShoppingItem(items, name, id) {
  const clean = (name ?? '').trim().replace(/\s+/g, ' ');
  if (!clean) return { ok: false, items, error: 'Введите название' };
  if (items.some((i) => norm(i.name) === norm(clean))) return { ok: false, items, error: 'Уже в списке' };
  return { ok: true, items: [{ id, name: clean, isBought: false }, ...items], error: null };
}
