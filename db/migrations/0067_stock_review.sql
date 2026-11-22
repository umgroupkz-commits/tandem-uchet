-- 0067: склад и бэк-офис по ревизии 22.11.2026 (ревьюер 3, участок «Бэк-офис и склад»). Номера S-R3 N -
-- находки отчёта ревьюера; тела функций - из базы стенда rv (копия рабочей 22.11) с точечными правками.
-- S-R3 1  doc_unpost: инвентаризация не отменяется, пока после неё на её складе проведены документы по
--         пересчитанным позициям (повторное проведение поглощало их: товар задваивался, недостача становилась
--         излишком). office_stock doc_preview у черновика описи отдаёт total_sum - итог разницы для окна «Провести?».
-- S-R3 2  отчёты склада («Расход для 1С», «Прибыль по точкам», «Закупки», «Ведомость», «Остатки» с итогом и CSV,
--         «Продажи по блюдам», список продаж, «Готовность») по умолчанию без учебных складов и складов учебных и
--         служебных (zz_*) точек: report_store_ids, report_point_ok. Склад или точку выбрали явно - показываются;
--         закреплённые за пользователем склады и склады учебной учётки - всегда. «Прибыль» понимает point_id.
-- S-R3 4  items_lookup_list с prefer = 'artikul' (загрузка факта из файла): сначала артикул, затем артикул без
--         ведущих нулей, потом код учёта; совпадение названия выше; name_differs - строка на проверку.
-- S-R3 8  docs_list и doc_get - только типы документов с правом doc:<тип>:view; «готовым со склада» правит
--         право doc:transfer:edit (список - doc:transfer:view).
-- S-R3 10 docs_list: сумма черновика прихода - из округлённых строк, как при проведении.
-- S-R3 11 «Прибыль»: себестоимость проданного - по строкам расхода продаж, как «Продажи по блюдам».
-- S-R3 12 inv_block_text: отказ документу задним числом разводит «движение после пересчёта» и «до пересчёта,
--         документ внесли позже».
-- S-R3 13 «Готовность»: служебные точки zz_* не в счёт (НТИН, точки без склада, привязка склада); новая проверка -
--         склад кухни плана заявок учебный (участок точки).
-- S-R3 14 doc_save: пустая дата у существующего документа - прежняя дата, а не сегодняшняя.
-- S-R3 15 CSV остатков: русские заголовки, «Код iiko» текстом; текстовые ячейки CSV (остатки, фудкост) - через
--         csv_text (CSV-инъекция: = + - @ в начале).
-- Повторяемая: помощники - create or replace, правки функций - точечные замены по тексту из базы на момент
-- применения (pg_temp.patch67, как 0068): уже применённая замена пропускается, несовпавший образец (кто-то
-- поменял это место) останавливает миграцию с ошибкой, а не затирает чужую правку.
-- Применение: docker exec -i tandem-db psql -U tandem -d tandem -v ON_ERROR_STOP=1 < db/migrations/0067_stock_review.sql

-- ---------------------------------------------------------------- помощники отчётов склада (S-R3 2, 15)
-- Склады, по которым строится отчёт склада. Склад выбран явно - только он (если доступен пользователю).
-- «Все склады» - доступные пользователю, кроме учебных (stores.training) и складов учебных и служебных
-- точек (points.training, коды zz_*): их приходы, продажи и списания - обучение и дымовой тест, а не работа,
-- и в «Расходе для 1С», «Прибыли», «Закупках», «Ведомости» и «Остатках» они искажали итоги. Склады,
-- закреплённые за пользователем, и любые склады учебной учётной записи показываются всегда - это его склады.
CREATE OR REPLACE FUNCTION tandem.report_store_ids(p_user tandem.users, p_store uuid)
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE
 SET search_path TO 'tandem', 'public'
AS $function$
  select s.id from tandem.stores s
   where p_store is not null and s.id = p_store and tandem.user_store_ok(p_user.id, s.id)
  union all
  select s.id from tandem.stores s
   where p_store is null and tandem.user_store_ok(p_user.id, s.id)
     and (coalesce(p_user.training, false)
          or exists (select 1 from tandem.user_stores us where us.user_id = p_user.id and us.store_id = s.id)
          or not (s.training
                  or exists (select 1 from tandem.points p
                              where (p.id = s.point_id or p.default_store_id = s.id)
                                and (coalesce(p.training, false) or p.id like 'zz\_%'))))
$function$
;

