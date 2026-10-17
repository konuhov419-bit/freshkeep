-- Дубликаты позиций списка покупок запрещены на уровне БД (US-10).
CREATE UNIQUE INDEX uq_shopping_user_name ON shopping_items(user_id, name_key);
