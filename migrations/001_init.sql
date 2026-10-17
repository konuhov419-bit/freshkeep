-- Схема данных FreshKeep. Владелец каждой записи — пользователь (user_id): изоляция данных на уровне API.
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE products (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  quantity   REAL NOT NULL CHECK (quantity > 0),
  unit       TEXT NOT NULL CHECK (unit IN ('шт','г','кг','мл','л')),
  storage    TEXT NOT NULL CHECK (storage IN ('fridge','freezer','pantry')),
  expires_at TEXT,                       -- ГГГГ-ММ-ДД или NULL
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_products_user ON products(user_id, expires_at);

CREATE TABLE shopping_items (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  name_key   TEXT NOT NULL,              -- нормализованное имя для защиты от дублей
  is_bought  INTEGER NOT NULL DEFAULT 0 CHECK (is_bought IN (0,1)),
  created_at TEXT NOT NULL
);
