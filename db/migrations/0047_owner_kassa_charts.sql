-- Сборка 21: ежедневные операции глазами людей из iiko — собственник, касса, техкарты, номенклатура.
-- Буквы — пункты контракта сборки 21 (contracts3.md, раздел S-C); в скобках — находки отчётов ролей
-- (tech = технолог, owner = собственник, sklad = кладовщик, buh = бухгалтер, Д = касса).
-- E  (sklad6, buh): items_search — фильтр types (массив типов), несколько слов (каждое — в названии
--    или артикуле), порядок «точное → начало названия → начало слова → по алфавиту», limit (до 200),
--    в строке last_price/last_price_date — цена и дата последнего проведённого прихода.
-- E2 (tech5): item_cost_get (и item_get) — source_doc: приход, из которого взята учётная цена, и
--    price_history: до 5 последних проведённых приходов.
-- Q  (tech3, tech6, tech11): chart_delete не удаляет единственную версию карты и последнюю действующую
--    версию полуфабриката, стоящего в других картах; chart_get отдаёт from_iiko (iiko_id сохраняется и
--    после правки); charts_list — фильтр ingredient («где используется») и next_from (будущая версия).
-- Q2 (tech10): item_cost и menu_foodcost рядом с missing (коды) отдают missing_names (названия, в том
--    же порядке); карточки — ещё и missing_text («нет цены у: …; нет техкарты у «…»»); сообщения
--    chart_save / chart_new_version / chart_delete — названиями; CSV фудкоста — русские заголовки и названия.
-- P  (owner4, owner13, owner15, Д1): сводка собственника — checks (чеки и средний чек по точкам),
--    unit_id в raw_usage, late_checks/late_sum (чеки после закрытия смены) и edited_at (отчёт
--    пересохранён с изменениями) у строк дня, «не сдали» — только с первого отчёта точки
--    (points[].first_report); check_list и get_report — late_checks/late_sum.
--    daily_reports: first_saved_at (первая сдача отчёта) и saved_at (последнее сохранение, менявшее отчёт).
-- U  (owner9): собственник получает раздел «Пользователи», но учётные записи администратора не трогает.
-- V  (buh): БИН/ИИН контрагента — ровно 12 цифр.
-- Второй круг (contracts4.md, раздел K; находки тестировщиков v21):
-- K1 (owner Д1, kassa Д1): чеки после закрытия смены. check_list, get_report (и ответ save_report),
--    сводка (строки дня) рядом с late_checks/late_sum отдают late_cash, late_kaspi, late_card,
--    late_transfer — экран считает «должно» на момент закрытия; у чека в check_list — признак late.
--    check_save/check_void правят и отменяют поздний чек (пробит после closed_at), пока смену не закрыли
--    заново; чек, вошедший в закрытие, — по-прежнему только после «Открыть смену для исправления».
-- K2 (admin 2): меню кассы и экрана точки — у точки со своими ценами позиция без своей цены идёт без
--    цены (price = null, «цена не задана»), а не с ценой по умолчанию (из iiko там часто себестоимость).
-- K3 (tech 1): приходы на учебные склады (stores.training) не участвуют в происхождении цены:
--    last_price в items_search, source_doc и price_history карточки.
-- Третья волна (contracts5.md, раздел S6; находки кладовщика v21):
-- S6-1 (sklad 12): items_search с payload.store_id (склад-отправитель перемещения и списания) — у строк
--    stock_qty (остаток на этом складе, null — строки остатка нет), позиции с остатком > 0 выше, после
--    точного совпадения. Только при праве «склад: просмотр» и доступе к складу; иначе и без store_id —
--    как раньше (ключа stock_qty нет, порядок прежний).
-- Скорость (замер на синтетике размером с Тандем): item_cost объявлена ROWS 1 — иначе список техкарт
-- уходил в JIT-компиляцию; tandem_api — jit = off: сводка собственника за месяц 3,0 с → 0,7 с.
-- Тела функций — из db/schema/tandem_full.sql (канон до 0043) с точечными правками; public.tandem_gate и
-- public.tandem_test_cleanup не трогаются (их меняет 0044). Миграция применяется повторно без ошибок.

-- ---------------------------------------------------------------- отчёт точки: первая сдача и правка (P4)
-- updated_at для этого не годится: у кассы его двигает каждый чек (check_rollup) и снятие закрытия, а
-- created_at у кассы — время первого чека, а не сдачи. Поэтому две свои колонки, их пишет только
-- save_report: first_saved_at — первая сдача, saved_at — последнее сохранение, которое что-то поменяло.
alter table tandem.daily_reports add column if not exists first_saved_at timestamp with time zone;
alter table tandem.daily_reports add column if not exists saved_at timestamp with time zone;
-- Прошлые отчёты: у точки без кассы строку создаёт и правит только save_report, значит created_at —
-- первая сдача, updated_at — последнее сохранение. У кассы первую сдачу уже не восстановить —
-- берём последнее закрытие (без отметки «исправлен»); незакрытую смену оставляем пустой: её первая
-- сдача ещё впереди. Повторный прогон заполненное не трогает.
update tandem.daily_reports r
   set first_saved_at = case when p.mode = 'checks' then r.closed_at else r.created_at end,
       saved_at       = case when p.mode = 'checks' then r.closed_at else r.updated_at end
  from tandem.points p
 where p.id = r.point_id and r.first_saved_at is null and (p.mode <> 'checks' or r.closed_at is not null);

-- ---------------------------------------------------------------- учебные склады (K3)
-- Колонку вводит 0045 (T1: приход на учебный склад не меняет учётную цену). Здесь — та же колонка
-- «если её нет»: функции ниже её читают, и 0047 не должна падать, если её переприменят раньше 0045.
alter table tandem.stores add column if not exists training boolean not null default false;

-- ---------------------------------------------------------------- права (U)
-- Собственник заводит сотрудников и сбрасывает им PIN сам, без входа администратора (owner9).
-- Учётные записи администратора ему по-прежнему недоступны — это держит office_users ниже.
insert into tandem.role_permissions (role, section, action) values
  ('owner', 'users', 'view'), ('owner', 'users', 'edit')
on conflict do nothing;

-- ---------------------------------------------------------------- помощники
-- Названия вместо кодов из missing (item_cost, menu_foodcost) — тот же порядок и та же длина, что у
-- missing, чтобы экран мог идти по двум массивам рядом. 'cycle:<код>' — «цикл: <название>»; код,
-- которого нет в справочнике, остаётся кодом.
-- plpgsql, а не sql, и без set search_path: зовётся на каждую строку списка карт и фудкоста, а
-- sql-функцию с запросом Postgres разбирает и планирует заново на каждый вызов; у plpgsql план живёт
-- всю сессию. Пустой список (полная себестоимость — почти все строки) — вовсе без запроса.
create or replace function tandem.missing_names(p_codes text[]) returns text[]
language plpgsql stable as $$
begin
  if p_codes is null or cardinality(p_codes) = 0 then return '{}'::text[]; end if;
  return (select coalesce(array_agg(case when u.m like 'cycle:%' then 'цикл: ' || coalesce(c.name, substr(u.m, 7))
                                         else coalesce(i.name, u.m) end order by u.o), '{}'::text[])
            from unnest(p_codes) with ordinality u(m, o)
            left join tandem.items i on i.code = u.m
            left join tandem.items c on u.m like 'cycle:%' and c.code = substr(u.m, 7));
end $$;

-- Готовая фраза для карточки: почему себестоимость не посчитана. Товар без учётной цены — «нет цены
-- у: …»; блюдо/полуфабрикат в missing — значит, у него нет действующей карты: «нет техкарты у «…»»
-- (tech10: новый ПФ без карты указывал «нет цены у: 90001» сам на себя). По 5 названий в группе.
create or replace function tandem.missing_text(p_codes text[]) returns text
language sql stable set search_path to 'tandem', 'public' as $$
  with m as (
    select u.m, u.o, i.name, i.item_type, c.name as cyc_name
      from unnest(coalesce(p_codes, '{}'::text[])) with ordinality u(m, o)
      left join tandem.items i on i.code = u.m
      left join tandem.items c on u.m like 'cycle:%' and c.code = substr(u.m, 7)
  ), g as (
    select case when m like 'cycle:%' then 3 when item_type in ('dish','prepared') then 2
                when item_type is not null then 1 else 4 end as grp,
           case when m like 'cycle:%' then '«' || coalesce(cyc_name, substr(m, 7)) || '»'
                when item_type in ('dish','prepared') then '«' || name || '»'
                when item_type is not null then name else m end as label, o
      from m
  ), n as (select g.*, row_number() over (partition by grp order by o) rn from g)
  select nullif(string_agg(t, '; ' order by grp), '') from (
    select grp, case grp when 1 then 'нет цены у: ' when 2 then 'нет техкарты у ' when 3 then 'цикл через '
                         else 'нет в справочнике: ' end
           || string_agg(label, ', ' order by o) filter (where rn <= 5)
           || case when count(*) > 5 then ' и ещё ' || (count(*) - 5) else '' end as t
      from n group by grp) x
$$;

-- Содержимое отчёта точки для сравнения «до/после» пересохранения. jsonb сравнивает числа по
-- значению (100 = 100.00), поэтому та же форма, сохранённая второй раз, правкой не считается.
create or replace function tandem.report_content(p_id bigint) returns jsonb
language sql stable set search_path to 'tandem', 'public' as $$
  select jsonb_build_array(r.shift_by, r.cash, r.kaspi_qr, r.transfer, r.card, r.qr_statement, r.tr_statement,
           r.cash_open, r.cash_handed, r.cash_counted, r.comment,
           (select jsonb_agg(jsonb_build_array(e.purpose, e.amount, e.receipt_no) order by e.purpose, e.amount, e.receipt_no)
              from tandem.cash_expenses e where e.report_id = r.id),
           (select jsonb_agg(jsonb_build_array(t.item_code, t.item_name, t.unit, t.issued, t.returned, t.price) order by t.item_name)
              from tandem.takeout_lines t where t.report_id = r.id),
           (select jsonb_agg(jsonb_build_array(s.item_code, s.item_name, s.qty, s.price, s.price_list) order by s.item_name)
              from tandem.sale_lines s where s.report_id = r.id))
    from tandem.daily_reports r where r.id = p_id
$$;

-- Чеки кассы, пробитые после закрытия смены (P3, K1: owner Д1, kassa Д1): активные чеки дня с
-- created_at позже closed_at — сколько, на какую сумму и как оплачены. Строку дня check_rollup
-- пересобирает на каждом чеке, поэтому деньги отчёта (cash, kaspi_qr, card, transfer) поздние чеки уже
-- содержат, а пересчёт кассы при закрытии (cash_counted) — нет: без вычета late_cash «должно» росло и
-- выходила ложная недостача. Экран считает «должно» на момент закрытия (наличные − late_cash) и
-- показывает поздние отдельной строкой. Смена не закрыта — поздних нет (одни нули).
-- plpgsql, как missing_names: сводка зовёт её на каждую строку дня.
create or replace function tandem.late_totals(p_point text, p_date date, p_closed timestamptz) returns jsonb
language plpgsql stable as $$
begin
  return (select jsonb_build_object('late_checks', count(*)::int, 'late_sum', coalesce(sum(c.total), 0),
                   'late_cash',     coalesce(sum(c.total) filter (where c.pay_kind = 'cash'), 0),
                   'late_kaspi',    coalesce(sum(c.total) filter (where c.pay_kind = 'kaspi_qr'), 0),
                   'late_card',     coalesce(sum(c.total) filter (where c.pay_kind = 'card'), 0),
                   'late_transfer', coalesce(sum(c.total) filter (where c.pay_kind = 'transfer'), 0))
            from tandem.checks c
           where p_closed is not null and c.point_id = p_point and c.check_date = p_date
             and c.status = 'active' and c.created_at > p_closed);
