# FreshKeep: CI/CD и интеграции (ДЗ 6)

Содержание: 1. CI/CD · 2. OAuth2 · 3. Аналитика · 4. Платежи · 5. Мониторинг · 6. Логирование · 7. Оптимизация · 8. Использование AI · 9. Что сделано, а что требует действий владельца

Отчёт по безопасности: [security_audit.md](security_audit.md).

## 1. CI/CD (GitHub Actions + Railway)

Рабочее приложение: **https://freshkeep-production.up.railway.app** (проверка: `/api/ready`). Фактическая схема развёртывания: Railway подключён к GitHub-репозиторию и сам выкладывает каждый пуш в `main`; GitHub Actions выполняют проверки качества, а шаг деплоя через `RAILWAY_TOKEN` остаётся запасным вариантом (без токена пропускается).

Файлы: `.github/workflows/ci.yml` (основной), `uptime.yml`, `codeql.yml`, `.github/dependabot.yml`, `Dockerfile`, `railway.json`.

```
push / pull request в main
 ├─ quality  : npm run lint, npm run format:check
 ├─ test     : npm test (73 теста, node:test)
 ├─ audit    : npm audit --omit=dev
 └─ build    : npm run build + docker build  (после трёх выше)
        └─ deploy (только push в main): railway up → smoke-тест GET $APP_URL/api/ready
```

- Установка зависимостей — `npm ci --ignore-scripts` (зависимостей нет, шаг подтверждает целостность lock-файла).
- Линтер и форматтер — собственный `scripts/lint.js` (без внешних пакетов): `no-var`, `no-console`, `no-debugger`, `no-eval`, `eqeqeq`, `no-secrets`, `no-unused-imports`, проверка синтаксиса и форматирования (`npm run format` исправляет автоматически).
- Деплой безопасен по умолчанию: без секрета `RAILWAY_TOKEN` шаг выдаёт предупреждение и пропускается, пайплайн остаётся зелёным. Pull request никогда не деплоится.
- `concurrency` отменяет устаревшие прогоны, `permissions: contents: read` — минимальные права.
- `uptime.yml` каждые 30 минут обращается к `/api/ready`; при сбое задача падает и GitHub присылает письмо — это простейший алерт.

### Подключение (один раз)

1. Создайте репозиторий на GitHub и выполните `git push` в ветку `main`.
2. Railway → New Project → Deploy from GitHub (или пустой сервис `freshkeep`). Добавьте **Volume** с точкой монтирования `/app/data` (в нём лежит SQLite). Включите `Generate Domain`.
3. Переменные сервиса Railway (`PUBLIC_URL` с протоколом `https://` и без `/` на конце; при неверном значении сервер сразу пишет понятную ошибку): `JWT_SECRET` (≥32 символов), `PUBLIC_URL` (адрес сервиса), `TRUST_PROXY=1`, `LOG_FILE=-` (логи в stdout, Railway хранит и ищет их сам), по желанию `METRIKA_ID`, `GOOGLE_*`, `YANDEX_*`, `METRICS_TOKEN`.
   Если Railway подключает том с правами root, а приложение работает от пользователя `node`, SQLite не может создать файл («unable to open database file»). Это случилось при первом деплое; обходное решение: переменная `RAILWAY_RUN_UID=0`.
4. (Необязательно, для запасного деплоя из Actions) В Railway создайте Project Token (Settings → Tokens). В GitHub: Settings → Secrets and variables → Actions → секрет `RAILWAY_TOKEN`; переменные `APP_URL` (адрес сервиса) и при необходимости `RAILWAY_SERVICE`.
5. Тестовый коммит: `git commit --allow-empty -m "ci: проверка пайплайна" && git push` → вкладка Actions: все задачи зелёные, шаг smoke-теста печатает ответ `/api/ready`.

### Пример прогона локально

```
npm run ci     # lint + format:check + test + build — те же шаги, что в CI
```

## 2. OAuth2 (Google и Яндекс ID)

Провайдер включается, когда заданы обе переменные (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, `YANDEX_CLIENT_ID`/`YANDEX_CLIENT_SECRET`). Кнопки на экране входа появляются только для настроенных провайдеров (`GET /api/auth/providers`).

**Redirect URI** в консоли провайдера: `<PUBLIC_URL>/api/auth/oauth/google/callback` и `<PUBLIC_URL>/api/auth/oauth/yandex/callback`.

