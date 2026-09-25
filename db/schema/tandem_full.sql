-- Полный снимок схемы учёта Тандем KZ (схема tandem + функции public.tandem_*).
-- Снят из боевой базы каталогом PostgreSQL 2026-09-18 запросом db/schema/snapshot-query.sql
-- и собран tools/build-schema-snapshot.mjs. Данных не содержит.
-- Миграции 0033 (касса, чеки, канал «карта») 0034 (расход для 1С) и 0035 (точки) внесены в снимок тем же содержанием без полного снятия каталога;
-- тела функций сверены с базой по md5. Следующее полное снятие перезапишет файл целиком.
-- Назначение: поднять пустую базу на собственном сервере одной командой
--   psql -v ON_ERROR_STOP=1 -f db/schema/tandem_full.sql
-- затем db/schema/tandem_seed.sql. Проверяется подъёмом в Docker и дымовым тестом (server/README.md).

set check_function_bodies = off;   -- функции ссылаются друг на друга и на таблицы: порядок создания не важен
create extension if not exists pgcrypto;
create extension if not exists btree_gist;
create schema if not exists tandem;
-- На Supabase pgcrypto живёт в схеме extensions, и функции ищут её в search_path; на своём сервере
-- схемы нет — создаём пустую, чтобы set search_path в функциях не ругался.
create schema if not exists extensions;

-- ---------------------------------------------------------------- последовательности
create sequence if not exists tandem.item_code_seq as bigint increment 1 minvalue 1 maxvalue 9223372036854775807 start 90000;
create sequence if not exists tandem.stock_moves_id_seq as bigint increment 1 minvalue 1 maxvalue 9223372036854775807 start 1;

-- ---------------------------------------------------------------- таблицы
create table if not exists tandem.assets (
  name text not null,
  content text not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists tandem.cash_expenses (
  id bigint generated always as identity not null,
  report_id bigint not null,
  purpose text not null,
  amount numeric not null,
  receipt_no text
);

create table if not exists tandem.chart_lines (
  id uuid default gen_random_uuid() not null,
  chart_id uuid not null,
  ingredient_code text not null,
  brutto numeric not null,
  netto numeric not null,
  output numeric not null,
  sort_order integer default 0 not null,
  note text
);

create table if not exists tandem.charts (
  id uuid default gen_random_uuid() not null,
  item_code text not null,
  date_from date default CURRENT_DATE not null,
  date_to date,
  output_amount numeric not null,
  technology text,
  note text,
  source text default 'office'::text not null,
  iiko_id uuid,
  created_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_by uuid,
  updated_at timestamp with time zone default now() not null
);

create table if not exists tandem.catalog_1c (
  code text not null,
  name text not null,
  unit text,
  account text
);

create table if not exists tandem.check_lines (
  id bigint generated always as identity not null,
  check_id bigint not null,
  item_code text not null,
  item_name text not null,
  qty numeric not null,
  price numeric not null,
  price_list numeric
);

create table if not exists tandem.checks (
  id bigint generated always as identity not null,
  uid uuid not null,
  point_id text not null,
  check_date date not null,
  no integer not null,
  seller text,
  pay_kind text not null,
  total numeric default 0 not null,
  status text default 'active'::text not null,
  void_reason text,
  edited boolean default false not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists tandem.counteragents (
  id uuid default gen_random_uuid() not null,
  name text not null,
  kind text default 'other'::text not null,
  bin text,
  phone text,
  note text,
  active boolean default true not null,
  iiko_id uuid
);

create table if not exists tandem.daily_reports (
  id bigint generated always as identity not null,
  point_id text not null,
  report_date date not null,
  shift_by text,
  cash numeric default 0 not null,
  kaspi_qr numeric default 0 not null,
  transfer numeric default 0 not null,
  qr_statement numeric,
  tr_statement numeric,
  cash_open numeric default 0 not null,
  cash_handed numeric default 0 not null,
  cash_counted numeric,
  comment text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  card numeric default 0 not null,
  closed_at timestamp with time zone
);

create table if not exists tandem.doc_counters (
  doc_type text not null,
  year integer not null,
  last_no integer default 0 not null
);

create table if not exists tandem.document_lines (
  id uuid default gen_random_uuid() not null,
  document_id uuid not null,
  line_kind text default 'item'::text not null,
  item_code text not null,
  qty numeric default 0 not null,
  unit_id text,
  price numeric,
  sum numeric,
  fact_qty numeric,
  calc_qty numeric,
  note text,
  sort_order integer default 0 not null
);

create table if not exists tandem.documents (
  id uuid default gen_random_uuid() not null,
  doc_type text not null,
  number text not null,
  doc_date date default CURRENT_DATE not null,
  status text default 'draft'::text not null,
  store_from uuid,
  store_to uuid,
  counteragent_id uuid,
  reason text,
  comment text,
  total_sum numeric,
  created_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_by uuid,
  updated_at timestamp with time zone default now() not null,
  posted_by uuid,
  posted_at timestamp with time zone,
  source_kind text,
  source_id text,
  ext_number text,
  ext_date date,
  sync_note text
);

create table if not exists tandem.item_aliases (
  alias text not null,
  item_code text not null,
  created_at timestamp with time zone default now()
);

create table if not exists tandem.item_groups (
  id uuid default gen_random_uuid() not null,
  parent_id uuid,
  name text not null,
  sort_order integer default 0 not null,
  active boolean default true not null,
  iiko_id uuid
);

create table if not exists tandem.item_prices (
  point_id text not null,
  item_code text not null,
  price numeric not null,
  source text default 'price_list_2026_08_21'::text
);

create table if not exists tandem.item_rank (
  point_id text not null,
  item_code text not null,
  rank integer not null,
  source text default 'iiko_olap_2026_08_21'::text not null,
  in_short_list boolean default false not null
);

create table if not exists tandem.items (
  code text not null,
  name text not null,
  category text,
  unit text default 'шт'::text not null,
  step numeric default 1 not null,
  cost numeric,
  price numeric,
  active boolean default true not null,
  source text,
  point_hint text,
  group_name text,
  artikul text,
  iiko_code text,
  note text,
  product_type text,
  has_chart boolean default false,
  synced_at timestamp with time zone,
  pack_factor numeric,
  pack_unit text,
  pack_price numeric,
  group_id uuid,
  unit_id text not null,
  item_type text default 'dish'::text not null,
  iiko_id uuid,
  for_sale boolean default false not null,
  cost_price numeric,
  cost_date date,
  cost_source text,
  code_1c text,
  k_1c numeric
);

create table if not exists tandem.pin_failures (
  id bigint generated always as identity not null,
  key text not null,
  at timestamp with time zone default now() not null
);

create table if not exists tandem.points (
  id text not null,
  name text not null,
  legal_entity text,
  mode text not null,
  sort_order integer default 100 not null,
  pin text not null,
  active boolean default true not null,
  note text,
  item_scopes text[] default '{}'::text[],
  item_categories text[],
  default_store_id uuid
);

create table if not exists tandem.realization_clients (
  id text not null,
  name text not null,
  active boolean default true not null,
  sort_order integer default 100
);

create table if not exists tandem.realization_ledger (
  id bigint generated always as identity not null,
  entry_date date default CURRENT_DATE not null,
  client_id text not null,
  delivered numeric default 0 not null,
  paid numeric default 0 not null,
  returned numeric default 0 not null,
  note text,
  created_by text,
  created_at timestamp with time zone default now()
);

create table if not exists tandem.role_permissions (
  role text not null,
  section text not null,
  action text not null
);

create table if not exists tandem.sale_lines (
  id bigint generated always as identity not null,
  report_id bigint not null,
  item_code text,
  item_name text not null,
  qty numeric default 0 not null,
  price numeric,
  price_list numeric
);

create table if not exists tandem.sessions (
  token text not null,
  user_id uuid not null,
  created_at timestamp with time zone default now() not null,
  expires_at timestamp with time zone not null
);

create table if not exists tandem.settings (
  key text not null,
  value text not null
);

create table if not exists tandem.stock_balances (
  store_id uuid not null,
  item_code text not null,
  qty numeric default 0 not null,
  avg_cost numeric default 0 not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists tandem.stock_moves (
  id bigint default nextval('tandem.stock_moves_id_seq'::regclass) not null,
  document_id uuid not null,
  line_id uuid,
  store_id uuid not null,
  item_code text not null,
  qty numeric not null,
  unit_cost numeric default 0 not null,
  move_date date not null,
  posted_at timestamp with time zone default now() not null
);

create table if not exists tandem.stores (
  id uuid default gen_random_uuid() not null,
  name text not null,
  point_id text,
  organization_id uuid,
  active boolean default true not null,
  sort_order integer default 0 not null,
  iiko_id uuid
);

create table if not exists tandem.takeout_lines (
  id bigint generated always as identity not null,
  report_id bigint not null,
  item_code text,
  item_name text not null,
  unit text default 'шт'::text not null,
  issued numeric default 0 not null,
  returned numeric default 0 not null,
  price numeric
);

create table if not exists tandem.units (
  id text not null,
  name text not null,
  "precision" integer default 0 not null,
  iiko_id uuid
);

create table if not exists tandem.user_stores (
  user_id uuid not null,
  store_id uuid not null
);

create table if not exists tandem.users (
  id uuid default gen_random_uuid() not null,
  login text not null,
  name text not null,
  role text not null,
  pin_hash text not null,
  must_change_pin boolean default true not null,
  active boolean default true not null,
  created_at timestamp with time zone default now() not null,
  failed_attempts integer default 0 not null,
  locked_until timestamp with time zone
);


-- ---------------------------------------------------------------- ограничения
alter table tandem.assets add constraint assets_pkey PRIMARY KEY (name);
alter table tandem.cash_expenses add constraint cash_expenses_amount_check CHECK ((amount > (0)::numeric));
alter table tandem.cash_expenses add constraint cash_expenses_pkey PRIMARY KEY (id);
alter table tandem.chart_lines add constraint chart_lines_brutto_check CHECK ((brutto >= (0)::numeric));
alter table tandem.chart_lines add constraint chart_lines_netto_check CHECK ((netto >= (0)::numeric));
alter table tandem.chart_lines add constraint chart_lines_output_check CHECK ((output >= (0)::numeric));
alter table tandem.chart_lines add constraint chart_lines_pkey PRIMARY KEY (id);
alter table tandem.charts add constraint charts_dates CHECK (((date_to IS NULL) OR (date_to >= date_from)));
alter table tandem.charts add constraint charts_iiko_id_key UNIQUE (iiko_id);
alter table tandem.charts add constraint charts_no_overlap EXCLUDE USING gist (item_code WITH =, daterange(date_from, date_to, '[]'::text) WITH &&);
alter table tandem.charts add constraint charts_output_amount_check CHECK ((output_amount > (0)::numeric));
alter table tandem.charts add constraint charts_pkey PRIMARY KEY (id);
alter table tandem.charts add constraint charts_source_check CHECK ((source = ANY (ARRAY['office'::text, 'iiko'::text])));
alter table tandem.counteragents add constraint counteragents_iiko_id_key UNIQUE (iiko_id);
alter table tandem.counteragents add constraint counteragents_kind_check CHECK ((kind = ANY (ARRAY['supplier'::text, 'customer'::text, 'employee'::text, 'other'::text])));
alter table tandem.counteragents add constraint counteragents_pkey PRIMARY KEY (id);
alter table tandem.catalog_1c add constraint catalog_1c_pkey PRIMARY KEY (code);
alter table tandem.check_lines add constraint check_lines_pkey PRIMARY KEY (id);
alter table tandem.check_lines add constraint check_lines_price_check CHECK ((price >= (0)::numeric));
alter table tandem.check_lines add constraint check_lines_qty_check CHECK ((qty > (0)::numeric));
alter table tandem.checks add constraint checks_pay_kind_check CHECK ((pay_kind = ANY (ARRAY['cash'::text, 'kaspi_qr'::text, 'transfer'::text, 'card'::text])));
alter table tandem.checks add constraint checks_pkey PRIMARY KEY (id);
alter table tandem.checks add constraint checks_point_id_check_date_no_key UNIQUE (point_id, check_date, no);
alter table tandem.checks add constraint checks_status_check CHECK ((status = ANY (ARRAY['active'::text, 'void'::text])));
alter table tandem.checks add constraint checks_uid_key UNIQUE (uid);
alter table tandem.daily_reports add constraint daily_reports_pkey PRIMARY KEY (id);
alter table tandem.daily_reports add constraint daily_reports_point_id_report_date_key UNIQUE (point_id, report_date);
alter table tandem.doc_counters add constraint doc_counters_pkey PRIMARY KEY (doc_type, year);
alter table tandem.document_lines add constraint document_lines_line_kind_check CHECK ((line_kind = ANY (ARRAY['item'::text, 'consume'::text])));
alter table tandem.document_lines add constraint document_lines_pkey PRIMARY KEY (id);
alter table tandem.document_lines add constraint document_lines_qty_check CHECK ((qty >= (0)::numeric));
alter table tandem.documents add constraint documents_doc_type_check CHECK ((doc_type = ANY (ARRAY['invoice_in'::text, 'transfer'::text, 'writeoff'::text, 'production'::text, 'inventory'::text, 'sale'::text])));
alter table tandem.documents add constraint documents_number_key UNIQUE (number);
alter table tandem.documents add constraint documents_pkey PRIMARY KEY (id);
alter table tandem.documents add constraint documents_reason_check CHECK (((reason IS NULL) OR (reason = ANY (ARRAY['spoilage'::text, 'tasting'::text, 'staff_meals'::text, 'other'::text]))));
alter table tandem.documents add constraint documents_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'posted'::text])));
alter table tandem.documents add constraint documents_stores_by_type CHECK (
CASE doc_type
    WHEN 'invoice_in'::text THEN ((store_to IS NOT NULL) AND (counteragent_id IS NOT NULL))
    WHEN 'transfer'::text THEN ((store_from IS NOT NULL) AND (store_to IS NOT NULL) AND (store_from <> store_to))
    ELSE (store_from IS NOT NULL)
END);
alter table tandem.item_aliases add constraint item_aliases_pkey PRIMARY KEY (alias);
alter table tandem.item_groups add constraint item_groups_iiko_id_key UNIQUE (iiko_id);
alter table tandem.item_groups add constraint item_groups_pkey PRIMARY KEY (id);
alter table tandem.item_prices add constraint item_prices_pkey PRIMARY KEY (point_id, item_code);
alter table tandem.item_rank add constraint item_rank_pkey PRIMARY KEY (point_id, item_code);
alter table tandem.items add constraint items_cost_source_check CHECK (((cost_source IS NULL) OR (cost_source = ANY (ARRAY['iiko_invoice'::text, 'manual'::text, 'document'::text]))));
alter table tandem.items add constraint items_iiko_id_key UNIQUE (iiko_id);
alter table tandem.items add constraint items_item_type_check CHECK ((item_type = ANY (ARRAY['goods'::text, 'dish'::text, 'prepared'::text, 'service'::text])));
alter table tandem.items add constraint items_pkey PRIMARY KEY (code);
alter table tandem.pin_failures add constraint pin_failures_pkey PRIMARY KEY (id);
alter table tandem.points add constraint points_mode_check CHECK ((mode = ANY (ARRAY['position'::text, 'takeout'::text, 'import'::text, 'manual'::text, 'checks'::text])));
alter table tandem.points add constraint points_pkey PRIMARY KEY (id);
alter table tandem.realization_clients add constraint realization_clients_pkey PRIMARY KEY (id);
alter table tandem.realization_ledger add constraint realization_ledger_pkey PRIMARY KEY (id);
alter table tandem.role_permissions add constraint role_permissions_action_check CHECK ((action = ANY (ARRAY['view'::text, 'edit'::text])));
alter table tandem.role_permissions add constraint role_permissions_pkey PRIMARY KEY (role, section, action);
alter table tandem.sale_lines add constraint sale_lines_pkey PRIMARY KEY (id);
alter table tandem.sale_lines add constraint sale_lines_report_id_item_name_key UNIQUE (report_id, item_name);
alter table tandem.sessions add constraint sessions_pkey PRIMARY KEY (token);
alter table tandem.settings add constraint settings_pkey PRIMARY KEY (key);
alter table tandem.stock_balances add constraint stock_balances_pkey PRIMARY KEY (store_id, item_code);
alter table tandem.stock_moves add constraint stock_moves_pkey PRIMARY KEY (id);
alter table tandem.stores add constraint stores_iiko_id_key UNIQUE (iiko_id);
alter table tandem.stores add constraint stores_pkey PRIMARY KEY (id);
alter table tandem.takeout_lines add constraint takeout_lines_pkey PRIMARY KEY (id);
alter table tandem.takeout_lines add constraint takeout_lines_report_id_item_name_key UNIQUE (report_id, item_name);
alter table tandem.units add constraint units_iiko_id_key UNIQUE (iiko_id);
alter table tandem.units add constraint units_pkey PRIMARY KEY (id);
alter table tandem.user_stores add constraint user_stores_pkey PRIMARY KEY (user_id, store_id);
alter table tandem.users add constraint users_login_key UNIQUE (login);
alter table tandem.users add constraint users_pkey PRIMARY KEY (id);
alter table tandem.users add constraint users_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'owner'::text, 'accountant'::text, 'technologist'::text, 'storekeeper'::text])));

-- ---------------------------------------------------------------- индексы
CREATE INDEX chart_lines_chart_idx ON tandem.chart_lines USING btree (chart_id);
CREATE INDEX check_lines_check_idx ON tandem.check_lines USING btree (check_id);
CREATE INDEX chart_lines_ingredient_idx ON tandem.chart_lines USING btree (ingredient_code);
CREATE INDEX charts_item_idx ON tandem.charts USING btree (item_code, date_from DESC);
CREATE INDEX document_lines_doc_idx ON tandem.document_lines USING btree (document_id, line_kind, sort_order);
CREATE INDEX documents_date_idx ON tandem.documents USING btree (doc_date DESC, created_at DESC);
CREATE UNIQUE INDEX documents_source_idx ON tandem.documents USING btree (source_kind, source_id) WHERE (source_kind IS NOT NULL);
CREATE INDEX documents_type_status_idx ON tandem.documents USING btree (doc_type, status);
CREATE INDEX items_group_idx ON tandem.items USING btree (group_name);
CREATE INDEX items_point_idx ON tandem.items USING btree (point_hint);
CREATE INDEX pin_failures_at ON tandem.pin_failures USING btree (at);
CREATE INDEX pin_failures_key_at ON tandem.pin_failures USING btree (key, at);
CREATE INDEX sessions_user_idx ON tandem.sessions USING btree (user_id);
CREATE INDEX stock_moves_doc_idx ON tandem.stock_moves USING btree (document_id);
CREATE INDEX stock_moves_replay_idx ON tandem.stock_moves USING btree (store_id, item_code, id);
CREATE INDEX stock_moves_store_item_idx ON tandem.stock_moves USING btree (store_id, item_code, move_date, id);

-- ---------------------------------------------------------------- внешние ключи
alter table tandem.cash_expenses add constraint cash_expenses_report_id_fkey FOREIGN KEY (report_id) REFERENCES tandem.daily_reports(id) ON DELETE CASCADE;
alter table tandem.chart_lines add constraint chart_lines_chart_id_fkey FOREIGN KEY (chart_id) REFERENCES tandem.charts(id) ON DELETE CASCADE;
alter table tandem.chart_lines add constraint chart_lines_ingredient_code_fkey FOREIGN KEY (ingredient_code) REFERENCES tandem.items(code);
alter table tandem.charts add constraint charts_created_by_fkey FOREIGN KEY (created_by) REFERENCES tandem.users(id);
alter table tandem.charts add constraint charts_item_code_fkey FOREIGN KEY (item_code) REFERENCES tandem.items(code);
alter table tandem.charts add constraint charts_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES tandem.users(id);
alter table tandem.daily_reports add constraint daily_reports_point_id_fkey FOREIGN KEY (point_id) REFERENCES tandem.points(id);
alter table tandem.document_lines add constraint document_lines_document_id_fkey FOREIGN KEY (document_id) REFERENCES tandem.documents(id) ON DELETE CASCADE;
alter table tandem.document_lines add constraint document_lines_item_code_fkey FOREIGN KEY (item_code) REFERENCES tandem.items(code);
alter table tandem.document_lines add constraint document_lines_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES tandem.units(id);
alter table tandem.documents add constraint documents_counteragent_id_fkey FOREIGN KEY (counteragent_id) REFERENCES tandem.counteragents(id);
alter table tandem.documents add constraint documents_created_by_fkey FOREIGN KEY (created_by) REFERENCES tandem.users(id);
alter table tandem.documents add constraint documents_posted_by_fkey FOREIGN KEY (posted_by) REFERENCES tandem.users(id);
alter table tandem.documents add constraint documents_store_from_fkey FOREIGN KEY (store_from) REFERENCES tandem.stores(id);
alter table tandem.documents add constraint documents_store_to_fkey FOREIGN KEY (store_to) REFERENCES tandem.stores(id);
alter table tandem.documents add constraint documents_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES tandem.users(id);
alter table tandem.item_groups add constraint item_groups_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES tandem.item_groups(id);
alter table tandem.item_prices add constraint item_prices_point_id_fkey FOREIGN KEY (point_id) REFERENCES tandem.points(id) ON DELETE CASCADE;
alter table tandem.item_rank add constraint item_rank_point_id_fkey FOREIGN KEY (point_id) REFERENCES tandem.points(id) ON DELETE CASCADE;
alter table tandem.items add constraint items_group_id_fkey FOREIGN KEY (group_id) REFERENCES tandem.item_groups(id);
alter table tandem.items add constraint items_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES tandem.units(id);
alter table tandem.points add constraint points_default_store_id_fkey FOREIGN KEY (default_store_id) REFERENCES tandem.stores(id);
alter table tandem.realization_ledger add constraint realization_ledger_client_id_fkey FOREIGN KEY (client_id) REFERENCES tandem.realization_clients(id);
alter table tandem.sale_lines add constraint sale_lines_item_code_fkey FOREIGN KEY (item_code) REFERENCES tandem.items(code);
alter table tandem.sale_lines add constraint sale_lines_report_id_fkey FOREIGN KEY (report_id) REFERENCES tandem.daily_reports(id) ON DELETE CASCADE;
alter table tandem.sessions add constraint sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES tandem.users(id) ON DELETE CASCADE;
alter table tandem.stock_balances add constraint stock_balances_item_code_fkey FOREIGN KEY (item_code) REFERENCES tandem.items(code);
alter table tandem.stock_balances add constraint stock_balances_store_id_fkey FOREIGN KEY (store_id) REFERENCES tandem.stores(id);
alter table tandem.stock_moves add constraint stock_moves_document_id_fkey FOREIGN KEY (document_id) REFERENCES tandem.documents(id) ON DELETE RESTRICT;
alter table tandem.stock_moves add constraint stock_moves_item_code_fkey FOREIGN KEY (item_code) REFERENCES tandem.items(code);
alter table tandem.stock_moves add constraint stock_moves_line_id_fkey FOREIGN KEY (line_id) REFERENCES tandem.document_lines(id) ON DELETE SET NULL;
alter table tandem.stock_moves add constraint stock_moves_store_id_fkey FOREIGN KEY (store_id) REFERENCES tandem.stores(id);
alter table tandem.stores add constraint stores_point_id_fkey FOREIGN KEY (point_id) REFERENCES tandem.points(id);
alter table tandem.takeout_lines add constraint takeout_lines_item_code_fkey FOREIGN KEY (item_code) REFERENCES tandem.items(code);
alter table tandem.takeout_lines add constraint takeout_lines_report_id_fkey FOREIGN KEY (report_id) REFERENCES tandem.daily_reports(id) ON DELETE CASCADE;
alter table tandem.user_stores add constraint user_stores_store_id_fkey FOREIGN KEY (store_id) REFERENCES tandem.stores(id) ON DELETE CASCADE;
alter table tandem.user_stores add constraint user_stores_user_id_fkey FOREIGN KEY (user_id) REFERENCES tandem.users(id) ON DELETE CASCADE;
alter table tandem.items add constraint items_code_1c_fkey FOREIGN KEY (code_1c) REFERENCES tandem.catalog_1c(code);
alter table tandem.check_lines add constraint check_lines_check_id_fkey FOREIGN KEY (check_id) REFERENCES tandem.checks(id) ON DELETE CASCADE;
alter table tandem.check_lines add constraint check_lines_item_code_fkey FOREIGN KEY (item_code) REFERENCES tandem.items(code);
alter table tandem.checks add constraint checks_point_id_fkey FOREIGN KEY (point_id) REFERENCES tandem.points(id);

-- ---------------------------------------------------------------- владельцы последовательностей
alter sequence tandem.stock_moves_id_seq owned by tandem.stock_moves.id;