end $$;

-- Пометки строки дня для собственника и кассы (P3, P4, K1):
--   late_checks/late_sum и late_cash/late_kaspi/late_card/late_transfer — чеки после закрытия смены
--     (tandem.late_totals): закрытый отчёт их не видел, смену надо закрыть заново (новый чек в закрытую
--     смену касса принимает — продажа не теряется; такой чек продавец может исправить и отменить);
--   edited_at — отчёт пересохранили с изменениями после первой сдачи; first_saved_at — первая сдача.
-- plpgsql по той же причине, что missing_names: сводка зовёт её на каждую строку дня.
create or replace function tandem.report_marks(p_id bigint) returns jsonb
language plpgsql stable as $$
begin
  return (select tandem.late_totals(r.point_id, r.report_date, r.closed_at)
                 || jsonb_build_object('first_saved_at', r.first_saved_at,
                                       'edited_at', case when r.saved_at > r.first_saved_at then r.saved_at end)
            from tandem.daily_reports r
           where r.id = p_id);
end $$;

-- Откуда учётная цена (E2, tech5): приход, который её поставил (doc_post пишет cost_price = цена строки,
-- cost_date = дата документа, cost_source = 'document'), и последние 5 проведённых приходов позиции.
-- Нулевые (бонусные) строки учётную цену не ставят — в историю цен они тоже не идут.
-- K3 (tech 1): приходы на учебные склады (stores.training) учётную цену не ставят (T1, 0045) — ни
-- источником, ни строкой истории они не показываются: учебная курица по 1 900 — не история закупок.
create or replace function tandem.item_price_origin(p_code text) returns jsonb
language sql stable set search_path to 'tandem', 'public' as $$
  select jsonb_build_object(
    'source_doc', (
      select jsonb_build_object('id', d.id, 'number', d.number, 'doc_date', d.doc_date, 'counteragent_name', ca.name)
        from tandem.items i
        join tandem.document_lines dl on dl.item_code = i.code and dl.line_kind = 'item' and dl.price = i.cost_price
        join tandem.documents d on d.id = dl.document_id and d.doc_type = 'invoice_in' and d.status = 'posted'
                               and d.doc_date = i.cost_date
        left join tandem.counteragents ca on ca.id = d.counteragent_id
        left join tandem.stores st on st.id = d.store_to
       where i.code = p_code and i.cost_source = 'document' and st.training is not true
       order by d.posted_at desc nulls last limit 1),
    'price_history', (
      select coalesce(jsonb_agg(h.j order by h.rn), '[]'::jsonb) from (
        select jsonb_build_object('doc_id', d.id, 'number', d.number, 'doc_date', d.doc_date,
                 'counteragent_name', ca.name, 'price', dl.price, 'qty', dl.qty) as j,
               row_number() over (order by d.doc_date desc, d.posted_at desc nulls last, d.number desc) as rn
          from tandem.document_lines dl
          join tandem.documents d on d.id = dl.document_id and d.doc_type = 'invoice_in' and d.status = 'posted'
          left join tandem.counteragents ca on ca.id = d.counteragent_id
          left join tandem.stores st on st.id = d.store_to
         where dl.item_code = p_code and dl.line_kind = 'item' and dl.price > 0 and st.training is not true
         order by d.doc_date desc, d.posted_at desc nulls last, d.number desc limit 5) h))
$$;

-- ---------------------------------------------------------------- себестоимость (Q2)
-- Q2: рядом с missing (коды) — missing_names, названия в том же порядке. Колонка добавлена в конец:
-- вызывающие «select * into запись» и «select cost, partial, missing» работают как прежде. Смена набора
-- колонок требует drop: create or replace тип результата не меняет. Названия ищутся только на верхнем
-- уровне (p_depth = 0): рекурсия их не читает, а список техкарт зовёт item_cost сотни раз.
-- ROWS 1: функция всегда отдаёт одну строку. Без этого планировщик ждал от неё 1000 строк, и список
-- техкарт с подзапросом next_from на строку оценивался в 1,6 млн — запрос уходил в JIT-компиляцию
-- (замер на 1400 картах: 0,7 с компиляции на запрос в 50 мс).
drop function if exists tandem.item_cost(text, date, integer);
CREATE OR REPLACE FUNCTION tandem.item_cost(p_code text, p_date date DEFAULT CURRENT_DATE, p_depth integer DEFAULT 0)
 RETURNS TABLE(cost numeric, partial numeric, missing text[], missing_names text[])
 LANGUAGE plpgsql
 STABLE
 ROWS 1
AS $function$
declare
  v_type text; v_price numeric; v_chart uuid; v_out numeric;
  v_sum numeric := 0; v_missing text[] := '{}'; v_all boolean := true;
  r record; s record;
begin
  if p_depth > 10 then
    return query select null::numeric, null::numeric, array['cycle:' || p_code],
      case when p_depth = 0 then tandem.missing_names(array['cycle:' || p_code]) end; return;
  end if;
  select item_type, cost_price into v_type, v_price from tandem.items where code = p_code;
  if not found then
    return query select null::numeric, null::numeric, array[p_code],
      case when p_depth = 0 then array[p_code] end; return;
  end if;
  if v_type in ('goods','service') then
    if v_price is null then
      return query select null::numeric, null::numeric, array[p_code],
        case when p_depth = 0 then tandem.missing_names(array[p_code]) end;
    else
      return query select v_price, v_price, '{}'::text[], case when p_depth = 0 then '{}'::text[] end;
    end if;
    return;
  end if;
  v_chart := tandem.active_chart(p_code, p_date);
  if v_chart is null then
    return query select null::numeric, null::numeric, array[p_code],
      case when p_depth = 0 then tandem.missing_names(array[p_code]) end; return;
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
  v_missing := (select coalesce(array_agg(distinct m), '{}'::text[]) from unnest(v_missing) m);
  return query select
    case when v_all then round(v_sum / v_out, 4) end,
    round(v_sum / v_out, 4),
    v_missing,
    case when p_depth = 0 then tandem.missing_names(v_missing) end;
end $function$
;

-- Q2: missing_names — последней колонкой, как у item_cost (to_jsonb строки в foodcost_report отдаёт её сама).
drop function if exists tandem.menu_foodcost(text, date, uuid);
CREATE OR REPLACE FUNCTION tandem.menu_foodcost(p_point text DEFAULT NULL::text, p_date date DEFAULT CURRENT_DATE, p_group uuid DEFAULT NULL::uuid)
 RETURNS TABLE(code text, name text, group_name text, unit_id text, cost numeric, price numeric, markup_pct numeric, foodcost_pct numeric, over_limit boolean, missing text[], missing_names text[])
 LANGUAGE sql
 STABLE
AS $function$
  with recursive
  lim as (select coalesce((select value::numeric from tandem.settings where key = 'foodcost_alert'), 35) as v),
  dishes as (
    -- K2 (интегратор): у точки со своими ценами позиция без своей цены — без цены, как в её меню; цена по
    -- умолчанию там часто себестоимость из iiko и давала бы ложный фудкост.
    select i.code, i.name, g.name as group_name, i.unit_id,
           case when p_point is not null and exists (select 1 from tandem.item_prices x where x.point_id = p_point)
                then pp.price else coalesce(pp.price, i.price) end as price
    from tandem.items i
    left join tandem.item_groups g on g.id = i.group_id
    left join tandem.item_prices pp on p_point is not null and pp.point_id = p_point and pp.item_code = i.code
    where i.active and i.for_sale and i.item_type in ('dish','prepared')
      and (p_group is null or i.group_id = p_group)
  ),
  -- 46: ребро, ведущее обратно в путь (цикл), не отбрасывается — иначе блюдо получало «полную»
  -- себестоимость без доли зацикленного ПФ. Узел цикла помечается cyc, дальше не раскрывается
  -- и становится листом без цены: complete = false, в missing — 'cycle:<код>', как в item_cost.
  walk as (
    select d.code as root, d.code as node, 1::numeric as factor, 0 as depth, array[d.code] as path, false as cyc
    from dishes d
    union all
    select w.root, cl.ingredient_code, w.factor * cl.brutto / c.output_amount, w.depth + 1, w.path || cl.ingredient_code,
           cl.ingredient_code = any(w.path)
    from walk w
    join tandem.items i on i.code = w.node and i.item_type in ('dish','prepared')
    join tandem.charts c on c.id = tandem.active_chart(w.node, p_date)
    join tandem.chart_lines cl on cl.chart_id = c.id
    where w.depth < 10 and not w.cyc
  ),
  leaves as (
    select w.root, w.node, w.factor, i.item_type, i.cost_price, w.cyc
    from walk w join tandem.items i on i.code = w.node
    where w.cyc or i.item_type in ('goods','service') or tandem.active_chart(w.node, p_date) is null
       -- M6: обход обрывается на глубине 10 (walk выше), и без этого условия узел на границе
       -- просто исчезал бы из расчёта, а блюдо получало бы «полную» себестоимость по обрубку.
       -- Такой узел — лист без цены: complete становится false, а его код попадает в missing.
       or w.depth >= 10
  ),
  agg as (
    select root,
      sum(case when not cyc and item_type in ('goods','service') and cost_price is not null then factor * cost_price else 0 end) as partial,
      bool_and(not cyc and item_type in ('goods','service') and cost_price is not null) as complete,
      array_remove(array_agg(distinct case when cyc then 'cycle:' || node
                                           when not (item_type in ('goods','service') and cost_price is not null) then node end), null) as missing
    from leaves group by root
  )
  select d.code, d.name, d.group_name, d.unit_id,
    case when a.complete then round(a.partial, 2) end as cost,
    d.price,
    case when a.complete and a.partial > 0 and d.price is not null then round((d.price - a.partial) / a.partial * 100, 1) end as markup_pct,
    case when a.complete and d.price > 0 then round(a.partial / d.price * 100, 1) end as foodcost_pct,
    case when a.complete and d.price > 0 then a.partial / d.price * 100 > (select v from lim) else false end as over_limit,
    coalesce(a.missing, array[d.code]) as missing,
    tandem.missing_names(coalesce(a.missing, array[d.code])) as missing_names
  from dishes d left join agg a on a.root = d.code
  order by d.name
$function$
;

-- ---------------------------------------------------------------- касса: смена (P)
CREATE OR REPLACE FUNCTION tandem.check_list(p_point text, p_date date)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'tandem', 'public'
AS $function$
  -- P/Д1, K1: late_checks/late_sum и late_cash/late_kaspi/late_card/late_transfer — активные чеки дня,
  -- пробитые после закрытия смены: закрытый отчёт их не видел, смену нужно закрыть заново (касса
  -- принимает такой чек, чтобы продажа не потерялась). У чека late = true — его продавец может исправить
  -- и отменить, пока смену не закрыли заново (check_save, check_void); вошедший в закрытие — нет.
  with r as (select (select closed_at from tandem.daily_reports where point_id = p_point and report_date = p_date) as closed_at)
  select jsonb_build_object('ok', true, 'date', p_date, 'closed_at', r.closed_at)
    || tandem.late_totals(p_point, p_date, r.closed_at)
    || jsonb_build_object(
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
        'late', coalesce(c.created_at > r.closed_at, false),
        'lines', (select coalesce(jsonb_agg(jsonb_build_object('item_code', l.item_code, 'item_name', l.item_name,
                    'qty', l.qty, 'price', l.price, 'price_list', l.price_list) order by l.id), '[]'::jsonb)
                  from tandem.check_lines l where l.check_id = c.id)) order by c.no desc), '[]'::jsonb)
      from tandem.checks c where c.point_id = p_point and c.check_date = p_date))
  from r;
$function$
;

