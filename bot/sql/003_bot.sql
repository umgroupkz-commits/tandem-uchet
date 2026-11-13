-- 13.11.2026: учёт обращений клиентов. Нужен и в тихом режиме, когда бот только слушает: по этим строкам
-- считают, сколько людей написало и сколько из них с рекламы (source заполняется, когда в рекламе появятся метки).
create table if not exists bot.contacts (
  dialog_id text primary key,
  phone text, name text, lang text not null default 'ru',
  first_at timestamptz not null default now(),
  last_at timestamptz not null default now(),
  msgs_in int not null default 0,
  first_text text, source text);
create index if not exists contacts_first_at_idx on bot.contacts (first_at);
