# Ghostfolio для TrueNAS (с поддержкой Московской биржи)

Готовая сборка Ghostfolio **3.69.0** с интеграцией **MOEX** (акции, облигации,
включены по умолчанию) и русским интерфейсом (`/ru`).

## Состав

- `docker-compose.yml` — стек: `ghostfolio` + `postgres` + `redis`
- `.env.example` — шаблон переменных окружения (скопировать в `.env`)
- `Dockerfile` (в корне репозитория) — сборка образа с нашими изменениями

## Быстрый старт (SSH на TrueNAS)

Рекомендуемый способ — Docker Compose прямо на хосте TrueNAS
(доступен по SSH) или через Portainer-стек.

```sh
# 1. Скопируйте папку docker/truenas на TrueNAS
scp -r docker/truenas admin@truenas-ip:/mnt/tank/apps/ghostfolio/
ssh admin@truenas-ip

# 2. Настройте переменные окружения
cd /mnt/tank/apps/ghostfolio
cp .env.example .env
#  отредактируйте .env: секреты, пароли, ROOT_URL
#  сгенерируйте ключи:
#    openssl rand -hex 96    -> ACCESS_TOKEN_SALT
#    openssl rand -hex 64    -> JWT_SECRET_KEY

# 3. Соберите или загрузите образ Ghostfolio
#    Вариант А — собрать на TrueNAS (если есть исходники):
#      cd /path/to/ghostfolio && docker build -t ghostfolio/ghostfolio:truenas .
#    Вариант Б — собрать где угодно и перенести:
#      docker save ghostfolio/ghostfolio:truenas | ssh admin@truenas-ip docker load

# 4. Запуск
cd /mnt/tank/apps/ghostfolio && docker compose up -d
```

После запуска Ghostfolio будет доступен по адресу
`http://truenas-ip:3333`, русская версия — `http://truenas-ip:3333/ru`.

> `DATA_SOURCES` в `.env` включает `MOSCOW_EXCHANGE` — не убирайте его,
> иначе тикеры `.MOEX` перестанут работать.

## TrueNAS SCALE / Apps (GUI)

В TrueNAS Apps вы можете развернуть этот стек либо как Custom App, либо
перетащить `docker-compose.yml` в виде Portainer-стека:

1. **Apps → Discover Apps → Custom App** (или Portainer).
2. Укажите образ `ghostfolio/ghostfolio:truenas`.
3. В **Docker Compose** вставьте содержимое `docker-compose.yml`.
4. В блоке **Environment variables** задайте ключи из `.env.example`.
5. В **Storage** добавьте постоянный volume для Postgres
   (`pv-gostfolio` → подмонтировать в `/var/lib/postgresql/data`).
6. Запустите приложение.

## Переменные окружения

| Переменная        | Обязательно | Описание |
| ---               | ---         | ---      |
| `ACCESS_TOKEN_SALT` | ✅ | Соль для хэширования токенов. `openssl rand -hex 96` |
| `JWT_SECRET_KEY`  | ✅ | Ключ подписи JWT. `openssl rand -hex 64` |
| `DATABASE_URL`    | ✅ | `postgresql://user:pass@postgres:5432/ghostfolio-db` |
| `REDIS_PASSWORD`  | ✅ | Пароль Redis (указан и в `REDIS_PASSWORD`, и в `redis-server`). |
| `POSTGRES_*`      | ✅ | Учётка Postgres: `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`. |
| `ROOT_URL`        | ~ | Публичный URL (домен), если сайт открывается через прокси/DDNS. |
| `DATA_SOURCES`    | – | JSON-список провайдеров. По умолчанию `["COINGECKO","MANUAL","MOSCOW_EXCHANGE","YAHOO"]` |
| `ENABLE_FEATURE_CRON` | – | Фоновые задачи (сбор котировок/истории). По умолчанию `true`. |
| `ENABLE_FEATURE_SUBSCRIPTION` | – | Только для облачного плана. |

## Первичный вход

После старта откройте `http://truenas-ip:3333` и зарегистрируйте первого
пользователя — он станет администратором. Это стандартный поток Ghostfolio
(регистрация открыта по умолчанию; при необходимости её можно закрыть,
включив Google/OIDC-авторизацию).

Проверка MOEX:

- Поиск инструмента: `SBER.MOEX`, `GAZP.MOEX`, облигации — `SU26238RMFS4.MOEX`.
- Профиль и цена запрашиваются напрямую с биржи `iss.moex.com`.

## Резервное копирование

Данные хранятся в docker-томе `ghostfolio-truenas_postgres`.

```sh
docker exec gf-postgres pg_dump -U user ghostfolio-db > backup.sql
```

Восстановление:

```sh
docker exec -i gf-postgres psql -U user ghostfolio-db < backup.sql
```

Бэкап sql-файла достаточно для переноса между каталками (миграции
применятся сами при старте).

## Обновление

```sh
# 1. Остановить стек
cd /mnt/tank/apps/ghostfolio && docker compose down
# 2. Собрать свежую версию
docker build -t ghostfolio/ghostfolio:truenas .
# 3. Запустить (миграции применятся автоматически)
docker compose up -d
```

Данные БД в томе `ghostfolio-truenas_postgres` сохранятся.