-- ---------------------------------------------------------------- касса: поздний чек (K1), цена без умолчания (K2)
-- Тела check_save и check_void — из канона (0042) с двумя правками.
-- K1 (owner Д1, kassa Д1): закрытая смена держит только чеки, вошедшие в закрытие (created_at не позже
--   closed_at). Чек, пробитый после закрытия, в закрытом отчёте не учтён — продавец, ошибившийся способом
--   оплаты, исправляет или отменяет его сам, без собственника. Пока смену не закрыли заново: повторное
--   закрытие ставит новый closed_at, чек входит в отчёт и дальше правится только после «Открыть смену
--   для исправления». Правило «чек старше двух дней — нельзя» не меняется.
-- K2 (admin 2): у точки со своими ценами (есть хоть одна строка item_prices) позиции без своей цены
--   цена по умолчанию не подставляется — ни в цену строки, ни в цену прейскуранта (price_list пуст, как
--   «цена не задана» в меню кассы; иначе себестоимость из iiko давала ложные «скидки» в отчётах).
CREATE OR REPLACE FUNCTION tandem.check_save(p_point text, payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'tandem', 'public'
AS $function$
declare
  v_uid    uuid;
  v_date   date := tandem.to_date(payload->>'date');
  v_pay    text := payload->>'pay_kind';
  v_chk    tandem.checks;
  v_id     bigint;
  v_bad    text;
  v_total  numeric;
  v_was    text;
  v_new    text;
  v_today  date := tandem.local_now()::date;   -- окно дат — по местному времени, не по часам сервера (UTC)
  v_closed timestamptz;   -- K1: закрытие смены, в которое вошёл этот чек (поздний чек — null)
  v_own    boolean;       -- K2: у точки загружены свои цены
begin
  begin v_uid := (payload->>'uid')::uuid; exception when others then v_uid := null; end;
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'У чека нет номера устройства (uid)'); end if;
  if v_pay is null or v_pay not in ('cash','kaspi_qr','transfer','card') then
    return jsonb_build_object('ok', false, 'error', 'Не выбран способ оплаты'); end if;
  if jsonb_typeof(payload->'lines') is distinct from 'array' or jsonb_array_length(payload->'lines') = 0 then
    return jsonb_build_object('ok', false, 'error', 'В чеке нет позиций'); end if;
  -- Числа строк — безопасным разбором: мусор вместо числа — отказ, а не исключение.
  if exists (select 1 from jsonb_array_elements(payload->'lines') x
              where not tandem.num_ok(x->>'qty') or not tandem.num_ok(x->>'price')
                 or coalesce(tandem.to_num(x->>'qty'), 0) <= 0 or coalesce(tandem.to_num(x->>'price'), 0) < 0) then
    return jsonb_build_object('ok', false, 'error', 'Количество должно быть больше нуля, цена — не меньше нуля'); end if;
  select string_agg(coalesce(x->>'item_code', '—'), ', ') into v_bad
    from jsonb_array_elements(payload->'lines') x
    left join tandem.items i on i.code = x->>'item_code' and i.active and i.for_sale
   where i.code is null;
  if v_bad is not null then
    return jsonb_build_object('ok', false, 'error', 'Позиции нет в продаже: ' || v_bad); end if;

  perform 1 from tandem.points where id = p_point for update;   -- нумерация чеков дня — по очереди
  v_own := exists (select 1 from tandem.item_prices where point_id = p_point);
  select * into v_chk from tandem.checks where uid = v_uid;
  if v_chk.id is not null and v_chk.point_id <> p_point then
    return jsonb_build_object('ok', false, 'error', 'Чек принадлежит другой точке'); end if;
  if v_chk.id is not null and v_chk.status = 'void' then
    return jsonb_build_object('ok', false, 'error', 'Чек отменён, исправить его нельзя'); end if;
  if v_chk.id is null then
    -- День чека присылает планшет; принимаем только соседние с местным сегодняшним. Новый чек в закрытую
    -- смену принимается: это опоздавшая досылка, продажа не должна теряться.
    if v_date is null or v_date < v_today - 2 or v_date > v_today + 1 then
      return jsonb_build_object('ok', false, 'error', 'Дата чека не похожа на сегодняшнюю — проверьте дату на планшете'); end if;
    insert into tandem.checks (uid, point_id, check_date, no, seller, pay_kind, first_pay_kind)
      values (v_uid, p_point, v_date,
              coalesce((select max(no) from tandem.checks where point_id = p_point and check_date = v_date), 0) + 1,
              left(nullif(btrim(coalesce(payload->>'seller','')), ''), 100), v_pay, v_pay)
      returning id into v_id;
  else
    v_id := v_chk.id; v_date := v_chk.check_date;
    -- «Исправлен» ставится, только если чек действительно изменился: досылка после обрыва связи — не правка.
    select v_chk.pay_kind || '|' || string_agg(item_code || ':' || qty::text || ':' || price::text, ',' order by id) into v_was
      from tandem.check_lines where check_id = v_id;
    -- Закрытую смену и старые дни чек уже не меняет: деньги и продажа такого дня сданы, иначе «пробил,
    -- взял наличные, исправил» прошло бы без следа задним числом. Досылка без изменений — проходит.
    -- K1: поздний чек (пробит после закрытия) закрытие не держит — в закрытом отчёте его нет.
    select closed_at into v_closed from tandem.daily_reports where point_id = p_point and report_date = v_date;
    if v_chk.created_at > v_closed then v_closed := null; end if;
    if v_closed is not null or v_date < v_today - 2 then
      select v_pay || '|' || string_agg(i.code || ':' || tandem.to_num(x->>'qty')::text || ':'
                                        || coalesce(tandem.to_num(x->>'price'), pp.price, case when not v_own then i.price end, 0)::text,
                                        ',' order by ord) into v_new
        from jsonb_array_elements(payload->'lines') with ordinality t(x, ord)
        join tandem.items i on i.code = x->>'item_code'
        left join tandem.item_prices pp on pp.item_code = i.code and pp.point_id = p_point;
      if v_new is not distinct from v_was then
        return jsonb_build_object('ok', true, 'check', (select jsonb_build_object('uid', uid, 'no', no, 'total', total,
                 'date', check_date, 'edited', edited) from tandem.checks where id = v_id));
      end if;
      -- Начало «Смена закрыта» / «Чек слишком старый» не менять: по нему касса узнаёт отказ правки (LOCKED).
      if v_closed is not null then
        return jsonb_build_object('ok', false, 'error', 'Смена закрыта — этот чек уже в закрытом отчёте. Исправить или отменить его можно, '
                                  || 'если собственник откроет смену: сводка по точкам → отчёт дня → «Открыть смену для исправления»'); end if;
      return jsonb_build_object('ok', false, 'error', 'Чек слишком старый — исправление через офис');
    end if;
    -- Чек, пробитый старой функцией во время миграции (first_* пусты), запоминает сумму и оплату до правки.
    update tandem.checks set first_total = coalesce(first_total, total), first_pay_kind = coalesce(first_pay_kind, pay_kind),
           pay_kind = v_pay, updated_at = now() where id = v_id;
    delete from tandem.check_lines where check_id = v_id;
  end if;

  -- K2: у точки со своими ценами цена по умолчанию (i.price) не подставляется — ни в цену, ни в прейскурант.
  insert into tandem.check_lines (check_id, item_code, item_name, qty, price, price_list)
    select v_id, i.code, i.name, tandem.to_num(x->>'qty'),
           coalesce(tandem.to_num(x->>'price'), pp.price, case when not v_own then i.price end, 0),
           case when v_own then pp.price else coalesce(pp.price, i.price) end
      from jsonb_array_elements(payload->'lines') with ordinality t(x, ord)
      join tandem.items i on i.code = x->>'item_code'
      left join tandem.item_prices pp on pp.item_code = i.code and pp.point_id = p_point
     order by ord;
  select coalesce(sum(round(qty * price, 2)), 0) into v_total from tandem.check_lines where check_id = v_id;
  -- first_total ставится первым сохранением и дальше не меняется (правка видна как «было → стало»).
  update tandem.checks set total = v_total, first_total = coalesce(first_total, v_total),
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
  v_uid    uuid;
  v_chk    tandem.checks;
  v_reason text := left(nullif(btrim(coalesce(payload->>'reason','')), ''), 500);
begin
  begin v_uid := (payload->>'uid')::uuid; exception when others then v_uid := null; end;
  -- Отмена без причины не принимается: собственник видит отмены в сводке, пустая причина там ничего не объясняет.
  if v_reason is null then return jsonb_build_object('ok', false, 'error', 'Укажите причину отмены'); end if;
  perform 1 from tandem.points where id = p_point for update;
  select * into v_chk from tandem.checks where uid = v_uid and point_id = p_point;
  if v_chk.id is null then return jsonb_build_object('ok', false, 'error', 'Чек не найден'); end if;
  if v_chk.status = 'active' then
    -- Как и правка: закрытую смену и старые дни отмена не переписывает. K1: поздний чек (пробит после
    -- закрытия) в закрытом отчёте не учтён — его отменить можно, пока смену не закрыли заново.
    if exists (select 1 from tandem.daily_reports where point_id = p_point and report_date = v_chk.check_date
                                                    and closed_at is not null and v_chk.created_at <= closed_at) then
      return jsonb_build_object('ok', false, 'error', 'Смена закрыта — этот чек уже в закрытом отчёте. Исправить или отменить его можно, '
                                || 'если собственник откроет смену: сводка по точкам → отчёт дня → «Открыть смену для исправления»'); end if;
    if v_chk.check_date < tandem.local_now()::date - 2 then
      return jsonb_build_object('ok', false, 'error', 'Чек слишком старый — исправление через офис'); end if;
    update tandem.checks set status = 'void', updated_at = now(), void_reason = v_reason where id = v_chk.id;
    perform tandem.check_apply(p_point, v_chk.check_date);
  end if;
  return jsonb_build_object('ok', true);
end $function$
;

-- ---------------------------------------------------------------- техкарты (Q, Q2)
CREATE OR REPLACE FUNCTION tandem.office_charts(action text, payload jsonb, v_user tandem.users)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'tandem', 'public'
AS $function$
declare
  v_code   text := payload->>'code';
  v_id     uuid := nullif(payload->>'id','')::uuid;
  v_date   date;
  v_q      text := btrim(coalesce(payload->>'q',''));
  v_page   int  := greatest(coalesce((payload->>'page')::int, 1), 1);
  v_only   text := nullif(payload->>'only','');
  v_group  uuid := nullif(payload->>'group_id','')::uuid;
  v_total  int; v_rows jsonb; v_type text; v_from date; v_to date; v_out numeric;
  v_prev   uuid; v_line jsonb; v_ing text; v_ing_type text; v_active boolean;
  v_chart  uuid; v_item jsonb; v_versions jsonb; v_lines jsonb; v_cost record;
  v_csv    text; v_limit numeric;
  -- Q: «где используется» — ингредиент по названию (каждое слово), коду или артикулу
  v_ing_q  text := btrim(coalesce(payload->>'ingredient',''));
  v_ing_w  text[];
  v_name   text; v_ing_name text; v_used int; v_left boolean;
