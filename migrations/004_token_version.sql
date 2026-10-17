-- Отзыв токенов: выход увеличивает версию, все ранее выданные токены перестают действовать.
ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;