-- ---------------------------------------------------------------- функции
CREATE OR REPLACE FUNCTION public.tandem_api(action text, payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'tandem', 'public'
AS $function$
declare
  v_pin        text := coalesce(payload->>'pin','');
  v_point      text := payload->>'point_id';
  v_date       date;
  v_owner_pin  text;
  v_driver_pin text;
  v_id         bigint;
  v_res        jsonb;
  v_scopes     text[];
  v_cats       text[];
  v_q          text := btrim(coalesce(payload->>'q',''));
  v_from       date;
  v_to         date;
begin
  select value into v_owner_pin  from tandem.settings where key = 'owner_pin';
  select value into v_driver_pin from tandem.settings where key = 'driver_pin';

  if action = 'points' then
    return (select coalesce(jsonb_agg(jsonb_build_object(
              'id', id, 'name', name, 'mode', mode, 'legal_entity', legal_entity) order by sort_order), '[]'::jsonb)
            from tandem.points where active);
  end if;

  if action = 'login' then
    if v_pin = v_owner_pin then
      return jsonb_build_object('ok', true, 'role', 'owner');
    end if;
    if v_pin = v_driver_pin then
      return jsonb_build_object('ok', true, 'role', 'driver');
    end if;
    if exists (select 1 from tandem.points where id = v_point and pin = v_pin and active) then
      return jsonb_build_object('ok', true, 'role', 'point',
        'point', (select jsonb_build_object('id',id,'name',name,'mode',mode)
                  from tandem.points where id = v_point));
    end if;
    return jsonb_build_object('ok', false, 'error', 'Неверный код');
  end if;

  if action in ('items','get_report','save_report','aliases','check_save','check_void','check_list') then
    if v_pin <> v_owner_pin
       and not exists (select 1 from tandem.points where id = v_point and pin = v_pin and active) then
      return jsonb_build_object('ok', false, 'error', 'Нет доступа');
    end if;
  end if;

  if action = 'items' then
    select item_scopes, item_categories into v_scopes, v_cats
      from tandem.points where id = v_point;
    return jsonb_build_object('ok', true, 'items', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'code', code, 'name', name, 'category', category, 'unit', unit,
        'price', price, 'artikul', artikul, 'iiko_code', iiko_code,
        'rank', rank, 'short', short, 'has_chart', has_chart,
        'pack_factor', pack_factor, 'pack_unit', pack_unit, 'pack_price', pack_price)
        order by category, name), '[]'::jsonb)
      from (
        select i.code, i.name, i.category, i.unit,
               coalesce(pp.price, i.price)   as price,
               i.artikul, i.iiko_code, r.rank,
               coalesce(r.in_short_list,false) as short,
               coalesce(i.has_chart,false)     as has_chart,
               i.pack_factor, i.pack_unit, i.pack_price
        from tandem.items i
        left join tandem.item_rank   r  on r.item_code  = i.code and r.point_id  = v_point
        left join tandem.item_prices pp on pp.item_code = i.code and pp.point_id = v_point
        where i.active and i.for_sale
          and (
            case
              when v_cats is not null and cardinality(v_cats) > 0 then i.category = any(v_cats)
              when v_scopes is null or cardinality(v_scopes) = 0 then true
              else i.point_hint = any(v_scopes)
            end
          )
          and (v_q = '' or i.name ilike '%' || v_q || '%')
        order by i.category, i.name
        limit 5000   -- было 1200: у Актау после включения штучных товаров 1231 позиция, хвост списка пропадал
      ) s));
  end if;

  -- Карта соответствий для импорта: названия чужой программы → код номенклатуры.
  if action = 'aliases' then
    return jsonb_build_object('ok', true, 'aliases', (
      select coalesce(jsonb_object_agg(alias, item_code), '{}'::jsonb) from tandem.item_aliases));
  end if;

  if action = 'get_report' then
    v_date := (payload->>'date')::date;
    select to_jsonb(v) into v_res from tandem.v_daily v
      where v.point_id = v_point and v.report_date = v_date;
    if v_res is null then
      return jsonb_build_object('ok', true, 'report', null, 'expenses','[]'::jsonb,
                                'takeout','[]'::jsonb, 'sales','[]'::jsonb);
    end if;
    select id into v_id from tandem.daily_reports
      where point_id = v_point and report_date = v_date;
    return jsonb_build_object('ok', true, 'report', v_res,
      'expenses', (select coalesce(jsonb_agg(jsonb_build_object(
          'purpose',purpose,'amount',amount,'receipt_no',receipt_no) order by id),'[]'::jsonb)
        from tandem.cash_expenses where report_id = v_id),
      'takeout', (select coalesce(jsonb_agg(jsonb_build_object(
          'item_code',item_code,'item_name',item_name,'unit',unit,
          'issued',issued,'returned',returned,'price',price) order by id),'[]'::jsonb)
        from tandem.takeout_lines where report_id = v_id),
      'sales', (select coalesce(jsonb_agg(jsonb_build_object(
          'item_code',item_code,'item_name',item_name,'qty',qty,
          'price',price,'price_list',price_list) order by id),'[]'::jsonb)
        from tandem.sale_lines where report_id = v_id));
  end if;

  if action = 'save_report' then
    v_date := (payload->>'date')::date;

    insert into tandem.daily_reports as d
      (point_id, report_date, shift_by, cash, kaspi_qr, transfer, card,
       qr_statement, tr_statement, cash_open, cash_handed, cash_counted, comment)
    values (v_point, v_date, payload->>'shift_by',
       coalesce((payload->>'cash')::numeric,0),
       coalesce((payload->>'kaspi_qr')::numeric,0),
       coalesce((payload->>'transfer')::numeric,0),
       coalesce((payload->>'card')::numeric,0),
       nullif(payload->>'qr_statement','')::numeric,
       nullif(payload->>'tr_statement','')::numeric,
       coalesce((payload->>'cash_open')::numeric,0),
       coalesce((payload->>'cash_handed')::numeric,0),
       nullif(payload->>'cash_counted','')::numeric,
       payload->>'comment')
    on conflict (point_id, report_date) do update set
       shift_by = excluded.shift_by, cash = excluded.cash,
       kaspi_qr = excluded.kaspi_qr, transfer = excluded.transfer, card = excluded.card,
       qr_statement = excluded.qr_statement, tr_statement = excluded.tr_statement,
       cash_open = excluded.cash_open, cash_handed = excluded.cash_handed,
       cash_counted = excluded.cash_counted, comment = excluded.comment,
       updated_at = now()
    returning d.id into v_id;

    delete from tandem.cash_expenses where report_id = v_id;
    insert into tandem.cash_expenses (report_id, purpose, amount, receipt_no)
    select v_id, e->>'purpose', (e->>'amount')::numeric, nullif(e->>'receipt_no','')
    from jsonb_array_elements(coalesce(payload->'expenses','[]'::jsonb)) e
    where coalesce((e->>'amount')::numeric,0) > 0;

    delete from tandem.takeout_lines where report_id = v_id;
    insert into tandem.takeout_lines (report_id, item_code, item_name, unit, issued, returned, price)
    select v_id, nullif(t->>'item_code',''), t->>'item_name', coalesce(t->>'unit','шт'),
           coalesce((t->>'issued')::numeric,0), coalesce((t->>'returned')::numeric,0),
           nullif(t->>'price','')::numeric
    from jsonb_array_elements(coalesce(payload->'takeout','[]'::jsonb)) t
    where coalesce(t->>'item_name','') <> '';

    delete from tandem.sale_lines where report_id = v_id;
    insert into tandem.sale_lines (report_id, item_code, item_name, qty, price, price_list)
    select v_id, nullif(s->>'item_code',''), s->>'item_name',
           coalesce((s->>'qty')::numeric,0), nullif(s->>'price','')::numeric,
           nullif(s->>'price_list','')::numeric
    from jsonb_array_elements(coalesce(payload->'sales','[]'::jsonb)) s
    where coalesce(s->>'item_name','') <> '' and coalesce((s->>'qty')::numeric,0) <> 0;

    -- Касса (режим «чеки»): первичка — чеки. Деньги по каналам и строки продаж отчёта
    -- пересобираются из них, присланное формой не учитывается; сохранение отчёта = закрытие смены.
    if (select mode from tandem.points where id = v_point) = 'checks' then
      perform tandem.check_rollup(v_point, v_date);
      update tandem.daily_reports set closed_at = now() where id = v_id;
    end if;

    -- Подпроект 4: отчёт порождает складской документ «Продажа». Сбой склада не должен
    -- мешать точке сдать отчёт — деньги важнее, продажу пересчитают из бэк-офиса.
    -- Сбой не прячется: пометка на документе (если он уже есть) и состояние в списке продаж.
    begin
      perform tandem.sale_sync(v_id);
    exception when others then
      begin
        update tandem.documents set sync_note = 'Сбой при сохранении отчёта: ' || sqlerrm
               || ' — нажмите «Провести продажи за период»'
          where source_kind = 'daily_report' and source_id = v_id::text;
      exception when others then
        null;
      end;
    end;

    select to_jsonb(v) into v_res from tandem.v_daily v where v.id = v_id;
    return jsonb_build_object('ok', true, 'report', v_res);
  end if;

  -- ---------- касса: чеки в течение дня ----------
  if action in ('check_save','check_void','check_list') then
    if (select mode from tandem.points where id = v_point) is distinct from 'checks' then
      return jsonb_build_object('ok', false, 'error', 'У этой точки касса не включена');
    end if;
    if action = 'check_save' then return tandem.check_save(v_point, payload); end if;
    if action = 'check_void' then return tandem.check_void(v_point, payload); end if;
    return tandem.check_list(v_point, coalesce(nullif(payload->>'date','')::date, current_date));
  end if;

  if action = 'dashboard' then
    if v_pin <> v_owner_pin then
      return jsonb_build_object('ok', false, 'error', 'Нет доступа');
    end if;
    v_from := coalesce((payload->>'from')::date, current_date - 30);
    v_to   := coalesce((payload->>'to')::date, current_date);
    return jsonb_build_object('ok', true,
      'rows', (select coalesce(jsonb_agg(to_jsonb(v) order by v.report_date desc, v.point_name), '[]'::jsonb)
               from tandem.v_daily v
               where v.report_date between v_from and v_to),
      'points', (select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'mode',mode) order by sort_order),'[]'::jsonb)
                 from tandem.points where active),
      -- Выручка по каналам и юрлицам за период
      'channels', (select jsonb_build_object(
          'cash', coalesce(sum(d.cash),0), 'kaspi_qr', coalesce(sum(d.kaspi_qr),0),
          'transfer', coalesce(sum(d.transfer),0), 'card', coalesce(sum(d.card),0))
        from tandem.daily_reports d where d.report_date between v_from and v_to),
      'by_legal', (select coalesce(jsonb_agg(jsonb_build_object(
          'legal', t.legal_entity, 'revenue', t.rev) order by t.rev desc), '[]'::jsonb)
        from (select p.legal_entity, sum(d.cash + d.kaspi_qr + d.transfer + d.card) rev
              from tandem.daily_reports d join tandem.points p on p.id = d.point_id
              where d.report_date between v_from and v_to
              group by p.legal_entity) t),
      -- Что продано: топ-20 позиций по сумме (продажи + заборный лист)
      'top_items', (select coalesce(jsonb_agg(jsonb_build_object(
          'name', t.item_name, 'qty', t.q, 'amount', t.amt,
          'discount', t.disc) order by t.amt desc), '[]'::jsonb)
        from (
          select item_name, sum(q) q, sum(amt) amt, sum(disc) disc from (
            select s.item_name, s.qty q, s.qty * coalesce(s.price,0) amt,
                   s.qty * greatest(coalesce(s.price_list, s.price, 0) - coalesce(s.price,0), 0) disc
            from tandem.sale_lines s
            join tandem.daily_reports d on d.id = s.report_id
            where d.report_date between v_from and v_to
            union all
            select t.item_name, (t.issued - t.returned) q,
                   (t.issued - t.returned) * coalesce(t.price,0) amt, 0
            from tandem.takeout_lines t
            join tandem.daily_reports d on d.id = t.report_id
            where d.report_date between v_from and v_to
          ) u group by item_name order by amt desc limit 20
        ) t),
      -- Кто не сдал отчёт за вчера
      'missing', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name) order by p.sort_order), '[]'::jsonb)
        from tandem.points p
        where p.active and not exists (
          select 1 from tandem.daily_reports d
          where d.point_id = p.id and d.report_date = current_date - 1
            -- у кассы строка отчёта появляется с первым чеком; сданным он считается после закрытия смены
            and (p.mode <> 'checks' or d.closed_at is not null))),
      -- Расход сырья по техкартам за период: топ-15
      'raw_usage', (select coalesce(jsonb_agg(jsonb_build_object(
          'name', t.ingredient_name, 'amount', t.total) order by t.total desc), '[]'::jsonb)
        from (
          -- Карта берётся на дату отчёта, а не на сегодня: иначе новая версия карты
          -- переписала бы расход сырья за прошлые дни.
          select ing.name as ingredient_name, sum(cl.brutto / ch.output_amount * u.q) total from (
            select s.item_code, s.qty q, d.report_date rd
            from tandem.sale_lines s join tandem.daily_reports d on d.id = s.report_id
            where d.report_date between v_from and v_to and s.item_code is not null
            union all
            select t.item_code, (t.issued - t.returned), d.report_date
            from tandem.takeout_lines t join tandem.daily_reports d on d.id = t.report_id
            where d.report_date between v_from and v_to and t.item_code is not null
          ) u
          join tandem.charts ch on ch.id = tandem.active_chart(u.item_code, u.rd)
          join tandem.chart_lines cl on cl.chart_id = ch.id
          join tandem.items ing on ing.code = cl.ingredient_code
          group by ing.name order by total desc limit 15
        ) t),
      -- Долги по реализации
      'realization', (select coalesce(jsonb_agg(jsonb_build_object(
          'name', c.name, 'debt', t.debt) order by t.debt desc), '[]'::jsonb)
        from (select client_id, sum(delivered - paid - returned) debt
              from tandem.realization_ledger group by client_id) t
        join tandem.realization_clients c on c.id = t.client_id
        where t.debt <> 0));
  end if;

  return jsonb_build_object('ok', false, 'error', 'Неизвестное действие: ' || action);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.tandem_asset(p_name text)
 RETURNS text
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'tandem', 'public'
AS $function$
  select content from tandem.assets where name = p_name;
$function$
;