begin
  -- 45/49: дата из payload — строго ГГГГ-ММ-ДД (tandem.chart_date). Разбирается здесь, а не в
  -- объявлениях: ошибку из объявлений обработчик функции не ловит, и наружу ушла бы голая 500.
  v_date := coalesce(tandem.chart_date(payload->>'date'), current_date);

  -- ---------- список ----------
  if action = 'charts_list' then
    v_limit := coalesce((select value::numeric from tandem.settings where key = 'foodcost_alert'), 35);
    v_ing_w := array(select w from regexp_split_to_table(lower(v_ing_q), '\s+') w where w <> '');
    with ing as (
      -- Q (tech6): «где используется». Ингредиент — по коду, артикулу (с ведущими нулями и без, как
      -- в отчётах iiko) или по названию: каждое слово запроса — в названии («триммер» найдёт
      -- «Мясо говядина триммер»). Пустой запрос — фильтра нет.
      select ii.code, ii.name from tandem.items ii
       where v_ing_q <> ''
         and (ii.code = v_ing_q or ii.artikul = v_ing_q
              or (v_ing_q ~ '^[0-9]+$' and ltrim(v_ing_q, '0') <> '' and ltrim(ii.artikul, '0') = ltrim(v_ing_q, '0'))
              or not exists (select 1 from unnest(v_ing_w) w where ii.name not ilike '%' || tandem.like_escape(w) || '%'))
    ),
    base as (
      select i.code, i.name, i.item_type, i.unit_id, g.name as group_name, i.price,
             tandem.active_chart(i.code, current_date) as chart_id
      from tandem.items i left join tandem.item_groups g on g.id = i.group_id
      where i.active and i.item_type in ('dish','prepared')
        and (v_q = '' or i.name ilike '%' || v_q || '%' or i.code = v_q)
        and (v_group is null or i.group_id = v_group)
        -- ингредиент ищется в действующей и будущих версиях карты: закрытая версия уже ничего не списывает
        and (v_ing_q = '' or exists (
              select 1 from tandem.charts c2 join tandem.chart_lines cl2 on cl2.chart_id = c2.id
               where c2.item_code = i.code and (c2.date_to is null or c2.date_to >= current_date)
                 and cl2.ingredient_code in (select code from ing)))
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
             'missing_count', coalesce((select count(*) from unnest(k.missing) m where m <> p.code), 0),
             -- Q (tech11): у карты есть версия, которая вступит в силу позже, — «есть версия с ДД.ММ»
             'next_from', (select min(c3.date_from) from tandem.charts c3 where c3.item_code = p.code and c3.date_from > current_date),
             -- при поиске «где используется» — какие из найденных ингредиентов стоят в карте (до 3)
             'ingredient_names', case when v_ing_q <> '' then (
                 select to_jsonb(array_agg(x.name order by x.name)) from (
                   select distinct ii.name from tandem.charts c4 join tandem.chart_lines cl4 on cl4.chart_id = c4.id
                     join tandem.items ii on ii.code = cl4.ingredient_code
                    where c4.item_code = p.code and (c4.date_to is null or c4.date_to >= current_date)
                      and ii.code in (select code from ing) order by ii.name limit 3) x) end)
             order by p.name), '[]'::jsonb)
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
    -- Q (tech3): from_iiko — карта пришла из iiko (iiko_id не пуст). source после правки в офисе
    -- становится 'office', а происхождение остаётся: chart_save iiko_id не трогает.
    select coalesce(jsonb_agg(jsonb_build_object('id', id, 'date_from', date_from, 'date_to', date_to,
             'source', source, 'from_iiko', iiko_id is not null) order by date_from desc), '[]'::jsonb)
      into v_versions from tandem.charts where item_code = v_code;
    if v_chart is null then
      return jsonb_build_object('ok', true, 'item', v_item, 'chart', null::jsonb,
        'cost', null::numeric, 'partial', null::numeric,
        'missing', to_jsonb(array[v_code]), 'missing_names', to_jsonb(tandem.missing_names(array[v_code])),
        'missing_text', tandem.missing_text(array[v_code]), 'versions', v_versions);
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
                  'source', c.source, 'from_iiko', c.iiko_id is not null, 'lines', v_lines)
                from tandem.charts c where c.id = v_chart),
      'cost', v_cost.cost, 'partial', v_cost.partial, 'missing', to_jsonb(v_cost.missing),
      'missing_names', to_jsonb(v_cost.missing_names), 'missing_text', tandem.missing_text(v_cost.missing),
      'versions', v_versions);
  end if;

  -- ---------- сохранение ----------
  if action = 'chart_save' then
    select item_type into v_type from tandem.items where code = v_code and active;
    if v_type is null then return tandem.err('not_found', 'Позиция не найдена или выключена'); end if;
    if v_type not in ('dish','prepared') then
      return tandem.err('validation', 'Техкарта бывает только у блюда или полуфабриката');
    end if;
    v_from := tandem.chart_date(payload->>'date_from');
    v_to   := tandem.chart_date(payload->>'date_to');
    v_out  := nullif(payload->>'output_amount','')::numeric;
    if v_from is null then return tandem.err('validation', 'Укажите дату начала действия'); end if;
    if v_to is not null and v_to < v_from then return tandem.err('validation', 'Дата окончания раньше начала'); end if;
    if v_out is null or v_out <= 0 then return tandem.err('validation', 'Выход должен быть больше нуля'); end if;
    if jsonb_typeof(payload->'lines') <> 'array' or jsonb_array_length(payload->'lines') = 0 then
      return tandem.err('validation', 'В карте нет ни одной строки');
    end if;
    -- строки: ингредиент существует, активен, не само блюдо, не ведёт обратно к блюду.
    -- 46: цикл ищется на весь период карты [v_from, v_to], а не только на дату начала: версия ПФ,
    -- вступающая в силу позже, может замкнуть круг уже внутри периода.
    -- Q2 (tech10): в текстах — названия позиций, а не коды: «Нетто больше брутто в строке 56» человеку
    -- ничего не говорит.
    select name into v_name from tandem.items where code = v_code;
    for v_line in select * from jsonb_array_elements(payload->'lines') loop
      v_ing := v_line->>'ingredient_code';
      v_ing_type := null;
      select item_type, active, name into v_ing_type, v_active, v_ing_name from tandem.items where code = v_ing;
      if v_ing_type is null then return tandem.err('validation', 'Ингредиент не найден в справочнике (код ' || coalesce(v_ing,'—') || ') — обновите страницу'); end if;
      if not v_active then return tandem.err('validation', 'Ингредиент «' || v_ing_name || '» выключен — включите его в номенклатуре или уберите из карты'); end if;
      if v_ing = v_code then return tandem.err('validation', 'Блюдо не может входить само в себя'); end if;
      if v_ing_type in ('dish','prepared') and tandem.chart_reaches_during(v_ing, v_code, v_from, v_to) then
        return tandem.err('validation', 'Цикл: «' || v_ing_name || '» уже содержит «' || v_name || '»');
      end if;
      if coalesce((v_line->>'brutto')::numeric, -1) < 0 or coalesce((v_line->>'netto')::numeric, -1) < 0
         or coalesce((v_line->>'output')::numeric, -1) < 0 then
        return tandem.err('validation', 'Брутто, нетто и выход у «' || v_ing_name || '» должны быть числами не меньше нуля');
      end if;
      if (v_line->>'netto')::numeric > (v_line->>'brutto')::numeric then
        return tandem.err('validation', 'Нетто больше брутто у «' || v_ing_name || '»');
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
    v_from := tandem.chart_date(payload->>'date_from');
    if v_from is null then return tandem.err('validation', 'Укажите дату начала новой версии'); end if;
    v_prev := tandem.active_chart(v_code, v_from - 1);
    if v_prev is null then
      return tandem.err('validation', 'Нет действующей карты, которую можно продолжить — создайте карту обычным сохранением');
    end if;
    if exists (select 1 from tandem.charts where item_code = v_code and date_from >= v_from) then
      return tandem.err('validation', 'Уже есть версия с более поздней датой начала');
    end if;
    -- 46: новая версия продлевает состав прежней на [v_from, ∞) — если прежняя была закрыта раньше,
    -- это новый для неё период, и цикл проверяется на нём так же, как при сохранении
    for v_ing in select cl.ingredient_code from tandem.chart_lines cl join tandem.items i on i.code = cl.ingredient_code
                  where cl.chart_id = v_prev and i.item_type in ('dish','prepared') loop
      if tandem.chart_reaches_during(v_ing, v_code, v_from, null) then
        return tandem.err('validation', 'Цикл: «' || (select name from tandem.items where code = v_ing)
                                        || '» уже содержит «' || (select name from tandem.items where code = v_code) || '»');
      end if;
    end loop;
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
    select name into v_name from tandem.items where code = v_code;
    -- Q (tech3): в скольких картах других блюд стоит эта позиция (полуфабрикат) — в действующих и будущих
    -- версиях у включённых блюд, как считает «Готовность» (quality_report, «стоит в N карт.»).
    select count(distinct c.item_code) into v_used
      from tandem.chart_lines cl
      join tandem.charts c on c.id = cl.chart_id and c.item_code <> v_code and (c.date_to is null or c.date_to >= current_date)
      join tandem.items d on d.code = c.item_code and d.active
     where cl.ingredient_code = v_code;
    -- Единственная версия: без неё блюдо остаётся без карты, и продажа молча списывает само блюдо
    -- (так одним подтверждением терялась правленная карта «Манты» из iiko).
    if not exists (select 1 from tandem.charts where item_code = v_code and id <> v_id) then
      return tandem.err('validation', 'Это единственная версия карты: блюдо останется без техкарты, и продажи будут списывать само блюдо. Закройте карту датой или замените новой версией'
        || case when v_used > 0 then '. «' || v_name || '» стоит в картах других блюд (' || v_used || ') — у них тоже перестанет считаться себестоимость' else '' end);
    end if;
    -- Останется ли действующая карта: прежняя версия, закрытая днём раньше этой, снова откроется
    -- (см. ниже); иначе — другая версия, которая действует сегодня или позже.
    v_left := exists (select 1 from tandem.charts where item_code = v_code and id <> v_id
                       and (date_to = v_from - 1 or date_to is null or date_to >= current_date));
    if v_used > 0 and not v_left then
      return tandem.err('validation', 'После удаления у «' || v_name || '» не останется действующей техкарты, а «' || v_name
        || '» стоит в картах других блюд (' || v_used || '): их продажи будут списывать «' || v_name
        || '» как есть, себестоимость перестанет считаться. Закройте карту датой или замените новой версией');
    end if;
    -- 46: предыдущая версия ниже снова открывается — на [v_from, ∞) её состав не должен замыкать круг
    select id into v_prev from tandem.charts where item_code = v_code and date_to = v_from - 1;
    for v_ing in select cl.ingredient_code from tandem.chart_lines cl join tandem.items i on i.code = cl.ingredient_code
                  where cl.chart_id = v_prev and i.item_type in ('dish','prepared') loop
      if tandem.chart_reaches_during(v_ing, v_code, v_from, null) then
        return tandem.err('validation', 'Цикл: после удаления снова действовала бы прежняя версия, а «'
          || (select name from tandem.items where code = v_ing) || '» уже содержит «' || v_name || '»');
      end if;
    end loop;
    delete from tandem.charts where id = v_id;
    -- предыдущая версия, закрытая ради удалённой, снова становится открытой
    update tandem.charts set date_to = null where item_code = v_code and date_to = v_from - 1
      and not exists (select 1 from tandem.charts c2 where c2.item_code = v_code and c2.date_from > v_from - 1);
    return jsonb_build_object('ok', true);
  end if;

  -- ---------- отчёт ----------
  if action = 'foodcost_report' then
    v_limit := coalesce((select value::numeric from tandem.settings where key = 'foodcost_alert'), 35);
    -- Q2 (tech9): заголовки CSV — по-русски, в последней колонке — названия того, без чего себестоимость
    -- не считается (раньше — коды). Строки rows несут и missing, и missing_names (to_jsonb строки).
    select coalesce(jsonb_agg(to_jsonb(m)), '[]'::jsonb),
           'Код;Название;Группа;Ед.;Себестоимость;Цена;Наценка, %;Фудкост, %;Выше порога;Нет цены или техкарты' || E'\n' ||
           coalesce(string_agg(concat_ws(';', m.code, replace(m.name,';',','),
             coalesce(replace(m.group_name,';',','),''), m.unit_id,
             -- 74: десятичная запятая — как в остальных выгрузках; русский Excel с «;» читает
             -- «28.6» как дату или текст
             coalesce(replace(m.cost::text, '.', ','), ''), coalesce(replace(m.price::text, '.', ','), ''),
             coalesce(replace(m.markup_pct::text, '.', ','), ''),
             coalesce(replace(m.foodcost_pct::text, '.', ','), ''), case when m.over_limit then 'да' else '' end,
             -- V26: через « | », как и прежние коды: так ячейка не похожа на число ни при каких названиях
             replace(array_to_string(m.missing_names, ' | '), ';', ',')), E'\n'), '')
      into v_rows, v_csv
      from tandem.menu_foodcost(nullif(payload->>'point_id',''), v_date, v_group) m;
    return jsonb_build_object('ok', true, 'rows', v_rows, 'limit', v_limit, 'csv', v_csv);
  end if;

  return tandem.err('unknown_action', 'Неизвестное действие: ' || action);
