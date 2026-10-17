import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';

const MIGRATIONS = new URL('../migrations/', import.meta.url);

/** Открывает БД и применяет непримёнённые миграции (migrations/*.sql по порядку имён), каждую в транзакции. */
export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const done = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    db.exec('BEGIN');
    try {
      db.exec(readFileSync(new URL(file, MIGRATIONS), 'utf8'));
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(file, new Date().toISOString());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`Миграция ${file} не применена: ${e.message}`);
    }
  }
  return db;
}