CREATE OR REPLACE FUNCTION public.tandem_charts(p_pin text, p_point text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'tandem', 'public'
AS $function$
declare
  v_owner text;
  v_cats  text[];
begin
  select value into v_owner from tandem.settings where key = 'owner_pin';
  if p_pin is distinct from v_owner
     and not exists (select 1 from tandem.points where id = p_point and pin = p_pin and active) then
    return jsonb_build_object('ok', false, 'error', 'Нет доступа');
  end if;
  select item_categories into v_cats from tandem.points where id = p_point;
  return jsonb_build_object('ok', true, 'charts', (
    select coalesce(jsonb_object_agg(item_code, lines), '{}'::jsonb)
    from (
      select c.item_code,
             jsonb_agg(jsonb_build_object('n', ing.name, 'a', round(cl.brutto / c.output_amount, 4)) order by cl.brutto desc) as lines
      from tandem.charts c
      join tandem.items i on i.code = c.item_code and i.active and i.for_sale
      join tandem.chart_lines cl on cl.chart_id = c.id
      join tandem.items ing on ing.code = cl.ingredient_code
      where c.id = tandem.active_chart(c.item_code, current_date)
        and (v_cats is null or cardinality(v_cats) = 0 or i.category = any(v_cats))
      group by c.item_code
    ) t));
end $function$
;

CREATE OR REPLACE FUNCTION public.tandem_gate(action text, payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'tandem', 'public', 'extensions'
AS $function$
declare
  v_pin   text := coalesce(payload->>'pin', '');
  v_key   text;
  v_res   jsonb;
  v_hash  text;
  v_owner text;
  v_service boolean := action in ('migrate','test_cleanup','sync_items','sync_prices','recalc_ranks','set_packaging','set_short_list');
begin
  if action like 'office\_%' then
    -- Токен текущей сессии — в настройку транзакции: триггер смены PIN закроет все сессии
    -- пользователя, кроме этой (см. tandem.users_pin_sessions).
    perform set_config('tandem.token', coalesce(payload->>'token', ''), true);
    return public.tandem_office(substr(action, 8), payload);
  end if;

  -- Ключ счётчика — настоящая точка из запроса; всё остальное (вход собственника и водителя,
  -- выдуманные точки) падает в один общий ключ, чтобы перебор нельзя было размазать по ключам.
  v_key := case when v_service then 'service'
                else coalesce((select p.id from tandem.points p
                                where p.id = coalesce(nullif(payload->>'point_id',''), nullif(payload->>'point',''))), '-') end;
  if (select count(*) from tandem.pin_failures f where f.key = v_key and f.at > now() - interval '5 minutes') >= 10
     or (select count(*) from tandem.pin_failures f where f.at > now() - interval '5 minutes') >= 60 then
    return jsonb_build_object('ok', false, 'error', 'Слишком много неверных кодов. Подождите 5 минут',
                              'code', 'throttled');
  end if;

  if v_service then
    select value into v_hash from tandem.settings where key = 'service_key_hash';
    if v_hash is null or coalesce(payload->>'service_key', '') = ''
       or encode(digest(payload->>'service_key', 'sha256'), 'hex') <> v_hash then
      insert into tandem.pin_failures (key) values ('service');
      return jsonb_build_object('ok', false, 'error', 'forbidden', 'message', 'Нужен служебный ключ');
    end if;
    select value into v_owner from tandem.settings where key = 'owner_pin';
    v_res := case action
      when 'migrate'        then public.tandem_migrate(v_owner, coalesce(payload->>'kind',''), coalesce(payload->'rows','[]'::jsonb))
      when 'test_cleanup'   then public.tandem_test_cleanup(v_owner)
      when 'sync_items'     then public.tandem_sync_items(v_owner, coalesce(payload->'items','[]'::jsonb))
      when 'sync_prices'    then public.tandem_sync_prices(v_owner, coalesce(payload->'data','[]'::jsonb))
      when 'recalc_ranks'   then public.tandem_recalc_ranks(v_owner, coalesce((payload->>'days')::int, 30))
      when 'set_packaging'  then public.tandem_set_packaging(v_owner, coalesce(payload->'data','[]'::jsonb))
      when 'set_short_list' then public.tandem_set_short_list(v_owner, coalesce(payload->>'point',''), coalesce(payload->'codes','[]'::jsonb))
    end;
    -- Уборка теста снимает и его неверные коды: иначе проверка счётчика запирала бы следующий прогон.
    if action = 'test_cleanup' then delete from tandem.pin_failures where key in ('zz_test'); end if;
    return v_res;
  end if;

  v_res := case action
    when 'charts'       then public.tandem_charts(v_pin, coalesce(payload->>'point_id',''))
    when 'realization'  then public.tandem_realization(v_pin, coalesce(payload->>'op','list'), coalesce(payload->'data','{}'::jsonb))
    when 'save_aliases' then public.tandem_save_aliases(v_pin, coalesce(payload->>'point_id',''), coalesce(payload->'data','[]'::jsonb))
    else public.tandem_api(action, payload)
  end;

  -- Неверный код узнаём по ответу нижележащей функции: их тела не трогаем.
  if v_pin <> '' and jsonb_typeof(v_res) = 'object' and (v_res->>'ok') = 'false'
     and (v_res->>'error' in ('Неверный код', 'Нет доступа')
          or (v_res->>'error' = 'forbidden' and v_res->>'message' = 'Нет доступа')) then
    insert into tandem.pin_failures (key) values (v_key);
    delete from tandem.pin_failures where at < now() - interval '1 day';
  end if;
  return v_res;
end $function$
;

CREATE OR REPLACE FUNCTION public.tandem_migrate(p_pin text, p_kind text, p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'tandem', 'public'
AS $function$
declare
  v_owner text; v_ins int := 0; v_upd int := 0; v_skip int := 0; v_total int;
begin
  select value into v_owner from tandem.settings where key = 'owner_pin';
  if p_pin is distinct from v_owner then
    return jsonb_build_object('ok', false, 'error', 'forbidden', 'message', 'Нет доступа');
  end if;
  v_total := jsonb_array_length(coalesce(p_rows, '[]'::jsonb));

  if p_kind = 'groups' then
    with inc as (
      select distinct on (id) (x->>'id')::uuid id, x->>'name' name, coalesce((x->>'deleted')::boolean,false) deleted,
             coalesce((x->>'sort')::int, 0) sort
      from jsonb_array_elements(p_rows) x where coalesce(x->>'id','') <> ''
      order by id, deleted
    ),
    upd as (
      update tandem.item_groups g set name = inc.name, active = not inc.deleted, sort_order = inc.sort
      from inc where g.iiko_id = inc.id returning 1),
    ins as (
      insert into tandem.item_groups (id, name, active, sort_order, iiko_id)
      select inc.id, inc.name, not inc.deleted, inc.sort, inc.id from inc
      where not exists (select 1 from tandem.item_groups g where g.iiko_id = inc.id) returning 1)
    select (select count(*) from upd), (select count(*) from ins) into v_upd, v_ins;

  elsif p_kind = 'stores' then
    with inc as (
      select distinct on (id) (x->>'id')::uuid id, x->>'name' name, nullif(x->>'organization_id','')::uuid org,
             coalesce((x->>'deleted')::boolean,false) deleted
      from jsonb_array_elements(p_rows) x where coalesce(x->>'id','') <> ''
      order by id, deleted
    ),
    upd as (
      update tandem.stores s set name = inc.name, organization_id = inc.org, active = not inc.deleted
      from inc where s.iiko_id = inc.id returning 1),
    ins as (
      insert into tandem.stores (id, name, organization_id, active, iiko_id)
      select inc.id, inc.name, inc.org, not inc.deleted, inc.id from inc
      where not exists (select 1 from tandem.stores s where s.iiko_id = inc.id) returning 1)
    select (select count(*) from upd), (select count(*) from ins) into v_upd, v_ins;

  elsif p_kind = 'counteragents' then
    with inc as (
      select distinct on (id) (x->>'id')::uuid id, x->>'name' name,
             case when x->>'kind' in ('supplier','customer','employee') then x->>'kind' else 'other' end kind,
             nullif(x->>'bin','') bin, nullif(x->>'phone','') phone,
             coalesce((x->>'deleted')::boolean,false) deleted
      from jsonb_array_elements(p_rows) x where coalesce(x->>'id','') <> ''
      order by id, deleted
    ),
    upd as (
      update tandem.counteragents c set name = inc.name, kind = inc.kind, bin = inc.bin,
             phone = inc.phone, active = not inc.deleted
      from inc where c.iiko_id = inc.id returning 1),
    ins as (
      insert into tandem.counteragents (id, name, kind, bin, phone, active, iiko_id)
      select inc.id, inc.name, inc.kind, inc.bin, inc.phone, not inc.deleted, inc.id from inc
      where not exists (select 1 from tandem.counteragents c where c.iiko_id = inc.id) returning 1)
    select (select count(*) from upd), (select count(*) from ins) into v_upd, v_ins;

  elsif p_kind = 'items' then
    -- три непересекающихся набора: уже привязанные по iiko_id; старые строки по iiko_code; новые.
    -- inc убирает дубли по id, inc2 — дубли по code (в обоих случаях живая строка побеждает
    -- удалённую): без этого две строки одной пачки с одинаковым ключом обе метят в insert
    -- и падают сырой ошибкой unique_violation вместо {ok:false,...}.
    with inc as (
      select distinct on (id) (x->>'id')::uuid id, x->>'code' code, x->>'name' name, nullif(x->>'artikul','') artikul,
             nullif(x->>'group_id','')::uuid group_id,
             case when x->>'unit' in ('шт','кг','л','порц') then x->>'unit' else 'шт' end unit,
             case when x->>'type' in ('goods','dish','prepared','service') then x->>'type' else 'dish' end typ,
             coalesce((x->>'deleted')::boolean,false) deleted,
             nullif(x->>'price','')::numeric price
      from jsonb_array_elements(p_rows) x
      where coalesce(x->>'id','') <> '' and coalesce(x->>'code','') <> ''
      order by id, deleted
    ),
    inc2 as (
      select distinct on (code) * from inc order by code, deleted
    ),
    upd_id as (
      update tandem.items i set name = inc2.name, artikul = coalesce(inc2.artikul, i.artikul),
             group_id = inc2.group_id, unit_id = inc2.unit, unit = inc2.unit, item_type = inc2.typ,
             active = not inc2.deleted, synced_at = now()
      from inc2 where i.iiko_id = inc2.id and i.source in ('iiko_migrate','iiko_api') returning 1),
    upd_code as (
      update tandem.items i set iiko_id = inc2.id, name = inc2.name, artikul = coalesce(inc2.artikul, i.artikul),
             group_id = inc2.group_id, unit_id = inc2.unit, unit = inc2.unit, item_type = inc2.typ,
             active = not inc2.deleted, synced_at = now()
      from inc2 where i.iiko_id is null and i.iiko_code = inc2.code
                  and i.source in ('iiko_migrate','iiko_api') returning 1),
    ins as (
      insert into tandem.items (code, name, artikul, iiko_code, iiko_id, group_id, unit_id, unit, step,
                                item_type, product_type, price, active, for_sale, source, synced_at)
      select inc2.code, inc2.name, inc2.artikul, inc2.code, inc2.id, inc2.group_id, inc2.unit, inc2.unit,
             case when inc2.unit in ('кг','л') then 0.5 else 1 end,
             inc2.typ, upper(inc2.typ), inc2.price, not inc2.deleted, false, 'iiko_migrate', now()
      from inc2
      where not exists (select 1 from tandem.items i where i.iiko_id = inc2.id or i.code = inc2.code)
      returning 1)
    select (select count(*) from upd_id) + (select count(*) from upd_code), (select count(*) from ins)
      into v_upd, v_ins;

  elsif p_kind = 'chart_candidates' then
    -- по каким позициям вообще имеет смысл спрашивать карты у iiko
    return jsonb_build_object('ok', true, 'rows', (
      select coalesce(jsonb_agg(jsonb_build_object('code', code, 'iiko_id', iiko_id) order by code), '[]'::jsonb)
      from tandem.items where active and iiko_id is not null and item_type in ('dish','prepared')));

  elsif p_kind = 'charts' then
    -- по одной карте: строки состава сопоставляются по items.iiko_id, неизвестные ингредиенты
    -- пропускаются и называются в ответе; пересекающиеся версии того же блюда закрываются.
    -- Правило при совпадении date_from — «побеждает первая записанная», а не пришедшая позже:
    -- перенос ничего не удаляет, новая версия уходит в skipped и называется в errors. Так
    -- повторный прогон той же выгрузки идемпотентен, а карту, заведённую в офисе руками
    -- (source <> 'iiko'), перенос из iiko не затирает никогда.
    declare
      v_row jsonb; v_cid uuid; v_code text; v_from date; v_to date; v_out numeric; v_lines jsonb;
      v_bad int; v_skip_lines int := 0; v_unknown text[] := '{}'; v_errors text[] := '{}';
      v_exists uuid; v_exists_src text; v_c record; v_conf record;
    begin
      for v_row in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
        v_cid  := nullif(v_row->>'iiko_id','')::uuid;
        v_code := nullif(v_row->>'code','');
        v_from := coalesce(nullif(v_row->>'date_from','')::date, date '2020-01-01');
        v_to   := nullif(v_row->>'date_to','')::date;
        v_out  := coalesce(nullif(v_row->>'output_amount','')::numeric, 1);
        -- карты бывают только у блюд и полуфабрикатов; на сырьё и услуги их не вешаем
        if v_cid is null or v_code is null
           or not exists (select 1 from tandem.items
                           where code = v_code and item_type in ('dish','prepared')) then
          v_skip := v_skip + 1; continue;
        end if;
        if v_out <= 0 then v_out := 1; end if;
        if v_to is not null and v_to < v_from then v_to := null; end if;

        -- известные строки складываем в v_lines, неизвестные считаем и запоминаем
        select coalesce(jsonb_agg(jsonb_build_object('code', i.code, 'brutto', (l->>'brutto')::numeric,
                 'netto', (l->>'netto')::numeric, 'output', (l->>'output')::numeric,
                 'sort', coalesce((l->>'sort')::int, 0)) order by coalesce((l->>'sort')::int, 0))
                 filter (where i.code is not null), '[]'::jsonb),
               count(*) filter (where i.code is null)
          into v_lines, v_bad
          from jsonb_array_elements(coalesce(v_row->'lines','[]'::jsonb)) l
          left join tandem.items i on i.iiko_id = nullif(l->>'ingredient_iiko_id','')::uuid;
        v_skip_lines := v_skip_lines + v_bad;
        if v_bad > 0 then
          -- список неизвестных: без пустых значений, сразу без повторов и не длиннее 20
          select coalesce(array_agg(distinct u), '{}'::text[]) into v_unknown
            from unnest(v_unknown || (
              select coalesce(array_agg(distinct l->>'ingredient_iiko_id'), '{}'::text[])
                from jsonb_array_elements(coalesce(v_row->'lines','[]'::jsonb)) l
                left join tandem.items i on i.iiko_id = nullif(l->>'ingredient_iiko_id','')::uuid
                where i.code is null and coalesce(l->>'ingredient_iiko_id','') <> '')) u;
          if coalesce(array_length(v_unknown, 1), 0) > 20 then v_unknown := v_unknown[1:20]; end if;
        end if;

        -- строки, где ингредиент — само блюдо, отбрасываем: рекурсия в себя бессмысленна;
        -- они такие же пропущенные строки, как и с неизвестным ингредиентом
        select coalesce(jsonb_agg(x) filter (where x->>'code' is distinct from v_code), '[]'::jsonb),
               count(*) filter (where x->>'code' is not distinct from v_code)
          into v_lines, v_bad
          from jsonb_array_elements(v_lines) x;
        v_skip_lines := v_skip_lines + v_bad;
        if jsonb_array_length(v_lines) = 0 then v_skip := v_skip + 1; continue; end if;

        -- I1: карту, правленную в бэк-офисе, перенос не переписывает. iiko_id у неё остался,
        -- но source стал 'office' — по нему и узнаём: пропускаем и называем в errors.
        select id, source into v_exists, v_exists_src from tandem.charts where iiko_id = v_cid;
        if v_exists is not null and v_exists_src is distinct from 'iiko' then
          v_skip := v_skip + 1;
          if coalesce(array_length(v_errors, 1), 0) < 20 then
            v_errors := v_errors || (v_cid::text || ': правлена в офисе');
          end if;
          continue;
        end if;
        -- чужая версия ровно с той же датой начала: не трогаем её и не пишем свою
        select id, source, iiko_id into v_conf from tandem.charts
          where item_code = v_code and date_from = v_from and (v_exists is null or id <> v_exists)
          limit 1;
        if v_conf.id is not null then
          v_skip := v_skip + 1;
          if coalesce(array_length(v_errors, 1), 0) < 20 then
            v_errors := v_errors || (v_cid::text || case when v_conf.source is distinct from 'iiko'
              then ': совпадает с картой офиса'
              else ': дубль даты начала с ' || coalesce(v_conf.iiko_id::text, '?') end);
          end if;
          continue;
        end if;

        -- ниже всё пишущее: одна кривая карта не должна ронять всю пачку
        begin
          -- пересечения с другими версиями того же блюда: ранние закрываем днём раньше нашего
          -- начала, из-за поздних укорачиваем себя; равное начало отсеяно выше
          for v_c in select id, date_from, date_to from tandem.charts
                     where item_code = v_code and (v_exists is null or id <> v_exists)
                       and daterange(date_from, date_to, '[]') && daterange(v_from, v_to, '[]') loop
            if v_c.date_from < v_from then
              update tandem.charts set date_to = v_from - 1, updated_at = now() where id = v_c.id;
            elsif v_c.date_from > v_from then
              v_to := least(coalesce(v_to, v_c.date_from - 1), v_c.date_from - 1);
            end if;
            -- равных начал здесь не бывает; если бы вдруг были, запись упрётся
            -- в charts_no_overlap и карта уйдёт в errors ниже — данные не пострадают
          end loop;

          -- страховка: сюда не попасть, пока равные начала отсеиваются до блока
          if v_to is not null and v_to < v_from then
            v_skip := v_skip + 1;
          else
            if v_exists is null then
              insert into tandem.charts (item_code, date_from, date_to, output_amount, technology, source, iiko_id)
                values (v_code, v_from, v_to, v_out, nullif(v_row->>'technology',''), 'iiko', v_cid)
                returning id into v_exists;
              v_ins := v_ins + 1;
            else
              update tandem.charts set item_code = v_code, date_from = v_from, date_to = v_to,
                     output_amount = v_out, technology = nullif(v_row->>'technology',''), updated_at = now()
                where id = v_exists;
              delete from tandem.chart_lines where chart_id = v_exists;
              v_upd := v_upd + 1;
            end if;
            insert into tandem.chart_lines (chart_id, ingredient_code, brutto, netto, output, sort_order)
              select v_exists, x->>'code', coalesce((x->>'brutto')::numeric,0), coalesce((x->>'netto')::numeric,0),
                     coalesce((x->>'output')::numeric,0), coalesce((x->>'sort')::int, 0)
              from jsonb_array_elements(v_lines) x;
          end if;
        exception when exclusion_violation then
          v_skip := v_skip + 1;
          if coalesce(array_length(v_errors, 1), 0) < 20 then v_errors := v_errors || v_cid::text; end if;
        end;
      end loop;

      return jsonb_build_object('ok', true, 'inserted', v_ins, 'updated', v_upd, 'skipped', v_skip,
        'skipped_lines', v_skip_lines, 'unknown', to_jsonb(v_unknown), 'errors', to_jsonb(v_errors));
    end;

  elsif p_kind = 'costs' then
    -- цена закупа из iiko. Перенос ставит только 'iiko_invoice': какой бы source ни пришёл
    -- во входе, чужой меткой он не притворяется. И не перебивает цену, поставленную руками
    -- ('manual') или посчитанную по документу склада ('document') — там источник надёжнее.
    with inc as (
      select distinct on (id) (x->>'iiko_id')::uuid id, (x->>'price')::numeric price,
             nullif(x->>'date','')::date d
      from jsonb_array_elements(p_rows) x
      where coalesce(x->>'iiko_id','') <> '' and coalesce(nullif(x->>'price','')::numeric, 0) > 0
      order by id, nullif(x->>'date','')::date desc nulls last
    ),
    upd as (
      update tandem.items i set cost_price = inc.price, cost_date = coalesce(inc.d, current_date),
             cost_source = 'iiko_invoice'
      from inc where i.iiko_id = inc.id
                and (i.cost_source is null or i.cost_source not in ('manual','document'))
      returning 1)
    select count(*) into v_upd from upd;
    return jsonb_build_object('ok', true, 'updated', v_upd, 'skipped', v_total - v_upd);

  else
    return jsonb_build_object('ok', false, 'error', 'validation', 'message', 'Неизвестный вид: ' || coalesce(p_kind,''));
  end if;

  return jsonb_build_object('ok', true, 'inserted', v_ins, 'updated', v_upd, 'skipped', v_total - v_ins - v_upd);
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'validation', 'message', 'Дубли ключей в пачке: ' || sqlerrm);
  when others then
    -- иначе любая непредусмотренная ошибка уходит наружу как 500 прокси и вызывающий
    -- (скрипт переноса) видит невнятный ответ вместо причины
    return jsonb_build_object('ok', false, 'error', 'internal', 'message', sqlerrm);
end $function$
;

CREATE OR REPLACE FUNCTION public.tandem_office(action text, payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'tandem', 'public', 'extensions'
AS $function$
declare
  v_token    text := payload->>'token';
  v_user     tandem.users;
  v_pin      text;
  v_hash     text;
  v_calc     text;
  v_ok       boolean;
  v_section  text;
  v_need     text;
  v_attempts int;
begin
  if action = 'login' then
    v_pin := coalesce(payload->>'pin','');
    select * into v_user from tandem.users
      where login = lower(btrim(coalesce(payload->>'login',''))) and active;

    -- crypt считается всегда, отдельными операторами: если сложить всё в одно
    -- выражение, Postgres вправе оборвать вычисление на первом false, и ответ
    -- «такого логина нет» вернётся заметно быстрее ответа «неверный PIN».
    -- Хэш-заглушка — обычный bcrypt-хэш от произвольной строки, не секрет:
    -- он нужен только чтобы crypt было над чем работать.
    v_hash := coalesce(v_user.pin_hash, '$2a$06$nok4o3iwBUM19xMpLFJzoeTS1iAyq43SB1ybN/Yq5Zt2PyGfXmZF6');
    v_calc := crypt(v_pin, v_hash);
    v_ok   := v_user.id is not null and v_calc = v_user.pin_hash;

    -- Пока логин заблокирован, ответ один и тот же при любом PIN — и тот же, что при обычной
    -- ошибке. Отдельный ответ на верный PIN (так было в 0021) давал перебору подсказку:
    -- блокировка не мешала узнать PIN по тексту ответа. Отдельный ответ «заблокирован»
    -- подтверждал бы существование логина. Поэтому про блокировку сказано в самом тексте ошибки.
    if v_user.id is not null and v_user.locked_until > now() then
      perform pg_sleep(0.3);
      return tandem.err('unauthorized', 'Неверный логин или PIN. После пяти ошибок подряд вход закрывается на 15 минут');
    end if;

    if not v_ok then
      if v_user.id is not null then
        -- храповик: локом, чей срок уже истёк, счётчик не наследуется, а начинается заново.
        v_attempts := case when v_user.locked_until is not null and v_user.locked_until <= now()
                            then 1 else v_user.failed_attempts + 1 end;
        update tandem.users set
          failed_attempts = v_attempts,
          locked_until = case when v_attempts >= 5 then now() + interval '15 minutes' else null end
        where id = v_user.id;
      end if;
      perform pg_sleep(0.3);
      return tandem.err('unauthorized', 'Неверный логин или PIN. После пяти ошибок подряд вход закрывается на 15 минут');
    end if;

    update tandem.users set failed_attempts = 0, locked_until = null where id = v_user.id;
    delete from tandem.sessions where expires_at < now();
    v_token := encode(gen_random_bytes(24), 'hex');
    insert into tandem.sessions (token, user_id, expires_at)
      values (v_token, v_user.id, now() + interval '12 hours');
    return jsonb_build_object('ok', true, 'token', v_token, 'user', tandem.office_user_json(v_user),
      'must_change_pin', v_user.must_change_pin, 'permissions', tandem.office_permissions(v_user.role));
  end if;

  v_user := tandem.office_session(coalesce(v_token,''));
  if v_user.id is null then
    return tandem.err('unauthorized', 'Войдите заново');
  end if;

  -- I2: временный PIN держится на сервере, а не на доброй воле фронта.
  if v_user.must_change_pin and action not in ('me','logout','change_pin') then
    return tandem.err('forbidden', 'Сначала смените временный PIN');
  end if;

  if action = 'logout' then
    delete from tandem.sessions where token = v_token;
    return jsonb_build_object('ok', true);
  end if;

  if action = 'me' then
    return jsonb_build_object('ok', true, 'user', tandem.office_user_json(v_user),
      'must_change_pin', v_user.must_change_pin, 'permissions', tandem.office_permissions(v_user.role));
  end if;

  if action = 'change_pin' then
    v_pin := coalesce(payload->>'pin','');
    if length(v_pin) < 4 or v_pin !~ '^[0-9]+$' then
      return tandem.err('validation', 'PIN — не меньше 4 цифр');
    end if;
    update tandem.users set pin_hash = crypt(v_pin, gen_salt('bf')), must_change_pin = false
      where id = v_user.id;
    return jsonb_build_object('ok', true, 'must_change_pin', false);
  end if;

  -- раздел и требуемое право выводятся из имени действия
  v_section := case
    -- Склад стоит первым: doc%/stock% и карточка остатков позиции уходят в него,
    -- иначе item_stock перехватил бы правилом item% раздел номенклатуры.
    when action like 'doc%' or action like 'stock%' or action = 'item_stock' then 'stock'
    when action like 'chart%' or action like 'foodcost%' then 'charts'
    when action like 'group%' or action like 'item%'     then 'nomenclature'
    when action like 'store%'        then 'stores'
    when action like 'counteragent%' then 'counteragents'
    when action like 'user%'         then 'users'
  end;
  if v_section is null then
    return tandem.err('unknown_action', 'Неизвестное действие: ' || action);
  end if;
  v_need := case when action like '%\_list' or action like '%\_search' or action like '%\_get'
                      or action like '%\_report' or action like '%\_preview'
                      or action in ('stock_balances','stock_moves','item_stock')
                 then 'view' else 'edit' end;
  if not tandem.office_can(v_user.role, v_section, v_need) then
    return tandem.err('forbidden', 'Нет прав на это действие');
  end if;

  if v_section = 'nomenclature' then
    return tandem.office_nomenclature(action, payload, v_user);
  elsif v_section = 'charts' then
    return tandem.office_charts(action, payload, v_user);
  elsif v_section = 'stores' then
    return tandem.office_stores(action, payload, v_user);
  elsif v_section = 'counteragents' then
    return tandem.office_counteragents(action, payload, v_user);
  elsif v_section = 'users' then
    return tandem.office_users(action, payload, v_user);
  elsif v_section = 'stock' then
    return tandem.office_stock(action, payload, v_user);
  end if;
exception
  -- Minor: кривой uuid/число/boolean в payload — это ошибка ввода, а не сбой базы.
  when invalid_text_representation then
    return tandem.err('validation', 'Неверный формат поля');
  -- ссылка на несуществующий склад/контрагента/позицию — тоже ошибка ввода, не 500.
  when foreign_key_violation then
    return tandem.err('validation', 'Ссылка на несуществующую запись (склад, контрагент или позиция)');
  -- I4: взаимная блокировка двух проведений — не сбой базы, а «повторите»: одна
  -- транзакция снята Postgres'ом, её документ остался черновиком и проводится заново.
  when deadlock_detected then
    return tandem.err('validation', 'Документ проводится параллельно — повторите');
  -- дата накладной или периода, пришедшая мусором ('31.02.2026', 'вчера').
  when invalid_datetime_format then
    return tandem.err('validation', 'Неверный формат даты');
end $function$
;

CREATE OR REPLACE FUNCTION public.tandem_realization(p_pin text, p_action text, p_data jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'tandem', 'public'
AS $function$
declare
  v_owner  text;
  v_driver text;
  v_who    text;
begin
  select value into v_owner  from tandem.settings where key = 'owner_pin';
  select value into v_driver from tandem.settings where key = 'driver_pin';
  if p_pin = v_owner then v_who := 'собственник';
  elsif p_pin = v_driver then v_who := 'водитель';
  else return jsonb_build_object('ok', false, 'error', 'Нет доступа');
  end if;

  if p_action = 'list' then
    return jsonb_build_object('ok', true,
      'clients', (select coalesce(jsonb_agg(jsonb_build_object(
          'id', c.id, 'name', c.name,
          'debt', coalesce(t.debt, 0)) order by c.sort_order), '[]'::jsonb)
        from tandem.realization_clients c
        left join (select client_id, sum(delivered - paid - returned) debt
                   from tandem.realization_ledger group by client_id) t on t.client_id = c.id
        where c.active),
      'recent', (select coalesce(jsonb_agg(jsonb_build_object(
          'date', l.entry_date, 'client', c.name, 'delivered', l.delivered,
          'paid', l.paid, 'returned', l.returned, 'note', l.note, 'by', l.created_by)
          order by l.entry_date desc, l.id desc), '[]'::jsonb)
        from (select * from tandem.realization_ledger order by entry_date desc, id desc limit 30) l
        join tandem.realization_clients c on c.id = l.client_id));
  end if;

  if p_action = 'add' then
    insert into tandem.realization_ledger (entry_date, client_id, delivered, paid, returned, note, created_by)
    values (
      coalesce(nullif(p_data->>'date','')::date, current_date),
      p_data->>'client_id',
      coalesce((p_data->>'delivered')::numeric, 0),
      coalesce((p_data->>'paid')::numeric, 0),
      coalesce((p_data->>'returned')::numeric, 0),
      nullif(p_data->>'note',''),
      v_who);
    return public.tandem_realization(p_pin, 'list');
  end if;

  return jsonb_build_object('ok', false, 'error', 'Неизвестное действие');
end;
$function$
;

CREATE OR REPLACE FUNCTION public.tandem_recalc_ranks(p_pin text, p_days integer DEFAULT 30)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'tandem', 'public'
AS $function$
declare
  v_owner text;
  v_n int := 0;
begin
  select value into v_owner from tandem.settings where key = 'owner_pin';
  if p_pin is distinct from v_owner then
    return jsonb_build_object('ok', false, 'error', 'Нет доступа');
  end if;

  with sold as (
    select d.point_id, s.item_code, sum(s.qty) as qty
    from tandem.sale_lines s
    join tandem.daily_reports d on d.id = s.report_id
    where d.report_date >= current_date - p_days and s.item_code is not null
    group by 1,2
    union all
    select d.point_id, t.item_code, sum(t.issued - t.returned)
    from tandem.takeout_lines t
    join tandem.daily_reports d on d.id = t.report_id
    where d.report_date >= current_date - p_days and t.item_code is not null
    group by 1,2
  ),
  agg as (
    select point_id, item_code, sum(qty) q,
           row_number() over (partition by point_id order by sum(qty) desc) rn
    from sold group by 1,2
  ),
  upd as (
    insert into tandem.item_rank (point_id, item_code, rank, source)
    select point_id, item_code, rn, 'own_history'
    from agg where rn <= 40 and q > 0
    on conflict (point_id, item_code) do update
      set rank = excluded.rank, source = 'own_history'
    returning 1
  )
  select count(*) from upd into v_n;

  return jsonb_build_object('ok', true, 'ranked', v_n);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.tandem_save_aliases(p_pin text, p_point text, p_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'tandem', 'public'
AS $function$
declare
  v_owner text;
  v_n int := 0;
begin
  select value into v_owner from tandem.settings where key = 'owner_pin';
  if p_pin is distinct from v_owner
     and not exists (select 1 from tandem.points where id = p_point and pin = p_pin and active and mode = 'import') then
    return jsonb_build_object('ok', false, 'error', 'Нет доступа');
  end if;
  with done as (
    insert into tandem.item_aliases (alias, item_code)
    select lower(btrim(x->>'alias')), x->>'code'
    from jsonb_array_elements(p_data) x
    where coalesce(x->>'alias','') <> '' and coalesce(x->>'code','') <> ''
    on conflict (alias) do update set item_code = excluded.item_code
    returning 1
  ) select count(*) from done into v_n;
  return jsonb_build_object('ok', true, 'saved', v_n);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.tandem_set_packaging(p_pin text, p_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'tandem', 'public'
AS $function$
declare
  v_owner text;
  v_n int := 0;
begin
  select value into v_owner from tandem.settings where key = 'owner_pin';
  if p_pin is distinct from v_owner then
    return jsonb_build_object('ok', false, 'error', 'Нет доступа');
  end if;

  with incoming as (
    select x->>'code' as code,
           nullif(x->>'factor','')::numeric as factor,
           nullif(x->>'unit','')            as unit,
           nullif(x->>'price','')::numeric  as price
    from jsonb_array_elements(p_data) x
  ),
  upd as (
    update tandem.items i
       set pack_factor = n.factor, pack_unit = n.unit, pack_price = n.price
      from incoming n
     where i.code = n.code
    returning 1
  )
  select count(*) from upd into v_n;

  return jsonb_build_object('ok', true, 'updated', v_n);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.tandem_set_short_list(p_pin text, p_point text, p_codes jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'tandem', 'public'
AS $function$
declare
  v_owner text;
  v_n int := 0;
begin
  select value into v_owner from tandem.settings where key = 'owner_pin';
  if p_pin is distinct from v_owner then
    return jsonb_build_object('ok', false, 'error', 'Нет доступа');
  end if;

  update tandem.item_rank set in_short_list = false where point_id = p_point;

  with incoming as (
    select value #>> '{}' as code, (ordinality)::int as ord
    from jsonb_array_elements(p_codes) with ordinality
  ),
  upd as (
    insert into tandem.item_rank (point_id, item_code, rank, source, in_short_list)
    select p_point, code, ord, 'short_list', true from incoming
    on conflict (point_id, item_code) do update
      set in_short_list = true, rank = excluded.rank, source = 'short_list'
    returning 1
  )
  select count(*) from upd into v_n;

  return jsonb_build_object('ok', true, 'in_list', v_n);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.tandem_sync_items(p_pin text, p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'tandem', 'public'
AS $function$
declare
  v_owner text;
  v_ins   int := 0;
  v_upd   int := 0;
begin
  select value into v_owner from tandem.settings where key = 'owner_pin';
  if p_pin is distinct from v_owner then
    return jsonb_build_object('ok', false, 'error', 'Нет доступа');
  end if;

  with incoming as (
    select
      x->>'c'                              as code,
      x->>'n'                              as name,
      nullif(x->>'a','')                   as artikul,
      nullif(x->>'g','')                   as category,
      nullif(x->>'t','')                   as product_type,
      nullif(x->>'u','')                   as unit,
      nullif(x->>'pr','')::numeric         as price,
      coalesce((x->>'ch')::boolean, false) as has_chart
    from jsonb_array_elements(p_items) x
    where coalesce(x->>'c','') <> '' and coalesce(x->>'n','') <> ''
  ),
  upd as (
    update tandem.items i set
      name         = n.name,
      artikul      = coalesce(n.artikul, i.artikul),
      iiko_code    = n.code,
      category     = coalesce(n.category, i.category),
      product_type = n.product_type,
      unit         = coalesce(n.unit, i.unit),
      price        = coalesce(n.price, i.price),
      has_chart    = n.has_chart,
      active       = true,
      source       = 'iiko_api',
      synced_at    = now()
    from incoming n
    where i.code = n.code
    returning 1
  ),
  ins as (
    insert into tandem.items (code, name, artikul, iiko_code, category, product_type,
                              unit, unit_id, item_type, group_id, step, price, has_chart,
                              active, for_sale, source, synced_at)
    select n.code, n.name, n.artikul, n.code, n.category, n.product_type,
           coalesce(n.unit,'шт'),
           case when n.unit in ('шт','кг','л','порц') then n.unit else 'шт' end,
           case n.product_type when 'GOODS' then 'goods' when 'PREPARED' then 'prepared'
                               when 'SERVICE' then 'service' else 'dish' end,
           (select g.id from tandem.item_groups g where g.name = n.category limit 1),
           case when n.unit in ('кг','л') then 0.5 else 1 end,
           n.price, n.has_chart, true, true, 'iiko_api', now()
    from incoming n
    where not exists (select 1 from tandem.items i where i.code = n.code)
    returning 1
  )
  select (select count(*) from upd), (select count(*) from ins) into v_upd, v_ins;

  return jsonb_build_object('ok', true, 'updated', v_upd, 'inserted', v_ins);
end $function$
;

CREATE OR REPLACE FUNCTION public.tandem_sync_prices(p_pin text, p_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'tandem', 'public'
AS $function$
declare
  v_owner text;
  v_n     int := 0;
  v_miss  int := 0;
begin
  select value into v_owner from tandem.settings where key = 'owner_pin';
  if p_pin is distinct from v_owner then
    return jsonb_build_object('ok', false, 'error', 'Нет доступа');
  end if;

  with incoming as (
    select x->>'pt' as point_id, x->>'a' as artikul, (x->>'p')::numeric as price
    from jsonb_array_elements(p_data) x
  ),
  matched as (
    select n.point_id, i.code, n.price
    from incoming n
    join tandem.items i on i.artikul = n.artikul
    where n.price > 0
  ),
  done as (
    insert into tandem.item_prices (point_id, item_code, price)
    select point_id, code, price from matched
    on conflict (point_id, item_code) do update set price = excluded.price
    returning 1
  )
  select (select count(*) from done),
         (select count(*) from incoming) - (select count(*) from matched)
    into v_n, v_miss;

  return jsonb_build_object('ok', true, 'loaded', v_n, 'unmatched', v_miss);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.tandem_test_cleanup(p_pin text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'tandem', 'public'
AS $function$
declare
  v_owner text;
  v_items int; v_groups int; v_stores int; v_ca int; v_users int; v_charts int; v_left int;
  v_docs int;
begin
  select value into v_owner from tandem.settings where key = 'owner_pin';
  if p_pin is distinct from v_owner then
    return jsonb_build_object('ok', false, 'error', 'forbidden', 'message', 'Нет доступа');
  end if;

  -- Движения держат документ (stock_moves_document_id_fkey on delete restrict) — с 0018
  -- они больше не уходят каскадом и снимаются здесь явно, до удаления самих документов.
  delete from tandem.stock_moves
    where store_id in (select id from tandem.stores where name like 'ZZ\_TEST\_%')
       or item_code in (select code from tandem.items where name like 'ZZ\_TEST\_%' or code like 'ZZ\_TEST\_%')
       or document_id in (
            select id from tandem.documents
              where store_from in (select id from tandem.stores where name like 'ZZ\_TEST\_%')
                 or store_to   in (select id from tandem.stores where name like 'ZZ\_TEST\_%')
                 or id in (select l.document_id from tandem.document_lines l join tandem.items i on i.code = l.item_code
                           where i.name like 'ZZ\_TEST\_%' or i.code like 'ZZ\_TEST\_%'));

  -- Отчёты служебной точки теста zz_test (выключена, на экранах не видна): их продажи сидят
  -- на тестовых складах и уйдут ниже вместе с документами склада. Настоящие точки тест не трогает.
  delete from tandem.checks where point_id = 'zz_kassa';   -- касса теста: чеки, затем отчёты
  delete from tandem.daily_reports where point_id in ('zz_test', 'zz_kassa');

  -- Документы тестовых складов и позиций уходят первыми: на них ссылаются строки,
  -- а сами документы держат FK на stores и items.
  with d as (delete from tandem.documents
      where store_from in (select id from tandem.stores where name like 'ZZ\_TEST\_%')
         or store_to   in (select id from tandem.stores where name like 'ZZ\_TEST\_%')
         or id in (select l.document_id from tandem.document_lines l join tandem.items i on i.code = l.item_code
                   where i.name like 'ZZ\_TEST\_%' or i.code like 'ZZ\_TEST\_%')
      returning 1)
    select count(*) into v_docs from d;
  delete from tandem.stock_balances
    where store_id in (select id from tandem.stores where name like 'ZZ\_TEST\_%')
       or item_code in (select code from tandem.items where name like 'ZZ\_TEST\_%' or code like 'ZZ\_TEST\_%');
  -- Счётчики номеров (doc_counters) не трогаем: номера документов не должны повторяться.

  delete from tandem.item_prices where item_code in
    (select code from tandem.items where name like 'ZZ\_TEST\_%' or code like 'ZZ\_TEST\_%');
  delete from tandem.item_rank where item_code in
    (select code from tandem.items where name like 'ZZ\_TEST\_%' or code like 'ZZ\_TEST\_%');

  -- Техкарты: сначала строки, где тестовая позиция стоит ингредиентом (в том числе в чужих
  -- картах — иначе FK не даст удалить позицию), затем сами карты тестовых блюд (строки уйдут каскадом).
  delete from tandem.chart_lines where ingredient_code in
    (select code from tandem.items where name like 'ZZ\_TEST\_%' or code like 'ZZ\_TEST\_%');
  with d as (delete from tandem.charts where item_code in
      (select code from tandem.items where name like 'ZZ\_TEST\_%' or code like 'ZZ\_TEST\_%') returning 1)
    select count(*) into v_charts from d;

  with d as (delete from tandem.items where name like 'ZZ\_TEST\_%' or code like 'ZZ\_TEST\_%' returning 1)
    select count(*) into v_items from d;

  -- склад по умолчанию точки ссылается на stores: сначала отвязать, иначе delete упрётся в FK
  update tandem.points set default_store_id = null
    where default_store_id in (select id from tandem.stores where name like 'ZZ\_TEST\_%');

  with d as (delete from tandem.item_groups where name like 'ZZ\_TEST\_%' returning 1)
    select count(*) into v_groups from d;
  with d as (delete from tandem.stores where name like 'ZZ\_TEST\_%' returning 1)
    select count(*) into v_stores from d;
  with d as (delete from tandem.counteragents where name like 'ZZ\_TEST\_%' returning 1)
    select count(*) into v_ca from d;
  -- сессии тестовых пользователей уходят каскадом (sessions_user_id_fkey on delete cascade)
  with d as (delete from tandem.users where login like 'zz\_test\_%' returning 1)
    select count(*) into v_users from d;

  delete from tandem.sessions where expires_at < now();

  select (select count(*) from tandem.items where name like 'ZZ\_TEST\_%' or code like 'ZZ\_TEST\_%')
       + (select count(*) from tandem.item_groups where name like 'ZZ\_TEST\_%')
       + (select count(*) from tandem.stores where name like 'ZZ\_TEST\_%')
       + (select count(*) from tandem.counteragents where name like 'ZZ\_TEST\_%')
       + (select count(*) from tandem.users where login like 'zz\_test\_%')
    into v_left;

  return jsonb_build_object('ok', true, 'deleted', jsonb_build_object(
    'items', v_items, 'groups', v_groups, 'stores', v_stores,
    'counteragents', v_ca, 'users', v_users, 'charts', v_charts, 'documents', v_docs), 'leftovers', v_left);
end $function$
;

CREATE OR REPLACE FUNCTION tandem.active_chart(p_code text, p_date date)
 RETURNS uuid
 LANGUAGE sql
 STABLE
AS $function$
  select id from tandem.charts
  where item_code = p_code and date_from <= p_date and (date_to is null or date_to >= p_date)
  order by date_from desc limit 1
$function$
;

CREATE OR REPLACE FUNCTION tandem.apply_move(p_doc uuid, p_line uuid, p_store uuid, p_item text, p_qty numeric, p_cost numeric, p_date date)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
declare v_qty numeric; v_avg numeric; v_cost numeric := coalesce(p_cost, 0);
begin
  if p_qty = 0 then return; end if;
  -- I2: сначала пара (склад, позиция) заводится и берётся под лок, и только потом пишется
  -- движение. В прежнем порядке два параллельных проведения успевали вставить движения
  -- до взаимной блокировки, и средняя считалась каждым по своему, уже устаревшему остатку.
  -- on conflict do nothing дожидается параллельной вставки той же пары, поэтому строка
  -- к моменту select … for update заведомо существует.
  insert into tandem.stock_balances (store_id, item_code, qty, avg_cost) values (p_store, p_item, 0, 0)
    on conflict (store_id, item_code) do nothing;
  select qty, avg_cost into v_qty, v_avg from tandem.stock_balances
    where store_id = p_store and item_code = p_item for update;
  insert into tandem.stock_moves (document_id, line_id, store_id, item_code, qty, unit_cost, move_date)
    values (p_doc, p_line, p_store, p_item, p_qty, v_cost, p_date);
  if p_qty > 0 then
    if v_qty <= 0 then v_avg := v_cost;
    else v_avg := round((v_qty * v_avg + p_qty * v_cost) / (v_qty + p_qty), 4); end if;
  end if;
  update tandem.stock_balances set qty = v_qty + p_qty, avg_cost = v_avg, updated_at = now()
    where store_id = p_store and item_code = p_item;
end $function$
;

CREATE OR REPLACE FUNCTION tandem.chart_reaches(p_from text, p_target text, p_date date DEFAULT CURRENT_DATE)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  with recursive w as (
    select cl.ingredient_code as node, 1 as depth
    from tandem.chart_lines cl where cl.chart_id = tandem.active_chart(p_from, p_date)
    union all
    select cl.ingredient_code, w.depth + 1
    from w join tandem.chart_lines cl on cl.chart_id = tandem.active_chart(w.node, p_date)
    where w.depth < 10
  )
  select exists (select 1 from w where node = p_target)
$function$
;

CREATE OR REPLACE FUNCTION tandem.doc_consume_plan(p_doc uuid)
 RETURNS TABLE(line_id uuid, item_code text, qty numeric)
 LANGUAGE sql
 STABLE
AS $function$
  select l.id, cl.ingredient_code, sum(cl.brutto * l.qty / c.output_amount)
  from tandem.document_lines l
  join tandem.documents d on d.id = l.document_id
  join tandem.charts c on c.id = tandem.active_chart(l.item_code, d.doc_date)
  join tandem.chart_lines cl on cl.chart_id = c.id
  where l.document_id = p_doc and l.line_kind = 'item'
  group by l.id, cl.ingredient_code
$function$
;

CREATE OR REPLACE FUNCTION tandem.doc_own_store(p_type text, p_from uuid, p_to uuid)
 RETURNS uuid
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case when p_type = 'invoice_in' then p_to else p_from end
$function$
;

CREATE OR REPLACE FUNCTION tandem.doc_post(p_doc uuid, p_user tandem.users)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
declare
  d record; l record; c record;
  v_cost numeric; v_sum numeric := 0; v_line_sum numeric; v_calc numeric; v_diff numeric;
  v_chart uuid; v_missing text[] := '{}'; v_warn jsonb; v_lines int; v_bad text; v_qty numeric;
begin
  select * into d from tandem.documents where id = p_doc for update;
  if d.id is null then return tandem.err('not_found', 'Документ не найден'); end if;
  if d.status <> 'draft' then return tandem.err('validation', 'Документ уже проведён'); end if;
  if not tandem.office_can(p_user.role, 'doc:' || d.doc_type, 'edit') then
    return tandem.err('forbidden', 'Нет права проводить документы этого типа');
  end if;
  if d.store_from is not null and not exists (select 1 from tandem.stores where id = d.store_from and active) then
    return tandem.err('validation', 'Склад-источник выключен или не найден'); end if;
  if d.store_to is not null and not exists (select 1 from tandem.stores where id = d.store_to and active) then
    return tandem.err('validation', 'Склад-получатель выключен или не найден'); end if;
  select count(*) into v_lines from tandem.document_lines where document_id = p_doc and line_kind = 'item';
  if v_lines = 0 then return tandem.err('validation', 'В документе нет строк'); end if;
  if exists (select 1 from tandem.document_lines dl join tandem.items i on i.code = dl.item_code
             where dl.document_id = p_doc and dl.line_kind = 'item' and not i.active) then
    return tandem.err('validation', 'В документе есть выключенные позиции'); end if;
  if exists (select 1 from tandem.document_lines where document_id = p_doc and line_kind = 'item'
             group by item_code having count(*) > 1) then
    return tandem.err('validation', 'Позиция повторяется в строках документа — объедините строки'); end if;

  -- Вся построчная проверка — до первой записи: иначе ошибка на второй строке
  -- оставляет движения первой (функция возвращает значение, а не откатывает транзакцию).
  if d.doc_type <> 'inventory' then
    select dl.item_code into v_bad from tandem.document_lines dl
      where dl.document_id = p_doc and dl.line_kind = 'item' and dl.qty <= 0 order by dl.sort_order limit 1;
    if v_bad is not null then return tandem.err('validation', 'Количество должно быть больше нуля: ' || v_bad); end if;
  end if;
  if d.doc_type = 'invoice_in' then
    select dl.item_code into v_bad from tandem.document_lines dl
      where dl.document_id = p_doc and dl.line_kind = 'item' and (dl.price is null or dl.price < 0)
      order by dl.sort_order limit 1;
    if v_bad is not null then return tandem.err('validation', 'Укажите цену: ' || v_bad); end if;
  elsif d.doc_type = 'inventory' then
    select dl.item_code into v_bad from tandem.document_lines dl
      where dl.document_id = p_doc and dl.line_kind = 'item' and (dl.fact_qty is null or dl.fact_qty < 0)
      order by dl.sort_order limit 1;
    if v_bad is not null then return tandem.err('validation', 'Укажите факт: ' || v_bad); end if;
  end if;

  -- I4: пишущие циклы идут по item_code, а не по sort_order. Порядок строк в документе
  -- задаёт человек, и два документа с одними позициями в разном порядке брали локи
  -- встречно. По item_code порядок блокировок одинаков у всех документов.
  if d.doc_type = 'invoice_in' then
    -- ВНИМАНИЕ: ниже уже идут записи; любая новая проверка должна стоять выше, в блоке предпроверок, иначе return err оставит частично проведённый документ
    for l in select * from tandem.document_lines where document_id = p_doc and line_kind = 'item' order by item_code loop
      perform tandem.apply_move(p_doc, l.id, d.store_to, l.item_code, l.qty, l.price, d.doc_date);
      v_line_sum := round(l.qty * l.price, 2);
      update tandem.document_lines set sum = v_line_sum where id = l.id;
      update tandem.items set cost_price = l.price, cost_date = d.doc_date, cost_source = 'document' where code = l.item_code;
      v_sum := v_sum + v_line_sum;
    end loop;

  elsif d.doc_type = 'transfer' then
    -- ВНИМАНИЕ: ниже уже идут записи; любая новая проверка должна стоять выше, в блоке предпроверок, иначе return err оставит частично проведённый документ
    for l in select * from tandem.document_lines where document_id = p_doc and line_kind = 'item' order by item_code loop
      v_cost := tandem.store_avg(d.store_from, l.item_code);
      -- Склады блокируются по возрастанию store_id: встречные перемещения не встают во взаимную блокировку.
      if d.store_from < d.store_to then
        perform tandem.apply_move(p_doc, l.id, d.store_from, l.item_code, -l.qty, v_cost, d.doc_date);
        perform tandem.apply_move(p_doc, l.id, d.store_to,   l.item_code,  l.qty, v_cost, d.doc_date);
      else
        perform tandem.apply_move(p_doc, l.id, d.store_to,   l.item_code,  l.qty, v_cost, d.doc_date);
        perform tandem.apply_move(p_doc, l.id, d.store_from, l.item_code, -l.qty, v_cost, d.doc_date);
      end if;
      v_line_sum := round(l.qty * v_cost, 2);
      update tandem.document_lines set price = v_cost, sum = v_line_sum where id = l.id;
      v_sum := v_sum + v_line_sum;
    end loop;

  elsif d.doc_type = 'writeoff' then
    -- ВНИМАНИЕ: ниже уже идут записи; любая новая проверка должна стоять выше, в блоке предпроверок, иначе return err оставит частично проведённый документ
    for l in select * from tandem.document_lines where document_id = p_doc and line_kind = 'item' order by item_code loop
      v_cost := tandem.store_avg(d.store_from, l.item_code);
      perform tandem.apply_move(p_doc, l.id, d.store_from, l.item_code, -l.qty, v_cost, d.doc_date);
      v_line_sum := round(l.qty * v_cost, 2);
      update tandem.document_lines set price = v_cost, sum = v_line_sum where id = l.id;
      v_sum := v_sum + v_line_sum;
    end loop;

  elsif d.doc_type = 'production' then
    for l in select dl.*, i.item_type from tandem.document_lines dl join tandem.items i on i.code = dl.item_code
             where dl.document_id = p_doc and dl.line_kind = 'item' order by dl.sort_order loop
      if l.item_type not in ('dish','prepared') then return tandem.err('validation', 'Выпускать можно только блюда и полуфабрикаты: ' || l.item_code); end if;
      if tandem.active_chart(l.item_code, d.doc_date) is null then v_missing := v_missing || l.item_code; end if;
    end loop;
    if cardinality(v_missing) > 0 then
      return tandem.err('validation', 'Нет действующей техкарты на дату документа: ' || array_to_string(v_missing, ', '));
    end if;
    -- ВНИМАНИЕ: ниже уже идут записи; любая новая проверка должна стоять выше, в блоке предпроверок, иначе return err оставит частично проведённый документ
    delete from tandem.document_lines where document_id = p_doc and line_kind = 'consume';
    for l in select * from tandem.document_lines where document_id = p_doc and line_kind = 'item' order by item_code loop
      v_line_sum := 0;
      for c in select item_code, qty from tandem.doc_consume_plan(p_doc) p where p.line_id = l.id order by item_code loop
        -- Округляем расход один раз: и в строку, и в движение, и в сумму идёт одно и то же число.
        v_qty := round(c.qty, 4);
        v_cost := tandem.store_avg(d.store_from, c.item_code);
        insert into tandem.document_lines (document_id, line_kind, item_code, qty, unit_id, price, sum, note, sort_order)
          select p_doc, 'consume', c.item_code, v_qty, i.unit_id, v_cost, round(v_qty * v_cost, 2), l.item_code, 1000 + l.sort_order
          from tandem.items i where i.code = c.item_code;
        perform tandem.apply_move(p_doc, l.id, d.store_from, c.item_code, -v_qty, v_cost, d.doc_date);
        v_line_sum := v_line_sum + round(v_qty * v_cost, 2);
      end loop;
      v_cost := case when l.qty > 0 then round(v_line_sum / l.qty, 4) else 0 end;
      perform tandem.apply_move(p_doc, l.id, d.store_from, l.item_code, l.qty, v_cost, d.doc_date);
      update tandem.document_lines set price = v_cost, sum = v_line_sum where id = l.id;
      v_sum := v_sum + v_line_sum;
    end loop;

  elsif d.doc_type = 'sale' then
    -- Продажа (подпроект 4): у позиции есть действующая на дату карта — списываются её
    -- ингредиенты (один уровень, как в производстве), карты нет — сама позиция. Строка
    -- позиции хранит цену продажи и выручку; сумма документа — себестоимость проданного.
    -- Сначала строки расхода по всем позициям, затем движения одним проходом по item_code:
    -- блокировки остатков берутся в одном порядке у всех документов (0023, ревью п. 3).
    -- Цена расхода берётся до движений: средняя склада от расхода не меняется.
    -- ВНИМАНИЕ: ниже уже идут записи; любая новая проверка должна стоять выше, в блоке предпроверок, иначе return err оставит частично проведённый документ
    delete from tandem.document_lines where document_id = p_doc and line_kind = 'consume';
    for l in select * from tandem.document_lines where document_id = p_doc and line_kind = 'item' order by item_code loop
      if tandem.active_chart(l.item_code, d.doc_date) is not null then
        insert into tandem.document_lines (document_id, line_kind, item_code, qty, unit_id, price, sum, note, sort_order)
          -- Псевдоним pl, а не c: c — переменная цикла ниже, и plpgsql подставил бы её вместо
          -- колонки («record c is not assigned yet» на первой же продаже блюда с картой).
          select p_doc, 'consume', pl.item_code, round(pl.qty, 4), i.unit_id, tandem.store_avg(d.store_from, pl.item_code),
                 round(round(pl.qty, 4) * tandem.store_avg(d.store_from, pl.item_code), 2), l.item_code, 1000 + l.sort_order
            from tandem.doc_consume_plan(p_doc) pl join tandem.items i on i.code = pl.item_code
           where pl.line_id = l.id;
      else
        insert into tandem.document_lines (document_id, line_kind, item_code, qty, unit_id, price, sum, note, sort_order)
          select p_doc, 'consume', l.item_code, round(l.qty, 4), i.unit_id, tandem.store_avg(d.store_from, l.item_code),
                 round(round(l.qty, 4) * tandem.store_avg(d.store_from, l.item_code), 2), l.item_code, 1000 + l.sort_order
            from tandem.items i where i.code = l.item_code;
      end if;
      update tandem.document_lines set sum = round(l.qty * coalesce(l.price, 0), 2) where id = l.id;
    end loop;
    for c in select cl.item_code, cl.qty, cl.price, il.id as line_id
               from tandem.document_lines cl
               join tandem.document_lines il on il.document_id = p_doc and il.line_kind = 'item' and il.item_code = cl.note
              where cl.document_id = p_doc and cl.line_kind = 'consume'
              order by cl.item_code, il.item_code loop
      perform tandem.apply_move(p_doc, c.line_id, d.store_from, c.item_code, -c.qty, c.price, d.doc_date);
    end loop;
    select coalesce(sum(sum), 0) into v_sum from tandem.document_lines where document_id = p_doc and line_kind = 'consume';

  elsif d.doc_type = 'inventory' then
    -- ВНИМАНИЕ: ниже уже идут записи; любая новая проверка должна стоять выше, в блоке предпроверок, иначе return err оставит частично проведённый документ
    for l in select * from tandem.document_lines where document_id = p_doc and line_kind = 'item' order by item_code loop
      -- I4: расчётный остаток читается под локом той же пары, что потом изменит apply_move,
      -- иначе параллельное списание успевало пройти между чтением и записью, и недостача
      -- считалась от остатка, которого уже нет.
      insert into tandem.stock_balances (store_id, item_code) values (d.store_from, l.item_code)
        on conflict (store_id, item_code) do update set updated_at = now();
      select qty into v_calc from tandem.stock_balances
        where store_id = d.store_from and item_code = l.item_code for update;
      v_calc := coalesce(v_calc, 0);
      v_diff := l.fact_qty - v_calc;
      v_cost := tandem.store_avg(d.store_from, l.item_code);
      if v_diff <> 0 then
        perform tandem.apply_move(p_doc, l.id, d.store_from, l.item_code, v_diff, v_cost, d.doc_date);
      end if;
      v_line_sum := round(v_diff * v_cost, 2);
      update tandem.document_lines set calc_qty = v_calc, qty = l.fact_qty, price = v_cost, sum = v_line_sum where id = l.id;
      v_sum := v_sum + v_line_sum;
    end loop;
  end if;

  update tandem.documents set status = 'posted', posted_by = p_user.id, posted_at = now(),
         total_sum = round(v_sum, 2), updated_by = p_user.id, updated_at = now() where id = p_doc;

  select coalesce(jsonb_agg(jsonb_build_object('item_code', t.item_code, 'name', i.name, 'store_id', t.store_id,
           'store_name', s.name, 'balance_after', b.qty) order by i.name), '[]'::jsonb)
    into v_warn
    from (select distinct store_id, item_code from tandem.stock_moves where document_id = p_doc) t
    join tandem.stock_balances b on b.store_id = t.store_id and b.item_code = t.item_code
    join tandem.items i on i.code = t.item_code join tandem.stores s on s.id = t.store_id
    where b.qty < 0;
  return jsonb_build_object('ok', true, 'warnings', v_warn, 'total_sum', round(v_sum, 2));
end $function$
;

CREATE OR REPLACE FUNCTION tandem.doc_preview(p_doc uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
AS $function$
declare d record; v_consume jsonb := '[]'::jsonb; v_warn jsonb;
begin
  select * into d from tandem.documents where id = p_doc;
  if d.id is null then return jsonb_build_object('warnings','[]'::jsonb,'consume','[]'::jsonb); end if;
  if d.doc_type = 'production' then
    select coalesce(jsonb_agg(jsonb_build_object('item_code', p.item_code, 'name', i.name, 'unit_id', i.unit_id,
             'qty', round(p.qty, 4), 'price', tandem.store_avg(d.store_from, p.item_code),
             'sum', round(p.qty * tandem.store_avg(d.store_from, p.item_code), 2)) order by i.name), '[]'::jsonb)
      into v_consume
      from (select item_code, sum(qty) qty from tandem.doc_consume_plan(p_doc) group by item_code) p
      join tandem.items i on i.code = p.item_code;
  end if;
  -- Исходящие количества по паре (склад, позиция). Инвентаризации здесь нет: её строки
  -- задают факт, а не расход, и итоговая выборка всё равно отбрасывала этот тип —
  -- ветка была мёртвой и только путала при чтении.
  with outgoing as (
    select d.store_from as store_id, l.item_code, sum(l.qty) as q
      from tandem.document_lines l where l.document_id = p_doc and l.line_kind = 'item'
       and d.doc_type in ('transfer','writeoff') group by l.item_code
    union all
    select d.store_from, p.item_code, sum(p.qty) from tandem.doc_consume_plan(p_doc) p
      where d.doc_type = 'production' group by p.item_code
  ),
  agg as (select store_id, item_code, sum(q) q from outgoing where q > 0 group by store_id, item_code)
  select coalesce(jsonb_agg(jsonb_build_object('item_code', a.item_code, 'name', i.name, 'store_id', a.store_id,
           'store_name', s.name, 'balance_after', round(coalesce(b.qty,0) - a.q, 4)) order by i.name), '[]'::jsonb)
    into v_warn
    from agg a join tandem.items i on i.code = a.item_code join tandem.stores s on s.id = a.store_id
    left join tandem.stock_balances b on b.store_id = a.store_id and b.item_code = a.item_code
    where coalesce(b.qty,0) - a.q < 0;
  return jsonb_build_object('warnings', v_warn, 'consume', v_consume);
end $function$
;

CREATE OR REPLACE FUNCTION tandem.doc_unpost(p_doc uuid, p_user tandem.users)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
declare d record; v_inv text; v_pairs text[]; p text; v_warn jsonb;
begin
  select * into d from tandem.documents where id = p_doc for update;
  if d.id is null then return tandem.err('not_found', 'Документ не найден'); end if;
  if d.status <> 'posted' then return tandem.err('validation', 'Документ не проведён'); end if;
  if not tandem.office_can(p_user.role, 'doc:' || d.doc_type, 'edit') then
    return tandem.err('forbidden', 'Нет права отменять документы этого типа');
  end if;
  select number into v_inv from tandem.documents inv
    where inv.doc_type = 'inventory' and inv.status = 'posted' and inv.id <> p_doc
      and inv.posted_at > d.posted_at and inv.store_from in (d.store_from, d.store_to)
    order by inv.posted_at limit 1;
  if v_inv is not null then
    return tandem.err('validation', 'После этого документа проведена инвентаризация ' || v_inv || ' — сначала отмените её');
  end if;
  with del as (delete from tandem.stock_moves where document_id = p_doc returning store_id, item_code)
    select array_agg(distinct store_id::text || '|' || item_code) into v_pairs from del;
  foreach p in array coalesce(v_pairs, '{}'::text[]) loop
    perform tandem.rebuild_balance(split_part(p, '|', 1)::uuid, split_part(p, '|', 2));
  end loop;
  delete from tandem.document_lines where document_id = p_doc and line_kind = 'consume';
  update tandem.document_lines set calc_qty = null, sum = null,
         price = case when d.doc_type in ('invoice_in','sale') then price else null end
    where document_id = p_doc;
  update tandem.documents set status = 'draft', posted_by = null, posted_at = null, total_sum = null,
         updated_by = p_user.id, updated_at = now() where id = p_doc;
  -- Пересборка могла увести пары в минус (например, отменён ранний приход) — формат тот же, что у doc_post.
  select coalesce(jsonb_agg(jsonb_build_object('item_code', b.item_code, 'name', i.name, 'store_id', b.store_id,
           'store_name', s.name, 'balance_after', b.qty) order by i.name), '[]'::jsonb)
    into v_warn
    from unnest(coalesce(v_pairs, '{}'::text[])) x(pair)
    join tandem.stock_balances b on b.store_id = split_part(x.pair, '|', 1)::uuid and b.item_code = split_part(x.pair, '|', 2)
    join tandem.items i on i.code = b.item_code
    join tandem.stores s on s.id = b.store_id
    where b.qty < 0;
  return jsonb_build_object('ok', true, 'warnings', v_warn);
end $function$
;

CREATE OR REPLACE FUNCTION tandem.err(p_code text, p_msg text)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select jsonb_build_object('ok', false, 'error', p_code, 'message', p_msg)
$function$
;

CREATE OR REPLACE FUNCTION tandem.item_cost(p_code text, p_date date DEFAULT CURRENT_DATE, p_depth integer DEFAULT 0)
 RETURNS TABLE(cost numeric, partial numeric, missing text[])
 LANGUAGE plpgsql
 STABLE
AS $function$
declare
  v_type text; v_price numeric; v_chart uuid; v_out numeric;
  v_sum numeric := 0; v_missing text[] := '{}'; v_all boolean := true;
  r record; s record;
begin
  if p_depth > 10 then
    return query select null::numeric, null::numeric, array['cycle:' || p_code]; return;
  end if;
  select item_type, cost_price into v_type, v_price from tandem.items where code = p_code;
  if not found then
    return query select null::numeric, null::numeric, array[p_code]; return;
  end if;
  if v_type in ('goods','service') then
    if v_price is null then
      return query select null::numeric, null::numeric, array[p_code];
    else
      return query select v_price, v_price, '{}'::text[];
    end if;
    return;
  end if;
  v_chart := tandem.active_chart(p_code, p_date);
  if v_chart is null then
    return query select null::numeric, null::numeric, array[p_code]; return;
  end if;
  select output_amount into v_out from tandem.charts where id = v_chart;
  for r in select ingredient_code, brutto from tandem.chart_lines where chart_id = v_chart loop
    select * into s from tandem.item_cost(r.ingredient_code, p_date, p_depth + 1);
    if s.cost is null then
      v_all := false;
      v_missing := v_missing || s.missing;
    else
      v_sum := v_sum + r.brutto * s.cost;
    end if;
  end loop;
  return query select
    case when v_all then round(v_sum / v_out, 4) end,
    round(v_sum / v_out, 4),
    (select coalesce(array_agg(distinct m), '{}'::text[]) from unnest(v_missing) m);
end $function$
;

CREATE OR REPLACE FUNCTION tandem.like_escape(p text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select replace(replace(replace(p, '\', '\\'), '%', '\%'), '_', '\_')
$function$
;

CREATE OR REPLACE FUNCTION tandem.menu_foodcost(p_point text DEFAULT NULL::text, p_date date DEFAULT CURRENT_DATE, p_group uuid DEFAULT NULL::uuid)
 RETURNS TABLE(code text, name text, group_name text, unit_id text, cost numeric, price numeric, markup_pct numeric, foodcost_pct numeric, over_limit boolean, missing text[])
 LANGUAGE sql
 STABLE
AS $function$
  with recursive
  lim as (select coalesce((select value::numeric from tandem.settings where key = 'foodcost_alert'), 35) as v),
  dishes as (
    select i.code, i.name, g.name as group_name, i.unit_id, coalesce(pp.price, i.price) as price
    from tandem.items i
    left join tandem.item_groups g on g.id = i.group_id
    left join tandem.item_prices pp on p_point is not null and pp.point_id = p_point and pp.item_code = i.code
    where i.active and i.for_sale and i.item_type in ('dish','prepared')
      and (p_group is null or i.group_id = p_group)
  ),
  walk as (
    select d.code as root, d.code as node, 1::numeric as factor, 0 as depth, array[d.code] as path
    from dishes d
    union all
    select w.root, cl.ingredient_code, w.factor * cl.brutto / c.output_amount, w.depth + 1, w.path || cl.ingredient_code
    from walk w
    join tandem.items i on i.code = w.node and i.item_type in ('dish','prepared')
    join tandem.charts c on c.id = tandem.active_chart(w.node, p_date)
    join tandem.chart_lines cl on cl.chart_id = c.id
    where w.depth < 10 and not (cl.ingredient_code = any(w.path))
  ),
  leaves as (
    select w.root, w.node, w.factor, i.item_type, i.cost_price
    from walk w join tandem.items i on i.code = w.node
    where i.item_type in ('goods','service') or tandem.active_chart(w.node, p_date) is null
       -- M6: обход обрывается на глубине 10 (walk выше), и без этого условия узел на границе
       -- просто исчезал бы из расчёта, а блюдо получало бы «полную» себестоимость по обрубку.
       -- Такой узел — лист без цены: complete становится false, а его код попадает в missing.
       or w.depth >= 10
  ),
  agg as (
    select root,
      sum(case when item_type in ('goods','service') and cost_price is not null then factor * cost_price else 0 end) as partial,
      bool_and(item_type in ('goods','service') and cost_price is not null) as complete,
      array_remove(array_agg(distinct case when not (item_type in ('goods','service') and cost_price is not null) then node end), null) as missing
    from leaves group by root
  )
  select d.code, d.name, d.group_name, d.unit_id,
    case when a.complete then round(a.partial, 2) end as cost,
    d.price,
    case when a.complete and a.partial > 0 and d.price is not null then round((d.price - a.partial) / a.partial * 100, 1) end as markup_pct,
    case when a.complete and d.price > 0 then round(a.partial / d.price * 100, 1) end as foodcost_pct,
    case when a.complete and d.price > 0 then a.partial / d.price * 100 > (select v from lim) else false end as over_limit,
    coalesce(a.missing, array[d.code]) as missing
  from dishes d left join agg a on a.root = d.code
  order by d.name
$function$
;

CREATE OR REPLACE FUNCTION tandem.next_doc_number(p_type text, p_date date)
 RETURNS text
 LANGUAGE plpgsql
AS $function$
declare v_no int; v_year int := extract(year from p_date)::int; v_pref text;
begin
  v_pref := case p_type when 'invoice_in' then 'ПН' when 'transfer' then 'ПМ' when 'writeoff' then 'СП'
                        when 'production' then 'АП' when 'inventory' then 'ИН'
                        when 'sale' then 'ПД' else 'ДК' end;
  insert into tandem.doc_counters (doc_type, year, last_no) values (p_type, v_year, 1)
    on conflict (doc_type, year) do update set last_no = tandem.doc_counters.last_no + 1
    returning last_no into v_no;
  return v_pref || '-' || v_year || '-' || lpad(v_no::text, 6, '0');
end $function$
;

CREATE OR REPLACE FUNCTION tandem.office_can(p_role text, p_section text, p_action text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  select exists (select 1 from tandem.role_permissions
                 where role = p_role and section = p_section and action = p_action)
$function$
;

CREATE OR REPLACE FUNCTION tandem.office_charts(action text, payload jsonb, v_user tandem.users)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'tandem', 'public'
AS $function$
declare
  v_code   text := payload->>'code';
  v_id     uuid := nullif(payload->>'id','')::uuid;
  v_date   date := coalesce(nullif(payload->>'date','')::date, current_date);
  v_q      text := btrim(coalesce(payload->>'q',''));
  v_page   int  := greatest(coalesce((payload->>'page')::int, 1), 1);
  v_only   text := nullif(payload->>'only','');
  v_group  uuid := nullif(payload->>'group_id','')::uuid;
  v_total  int; v_rows jsonb; v_type text; v_from date; v_to date; v_out numeric;
  v_prev   uuid; v_line jsonb; v_ing text; v_ing_type text; v_active boolean;
  v_chart  uuid; v_item jsonb; v_versions jsonb; v_lines jsonb; v_cost record;
  v_csv    text; v_limit numeric;
begin
  -- ---------- список ----------
  if action = 'charts_list' then
    v_limit := coalesce((select value::numeric from tandem.settings where key = 'foodcost_alert'), 35);
    with base as (
      select i.code, i.name, i.item_type, i.unit_id, g.name as group_name, i.price,
             tandem.active_chart(i.code, current_date) as chart_id
      from tandem.items i left join tandem.item_groups g on g.id = i.group_id
      where i.active and i.item_type in ('dish','prepared')
        and (v_q = '' or i.name ilike '%' || v_q || '%' or i.code = v_q)
        and (v_group is null or i.group_id = v_group)
    ),
    -- Себестоимость считается рекурсивно, поэтому её берут только для страницы (join ниже).
    -- Исключение — фильтр «с картой, но без себестоимости»: он без расчёта не работает.
    no_cost as (
      select b.*
      from base b
      left join lateral tandem.item_cost(b.code, current_date) k on true
      where v_only = 'no_cost' and b.chart_id is not null and k.cost is null
    ),
    flt as (
      select * from base where v_only is null or (v_only = 'no_chart' and chart_id is null)
      union all
      select * from no_cost
    ),
    page as (
      select f.*, count(*) over () as total_cnt
      from flt f order by f.name limit 200 offset (v_page - 1) * 200
    )
    select coalesce(max(p.total_cnt), 0),
           coalesce(jsonb_agg(jsonb_build_object(
             'code', p.code, 'name', p.name, 'item_type', p.item_type, 'unit_id', p.unit_id,
             'group_name', p.group_name, 'chart_id', p.chart_id, 'date_from', c.date_from,
             'output_amount', c.output_amount, 'cost', k.cost, 'price', p.price,
             'foodcost_pct', case when k.cost is not null and p.price > 0
                               then round(k.cost / p.price * 100, 1) end,
             'over_limit', case when k.cost is not null and p.price > 0
                             then k.cost / p.price * 100 > v_limit else false end,
             'missing_count', coalesce((select count(*) from unnest(k.missing) m where m <> p.code), 0)) order by p.name), '[]'::jsonb)
      into v_total, v_rows
      from page p
      left join tandem.charts c on c.id = p.chart_id
      left join lateral tandem.item_cost(p.code, current_date) k on true;
    return jsonb_build_object('ok', true, 'total', v_total, 'page', v_page,
      'pages', greatest(ceil(v_total / 200.0)::int, 1), 'limit', v_limit, 'rows', v_rows);
  end if;

  -- ---------- карточка ----------
  if action = 'chart_get' then
    select item_type into v_type from tandem.items where code = v_code;
    if v_type is null then return tandem.err('not_found', 'Позиция не найдена'); end if;
    if v_id is not null then
      -- I3: запросили конкретную версию — дальше всё считается на её дату начала. Иначе строки
      -- брали цену ингредиента на сегодня, а итог — на дату версии, и они расходились.
      select id, date_from into v_chart, v_date from tandem.charts where id = v_id and item_code = v_code;
      if v_chart is null then return tandem.err('not_found', 'Версия карты не найдена у этой позиции'); end if;
    else
      v_chart := tandem.active_chart(v_code, v_date);
    end if;
    select jsonb_build_object('code', i.code, 'name', i.name, 'item_type', i.item_type,
             'unit_id', i.unit_id, 'price', i.price)
      into v_item from tandem.items i where i.code = v_code;
    select coalesce(jsonb_agg(jsonb_build_object('id', id, 'date_from', date_from, 'date_to', date_to,
             'source', source) order by date_from desc), '[]'::jsonb)
      into v_versions from tandem.charts where item_code = v_code;
    if v_chart is null then
      return jsonb_build_object('ok', true, 'item', v_item, 'chart', null::jsonb,
        'cost', null::numeric, 'partial', null::numeric,
        'missing', to_jsonb(array[v_code]), 'versions', v_versions);
    end if;
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', cl.id, 'ingredient_code', cl.ingredient_code, 'name', i.name, 'unit', i.unit_id,
        'item_type', i.item_type, 'brutto', cl.brutto, 'netto', cl.netto, 'output', cl.output,
        'note', cl.note, 'ing_cost', k.cost,
        'line_cost', case when k.cost is not null then round(cl.brutto * k.cost, 4) end,
        'cold_loss_pct', case when cl.brutto > 0 then round((cl.brutto - cl.netto) / cl.brutto * 100, 1) end,
        'hot_loss_pct',  case when cl.netto  > 0 then round((cl.netto - cl.output) / cl.netto  * 100, 1) end)
        order by cl.sort_order, i.name), '[]'::jsonb)
      into v_lines
      from tandem.chart_lines cl join tandem.items i on i.code = cl.ingredient_code
      left join lateral tandem.item_cost(cl.ingredient_code, v_date) k on true
      where cl.chart_id = v_chart;
    -- одна дата на всю карточку: v_date выше подменён датой версии, если её спросили по id
    select * into v_cost from tandem.item_cost(v_code, v_date);
    return jsonb_build_object('ok', true, 'item', v_item,
      'chart', (select jsonb_build_object('id', c.id, 'date_from', c.date_from, 'date_to', c.date_to,
                  'output_amount', c.output_amount, 'technology', c.technology, 'note', c.note,
                  'source', c.source, 'lines', v_lines)
                from tandem.charts c where c.id = v_chart),
      'cost', v_cost.cost, 'partial', v_cost.partial, 'missing', to_jsonb(v_cost.missing),
      'versions', v_versions);
  end if;

  -- ---------- сохранение ----------
  if action = 'chart_save' then
    select item_type into v_type from tandem.items where code = v_code and active;
    if v_type is null then return tandem.err('not_found', 'Позиция не найдена или выключена'); end if;
    if v_type not in ('dish','prepared') then
      return tandem.err('validation', 'Техкарта бывает только у блюда или полуфабриката');
    end if;
    v_from := nullif(payload->>'date_from','')::date;
    v_to   := nullif(payload->>'date_to','')::date;
    v_out  := nullif(payload->>'output_amount','')::numeric;
    if v_from is null then return tandem.err('validation', 'Укажите дату начала действия'); end if;
    if v_to is not null and v_to < v_from then return tandem.err('validation', 'Дата окончания раньше начала'); end if;
    if v_out is null or v_out <= 0 then return tandem.err('validation', 'Выход должен быть больше нуля'); end if;
    if jsonb_typeof(payload->'lines') <> 'array' or jsonb_array_length(payload->'lines') = 0 then
      return tandem.err('validation', 'В карте нет ни одной строки');
    end if;
    -- строки: ингредиент существует, активен, не само блюдо, не ведёт обратно к блюду
    for v_line in select * from jsonb_array_elements(payload->'lines') loop
      v_ing := v_line->>'ingredient_code';
      select item_type, active into v_ing_type, v_active from tandem.items where code = v_ing;
      if v_ing_type is null then return tandem.err('validation', 'Ингредиент не найден: ' || coalesce(v_ing,'')); end if;
      if not v_active then return tandem.err('validation', 'Ингредиент выключен: ' || v_ing); end if;
      if v_ing = v_code then return tandem.err('validation', 'Блюдо не может входить само в себя'); end if;
      if v_ing_type in ('dish','prepared') and tandem.chart_reaches(v_ing, v_code, v_from) then
        return tandem.err('validation', 'Цикл: ' || v_ing || ' уже содержит ' || v_code);
      end if;
      if coalesce((v_line->>'brutto')::numeric, -1) < 0 or coalesce((v_line->>'netto')::numeric, -1) < 0
         or coalesce((v_line->>'output')::numeric, -1) < 0 then
        return tandem.err('validation', 'Количества в строке ' || v_ing || ' должны быть числами не меньше нуля');
      end if;
      if (v_line->>'netto')::numeric > (v_line->>'brutto')::numeric then
        return tandem.err('validation', 'Нетто больше брутто в строке ' || v_ing);
      end if;
    end loop;
    -- пересечение дат с другой картой этого блюда
    if exists (select 1 from tandem.charts c where c.item_code = v_code and (v_id is null or c.id <> v_id)
               and daterange(c.date_from, c.date_to, '[]') && daterange(v_from, v_to, '[]')) then
      return tandem.err('validation', 'На эти даты уже действует другая версия — закройте её датой или выберите другую дату начала');
    end if;
    if v_id is null then
      insert into tandem.charts (item_code, date_from, date_to, output_amount, technology, note, source, created_by, updated_by)
        values (v_code, v_from, v_to, v_out, payload->>'technology', payload->>'note', 'office', v_user.id, v_user.id)
        returning id into v_id;
    else
      -- I1: правка карты из iiko делает её офисной — перенос её больше не трогает. iiko_id
      -- сохраняется: по нему повторный перенос узнаёт карту и пропускает как «правлена в офисе».
      -- M4: technology и note меняются только когда ключ пришёл в payload — иначе точечное
      -- сохранение (фронт передаёт не всю карточку) молча стирало бы описание и примечание.
      update tandem.charts set date_from = v_from, date_to = v_to, output_amount = v_out,
        technology = case when payload ? 'technology' then payload->>'technology' else technology end,
        note = case when payload ? 'note' then payload->>'note' else note end,
        source = 'office',
        updated_by = v_user.id, updated_at = now()
        where id = v_id and item_code = v_code;
      if not found then return tandem.err('not_found', 'Карта не найдена'); end if;
      delete from tandem.chart_lines where chart_id = v_id;
    end if;
    insert into tandem.chart_lines (chart_id, ingredient_code, brutto, netto, output, sort_order, note)
      select v_id, x->>'ingredient_code', (x->>'brutto')::numeric, (x->>'netto')::numeric,
             (x->>'output')::numeric, (ord - 1)::int, nullif(x->>'note','')
      from jsonb_array_elements(payload->'lines') with ordinality as t(x, ord);
    return jsonb_build_object('ok', true, 'id', v_id);
  end if;

  -- ---------- новая версия с даты ----------
  if action = 'chart_new_version' then
    v_from := nullif(payload->>'date_from','')::date;
    if v_from is null then return tandem.err('validation', 'Укажите дату начала новой версии'); end if;
    v_prev := tandem.active_chart(v_code, v_from - 1);
    if v_prev is null then
      return tandem.err('validation', 'Нет действующей карты, которую можно продолжить — создайте карту обычным сохранением');
    end if;
    if exists (select 1 from tandem.charts where item_code = v_code and date_from >= v_from) then
      return tandem.err('validation', 'Уже есть версия с более поздней датой начала');
    end if;
    update tandem.charts set date_to = v_from - 1, updated_by = v_user.id, updated_at = now() where id = v_prev;
    insert into tandem.charts (item_code, date_from, date_to, output_amount, technology, note, source, created_by, updated_by)
      select item_code, v_from, null, output_amount, technology, note, 'office', v_user.id, v_user.id
      from tandem.charts where id = v_prev returning id into v_id;
    insert into tandem.chart_lines (chart_id, ingredient_code, brutto, netto, output, sort_order, note)
      select v_id, ingredient_code, brutto, netto, output, sort_order, note
      from tandem.chart_lines where chart_id = v_prev;
    return jsonb_build_object('ok', true, 'id', v_id);
  end if;

  -- ---------- удаление ----------
  if action = 'chart_delete' then
    select item_code, date_from into v_code, v_from from tandem.charts where id = v_id and source = 'office';
    if v_code is null then
      return tandem.err('validation', 'Удалять можно только карты, созданные в бэк-офисе; карты из iiko закрываются датой');
    end if;
    if exists (select 1 from tandem.charts where item_code = v_code and date_from > v_from) then
      return tandem.err('validation', 'После этой версии есть более поздние — удалите сначала их');
    end if;
    delete from tandem.charts where id = v_id;
    -- предыдущая версия, закрытая ради удалённой, снова становится открытой
    update tandem.charts set date_to = null where item_code = v_code and date_to = v_from - 1
      and not exists (select 1 from tandem.charts c2 where c2.item_code = v_code and c2.date_from > v_from - 1);
    return jsonb_build_object('ok', true);
  end if;

  -- ---------- отчёт ----------
  if action = 'foodcost_report' then
    v_limit := coalesce((select value::numeric from tandem.settings where key = 'foodcost_alert'), 35);
    select coalesce(jsonb_agg(to_jsonb(m)), '[]'::jsonb),
           'code;name;group;unit;cost;price;markup_pct;foodcost_pct;over_limit;missing' || E'\n' ||
           coalesce(string_agg(concat_ws(';', m.code, replace(m.name,';',','),
             coalesce(replace(m.group_name,';',','),''), m.unit_id,
             coalesce(m.cost::text,''), coalesce(m.price::text,''), coalesce(m.markup_pct::text,''),
             coalesce(m.foodcost_pct::text,''), case when m.over_limit then '1' else '0' end,
             array_to_string(m.missing, ',')), E'\n'), '')
      into v_rows, v_csv
      from tandem.menu_foodcost(nullif(payload->>'point_id',''), v_date, v_group) m;
    return jsonb_build_object('ok', true, 'rows', v_rows, 'limit', v_limit, 'csv', v_csv);
  end if;

  return tandem.err('unknown_action', 'Неизвестное действие: ' || action);
exception
  -- charts_no_overlap ловится проверкой выше; сюда доходят только гонки двух правок разом.
  when exclusion_violation then
    return tandem.err('validation', 'На эти даты уже действует другая версия этой карты');
end $function$
;

CREATE OR REPLACE FUNCTION tandem.office_counteragents(action text, payload jsonb, v_user tandem.users)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'tandem', 'public'
AS $function$
declare
  v_id uuid; v_name text; v_kind text;
  v_q text := btrim(coalesce(payload->>'q',''));
  v_page int := greatest(coalesce((payload->>'page')::int, 1), 1);
  v_total int; v_rows jsonb;
  v_digits text := regexp_replace(btrim(coalesce(payload->>'q','')), '\D', '', 'g');
begin
  if action = 'counteragents_list' then
    v_kind := nullif(payload->>'kind','');
    select count(*) into v_total from tandem.counteragents c
      where (v_q = '' or c.name ilike '%' || tandem.like_escape(v_q) || '%'
             or c.bin like '%' || tandem.like_escape(v_q) || '%'
             or (length(v_digits) >= 5 and v_q ~ '^[0-9+() -]+$'
                 and regexp_replace(coalesce(c.phone, ''), '\D', '', 'g') like '%' || right(v_digits, 10) || '%'))
        and (v_kind is null or c.kind = v_kind)
        and (payload->>'active' is null or c.active = (payload->>'active')::boolean);
    select coalesce(jsonb_agg(r), '[]'::jsonb) into v_rows from (
      select c.id, c.name, c.kind, c.bin, c.phone, c.note, c.active
      from tandem.counteragents c
      where (v_q = '' or c.name ilike '%' || tandem.like_escape(v_q) || '%'
             or c.bin like '%' || tandem.like_escape(v_q) || '%'
             or (length(v_digits) >= 5 and v_q ~ '^[0-9+() -]+$'
                 and regexp_replace(coalesce(c.phone, ''), '\D', '', 'g') like '%' || right(v_digits, 10) || '%'))
        and (v_kind is null or c.kind = v_kind)
        and (payload->>'active' is null or c.active = (payload->>'active')::boolean)
      order by c.active desc, c.name
      limit 200 offset (v_page - 1) * 200) r;
    return jsonb_build_object('ok', true, 'rows', v_rows, 'total', v_total, 'page', v_page,
                              'pages', greatest(ceil(v_total / 200.0)::int, 1));
  end if;

  if action = 'counteragent_save' then
    v_name := btrim(coalesce(payload->>'name',''));
    if v_name = '' then return tandem.err('validation', 'Название контрагента пустое'); end if;
    v_kind := coalesce(payload->>'kind','');
    if v_kind not in ('supplier','customer','employee','other') then
      return tandem.err('validation', 'Вид: supplier, customer, employee или other');
    end if;
    v_id := nullif(payload->>'id','')::uuid;
    if v_id is null then
      insert into tandem.counteragents (name, kind, bin, phone, note, active)
        values (v_name, v_kind, nullif(payload->>'bin',''), nullif(payload->>'phone',''),
                payload->>'note', coalesce((payload->>'active')::boolean, true)) returning id into v_id;
    else
      update tandem.counteragents set name = v_name, kind = v_kind,
        bin = case when payload ? 'bin' then nullif(payload->>'bin','') else bin end,
        phone = case when payload ? 'phone' then nullif(payload->>'phone','') else phone end,
        note = coalesce(payload->>'note', note),
        active = coalesce((payload->>'active')::boolean, active)
        where id = v_id;
      if not found then return tandem.err('not_found', 'Контрагент не найден'); end if;
    end if;
    return jsonb_build_object('ok', true, 'id', v_id);
  end if;

  return tandem.err('unknown_action', 'Неизвестное действие: ' || action);
end $function$
;

CREATE OR REPLACE FUNCTION tandem.office_nomenclature(action text, payload jsonb, v_user tandem.users)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'tandem', 'public'
AS $function$
declare
  v_id    uuid;
  v_code  text;
  v_q     text := btrim(coalesce(payload->>'q',''));
  v_page  int  := greatest(coalesce((payload->>'page')::int, 1), 1);
  v_total int;
  v_rows  jsonb;
  v_name  text;
  k       record;   -- себестоимость позиции: (cost, partial, missing)
begin
  -- Себестоимость отдельным действием: карточка товара обходится без пересчёта дерева,
  -- а экран техкарт спрашивает цену ингредиента точечно.
  if action = 'item_cost_get' then
    v_code := payload->>'code';
    if not exists (select 1 from tandem.items where code = v_code) then
      return tandem.err('not_found', 'Позиция не найдена');
    end if;
    select * into k from tandem.item_cost(v_code, coalesce(nullif(payload->>'date','')::date, current_date));
    return jsonb_build_object('ok', true, 'cost', k.cost, 'partial', k.partial, 'missing', to_jsonb(k.missing));
  end if;

  if action = 'groups_list' then
    return jsonb_build_object('ok', true, 'groups', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', g.id, 'parent_id', g.parent_id, 'name', g.name, 'sort_order', g.sort_order,
        'active', g.active, 'items_count', (select count(*) from tandem.items i where i.group_id = g.id and i.active))
        order by g.sort_order, g.name), '[]'::jsonb)
      from tandem.item_groups g));
  end if;

  if action = 'group_save' then
    v_name := btrim(coalesce(payload->>'name',''));
    if v_name = '' then return tandem.err('validation', 'Название группы пустое'); end if;
    v_id := nullif(payload->>'id','')::uuid;
    -- Цикл в дереве групп прятал бы ветку целиком (дерево строится от корня): группа не может
    -- входить сама в себя и в собственную подгруппу.
    if v_id is not null and v_id = nullif(payload->>'parent_id','')::uuid then
      return tandem.err('validation', 'Группа не может входить сама в себя'); end if;
    if v_id is not null and exists (
         with recursive up as (
           select g.id, g.parent_id from tandem.item_groups g where g.id = nullif(payload->>'parent_id','')::uuid
           union
           select g.id, g.parent_id from tandem.item_groups g join up on g.id = up.parent_id)
         select 1 from up where up.id = v_id) then
      return tandem.err('validation', 'Нельзя вложить группу в её же подгруппу'); end if;
    if v_id is null then
      insert into tandem.item_groups (name, parent_id, active)
        values (v_name, nullif(payload->>'parent_id','')::uuid, coalesce((payload->>'active')::boolean, true))
        returning id into v_id;
    else
      update tandem.item_groups set name = v_name,
        parent_id = nullif(payload->>'parent_id','')::uuid,
        active = coalesce((payload->>'active')::boolean, active)
        where id = v_id;
      if not found then return tandem.err('not_found', 'Группа не найдена'); end if;
    end if;
    return jsonb_build_object('ok', true, 'id', v_id);
  end if;

  if action = 'items_search' then
    select count(*) into v_total from tandem.items i
      where (v_q = '' or i.name ilike '%' || tandem.like_escape(v_q) || '%' or i.artikul ilike '%' || tandem.like_escape(v_q) || '%' or i.code = v_q)
        and (nullif(payload->>'group_id','') is null or i.group_id = (payload->>'group_id')::uuid)
        and (nullif(payload->>'item_type','') is null or i.item_type = payload->>'item_type')
        and (payload->>'active' is null or i.active = (payload->>'active')::boolean)
        and (payload->>'for_sale' is null or i.for_sale = (payload->>'for_sale')::boolean);
    select coalesce(jsonb_agg(r), '[]'::jsonb) into v_rows from (
      select i.code, i.name, i.artikul, i.item_type, i.unit_id, i.group_id, g.name as group_name,
             i.active, i.for_sale, i.price
      from tandem.items i left join tandem.item_groups g on g.id = i.group_id
      where (v_q = '' or i.name ilike '%' || tandem.like_escape(v_q) || '%' or i.artikul ilike '%' || tandem.like_escape(v_q) || '%' or i.code = v_q)
        and (nullif(payload->>'group_id','') is null or i.group_id = (payload->>'group_id')::uuid)
        and (nullif(payload->>'item_type','') is null or i.item_type = payload->>'item_type')
        and (payload->>'active' is null or i.active = (payload->>'active')::boolean)
        and (payload->>'for_sale' is null or i.for_sale = (payload->>'for_sale')::boolean)
      order by i.name
      limit 200 offset (v_page - 1) * 200) r;
    return jsonb_build_object('ok', true, 'rows', v_rows, 'total', v_total, 'page', v_page,
                              'pages', greatest(ceil(v_total / 200.0)::int, 1));
  end if;

  -- Пачечное сопоставление ключей из файла остатков с номенклатурой.
  -- Ключ — код и/или название; порядок попыток задан весом pr: собственный код, код iiko,
  -- артикул (в отчётах iiko колонка «Код» — это именно артикул, пятизначный с ведущими
  -- нулями), псевдоним, единственное точное совпадение по названию. Название, под которым
  -- ходят две живые позиции, не сопоставляется вовсе: угаданная пара хуже честного «не нашёл».
  -- Несопоставленные ключи в ответе просто отсутствуют — их показывает форма.
  -- CTE с ключами зовётся kv, а не k: k здесь — объявленная запись себестоимости, и plpgsql
  -- подставляет переменную вместо колонки CTE ("record k is not assigned yet" на любом вызове).
  if action = 'items_lookup_list' then
    if jsonb_typeof(payload->'keys') <> 'array' or jsonb_array_length(payload->'keys') > 2000 then
      return tandem.err('validation', 'Передайте массив ключей (до 2000)');
    end if;
    return jsonb_build_object('ok', true, 'rows', (
      with kv as (
        select (ord - 1)::int as i, nullif(btrim(x->>'code'),'') as code, nullif(btrim(x->>'name'),'') as name
        from jsonb_array_elements(payload->'keys') with ordinality t(x, ord)
      ),
      m as (
        select kv.i, i.code as item_code, i.name, i.unit_id, 'code' as matched_by, 1 as pr
          from kv join tandem.items i on i.active and kv.code is not null and i.code = kv.code
        union all
        select kv.i, i.code, i.name, i.unit_id, 'iiko_code', 2
          from kv join tandem.items i on i.active and kv.code is not null and i.iiko_code = kv.code
        union all
        select kv.i, i.code, i.name, i.unit_id, 'artikul', 3
          from kv join tandem.items i on i.active and kv.code is not null and i.artikul = kv.code
        union all
        select kv.i, i.code, i.name, i.unit_id, 'alias', 4
          from kv join tandem.item_aliases a on kv.name is not null and a.alias = kv.name
          join tandem.items i on i.code = a.item_code and i.active
        union all
        select kv.i, i.code, i.name, i.unit_id, 'name', 5
          from kv
          join (select lower(name) as ln, min(code) as code from tandem.items
                where active group by lower(name) having count(*) = 1) nm
            on kv.name is not null and nm.ln = lower(kv.name)
          join tandem.items i on i.code = nm.code
      ),
      best as (select distinct on (i) i, item_code, name, unit_id, matched_by from m order by i, pr)
      select coalesce(jsonb_agg(jsonb_build_object('i', i, 'item_code', item_code, 'name', name,
                                                   'unit_id', unit_id, 'matched_by', matched_by)
                                order by i), '[]'::jsonb) from best));
  end if;

  if action = 'item_get' then
    v_code := payload->>'code';
    if not exists (select 1 from tandem.items where code = v_code) then
      return tandem.err('not_found', 'Позиция не найдена');
    end if;
    select * into k from tandem.item_cost(v_code, current_date);
    return jsonb_build_object('ok', true,
      'item', (select jsonb_build_object('code', i.code, 'name', i.name, 'artikul', i.artikul,
                 'item_type', i.item_type, 'unit_id', i.unit_id, 'group_id', i.group_id,
                 'group_name', g.name, 'active', i.active, 'for_sale', i.for_sale, 'price', i.price,
                 'note', i.note, 'pack_factor', i.pack_factor, 'pack_unit', i.pack_unit,
                 'pack_price', i.pack_price, 'has_chart', i.has_chart, 'iiko_code', i.iiko_code,
                 'cost_price', i.cost_price, 'cost_date', i.cost_date, 'cost_source', i.cost_source)
               from tandem.items i left join tandem.item_groups g on g.id = i.group_id where i.code = v_code),
      'points', (select coalesce(jsonb_agg(jsonb_build_object(
                   'point_id', p.id, 'point_name', p.name, 'price', pp.price,
                   'rank', r.rank, 'short', coalesce(r.in_short_list, false)) order by p.sort_order), '[]'::jsonb)
                 from tandem.points p
                 left join tandem.item_prices pp on pp.point_id = p.id and pp.item_code = v_code
                 left join tandem.item_rank r on r.point_id = p.id and r.item_code = v_code
                 where p.active),
      'cost', k.cost, 'partial', k.partial, 'missing', to_jsonb(k.missing));
  end if;

  if action = 'item_save' then
    v_name := btrim(coalesce(payload->>'name',''));
    v_code := nullif(payload->>'code','');
    -- Имя обязательно только при создании: правка меняет ровно те поля, что переданы,
    -- иначе точечное «поставить учётную цену» требовало бы тащить с собой всю карточку.
    if v_code is null and v_name = '' then return tandem.err('validation', 'Название позиции пустое'); end if;
    if v_code is null then
      -- создание: тип и единица измерения обязательны
      if coalesce(payload->>'item_type','') not in ('goods','dish','prepared','service') then
        return tandem.err('validation', 'Тип: goods, dish, prepared или service');
      end if;
      if not exists (select 1 from tandem.units where id = payload->>'unit_id') then
        return tandem.err('validation', 'Единица измерения не из справочника');
      end if;
      v_code := nextval('tandem.item_code_seq')::text;
      insert into tandem.items (code, name, artikul, item_type, unit_id, unit, step, group_id, active,
                                for_sale, note, price, pack_factor, pack_unit, pack_price, category, source,
                                cost_price, cost_date, cost_source)
      values (v_code, v_name, nullif(payload->>'artikul',''), payload->>'item_type', payload->>'unit_id',
              payload->>'unit_id', case when payload->>'unit_id' in ('кг','л') then 0.5 else 1 end,
              nullif(payload->>'group_id','')::uuid, coalesce((payload->>'active')::boolean, true),
              coalesce((payload->>'for_sale')::boolean, false), payload->>'note',
              nullif(payload->>'price','')::numeric, nullif(payload->>'pack_factor','')::numeric,
              nullif(payload->>'pack_unit',''), nullif(payload->>'pack_price','')::numeric,
              (select name from tandem.item_groups where id = nullif(payload->>'group_id','')::uuid), 'office',
              nullif(payload->>'cost_price','')::numeric,
              case when nullif(payload->>'cost_price','') is not null then current_date end,
              case when nullif(payload->>'cost_price','') is not null then 'manual' end);
    else
      -- правка: тип и единица измерения необязательны — как остальные поля, меняются только если переданы
      if nullif(payload->>'item_type','') is not null and payload->>'item_type' not in ('goods','dish','prepared','service') then
        return tandem.err('validation', 'Тип: goods, dish, prepared или service');
      end if;
      if nullif(payload->>'unit_id','') is not null and not exists (select 1 from tandem.units where id = payload->>'unit_id') then
        return tandem.err('validation', 'Единица измерения не из справочника');
      end if;
      -- I8: source='office' закрывает строку от повторного переноса из iiko (см. tandem_migrate),
      -- category держится в согласии с группой — на неё смотрят старые экраны точек.
      -- cost_price правится только когда ключ пришёл: пустое значение снимает цену вместе с датой
      -- и источником, иначе учётная цена молча воскресала бы при любой правке карточки.
      update tandem.items set
        name = coalesce(nullif(v_name, ''), name),
        artikul = coalesce(nullif(payload->>'artikul',''), artikul),
        item_type = coalesce(nullif(payload->>'item_type',''), item_type),
        unit_id = coalesce(nullif(payload->>'unit_id',''), unit_id),
        unit = coalesce(nullif(payload->>'unit_id',''), unit),
        group_id = coalesce(nullif(payload->>'group_id','')::uuid, group_id),
        category = coalesce((select g.name from tandem.item_groups g
                             where g.id = coalesce(nullif(payload->>'group_id','')::uuid, items.group_id)),
                            items.category),
        source = 'office',
        active = coalesce((payload->>'active')::boolean, active),
        for_sale = coalesce((payload->>'for_sale')::boolean, for_sale),
        note = coalesce(payload->>'note', note),
        -- Цена по умолчанию правится только когда ключ пришёл: пустое значение её снимает.
        price = case when payload ? 'price' then nullif(payload->>'price','')::numeric else price end,
        pack_factor = case when payload ? 'pack_factor' then nullif(payload->>'pack_factor','')::numeric else pack_factor end,
        pack_unit   = case when payload ? 'pack_unit'   then nullif(payload->>'pack_unit','')            else pack_unit end,
        pack_price  = case when payload ? 'pack_price'  then nullif(payload->>'pack_price','')::numeric  else pack_price end,
        cost_price  = case when payload ? 'cost_price'  then nullif(payload->>'cost_price','')::numeric  else cost_price end,
        cost_date   = case when payload ? 'cost_price'
                           then case when nullif(payload->>'cost_price','') is null then null else current_date end
                           else cost_date end,
        cost_source = case when payload ? 'cost_price'
                           then case when nullif(payload->>'cost_price','') is null then null else 'manual' end
                           else cost_source end
      where code = v_code;
      if not found then return tandem.err('not_found', 'Позиция не найдена'); end if;
    end if;
    return jsonb_build_object('ok', true, 'code', v_code);
  end if;

  if action = 'item_prices_save' then
    v_code := payload->>'code';
    if not exists (select 1 from tandem.items where code = v_code) then
      return tandem.err('not_found', 'Позиция не найдена');
    end if;
    delete from tandem.item_prices pp using jsonb_array_elements(coalesce(payload->'prices','[]'::jsonb)) x
      where pp.item_code = v_code and pp.point_id = x->>'point_id' and nullif(x->>'price','') is null;
    insert into tandem.item_prices (point_id, item_code, price, source)
      select x->>'point_id', v_code, (x->>'price')::numeric, 'office'
      from jsonb_array_elements(coalesce(payload->'prices','[]'::jsonb)) x
      where nullif(x->>'price','') is not null
    on conflict (point_id, item_code) do update set price = excluded.price, source = 'office';
    return jsonb_build_object('ok', true);
  end if;

  return tandem.err('unknown_action', 'Неизвестное действие: ' || action);
end $function$
;

CREATE OR REPLACE FUNCTION tandem.office_permissions(p_role text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
  select coalesce(jsonb_agg(section || ':' || action order by section, action), '[]'::jsonb)
  from tandem.role_permissions where role = p_role
$function$
;

CREATE OR REPLACE FUNCTION tandem.office_session(p_token text)
 RETURNS tandem.users
 LANGUAGE sql
 STABLE
AS $function$
  select u.* from tandem.sessions s join tandem.users u on u.id = s.user_id
  where s.token = p_token and s.expires_at > now() and u.active
$function$
;

CREATE OR REPLACE FUNCTION tandem.office_stock_ext(action text, payload jsonb, v_user tandem.users)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'tandem', 'public'
AS $function$
declare
  v_store uuid := nullif(payload->>'store_id','')::uuid;
  v_q     text := btrim(coalesce(payload->>'q',''));
  v_d1    date;
  v_d2    date;
begin
  -- Оборотная ведомость: по каждой позиции остаток на начало, обороты по видам документов
  -- и остаток на конец — как «Расширенная оборотно-сальдовая ведомость» iiko, чтобы
  -- сверять учёт в параллельной работе. Количества расхода — положительные числа.
  -- Суммы — по себестоимости движений (qty × unit_cost), как «Сумма с/н» в iiko.
  if action = 'stock_turnover_report' then
    v_d1 := coalesce(nullif(payload->>'date_from','')::date, date_trunc('month', current_date)::date);
    v_d2 := coalesce(nullif(payload->>'date_to','')::date, current_date);
    if v_d2 < v_d1 then return tandem.err('validation', 'Дата «по» раньше даты «с»'); end if;
    return jsonb_build_object('ok', true, 'date_from', v_d1, 'date_to', v_d2, 'rows', (
      with m as (
        select m.item_code, m.qty, m.qty * m.unit_cost as s, m.move_date, d.doc_type
          from tandem.stock_moves m join tandem.documents d on d.id = m.document_id
         where m.move_date <= v_d2
           and (v_store is null or m.store_id = v_store)
           and tandem.user_store_ok(v_user.id, m.store_id)
      ), a as (
        select item_code,
          coalesce(sum(qty) filter (where move_date < v_d1), 0)                                          as start_qty,
          coalesce(sum(s)   filter (where move_date < v_d1), 0)                                          as start_sum,
          coalesce(sum(qty) filter (where move_date >= v_d1 and doc_type = 'invoice_in'), 0)             as income,
          coalesce(sum(s)   filter (where move_date >= v_d1 and doc_type = 'invoice_in'), 0)             as income_sum,
          coalesce(sum(qty) filter (where move_date >= v_d1 and doc_type = 'transfer' and qty > 0), 0)   as transfer_in,
          coalesce(-sum(qty) filter (where move_date >= v_d1 and doc_type = 'transfer' and qty < 0), 0)  as transfer_out,
          coalesce(sum(qty) filter (where move_date >= v_d1 and doc_type = 'production' and qty > 0), 0) as production_in,
          coalesce(-sum(qty) filter (where move_date >= v_d1 and doc_type = 'production' and qty < 0), 0) as production_out,
          coalesce(-sum(qty) filter (where move_date >= v_d1 and doc_type = 'sale'), 0)                  as sales,
          coalesce(-sum(s)   filter (where move_date >= v_d1 and doc_type = 'sale'), 0)                  as sales_sum,
          coalesce(-sum(qty) filter (where move_date >= v_d1 and doc_type = 'writeoff'), 0)              as writeoff,
          coalesce(-sum(s)   filter (where move_date >= v_d1 and doc_type = 'writeoff'), 0)              as writeoff_sum,
          coalesce(sum(qty) filter (where move_date >= v_d1 and doc_type = 'inventory'), 0)              as inventory,
          coalesce(sum(s)   filter (where move_date >= v_d1 and doc_type = 'inventory'), 0)              as inventory_sum,
          coalesce(sum(qty), 0) as end_qty,
          coalesce(sum(s), 0)   as end_sum,
          count(*) filter (where move_date >= v_d1) as moves
        from m group by item_code
      )
      select coalesce(jsonb_agg(jsonb_build_object(
          'item_code', a.item_code, 'name', i.name, 'unit_id', i.unit_id, 'group_name', g.name,
          'start_qty', round(a.start_qty, 4), 'start_sum', round(a.start_sum, 2),
          'income', round(a.income, 4), 'income_sum', round(a.income_sum, 2),
          'transfer_in', round(a.transfer_in, 4), 'transfer_out', round(a.transfer_out, 4),
          'production_in', round(a.production_in, 4), 'production_out', round(a.production_out, 4),
          'sales', round(a.sales, 4), 'sales_sum', round(a.sales_sum, 2),
          'writeoff', round(a.writeoff, 4), 'writeoff_sum', round(a.writeoff_sum, 2),
          'inventory', round(a.inventory, 4), 'inventory_sum', round(a.inventory_sum, 2),
          'end_qty', round(a.end_qty, 4), 'end_sum', round(a.end_sum, 2))
          order by g.name nulls last, i.name), '[]'::jsonb)
        from a join tandem.items i on i.code = a.item_code
        left join tandem.item_groups g on g.id = i.group_id
       where (a.moves > 0 or round(a.start_qty, 4) <> 0 or round(a.end_qty, 4) <> 0)
         and (v_q = '' or i.name ilike '%' || v_q || '%' or i.code = v_q)
         and (nullif(payload->>'group_id','') is null or i.group_id = (payload->>'group_id')::uuid)));
  end if;

  -- Продажи и себестоимость за период: по точкам и по позициям, только проведённые продажи.
  -- Выручка — строки проданного (кол-во × цена продажи из отчёта), себестоимость — строки
  -- расхода (списано по техкартам и как есть по средней склада). Фудкост = себестоимость / выручка.
  if action = 'doc_sales_report' then
    if not tandem.office_can(v_user.role, 'doc:sale', 'view') then
      return tandem.err('forbidden', 'Нет права смотреть продажи'); end if;
    v_d1 := coalesce(nullif(payload->>'date_from','')::date, date_trunc('month', current_date)::date);
    v_d2 := coalesce(nullif(payload->>'date_to','')::date, current_date);
    if v_d2 < v_d1 then return tandem.err('validation', 'Дата «по» раньше даты «с»'); end if;
    return (
      with d as (
        select doc.id, doc.store_from, r.point_id
          from tandem.documents doc
          join tandem.daily_reports r on doc.source_kind = 'daily_report' and doc.source_id = r.id::text
         where doc.doc_type = 'sale' and doc.status = 'posted'
           and doc.doc_date between v_d1 and v_d2
           and (nullif(payload->>'point_id','') is null or r.point_id = payload->>'point_id')
           and tandem.user_store_ok(v_user.id, doc.store_from)
      ), li as (
        select d.point_id, l.item_code, l.qty, coalesce(l.sum, 0) as revenue
          from d join tandem.document_lines l on l.document_id = d.id and l.line_kind = 'item'
      ), lc as (
        select d.point_id, l.note as item_code, coalesce(l.sum, 0) as cost
          from d join tandem.document_lines l on l.document_id = d.id and l.line_kind = 'consume'
      ), pt as (
        select p.id as point_id, p.name, p.sort_order,
               (select count(*) from d where d.point_id = p.id) as docs,
               coalesce((select sum(revenue) from li where li.point_id = p.id), 0) as revenue,
               coalesce((select sum(cost) from lc where lc.point_id = p.id), 0) as cost
          from tandem.points p where exists (select 1 from d where d.point_id = p.id)
      ), it as (
        select x.item_code, sum(x.qty) as qty, sum(x.revenue) as revenue, sum(x.cost) as cost from (
          select item_code, qty, revenue, 0::numeric as cost from li
          union all
          select item_code, 0, 0, cost from lc) x
         group by x.item_code
      )
      select jsonb_build_object('ok', true, 'date_from', v_d1, 'date_to', v_d2,
        'points', (select coalesce(jsonb_agg(jsonb_build_object('point_id', point_id, 'point_name', name, 'docs', docs,
                     'revenue', round(revenue, 2), 'cost', round(cost, 2), 'margin', round(revenue - cost, 2),
                     'foodcost_pct', case when revenue > 0 then round(cost / revenue * 100, 2) end)
                     order by sort_order), '[]'::jsonb) from pt),
        'items', (select coalesce(jsonb_agg(jsonb_build_object('item_code', it.item_code, 'name', i.name, 'unit_id', i.unit_id,
                     'qty', round(it.qty, 4), 'revenue', round(it.revenue, 2), 'cost', round(it.cost, 2),
                     'margin', round(it.revenue - it.cost, 2),
                     'foodcost_pct', case when it.revenue > 0 then round(it.cost / it.revenue * 100, 2) end)
                     order by it.revenue desc, i.name), '[]'::jsonb)
                    from it join tandem.items i on i.code = it.item_code)));
  end if;

  if action = 'stock_quality_report' then return tandem.quality_report(v_user); end if;

  -- Расход для 1С: сколько продуктов ушло на проданное за период, в позициях и единицах 1С —
  -- основа акта списания «на основании продаж». Берётся расход проведённых продаж и актов
  -- производства, кроме полуфабрикатов (их в 1С нет: 1С видит сырьё, из которого они сделаны).
  -- Сумма — по себестоимости движений нашего склада.
  if action = 'stock_1c_report' then
    if not tandem.office_can(v_user.role, 'doc:sale', 'view') then
      return tandem.err('forbidden', 'Нет права смотреть продажи'); end if;
    v_d1 := coalesce(nullif(payload->>'date_from','')::date, date_trunc('month', current_date)::date);
    v_d2 := coalesce(nullif(payload->>'date_to','')::date, current_date);
    if v_d2 < v_d1 then return tandem.err('validation', 'Дата «по» раньше даты «с»'); end if;
    return jsonb_build_object('ok', true, 'date_from', v_d1, 'date_to', v_d2, 'rows', (
      with u as (
        select m.item_code, -sum(m.qty) as qty, -sum(m.qty * m.unit_cost) as s
          from tandem.stock_moves m
          join tandem.documents d on d.id = m.document_id
          join tandem.items i on i.code = m.item_code
         where d.doc_type in ('sale', 'production') and d.status = 'posted' and m.qty < 0
           and i.item_type <> 'prepared'
           and m.move_date between v_d1 and v_d2
           and (v_store is null or m.store_id = v_store)
           and tandem.user_store_ok(v_user.id, m.store_id)
         group by m.item_code
      )
      select coalesce(jsonb_agg(jsonb_build_object(
          'item_code', u.item_code, 'name', i.name, 'unit_id', i.unit_id,
          'qty', round(u.qty, 4), 'sum', round(u.s, 2),
          'code_1c', i.code_1c, 'name_1c', c.name, 'unit_1c', c.unit, 'account_1c', c.account, 'k_1c', i.k_1c,
          'qty_1c', case when i.code_1c is not null and i.k_1c is not null then round(u.qty * i.k_1c, 3) end)
          order by c.name nulls last, i.name), '[]'::jsonb)
        from u join tandem.items i on i.code = u.item_code
        left join tandem.catalog_1c c on c.code = i.code_1c
       where round(u.qty, 4) <> 0));
  end if;

  -- Справочник позиций 1С — для выбора соответствия.
  if action = 'stock_1c_catalog_list' then
    return jsonb_build_object('ok', true, 'rows', (
      select coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name, 'unit', unit, 'account', account) order by name), '[]'::jsonb)
        from tandem.catalog_1c));
  end if;

  -- Загрузка справочника 1С (строки материальной ведомости) и, по желанию, соответствий по названию
  -- позиции учёта. Существующие соответствия не перезаписываются — их правят по одной.
  if action = 'stock_1c_catalog_save' then
    if not tandem.office_can(v_user.role, 'doc:sale', 'edit') then
      return tandem.err('forbidden', 'Нет права менять справочник 1С'); end if;
    insert into tandem.catalog_1c (code, name, unit, account)
      select btrim(x->>'code'), btrim(x->>'name'), nullif(btrim(x->>'unit'), ''), nullif(btrim(x->>'account'), '')
        from jsonb_array_elements(coalesce(payload->'rows', '[]'::jsonb)) x
       where nullif(btrim(x->>'code'), '') is not null and nullif(btrim(x->>'name'), '') is not null
      on conflict (code) do update set name = excluded.name, unit = excluded.unit, account = excluded.account;
    with l as (select lower(regexp_replace(btrim(x->>'name'), '[[:space:]]+', ' ', 'g')) as n, x->>'code' as code, (x->>'k')::numeric as k
                 from jsonb_array_elements(coalesce(payload->'links', '[]'::jsonb)) x
                where (x->>'k')::numeric > 0 and exists (select 1 from tandem.catalog_1c c where c.code = x->>'code'))
    update tandem.items i set code_1c = l.code, k_1c = l.k
      from l where lower(regexp_replace(btrim(i.name), '[[:space:]]+', ' ', 'g')) = l.n and i.active and i.code_1c is null;
    return jsonb_build_object('ok', true, 'catalog', (select count(*) from tandem.catalog_1c),
      'linked', (select count(*) from tandem.items where code_1c is not null));
  end if;

  -- Соответствие позиции учёта и позиции 1С: код 1С и сколько единиц 1С в одной нашей единице.
  -- Пустой код снимает соответствие.
  if action = 'stock_1c_link_save' then
    if not tandem.office_can(v_user.role, 'doc:sale', 'edit') then
      return tandem.err('forbidden', 'Нет права менять соответствия 1С'); end if;
    if not exists (select 1 from tandem.items where code = payload->>'item_code') then
      return tandem.err('not_found', 'Позиция не найдена'); end if;
    if nullif(payload->>'code_1c', '') is not null then
      if not exists (select 1 from tandem.catalog_1c where code = payload->>'code_1c') then
        return tandem.err('validation', 'Такой позиции в справочнике 1С нет'); end if;
      if coalesce(nullif(payload->>'k_1c', '')::numeric, 0) <= 0 then
        return tandem.err('validation', 'Коэффициент — число больше нуля: сколько единиц 1С в одной нашей'); end if;
    end if;
    update tandem.items set code_1c = nullif(payload->>'code_1c', ''),
           k_1c = case when nullif(payload->>'code_1c', '') is null then null else (payload->>'k_1c')::numeric end
     where code = payload->>'item_code';
    return jsonb_build_object('ok', true);
  end if;

  return tandem.err('unknown_action', 'Неизвестное действие: ' || action);
end $function$
;

CREATE OR REPLACE FUNCTION tandem.office_stock(action text, payload jsonb, v_user tandem.users)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'tandem', 'public'
AS $function$
declare
  v_id    uuid := nullif(payload->>'id','')::uuid;
  v_type  text;
  v_page  int  := greatest(coalesce((payload->>'page')::int, 1), 1);
  v_q     text := btrim(coalesce(payload->>'q',''));
  v_total int;
  v_rows  jsonb;
  v_num   text;
  v_store uuid := nullif(payload->>'store_id','')::uuid;
  v_code  text := nullif(payload->>'code','');
  v_doc   record;   -- строка документа; имя не d, иначе plpgsql перехватывает алиас d в подзапросах
  v_from  uuid; v_to uuid; v_ca uuid; v_date date; v_reason text;
  v_ext_num text; v_ext_date date;
  v_csv   text; v_sum numeric;
  v_d1    date; v_d2 date; v_res jsonb; v_cnt jsonb := '{}'::jsonb; v_rep record;
begin
  -- ---------- журнал ----------
  if action = 'docs_list' then
    -- count(*) over () считается до limit, поэтому общее число берётся из max(cnt),
    -- а сама служебная колонка убирается из строк (to_jsonb(x) - 'cnt').
    select coalesce(jsonb_agg(to_jsonb(x) - 'cnt'), '[]'::jsonb), coalesce(max(x.cnt), 0)
      into v_rows, v_total from (
      select d.id, d.number, d.doc_type, d.doc_date, d.status, d.store_from, sf.name as store_from_name,
             d.store_to, st.name as store_to_name, d.counteragent_id, c.name as counteragent_name,
             d.reason, d.comment, d.total_sum, d.ext_number, d.ext_date,
             u.name as created_by_name, d.posted_at,
             count(*) over () as cnt
      from tandem.documents d
      left join tandem.stores sf on sf.id = d.store_from
      left join tandem.stores st on st.id = d.store_to
      left join tandem.counteragents c on c.id = d.counteragent_id
      left join tandem.users u on u.id = d.created_by
      where (nullif(payload->>'doc_type','') is null or d.doc_type = payload->>'doc_type')
        and (v_store is null or d.store_from = v_store or d.store_to = v_store)
        and (nullif(payload->>'status','') is null or d.status = payload->>'status')
        and (nullif(payload->>'date_from','') is null or d.doc_date >= (payload->>'date_from')::date)
        and (nullif(payload->>'date_to','') is null or d.doc_date <= (payload->>'date_to')::date)
        and (v_q = '' or d.number ilike '%'||v_q||'%' or c.name ilike '%'||v_q||'%' or d.comment ilike '%'||v_q||'%')
        and tandem.user_doc_ok(v_user.id, d.store_from, d.store_to)
      order by d.doc_date desc, d.created_at desc limit 200 offset (v_page-1)*200) x;
    return jsonb_build_object('ok', true, 'rows', v_rows, 'total', v_total, 'page', v_page,
                              'pages', greatest(ceil(v_total/200.0)::int, 1));
  end if;

  -- ---------- карточка ----------
  if action = 'doc_get' then
    select * into v_doc from tandem.documents where id = v_id;
    if v_doc.id is null then return tandem.err('not_found', 'Документ не найден'); end if;
    if not tandem.user_doc_ok(v_user.id, v_doc.store_from, v_doc.store_to) then
      return tandem.err('forbidden', 'Документ чужого склада'); end if;
    -- ext_number/ext_date/source_* приходят в ответ сами: карточка отдаёт to_jsonb(документа).
    return jsonb_build_object('ok', true, 'doc', (
      select to_jsonb(dd) || jsonb_build_object(
        'store_from_name', (select name from tandem.stores where id = dd.store_from),
        'store_to_name', (select name from tandem.stores where id = dd.store_to),
        'counteragent_name', (select name from tandem.counteragents where id = dd.counteragent_id),
        'lines', (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'item_code', l.item_code, 'name', i.name,
                    'unit_id', coalesce(l.unit_id, i.unit_id), 'item_type', i.item_type, 'qty', l.qty, 'price', l.price, 'sum', l.sum,
                    'fact_qty', l.fact_qty, 'calc_qty', l.calc_qty, 'note', l.note, 'sort_order', l.sort_order,
                    'current_qty', (select qty from tandem.stock_balances b
                                    where b.store_id = coalesce(dd.store_from, dd.store_to) and b.item_code = l.item_code))
                    order by l.sort_order), '[]'::jsonb)
                  from tandem.document_lines l join tandem.items i on i.code = l.item_code
                  where l.document_id = dd.id and l.line_kind = 'item'),
        'consume', (select coalesce(jsonb_agg(jsonb_build_object('item_code', l.item_code, 'name', i.name, 'unit_id', l.unit_id,
                    'qty', l.qty, 'price', l.price, 'sum', l.sum, 'for_item', l.note) order by l.sort_order, i.name), '[]'::jsonb)
                  from tandem.document_lines l join tandem.items i on i.code = l.item_code
                  where l.document_id = dd.id and l.line_kind = 'consume'))
      from tandem.documents dd where dd.id = v_id));
  end if;

  -- ---------- сохранение черновика ----------
  if action = 'doc_save' then
    v_type := payload->>'doc_type';
    if v_type = 'sale' then
      return tandem.err('validation', 'Продажа создаётся отчётом точки, руками её не заводят'); end if;
    if v_type is null or v_type not in ('invoice_in','transfer','writeoff','production','inventory') then
      return tandem.err('validation', 'Неизвестный тип документа'); end if;
    if not tandem.office_can(v_user.role, 'doc:'||v_type, 'edit') then
      return tandem.err('forbidden', 'Нет права на документы этого типа'); end if;
    v_date   := coalesce(nullif(payload->>'doc_date','')::date, current_date);
    v_from   := nullif(payload->>'store_from','')::uuid;
    v_to     := nullif(payload->>'store_to','')::uuid;
    v_ca     := nullif(payload->>'counteragent_id','')::uuid;
    v_reason := nullif(payload->>'reason','');
    -- Накладная поставщика — только у прихода; у прочих типов поля молча обнуляются.
    v_ext_num  := case when v_type = 'invoice_in' then nullif(payload->>'ext_number','') end;
    v_ext_date := case when v_type = 'invoice_in' then nullif(payload->>'ext_date','')::date end;
    if v_type = 'invoice_in' and (v_to is null or v_ca is null) then
      return tandem.err('validation', 'Приходу нужны склад и поставщик'); end if;
    if v_type = 'transfer' and (v_from is null or v_to is null or v_from = v_to) then
      return tandem.err('validation', 'Перемещению нужны два разных склада'); end if;
    if v_type in ('writeoff','production','inventory') and v_from is null then
      return tandem.err('validation', 'Укажите склад'); end if;
    if v_type = 'writeoff' and v_reason is null then
      return tandem.err('validation', 'Укажите причину списания'); end if;
    if v_type = 'invoice_in' then v_from := null; end if;
    if v_type in ('writeoff','production','inventory') then v_to := null; end if;
    -- Кладовщик с привязкой к складам создаёт документы только от своего склада.
    if not tandem.user_store_ok(v_user.id, tandem.doc_own_store(v_type, v_from, v_to)) then
      return tandem.err('forbidden', 'Этот склад не закреплён за вами'); end if;
    if jsonb_typeof(payload->'lines') <> 'array' then
      return tandem.err('validation', 'Строки не переданы'); end if;
    if exists (select 1 from jsonb_array_elements(payload->'lines') x
               where not exists (select 1 from tandem.items where code = x->>'item_code')) then
      return tandem.err('validation', 'В строках есть неизвестная позиция'); end if;
    if v_id is null then
      v_num := tandem.next_doc_number(v_type, v_date);
      insert into tandem.documents (doc_type, number, doc_date, store_from, store_to, counteragent_id, reason,
                                    comment, ext_number, ext_date, created_by, updated_by)
        values (v_type, v_num, v_date, v_from, v_to, v_ca, v_reason,
                payload->>'comment', v_ext_num, v_ext_date, v_user.id, v_user.id)
        returning id into v_id;
    else
      -- C1: документ берётся под лок до проверки статуса — иначе параллельное проведение
      -- успевало пройти между чтением статуса и перезаписью строк, и проведённый документ
      -- оставался с чужими строками.
      select * into v_doc from tandem.documents where id = v_id for update;
      if v_doc.id is null then return tandem.err('not_found', 'Документ не найден'); end if;
      if v_doc.status <> 'draft' then
        return tandem.err('validation', 'Проведённый документ не правится — сначала отмените проведение'); end if;
      if v_doc.doc_type <> v_type then return tandem.err('validation', 'Тип документа менять нельзя'); end if;
      -- и чужой черновик не перетащить на свой склад: проверяется и старый склад документа.
      if not tandem.user_store_ok(v_user.id, tandem.doc_own_store(v_doc.doc_type, v_doc.store_from, v_doc.store_to)) then
        return tandem.err('forbidden', 'Документ чужого склада'); end if;
      v_num := v_doc.number;
      update tandem.documents set doc_date = v_date, store_from = v_from, store_to = v_to, counteragent_id = v_ca,
        reason = v_reason, comment = payload->>'comment', ext_number = v_ext_num, ext_date = v_ext_date,
        updated_by = v_user.id, updated_at = now() where id = v_id;
      delete from tandem.document_lines where document_id = v_id;
    end if;
    insert into tandem.document_lines (document_id, item_code, qty, unit_id, price, fact_qty, note, sort_order)
      select v_id, x->>'item_code',
             case when v_type = 'inventory' then coalesce(nullif(x->>'fact_qty','')::numeric, 0)
                  else coalesce(nullif(x->>'qty','')::numeric, 0) end,
             i.unit_id, nullif(x->>'price','')::numeric,
             case when v_type = 'inventory' then nullif(x->>'fact_qty','')::numeric end,
             nullif(x->>'note',''), (ord-1)::int
      from jsonb_array_elements(payload->'lines') with ordinality t(x, ord)
      join tandem.items i on i.code = x->>'item_code';
    return jsonb_build_object('ok', true, 'id', v_id, 'number', v_num);
  end if;

  -- ---------- предпросмотр / проведение / отмена / удаление ----------
  if action in ('doc_preview','doc_post','doc_unpost','doc_delete') then
    select * into v_doc from tandem.documents where id = v_id;
    if v_doc.id is not null and not tandem.user_store_ok(v_user.id,
         tandem.doc_own_store(v_doc.doc_type, v_doc.store_from, v_doc.store_to)) then
      return tandem.err('forbidden', 'Документ чужого склада'); end if;
    -- Продажа — зеркало отчёта точки: её не проводят, не отменяют и не удаляют руками,
    -- иначе склад разойдётся с отчётом. Пересчёт — действием doc_sales_sync.
    if v_doc.doc_type = 'sale' and action <> 'doc_preview' then
      return tandem.err('validation', 'Продажа ведётся отчётом точки — пересчитайте её во вкладке «Продажи»'); end if;
  end if;
  if action = 'doc_preview' then
    if not exists (select 1 from tandem.documents where id = v_id) then
      return tandem.err('not_found', 'Документ не найден'); end if;
    return jsonb_build_object('ok', true) || tandem.doc_preview(v_id);
  end if;
  if action = 'doc_post'   then return tandem.doc_post(v_id, v_user);   end if;
  if action = 'doc_unpost' then return tandem.doc_unpost(v_id, v_user); end if;
  if action = 'doc_delete' then
    -- C1: тот же лок, что и в doc_save, плюс status = 'draft' в самом delete —
    -- проведённый документ не может быть удалён даже при гонке с doc_post.
    select * into v_doc from tandem.documents where id = v_id for update;
    if v_doc.id is null then return tandem.err('not_found', 'Документ не найден'); end if;
    if v_doc.status <> 'draft' then return tandem.err('validation', 'Удалять можно только черновики'); end if;
    if not tandem.office_can(v_user.role, 'doc:'||v_doc.doc_type, 'edit') then
      return tandem.err('forbidden', 'Нет права на документы этого типа'); end if;
    delete from tandem.documents where id = v_id and status = 'draft';
    return jsonb_build_object('ok', true);
  end if;

  -- ---------- продажи: отчёты точек и их документы ----------
  if action = 'doc_sales_list' then
    if not tandem.office_can(v_user.role, 'doc:sale', 'view') then
      return tandem.err('forbidden', 'Нет права смотреть продажи'); end if;
    v_d1 := coalesce(nullif(payload->>'date_from','')::date, current_date - 7);
    v_d2 := coalesce(nullif(payload->>'date_to','')::date, current_date);
    return jsonb_build_object('ok', true, 'rows', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'report_id', r.id, 'report_date', r.report_date, 'point_id', p.id, 'point_name', p.name,
        'point_mode', p.mode, 'store_id', p.default_store_id, 'store_name', st.name,
        'money', r.cash + r.kaspi_qr + r.transfer + r.card,
        'lines', (select count(*) from tandem.sale_lines s where s.report_id = r.id)
               + (select count(*) from tandem.takeout_lines t where t.report_id = r.id),
        'doc_id', d.id, 'number', d.number, 'status', d.status, 'cost', d.total_sum, 'sync_note', d.sync_note,
        'sale_sum', (select sum(l.sum) from tandem.document_lines l where l.document_id = d.id and l.line_kind = 'item'),
        'state', case when d.id is not null and d.status = 'posted' and d.sync_note like 'Отчёт изменён%' then 'locked'
                      when d.id is not null and d.status = 'posted' and d.sync_note like 'Сбой%' then 'stale'
                      when d.id is not null and d.status = 'posted' then 'posted'
                      when d.id is not null then 'draft'
                      when p.default_store_id is null then 'no_store'
                      when exists (select 1 from tandem.sale_lines s where s.report_id = r.id and s.item_code is not null)
                        or exists (select 1 from tandem.takeout_lines t where t.report_id = r.id and t.item_code is not null)
                        then 'pending'
                      else 'none' end)
        order by r.report_date desc, p.sort_order), '[]'::jsonb)
      from tandem.daily_reports r
      join tandem.points p on p.id = r.point_id
      left join tandem.stores st on st.id = p.default_store_id
      left join tandem.documents d on d.source_kind = 'daily_report' and d.source_id = r.id::text
      where r.report_date between v_d1 and v_d2
        and (nullif(payload->>'point_id','') is null or r.point_id = payload->>'point_id')
        and (not exists (select 1 from tandem.user_stores us where us.user_id = v_user.id)
             or exists (select 1 from tandem.user_stores us where us.user_id = v_user.id
                          and us.store_id in (p.default_store_id, d.store_from)))));
  end if;

  if action = 'doc_sales_sync' then
    if not tandem.office_can(v_user.role, 'doc:sale', 'edit') then
      return tandem.err('forbidden', 'Пересчитывать продажи может администратор, собственник или бухгалтер'); end if;
    v_d1 := nullif(payload->>'date_from','')::date;
    v_d2 := nullif(payload->>'date_to','')::date;
    if v_d1 is null or v_d2 is null or v_d2 < v_d1 then
      return tandem.err('validation', 'Укажите период'); end if;
    if v_d2 - v_d1 > 31 then return tandem.err('validation', 'Период не длиннее месяца'); end if;
    -- Пакет — одна транзакция: чужой лок ждём не дольше 5 секунд, а сбой одного отчёта не
    -- валит остальные (своя подтранзакция на каждый отчёт, ревью п. 3).
    perform set_config('lock_timeout', '5s', true);
    for v_rep in select r.id from tandem.daily_reports r join tandem.points p on p.id = r.point_id
                 where r.report_date between v_d1 and v_d2
                   and (nullif(payload->>'point_id','') is null or r.point_id = payload->>'point_id')
                   and (not exists (select 1 from tandem.user_stores us where us.user_id = v_user.id)
                        or exists (select 1 from tandem.user_stores us where us.user_id = v_user.id
                                     and us.store_id = p.default_store_id))
                 order by r.report_date, r.id loop
      begin
        v_res := tandem.sale_sync(v_rep.id);
      exception when others then
        v_res := jsonb_build_object('status', 'error');
        update tandem.documents set sync_note = 'Сбой пересчёта: ' || sqlerrm
          where source_kind = 'daily_report' and source_id = v_rep.id::text;
      end;
      v_type := coalesce(v_res->>'status', 'error');
      v_cnt := v_cnt || jsonb_build_object(v_type, coalesce((v_cnt->>v_type)::int, 0) + 1);
    end loop;
    return jsonb_build_object('ok', true, 'counts', v_cnt);
  end if;

  -- ---------- остатки ----------
  if action = 'stock_balances' then
    select coalesce(jsonb_agg(to_jsonb(x) - 'cnt'), '[]'::jsonb), coalesce(max(x.cnt), 0)
      into v_rows, v_total from (
      select b.store_id, s.name as store_name, b.item_code, i.name, i.unit_id, b.qty, b.avg_cost,
             round(b.qty * b.avg_cost, 2) as sum, count(*) over () as cnt
      from tandem.stock_balances b
      join tandem.stores s on s.id = b.store_id
      join tandem.items i on i.code = b.item_code
      where (v_store is null or b.store_id = v_store) and tandem.user_store_ok(v_user.id, b.store_id)
        and (v_q = '' or i.name ilike '%'||v_q||'%' or i.code = v_q)
        and (coalesce((payload->>'only_nonzero')::boolean, true) = false or b.qty <> 0)
      order by s.name, i.name limit 200 offset (v_page-1)*200) x;
    -- Итог считается по всей отобранной выборке, а не по одной странице,
    -- иначе сумма под таблицей меняется при листании.
    select coalesce(sum(round(b.qty * b.avg_cost, 2)), 0) into v_sum
      from tandem.stock_balances b
      join tandem.stores s on s.id = b.store_id
      join tandem.items i on i.code = b.item_code
      where (v_store is null or b.store_id = v_store) and tandem.user_store_ok(v_user.id, b.store_id)
        and (v_q = '' or i.name ilike '%'||v_q||'%' or i.code = v_q)
        and (coalesce((payload->>'only_nonzero')::boolean, true) = false or b.qty <> 0);
    -- CSV — тяжёлая строка на весь список, строится только по явному запросу экспорта.
    if coalesce((payload->>'export')::boolean, false) then
      select 'store;code;name;unit;qty;avg_cost;sum' || E'\n' ||
             coalesce(string_agg(concat_ws(';', replace(s.name, ';', ','), b.item_code, replace(i.name, ';', ','), i.unit_id,
                                           b.qty, b.avg_cost, round(b.qty * b.avg_cost, 2)),
                                 E'\n' order by s.name, i.name), '')
        into v_csv
        from tandem.stock_balances b
        join tandem.stores s on s.id = b.store_id
        join tandem.items i on i.code = b.item_code
        where (v_store is null or b.store_id = v_store) and tandem.user_store_ok(v_user.id, b.store_id)
          and (v_q = '' or i.name ilike '%'||v_q||'%' or i.code = v_q)
          and (coalesce((payload->>'only_nonzero')::boolean, true) = false or b.qty <> 0);
    else
      v_csv := null;
    end if;
    return jsonb_build_object('ok', true, 'rows', v_rows, 'total', v_total, 'page', v_page,
      'pages', greatest(ceil(v_total/200.0)::int, 1), 'total_sum', v_sum, 'csv', v_csv);
  end if;

  if action = 'stock_moves' then
    select coalesce(jsonb_agg(to_jsonb(x) - 'cnt'), '[]'::jsonb), coalesce(max(x.cnt), 0)
      into v_rows, v_total from (
      select m.id, m.move_date, m.posted_at, s.name as store_name, m.store_id, m.item_code, i.name,
             m.qty, m.unit_cost, round(m.qty * m.unit_cost, 2) as sum,
             m.document_id, d.number, d.doc_type, count(*) over () as cnt
      from tandem.stock_moves m
      join tandem.documents d on d.id = m.document_id
      join tandem.stores s on s.id = m.store_id
      join tandem.items i on i.code = m.item_code
      where (v_store is null or m.store_id = v_store) and tandem.user_store_ok(v_user.id, m.store_id)
        and (nullif(payload->>'item_code','') is null or m.item_code = payload->>'item_code')
        and (nullif(payload->>'date_from','') is null or m.move_date >= (payload->>'date_from')::date)
        and (nullif(payload->>'date_to','') is null or m.move_date <= (payload->>'date_to')::date)
      order by m.posted_at desc, m.id desc limit 200 offset (v_page-1)*200) x;
    return jsonb_build_object('ok', true, 'rows', v_rows, 'total', v_total, 'page', v_page,
                              'pages', greatest(ceil(v_total/200.0)::int, 1));
  end if;

  if action = 'item_stock' then
    if not exists (select 1 from tandem.items where code = v_code) then
      return tandem.err('not_found', 'Позиция не найдена'); end if;
    return jsonb_build_object('ok', true,
      'balances', (select coalesce(jsonb_agg(jsonb_build_object('store_id', b.store_id, 'store_name', s.name,
                             'qty', b.qty, 'avg_cost', b.avg_cost) order by s.name), '[]'::jsonb)
                   from tandem.stock_balances b join tandem.stores s on s.id = b.store_id
                   where b.item_code = v_code and b.qty <> 0 and tandem.user_store_ok(v_user.id, b.store_id)),
      'moves', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
                  select m.move_date, s.name as store_name, m.qty, m.unit_cost, d.number, d.doc_type
                  from tandem.stock_moves m
                  join tandem.documents d on d.id = m.document_id
                  join tandem.stores s on s.id = m.store_id
                  where m.item_code = v_code and tandem.user_store_ok(v_user.id, m.store_id) order by m.posted_at desc, m.id desc limit 20) x));
  end if;

  if action = 'stock_rebuild' then
    if v_user.role <> 'admin' then return tandem.err('forbidden', 'Только администратор'); end if;
    return jsonb_build_object('ok', true, 'mismatches_before', tandem.rebuild_balances());
  end if;

  -- Новые действия склада (отчёты) живут в office_stock_ext: их добавление не требует
  -- пересоздавать эту большую функцию целиком.
  return tandem.office_stock_ext(action, payload, v_user);