-- Точка в отчёте «по всем точкам» (продажи точек): не учебная и не служебная zz_*. Учебной учётке и
-- пользователю, за которым закреплён склад точки, она видна всегда.
CREATE OR REPLACE FUNCTION tandem.report_point_ok(p_user tandem.users, p_point text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'tandem', 'public'
AS $function$
  select coalesce(p_user.training, false)
      or exists (select 1 from tandem.points p join tandem.user_stores us on us.store_id = p.default_store_id
                  where p.id = p_point and us.user_id = p_user.id)
      or not exists (select 1 from tandem.points p where p.id = p_point and (coalesce(p.training, false) or p.id like 'zz\_%'))
$function$
;

-- Текстовая ячейка CSV для Excel: «;» и переводы строк не ломают колонки, а текст, начинающийся с = + - @
-- (или табуляции), не выполняется как формула - перед ним апостроф (CSV-инъекция). Числа и намеренные
-- формулы ="00725" сюда не передаются.
CREATE OR REPLACE FUNCTION tandem.csv_text(p text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case when v ~ '^[=+@\t\r-]' then '''' || v else v end
    from (select replace(regexp_replace(coalesce(p, ''), '[\r\n]+', ' ', 'g'), ';', ',') as v) x
$function$
;


-- Правки - точечные, по тексту функций из базы на момент применения (как 0060 и 0068): чужие изменения соседних
-- мест сохраняются, повторный прогон ничего не меняет, несовпавший образец останавливает миграцию с ошибкой.
create or replace function pg_temp.patch67(p_fn regprocedure, p_from text, p_to text) returns void language plpgsql as $$
declare d text := pg_get_functiondef(p_fn); n int;
begin
  if position(p_to in d) > 0 then return; end if;   -- уже применено (повторный прогон)
  n := (length(d) - length(replace(d, p_from, ''))) / length(p_from);
  if n <> 1 then raise exception '0067: образец в % встретился % раз: %', p_fn, n, left(p_from, 80); end if;
  execute replace(d, p_from, p_to);
end $$;


-- ---------------------------------------------------------------- tandem.inv_block_text(jsonb,boolean)
select pg_temp.patch67('tandem.inv_block_text(jsonb,boolean)'::regprocedure,
$p$declare r jsonb; v_parts text[] := '{}'; v_n int := 0; v_open boolean := false; v_more int; v_d text; v_txt text;$p$,
$p$declare r jsonb; v_parts text[] := '{}'; v_n int := 0; v_open boolean := false; v_more int; v_d text; v_txt text;
        v_inv text;   -- номера обычных описей (не ввод остатков), мешающих документу$p$);
select pg_temp.patch67('tandem.inv_block_text(jsonb,boolean)'::regprocedure,
$p$  if not p_unpost then
    if cardinality(v_parts) = 1 and v_more = 0 and not v_open then
      return v_txt || '. Проведите его датой не раньше ' || v_d || ', уберите эти позиции или сначала отмените её проведение';
    end if;
    return v_txt || '. Проведите документ датой не раньше ' || v_d
      || case when v_n > 0 then ', уберите эти позиции или сначала отмените проведение '
                || (select string_agg(x->>'number', ', ') from jsonb_array_elements(coalesce(p_blk->'list', jsonb_build_array(p_blk))) x
                     where not coalesce((x->>'opening')::boolean, false))
              else ' или уберите эти позиции' end;
  end if;
$p$,
$p$  -- S-R3 12: два случая. Движение было ПОСЛЕ пересчёта - документ датой не раньше описи. Движение было ДО
  -- пересчёта, а документ внесли позже (накладная за вчера после утренней описи) - опись его уже учла:
  -- провести документ датой описи значит учесть товар второй раз; нужно отменить опись, провести документ
  -- его датой и провести опись снова. Ввод начальных остатков не отменяют: то, что в него вошло, документом
  -- не вносят.
  if not p_unpost then
    v_inv := (select string_agg(x->>'number', ', ') from jsonb_array_elements(coalesce(p_blk->'list', jsonb_build_array(p_blk))) x
               where not coalesce((x->>'opening')::boolean, false));
    return v_txt || '. Если товар пришёл или ушёл после пересчёта - проведите документ датой не раньше ' || v_d || '.'
      || case when v_n > 0 then ' Если до пересчёта, а документ просто внесли позже - сначала отмените проведение '
                || v_inv || ', проведите этот документ и снова проведите опись: иначе товар учтётся дважды.' else '' end
      || case when v_open then ' Если движение уже вошло в начальные остатки - этот документ не нужен.' else '' end
      || ' Или уберите эти позиции';
  end if;
$p$);

-- ---------------------------------------------------------------- tandem.doc_unpost(uuid,tandem.users)
select pg_temp.patch67('tandem.doc_unpost(uuid,tandem.users)'::regprocedure,
$p$        v_train boolean;$p$,
$p$        v_train boolean;
        v_after_n int; v_after text;   -- S-R3 1: документы после описи по её позициям$p$);
select pg_temp.patch67('tandem.doc_unpost(uuid,tandem.users)'::regprocedure,
$p$    return tandem.err('validation', tandem.inv_block_text(v_blk, true));
  end if;
$p$,
$p$    return tandem.err('validation', tandem.inv_block_text(v_blk, true));
  end if;
  -- S-R3 1: опись не отменяется, пока после неё на её складе проведены документы её дня (или раньше) по
  -- пересчитанным ею позициям. Повторное проведение считает расчёт «на конец дня» из уже проведённого и
  -- включило бы их: факт стёр бы их движения - перемещение ушло бы с кухни на точку и осталось на кухне,
  -- а недостача превратилась бы в излишек. Исправление - новой описью с фактом на сейчас или отменой этих
  -- документов (продажу точки руками не отменить - только новой описью).
  if d.doc_type = 'inventory' then
    select count(*), string_agg(t.label, ', ' order by t.posted_at, t.number) filter (where t.rn <= 5)
      into v_after_n, v_after
      from (select x.number, x.posted_at,
                   x.number || ' (' || tandem.item_names_text(array_agg(distinct m.item_code)) || ')' as label,
                   row_number() over (order by x.posted_at, x.number) as rn
              from tandem.stock_moves m
              join tandem.documents x on x.id = m.document_id and x.status = 'posted' and x.posted_at > d.posted_at
             where m.store_id = d.store_from and m.move_date <= d.doc_date and m.document_id <> d.id and m.qty <> 0
               and m.item_code in (select dl.item_code from tandem.document_lines dl
                                    where dl.document_id = d.id and dl.line_kind = 'item' and dl.fact_qty is not null)
             group by x.id, x.number, x.posted_at) t;
    if v_after_n > 0 then
      return tandem.err('validation', 'Инвентаризацию ' || d.number || ' не отменить: после неё на складе «'
        || (select name from tandem.stores where id = d.store_from) || '» проведены документы по пересчитанным позициям: '
        || v_after || case when v_after_n > 5 then ' и ещё ' || (v_after_n - 5) else '' end
        || '. Повторное проведение описи учло бы их в расчёте, и они пропали бы из остатка. Ошибку в описи исправьте новой '
        || 'инвентаризацией с фактом на сейчас или сначала отмените проведение этих документов');
    end if;
  end if;
$p$);

-- ---------------------------------------------------------------- tandem.office_stock(text,jsonb,tandem.users)
select pg_temp.patch67('tandem.office_stock(text,jsonb,tandem.users)'::regprocedure,
$p$  v_key   text; v_qkey text; v_bad text;$p$,
$p$  v_key   text; v_qkey text; v_bad text;
  v_vtypes text[];   -- S-R3 8: типы документов, которые роль может смотреть (doc:<тип>:view)$p$);
select pg_temp.patch67('tandem.office_stock(text,jsonb,tandem.users)'::regprocedure,
$p$  if action = 'docs_list' then
$p$,
$p$  if action = 'docs_list' then
    -- S-R3 8: журнал показывает только типы документов, которые роль может смотреть (doc:<тип>:view) -
    -- технолог без права на приходы не видит накладные с ценами и поставщиками.
    v_vtypes := array(select substr(rp.section, 5) from tandem.role_permissions rp
                       where rp.role = v_user.role and rp.action = 'view' and rp.section like 'doc:%');
$p$);
select pg_temp.patch67('tandem.office_stock(text,jsonb,tandem.users)'::regprocedure,
$p$                  then (select round(sum(l.qty * coalesce(l.price, 0)), 2) from tandem.document_lines l$p$,
$p$                  -- S-R3 10: сумма округлённых до тиына строк, как при проведении (а не округлённая сумма)
                  then (select sum(round(l.qty * coalesce(l.price, 0), 2)) from tandem.document_lines l$p$);
select pg_temp.patch67('tandem.office_stock(text,jsonb,tandem.users)'::regprocedure,
$p$        and tandem.user_doc_ok(v_user.id, d.store_from, d.store_to)
      order by d.doc_date desc, d.created_at desc limit 200 offset (v_page-1)*200) x;$p$,
$p$        and tandem.user_doc_ok(v_user.id, d.store_from, d.store_to)
        and d.doc_type = any(v_vtypes)
      order by d.doc_date desc, d.created_at desc limit 200 offset (v_page-1)*200) x;$p$);
select pg_temp.patch67('tandem.office_stock(text,jsonb,tandem.users)'::regprocedure,
$p$    if not tandem.user_doc_ok(v_user.id, v_doc.store_from, v_doc.store_to) then
      return tandem.err('forbidden', 'Документ чужого склада'); end if;
    -- ext_number$p$,
$p$    if not tandem.user_doc_ok(v_user.id, v_doc.store_from, v_doc.store_to) then
      return tandem.err('forbidden', 'Документ чужого склада'); end if;
    if not tandem.office_can(v_user.role, 'doc:' || v_doc.doc_type, 'view') then
      return tandem.err('forbidden', 'Нет права смотреть документы этого типа'); end if;
    -- ext_number$p$);
select pg_temp.patch67('tandem.office_stock(text,jsonb,tandem.users)'::regprocedure,
$p$    begin
      v_date := coalesce(nullif(payload->>'doc_date','')::date, tandem.local_now()::date);
    exception when others then
      return tandem.err('validation', 'Неверная дата документа');
    end;$p$,
$p$    -- S-R3 14: пустая дата - у нового документа сегодняшняя (местная), у существующего прежняя (ниже):
    -- раньше очищенное поле даты молча переносило черновик задним числом на сегодня.
    begin
      v_date := nullif(payload->>'doc_date','')::date;
    exception when others then
      return tandem.err('validation', 'Неверная дата документа');
    end;$p$);
select pg_temp.patch67('tandem.office_stock(text,jsonb,tandem.users)'::regprocedure,
$p$    if v_id is null then
      if v_date < date '2024-01-01' or (v_date > tandem.local_now()::date + 1$p$,
$p$    if v_id is null then
      v_date := coalesce(v_date, tandem.local_now()::date);
      if v_date < date '2024-01-01' or (v_date > tandem.local_now()::date + 1$p$);
select pg_temp.patch67('tandem.office_stock(text,jsonb,tandem.users)'::regprocedure,
$p$      -- окно дат — только если дату меняют (второй круг V3)
      if v_date is distinct from v_doc.doc_date$p$,
$p$      v_date := coalesce(v_date, v_doc.doc_date);
      -- окно дат — только если дату меняют (второй круг V3)
      if v_date is distinct from v_doc.doc_date$p$);
select pg_temp.patch67('tandem.office_stock(text,jsonb,tandem.users)'::regprocedure,
$p$    return jsonb_build_object('ok', true) || tandem.doc_preview(v_id);$p$,
$p$    v_res := jsonb_build_object('ok', true) || tandem.doc_preview(v_id);
    -- S-R3 1: у черновика описи - итог разницы, как его сейчас посчитает проведение: окно «Провести
    -- документ?» показывает его, и перевёрнутый расчёт виден до проведения.
    if v_doc.doc_type = 'inventory' and v_doc.status = 'draft' then
      select round(coalesce(sum(round(x.diff * case when x.diff > 0 and x.price > 0 then x.price
                                                    else tandem.store_avg(v_doc.store_from, x.item_code) end, 2)), 0), 2)
        into v_sum
        from (select l.item_code, l.price, l.fact_qty - tandem.stock_qty_at(v_doc.store_from, l.item_code, v_doc.doc_date) as diff
                from tandem.document_lines l
               where l.document_id = v_id and l.line_kind = 'item' and l.fact_qty is not null) x;
      v_res := v_res || jsonb_build_object('total_sum', v_sum);
    end if;
    return v_res;$p$);
select pg_temp.patch67('tandem.office_stock(text,jsonb,tandem.users)'::regprocedure,
$p$        and (nullif(payload->>'point_id','') is null or r.point_id = payload->>'point_id')
        and (not exists (select 1 from tandem.user_stores us where us.user_id = v_user.id)
             or exists (select 1 from tandem.user_stores us where us.user_id = v_user.id
                          and us.store_id in (p.default_store_id, d.store_from)))));$p$,
$p$        and (nullif(payload->>'point_id','') is null or r.point_id = payload->>'point_id')
        -- S-R3 2: точку не выбрали - учебные и служебные (zz_*) точки не показываются
        and (nullif(payload->>'point_id','') is not null or tandem.report_point_ok(v_user, p.id))
        and (not exists (select 1 from tandem.user_stores us where us.user_id = v_user.id)
             or exists (select 1 from tandem.user_stores us where us.user_id = v_user.id
                          and us.store_id in (p.default_store_id, d.store_from)))));$p$);
select pg_temp.patch67('tandem.office_stock(text,jsonb,tandem.users)'::regprocedure,
$p$      where (v_store is null or b.store_id = v_store) and tandem.user_store_ok(v_user.id, b.store_id)
        and (v_q = '' or i.name ilike '%'||v_q||'%' or i.code = v_q)
        and (coalesce((payload->>'only_nonzero')::boolean, true) = false or b.qty <> 0)
      order by s.name, i.name limit 200$p$,
$p$      where b.store_id in (select tandem.report_store_ids(v_user, v_store))   -- S-R3 2: склад не выбран - без учебных
        and (v_q = '' or i.name ilike '%'||v_q||'%' or i.code = v_q)
        and (coalesce((payload->>'only_nonzero')::boolean, true) = false or b.qty <> 0)
      order by s.name, i.name limit 200$p$);
select pg_temp.patch67('tandem.office_stock(text,jsonb,tandem.users)'::regprocedure,
$p$      where (v_store is null or b.store_id = v_store) and tandem.user_store_ok(v_user.id, b.store_id)
        and (v_q = '' or i.name ilike '%'||v_q||'%' or i.code = v_q)
        and (coalesce((payload->>'only_nonzero')::boolean, true) = false or b.qty <> 0);
    -- CSV$p$,
$p$      where b.store_id in (select tandem.report_store_ids(v_user, v_store))   -- S-R3 2: склад не выбран - без учебных
        and (v_q = '' or i.name ilike '%'||v_q||'%' or i.code = v_q)
        and (coalesce((payload->>'only_nonzero')::boolean, true) = false or b.qty <> 0);
    -- CSV$p$);
select pg_temp.patch67('tandem.office_stock(text,jsonb,tandem.users)'::regprocedure,
$p$        where (v_store is null or b.store_id = v_store) and tandem.user_store_ok(v_user.id, b.store_id)
          and (v_q$p$,
$p$        where b.store_id in (select tandem.report_store_ids(v_user, v_store))   -- S-R3 2: склад не выбран - без учебных
          and (v_q$p$);
select pg_temp.patch67('tandem.office_stock(text,jsonb,tandem.users)'::regprocedure,
$p$      select 'store;code;name;unit;qty;avg_cost;sum' || E'\n' ||
             coalesce(string_agg(concat_ws(';', replace(s.name, ';', ','), b.item_code, replace(i.name, ';', ','), i.unit_id,
                                           replace(b.qty::text, '.', ','), replace(b.avg_cost::text, '.', ','),
                                           replace(round(b.value, 2)::text, '.', ',')),
                                 E'\n' order by s.name, i.name), '')$p$,
$p$      -- S-R3 15: заголовки по-русски, «Код iiko» - текстом ="00725" (иначе Excel срезает нули), текстовые
      -- ячейки - через csv_text (формулы с = + - @ не выполняются)
      select 'Склад;Код учёта;Код iiko;Позиция;Ед.;Кол-во;Средняя;Сумма' || E'\n' ||
             coalesce(string_agg(concat_ws(';', tandem.csv_text(s.name), b.item_code,
                                           case when i.artikul ~ '^0[0-9]+$' then '="' || i.artikul || '"' else tandem.csv_text(i.artikul) end,
                                           tandem.csv_text(i.name), coalesce(i.unit_id, ''),
                                           replace(b.qty::text, '.', ','), replace(b.avg_cost::text, '.', ','),
                                           replace(round(b.value, 2)::text, '.', ',')),
                                 E'\n' order by s.name, i.name), '')$p$);

-- ---------------------------------------------------------------- tandem.office_stock_ext(text,jsonb,tandem.users)
select pg_temp.patch67('tandem.office_stock_ext(text,jsonb,tandem.users)'::regprocedure,
$p$         where m.move_date <= v_d2
           and (v_store is null or m.store_id = v_store)
           and tandem.user_store_ok(v_user.id, m.store_id)$p$,
$p$         where m.move_date <= v_d2
           -- S-R3 2: склад не выбран - без учебных и складов служебных точек
           and m.store_id in (select tandem.report_store_ids(v_user, v_store))$p$);
select pg_temp.patch67('tandem.office_stock_ext(text,jsonb,tandem.users)'::regprocedure,
$p$           and (nullif(payload->>'point_id','') is null or r.point_id = payload->>'point_id')
           and tandem.user_store_ok(v_user.id, doc.store_from)
      ), li as ($p$,
$p$           and (nullif(payload->>'point_id','') is null or r.point_id = payload->>'point_id')
           and tandem.user_store_ok(v_user.id, doc.store_from)
           -- S-R3 2: точку не выбрали - без учебных складов и служебных точек, как в «Прибыли»
           and (nullif(payload->>'point_id','') is not null or doc.store_from in (select tandem.report_store_ids(v_user, null)))
      ), li as ($p$);
select pg_temp.patch67('tandem.office_stock_ext(text,jsonb,tandem.users)'::regprocedure,
$p$  if action = 'stock_ready_list' then
$p$,
$p$  if action = 'stock_ready_list' then
    -- S-R3 8: список - во вкладке «Заявки» (право смотреть перемещения), правка - у того, кто их ведёт
    if not tandem.office_can(v_user.role, 'doc:transfer', 'view') then
      return tandem.err('forbidden', 'Нет права смотреть, что склады получают готовым'); end if;
$p$);
select pg_temp.patch67('tandem.office_stock_ext(text,jsonb,tandem.users)'::regprocedure,
$p$  if action in ('stock_ready_save', 'stock_ready_delete') then
$p$,
$p$  if action in ('stock_ready_save', 'stock_ready_delete') then
    if not tandem.office_can(v_user.role, 'doc:transfer', 'edit') then
      return tandem.err('forbidden', 'Нет права менять, что склады получают готовым'); end if;
$p$);
select pg_temp.patch67('tandem.office_stock_ext(text,jsonb,tandem.users)'::regprocedure,
$p$           and (v_store is null or d.store_to = v_store)
           and tandem.user_store_ok(v_user.id, d.store_to)$p$,
$p$           -- S-R3 2: склад не выбран - без учебных и складов служебных точек
           and d.store_to in (select tandem.report_store_ids(v_user, v_store))$p$);
select pg_temp.patch67('tandem.office_stock_ext(text,jsonb,tandem.users)'::regprocedure,
$p$    return (with sp as (
        select s.id as store_id,
               coalesce(s.point_id, (select p.id from tandem.points p where p.default_store_id = s.id
                                      order by p.active desc, p.name, p.id limit 1)) as point_id
          from tandem.stores s
      ), rev as ($p$,
$p$    return (with sp as (
        -- S-R3 2: по умолчанию без учебных складов и складов учебных и служебных точек; точку выбрали явно
        -- (point_id) - её склады, какие бы они ни были (так дымовой тест смотрит служебную кассу)
        select x.store_id, x.point_id from (
          select s.id as store_id,
                 coalesce(s.point_id, (select p.id from tandem.points p where p.default_store_id = s.id
                                        order by p.active desc, p.name, p.id limit 1)) as point_id
            from tandem.stores s) x
         where tandem.user_store_ok(v_user.id, x.store_id)
           and case when nullif(payload->>'point_id', '') is not null then x.point_id is not distinct from nullif(payload->>'point_id', '')
                    else x.store_id in (select tandem.report_store_ids(v_user, null)) end
      ), rev as ($p$);
select pg_temp.patch67('tandem.office_stock_ext(text,jsonb,tandem.users)'::regprocedure,
$p$        select sp.point_id,
               coalesce(sum(m.qty * m.unit_cost) filter (where d.doc_type = 'sale'), 0) as sale,
               coalesce(sum(m.qty * m.unit_cost) filter (where d.doc_type = 'writeoff'), 0) as writeoff,$p$,
$p$        select sp.point_id,
               coalesce(sum(m.qty * m.unit_cost) filter (where d.doc_type = 'writeoff'), 0) as writeoff,$p$);
select pg_temp.patch67('tandem.office_stock_ext(text,jsonb,tandem.users)'::regprocedure,
$p$      ), disc as ($p$,
$p$      ), sc as (
        -- S-R3 11: себестоимость проданного - по строкам расхода проведённых продаж (суммы строк округлены до
        -- тиына), как во вкладке «Продажи» и в «Продажах по блюдам»: обе цифры совпадают
        select sp.point_id, sum(coalesce(l.sum, 0)) v
          from tandem.documents d join tandem.document_lines l on l.document_id = d.id and l.line_kind = 'consume'
          join sp on sp.store_id = d.store_from
         where d.doc_type = 'sale' and d.status = 'posted' and d.doc_date between v_d1 and v_d2
           and tandem.user_store_ok(v_user.id, d.store_from)
         group by sp.point_id
      ), disc as ($p$);
select pg_temp.patch67('tandem.office_stock_ext(text,jsonb,tandem.users)'::regprocedure,
$p$         where c.status = 'active' and c.check_date between v_d1 and v_d2 and l.price_list > l.price
           and (not exists (select 1 from tandem.user_stores us where us.user_id = v_user.id)$p$,
$p$         where c.status = 'active' and c.check_date between v_d1 and v_d2 and l.price_list > l.price
           and case when nullif(payload->>'point_id', '') is not null then c.point_id = nullif(payload->>'point_id', '')
                    else tandem.report_point_ok(v_user, c.point_id) end
           and (not exists (select 1 from tandem.user_stores us where us.user_id = v_user.id)$p$);
select pg_temp.patch67('tandem.office_stock_ext(text,jsonb,tandem.users)'::regprocedure,
$p$               round(-coalesce(mv.sale, 0) - coalesce(mv.adj, 0), 2) as cost,$p$,
$p$               round(coalesce(sc.v, 0) - coalesce(mv.adj, 0), 2) as cost,$p$);
select pg_temp.patch67('tandem.office_stock_ext(text,jsonb,tandem.users)'::regprocedure,
$p$          left join mv on mv.point_id is not distinct from k.point_id
$p$,
$p$          left join mv on mv.point_id is not distinct from k.point_id
          left join sc on sc.point_id is not distinct from k.point_id
$p$);
select pg_temp.patch67('tandem.office_stock_ext(text,jsonb,tandem.users)'::regprocedure,
$p$           and m.move_date between v_d1 and v_d2
           and (v_store is null or m.store_id = v_store)
           and tandem.user_store_ok(v_user.id, m.store_id)
         group by m.item_code$p$,
$p$           and m.move_date between v_d1 and v_d2
           -- S-R3 2: склад не выбран - без учебных и складов служебных точек: учебное производство и учебные
           -- продажи не должны попасть в акт списания 1С
           and m.store_id in (select tandem.report_store_ids(v_user, v_store))
         group by m.item_code$p$);

-- ---------------------------------------------------------------- tandem.office_nomenclature(text,jsonb,tandem.users)
select pg_temp.patch67('tandem.office_nomenclature(text,jsonb,tandem.users)'::regprocedure,
$p$  v_store uuid;     -- items_search: склад, остаток на котором отдаётся в stock_qty (S6-1)$p$,
$p$  v_store uuid;     -- items_search: склад, остаток на котором отдаётся в stock_qty (S6-1)
  v_art   boolean;  -- items_lookup_list: режим файла остатков - сначала артикул (S-R3 4)$p$);
select pg_temp.patch67('tandem.office_nomenclature(text,jsonb,tandem.users)'::regprocedure,
$p$  if action = 'items_lookup_list' then
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
          from kv join tandem.item_aliases a on kv.name is not null and a.alias = lower(kv.name)   -- 73: псевдонимы хранятся строчными
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

$p$,
$p$  if action = 'items_lookup_list' then
    if jsonb_typeof(payload->'keys') <> 'array' or jsonb_array_length(payload->'keys') > 2000 then
      return tandem.err('validation', 'Передайте массив ключей (до 2000)');
    end if;
    -- S-R3 4: загрузка факта из файла (prefer = 'artikul') ищет сначала по артикулу iiko, затем по артикулу
    -- без ведущих нулей (Excel делает из «02580» число 2580) и только потом по коду учёта: раньше «2580»
    -- находил чужую позицию с кодом учёта 2580, и факт молча ложился на неё. Среди совпадений выше то, чьё
    -- название совпадает с названием из файла. Совпало не точным артикулом (без нулей, по коду учёта или коду
    -- iiko), а название другое - name_differs: экран показывает такую строку на проверку. Точный артикул -
    -- ключ iiko: позиция, переименованная в бэк-офисе, находится по нему без проверки. Без prefer порядок
    -- прежний: код учёта, код iiko, артикул, псевдоним, название.
    v_art := coalesce(payload->>'prefer', '') = 'artikul';
    return jsonb_build_object('ok', true, 'rows', (
      with kv as (
        select (ord - 1)::int as i, nullif(btrim(x->>'code'),'') as code, nullif(btrim(x->>'name'),'') as name,
               nullif(lower(regexp_replace(translate(btrim(coalesce(x->>'name', '')), 'Ёё', 'Ее'), '[[:space:]]+', ' ', 'g')), '') as nk
        from jsonb_array_elements(payload->'keys') with ordinality t(x, ord)
      ),
      m as (
        select kv.i, kv.nk, i.code as item_code, i.name, i.unit_id, 'code' as matched_by, case when v_art then 3 else 1 end as pr, false as strong
          from kv join tandem.items i on i.active and kv.code is not null and i.code = kv.code
        union all
        select kv.i, kv.nk, i.code, i.name, i.unit_id, 'iiko_code', case when v_art then 4 else 2 end, false
          from kv join tandem.items i on i.active and kv.code is not null and i.iiko_code = kv.code
        union all
        select kv.i, kv.nk, i.code, i.name, i.unit_id, 'artikul', case when v_art then 1 else 3 end, true
          from kv join tandem.items i on i.active and kv.code is not null and i.artikul = kv.code
        union all
        select kv.i, kv.nk, i.code, i.name, i.unit_id, 'artikul', 2, false
          from kv join tandem.items i on i.active and v_art and kv.code ~ '^[0-9]+$' and ltrim(kv.code, '0') <> ''
                                       and i.artikul ~ '^[0-9]+$' and ltrim(i.artikul, '0') = ltrim(kv.code, '0')
        union all
        select kv.i, kv.nk, i.code, i.name, i.unit_id, 'alias', 5, true
          from kv join tandem.item_aliases a on kv.name is not null and a.alias = lower(kv.name)   -- 73: псевдонимы хранятся строчными
          join tandem.items i on i.code = a.item_code and i.active
        union all
        select kv.i, kv.nk, i.code, i.name, i.unit_id, 'name', 6, true
          from kv
          join (select lower(name) as ln, min(code) as code from tandem.items
                where active group by lower(name) having count(*) = 1) nm
            on kv.name is not null and nm.ln = lower(kv.name)
          join tandem.items i on i.code = nm.code
      ),
      mk as (
        select m.*, m.nk is not null
                    and m.nk = lower(regexp_replace(translate(btrim(m.name), 'Ёё', 'Ее'), '[[:space:]]+', ' ', 'g')) as same_name
          from m
      ),
      best as (select distinct on (i) i, item_code, name, unit_id, matched_by,
                      (nk is not null and not same_name and not strong) as name_differs
                 from mk order by i, same_name desc, pr, item_code)
      select coalesce(jsonb_agg(jsonb_build_object('i', i, 'item_code', item_code, 'name', name,
                                                   'unit_id', unit_id, 'matched_by', matched_by, 'name_differs', name_differs)
                                order by i), '[]'::jsonb) from best));
  end if;

$p$);

-- ---------------------------------------------------------------- tandem.quality_report(tandem.users)
select pg_temp.patch67('tandem.quality_report(tandem.users)'::regprocedure,
$p$    into v_count, v_rows from tandem.points p
   where p.active and (p.default_store_id is null$p$,
$p$    into v_count, v_rows from tandem.points p
   where p.active and p.id not like 'zz\_%'   -- S-R3 13: служебные точки дымового теста не в счёт
     and (p.default_store_id is null$p$);
select pg_temp.patch67('tandem.quality_report(tandem.users)'::regprocedure,
$p$       where p.active and s.point_id is distinct from p.id) x;$p$,
$p$       where p.active and p.id not like 'zz\_%' and s.point_id is distinct from p.id) x;$p$);
select pg_temp.patch67('tandem.quality_report(tandem.users)'::regprocedure,
$p$           and tandem.user_store_ok(p_user.id, d.store_from)
        union all$p$,
$p$           and tandem.user_store_ok(p_user.id, d.store_from)
           -- S-R3 2: учебные и служебные склады - не учёт (закреплённые за пользователем видны)
           and d.store_from in (select tandem.report_store_ids(p_user, null))
        union all$p$);
select pg_temp.patch67('tandem.quality_report(tandem.users)'::regprocedure,
$p$           and tandem.user_store_ok(p_user.id, p.default_store_id)
           and not exists (select 1 from tandem.documents d where d.source_kind = 'daily_report' and d.source_id = r.id::text)$p$,
$p$           and tandem.user_store_ok(p_user.id, p.default_store_id)
           and p.default_store_id in (select tandem.report_store_ids(p_user, null))
           and not exists (select 1 from tandem.documents d where d.source_kind = 'daily_report' and d.source_id = r.id::text)$p$);
select pg_temp.patch67('tandem.quality_report(tandem.users)'::regprocedure,
$p$       where b.qty < 0 and tandem.user_store_ok(p_user.id, b.store_id)) x;$p$,
$p$       where b.qty < 0 and b.store_id in (select tandem.report_store_ids(p_user, null))) x;$p$);
select pg_temp.patch67('tandem.quality_report(tandem.users)'::regprocedure,
$p$       and doc.doc_date > current_date - 30 and doc.doc_date <= current_date
       and tandem.user_store_ok(p_user.id, doc.store_from)$p$,
$p$       and doc.doc_date > current_date - 30 and doc.doc_date <= current_date
       and doc.store_from in (select tandem.report_store_ids(p_user, null))$p$);
select pg_temp.patch67('tandem.quality_report(tandem.users)'::regprocedure,
$p$  if exists (select 1 from tandem.points where active and fiscal_enabled and not coalesce(training, false)) then$p$,
$p$  -- S-R3 13: служебная касса дымового теста (zz_kassa, фискальный чек включён, меню «всё») не в счёт
  if exists (select 1 from tandem.points where active and fiscal_enabled and not coalesce(training, false) and id not like 'zz\_%') then$p$);
select pg_temp.patch67('tandem.quality_report(tandem.users)'::regprocedure,
$p$           and exists (select 1 from tandem.points p where p.active and p.fiscal_enabled and not coalesce(p.training, false)
$p$,
$p$           and exists (select 1 from tandem.points p where p.active and p.fiscal_enabled and not coalesce(p.training, false)
                        and p.id not like 'zz\_%'
$p$);
select pg_temp.patch67('tandem.quality_report(tandem.users)'::regprocedure,
$p$  -- 9. Пользователи: временный PIN$p$,
$p$  -- 8б. Участок точки (ревизия 22.11): склад кухни плана заявок (settings.orders_store_id) - учебный: акт производства
  -- и перемещения по плану выпечки уходят на учебный склад, мимо настоящих остатков и отчётов.
  select count(*), coalesce(jsonb_agg(jsonb_build_object('code', s.id, 'name', s.name, 'store_id', s.id,
           'detail', 'склад кухни для плана выпечки отмечен учебным')), '[]'::jsonb)
    into v_count, v_rows
    from tandem.stores s
   where s.training and s.id::text = (select nullif(value, '') from tandem.settings where key = 'orders_store_id');
  if v_count > 0 then
    v_checks := v_checks || jsonb_build_object('id', 'orders_store_training', 'severity', 'bad', 'target', 'orders', 'count', v_count, 'rows', v_rows,
      'title', 'Склад кухни для заявок - учебный',
      'hint', 'Склад → Заявки → «Настройки»: выберите настоящий склад кухни. Пока там учебный склад, акт производства и перемещения по плану выпечки уходят на него, мимо настоящих остатков и отчётов.');
  end if;

  -- 9. Пользователи: временный PIN$p$);

-- ---------------------------------------------------------------- tandem.office_charts(text,jsonb,tandem.users)
select pg_temp.patch67('tandem.office_charts(text,jsonb,tandem.users)'::regprocedure,
$p$           coalesce(string_agg(concat_ws(';', m.code, replace(m.name,';',','),
             coalesce(replace(m.group_name,';',','),''), m.unit_id,$p$,
$p$           -- S-R3: текстовые ячейки - через csv_text: «;» не ломает колонки, = + - @ в начале не формула
           coalesce(string_agg(concat_ws(';', m.code, tandem.csv_text(m.name),
             tandem.csv_text(m.group_name), coalesce(m.unit_id, ''),$p$);
select pg_temp.patch67('tandem.office_charts(text,jsonb,tandem.users)'::regprocedure,
$p$             replace(array_to_string(m.missing_names, ' | '), ';', ',')), E'\n'), '')$p$,
$p$             tandem.csv_text(array_to_string(m.missing_names, ' | '))), E'\n'), '')$p$);

-- Новые функции получают EXECUTE для PUBLIC: закрываем их и пересозданные, как в 0045/0047 - снаружи только через tandem_gate.
do $$
declare f text;
begin
  foreach f in array array[
      'tandem.report_store_ids(tandem.users,uuid)',
      'tandem.report_point_ok(tandem.users,text)',
      'tandem.csv_text(text)',
      'tandem.doc_unpost(uuid,tandem.users)',
      'tandem.inv_block_text(jsonb,boolean)',
      'tandem.office_charts(text,jsonb,tandem.users)',
      'tandem.office_nomenclature(text,jsonb,tandem.users)',
      'tandem.office_stock(text,jsonb,tandem.users)',
      'tandem.office_stock_ext(text,jsonb,tandem.users)',
      'tandem.quality_report(tandem.users)'] loop
    execute 'revoke all on function ' || f || ' from public';
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute 'revoke all on function ' || f || ' from anon, authenticated';
      execute 'grant execute on function ' || f || ' to service_role';
    end if;
  end loop;
end $$;

