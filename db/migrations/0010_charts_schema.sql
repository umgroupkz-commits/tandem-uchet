-- Техкарты и себестоимость: схема. btree_gist — стандартное расширение Postgres,
-- нужно для ограничения «у блюда одна карта на любую дату».
create extension if not exists btree_gist;

alter table tandem.items
  add column if not exists cost_price  numeric,
  add column if not exists cost_date   date,
  add column if not exists cost_source text;
alter table tandem.items drop constraint if exists items_cost_source_check;
alter table tandem.items add constraint items_cost_source_check
  check (cost_source is null or cost_source in ('iiko_invoice','manual','document'));
alter table tandem.items alter column unit_id set not null;

create table if not exists tandem.charts (
  id            uuid primary key default gen_random_uuid(),
  item_code     text not null references tandem.items(code),
  date_from     date not null default current_date,
  date_to       date null,
  output_amount numeric not null check (output_amount > 0),
  technology    text null,
  note          text null,
  source        text not null default 'office' check (source in ('office','iiko')),
  iiko_id       uuid unique null,
  created_by    uuid null references tandem.users(id),
  created_at    timestamptz not null default now(),
  updated_by    uuid null references tandem.users(id),
  updated_at    timestamptz not null default now(),
  constraint charts_dates check (date_to is null or date_to >= date_from),
  constraint charts_no_overlap exclude using gist
    (item_code with =, daterange(date_from, date_to, '[]') with &&)
);
create index if not exists charts_item_idx on tandem.charts (item_code, date_from desc);

create table if not exists tandem.chart_lines (
  id              uuid primary key default gen_random_uuid(),
  chart_id        uuid not null references tandem.charts(id) on delete cascade,
  ingredient_code text not null references tandem.items(code),
  brutto          numeric not null check (brutto >= 0),
  netto           numeric not null check (netto >= 0),
  output          numeric not null check (output >= 0),
  sort_order      int not null default 0,
  note            text null
);
create index if not exists chart_lines_chart_idx on tandem.chart_lines (chart_id);
create index if not exists chart_lines_ingredient_idx on tandem.chart_lines (ingredient_code);

insert into tandem.settings (key, value) values ('foodcost_alert', '35')
on conflict (key) do nothing;

insert into tandem.role_permissions (role, section, action)
select r, 'charts', a from (values
  ('admin','view'),('admin','edit'),
  ('owner','view'),('owner','edit'),
  ('technologist','view'),('technologist','edit'),
  ('accountant','view'),
  ('storekeeper','view')
) v(r, a)
on conflict do nothing;

alter table tandem.charts      enable row level security;
alter table tandem.chart_lines enable row level security;
