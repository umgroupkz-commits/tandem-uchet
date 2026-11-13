-- 13.11.2026: обращения клиентов (заявки). Разговор с клиентом делится на эпизоды: новое сообщение после долгой
-- тишины - новое обращение со своим «временем первого обращения». Пишутся в любом режиме бота, и в тихом тоже:
-- по ним считают заявки для рекламы. Когда эпизод затих, бот разбирает переписку моделью (analyzed_at) и
-- отправляет итог в учёт (tandem.wa_leads). Здесь - только то, что нужно, чтобы знать, что и когда разбирать.
create table if not exists bot.leads (
  dialog_id text not null,
  episode_start timestamptz not null,
  phone text, name text, lang text not null default 'ru',
  first_text text,
  last_at timestamptz not null,
  msgs_in int not null default 0,
  msgs_out int not null default 0,
  first_reply_at timestamptz,
  analyzed_at timestamptz,
  primary key (dialog_id, episode_start));
create index if not exists leads_due_idx on bot.leads (last_at) where analyzed_at is null;
