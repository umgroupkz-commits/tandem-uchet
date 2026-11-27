-- 0069: позиции, снятые с учёта по решению Тандема (разбор номенклатуры iiko, ответ Раисы 24.11.2026: из списка
-- удалено то, что в новую программу не переносится). Снятая позиция: active = false, off_reason - почему, off_at - когда.
--
-- Перенос из iiko (public.tandem_migrate, kind items) и старая синхронизация (public.tandem_sync_items) включали
-- каждую позицию, живую в iiko, и вернули бы снятые при первом же обновлении из iiko. Теперь у позиции с off_reason
-- активность решает только учёт: перенос обновляет её название, группу, единицу, но active не трогает.
-- Вернуть позицию: в бэк-офисе отметить «активна» (перенос её больше не выключит) или
--   update tandem.items set active = true, off_reason = null, off_at = null where code = '…';
-- Сами снятые позиции - разовая загрузка db/loads/2026-11-27-nomenklatura-raisa.sql (только рабочая база).
--
-- Функции правятся точечной заменой по их тексту в базе (как 0067, 0068): повторный прогон ничего не меняет,
-- несовпавший образец останавливает миграцию с ошибкой, а не затирает чужие правки.

alter table tandem.items add column if not exists off_reason text;
alter table tandem.items add column if not exists off_at timestamptz;

do $mig$
declare
  v text; n int;
  a1 constant text := 'active = not inc2.deleted, synced_at = now()';
  b1 constant text := 'active = case when i.off_reason is not null then i.active else not inc2.deleted end, synced_at = now() /* 0069 */';
  a2 constant text := 'active       = true,';
  b2 constant text := 'active       = case when i.off_reason is not null then i.active else true end,   /* 0069 */';
begin
  v := pg_get_functiondef('public.tandem_migrate(text,text,jsonb)'::regprocedure);
  if position('/* 0069 */' in v) = 0 then
    n := (length(v) - length(replace(v, a1, ''))) / length(a1);
    if n <> 2 then raise exception '0069: в tandem_migrate образец найден % раз, ожидалось 2', n; end if;
    execute replace(v, a1, b1);
  end if;

  v := pg_get_functiondef('public.tandem_sync_items(text,jsonb)'::regprocedure);
  if position('/* 0069 */' in v) = 0 then
    n := (length(v) - length(replace(v, a2, ''))) / length(a2);
    if n <> 1 then raise exception '0069: в tandem_sync_items образец найден % раз, ожидалось 1', n; end if;
    execute replace(v, a2, b2);
  end if;
end $mig$;