exception
  -- charts_no_overlap ловится проверкой выше; сюда доходят только гонки двух правок разом.
  when exclusion_violation then
    return tandem.err('validation', 'На эти даты уже действует другая версия этой карты');
  when invalid_datetime_format or datetime_field_overflow then
    return tandem.err('validation', 'Дата — в формате ГГГГ-ММ-ДД');
end $function$
;

-- ---------------------------------------------------------------- контрагенты (V)
CREATE OR REPLACE FUNCTION tandem.office_counteragents(action text, payload jsonb, v_user tandem.users)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'tandem', 'public'
AS $function$
declare
  v_id uuid; v_name text; v_kind text; v_bin text;
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
    -- V (buh): БИН/ИИН в Казахстане — ровно 12 цифр; 11 цифр сохранялись молча и всплыли бы в печатной
    -- накладной и выгрузке. Пробелы, набранные для удобства («1234 5678 9012»), убираются; пусто — без БИН.
    v_bin := nullif(regexp_replace(coalesce(payload->>'bin', ''), '[[:space:]' || chr(160) || ']', '', 'g'), '');
    if v_bin is not null and v_bin !~ '^[0-9]{12}$' then
      return tandem.err('validation', 'БИН/ИИН — 12 цифр');
    end if;
    v_id := nullif(payload->>'id','')::uuid;
    if v_id is null then
      insert into tandem.counteragents (name, kind, bin, phone, note, active)
        values (v_name, v_kind, v_bin, nullif(payload->>'phone',''),
                payload->>'note', coalesce((payload->>'active')::boolean, true)) returning id into v_id;
    else
      update tandem.counteragents set name = v_name, kind = v_kind,
        bin = case when payload ? 'bin' then v_bin else bin end,
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

-- ---------------------------------------------------------------- номенклатура (E, E2, Q2)
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
  v_old   text;
  v_item  tandem.items;
  k       record;   -- себестоимость позиции: (cost, partial, missing, missing_names)
  v_limit int;      -- items_search: строк на странице
  v_words text[];   -- items_search: слова запроса
  v_types text[];   -- items_search: типы позиций
  v_store uuid;     -- items_search: склад, остаток на котором отдаётся в stock_qty (S6-1)
begin
  -- Себестоимость отдельным действием: карточка товара обходится без пересчёта дерева,
  -- а экран техкарт спрашивает цену ингредиента точечно.
  if action = 'item_cost_get' then
    v_code := payload->>'code';
    if not exists (select 1 from tandem.items where code = v_code) then
      return tandem.err('not_found', 'Позиция не найдена');
    end if;
    -- 49: дата — строго ГГГГ-ММ-ДД, как в разделе техкарт (неверная ловится в конце функции)
    select * into k from tandem.item_cost(v_code, coalesce(tandem.chart_date(payload->>'date'), current_date));
    -- E2: откуда учётная цена (source_doc) и последние приходы (price_history); Q2: названия вместо кодов
    return jsonb_build_object('ok', true, 'cost', k.cost, 'partial', k.partial, 'missing', to_jsonb(k.missing),
      'missing_names', to_jsonb(k.missing_names), 'missing_text', tandem.missing_text(k.missing))
      || tandem.item_price_origin(v_code);
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
      select name into v_old from tandem.item_groups where id = v_id;
      -- V13: имя, которым уже помечены позиции другой группы, добавилось бы в фильтры точек этой —
      -- и им открылись бы чужие позиции. Сохранение без смены имени (имена групп повторяются) не держим.
      if found and v_old is distinct from v_name and tandem.group_name_taken(v_id, v_name) then
        return tandem.err('validation', 'Такое имя уже у другой группы — точкам открылись бы её позиции. Выберите другое');
      end if;
      update tandem.item_groups set name = v_name,
        parent_id = nullif(payload->>'parent_id','')::uuid,
        active = coalesce((payload->>'active')::boolean, active)
        where id = v_id;
      if not found then return tandem.err('not_found', 'Группа не найдена'); end if;
      -- 42: в той же транзакции новое имя уходит в category позиций группы и фильтры точек
      if v_old is distinct from v_name then perform tandem.group_rename_sync(v_id, v_old, v_name); end if;
    end if;
    return jsonb_build_object('ok', true, 'id', v_id);
  end if;

  if action = 'items_search' then
    -- E (sklad6, buh): поиск как в iiko. «творог» в приходе показывал 12 блинов по алфавиту, а
    -- «Молочка Творог» не находилась; «мясо гов» не находило «Мясо говядина триммер» одним куском.
    --  * types — массив типов (приход — только товары); пусто — все; прежний item_type тоже работает;
    --  * несколько слов — каждое должно найтись в названии или артикуле (в любом порядке);
    --  * порядок: точное совпадение названия/артикула/кода → название начинается с запроса → каждое
    --    слово запроса — начало какого-то слова названия → остальное; внутри — по алфавиту;
    --  * limit — до 200 (выпадающему поиску хватает 30), по умолчанию 200, как было.
    -- Слова названия режутся по всему, что не буква и не цифра (кириллица, казахские буквы, латиница):
    -- явным списком обоих регистров, а не классом [[:alnum:]] — тот зависит от локали базы.
    v_limit := least(greatest(coalesce(nullif(payload->>'limit','')::int, 200), 1), 200);
    v_words := array(select w from regexp_split_to_table(lower(v_q), '\s+') w where w <> '');
    v_types := case jsonb_typeof(payload->'types')
                 when 'array'  then array(select jsonb_array_elements_text(payload->'types'))
                 when 'string' then array[payload->>'types'] end;
    if cardinality(v_types) = 0 then v_types := null; end if;
    -- S6-1 (sklad 12): store_id — склад-отправитель перемещения или списания. У строк — stock_qty
    -- (остаток на этом складе; null, если строки остатка нет), позиции с остатком > 0 — выше, но после
    -- точного совпадения: «беляш без остатка я выбрал вслепую». Без store_id — как раньше: ключа
    -- stock_qty нет, порядок прежний. Остаток — это раздел «Склад», а поиск — раздел «Номенклатура»:
    -- без права «склад: просмотр» или без доступа к этому складу (user_store_ok) поиск идёт как без
    -- store_id, а не падает — выпадающий поиск в документе должен работать всегда.
    v_store := nullif(payload->>'store_id', '')::uuid;
    if v_store is not null and not (tandem.office_can(v_user.role, 'stock', 'view')
                                    and tandem.user_store_ok(v_user.id, v_store)) then
      v_store := null;
    end if;
    with f as (
      select i.code, i.name, i.artikul, i.item_type, i.unit_id, i.group_id, i.active, i.for_sale, i.price,
             sb.qty as stock_qty,
             case when v_q = '' then 3
                  when lower(i.name) = lower(v_q) or lower(coalesce(i.artikul, '')) = lower(v_q) or i.code = v_q then 0
                  when i.name ilike tandem.like_escape(v_q) || '%' then 1
                  when not exists (select 1 from unnest(v_words) w where not exists (
                         select 1 from regexp_split_to_table(lower(i.name), '[^0-9a-zA-Zа-яА-ЯёЁәӘғҒқҚңҢөӨұҰүҮһҺіІ]+') nw
                          where nw like tandem.like_escape(w) || '%')) then 2
                  else 3 end as rk
      from tandem.items i
      -- по ключу (store_id, item_code); без склада соединение не выполняется вовсе
      left join tandem.stock_balances sb on v_store is not null and sb.store_id = v_store and sb.item_code = i.code
      where (v_q = '' or i.code = v_q
             or not exists (select 1 from unnest(v_words) w
                             where not (i.name ilike '%' || tandem.like_escape(w) || '%'
                                        or coalesce(i.artikul, '') ilike '%' || tandem.like_escape(w) || '%')))
        and (nullif(payload->>'group_id','') is null or i.group_id = (payload->>'group_id')::uuid)
        and (nullif(payload->>'item_type','') is null or i.item_type = payload->>'item_type')
        and (v_types is null or i.item_type = any(v_types))
        and (payload->>'active' is null or i.active = (payload->>'active')::boolean)
        and (payload->>'for_sale' is null or i.for_sale = (payload->>'for_sale')::boolean)
    ),
    -- Порядок: точное совпадение → с остатком > 0 (только со складом) → прежний (rk, название, код).
    -- Без склада stock_qty у всех null — второй ключ одинаков, и порядок совпадает с прежним.
    pg as (select * from f order by rk > 0, (stock_qty > 0) is not true, rk, name, code
                           limit v_limit offset (v_page - 1) * v_limit),
    -- Цена последнего проведённого прихода (любой поставщик) — подсказка цены в новой накладной.
    -- Одним проходом по строкам приходов для всей страницы, а не запросом на каждую строку. Нулевая
    -- (бонусная) строка ценой не считается — как и для учётной цены. K3 (tech 1): приходы на учебные
    -- склады — тоже: подсказка цены в настоящей накладной не должна брать учебную. Склад — left join
    -- с «training is not true», а не not exists: на анти-соединении планировщик ждал одну строку и
    -- уходил во вложенный цикл (замер на 60 тыс. строк приходов: 0,55 с вместо 0,02 с).
    lp as (
      select distinct on (dl.item_code) dl.item_code, dl.price, d.doc_date
        from tandem.document_lines dl
        join tandem.documents d on d.id = dl.document_id and d.doc_type = 'invoice_in' and d.status = 'posted'
        left join tandem.stores st on st.id = d.store_to
       where dl.line_kind = 'item' and dl.price > 0 and dl.item_code in (select code from pg)
         and st.training is not true
       order by dl.item_code, d.doc_date desc, d.posted_at desc nulls last
    )
    select (select count(*) from f),
           (select coalesce(jsonb_agg(jsonb_build_object('code', pg.code, 'name', pg.name, 'artikul', pg.artikul,
                     'item_type', pg.item_type, 'unit_id', pg.unit_id, 'group_id', pg.group_id, 'group_name', g.name,
                     'active', pg.active, 'for_sale', pg.for_sale, 'price', pg.price,
                     'last_price', lp.price, 'last_price_date', lp.doc_date)
                     || case when v_store is not null then jsonb_build_object('stock_qty', pg.stock_qty) else '{}'::jsonb end
                     order by pg.rk > 0, (pg.stock_qty > 0) is not true, pg.rk, pg.name, pg.code), '[]'::jsonb)
              from pg left join tandem.item_groups g on g.id = pg.group_id
              left join lp on lp.item_code = pg.code)
      into v_total, v_rows;
    return jsonb_build_object('ok', true, 'rows', v_rows, 'total', v_total, 'page', v_page,
                              'pages', greatest(ceil(v_total / v_limit::numeric)::int, 1));
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
      'cost', k.cost, 'partial', k.partial, 'missing', to_jsonb(k.missing),
      'missing_names', to_jsonb(k.missing_names), 'missing_text', tandem.missing_text(k.missing))
      -- E2: карточка открывается через item_get — происхождение цены приходит сразу, без второго запроса
      || tandem.item_price_origin(v_code);
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
      select * into v_item from tandem.items where code = v_code;
      if not found then return tandem.err('not_found', 'Позиция не найдена'); end if;
      -- 44: единица — мера всех чисел позиции: остатков и средней на складе, строк документов, норм
      -- закладки в чужих техкартах и выхода своей. Смена без пересчёта молча превращала «300 шт по 60 ₸»
      -- в «300 кг по 60 ₸», поэтому единицу меняет только позиция без истории.
      if nullif(payload->>'unit_id','') is not null and payload->>'unit_id' <> v_item.unit_id
         and (exists (select 1 from tandem.stock_moves where item_code = v_code)
              or exists (select 1 from tandem.document_lines where item_code = v_code)
              or exists (select 1 from tandem.chart_lines where ingredient_code = v_code)
              or exists (select 1 from tandem.charts where item_code = v_code)) then
        return tandem.err('validation', 'Единицу нельзя сменить: по позиции есть движения, документы или техкарты');
      end if;
      -- Товар считается и списывается по учётной цене, блюдо и полуфабрикат — по техкарте: при
      -- движениях склада смена между ними переписала бы смысл уже проведённого.
      -- V14: блюдо/полуфабрикат без единой версии карты списывался и так сам, как товар, — смена на
      -- «товар» ничего не переписывает (это и советует отчёт качества «Вода ПФ»). Любая версия карты,
      -- даже закрытая, держит: по ней раскладывалось проведённое.
      if nullif(payload->>'item_type','') is not null
         and payload->>'item_type' in ('goods','dish','prepared') and v_item.item_type in ('goods','dish','prepared')
         and (payload->>'item_type' = 'goods') <> (v_item.item_type = 'goods')
         and exists (select 1 from tandem.stock_moves where item_code = v_code)
         and (payload->>'item_type' <> 'goods' or exists (select 1 from tandem.charts where item_code = v_code)) then
        return tandem.err('validation', case when payload->>'item_type' = 'goods'
          then 'Тип нельзя сменить на товар: у позиции есть техкарта и движения склада'
          else 'Тип нельзя сменить между товаром и блюдом/полуфабрикатом: по позиции есть движения склада' end);
      end if;
      -- I8: source='office' закрывает строку от повторного переноса из iiko (см. tandem_migrate),
      -- category держится в согласии с группой — на неё смотрят старые экраны точек.
      -- cost_price правится только когда ключ пришёл: пустое значение снимает цену вместе с датой
      -- и источником, иначе учётная цена молча воскресала бы при любой правке карточки.
      -- 76: artikul и group_id так же — ключ пришёл, значит применяется (пустое снимает артикул и
      -- группу); раньше пустое молча оставляло прежнее, а карточка показывала «Сохранено».
      update tandem.items set
        name = coalesce(nullif(v_name, ''), name),
        artikul = case when payload ? 'artikul' then nullif(payload->>'artikul','') else artikul end,
        item_type = coalesce(nullif(payload->>'item_type',''), item_type),
        unit_id = coalesce(nullif(payload->>'unit_id',''), unit_id),
        unit = coalesce(nullif(payload->>'unit_id',''), unit),
        -- шаг ввода следует за единицей, как при создании (сменить её можно только у позиции без истории)
        step = case when nullif(payload->>'unit_id','') is not null and payload->>'unit_id' <> unit_id
                    then case when payload->>'unit_id' in ('кг','л') then 0.5 else 1 end else step end,
        group_id = case when payload ? 'group_id' then nullif(payload->>'group_id','')::uuid else group_id end,
        category = case when payload ? 'group_id'
                        then (select g.name from tandem.item_groups g where g.id = nullif(payload->>'group_id','')::uuid)
                        else coalesce((select g.name from tandem.item_groups g where g.id = items.group_id), items.category) end,
        source = 'office',
        active = coalesce((payload->>'active')::boolean, active),
        for_sale = coalesce((payload->>'for_sale')::boolean, for_sale),
        note = coalesce(payload->>'note', note),
        -- Цена по умолчанию правится только когда ключ пришёл: пустое значение её снимает.
        price = case when payload ? 'price' then nullif(payload->>'price','')::numeric else price end,
        pack_factor = case when payload ? 'pack_factor' then nullif(payload->>'pack_factor','')::numeric else pack_factor end,
        pack_unit   = case when payload ? 'pack_unit'   then nullif(payload->>'pack_unit','')            else pack_unit end,
        pack_price  = case when payload ? 'pack_price'  then nullif(payload->>'pack_price','')::numeric  else pack_price end,
        -- 72: карточка шлёт cost_price при любом сохранении; цена, равная текущей, не делает её
        -- «ручной» с сегодняшней датой — иначе терялось, откуда она (накладная, iiko), и перенос
        -- цен из iiko переставал её обновлять
        cost_price  = case when payload ? 'cost_price'  then nullif(payload->>'cost_price','')::numeric  else cost_price end,
        cost_date   = case when payload ? 'cost_price' and nullif(payload->>'cost_price','')::numeric is distinct from cost_price
                           then case when nullif(payload->>'cost_price','') is null then null else current_date end
                           else cost_date end,
        cost_source = case when payload ? 'cost_price' and nullif(payload->>'cost_price','')::numeric is distinct from cost_price
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

  -- Загрузка цен из «Сводного прейскуранта» iiko кнопкой в бэк-офисе (раньше — скрипт со служебным
  -- ключом). Разбор Excel и выбор точек для каждого подразделения — в браузере; сюда приходят строки
  -- {pt: точка, a: артикул, p: цена}. Пара — по артикулу позиции; цена точки перезаписывается.
  if action = 'item_prices_import' then
    if jsonb_typeof(payload->'rows') is distinct from 'array' then
      return tandem.err('validation', 'Нет строк цен'); end if;
    if exists (select 1 from jsonb_array_elements(payload->'rows') x
                where not exists (select 1 from tandem.points p where p.id = x->>'pt' and p.id not like 'zz\_%')) then
      return tandem.err('validation', 'В строках есть неизвестная точка'); end if;
    declare
      v_loaded int; v_unm int; v_sample jsonb;
    begin
      create temp table if not exists _price_in (point_id text, artikul text, price numeric) on commit drop;
      truncate _price_in;
      insert into _price_in select x->>'pt', btrim(x->>'a'), (x->>'p')::numeric
        from jsonb_array_elements(payload->'rows') x
       where (x->>'p')::numeric > 0 and nullif(btrim(x->>'a'), '') is not null;
      with matched as (
        select distinct on (n.point_id, i.code) n.point_id, i.code, n.price
          from _price_in n join tandem.items i on i.artikul = n.artikul and i.active
         order by n.point_id, i.code
      ), done as (
        insert into tandem.item_prices (point_id, item_code, price, source)
        select point_id, code, price, 'pricelist' from matched
        on conflict (point_id, item_code) do update set price = excluded.price, source = excluded.source
        returning 1
      ) select count(*) into v_loaded from done;
      select count(distinct artikul) into v_unm from _price_in n
       where not exists (select 1 from tandem.items i where i.artikul = n.artikul and i.active);
      select coalesce(jsonb_agg(a), '[]'::jsonb) into v_sample from (select distinct n.artikul a from _price_in n
       where not exists (select 1 from tandem.items i where i.artikul = n.artikul and i.active) order by 1 limit 20) s;
      return jsonb_build_object('ok', true, 'loaded', v_loaded, 'unmatched', v_unm, 'unmatched_sample', v_sample);
    end;
  end if;

  return tandem.err('unknown_action', 'Неизвестное действие: ' || action);
