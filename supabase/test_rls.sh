#!/usr/bin/env bash
# Проверка RLS на локальном PostgreSQL (нужны initdb/pg_ctl/psql 14+). Запуск: bash supabase/test_rls.sh
set -euo pipefail
BIN=$(dirname "$(ls /usr/lib/postgresql/*/bin/initdb | tail -1)")
DIR=$(mktemp -d); chmod 777 "$DIR"; PORT=54329
RUN() { if [ "$(id -u)" = 0 ]; then runuser -u "${PGUSER_OS:-claude}" -- "$@"; else "$@"; fi; }
RUN "$BIN/initdb" -D "$DIR/data" -A trust -E UTF8 --locale=C.UTF-8 >/dev/null
RUN "$BIN/pg_ctl" -D "$DIR/data" -o "-p $PORT -k $DIR" -l "$DIR/log" -w start >/dev/null
trap 'RUN "$BIN/pg_ctl" -D "$DIR/data" -m fast stop >/dev/null; rm -rf "$DIR"' EXIT
[ "$(id -u)" = 0 ] && export PGUSER="${PGUSER_OS:-claude}"
P() { psql -h "$DIR" -p $PORT -d postgres -v ON_ERROR_STOP=1 -X -q -t -A "$@"; }
# Заглушка Supabase Auth: схема auth, таблица users, функция uid() читает claim из сессии
P <<'SQL'
create role authenticated nologin; create role anon nologin;
create schema auth; create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to authenticated, anon; grant usage on schema public to authenticated, anon;
insert into auth.users values ('00000000-0000-0000-0000-00000000000a'), ('00000000-0000-0000-0000-00000000000b');
SQL
P -f "$(dirname "$0")/migrations/001_init.sql" && echo "миграция применена"
A=00000000-0000-0000-0000-00000000000a; B=00000000-0000-0000-0000-00000000000b
as() { P -c "set role authenticated; set request.jwt.claim.sub='$1'; $2" 2>&1 || true; }
as $A "insert into products(name,quantity,unit,storage) values ('Яйца',10,'шт','fridge');" >/dev/null
echo "A видит своих строк: $(as $A 'select count(*) from products;' | tail -1)"
echo "B видит строк A:   $(as $B 'select count(*) from products;' | tail -1)"
echo "B update чужого (затронуто строк): $(as $B "with u as (update products set quantity=1 returning 1) select count(*) from u;" | tail -1)"
echo "B delete чужого (затронуто строк): $(as $B "with d as (delete from products returning 1) select count(*) from d;" | tail -1)"
echo "B insert от имени A: $(as $B "insert into products(user_id,name,quantity,unit,storage) values ('$A','X',1,'шт','fridge');" | grep -o 'row-level security policy[^\"]*' | head -1)"
echo "anon читает: $(P -c "set role anon; select count(*) from products;" 2>&1 | grep -o 'permission denied[^\"]*' | head -1)"
echo "CHECK quantity<=0: $(as $A "insert into products(name,quantity,unit,storage) values ('Z',0,'шт','fridge');" | grep -o 'violates check constraint[^\"]*' | head -1)"
as $A "insert into shopping_items(name) values ('Творог');" >/dev/null
echo "дубль покупок: $(as $A "insert into shopping_items(name) values ('  творог ');" | grep -o 'violates unique constraint[^\"]*' | head -1)"
echo "A после атак B: $(as $A 'select quantity from products;' | tail -1) (должно быть 10.000)"
