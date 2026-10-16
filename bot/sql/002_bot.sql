-- 16.10.2026: ответ с причиной или курьером — только от того, кто нажал кнопку (Telegram id)
alter table bot.awaits add column if not exists by_id bigint not null default 0;