end $function$
;

CREATE OR REPLACE FUNCTION tandem.office_stores(action text, payload jsonb, v_user tandem.users)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'tandem', 'public'
AS $function$
declare
  v_id uuid; v_name text; v_point text;
begin
  if action = 'stores_list' then
    return jsonb_build_object('ok', true,
      'stores', (select coalesce(jsonb_agg(jsonb_build_object(
          'id', s.id, 'name', s.name, 'point_id', s.point_id, 'point_name', p.name,
          'is_default', (p.default_store_id = s.id), 'active', s.active,
          'organization_id', s.organization_id) order by s.active desc, p.sort_order nulls last, s.name), '[]'::jsonb)
        from tandem.stores s left join tandem.points p on p.id = s.point_id),
      'points', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name) order by sort_order), '[]'::jsonb)
        from tandem.points where active));
  end if;

  if action = 'store_save' then
    v_name := btrim(coalesce(payload->>'name',''));
    if v_name = '' then return tandem.err('validation', 'Название склада пустое'); end if;
    v_point := nullif(payload->>'point_id','');
    if v_point is not null and not exists (select 1 from tandem.points where id = v_point) then
      return tandem.err('validation', 'Точка не найдена');
    end if;
    v_id := nullif(payload->>'id','')::uuid;
    if v_id is null then
      insert into tandem.stores (name, point_id, active)
        values (v_name, v_point, coalesce((payload->>'active')::boolean, true)) returning id into v_id;
    else
      update tandem.stores set name = v_name, point_id = v_point,
        active = coalesce((payload->>'active')::boolean, active) where id = v_id;
      if not found then return tandem.err('not_found', 'Склад не найден'); end if;
      -- отвязанный или выключенный склад не может быть складом по умолчанию
      update tandem.points set default_store_id = null
        where default_store_id = v_id and (v_point is null or id <> v_point or not coalesce((payload->>'active')::boolean, true));
    end if;
    if coalesce((payload->>'is_default')::boolean, false) and v_point is not null
       and exists (select 1 from tandem.stores where id = v_id and active) then
      update tandem.points set default_store_id = v_id where id = v_point;
    elsif payload ? 'is_default' and not (payload->>'is_default')::boolean then
      update tandem.points set default_store_id = null where default_store_id = v_id;
    end if;
    return jsonb_build_object('ok', true, 'id', v_id);
  end if;

  -- Точки продаж: режим экрана точки, код входа, юрлицо, группы меню. Служебные точки теста (zz_*)
  -- не показываются и не правятся. Код точки не отдаётся — только признак «задан»; новый код задаётся явно.
  if action = 'store_points_list' then
    return jsonb_build_object('ok', true,
      'points', (select coalesce(jsonb_agg(jsonb_build_object(
          'id', p.id, 'name', p.name, 'mode', p.mode, 'legal_entity', p.legal_entity, 'active', p.active,
          'sort_order', p.sort_order, 'item_categories', coalesce(to_jsonb(p.item_categories), '[]'::jsonb),
          'store_name', s.name, 'has_pin', coalesce(p.pin, '') <> '') order by p.sort_order, p.name), '[]'::jsonb)
        from tandem.points p left join tandem.stores s on s.id = p.default_store_id
       where p.id not like 'zz\_%'),
      'categories', (select coalesce(jsonb_agg(c order by c), '[]'::jsonb)
        from (select distinct category c from tandem.items where active and for_sale and category is not null) x),
      'legal_entities', (select coalesce(jsonb_agg(distinct legal_entity), '[]'::jsonb) from tandem.points where legal_entity is not null));
  end if;

  if action = 'store_point_save' then
    v_point := btrim(coalesce(payload->>'id', ''));
    v_name := btrim(coalesce(payload->>'name', ''));
    if v_point = '' or v_point like 'zz\_%' then return tandem.err('validation', 'Не указана точка'); end if;
    if v_name = '' then return tandem.err('validation', 'Название точки обязательно'); end if;
    if coalesce(payload->>'mode', '') not in ('position', 'takeout', 'import', 'manual', 'checks') then
      return tandem.err('validation', 'Неизвестный режим точки'); end if;
    if nullif(payload->>'pin', '') is not null then
      if payload->>'pin' !~ '^[0-9]{4,8}$' then
        return tandem.err('validation', 'Код точки — от 4 до 8 цифр'); end if;
      -- Вход на экран точки сначала сверяет код собственника и водителя: совпадение с ними открыло бы
      -- чужую роль. Совпадение с кодом другой точки путает людей.
      if payload->>'pin' in (select value from tandem.settings where key in ('owner_pin', 'driver_pin'))
         or exists (select 1 from tandem.points where pin = payload->>'pin' and id <> v_point) then
        return tandem.err('validation', 'Этот код уже занят — придумайте другой'); end if;
    end if;
    if not exists (select 1 from tandem.points where id = v_point) then
      if v_point !~ '^[a-z][a-z0-9_]{1,30}$' then
        return tandem.err('validation', 'Код новой точки — латиница, цифры и подчёркивание, например eneshka2'); end if;
      if nullif(payload->>'pin', '') is null then return tandem.err('validation', 'Для новой точки задайте код входа'); end if;
      insert into tandem.points (id, name, mode, pin, legal_entity, active, sort_order)
        values (v_point, v_name, payload->>'mode', payload->>'pin', nullif(btrim(coalesce(payload->>'legal_entity', '')), ''),
                coalesce((payload->>'active')::boolean, true), coalesce((select max(sort_order) from tandem.points where id not like 'zz\_%'), 0) + 10);
    end if;
    update tandem.points set name = v_name, mode = payload->>'mode',
           legal_entity = nullif(btrim(coalesce(payload->>'legal_entity', '')), ''),
           active = coalesce((payload->>'active')::boolean, active),
           item_categories = case when jsonb_typeof(payload->'item_categories') = 'array'
                                  then array(select jsonb_array_elements_text(payload->'item_categories')) else item_categories end,
           pin = coalesce(nullif(payload->>'pin', ''), pin)
     where id = v_point;
    return jsonb_build_object('ok', true, 'id', v_point);
  end if;

  return tandem.err('unknown_action', 'Неизвестное действие: ' || action);
