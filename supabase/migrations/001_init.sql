-- FreshKeep: схема PostgreSQL для Supabase (или любого Postgres с совместимой auth.uid()).
-- Изоляция данных обеспечивается Row Level Security: пользователь видит и меняет только свои строки.

create table public.products (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 100),
  quantity   numeric(12,3) not null check (quantity > 0),
  unit       text not null check (unit in ('шт','г','кг','мл','л')),
  storage    text not null check (storage in ('fridge','freezer','pantry')),
  expires_at date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_products_user on public.products (user_id, expires_at);

create table public.shopping_items (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 100),
  name_key   text generated always as (lower(regexp_replace(btrim(name), '\s+', ' ', 'g'))) stored,
  is_bought  boolean not null default false,
  created_at timestamptz not null default now(),
  unique (user_id, name_key)
);

alter table public.products       enable row level security;
alter table public.shopping_items enable row level security;

-- Политики: только авторизованные и только свои строки (anon не получает ничего)
create policy products_select on public.products for select to authenticated using (user_id = auth.uid());
create policy products_insert on public.products for insert to authenticated with check (user_id = auth.uid());
create policy products_update on public.products for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy products_delete on public.products for delete to authenticated using (user_id = auth.uid());

create policy shopping_select on public.shopping_items for select to authenticated using (user_id = auth.uid());
create policy shopping_insert on public.shopping_items for insert to authenticated with check (user_id = auth.uid());
create policy shopping_update on public.shopping_items for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy shopping_delete on public.shopping_items for delete to authenticated using (user_id = auth.uid());

grant select, insert, update, delete on public.products, public.shopping_items to authenticated;
