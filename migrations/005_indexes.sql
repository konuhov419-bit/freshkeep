-- Оптимизация: список покупок читается по пользователю и дате.
CREATE INDEX idx_shopping_user_created ON shopping_items(user_id, created_at);
