create schema if not exists bot;
create table if not exists bot.events_seen (event_id text primary key, at timestamptz not null default now());
create table if not exists bot.dialogs (dialog_id text primary key, data jsonb not null, updated_at timestamptz not null default now());
create table if not exists bot.state (key text primary key, value jsonb not null);
create table if not exists bot.cards (order_id bigint primary key, chat_id bigint not null, message_id bigint not null,
  status text not null, created_at timestamptz not null, dialog_id text, lang text not null, no int not null);
create table if not exists bot.awaits (chat_id bigint not null, prompt_id bigint not null, order_id bigint not null,
  kind text not null, to_status text not null, by_name text not null, primary key (chat_id, prompt_id));
create table if not exists bot.notices (order_id bigint not null, kind text not null, at timestamptz not null default now(),
  primary key (order_id, kind));
create table if not exists bot.journal (id bigserial primary key, at timestamptz not null default now(), kind text not null,
  dialog_id text, text text not null);
-- события «Узла» старше недели не повторяются (README «Узла»: доставленные хранятся неделю)
create index if not exists events_seen_at_idx on bot.events_seen (at);