end $function$
;

CREATE OR REPLACE FUNCTION tandem.office_user_json(u tandem.users)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
  select jsonb_build_object('id', u.id, 'login', u.login, 'name', u.name, 'role', u.role,
    'store_ids', tandem.user_store_ids(u.id))
$function$
;

CREATE OR REPLACE FUNCTION tandem.office_users(action text, payload jsonb, v_user tandem.users)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'tandem', 'public', 'extensions'
AS $function$
declare
  v_id uuid; v_login text; v_name text; v_role text; v_pin text;
begin
  if action = 'users_list' then
    return jsonb_build_object('ok', true,
      'users', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'login', login, 'name', name, 'role', role,
                  'active', active, 'must_change_pin', must_change_pin, 'created_at', created_at,
                  'store_ids', tandem.user_store_ids(id))
                  order by active desc, name), '[]'::jsonb) from tandem.users),
      'roles', jsonb_build_array('admin','owner','accountant','technologist','storekeeper'));
  end if;

  if action = 'user_save' then
    v_login := lower(btrim(coalesce(payload->>'login','')));
    v_name  := btrim(coalesce(payload->>'name',''));
    v_role  := coalesce(payload->>'role','');
    v_pin   := nullif(payload->>'pin','');
    if v_login !~ '^[a-z0-9_.-]{2,32}$' then return tandem.err('validation', 'Логин: 2–32 латинских буквы, цифры, _ . -'); end if;
    if v_name = '' then return tandem.err('validation', 'Имя пустое'); end if;
    if v_role not in ('admin','owner','accountant','technologist','storekeeper') then
      return tandem.err('validation', 'Роль не из списка');
    end if;
    v_id := nullif(payload->>'id','')::uuid;
    if exists (select 1 from tandem.users where login = v_login and (v_id is null or id <> v_id)) then
      return tandem.err('validation', 'Такой логин уже есть');
    end if;
    if v_id is null then
      if v_pin is null or length(v_pin) < 4 or v_pin !~ '^[0-9]+$' then
        return tandem.err('validation', 'PIN — не меньше 4 цифр');
      end if;
      insert into tandem.users (login, name, role, pin_hash, must_change_pin, active)
        values (v_login, v_name, v_role, crypt(v_pin, gen_salt('bf')), true,
                coalesce((payload->>'active')::boolean, true)) returning id into v_id;
    else
      if v_id = v_user.id and coalesce((payload->>'active')::boolean, true) = false then
        return tandem.err('validation', 'Нельзя выключить самого себя');
      end if;
      if exists (select 1 from tandem.users where id = v_id and role = 'admin' and active)
        and (v_role <> 'admin' or coalesce((payload->>'active')::boolean, true) = false)
        and not exists (select 1 from tandem.users where role = 'admin' and active and id <> v_id)
      then
        return tandem.err('validation', 'Нельзя оставить систему без администратора');
      end if;
      update tandem.users set login = v_login, name = v_name, role = v_role,
        active = coalesce((payload->>'active')::boolean, active) where id = v_id;
      if not found then return tandem.err('not_found', 'Пользователь не найден'); end if;
      if not coalesce((payload->>'active')::boolean, true) then
        delete from tandem.sessions where user_id = v_id;
      end if;
    end if;
    -- Склады пользователя меняются, только если ключ пришёл: пустой массив снимает привязку.
    if payload ? 'store_ids' then
      if jsonb_typeof(payload->'store_ids') <> 'array' then
        return tandem.err('validation', 'Склады — списком'); end if;
      delete from tandem.user_stores where user_id = v_id;
      insert into tandem.user_stores (user_id, store_id)
        select v_id, x::uuid from jsonb_array_elements_text(payload->'store_ids') x
        on conflict do nothing;
    end if;
    return jsonb_build_object('ok', true, 'id', v_id);
  end if;

  if action = 'user_reset_pin' then
    v_id := nullif(payload->>'id','')::uuid;
    v_pin := coalesce(payload->>'pin','');
    if length(v_pin) < 4 or v_pin !~ '^[0-9]+$' then return tandem.err('validation', 'PIN — не меньше 4 цифр'); end if;
    update tandem.users set pin_hash = crypt(v_pin, gen_salt('bf')), must_change_pin = true,
      failed_attempts = 0, locked_until = null where id = v_id;
    if not found then return tandem.err('not_found', 'Пользователь не найден'); end if;
    delete from tandem.sessions where user_id = v_id;
    return jsonb_build_object('ok', true);
  end if;

  return tandem.err('unknown_action', 'Неизвестное действие: ' || action);