- Google: console.cloud.google.com → APIs & Services → OAuth consent screen (внешний, область `openid email profile`) → Credentials → Create OAuth client ID → Web application → Authorized redirect URIs.
- Яндекс: oauth.yandex.ru → Создать приложение → Платформа «Веб-сервисы», Callback URI, доступ «Адрес электронной почты» и «Доступ к логину, имени и фамилии».

Поток (Authorization Code + PKCE):

```
Браузер → GET /api/auth/oauth/google/start
        ← 302 на Google (state, code_challenge S256) + cookie fk_oauth (HttpOnly, SameSite=Lax)
Google  → GET /api/auth/oauth/google/callback?code&state
Сервер  : сверяет state с cookie, меняет code на токен (с code_verifier), берёт профиль,
          находит/создаёт пользователя, выдаёт тикет (60 с, одноразовый)
        ← 302 на /#oauth_ticket=…
Браузер → POST /api/auth/oauth/exchange {ticket} ← JWT
```

Ошибки возвращаются как `/#oauth_error=denied|state|failed|no_email|unverified`, интерфейс показывает понятное сообщение («Вход отменён. Можно попробовать ещё раз или войти по паролю»).

Правила связывания: аккаунт создаётся или привязывается только по **подтверждённому** провайдером email; при привязке к аккаунту с паролем пароль отключается, прежние токены отзываются (защита от предзахвата, см. аудит).

Тесты: `server/test/oauth.test.js` (9 тестов: успех, тикет одноразовый, отказ, неверный state, нет cookie, ошибки провайдера, нет email, неподтверждённый email, привязка, предзахват, Secure-cookie). Для ручной проверки без реальных ключей: `npm run dev:oauth` поднимает приложение и поддельного провайдера (кнопка «Войти через Google» работает целиком).

## 3. Аналитика (Яндекс.Метрика)

Счётчик создаётся на metrika.yandex.ru; номер записывается в `METRIKA_ID`. Вебвизор выключен, персональные данные не передаются, скрипт грузится **только после согласия** пользователя (баннер внизу экрана; выбор хранится в браузере и меняется в подвале).

CSP автоматически разрешает `mc.yandex.ru` только при заданном `METRIKA_ID`.

| Событие (цель) | Параметры | Когда |
|---|---|---|
| `register` / `login` | `method`: password/oauth | После успешного входа |
| `logout` | | Выход |
| `product_added` | `storage`, `has_expiry` | Добавлен продукт |
| `product_consumed` | `partial` | Списание (частичное или полное) |
| `shopping_added` / `shopping_bought` | | Покупки |
| `recipe_opened` | | Открыт рецепт |
| pageView | | Смена раздела (`#/recipes` и т.д.) |

Настройка в Метрике: Цели → Добавить цель → «JavaScript-событие» с идентификатором из таблицы.

Проверка (выполнена в Chromium, запросы к mc.yandex.ru перехвачены заглушкой): до согласия `ym` не загружен; после согласия вызван `init`; цели `login {method: oauth}`, `product_added {storage: fridge, has_expiry: true}`, pageView отправлены; после отключения новых событий нет. Юнит-тесты: `web/test/analytics.test.js`.

AI помогал составить каталог событий: промпт «Составь минимальный набор событий воронки для приложения учёта продуктов (регистрация → первый продукт → возвращение), без персональных данных».

## 4. Платежи

Шаг опциональный и **не реализован** осознанно: у приложения нет платных функций, а условия приёмки требуют минимум две интеграции (реализованы три: OAuth Google, OAuth Яндекс, Метрика). При необходимости схема такая: ЮKassa/Stripe в тестовом режиме, создание платежа на сервере, webhook с проверкой подписи и идемпотентностью.

## 5. Мониторинг

| Адрес | Назначение | Ответ |
|---|---|---|
| `GET /api/health` | процесс жив (liveness) | 200 `{status:"ok", version, uptime}` |
| `GET /api/ready` | готовность (readiness) | 200 `ok`; 200 `degraded` при сбое внешнего сервиса; **503** если недоступна БД |
| `GET /api/metrics` | Prometheus-метрики | Bearer `METRICS_TOKEN`; без токена в настройках 404, с неверным 401 |

`/api/ready` проверяет БД (`SELECT 1`) и доступность настроенных OAuth-провайдеров; сбой провайдера не выключает приложение (вход по паролю работает), а переводит статус в `degraded`.

