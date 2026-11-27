-- 0073: папки как в iiko (вопрос Раисы 27.11.2026: «выпечка и реал в одном блоке, путаница»). При переносе из iiko
-- вложенность групп потерялась: у всех 115 групп учёта не было «родителя», и на кассе три разные группы «ТЭМК»
-- (Завтрак, Напитки, П/Ф) слились в одну кнопку, восемь «Актау» - в одну.
-- - Перенос из iiko (tandem_migrate, groups) ставит родителя группы по полю parent строки (tools/iiko-migrate.mjs
--   теперь его передаёт); сами родители - разовая загрузка db/loads/2026-11-27-gruppy-roditeli.sql из выгрузки iiko.
-- - tandem.group_label: подпись папки для кассы - «родитель · группа», если родитель сам не корень (корни «Меню»,
--   «Товары», «П/Ф», «TANDEM меню» опускаются): «Завтрак · ТЭМК», «Напитки · ТЭМК», «Фабрика ТЭМК · Выпечка Пф».
-- - Касса получает её в поле folder позиций (действие items); фильтр точки по-прежнему по category (имени группы).

create or replace function tandem.group_label(p_group uuid)
 returns text
 language sql
 stable
 set search_path to 'tandem', 'public'
as $function$
  select case when p.id is not null and p.parent_id is not null then p.name || ' · ' || g.name else g.name end
    from tandem.item_groups g left join tandem.item_groups p on p.id = g.parent_id
   where g.id = p_group
$function$;

do $mig$
declare
  v text; n int;
  i1a constant text := $r$'code', code, 'name', name, 'category', category, 'unit', unit,$r$;
  i1b constant text := $r$'code', code, 'name', name, 'category', category, 'folder', folder, 'unit', unit,   /* 0073 */$r$;
  i2a constant text := $r$        select i.code, i.name, i.category, i.unit,$r$;
  i2b constant text := $r$        select i.code, i.name, i.category, tandem.group_label(i.group_id) as folder, i.unit,$r$;
  m1a constant text := $r$    select (select count(*) from upd), (select count(*) from ins) into v_upd, v_ins;

  elsif p_kind = 'stores' then$r$;
  m1b constant text := $r$    select (select count(*) from upd), (select count(*) from ins) into v_upd, v_ins;
    -- 0073: вложенность групп из iiko - родитель по полю parent (iiko_id родительской группы).
    update tandem.item_groups g set parent_id = p.id
      from (select distinct on (iid) (x->>'id')::uuid iid, (x->>'parent')::uuid piid
              from jsonb_array_elements(p_rows) x
             where coalesce(x->>'id', '') <> '' and coalesce(x->>'parent', '') <> ''
             order by iid) r
      join tandem.item_groups p on p.iiko_id = r.piid
     where g.iiko_id = r.iid and g.id <> p.id and g.parent_id is distinct from p.id;

  elsif p_kind = 'stores' then$r$;
begin
  v := pg_get_functiondef('public.tandem_api(text,jsonb)'::regprocedure);
  if position('/* 0073 */' in v) = 0 then
    n := (length(v) - length(replace(v, i1a, ''))) / length(i1a);
    if n <> 1 then raise exception '0073: в tandem_api поля позиции найдены % раз', n; end if;
    n := (length(v) - length(replace(v, i2a, ''))) / length(i2a);
    if n <> 1 then raise exception '0073: в tandem_api выборка позиций найдена % раз', n; end if;
    execute replace(replace(v, i1a, i1b), i2a, i2b);
  end if;

  v := pg_get_functiondef('public.tandem_migrate(text,text,jsonb)'::regprocedure);
  if position('0073: вложенность' in v) = 0 then
    n := (length(v) - length(replace(v, m1a, ''))) / length(m1a);
    if n <> 1 then raise exception '0073: в tandem_migrate конец переноса групп найден % раз', n; end if;
    execute replace(v, m1a, m1b);
  end if;
end $mig$;
