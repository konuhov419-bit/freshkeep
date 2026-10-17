-- OAuth2: связь аккаунта пользователя с учётной записью у провайдера (Google, Yandex ID).
CREATE TABLE oauth_identities (
  provider   TEXT NOT NULL,
  subject    TEXT NOT NULL,              -- идентификатор пользователя у провайдера (sub / id)
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX idx_oauth_user ON oauth_identities(user_id);