end $function$
;

CREATE OR REPLACE FUNCTION tandem.quality_report(p_user tandem.users)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'tandem', 'public'
AS $function$
declare
  v_checks jsonb := '[]'::jsonb;
  v_rows   jsonb;
  v_count  int;
begin
  -- 1. Сырьё без учётной цены, стоящее в действующих картах: от него зависит себестоимость блюд.
  with ing as (
    select cl.ingredient_code as code, count(distinct c.item_code) as dishes
      from tandem.chart_lines cl
      join tandem.charts c on c.id = cl.chart_id and (c.date_to is null or c.date_to >= current_date) and c.date_from <= current_date
      join tandem.items d on d.code = c.item_code and d.active
     group by cl.ingredient_code
  ), bad as (
    -- Полуфабрикат-ингредиент без своей карты («Вода ПФ») так же обрывает расчёт: его учётную
    -- цену расчёт не читает, поэтому лечится картой либо сменой типа на «товар» с ценой.
    select i.code, i.name, ing.dishes,
           case when i.item_type = 'goods' then '' else ' — полуфабрикат без техкарты: заведите карту или смените тип на «товар» и задайте цену' end as how
      from ing join tandem.items i on i.code = ing.code
     where (i.item_type = 'goods' and i.cost_price is null)
        or (i.item_type in ('dish','prepared') and tandem.active_chart(i.code, current_date) is null)
  )
  select count(*), coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name,
           'detail', 'стоит в ' || dishes || ' карт.' || how) order by dishes desc, name) filter (where rn <= 300), '[]'::jsonb)
    into v_count, v_rows from (select *, row_number() over (order by dishes desc, name) rn from bad) x;
  v_checks := v_checks || jsonb_build_object('id', 'raw_no_cost', 'severity', 'bad', 'target', 'item', 'count', v_count, 'rows', v_rows,
    'title', 'Сырьё без цены, из-за которого не считается себестоимость',
    'hint', 'Пока цены нет, себестоимость блюд с этим сырьём не считается. Цена появится сама после первого прихода, либо задайте её в карточке.');

  -- 2. Блюда на продаже без действующей техкарты: при продаже спишутся «как есть», а не сырьём.
  select count(*), coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name, 'detail', category) order by name) filter (where rn <= 300), '[]'::jsonb)
    into v_count, v_rows from (
      select i.code, i.name, coalesce(g.name, '') as category, row_number() over (order by i.name) rn
        from tandem.items i left join tandem.item_groups g on g.id = i.group_id
       where i.active and i.for_sale and i.item_type in ('dish','prepared')
         and tandem.active_chart(i.code, current_date) is null) x;
  v_checks := v_checks || jsonb_build_object('id', 'dish_no_chart', 'severity', 'bad', 'target', 'chart', 'count', v_count, 'rows', v_rows,
    'title', 'Блюда на продаже без техкарты',
    'hint', 'Продажа такого блюда спишет со склада само блюдо, а не продукты. Заведите техкарту или снимите блюдо с продажи.');

  -- 3. Позиции на продаже без цены — ни общей, ни по точкам.
  select count(*), coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name, 'detail', category) order by name) filter (where rn <= 300), '[]'::jsonb)
    into v_count, v_rows from (
      select i.code, i.name, coalesce(g.name, '') as category, row_number() over (order by i.name) rn
        from tandem.items i left join tandem.item_groups g on g.id = i.group_id
       where i.active and i.for_sale and i.price is null
         and not exists (select 1 from tandem.item_prices p where p.item_code = i.code)) x;
  v_checks := v_checks || jsonb_build_object('id', 'sale_no_price', 'severity', 'warn', 'target', 'item', 'count', v_count, 'rows', v_rows,
    'title', 'На продаже без цены',
    'hint', 'Точка увидит позицию без цены, выручка по ней посчитается нулём. Задайте цену в карточке или снимите с продажи.');

  -- 4. Одинаковые названия у действующих позиций: путаница при приёмке и загрузке остатков по названию.
  select count(*), coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name, 'detail', 'код ' || code || ', ' || kind) order by name, code) filter (where rn <= 300), '[]'::jsonb)
    into v_count, v_rows from (
      select i.code, i.name, i.item_type as kind, row_number() over (order by i.name, i.code) rn
        from tandem.items i
       where i.active and lower(btrim(i.name)) in (select lower(btrim(name)) from tandem.items where active group by 1 having count(*) > 1)) x;
  v_checks := v_checks || jsonb_build_object('id', 'dup_names', 'severity', 'warn', 'target', 'item', 'count', v_count, 'rows', v_rows,
    'title', 'Одинаковые названия',
    'hint', 'Две действующие позиции с одним названием. Лишнюю выключите или переименуйте — иначе загрузка остатков по названию их пропустит.');

  -- 5. Позиции без группы.
  select count(*), coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name, 'detail', kind) order by name) filter (where rn <= 300), '[]'::jsonb)
    into v_count, v_rows from (
      select i.code, i.name, i.item_type as kind, row_number() over (order by i.name) rn
        from tandem.items i where i.active and i.group_id is null) x;
  v_checks := v_checks || jsonb_build_object('id', 'no_group', 'severity', 'warn', 'target', 'item', 'count', v_count, 'rows', v_rows,
    'title', 'Позиции без группы', 'hint', 'Их не видно в дереве групп и в отчётах по группам.');

  -- 6. Точки без склада: продажи этих точек склад не списывают.
  select count(*), coalesce(jsonb_agg(jsonb_build_object('code', id, 'name', name, 'detail', 'продажи не списывают склад') order by sort_order), '[]'::jsonb)
    into v_count, v_rows from tandem.points p
   where p.active and (p.default_store_id is null
      or not exists (select 1 from tandem.stores s where s.id = p.default_store_id and s.active));
  v_checks := v_checks || jsonb_build_object('id', 'point_no_store', 'severity', 'bad', 'target', 'store', 'count', v_count, 'rows', v_rows,
    'title', 'Точки без склада',
    'hint', 'В разделе «Склады» откройте склад точки, выберите точку и отметьте «склад точки по умолчанию».');

  -- 7. Продажи, которые не проведены или устарели, за последние 45 дней.
  select count(*), coalesce(jsonb_agg(jsonb_build_object('code', number, 'name', point_name || ' · ' || doc_date, 'detail', coalesce(sync_note, 'не проведена')) order by doc_date desc) filter (where rn <= 300), '[]'::jsonb)
    into v_count, v_rows from (
      select d.number, d.doc_date, d.sync_note, p.name as point_name, row_number() over (order by d.doc_date desc) rn
        from tandem.documents d
        join tandem.daily_reports r on d.source_kind = 'daily_report' and d.source_id = r.id::text
        join tandem.points p on p.id = r.point_id
       where d.doc_type = 'sale' and d.doc_date >= current_date - 45
         and (d.status <> 'posted' or d.sync_note like 'Сбой%' or d.sync_note like 'Отчёт изменён%')
         and tandem.user_store_ok(p_user.id, d.store_from)) x;
  v_checks := v_checks || jsonb_build_object('id', 'sales_not_posted', 'severity', 'bad', 'target', 'sale', 'count', v_count, 'rows', v_rows,
    'title', 'Продажи не проведены', 'hint', 'Откройте вкладку «Продажи» и нажмите «Провести продажи за период». Если мешает инвентаризация — причина написана в строке.');

  -- 8. Отрицательные остатки.
  select count(*), coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name, 'detail', store_name || ': ' || qty) order by store_name, name) filter (where rn <= 300), '[]'::jsonb)
    into v_count, v_rows from (
      select b.item_code as code, i.name, s.name as store_name, round(b.qty, 3) as qty, row_number() over (order by s.name, i.name) rn
        from tandem.stock_balances b join tandem.items i on i.code = b.item_code join tandem.stores s on s.id = b.store_id
       where b.qty < 0 and tandem.user_store_ok(p_user.id, b.store_id)) x;
  v_checks := v_checks || jsonb_build_object('id', 'negative_stock', 'severity', 'warn', 'target', 'item', 'count', v_count, 'rows', v_rows,
    'title', 'Остаток в минусе',
    'hint', 'Продано или списано больше, чем числилось: не внесён приход, не проведено производство или нет стартовой инвентаризации.');

  -- 9. Пользователи: временный PIN и кладовщики без закреплённых складов. Видит только администратор.
  if p_user.role = 'admin' then
    select count(*), coalesce(jsonb_agg(jsonb_build_object('code', login, 'name', name, 'detail', what) order by name), '[]'::jsonb)
      into v_count, v_rows from (
        select u.login, u.name, 'временный PIN — ещё ни разу не входил' as what from tandem.users u where u.active and u.must_change_pin
        union all
        select u.login, u.name, 'кладовщик без закреплённых складов — видит все склады' from tandem.users u
         where u.active and u.role = 'storekeeper' and not exists (select 1 from tandem.user_stores us where us.user_id = u.id)) x;
    v_checks := v_checks || jsonb_build_object('id', 'users', 'severity', 'warn', 'target', 'user', 'count', v_count, 'rows', v_rows,
      'title', 'Пользователи', 'hint', 'Раздел «Пользователи»: закрепите склады за кладовщиками, напомните про первый вход.');
  end if;

  return jsonb_build_object('ok', true, 'checks', v_checks,
    'bad', (select count(*) from jsonb_array_elements(v_checks) c where c->>'severity' = 'bad' and (c->>'count')::int > 0),
    'warn', (select count(*) from jsonb_array_elements(v_checks) c where c->>'severity' = 'warn' and (c->>'count')::int > 0));