exception
  when invalid_datetime_format then   -- tandem.chart_date в item_cost_get
    return tandem.err('validation', 'Дата — в формате ГГГГ-ММ-ДД');
end $function$
;

-- ---------------------------------------------------------------- пользователи (U)
CREATE OR REPLACE FUNCTION tandem.office_users(action text, payload jsonb, v_user tandem.users)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'tandem', 'public', 'extensions'
AS $function$
declare
  v_id uuid; v_login text; v_name text; v_role text; v_pin text;
begin
  if action = 'users_list' then
    -- store_ids — все привязки, в том числе к выключенным складам: форма показывает их и отправляет обратно.
    return jsonb_build_object('ok', true,
      'users', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'login', login, 'name', name, 'role', role,
                  'active', active, 'must_change_pin', must_change_pin, 'created_at', created_at,
                  'store_ids', tandem.user_store_ids(id))
                  order by active desc, name), '[]'::jsonb) from tandem.users),
      'roles', jsonb_build_array('admin','owner','accountant','technologist','storekeeper'),
      -- U: может ли смотрящий заводить и менять администраторов (форма прячет роль «admin» и кнопки)
      'can_manage_admins', v_user.role = 'admin');
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
    -- U (owner9): раздел «Пользователи» теперь и у собственника — заводить сотрудников и сбрасывать им PIN.
    -- Администратора он не создаёт (и не делает им никого, в том числе себя), а чужую учётную запись
    -- администратора не меняет и не выключает: иначе право на раздел стало бы правом на всю систему.
    if v_user.role <> 'admin'
       and (v_role = 'admin'
            or exists (select 1 from tandem.users where id = nullif(payload->>'id','')::uuid and role = 'admin')) then
      return tandem.err('forbidden', 'Учётные записи администратора меняет только администратор');
    end if;
    -- Склады пользователя меняются, только если ключ пришёл: пустой массив снимает привязку (все склады).
    -- Проверяются до записи: отказ после сохранения оставлял пользователя созданным, а повтор упирался
    -- в «Такой логин уже есть».
    if payload ? 'store_ids' then
      if jsonb_typeof(payload->'store_ids') is distinct from 'array' then
        return tandem.err('validation', 'Склады — списком'); end if;
      if exists (select 1 from jsonb_array_elements_text(payload->'store_ids') x
                  where not exists (select 1 from tandem.stores s where s.id::text = lower(btrim(x)))) then
        return tandem.err('validation', 'Склад не найден — обновите страницу'); end if;
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
    if payload ? 'store_ids' then
      delete from tandem.user_stores where user_id = v_id;
      insert into tandem.user_stores (user_id, store_id)
        select v_id, lower(btrim(x))::uuid from jsonb_array_elements_text(payload->'store_ids') x
        on conflict do nothing;
    end if;
    return jsonb_build_object('ok', true, 'id', v_id);
  end if;

  if action = 'user_reset_pin' then
    v_id := nullif(payload->>'id','')::uuid;
    v_pin := coalesce(payload->>'pin','');
    -- U: сбросить PIN администратору — значит войти под ним; это может только администратор
    if v_user.role <> 'admin' and exists (select 1 from tandem.users where id = v_id and role = 'admin') then
      return tandem.err('forbidden', 'Учётные записи администратора меняет только администратор');
    end if;
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

