-- Экран точки «расход сырья»: те же данные из новых таблиц. Формат ответа не меняется.
create or replace function public.tandem_charts(p_pin text, p_point text)
returns jsonb language plpgsql security definer set search_path to 'tandem','public' as $$
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
             jsonb_agg(jsonb_build_object('n', ing.name, 'a', round(cl.brutto / c.output_amount, 4)) order by cl.brutto desc) as lines
      from tandem.charts c
      join tandem.items i on i.code = c.item_code and i.active and i.for_sale
      join tandem.chart_lines cl on cl.chart_id = c.id
      join tandem.items ing on ing.code = cl.ingredient_code
      where c.id = tandem.active_chart(c.item_code, current_date)
        and (v_cats is null or cardinality(v_cats) = 0 or i.category = any(v_cats))
      group by c.item_code
    ) t));
end $$;

-- Дашборд собственника: блок «расход сырья за период» читал ту же tandem.item_chart.
-- Функция пересоздаётся целиком (частично тело plpgsql не правится): изменён только
-- источник расхода — состав активной на сегодня карты вместо снимка item_chart.
CREATE OR REPLACE FUNCTION public.tandem_api(action text, payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'tandem', 'public'
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

  if action in ('items','get_report','save_report','aliases') then
    if v_pin <> v_owner_pin
       and not exists (select 1 from tandem.points where id = v_point and pin = v_pin and active) then
      return jsonb_build_object('ok', false, 'error', 'Нет доступа');
    end if;
  end if;

  if action = 'items' then
    select item_scopes, item_categories into v_scopes, v_cats
      from tandem.points where id = v_point;
    return jsonb_build_object('ok', true, 'items', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'code', code, 'name', name, 'category', category, 'unit', unit,
        'price', price, 'artikul', artikul, 'iiko_code', iiko_code,
        'rank', rank, 'short', short, 'has_chart', has_chart,
        'pack_factor', pack_factor, 'pack_unit', pack_unit, 'pack_price', pack_price)
        order by category, name), '[]'::jsonb)
      from (
        select i.code, i.name, i.category, i.unit,
               coalesce(pp.price, i.price)   as price,
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
        limit 1200
      ) s));
  end if;

  -- Карта соответствий для импорта: названия чужой программы → код номенклатуры.
  if action = 'aliases' then
    return jsonb_build_object('ok', true, 'aliases', (
      select coalesce(jsonb_object_agg(alias, item_code), '{}'::jsonb) from tandem.item_aliases));
  end if;

  if action = 'get_report' then
    v_date := (payload->>'date')::date;
    select to_jsonb(v) into v_res from tandem.v_daily v
      where v.point_id = v_point and v.report_date = v_date;
    if v_res is null then
      return jsonb_build_object('ok', true, 'report', null, 'expenses','[]'::jsonb,
                                'takeout','[]'::jsonb, 'sales','[]'::jsonb);
    end if;
    select id into v_id from tandem.daily_reports
      where point_id = v_point and report_date = v_date;
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
        from tandem.sale_lines where report_id = v_id));
  end if;

  if action = 'save_report' then
    v_date := (payload->>'date')::date;

    insert into tandem.daily_reports as d
      (point_id, report_date, shift_by, cash, kaspi_qr, transfer,
       qr_statement, tr_statement, cash_open, cash_handed, cash_counted, comment)
    values (v_point, v_date, payload->>'shift_by',
       coalesce((payload->>'cash')::numeric,0),
       coalesce((payload->>'kaspi_qr')::numeric,0),
       coalesce((payload->>'transfer')::numeric,0),
       nullif(payload->>'qr_statement','')::numeric,
       nullif(payload->>'tr_statement','')::numeric,
       coalesce((payload->>'cash_open')::numeric,0),
       coalesce((payload->>'cash_handed')::numeric,0),
       nullif(payload->>'cash_counted','')::numeric,
       payload->>'comment')
    on conflict (point_id, report_date) do update set
       shift_by = excluded.shift_by, cash = excluded.cash,
       kaspi_qr = excluded.kaspi_qr, transfer = excluded.transfer,
       qr_statement = excluded.qr_statement, tr_statement = excluded.tr_statement,
       cash_open = excluded.cash_open, cash_handed = excluded.cash_handed,
       cash_counted = excluded.cash_counted, comment = excluded.comment,
       updated_at = now()
    returning d.id into v_id;

    delete from tandem.cash_expenses where report_id = v_id;
    insert into tandem.cash_expenses (report_id, purpose, amount, receipt_no)
    select v_id, e->>'purpose', (e->>'amount')::numeric, nullif(e->>'receipt_no','')
    from jsonb_array_elements(coalesce(payload->'expenses','[]'::jsonb)) e
    where coalesce((e->>'amount')::numeric,0) > 0;

    delete from tandem.takeout_lines where report_id = v_id;
    insert into tandem.takeout_lines (report_id, item_code, item_name, unit, issued, returned, price)
    select v_id, nullif(t->>'item_code',''), t->>'item_name', coalesce(t->>'unit','шт'),
           coalesce((t->>'issued')::numeric,0), coalesce((t->>'returned')::numeric,0),
           nullif(t->>'price','')::numeric
    from jsonb_array_elements(coalesce(payload->'takeout','[]'::jsonb)) t
    where coalesce(t->>'item_name','') <> '';

    delete from tandem.sale_lines where report_id = v_id;
    insert into tandem.sale_lines (report_id, item_code, item_name, qty, price, price_list)
    select v_id, nullif(s->>'item_code',''), s->>'item_name',
           coalesce((s->>'qty')::numeric,0), nullif(s->>'price','')::numeric,
           nullif(s->>'price_list','')::numeric
    from jsonb_array_elements(coalesce(payload->'sales','[]'::jsonb)) s
    where coalesce(s->>'item_name','') <> '' and coalesce((s->>'qty')::numeric,0) <> 0;

    select to_jsonb(v) into v_res from tandem.v_daily v where v.id = v_id;
    return jsonb_build_object('ok', true, 'report', v_res);
  end if;

  if action = 'dashboard' then
    if v_pin <> v_owner_pin then
      return jsonb_build_object('ok', false, 'error', 'Нет доступа');
    end if;
    v_from := coalesce((payload->>'from')::date, current_date - 30);
    v_to   := coalesce((payload->>'to')::date, current_date);
    return jsonb_build_object('ok', true,
      'rows', (select coalesce(jsonb_agg(to_jsonb(v) order by v.report_date desc, v.point_name), '[]'::jsonb)
               from tandem.v_daily v
               where v.report_date between v_from and v_to),
      'points', (select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'mode',mode) order by sort_order),'[]'::jsonb)
                 from tandem.points where active),
      -- Выручка по каналам и юрлицам за период
      'channels', (select jsonb_build_object(
          'cash', coalesce(sum(d.cash),0), 'kaspi_qr', coalesce(sum(d.kaspi_qr),0),
          'transfer', coalesce(sum(d.transfer),0))
        from tandem.daily_reports d where d.report_date between v_from and v_to),
      'by_legal', (select coalesce(jsonb_agg(jsonb_build_object(
          'legal', t.legal_entity, 'revenue', t.rev) order by t.rev desc), '[]'::jsonb)
        from (select p.legal_entity, sum(d.cash + d.kaspi_qr + d.transfer) rev
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
      -- Кто не сдал отчёт за вчера
      'missing', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name) order by p.sort_order), '[]'::jsonb)
        from tandem.points p
        where p.active and not exists (
          select 1 from tandem.daily_reports d
          where d.point_id = p.id and d.report_date = current_date - 1)),
      -- Расход сырья по техкартам за период: топ-15
      'raw_usage', (select coalesce(jsonb_agg(jsonb_build_object(
          'name', t.ingredient_name, 'amount', t.total) order by t.total desc), '[]'::jsonb)
        from (
          select c.ingredient_name, sum(c.amount * u.q) total from (
            select s.item_code, s.qty q
            from tandem.sale_lines s join tandem.daily_reports d on d.id = s.report_id
            where d.report_date between v_from and v_to and s.item_code is not null
            union all
            select t.item_code, (t.issued - t.returned)
            from tandem.takeout_lines t join tandem.daily_reports d on d.id = t.report_id
            where d.report_date between v_from and v_to and t.item_code is not null
          ) u join (
            select ch.item_code, ing.name as ingredient_name,
                   cl.brutto / ch.output_amount as amount
            from tandem.charts ch
            join tandem.chart_lines cl on cl.chart_id = ch.id
            join tandem.items ing on ing.code = cl.ingredient_code
            where ch.id = tandem.active_chart(ch.item_code, current_date)
          ) c on c.item_code = u.item_code
          group by c.ingredient_name order by total desc limit 15
        ) t),
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
$function$;

drop function if exists public.tandem_sync_charts(text, jsonb);
drop table if exists tandem.item_chart;