end $function$
;

CREATE OR REPLACE FUNCTION tandem.rebuild_balance(p_store uuid, p_item text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
declare r record; v_qty numeric := 0; v_avg numeric := 0;
begin
  -- I3: пара захватывается первым же оператором, до чтения движений. on conflict do update
  -- блокирует строку всегда (do nothing — не блокирует), поэтому параллельная отмена
  -- проведения не может пересобрать ту же пару по половине движений.
  insert into tandem.stock_balances (store_id, item_code) values (p_store, p_item)
    on conflict (store_id, item_code) do update set updated_at = now();
  -- Порядок — по id: posted_at внутри одной транзакции одинаков у всех её движений
  -- (now() не меняется), и сортировка по нему неустойчива — средняя зависела бы от плана.
  for r in select qty, unit_cost from tandem.stock_moves where store_id = p_store and item_code = p_item
           order by id loop
    if r.qty > 0 then
      if v_qty <= 0 then v_avg := r.unit_cost;
      else v_avg := round((v_qty * v_avg + r.qty * r.unit_cost) / (v_qty + r.qty), 4); end if;
    end if;
    v_qty := v_qty + r.qty;
  end loop;
  insert into tandem.stock_balances (store_id, item_code, qty, avg_cost, updated_at)
    values (p_store, p_item, v_qty, v_avg, now())
    on conflict (store_id, item_code) do update set qty = excluded.qty, avg_cost = excluded.avg_cost, updated_at = now();
end $function$
;

CREATE OR REPLACE FUNCTION tandem.rebuild_balances()
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
declare r record; v_bad int := 0; v_qty numeric; v_avg numeric;
begin
  for r in select store_id, item_code from tandem.stock_balances
           union select store_id, item_code from tandem.stock_moves loop
    select qty, avg_cost into v_qty, v_avg from tandem.stock_balances where store_id = r.store_id and item_code = r.item_code;
    perform tandem.rebuild_balance(r.store_id, r.item_code);
    if v_qty is distinct from (select qty from tandem.stock_balances where store_id = r.store_id and item_code = r.item_code)
       or v_avg is distinct from (select avg_cost from tandem.stock_balances where store_id = r.store_id and item_code = r.item_code) then
      v_bad := v_bad + 1;
    end if;
  end loop;
  return v_bad;
end $function$
;

CREATE OR REPLACE FUNCTION tandem.sale_sync(p_report bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'tandem', 'public'
AS $function$
declare
  r       record;
  v_doc   record;
  v_store uuid;
  v_lines jsonb;
  v_sys   tandem.users;   -- системный проводящий: права администратора, автор не указан
  v_res   jsonb;
  v_id    uuid;
  v_num   text;
  v_note  text;
  v_skip  text;
  v_inv   text;
  v_same  boolean;
begin
  v_sys.role := 'admin';
  -- Лок отчёта: сохранение отчёта точкой и пересчёт из бэк-офиса идут по очереди. Без него
  -- оба создавали бы первый документ, и второй падал на уникальном индексе источника.
  perform 1 from tandem.daily_reports where id = p_report for update;
  select dr.id, dr.report_date, dr.point_id, p.name as point_name, p.default_store_id
    into r from tandem.daily_reports dr join tandem.points p on p.id = dr.point_id where dr.id = p_report;
  if r.id is null then return tandem.err('not_found', 'Отчёт не найден'); end if;
  select * into v_doc from tandem.documents
    where source_kind = 'daily_report' and source_id = p_report::text for update;

  v_store := r.default_store_id;
  if v_store is not null and not exists (select 1 from tandem.stores where id = v_store and active) then
    v_store := null;
  end if;

  -- Проданное по позиции: продажи + вынос (выдано − возвращено). Без кода, выключенные,
  -- услуги и позиции с итогом ≤ 0 (возврат перекрыл продажу) в склад не идут.
  with u as (
    select s.item_code, s.qty as q, s.qty * coalesce(s.price, 0) as amt
      from tandem.sale_lines s where s.report_id = p_report and s.item_code is not null
    union all
    select t.item_code, t.issued - t.returned, (t.issued - t.returned) * coalesce(t.price, 0)
      from tandem.takeout_lines t where t.report_id = p_report and t.item_code is not null
  ), g as (
    select u.item_code, sum(u.q) as q, sum(u.amt) as amt
      from u join tandem.items i on i.code = u.item_code
     where i.active and i.item_type <> 'service'
     group by u.item_code having sum(u.q) > 0
  )
  select coalesce(jsonb_agg(jsonb_build_object('item_code', item_code, 'qty', q,
           'price', round(amt / q, 2)) order by item_code), '[]'::jsonb)
    into v_lines from g;
  -- Выключенные позиции в отчёте — в пометку: иначе склад разойдётся с отчётом без объяснения.
  select string_agg(distinct i.name, ', ') into v_skip
    from (select item_code from tandem.sale_lines where report_id = p_report and item_code is not null
          union all
          select item_code from tandem.takeout_lines where report_id = p_report and item_code is not null) u
    join tandem.items i on i.code = u.item_code where not i.active;

  if v_store is null then
    if v_doc.id is not null then
      update tandem.documents set sync_note = 'У точки нет действующего склада — продажа не пересчитана'
        where id = v_doc.id;
    end if;
    return jsonb_build_object('ok', true, 'status', 'no_store');
  end if;

  if v_doc.id is not null and v_doc.status = 'posted' then
    v_same := v_doc.store_from = v_store and v_doc.doc_date = r.report_date
       and not exists (
         select x.item_code, (x.qty)::numeric, (x.price)::numeric
           from jsonb_to_recordset(v_lines) x(item_code text, qty numeric, price numeric)
         except
         select l.item_code, l.qty, l.price from tandem.document_lines l
          where l.document_id = v_doc.id and l.line_kind = 'item')
       and not exists (
         select l.item_code, l.qty, l.price from tandem.document_lines l
          where l.document_id = v_doc.id and l.line_kind = 'item'
         except
         select x.item_code, (x.qty)::numeric, (x.price)::numeric
           from jsonb_to_recordset(v_lines) x(item_code text, qty numeric, price numeric));
    -- Строки те же и пометки нет (или она про «изменён после инвентаризации», а отчёт
    -- вернули к проведённому) — документ верен. Иная пометка («без техкарты», «сбой») —
    -- повод провести заново: например, технолог добавил карту.
    if v_same and (v_doc.sync_note is null or v_doc.sync_note like 'Отчёт изменён%') then
      if v_doc.sync_note is not null then
        update tandem.documents set sync_note = null where id = v_doc.id;
      end if;
      return jsonb_build_object('ok', true, 'status', 'unchanged', 'doc_id', v_doc.id, 'number', v_doc.number);
    end if;
    v_res := tandem.doc_unpost(v_doc.id, v_sys);
    if not coalesce((v_res->>'ok')::boolean, false) then
      update tandem.documents set sync_note = 'Отчёт изменён после проведения, продажа не пересчитана: '
             || coalesce(v_res->>'message', 'отмена проведения не удалась')
        where id = v_doc.id;
      return jsonb_build_object('ok', true, 'status', 'locked', 'doc_id', v_doc.id, 'number', v_doc.number,
                                'message', v_res->>'message');
    end if;
  end if;

  if jsonb_array_length(v_lines) = 0 then
    if v_doc.id is not null then delete from tandem.documents where id = v_doc.id; end if;
    return jsonb_build_object('ok', true, 'status', 'empty');
  end if;

  if v_doc.id is null then
    v_num := tandem.next_doc_number('sale', r.report_date);
    insert into tandem.documents (doc_type, number, doc_date, store_from, comment, source_kind, source_id)
      values ('sale', v_num, r.report_date, v_store, 'Отчёт точки «' || r.point_name || '»',
              'daily_report', p_report::text)
      returning id into v_id;
  else
    v_id := v_doc.id; v_num := v_doc.number;
    update tandem.documents set store_from = v_store, doc_date = r.report_date, updated_at = now()
      where id = v_id;
    delete from tandem.document_lines where document_id = v_id;
  end if;
  insert into tandem.document_lines (document_id, item_code, qty, unit_id, price, sort_order)
    select v_id, x->>'item_code', (x->>'qty')::numeric, i.unit_id, (x->>'price')::numeric, (ord - 1)::int
      from jsonb_array_elements(v_lines) with ordinality t(x, ord)
      join tandem.items i on i.code = x->>'item_code';

  -- Инвентаризация этого склада более поздним днём уже учла проданное в своей недостаче:
  -- провести продажу сейчас — списать то же самое второй раз. Документ остаётся черновиком
  -- с пометкой. Инвентаризация в тот же день считается утренней (до продаж) и не мешает.
  select inv.number into v_inv from tandem.documents inv
   where inv.doc_type = 'inventory' and inv.status = 'posted' and inv.store_from = v_store
     and inv.doc_date > r.report_date
   order by inv.doc_date, inv.number limit 1;
  if v_inv is not null then
    update tandem.documents set sync_note = 'Не проведено: после даты отчёта на складе проведена инвентаризация '
           || v_inv || ' — проданное уже учтено в её недостаче'
      where id = v_id;
    return jsonb_build_object('ok', true, 'status', 'locked', 'doc_id', v_id, 'number', v_num,
                              'message', 'инвентаризация ' || v_inv);
  end if;

  v_res := tandem.doc_post(v_id, v_sys);
  if not coalesce((v_res->>'ok')::boolean, false) then
    update tandem.documents set sync_note = 'Не проведено: ' || coalesce(v_res->>'message', '?') where id = v_id;
    return jsonb_build_object('ok', true, 'status', 'error', 'doc_id', v_id, 'number', v_num,
                              'message', v_res->>'message');
  end if;

  -- Блюда без действующей карты списаны как есть — это стоит видеть технологу.
  select string_agg(i.name, ', ' order by i.name) into v_note
    from tandem.document_lines l join tandem.items i on i.code = l.item_code
   where l.document_id = v_id and l.line_kind = 'item' and i.item_type in ('dish','prepared')
     and tandem.active_chart(l.item_code, r.report_date) is null;
  update tandem.documents set sync_note = nullif(concat_ws('. ',
           case when v_note is not null then 'Без техкарты списаны как есть: ' || v_note end,
           case when v_skip is not null then 'Выключенные позиции не списаны: ' || v_skip end), '')
    where id = v_id;
  return jsonb_build_object('ok', true, 'status', 'posted', 'doc_id', v_id, 'number', v_num,
                            'warnings', v_res->'warnings');
end $function$
;

CREATE OR REPLACE FUNCTION tandem.store_avg(p_store uuid, p_item text)
 RETURNS numeric
 LANGUAGE sql
 STABLE
AS $function$
  select coalesce((select nullif(avg_cost, 0) from tandem.stock_balances where store_id = p_store and item_code = p_item),
                  (select cost_price from tandem.items where code = p_item), 0)
$function$
;

CREATE OR REPLACE FUNCTION tandem.user_doc_ok(p_user uuid, p_from uuid, p_to uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'tandem', 'public'
AS $function$
  select not exists (select 1 from tandem.user_stores where user_id = p_user)
      or exists (select 1 from tandem.user_stores where user_id = p_user and store_id in (p_from, p_to))
$function$
;

CREATE OR REPLACE FUNCTION tandem.user_store_ids(p_user uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'tandem', 'public'
AS $function$
  select coalesce(jsonb_agg(store_id order by store_id), '[]'::jsonb)
  from tandem.user_stores where user_id = p_user
$function$
;

CREATE OR REPLACE FUNCTION tandem.user_store_ok(p_user uuid, p_store uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'tandem', 'public'
AS $function$
  select p_store is null
      or not exists (select 1 from tandem.user_stores where user_id = p_user)
      or exists (select 1 from tandem.user_stores where user_id = p_user and store_id = p_store)
$function$
;

CREATE OR REPLACE FUNCTION tandem.users_pin_sessions()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if new.pin_hash is distinct from old.pin_hash then
    delete from tandem.sessions
     where user_id = new.id and token <> coalesce(current_setting('tandem.token', true), '');
  end if;
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION tandem.users_role_sessions()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if new.role is distinct from old.role then
    delete from tandem.sessions where user_id = new.id;
  end if;
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION tandem.check_rollup(p_point text, p_date date)
 RETURNS bigint
 LANGUAGE plpgsql
 SET search_path TO 'tandem', 'public'
AS $function$
declare
  v_id bigint;
begin
  insert into tandem.daily_reports (point_id, report_date) values (p_point, p_date)
    on conflict (point_id, report_date) do nothing;
  select id into v_id from tandem.daily_reports where point_id = p_point and report_date = p_date for update;
  update tandem.daily_reports d set
      cash     = coalesce((select sum(total) from tandem.checks where point_id = p_point and check_date = p_date and status = 'active' and pay_kind = 'cash'), 0),
      kaspi_qr = coalesce((select sum(total) from tandem.checks where point_id = p_point and check_date = p_date and status = 'active' and pay_kind = 'kaspi_qr'), 0),
      transfer = coalesce((select sum(total) from tandem.checks where point_id = p_point and check_date = p_date and status = 'active' and pay_kind = 'transfer'), 0),
      card     = coalesce((select sum(total) from tandem.checks where point_id = p_point and check_date = p_date and status = 'active' and pay_kind = 'card'), 0),
      updated_at = now()
    where d.id = v_id;
  delete from tandem.sale_lines where report_id = v_id;
  insert into tandem.sale_lines (report_id, item_code, item_name, qty, price, price_list)
    -- Одна строка на позицию (в sale_lines название уникально внутри отчёта): цена — средняя по чекам,
    -- скидка видна как разница с ценой прейскуранта. Два кода с одним названием различаются кодом в скобках.
    select v_id, g.item_code,
           g.item_name || case when count(*) over (partition by g.item_name) > 1 then ' [' || g.item_code || ']' else '' end,
           g.qty, g.price, g.price_list
      from (select l.item_code, min(l.item_name) as item_name, sum(l.qty) as qty,
                   round(sum(l.qty * l.price) / sum(l.qty), 2) as price, max(l.price_list) as price_list
              from tandem.check_lines l join tandem.checks c on c.id = l.check_id
             where c.point_id = p_point and c.check_date = p_date and c.status = 'active'
             group by l.item_code) g
     order by g.item_name;
  return v_id;
end $function$
;

CREATE OR REPLACE FUNCTION tandem.check_apply(p_point text, p_date date)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'tandem', 'public'
AS $function$
declare
  v_id bigint;
begin
  v_id := tandem.check_rollup(p_point, p_date);
  begin
    perform tandem.sale_sync(v_id);
  exception when others then
    begin
      update tandem.documents set sync_note = 'Сбой при сохранении чека: ' || sqlerrm
             || ' — нажмите «Провести продажи за период»'
        where source_kind = 'daily_report' and source_id = v_id::text;
    exception when others then null;
    end;
  end;
end $function$
;

CREATE OR REPLACE FUNCTION tandem.check_save(p_point text, payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'tandem', 'public'
AS $function$
declare
  v_uid   uuid;
  v_date  date := nullif(payload->>'date','')::date;
  v_pay   text := payload->>'pay_kind';
  v_chk   tandem.checks;
  v_id    bigint;
  v_bad   text;
  v_total numeric;
  v_was   text;
begin
  begin v_uid := (payload->>'uid')::uuid; exception when others then v_uid := null; end;
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'У чека нет номера устройства (uid)'); end if;
  if v_pay is null or v_pay not in ('cash','kaspi_qr','transfer','card') then
    return jsonb_build_object('ok', false, 'error', 'Не выбран способ оплаты'); end if;
  if jsonb_typeof(payload->'lines') is distinct from 'array' or jsonb_array_length(payload->'lines') = 0 then
    return jsonb_build_object('ok', false, 'error', 'В чеке нет позиций'); end if;
  if exists (select 1 from jsonb_array_elements(payload->'lines') x
              where coalesce(nullif(x->>'qty','')::numeric, 0) <= 0 or coalesce(nullif(x->>'price','')::numeric, 0) < 0) then
    return jsonb_build_object('ok', false, 'error', 'Количество должно быть больше нуля, цена — не меньше нуля'); end if;
  select string_agg(x->>'item_code', ', ') into v_bad
    from jsonb_array_elements(payload->'lines') x
    left join tandem.items i on i.code = x->>'item_code' and i.active and i.for_sale
   where i.code is null;
  if v_bad is not null then
    return jsonb_build_object('ok', false, 'error', 'Позиции нет в продаже: ' || v_bad); end if;

  perform 1 from tandem.points where id = p_point for update;   -- нумерация чеков дня — по очереди
  select * into v_chk from tandem.checks where uid = v_uid;
  if v_chk.id is not null and v_chk.point_id <> p_point then
    return jsonb_build_object('ok', false, 'error', 'Чек принадлежит другой точке'); end if;
  if v_chk.id is not null and v_chk.status = 'void' then
    return jsonb_build_object('ok', false, 'error', 'Чек отменён, исправить его нельзя'); end if;
  if v_chk.id is null then
    -- День чека присылает планшет (у сервера время UTC); принимаем только соседние с сегодняшним.
    if v_date is null or v_date < current_date - 2 or v_date > current_date + 1 then
      return jsonb_build_object('ok', false, 'error', 'Дата чека не похожа на сегодняшнюю — проверьте дату на планшете'); end if;
    insert into tandem.checks (uid, point_id, check_date, no, seller, pay_kind)
      values (v_uid, p_point, v_date,
              coalesce((select max(no) from tandem.checks where point_id = p_point and check_date = v_date), 0) + 1,
              nullif(btrim(coalesce(payload->>'seller','')), ''), v_pay)
      returning id into v_id;
  else
    v_id := v_chk.id; v_date := v_chk.check_date;
    -- «Исправлен» ставится, только если чек действительно изменился: досылка после обрыва связи — не правка.
    select v_chk.pay_kind || '|' || string_agg(item_code || ':' || qty::text || ':' || price::text, ',' order by id) into v_was
      from tandem.check_lines where check_id = v_id;
    update tandem.checks set pay_kind = v_pay, updated_at = now() where id = v_id;
    delete from tandem.check_lines where check_id = v_id;
  end if;

  insert into tandem.check_lines (check_id, item_code, item_name, qty, price, price_list)
    select v_id, i.code, i.name, (x->>'qty')::numeric,
           coalesce(nullif(x->>'price','')::numeric, pp.price, i.price, 0), coalesce(pp.price, i.price)
      from jsonb_array_elements(payload->'lines') with ordinality t(x, ord)
      join tandem.items i on i.code = x->>'item_code'
      left join tandem.item_prices pp on pp.item_code = i.code and pp.point_id = p_point
     order by ord;
  select coalesce(sum(round(qty * price, 2)), 0) into v_total from tandem.check_lines where check_id = v_id;
  update tandem.checks set total = v_total,
         edited = edited or (v_was is not null and v_was <> (select v_pay || '|' || string_agg(item_code || ':' || qty::text || ':' || price::text, ',' order by id)
                                                              from tandem.check_lines where check_id = v_id))
   where id = v_id;

  perform tandem.check_apply(p_point, v_date);
  return jsonb_build_object('ok', true, 'check', (select jsonb_build_object('uid', uid, 'no', no, 'total', total,
           'date', check_date, 'edited', edited) from tandem.checks where id = v_id));
end $function$
;

CREATE OR REPLACE FUNCTION tandem.check_void(p_point text, payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'tandem', 'public'
AS $function$
declare
  v_uid uuid;
  v_chk tandem.checks;
begin
  begin v_uid := (payload->>'uid')::uuid; exception when others then v_uid := null; end;
  perform 1 from tandem.points where id = p_point for update;
  select * into v_chk from tandem.checks where uid = v_uid and point_id = p_point;
  if v_chk.id is null then return jsonb_build_object('ok', false, 'error', 'Чек не найден'); end if;
  if v_chk.status = 'active' then
    update tandem.checks set status = 'void', updated_at = now(),
           void_reason = nullif(btrim(coalesce(payload->>'reason','')), '') where id = v_chk.id;
    perform tandem.check_apply(p_point, v_chk.check_date);
  end if;
  return jsonb_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION tandem.check_list(p_point text, p_date date)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'tandem', 'public'
AS $function$
  select jsonb_build_object('ok', true, 'date', p_date,
    'closed_at', (select closed_at from tandem.daily_reports where point_id = p_point and report_date = p_date),
    'totals', (select jsonb_build_object(
        'count', count(*), 'total', coalesce(sum(total), 0),
        'cash', coalesce(sum(total) filter (where pay_kind = 'cash'), 0),
        'kaspi_qr', coalesce(sum(total) filter (where pay_kind = 'kaspi_qr'), 0),
        'transfer', coalesce(sum(total) filter (where pay_kind = 'transfer'), 0),
        'card', coalesce(sum(total) filter (where pay_kind = 'card'), 0))
      from tandem.checks where point_id = p_point and check_date = p_date and status = 'active'),
    'checks', (select coalesce(jsonb_agg(jsonb_build_object(
        'uid', c.uid, 'no', c.no, 'seller', c.seller, 'pay_kind', c.pay_kind, 'total', c.total,
        'status', c.status, 'void_reason', c.void_reason, 'edited', c.edited, 'created_at', c.created_at,
        'lines', (select coalesce(jsonb_agg(jsonb_build_object('item_code', l.item_code, 'item_name', l.item_name,
                    'qty', l.qty, 'price', l.price, 'price_list', l.price_list) order by l.id), '[]'::jsonb)
                  from tandem.check_lines l where l.check_id = c.id)) order by c.no desc), '[]'::jsonb)
      from tandem.checks c where c.point_id = p_point and c.check_date = p_date));
$function$
;


-- ---------------------------------------------------------------- представления
create or replace view tandem.v_daily as
 SELECT r.id, r.report_date, r.point_id, p.name AS point_name, p.mode, r.shift_by,
    r.cash, r.kaspi_qr, r.transfer,
    r.cash + r.kaspi_qr + r.transfer + r.card AS revenue_total,
    r.qr_statement, r.tr_statement,
    CASE WHEN r.qr_statement IS NULL THEN NULL::numeric ELSE r.kaspi_qr - r.qr_statement END AS diff_qr,
    CASE WHEN r.tr_statement IS NULL THEN NULL::numeric ELSE r.transfer - r.tr_statement END AS diff_transfer,
    r.cash_open, r.cash_handed,
    COALESCE(( SELECT sum(e.amount) FROM tandem.cash_expenses e WHERE e.report_id = r.id), 0::numeric) AS podotchet,
    r.cash_open + r.cash - r.cash_handed - COALESCE(( SELECT sum(e.amount) FROM tandem.cash_expenses e WHERE e.report_id = r.id), 0::numeric) AS cash_expected,
    r.cash_counted,
    CASE WHEN r.cash_counted IS NULL THEN NULL::numeric
         ELSE r.cash_open + r.cash - r.cash_handed - COALESCE(( SELECT sum(e.amount) FROM tandem.cash_expenses e WHERE e.report_id = r.id), 0::numeric) - r.cash_counted
    END AS diff_cash,
    COALESCE(( SELECT count(*) FROM tandem.cash_expenses e
          WHERE e.report_id = r.id AND (e.receipt_no IS NULL OR btrim(e.receipt_no) = ''::text)), 0::bigint) AS expenses_no_receipt,
    COALESCE(( SELECT sum((t.issued - t.returned) * COALESCE(t.price, 0::numeric)) FROM tandem.takeout_lines t WHERE t.report_id = r.id), 0::numeric) AS takeout_amount,
    COALESCE(( SELECT sum(s.qty * COALESCE(s.price, 0::numeric)) FROM tandem.sale_lines s WHERE s.report_id = r.id), 0::numeric) AS sales_amount,
    r.comment, r.created_at,
    r.card, r.closed_at,
    ( SELECT count(*) FROM tandem.checks c WHERE c.point_id = r.point_id AND c.check_date = r.report_date AND c.status = 'active') AS checks_count
   FROM tandem.daily_reports r
     JOIN tandem.points p ON p.id = r.point_id;


-- ---------------------------------------------------------------- триггеры
CREATE TRIGGER users_pin_sessions AFTER UPDATE OF pin_hash ON tandem.users FOR EACH ROW EXECUTE FUNCTION tandem.users_pin_sessions();
CREATE TRIGGER users_role_sessions AFTER UPDATE OF role ON tandem.users FOR EACH ROW EXECUTE FUNCTION tandem.users_role_sessions();

-- ---------------------------------------------------------------- RLS: запрет всего, доступ только через функции
alter table tandem.assets enable row level security;
alter table tandem.cash_expenses enable row level security;
alter table tandem.chart_lines enable row level security;
alter table tandem.charts enable row level security;
alter table tandem.counteragents enable row level security;
alter table tandem.catalog_1c enable row level security;
alter table tandem.check_lines enable row level security;
alter table tandem.checks enable row level security;
alter table tandem.daily_reports enable row level security;
alter table tandem.doc_counters enable row level security;
alter table tandem.document_lines enable row level security;
alter table tandem.documents enable row level security;
alter table tandem.item_aliases enable row level security;
alter table tandem.item_groups enable row level security;
alter table tandem.item_prices enable row level security;
alter table tandem.item_rank enable row level security;
alter table tandem.items enable row level security;
alter table tandem.pin_failures enable row level security;
alter table tandem.points enable row level security;
alter table tandem.realization_clients enable row level security;
alter table tandem.realization_ledger enable row level security;
alter table tandem.role_permissions enable row level security;
alter table tandem.sale_lines enable row level security;
alter table tandem.sessions enable row level security;
alter table tandem.settings enable row level security;
alter table tandem.stock_balances enable row level security;
alter table tandem.stock_moves enable row level security;
alter table tandem.stores enable row level security;
alter table tandem.takeout_lines enable row level security;
alter table tandem.units enable row level security;
alter table tandem.user_stores enable row level security;
alter table tandem.users enable row level security;
