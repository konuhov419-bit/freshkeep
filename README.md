# FreshKeep (ДЗ 6): веб-приложение + API + CI/CD и интеграции

Учёт продуктов, сроков годности, рецептов и покупок. Вход по email и паролю либо через Google / Яндекс ID, аналитика Яндекс.Метрика (по согласию), health-check, JSON-логи, пайплайн GitHub Actions с деплоем на Railway.

```bash
npm start        # http://localhost:5173  (Node.js 22.5+, npm install не нужен)
npm test         # 70 тестов
npm run ci       # lint + format:check + test + build — как в CI
npm run dev:oauth  # демо OAuth с поддельным провайдером, без реальных ключей
npm run analyze-logs -- logs/api.log
```
При первом запуске создаётся `.env` со случайным `JWT_SECRET`. Все настройки: `.env.example`.

## Документы
- [integration_documentation.md](integration_documentation.md): CI/CD, OAuth2, аналитика, мониторинг, логирование, оптимизация, использование AI
- [security_audit.md](security_audit.md): уязвимости, исправления, OWASP Top 10, рекомендации
- [docs/log_analysis_prompts.md](docs/log_analysis_prompts.md): промпты для анализа логов
- [backend_documentation.md](backend_documentation.md): API и архитектура (ДЗ 5)

## Структура
`web/` фронтенд · `server/` API · `migrations/` схема БД · `scripts/` линтер, сборка, бенчмарк, анализ логов · `.github/` workflows · `supabase/` схема PostgreSQL · `Dockerfile`, `railway.json` · `screenshots/`

## Деплой
Пуш в `main` → GitHub Actions → Railway. Настройка (секреты, том для БД, переменные) — раздел 1 integration_documentation.md. Ссылка на работающее приложение: _указать после деплоя_.
