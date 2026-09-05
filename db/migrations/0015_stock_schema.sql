-- Документы склада: схема.
create table if not exists tandem.documents (
  id              uuid primary key default gen_random_uuid(),
  doc_type        text not null check (doc_type in ('invoice_in','transfer','writeoff','production','inventory')),
  number          text not null unique,
  doc_date        date not null default current_date,
  status          text not null default 'draft' check (status in ('draft','posted')),
  store_from      uuid null references tandem.stores(id),
  store_to        uuid null references tandem.stores(id),
  counteragent_id uuid null references tandem.counteragents(id),
  reason          text null check (reason is null or reason in ('spoilage','tasting','staff_meals','other')),
  comment         text null,
  total_sum       numeric null,
  created_by      uuid null references tandem.users(id),
  created_at      timestamptz not null default now(),
  updated_by      uuid null references tandem.users(id),
  updated_at      timestamptz not null default now(),
  posted_by       uuid null references tandem.users(id),
  posted_at       timestamptz null,
  constraint documents_stores_by_type check (
    case doc_type
      when 'invoice_in' then store_to is not null and counteragent_id is not null
      when 'transfer'   then store_from is not null and store_to is not null and store_from <> store_to
      else store_from is not null
    end)
);
create index if not exists documents_date_idx on tandem.documents (doc_date desc, created_at desc);
create index if not exists documents_type_status_idx on tandem.documents (doc_type, status);

create table if not exists tandem.document_lines (
  id          uuid primary key default gen_random_uuid(),
  document_id uuid not null references tandem.documents(id) on delete cascade,
  line_kind   text not null default 'item' check (line_kind in ('item','consume')),
  item_code   text not null references tandem.items(code),
  qty         numeric not null default 0 check (qty >= 0),
  unit_id     text null references tandem.units(id),
  price       numeric null,
  sum         numeric null,
  fact_qty    numeric null,
  calc_qty    numeric null,
  note        text null,
  sort_order  int not null default 0
);
create index if not exists document_lines_doc_idx on tandem.document_lines (document_id, line_kind, sort_order);

create table if not exists tandem.stock_moves (
  id          bigserial primary key,
  document_id uuid not null references tandem.documents(id) on delete cascade,
  line_id     uuid null references tandem.document_lines(id) on delete set null,
  store_id    uuid not null references tandem.stores(id),
  item_code   text not null references tandem.items(code),
  qty         numeric not null,
  unit_cost   numeric not null default 0,
  move_date   date not null,
  posted_at   timestamptz not null default now()
);
create index if not exists stock_moves_store_item_idx on tandem.stock_moves (store_id, item_code, move_date, id);
create index if not exists stock_moves_doc_idx on tandem.stock_moves (document_id);

create table if not exists tandem.stock_balances (
  store_id   uuid not null references tandem.stores(id),
  item_code  text not null references tandem.items(code),
  qty        numeric not null default 0,
  avg_cost   numeric not null default 0,
  updated_at timestamptz not null default now(),
  primary key (store_id, item_code)
);

create table if not exists tandem.doc_counters (
  doc_type text not null,
  year     int  not null,
  last_no  int  not null default 0,
  primary key (doc_type, year)
);

insert into tandem.role_permissions (role, section, action)
select r, s, a from (values
  ('admin','stock','view'),('admin','stock','edit'),('owner','stock','view'),('owner','stock','edit'),
  ('storekeeper','stock','view'),('storekeeper','stock','edit'),('accountant','stock','view'),('accountant','stock','edit'),
  ('technologist','stock','view'),('technologist','stock','edit'),
  ('admin','doc:invoice_in','view'),('admin','doc:invoice_in','edit'),('owner','doc:invoice_in','view'),('owner','doc:invoice_in','edit'),
  ('storekeeper','doc:invoice_in','view'),('storekeeper','doc:invoice_in','edit'),('accountant','doc:invoice_in','view'),('accountant','doc:invoice_in','edit'),
  ('admin','doc:transfer','view'),('admin','doc:transfer','edit'),('owner','doc:transfer','view'),('owner','doc:transfer','edit'),
  ('storekeeper','doc:transfer','view'),('storekeeper','doc:transfer','edit'),
  ('admin','doc:writeoff','view'),('admin','doc:writeoff','edit'),('owner','doc:writeoff','view'),('owner','doc:writeoff','edit'),
  ('storekeeper','doc:writeoff','view'),('storekeeper','doc:writeoff','edit'),
  ('admin','doc:production','view'),('admin','doc:production','edit'),('owner','doc:production','view'),('owner','doc:production','edit'),
  ('technologist','doc:production','view'),('technologist','doc:production','edit'),('storekeeper','doc:production','view'),('storekeeper','doc:production','edit'),
  ('admin','doc:inventory','view'),('admin','doc:inventory','edit'),('owner','doc:inventory','view'),('owner','doc:inventory','edit'),
  ('storekeeper','doc:inventory','view'),('storekeeper','doc:inventory','edit')
) v(r, s, a)
on conflict do nothing;

alter table tandem.documents      enable row level security;
alter table tandem.document_lines enable row level security;
alter table tandem.stock_moves    enable row level security;
alter table tandem.stock_balances enable row level security;
alter table tandem.doc_counters   enable row level security;