Алерты:
1. **Railway healthcheck** (`railway.json` → `/api/ready`): неуспешный деплой откатывается, при падении сервис перезапускается.
2. **UptimeRobot** (бесплатно): New monitor → HTTP(s), URL `<PUBLIC_URL>/api/ready`, интервал 5 минут, уведомления на email/Telegram. Ключевое слово `"status":"ok"` отличает `degraded` от нормы.
3. **GitHub Actions `uptime.yml`**: резервная проверка раз в 30 минут с письмом при сбое.
4. Для Prometheus/Grafana: `scrape_configs` с `bearer_token`, путь `/api/metrics`.

## 6. Логирование

Формат — одна JSON-строка на событие:

```json
{"ts":"2026-10-17T10:00:41.120Z","level":"warn","service":"freshkeep","version":"3.0.0+ab12cd3","event":"auth.login_failed","ip":"a1b2c3d4"}
```

- Уровни `debug|info|warn|error` (`LOG_LEVEL`); 5xx и необработанные исключения — `error` со стеком и `reqId`.
- События: `http.request` (метод, путь, статус, мс), `auth.login/login_failed/locked/logout/register`, `oauth.provider_error`, `http.unhandled`, `server.started`, `config.warning`.
- Секреты маскируются автоматически (`[скрыто]`), IP хранится в виде короткого хэша.
- Хранение: файл `logs/api.log` (права 0600, ротация по размеру в `.1`) или stdout (`LOG_FILE=-`) — на Railway это централизованное хранение со встроенным поиском и экспортом; для внешних систем (Better Stack, Loki) подойдёт любой сборщик, читающий stdout.

### Анализ логов с AI

- Автоматический разбор: `npm run analyze-logs -- logs/api.log` (или `--json`). Находит необработанные ошибки, долю 5xx, подбор паролей, блокировки, сбои OAuth, медленные маршруты, 404-сканирование, повреждённые строки.
- Для вопросов к AI используйте промпты из [docs/log_analysis_prompts.md](docs/log_analysis_prompts.md).
- Пример на учебном логе с типичными проблемами: `docs/samples/problem.log` → `docs/samples/problem-report.txt` (все 8 заложенных проблем найдены; тесты в `scripts/test/analyze-logs.test.js`).

## 7. Оптимизация

Предложения AI (профилирование отдельных запросов, анализ размера загрузки) и результат (`npm run bench`, 400 продуктов, локально):

| Мера | Было | Стало |
|---|---|---|
| Первая загрузка страницы (11 файлов) | ≈ 51,6 КБ без сжатия | 19,7 КБ (gzip для ответов ≥1 КБ) |
| Повторная загрузка | полная | 73 байта (ETag → 304 на все файлы) |
| Чтение файлов статики | с диска на каждый запрос | кэш в памяти |
| `GET /api/products` на 400 записях | | 10,3 КБ по сети, p50 2,7 мс, p95 4,4 мс |
| Список покупок по пользователю | полное сканирование | индекс `idx_shopping_user_created` (миграция 005) |

Цифры измерены на локальной машине и не заменяют замеры на хостинге.

## 8. Использование AI

| Задача | Как использовался AI | Результат |
|---|---|---|
| CI/CD | Агент сгенерировал каркас `ci.yml` по промпту «GitHub Actions для Node 22 без зависимостей: lint, format, test, audit, build, деплой на Railway только из main, smoke-тест после выкладки» и дополнил защитой (пропуск без секрета, concurrency, минимальные права) | Файлы проверены разбором YAML и локальным запуском тех же команд |
| Аудит | OWASP-проход с гипотезами и падающими тестами | [security_audit.md](security_audit.md) |
| Логи | Скрипт `analyze-logs.js` и промпты для разбора | `docs/log_analysis_prompts.md` |
| Аналитика | Каталог событий воронки | таблица в разделе 3 |
| Оптимизация | Анализ размера загрузки и запросов | раздел 7 |

## 9. Что проверено, а что нужно сделать владельцу

Проверено в среде разработки: 70 автотестов, `lint`, `format:check`, `build`, `npm audit`, разбор YAML-файлов, сквозной сценарий в браузере (OAuth на поддельном провайдере, согласие и события Метрики, отзыв токена, 0 нарушений CSP).

**Не проверено или зависит от действий владельца:**
- шаг деплоя из Actions через `RAILWAY_TOKEN` (деплой фактически выполняет Railway по пушу в `main`);
- реальные `Client ID/Secret` Google и Яндекс (разделы 2) и счётчик Метрики (`METRIKA_ID`);
- монитор UptimeRobot (раздел 5);
- `Dockerfile` не собирался локально (в среде нет Docker-демона), его соберёт шаг `build` в CI.
