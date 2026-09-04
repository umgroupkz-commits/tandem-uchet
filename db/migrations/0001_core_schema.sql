-- Ядро: справочники, пользователи, роли.
-- pgcrypto: на Supabase уже стоит в схеме extensions (команда — no-op), на своём сервере встанет в public.
create extension if not exists pgcrypto;

create table if not exists tandem.units (
  id        text primary key,
  name      text not null,
  precision int  not null default 0,
  iiko_id   uuid unique
);
insert into tandem.units (id, name, precision, iiko_id) values
  ('шт',   'штука',     0, 'cd19b5ea-1b32-a6e5-1df7-5d2784a0549a'),
  ('кг',   'килограмм', 3, '7ba81c3a-8de5-8f9d-fb9f-e39efcbc57cc'),
  ('л',    'литр',      3, '69859c74-db72-b006-cba5-326cf6f4fc6e'),
  ('порц', 'порция',    0, '6040d92d-e286-f4f9-a613-ed0e6fd241e1')
on conflict (id) do nothing;

create table if not exists tandem.item_groups (
  id         uuid primary key default gen_random_uuid(),
  parent_id  uuid references tandem.item_groups(id),
  name       text not null,
  sort_order int  not null default 0,
  active     boolean not null default true,
  iiko_id    uuid unique
);

alter table tandem.items
  add column if not exists group_id  uuid references tandem.item_groups(id),
  add column if not exists unit_id   text references tandem.units(id),
  add column if not exists item_type text not null default 'dish',
  add column if not exists iiko_id   uuid unique,
  add column if not exists for_sale  boolean not null default false;
alter table tandem.items drop constraint if exists items_item_type_check;
alter table tandem.items add constraint items_item_type_check
  check (item_type in ('goods','dish','prepared','service'));

-- всё, что уже есть, — продаваемая номенклатура точек
update tandem.items set for_sale = true where for_sale = false;
update tandem.items set unit_id = unit
  where unit_id is null and unit in (select id from tandem.units);
update tandem.items set item_type = case product_type
  when 'GOODS' then 'goods' when 'PREPARED' then 'prepared'
  when 'SERVICE' then 'service' else 'dish' end;

create sequence if not exists tandem.item_code_seq start 90000;

create table if not exists tandem.stores (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  point_id        text references tandem.points(id),
  organization_id uuid,
  active          boolean not null default true,
  sort_order      int not null default 0,
  iiko_id         uuid unique
);
alter table tandem.points
  add column if not exists default_store_id uuid references tandem.stores(id);

create table if not exists tandem.counteragents (
  id      uuid primary key default gen_random_uuid(),
  name    text not null,
  kind    text not null default 'other' check (kind in ('supplier','customer','employee','other')),
  bin     text,
  phone   text,
  note    text,
  active  boolean not null default true,
  iiko_id uuid unique
);

create table if not exists tandem.users (
  id              uuid primary key default gen_random_uuid(),
  login           text not null unique,
  name            text not null,
  role            text not null check (role in ('admin','owner','accountant','technologist','storekeeper')),
  pin_hash        text not null,
  must_change_pin boolean not null default true,
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);

create table if not exists tandem.sessions (
  token      text primary key,
  user_id    uuid not null references tandem.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table if not exists tandem.role_permissions (
  role    text not null,
  section text not null,
  action  text not null check (action in ('view','edit')),
  primary key (role, section, action)
);
insert into tandem.role_permissions (role, section, action)
select r, s, a from (values
  ('admin','nomenclature','view'),('admin','nomenclature','edit'),
  ('admin','stores','view'),('admin','stores','edit'),
  ('admin','counteragents','view'),('admin','counteragents','edit'),
  ('admin','users','view'),('admin','users','edit'),
  ('owner','nomenclature','view'),('owner','nomenclature','edit'),
  ('owner','stores','view'),('owner','stores','edit'),
  ('owner','counteragents','view'),('owner','counteragents','edit'),
  ('accountant','nomenclature','view'),('accountant','stores','view'),
  ('accountant','counteragents','view'),('accountant','counteragents','edit'),
  ('technologist','nomenclature','view'),('technologist','nomenclature','edit'),
  ('technologist','stores','view'),('technologist','counteragents','view'),
  ('storekeeper','nomenclature','view'),('storekeeper','stores','view'),
  ('storekeeper','counteragents','view')
) v(r, s, a)
on conflict do nothing;

-- первый администратор с временным PIN 0000: сменить при первом входе
insert into tandem.users (login, name, role, pin_hash, must_change_pin)
values ('admin', 'Администратор', 'admin', crypt('0000', gen_salt('bf')), true)
on conflict (login) do nothing;

-- доступ только через RPC: RLS без политик
alter table tandem.units            enable row level security;
alter table tandem.item_groups      enable row level security;
alter table tandem.stores           enable row level security;
alter table tandem.counteragents    enable row level security;
alter table tandem.users            enable row level security;
alter table tandem.sessions         enable row level security;
alter table tandem.role_permissions enable row level security;