-- ---------------------------------------------------------------- точки, касса, сводка собственника (P)
-- jit = off: сводка собственника — один большой запрос из десятка подзапросов; на объёме в несколько
-- месяцев его оценка переходит порог JIT, и Postgres тратит на компиляцию больше, чем на сам расчёт
-- (замер: 30 точек × 60 дней — 3,0 с, из них 1,7 с компиляция; без JIT — 0,7 с). Остальным
-- действиям точки и кассы JIT не нужен тем более.
CREATE OR REPLACE FUNCTION public.tandem_api(action text, payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'tandem', 'public'
 SET jit TO 'off'
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
  v_today      date := tandem.local_now()::date;   -- местная дата (UTC+5): «сегодня» и «вчера» точек и сводки
  v_exp        jsonb;
  v_tko        jsonb;
  v_sal        jsonb;
  v_lbl        text;
  v_val        text;
  v_prev_id    bigint;        -- save_report: строка отчёта до сохранения
  v_prev_first timestamptz;   -- save_report: первая сдача до этого сохранения
  v_before     jsonb;         -- save_report: содержимое отчёта до сохранения
  v_own        boolean;       -- items: у точки загружены свои цены (K2)
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

  if action in ('items','get_report','save_report','aliases','check_save','check_void','check_list','order_get','order_save') then
    if v_pin is distinct from v_owner_pin
       and not exists (select 1 from tandem.points where id = v_point and pin = v_pin and active) then
      return jsonb_build_object('ok', false, 'error', 'Нет доступа');
    end if;
  end if;

  if action = 'items' then
    select item_scopes, item_categories into v_scopes, v_cats
      from tandem.points where id = v_point;
    -- K2 (admin 2): у точки со своими ценами (загружен прейскурант — есть хоть одна строка item_prices)
    -- позиция без своей цены идёт с price = null — касса и экран точки пишут «цена не задана». Цена по
    -- умолчанию из номенклатуры там часто себестоимость из iiko («Блин с творогом фабрика 40,58 ₸»).
    -- У точки без своих цен — по-прежнему цена по умолчанию.
    v_own := exists (select 1 from tandem.item_prices where point_id = v_point);
    return jsonb_build_object('ok', true, 'items', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'code', code, 'name', name, 'category', category, 'unit', unit,
        'price', price, 'artikul', artikul, 'iiko_code', iiko_code,
        'rank', rank, 'short', short, 'has_chart', has_chart,
        'pack_factor', pack_factor, 'pack_unit', pack_unit, 'pack_price', pack_price)
        order by category, name), '[]'::jsonb)
      from (
        select i.code, i.name, i.category, i.unit,
               case when v_own then pp.price else coalesce(pp.price, i.price) end as price,
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
    v_date := tandem.to_date(payload->>'date');
    if v_date is null then return jsonb_build_object('ok', false, 'error', 'Неверная дата отчёта'); end if;
    select to_jsonb(v) into v_res from tandem.v_daily v
      where v.point_id = v_point and v.report_date = v_date;
    if v_res is null then
      return jsonb_build_object('ok', true, 'report', null, 'expenses','[]'::jsonb,
                                'takeout','[]'::jsonb, 'sales','[]'::jsonb, 'voids','[]'::jsonb);
    end if;
    select id into v_id from tandem.daily_reports
      where point_id = v_point and report_date = v_date;
    -- P/Д1, K1: чеки после закрытия смены (late_checks, late_sum, late_cash, late_kaspi, late_card,
    -- late_transfer) и отметка правки отчёта (edited_at) — экран закрытия смены считает «должно» на момент
    -- закрытия и показывает «после закрытия пробито N чеков — закройте смену заново»
    v_res := v_res || coalesce(tandem.report_marks(v_id), '{}'::jsonb);
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
        from tandem.sale_lines where report_id = v_id),
      -- Отменённые и исправленные чеки дня (касса): кто, когда, на сколько и почему. first_total и
      -- first_pay_kind — как чек был пробит впервые (было → стало); edited — правили ли и отменённый чек.
      'voids', (select coalesce(jsonb_agg(jsonb_build_object(
          'kind', case when c.status = 'void' then 'void' else 'edited' end, 'no', c.no, 'total', c.total,
          'pay_kind', c.pay_kind, 'first_total', coalesce(c.first_total, c.total),
          'first_pay_kind', coalesce(c.first_pay_kind, c.pay_kind), 'edited', c.edited,
          'reason', c.void_reason, 'seller', c.seller, 'at', c.updated_at)
          order by c.updated_at desc), '[]'::jsonb)
        from tandem.checks c
        where c.point_id = v_point and c.check_date = v_date and (c.status = 'void' or c.edited)));
  end if;

  if action = 'save_report' then
    -- Всё, что может отказать, проверяется до записи; ни одно присланное поле не роняет функцию исключением.
    v_date := tandem.to_date(payload->>'date');
    if v_date is null then return jsonb_build_object('ok', false, 'error', 'Не указана дата отчёта'); end if;
    if not exists (select 1 from tandem.points where id = v_point) then
      return jsonb_build_object('ok', false, 'error', 'Не указана точка'); end if;
    v_exp := tandem.jlist(payload->'expenses');
    v_tko := tandem.jlist(payload->'takeout');
    v_sal := tandem.jlist(payload->'sales');
    if v_exp is null or v_tko is null or v_sal is null then
      return jsonb_build_object('ok', false, 'error', 'Неверный формат отчёта: расходы, заборный лист и продажи — списками'); end if;

    -- Числа: пробелы и запятая — как на экране точки (num()), мусор — отказ с именем поля.
    select f.label, f.val into v_lbl, v_val from (
      select 0 as g, v.n::bigint as ord, v.label, v.val from (values
        (1, 'Наличные'::text, payload->>'cash'), (2, 'Kaspi QR', payload->>'kaspi_qr'),
        (3, 'Перевод на счёт', payload->>'transfer'), (4, 'Карта через терминал', payload->>'card'),
        (5, 'QR по выписке', payload->>'qr_statement'), (6, 'Переводы по выписке', payload->>'tr_statement'),
        (7, 'Остаток на начало', payload->>'cash_open'), (8, 'Сдано / инкассация', payload->>'cash_handed'),
        (9, 'Фактически пересчитано', payload->>'cash_counted')) v(n, label, val)
      union all
      select 1, e.ord, 'Расходы, ' || coalesce(nullif(left(btrim(e.x->>'purpose'), 40), ''), 'строка ' || e.ord) || ': сумма', e.x->>'amount'
        from jsonb_array_elements(v_exp) with ordinality e(x, ord)
      union all
      select 2, t.ord * 10 + c.n, 'Заборный лист, ' || coalesce(i.name, left(btrim(t.x->>'item_name'), 40)) || ': ' || c.label, c.val
        from jsonb_array_elements(v_tko) with ordinality t(x, ord)
        left join tandem.items i on i.code = nullif(btrim(t.x->>'item_code'), '')
        cross join lateral (values (1, 'выдано'::text, t.x->>'issued'), (2, 'остаток', t.x->>'returned'), (3, 'цена', t.x->>'price')) c(n, label, val)
       where coalesce(i.name, nullif(btrim(t.x->>'item_name'), '')) is not null
      union all
      select 3, s.ord * 10 + c.n, 'Продажи, ' || coalesce(i.name, left(btrim(s.x->>'item_name'), 40)) || ': ' || c.label, c.val
        from jsonb_array_elements(v_sal) with ordinality s(x, ord)
        left join tandem.items i on i.code = nullif(btrim(s.x->>'item_code'), '')
        cross join lateral (values (1, 'количество'::text, s.x->>'qty'), (2, 'цена', s.x->>'price'), (3, 'цена прейскуранта', s.x->>'price_list')) c(n, label, val)
       where coalesce(i.name, nullif(btrim(s.x->>'item_name'), '')) is not null
    ) f where not tandem.num_ok(f.val) order by f.g, f.ord limit 1;
    if v_lbl is not null then
      return jsonb_build_object('ok', false, 'error', 'Неверное число в поле «' || v_lbl || '»: ' || left(v_val, 40));
    end if;

    -- Код позиции, которой нет в справочнике, раньше ронял сохранение ошибкой внешнего ключа.
    select x.code into v_val from (
      select nullif(btrim(t->>'item_code'), '') as code from jsonb_array_elements(v_tko) t
      union all
      select nullif(btrim(s->>'item_code'), '') from jsonb_array_elements(v_sal) s) x
     where x.code is not null and not exists (select 1 from tandem.items i where i.code = x.code)
     limit 1;
    if v_val is not null then
      return jsonb_build_object('ok', false, 'error', 'Позиции с кодом «' || left(v_val, 40) || '» нет в справочнике — обновите страницу');
    end if;

    -- P4 (owner13): каким был отчёт до этого сохранения — чтобы отличить правку сданного отчёта от
    -- повторной отправки той же формы. У кассы строка есть с первого чека, но сдачей это ещё не было.
    select id, first_saved_at into v_prev_id, v_prev_first from tandem.daily_reports
     where point_id = v_point and report_date = v_date;
    if v_prev_first is not null then v_before := tandem.report_content(v_prev_id); end if;

    insert into tandem.daily_reports as d
      (point_id, report_date, shift_by, cash, kaspi_qr, transfer, card,
       qr_statement, tr_statement, cash_open, cash_handed, cash_counted, comment)
    values (v_point, v_date, left(payload->>'shift_by', 200),
       coalesce(tandem.to_num(payload->>'cash'), 0),
       coalesce(tandem.to_num(payload->>'kaspi_qr'), 0),
       coalesce(tandem.to_num(payload->>'transfer'), 0),
       coalesce(tandem.to_num(payload->>'card'), 0),
       tandem.to_num(payload->>'qr_statement'),
       tandem.to_num(payload->>'tr_statement'),
       coalesce(tandem.to_num(payload->>'cash_open'), 0),
       coalesce(tandem.to_num(payload->>'cash_handed'), 0),
       tandem.to_num(payload->>'cash_counted'),
       left(payload->>'comment', 2000))
    on conflict (point_id, report_date) do update set
       shift_by = excluded.shift_by, cash = excluded.cash,
       kaspi_qr = excluded.kaspi_qr, transfer = excluded.transfer, card = excluded.card,
       qr_statement = excluded.qr_statement, tr_statement = excluded.tr_statement,
       cash_open = excluded.cash_open, cash_handed = excluded.cash_handed,
       cash_counted = excluded.cash_counted, comment = excluded.comment,
       updated_at = now()
    returning d.id into v_id;

    -- Расход без суммы (пустая добавленная строка) пропускается.
    delete from tandem.cash_expenses where report_id = v_id;
    insert into tandem.cash_expenses (report_id, purpose, amount, receipt_no)
    select v_id, left(coalesce(e->>'purpose', ''), 500), tandem.to_num(e->>'amount'), left(nullif(e->>'receipt_no',''), 100)
    from jsonb_array_elements(v_exp) e
    where coalesce(tandem.to_num(e->>'amount'), 0) > 0;

    -- Название строки с кодом — из справочника, а не из запроса: текст точки уходит на экран собственника.
    -- Одна позиция дважды складывается в одну строку (название в отчёте уникально); два кода с одним
    -- названием различаются кодом в скобках, как в отчёте кассы.
    delete from tandem.takeout_lines where report_id = v_id;
    insert into tandem.takeout_lines (report_id, item_code, item_name, unit, issued, returned, price)
    select v_id, g.code,
           case when g.code is not null and count(*) over (partition by g.name) > 1 then g.name || ' [' || g.code || ']' else g.name end,
           g.unit, g.issued, g.returned, g.price
      from (select i.code, coalesce(i.name, left(nullif(btrim(t->>'item_name'), ''), 200)) as name,
                   min(coalesce(i.unit, left(nullif(btrim(t->>'unit'), ''), 20), 'шт')) as unit,
                   sum(coalesce(tandem.to_num(t->>'issued'), 0)) as issued,
                   sum(coalesce(tandem.to_num(t->>'returned'), 0)) as returned,
                   max(tandem.to_num(t->>'price')) as price
              from jsonb_array_elements(v_tko) t
              left join tandem.items i on i.code = nullif(btrim(t->>'item_code'), '')
             group by 1, 2) g
     where g.name is not null;

    delete from tandem.sale_lines where report_id = v_id;
    insert into tandem.sale_lines (report_id, item_code, item_name, qty, price, price_list)
    select v_id, g.code,
           case when g.code is not null and count(*) over (partition by g.name) > 1 then g.name || ' [' || g.code || ']' else g.name end,
           g.qty, g.price, g.price_list
      from (select s.code, s.name, sum(s.qty) as qty,
                   case when count(*) = 1 then max(s.price)
                        else round(sum(s.qty * s.price) / nullif(sum(s.qty) filter (where s.price is not null), 0), 2) end as price,
                   max(s.price_list) as price_list
              from (select i.code, coalesce(i.name, left(nullif(btrim(x->>'item_name'), ''), 200)) as name,
                           coalesce(tandem.to_num(x->>'qty'), 0) as qty,
                           tandem.to_num(x->>'price') as price, tandem.to_num(x->>'price_list') as price_list
                      from jsonb_array_elements(v_sal) x
                      left join tandem.items i on i.code = nullif(btrim(x->>'item_code'), '')) s
             where s.name is not null and s.qty <> 0
             group by s.code, s.name
            having sum(s.qty) <> 0) g;

    -- Касса (режим «чеки»): первичка — чеки. Деньги по каналам и строки продаж отчёта
    -- пересобираются из них, присланное формой не учитывается; сохранение отчёта = закрытие смены.
    if (select mode from tandem.points where id = v_point) = 'checks' then
      perform tandem.check_rollup(v_point, v_date);
      update tandem.daily_reports set closed_at = now() where id = v_id;
    end if;

    -- P4: первая сдача запоминается один раз; saved_at двигается, только если отчёт и правда изменился
    -- (деньги, расходы, заборный лист, продажи, комментарий). Чеки кассы, пришедшие после закрытия,
    -- правкой отчёта не считаются — для них late_checks; они уже были в «до» (check_rollup на каждом чеке).
    update tandem.daily_reports set
        first_saved_at = coalesce(first_saved_at, now()),
        saved_at = case when v_prev_first is null then now()
                        when v_before is distinct from tandem.report_content(v_id) then now()
                        else coalesce(saved_at, now()) end
     where id = v_id;

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

    select to_jsonb(v) || coalesce(tandem.report_marks(v.id), '{}'::jsonb) into v_res from tandem.v_daily v where v.id = v_id;
    return jsonb_build_object('ok', true, 'report', v_res);
  end if;

  -- ---------- заявки точки на завтра (миграция 0038) ----------
  if action = 'order_get' then
    return tandem.order_get(v_point, coalesce(tandem.to_date(payload->>'for_date'), v_today + 1));
  end if;
  if action = 'order_save' then return tandem.order_save(v_point, payload); end if;

  -- ---------- касса: чеки в течение дня ----------
  if action in ('check_save','check_void','check_list') then
    if (select mode from tandem.points where id = v_point) is distinct from 'checks' then
      return jsonb_build_object('ok', false, 'error', 'У этой точки касса не включена');
    end if;
    if action = 'check_save' then return tandem.check_save(v_point, payload); end if;
    if action = 'check_void' then return tandem.check_void(v_point, payload); end if;
    return tandem.check_list(v_point, coalesce(tandem.to_date(payload->>'date'), v_today));
  end if;

  -- ---------- открыть смену кассы заново (собственник) ----------
  -- Чек, вошедший в закрытие смены, уже не меняется (check_save/check_void; поздний чек — можно, K1).
  -- Собственник снимает закрытие, касса исправляет или отменяет чек (правка видна в voids как «было →
  -- стало»), затем закрывает смену снова.
  if action = 'reopen_shift' then
    if v_pin is distinct from v_owner_pin then
      return jsonb_build_object('ok', false, 'error', 'Нет доступа');
    end if;
    v_date := tandem.to_date(payload->>'date');
    if v_date is null then return jsonb_build_object('ok', false, 'error', 'Неверная дата отчёта'); end if;
    update tandem.daily_reports set closed_at = null, updated_at = now()
     where point_id = v_point and report_date = v_date and closed_at is not null
    returning id into v_id;
    if v_id is null then return jsonb_build_object('ok', false, 'error', 'Смена не закрыта'); end if;
    return jsonb_build_object('ok', true);
  end if;

  if action = 'dashboard' then
    if v_pin is distinct from v_owner_pin then
      return jsonb_build_object('ok', false, 'error', 'Нет доступа');
    end if;
    -- Даты периода фронт шлёт местные; по умолчанию — местные же, не дата сервера (UTC).
    v_from := coalesce(tandem.to_date(payload->>'from'), v_today - 30);
    v_to   := coalesce(tandem.to_date(payload->>'to'), v_today);
    return jsonb_build_object('ok', true,
      -- P3/P4, K1: у строки дня — late_checks/late_sum и late_cash/late_kaspi/late_card/late_transfer (чеки
      -- после закрытия смены: «должно» — на момент закрытия, «закрыть смену заново»), first_saved_at и
      -- edited_at (отчёт пересохранён с изменениями после первой сдачи)
      'rows', (select coalesce(jsonb_agg(to_jsonb(v) || coalesce(tandem.report_marks(v.id), '{}'::jsonb)
                                         order by v.report_date desc, v.point_name), '[]'::jsonb)
               from tandem.v_daily v
               where v.report_date between v_from and v_to),
      -- P5 (owner15): first_report — дата первого отчёта точки; дни до неё — не «не сдано», а «ещё не работала»
      'points', (select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'mode',p.mode,
                   'first_report', (select min(d.report_date) from tandem.daily_reports d where d.point_id = p.id))
                   order by p.sort_order),'[]'::jsonb)
                 from tandem.points p where p.active),
      -- P1 (owner4): чеки кассы по точкам за период — число активных чеков, сумма, средний чек
      'checks', (select coalesce(jsonb_agg(jsonb_build_object('point_id', t.point_id, 'point_name', t.name,
                   'checks', t.n, 'total', t.s, 'avg', round(t.s / t.n, 2)) order by t.sort_order, t.name), '[]'::jsonb)
                 from (select c.point_id, p.name, p.sort_order, count(*) as n, sum(c.total) as s
                         from tandem.checks c join tandem.points p on p.id = c.point_id
                        where c.check_date between v_from and v_to and c.status = 'active'
                        group by c.point_id, p.name, p.sort_order) t),
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
      -- Кто не сдал отчёт за вчера — по местной дате: ночью до 05:00 «вчера» по UTC — это позавчера.
      -- P5 (owner15): точка, у которой ещё не было ни одного отчёта до вчерашнего дня включительно, не
      -- начала работать в программе — в первые дни все точки шумели бы в «не сдали».
      'missing', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name) order by p.sort_order), '[]'::jsonb)
        from tandem.points p
        where p.active
          and exists (select 1 from tandem.daily_reports d0 where d0.point_id = p.id and d0.report_date <= v_today - 1)
          and not exists (
          select 1 from tandem.daily_reports d
          where d.point_id = p.id and d.report_date = v_today - 1
            -- у кассы строка отчёта появляется с первым чеком; сданным он считается после закрытия смены
            and (p.mode <> 'checks' or d.closed_at is not null))),
      -- Отмены и исправления чеков кассы за период: «пробил, взял наличные, отменил» больше не проходит без следа.
      'voids', (select coalesce(jsonb_agg(x.j order by x.t_at desc), '[]'::jsonb)
        from (select jsonb_build_object('kind', case when c.status = 'void' then 'void' else 'edited' end,
                  'point_id', c.point_id, 'point_name', p.name, 'date', c.check_date, 'no', c.no, 'total', c.total,
                  'pay_kind', c.pay_kind, 'first_total', coalesce(c.first_total, c.total),
                  'first_pay_kind', coalesce(c.first_pay_kind, c.pay_kind), 'edited', c.edited,
                  'reason', c.void_reason, 'seller', c.seller, 'at', c.updated_at) as j,
                  c.updated_at as t_at
                from tandem.checks c join tandem.points p on p.id = c.point_id
               where c.check_date between v_from and v_to and (c.status = 'void' or c.edited)
               order by c.updated_at desc limit 300) x),
      -- Расход сырья по техкартам за период: топ-15
      -- P2 (owner7): unit_id — единица ингредиента (брутто в карте — в ней же); экран писал «кг» всем.
      -- Группировка по коду: две позиции с одним названием и разными единицами не складываются.
      'raw_usage', (select coalesce(jsonb_agg(jsonb_build_object(
          'name', t.ingredient_name, 'amount', t.total, 'unit_id', t.unit_id) order by t.total desc), '[]'::jsonb)
        from (
          -- Карта берётся на дату отчёта, а не на сегодня: иначе новая версия карты
          -- переписала бы расход сырья за прошлые дни.
          select ing.name as ingredient_name, ing.unit_id, sum(cl.brutto / ch.output_amount * u.q) total from (
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
          group by ing.code, ing.name, ing.unit_id order by total desc limit 15
        ) t),
      -- Неверные коды за сутки (счётчик единого входа, 0029/0042): кто-то подбирает код точки, собственника
      -- или PIN бэк-офиса. 'master' — общий счётчик всех неверных кодов сети (он запирает вход собственника и водителя).
      'pin_failures', (select coalesce(jsonb_agg(jsonb_build_object('key', f.key, 'count', f.n, 'last', f.last,
          'name', coalesce(p.name, case
            when f.key = 'service' then 'служебный ключ'
            when f.key = '-' then 'вход без точки (собственник, водитель)'
            -- owner16: «общий замок» было непонятно — пишем, что он делает (порог — в tandem_gate: 10 за 5 минут)
            when f.key = 'master' then 'все неверные коды точек, собственника и водителя вместе: после 10 ошибок за 5 минут вход собственника и водителя закрывается на 5 минут'
            when f.key like 'office:%' then 'бэк-офис, логин «' || substr(f.key, 8) || '»'
            else f.key end))
          order by f.n desc), '[]'::jsonb)
        from (select key, count(*) n, max(at) last from tandem.pin_failures where at > now() - interval '24 hours'
               group by key order by count(*) desc limit 30) f
        left join tandem.points p on p.id = f.key),
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

-- Новые и пересозданные (drop + create получают права по умолчанию — EXECUTE для PUBLIC) функции
-- закрываются, как и остальные: снаружи — только через tandem_gate.
do $$
declare f text;
begin
  foreach f in array array[
      'tandem.missing_names(text[])', 'tandem.missing_text(text[])', 'tandem.report_content(bigint)',
      'tandem.report_marks(bigint)', 'tandem.item_price_origin(text)',
      'tandem.late_totals(text,date,timestamp with time zone)',
      'tandem.check_save(text,jsonb)', 'tandem.check_void(text,jsonb)',
      'tandem.item_cost(text,date,integer)', 'tandem.menu_foodcost(text,date,uuid)', 'tandem.check_list(text,date)',
      'tandem.office_charts(text,jsonb,tandem.users)', 'tandem.office_counteragents(text,jsonb,tandem.users)',
      'tandem.office_nomenclature(text,jsonb,tandem.users)', 'tandem.office_users(text,jsonb,tandem.users)',
      'public.tandem_api(text,jsonb)'] loop
    execute 'revoke all on function ' || f || ' from public';
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute 'revoke all on function ' || f || ' from anon, authenticated';
      execute 'grant execute on function ' || f || ' to service_role';
    end if;
  end loop;
end $$;


-- ---------------------------------------------------------------- техкарты экрана точки: единица ингредиента
-- Расход сырья на отчёте точки писал количества без единиц («4,53» рядом с «0,6»): экран берёт единицу
-- из поля u строки карты (интегратор сборки 21; тело — из канона, добавлено только u).
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
             jsonb_agg(jsonb_build_object('n', ing.name, 'a', round(cl.brutto / c.output_amount, 4), 'u', ing.unit_id) order by cl.brutto desc) as lines
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

revoke all on function public.tandem_charts(text,text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function public.tandem_charts(text,text) from anon, authenticated;
    grant execute on function public.tandem_charts(text,text) to service_role;
  end if;
end $$;
