-- 0066: ревизия 22.11.2026, участок «Точка, заявки, заказы клиентов, ежедневные операции» (ревьюер 2).
-- Что исправлено (номера находок ревизии):
--  2  учебному плану заявок - свой склад кухни (settings.training_orders_store_id); рабочая настройка
--     orders_store_id обучению больше не нужна (её значение здесь не меняется - склад кухни выбирает владелец);
--  3  план выпечки и документы плана настоящего пользователя - без учебных точек;
--  4  сводка собственника с экрана (only_real) - без учебных точек и служебных zz_* во всех разделах;
--  5  список точек для входа - без zz_*, учебные точки - только экрану в режиме обучения;
--  7  «Акт по заказам клиентов» - действие склада: кладовщик может (право акта проверяет office_corders);
--  8  правка заказа в кассе: адрес и комментарий без проверок нового заказа, прежние строки - по прежней цене,
--     правила «нового заказа на текущее время» - только для новой даты и нового времени;
--  11 подсказка «смена за ДД.ММ не закрыта» (get_report, список заказов кассы);
--  12 окно дат отчёта точки на сервере, как у документов склада (код собственника - без окна);
--  13 заявка на кухню принимает только позиции из меню точки;
--  14 меню заказов бота и стоп-лист - только точкам выдачи;
--  15 запись развоза отменяет собственник с причиной; запись из одних нулей - отказ;
--  17 касса видит все незакрытые заказы клиентов, а не только на 14 дней;
--  18 учебная учётка видит в плане выпечки только учебные точки (имён настоящих клиентов нет);
--  19 сбой создания акта по заказам клиентов - понятной причиной, а не «Ошибка базы данных»;
--  от участка кассы: код точки не закрывает смену кассы, пока продажи дня не пробиты в налоговой (нужна 0065).
-- Общие функции (public.tandem_api, public.tandem_office) правятся по якорю из текущего текста в базе: чужие правки
-- в них сохраняются. Функции участка - целиком. Повторный прогон ничего не задваивает.

begin;

-- ---------------------------------------------------------------- правка по якорю
-- Уже применено (новый текст есть в функции) - пропуск; иначе якорь обязан встретиться ровно раз.
create or replace function pg_temp.patch66(p_fn regprocedure, p_from text, p_to text) returns void language plpgsql as $$
declare d text := pg_get_functiondef(p_fn); n int;
begin
  if position(p_to in d) > 0 then return; end if;
  n := (length(d) - length(replace(d, p_from, ''))) / length(p_from);
  if n <> 1 then raise exception '0066: якорь в % встретился % раз: %', p_fn, n, left(p_from, 80); end if;
  execute replace(d, p_from, p_to);
end $$;

-- ---------------------------------------------------------------- данные
-- 15: отмена записи развоза собственником
alter table tandem.realization_ledger add column if not exists cancelled_at timestamptz;
alter table tandem.realization_ledger add column if not exists cancel_reason text;
alter table tandem.realization_ledger add column if not exists cancelled_by text;

-- 2: учебный склад кухни для учебного плана заявок - «Учебный склад кухни» из настройки обучения, если настройки ещё нет
insert into tandem.settings (key, value)
select 'training_orders_store_id', s.id::text from tandem.stores s
 where s.training and lower(btrim(s.name)) = lower('Учебный склад кухни')
 order by s.active desc, s.id limit 1
on conflict (key) do nothing;

-- ---------------------------------------------------------------- новые функции
-- 5: список точек для входа (экран точки, заявка, касса).
create or replace function tandem.login_points(payload jsonb)
 returns jsonb
 language sql
 stable
 set search_path to 'tandem', 'public'
as $function$
  -- Служебные zz_* - никогда: дымовые тесты входят по коду через API, а продавец по ошибке выбрал бы
  -- «ZZ_TEST_касса». Учебные точки - только экрану в режиме обучения (training: true - в браузере есть учётки
  -- обучения или это тестовая база) и точке, в которую этот телефон уже входил (keep). Экран без признака
  -- training (касса до своей правки) получает учебные точки, как раньше: иначе встали бы уроки кассы.
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'mode', p.mode, 'legal_entity', p.legal_entity)
                            order by p.sort_order), '[]'::jsonb)
    from tandem.points p
   where p.active and p.id not like 'zz\_%'
     and (not p.training
          or not (coalesce(payload, '{}'::jsonb) ? 'training')
          or coalesce(payload->>'training', '') = 'true'
          or p.id = coalesce(payload->>'keep', ''))
$function$;

-- 11: подсказки экрану точки и кассе. open_shift - последний день за неделю до p_date, когда касса пробивала
-- чеки, а смену не закрыли; prev_missing - вчерашний (к p_date) отчёт точки без кассы не сдан, хотя точка уже
-- сдавала отчёты раньше. Только текст-предупреждение: дату формы экран не меняет.
-- unfiscal (участок кассы, 0065) - сколько продаж дня не пробито в налоговой: с ними код точки смену не закрывает
-- (save_report), экран закрытия показывает причину заранее. Нужна 0065 (tandem.fiscal_unfiscal).
create or replace function tandem.report_hints(p_point text, p_date date)
 returns jsonb
 language sql
 stable
 set search_path to 'tandem', 'public'
as $function$
  select jsonb_build_object(
    'unfiscal', tandem.fiscal_unfiscal(p_point, p_date),
    'open_shift', (select max(d.report_date) from tandem.daily_reports d join tandem.points p on p.id = d.point_id
                    where d.point_id = p_point and p.mode = 'checks' and d.closed_at is null
                      and d.report_date < p_date and d.report_date >= p_date - 7
                      and exists (select 1 from tandem.checks c where c.point_id = d.point_id and c.check_date = d.report_date)),
    'prev_missing', (select p_date - 1 from tandem.points p
                      where p.id = p_point and p.mode <> 'checks'
                        and not exists (select 1 from tandem.daily_reports d where d.point_id = p_point and d.report_date = p_date - 1)
                        and exists (select 1 from tandem.daily_reports d where d.point_id = p_point and d.report_date < p_date - 1)))
$function$;

-- 13: позиция в меню точки - тот же отбор, что у действия items (public.tandem_api): в продаже, учебная - только
-- у учебной точки, группы меню точки (item_categories) или старые области (item_scopes).
create or replace function tandem.point_menu_ok(p_point text, p_code text)
 returns boolean
 language sql
 stable
 set search_path to 'tandem', 'public'
as $function$
  select exists (
    select 1 from tandem.items i join tandem.points p on p.id = p_point
     where i.code = p_code and i.active and i.for_sale
       and (not i.training or p.training)
       and case when p.item_categories is not null and cardinality(p.item_categories) > 0 then i.category = any(p.item_categories)
                when p.item_scopes is null or cardinality(p.item_scopes) = 0 then true
                else i.point_hint = any(p.item_scopes) end)
$function$;

-- 4: сводка собственника (раньше - блок dashboard в public.tandem_api). p_pts - какие точки показывать:
-- null - все (вызов без признака, дымовые тесты), учебные (учебный код сводки) или рабочие без учебных и zz_*
-- (экран собственника, признак only_real). p_train - учебный код: развоза нет, неверные коды - только учебные.
create or replace function tandem.owner_dashboard(p_from date, p_to date, p_pts text[], p_train boolean, p_today date)
 returns jsonb
 language sql
 stable
 set search_path to 'tandem', 'public'
 set jit to 'off'
as $function$
  select jsonb_build_object('ok', true,
      -- P3/P4, K1: у строки дня - late_checks/late_sum и late_cash/late_kaspi/late_card/late_transfer (чеки
      -- после закрытия смены), first_saved_at и edited_at (отчёт пересохранён с изменениями после первой сдачи)
      'rows', (select coalesce(jsonb_agg(to_jsonb(v) || coalesce(tandem.report_marks(v.id), '{}'::jsonb)
                                         order by v.report_date desc, v.point_name), '[]'::jsonb)
               from tandem.v_daily v
               where v.report_date between p_from and p_to and (p_pts is null or v.point_id = any(p_pts))),
      -- P5 (owner15): first_report - дата первого отчёта точки; дни до неё - не «не сдано», а «ещё не работала»
      'points', (select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'mode',p.mode,
                   'first_report', (select min(d.report_date) from tandem.daily_reports d where d.point_id = p.id))
                   order by p.sort_order),'[]'::jsonb)
                 from tandem.points p where p.active and (p_pts is null or p.id = any(p_pts))),
      -- P1 (owner4): чеки кассы по точкам за период - число активных чеков, сумма, средний чек
      'checks', (select coalesce(jsonb_agg(jsonb_build_object('point_id', t.point_id, 'point_name', t.name,
                   'checks', t.n, 'total', t.s, 'avg', round(t.s / t.n, 2)) order by t.sort_order, t.name), '[]'::jsonb)
                 from (select c.point_id, p.name, p.sort_order, count(*) as n, sum(c.total) as s
                         from tandem.checks c join tandem.points p on p.id = c.point_id
                        where c.check_date between p_from and p_to and c.status = 'active'
                          and (p_pts is null or c.point_id = any(p_pts))
                        group by c.point_id, p.name, p.sort_order) t),
      -- Выручка по каналам и юрлицам за период
      'channels', (select jsonb_build_object(
          'cash', coalesce(sum(d.cash),0), 'kaspi_qr', coalesce(sum(d.kaspi_qr),0),
          'transfer', coalesce(sum(d.transfer),0), 'card', coalesce(sum(d.card),0))
        from tandem.daily_reports d where d.report_date between p_from and p_to and (p_pts is null or d.point_id = any(p_pts))),
      'by_legal', (select coalesce(jsonb_agg(jsonb_build_object(
          'legal', t.legal_entity, 'revenue', t.rev) order by t.rev desc), '[]'::jsonb)
        from (select p.legal_entity, sum(d.cash + d.kaspi_qr + d.transfer + d.card) rev
              from tandem.daily_reports d join tandem.points p on p.id = d.point_id
              where d.report_date between p_from and p_to and (p_pts is null or d.point_id = any(p_pts))
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
            where d.report_date between p_from and p_to and (p_pts is null or d.point_id = any(p_pts))
            union all
            select t.item_name, (t.issued - t.returned) q,
                   (t.issued - t.returned) * coalesce(t.price,0) amt, 0
            from tandem.takeout_lines t
            join tandem.daily_reports d on d.id = t.report_id
            where d.report_date between p_from and p_to and (p_pts is null or d.point_id = any(p_pts))
          ) u group by item_name order by amt desc limit 20
        ) t),
      -- Кто не сдал отчёт за вчера - по местной дате. P5 (owner15): точка без единого отчёта до вчерашнего дня
      -- включительно ещё не работает в программе и в «не сдали» не попадает.
      'missing', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name) order by p.sort_order), '[]'::jsonb)
        from tandem.points p
        where p.active and (p_pts is null or p.id = any(p_pts))
          and exists (select 1 from tandem.daily_reports d0 where d0.point_id = p.id and d0.report_date <= p_today - 1)
          and not exists (
          select 1 from tandem.daily_reports d
          where d.point_id = p.id and d.report_date = p_today - 1
            -- у кассы строка отчёта появляется с первым чеком; сданным он считается после закрытия смены
            and (p.mode <> 'checks' or d.closed_at is not null))),
      -- Отмены и исправления чеков кассы за период
      'voids', (select coalesce(jsonb_agg(x.j order by x.t_at desc), '[]'::jsonb)
        from (select jsonb_build_object('kind', case when c.status = 'void' then 'void' else 'edited' end,
                  'point_id', c.point_id, 'point_name', p.name, 'date', c.check_date, 'no', c.no, 'total', c.total,
                  'pay_kind', c.pay_kind, 'first_total', coalesce(c.first_total, c.total),
                  'first_pay_kind', coalesce(c.first_pay_kind, c.pay_kind), 'edited', c.edited,
                  'reason', c.void_reason, 'seller', c.seller, 'at', c.updated_at) as j,
                  c.updated_at as t_at
                from tandem.checks c join tandem.points p on p.id = c.point_id
               where c.check_date between p_from and p_to and (c.status = 'void' or c.edited)
                 and (p_pts is null or c.point_id = any(p_pts))
               order by c.updated_at desc limit 300) x),
      -- Расход сырья по техкартам за период: топ-15, карта - на дату отчёта; группировка по коду ингредиента
      'raw_usage', (select coalesce(jsonb_agg(jsonb_build_object(
          'name', t.ingredient_name, 'amount', t.total, 'unit_id', t.unit_id) order by t.total desc), '[]'::jsonb)
        from (
          select ing.name as ingredient_name, ing.unit_id, sum(cl.brutto / ch.output_amount * u.q) total from (
            select s.item_code, s.qty q, d.report_date rd
            from tandem.sale_lines s join tandem.daily_reports d on d.id = s.report_id
            where d.report_date between p_from and p_to and s.item_code is not null and (p_pts is null or d.point_id = any(p_pts))
            union all
            select t.item_code, (t.issued - t.returned), d.report_date
            from tandem.takeout_lines t join tandem.daily_reports d on d.id = t.report_id
            where d.report_date between p_from and p_to and t.item_code is not null and (p_pts is null or d.point_id = any(p_pts))
          ) u
          join tandem.charts ch on ch.id = tandem.active_chart(u.item_code, u.rd)
          join tandem.chart_lines cl on cl.chart_id = ch.id
          join tandem.items ing on ing.code = cl.ingredient_code
          group by ing.code, ing.name, ing.unit_id order by total desc limit 15
        ) t),
      -- Неверные коды за сутки. Учебной сводке - только учебное; экрану собственника - без служебных zz_* и
      -- учебных точек (их ошибки - уроки и дымовые тесты, не подбор кода).
      'pin_failures', (select coalesce(jsonb_agg(jsonb_build_object('key', f.key, 'count', f.n, 'last', f.last,
          'name', coalesce(p.name, case
            when f.key = 'service' then 'служебный ключ'
            when f.key = '-' then 'вход без точки (собственник, водитель)'
            when f.key = 'master' then 'все неверные коды точек, собственника и водителя вместе: после 10 ошибок за 5 минут вход собственника и водителя закрывается на 5 минут'
            when f.key like 'office:%' then 'бэк-офис, логин «' || substr(f.key, 8) || '»'
            when f.key = 'training' then 'код обучения (страница обучения)'
            else f.key end))
          order by f.n desc), '[]'::jsonb)
        from (select key, count(*) n, max(at) last from tandem.pin_failures where at > now() - interval '24 hours'
                 and case when p_train then key = any(p_pts) or key = 'training'
                          when p_pts is not null then key not like 'zz\_%' and key not like 'office:zz\_test\_%'
                                                      and key not in (select id from tandem.points where training)
                          else true end
               group by key order by count(*) desc limit 30) f
        left join tandem.points p on p.id = f.key),
      -- Долги по реализации: отменённая собственником запись (0066) в долг не входит; учебной сводке развоза нет
      'realization', (select coalesce(jsonb_agg(jsonb_build_object(
          'name', c.name, 'debt', t.debt) order by t.debt desc), '[]'::jsonb)
        from (select client_id, sum(delivered - paid - returned) debt
              from tandem.realization_ledger where cancelled_at is null group by client_id) t
        join tandem.realization_clients c on c.id = t.client_id
        where t.debt <> 0 and not p_train))
$function$;

-- ---------------------------------------------------------------- public.tandem_api (по якорю)
-- 5: список точек для входа
select pg_temp.patch66('public.tandem_api(text,jsonb)',
$a$  if action = 'points' then
    return (select coalesce(jsonb_agg(jsonb_build_object(
              'id', id, 'name', name, 'mode', mode, 'legal_entity', legal_entity) order by sort_order), '[]'::jsonb)
            from tandem.points where active);
  end if;$a$,
$a$  -- 0066: список точек для входа - без служебных zz_*, учебные - только в режиме обучения (tandem.login_points)
  if action = 'points' then
    return tandem.login_points(payload);
  end if;$a$);

-- 11: подсказки дня в get_report (brief - только подсказки: касса спрашивает их без отчёта)
select pg_temp.patch66('public.tandem_api(text,jsonb)',
$a$    if v_date is null then return jsonb_build_object('ok', false, 'error', 'Неверная дата отчёта'); end if;
    select to_jsonb(v) into v_res from tandem.v_daily v
      where v.point_id = v_point and v.report_date = v_date;
    if v_res is null then
      return jsonb_build_object('ok', true, 'report', null, 'expenses','[]'::jsonb,
                                'takeout','[]'::jsonb, 'sales','[]'::jsonb, 'voids','[]'::jsonb);
    end if;$a$,
$a$    if v_date is null then return jsonb_build_object('ok', false, 'error', 'Неверная дата отчёта'); end if;
    -- 0066: подсказки дня - незакрытая смена кассы за прошлые дни, несданный вчерашний отчёт (tandem.report_hints)
    if coalesce(payload->>'brief', '') = 'true' then
      return jsonb_build_object('ok', true) || tandem.report_hints(v_point, v_date);
    end if;
    select to_jsonb(v) into v_res from tandem.v_daily v
      where v.point_id = v_point and v.report_date = v_date;
    if v_res is null then
      return jsonb_build_object('ok', true, 'report', null, 'expenses','[]'::jsonb,
                                'takeout','[]'::jsonb, 'sales','[]'::jsonb, 'voids','[]'::jsonb)
             || tandem.report_hints(v_point, v_date);
    end if;$a$);
select pg_temp.patch66('public.tandem_api(text,jsonb)',
$a$        where c.point_id = v_point and c.check_date = v_date and (c.status = 'void' or c.edited)));
  end if;$a$,
$a$        where c.point_id = v_point and c.check_date = v_date and (c.status = 'void' or c.edited)))
      || tandem.report_hints(v_point, v_date);   -- 0066
  end if;$a$);

-- 12: окно дат отчёта для кода точки. И от участка кассы (0065): смену кассы с фискальным чеком код точки не
-- закрывает, пока продажи дня не пробиты в налоговой - Z-отчёт Webkassa их не примет, а закрытая в учёте смена
-- разошлась бы с налоговой. Учебные и zz_* - так же (это правило, а не данные). Собственник (правка закрытой смены)
-- и учебный код сводки - без этих проверок.
select pg_temp.patch66('public.tandem_api(text,jsonb)',
$a$      return jsonb_build_object('ok', false, 'error', 'Не указана точка'); end if;
    v_exp := tandem.jlist(payload->'expenses');$a$,
$a$      return jsonb_build_object('ok', false, 'error', 'Не указана точка'); end if;
    -- 0066: окно дат, как у документов склада: код точки сдаёт отчёт не раньше 01.01.2024 и не позже завтрашнего
    -- (местного) дня - неверный год или «завтра» в календаре телефона больше не ставят отчёт и складскую продажу на
    -- чужую дату. Собственник (и учебный код сводки у учебных точек) исправляет любой день.
    if v_pin is distinct from v_owner_pin and not v_train
       and (v_date < date '2024-01-01' or v_date > v_today + 1) then
      return jsonb_build_object('ok', false, 'error', 'Дата отчёта ' || to_char(v_date, 'DD.MM.YYYY')
        || ' не подходит: отчёт сдают не раньше 01.01.2024 и не позже завтрашнего дня. Проверьте дату');
    end if;
    -- 0066 (касса, 0065): не пробитые в налоговой продажи дня - закрыть смену нельзя (tandem.fiscal_unfiscal)
    if v_pin is distinct from v_owner_pin and not v_train
       and (select mode from tandem.points where id = v_point) = 'checks'
       and tandem.fiscal_unfiscal(v_point, v_date) > 0 then
      return jsonb_build_object('ok', false, 'unfiscal', tandem.fiscal_unfiscal(v_point, v_date),
        'error', 'Не пробиты в налоговой: ' || tandem.fiscal_unfiscal(v_point, v_date)
          || ' - откройте кассу (вкладка «Смена»), нажмите «Проверить в налоговой» или отмените такой чек');
    end if;
    v_exp := tandem.jlist(payload->'expenses');$a$);

-- 4, 9: сводка собственника - в tandem.owner_dashboard; экран собственника шлёт only_real
select pg_temp.patch66('public.tandem_api(text,jsonb)',
$a$    -- 0048: по учебному коду сводки каждый раздел ниже отбирает только учебные точки (v_tp), развоз — пуст
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
               where v.report_date between v_from and v_to and (not v_train or v.point_id = any(v_tp))),
      -- P5 (owner15): first_report — дата первого отчёта точки; дни до неё — не «не сдано», а «ещё не работала»
      'points', (select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'mode',p.mode,
                   'first_report', (select min(d.report_date) from tandem.daily_reports d where d.point_id = p.id))
                   order by p.sort_order),'[]'::jsonb)
                 from tandem.points p where p.active and (not v_train or p.id = any(v_tp))),
      -- P1 (owner4): чеки кассы по точкам за период — число активных чеков, сумма, средний чек
      'checks', (select coalesce(jsonb_agg(jsonb_build_object('point_id', t.point_id, 'point_name', t.name,
                   'checks', t.n, 'total', t.s, 'avg', round(t.s / t.n, 2)) order by t.sort_order, t.name), '[]'::jsonb)
                 from (select c.point_id, p.name, p.sort_order, count(*) as n, sum(c.total) as s
                         from tandem.checks c join tandem.points p on p.id = c.point_id
                        where c.check_date between v_from and v_to and c.status = 'active'
                          and (not v_train or c.point_id = any(v_tp))
                        group by c.point_id, p.name, p.sort_order) t),
      -- Выручка по каналам и юрлицам за период
      'channels', (select jsonb_build_object(
          'cash', coalesce(sum(d.cash),0), 'kaspi_qr', coalesce(sum(d.kaspi_qr),0),
          'transfer', coalesce(sum(d.transfer),0), 'card', coalesce(sum(d.card),0))
        from tandem.daily_reports d where d.report_date between v_from and v_to and (not v_train or d.point_id = any(v_tp))),
      'by_legal', (select coalesce(jsonb_agg(jsonb_build_object(
          'legal', t.legal_entity, 'revenue', t.rev) order by t.rev desc), '[]'::jsonb)
        from (select p.legal_entity, sum(d.cash + d.kaspi_qr + d.transfer + d.card) rev
              from tandem.daily_reports d join tandem.points p on p.id = d.point_id
              where d.report_date between v_from and v_to and (not v_train or d.point_id = any(v_tp))
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
            where d.report_date between v_from and v_to and (not v_train or d.point_id = any(v_tp))
            union all
            select t.item_name, (t.issued - t.returned) q,
                   (t.issued - t.returned) * coalesce(t.price,0) amt, 0
            from tandem.takeout_lines t
            join tandem.daily_reports d on d.id = t.report_id
            where d.report_date between v_from and v_to and (not v_train or d.point_id = any(v_tp))
          ) u group by item_name order by amt desc limit 20
        ) t),
      -- Кто не сдал отчёт за вчера — по местной дате: ночью до 05:00 «вчера» по UTC — это позавчера.
      -- P5 (owner15): точка, у которой ещё не было ни одного отчёта до вчерашнего дня включительно, не
      -- начала работать в программе — в первые дни все точки шумели бы в «не сдали».
      'missing', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name) order by p.sort_order), '[]'::jsonb)
        from tandem.points p
        where p.active and (not v_train or p.id = any(v_tp))
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
                 and (not v_train or c.point_id = any(v_tp))
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
            where d.report_date between v_from and v_to and s.item_code is not null and (not v_train or d.point_id = any(v_tp))
            union all
            select t.item_code, (t.issued - t.returned), d.report_date
            from tandem.takeout_lines t join tandem.daily_reports d on d.id = t.report_id
            where d.report_date between v_from and v_to and t.item_code is not null and (not v_train or d.point_id = any(v_tp))
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
            when f.key = 'training' then 'код обучения (страница обучения)'   -- 0048
            else f.key end))
          order by f.n desc), '[]'::jsonb)
        from (select key, count(*) n, max(at) last from tandem.pin_failures where at > now() - interval '24 hours'
                 and (not v_train or key = any(v_tp) or key = 'training')   -- 0048: учебной сводке — только учебное
               group by key order by count(*) desc limit 30) f
        left join tandem.points p on p.id = f.key),
      -- Долги по реализации
      'realization', (select coalesce(jsonb_agg(jsonb_build_object(
          'name', c.name, 'debt', t.debt) order by t.debt desc), '[]'::jsonb)
        from (select client_id, sum(delivered - paid - returned) debt
              from tandem.realization_ledger group by client_id) t
        join tandem.realization_clients c on c.id = t.client_id
        where t.debt <> 0 and not v_train));   -- 0048: развоз — настоящие клиенты, учебной сводке не показывается
  end if;$a$,
$a$    -- Даты периода фронт шлёт местные; по умолчанию - местные же, не дата сервера (UTC).
    v_from := coalesce(tandem.to_date(payload->>'from'), v_today - 30);
    v_to   := coalesce(tandem.to_date(payload->>'to'), v_today);
    -- 0066: разделы сводки - в tandem.owner_dashboard. Какие точки: учебный код - только учебные (0048);
    -- экран собственника (only_real) - без учебных и служебных zz_*; вызов без признака (дымовые тесты) - все.
    return tandem.owner_dashboard(v_from, v_to,
      case when v_train then v_tp
           when coalesce(payload->>'only_real', '') = 'true'
             then array(select id from tandem.points where not training and id not like 'zz\_%') end,
      v_train, v_today);
  end if;$a$);

-- ---------------------------------------------------------------- public.tandem_office (по якорю, только corder_docs_save)
-- 7: «Акт по заказам клиентов» - действие склада (кладовщик): раздел stock, право акта проверяет office_corders
select pg_temp.patch66('public.tandem_office(text,jsonb)',
$a$    when action like 'cmenu%' or action like 'corder%' or action = 'client_settings_save' then 'clients'$a$,
$a$    when action = 'corder_docs_save' then 'stock'   -- 0066: акт по заказам клиентов - склад, право акта (doc:production) - в office_corders
    when action like 'cmenu%' or action like 'corder%' or action = 'client_settings_save' then 'clients'$a$);
select pg_temp.patch66('public.tandem_office(text,jsonb)',
$a$  elsif v_section = 'stock' then
    return tandem.office_stock(action, payload, v_user);$a$,
$a$  elsif v_section = 'stock' then
    if action = 'corder_docs_save' then return tandem.office_corders(action, payload, v_user); end if;   -- 0066
    return tandem.office_stock(action, payload, v_user);$a$);

-- ---------------------------------------------------------------- развоз водителя (15)
CREATE OR REPLACE FUNCTION public.tandem_realization(p_pin text, p_action text, p_data jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'tandem', 'public'
AS $function$
declare
  v_owner  text;
  v_driver text;
  v_who    text;
  v_uid    uuid;
  v_date   date;
  v_lbl    text;
  v_id     bigint;   -- 0066: отмена записи
  v_reason text;
begin
  select value into v_owner  from tandem.settings where key = 'owner_pin';
  select value into v_driver from tandem.settings where key = 'driver_pin';
  if p_pin = v_owner then v_who := 'собственник';
  elsif p_pin = v_driver then v_who := 'водитель';
  else return jsonb_build_object('ok', false, 'error', 'Нет доступа');
  end if;

  if p_action = 'list' then
    return jsonb_build_object('ok', true,
      -- 0066: запись, отменённую собственником, в долг не считаем
      'clients', (select coalesce(jsonb_agg(jsonb_build_object(
          'id', c.id, 'name', c.name,
          'debt', coalesce(t.debt, 0)) order by c.sort_order), '[]'::jsonb)
        from tandem.realization_clients c
        left join (select client_id, sum(delivered - paid - returned) debt
                   from tandem.realization_ledger where cancelled_at is null group by client_id) t on t.client_id = c.id
        where c.active),
      'recent', (select coalesce(jsonb_agg(jsonb_build_object(
          'id', l.id, 'date', l.entry_date, 'client', c.name, 'delivered', l.delivered,
          'paid', l.paid, 'returned', l.returned, 'note', l.note, 'by', l.created_by,
          'cancelled_at', l.cancelled_at, 'cancel_reason', l.cancel_reason, 'cancelled_by', l.cancelled_by)
          order by l.entry_date desc, l.id desc), '[]'::jsonb)
        from (select * from tandem.realization_ledger order by entry_date desc, id desc limit 30) l
        join tandem.realization_clients c on c.id = l.client_id),
      'can_cancel', v_who = 'собственник');
  end if;

  if p_action = 'add' then
    -- uid записи генерирует устройство (crypto.randomUUID): ответ потерялся, водитель нажал ещё раз —
    -- вторая строка не появляется, долг клиента не задваивается.
    if nullif(btrim(coalesce(p_data->>'uid', '')), '') is not null then
      begin v_uid := (p_data->>'uid')::uuid;
      exception when others then
        return jsonb_build_object('ok', false, 'error', 'Неверный номер записи (uid)');
      end;
    end if;
    if nullif(btrim(coalesce(p_data->>'date', '')), '') is not null then
      v_date := tandem.to_date(p_data->>'date');
      if v_date is null then return jsonb_build_object('ok', false, 'error', 'Неверная дата'); end if;
    end if;
    select f.label into v_lbl from (values (1, 'Отвёз по накладной'::text, p_data->>'delivered'),
        (2, 'Принял деньгами', p_data->>'paid'), (3, 'Возврат продукции', p_data->>'returned')) f(n, label, val)
     where not tandem.num_ok(f.val) order by f.n limit 1;
    if v_lbl is not null then
      return jsonb_build_object('ok', false, 'error', 'Неверное число в поле «' || v_lbl || '»'); end if;
    -- 0066: запись из одних нулей ничего не говорит о долге - отказ (экран её не пускал, сервер принимал)
    if coalesce(tandem.to_num(p_data->>'delivered'), 0) = 0 and coalesce(tandem.to_num(p_data->>'paid'), 0) = 0
       and coalesce(tandem.to_num(p_data->>'returned'), 0) = 0 then
      return jsonb_build_object('ok', false, 'error', 'Введите хотя бы одну сумму'); end if;
    if not exists (select 1 from tandem.realization_clients where id = p_data->>'client_id') then
      return jsonb_build_object('ok', false, 'error', 'Выберите, куда возили'); end if;
    insert into tandem.realization_ledger (uid, entry_date, client_id, delivered, paid, returned, note, created_by)
    values (
      v_uid,
      coalesce(v_date, tandem.local_now()::date),
      p_data->>'client_id',
      coalesce(tandem.to_num(p_data->>'delivered'), 0),
      coalesce(tandem.to_num(p_data->>'paid'), 0),
      coalesce(tandem.to_num(p_data->>'returned'), 0),
      left(nullif(p_data->>'note',''), 500),
      v_who)
    on conflict (uid) do nothing;
    return public.tandem_realization(p_pin, 'list');
  end if;

  -- 0066 (находка 15): ошибочную запись водителя отменяет собственник с причиной. Запись остаётся в списке с
  -- пометкой и в долг больше не входит; повторная отмена (ответ потерялся) - не ошибка, причина остаётся первой.
  if p_action = 'cancel' then
    if v_who <> 'собственник' then
      return jsonb_build_object('ok', false, 'error', 'Отменить запись развоза может только собственник', 'code', 'forbidden'); end if;
    v_reason := left(nullif(btrim(coalesce(p_data->>'reason', '')), ''), 300);
    if v_reason is null then return jsonb_build_object('ok', false, 'error', 'Укажите причину отмены'); end if;
    v_id := case when coalesce(p_data->>'id', '') ~ '^[0-9]{1,18}$' then (p_data->>'id')::bigint end;
    update tandem.realization_ledger set cancelled_at = coalesce(cancelled_at, now()),
           cancel_reason = coalesce(cancel_reason, v_reason), cancelled_by = coalesce(cancelled_by, v_who)
     where id = v_id;
    if not found then return jsonb_build_object('ok', false, 'error', 'Запись не найдена - обновите список'); end if;
    return public.tandem_realization(p_pin, 'list');
  end if;

  return jsonb_build_object('ok', false, 'error', 'Неизвестное действие');
end;
$function$;

-- ---------------------------------------------------------------- заявки точек (2, 3, 13, 18)
CREATE OR REPLACE FUNCTION tandem.order_save(p_point text, payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'tandem', 'public'
AS $function$
declare
  v_date date;
  v_id   bigint;
  v_bad  text;
begin
  begin v_date := (payload->>'for_date')::date; exception when others then v_date := null; end;
  if v_date is null then return jsonb_build_object('ok', false, 'error', 'Не указан день заявки'); end if;
  -- Заявки дня и создание документов по ним идут по очереди: иначе правка, сохранённая в момент
  -- создания перемещений, в них бы не попала.
  perform pg_advisory_xact_lock(hashtext('tandem.orders:' || v_date::text));
  if tandem.order_locked(v_date) then
    return jsonb_build_object('ok', false, 'error', 'План на этот день уже передан в производство — заявку не изменить. Позвоните на кухню.'); end if;
  if not tandem.order_open(v_date) then
    return jsonb_build_object('ok', false, 'error', 'Приём заявок на этот день закрыт (отсечка ' ||
      coalesce((select value from tandem.settings where key = 'orders_cutoff'), '20:00') || '). Подайте на следующий день.'); end if;
  if jsonb_typeof(payload->'lines') is distinct from 'array' then
    return jsonb_build_object('ok', false, 'error', 'Нет строк заявки'); end if;
  if exists (select 1 from jsonb_array_elements(payload->'lines') x
              where coalesce(x->>'qty', '') !~ '^[0-9]+([.][0-9]+)?$' or (x->>'qty')::numeric <= 0
                 or nullif(btrim(coalesce(x->>'item_code', '')), '') is null) then
    return jsonb_build_object('ok', false, 'error', 'В каждой строке — позиция и количество больше нуля'); end if;
  select string_agg(coalesce(i.name, x->>'item_code'), ', ') into v_bad
    from jsonb_array_elements(payload->'lines') x
    left join tandem.items i on i.code = x->>'item_code' and i.active and i.for_sale
   where i.code is null;
  if v_bad is not null then return jsonb_build_object('ok', false, 'error', 'Позиции нет в продаже: ' || v_bad); end if;
  -- 0066 (находка 13): только позиции из меню этой точки - тот же отбор, что у экрана заявки (действие items)
  select string_agg(i.name, ', ' order by i.name) into v_bad
    from jsonb_array_elements(payload->'lines') x join tandem.items i on i.code = x->>'item_code'
   where not tandem.point_menu_ok(p_point, i.code);
  if v_bad is not null then
    return jsonb_build_object('ok', false, 'error', 'Этих позиций нет в меню точки: ' || v_bad || '. Обновите страницу заявки'); end if;
  -- Штучное — только целыми: полтора беляша не испечь.
  select string_agg(i.name, ', ') into v_bad
    from jsonb_array_elements(payload->'lines') x join tandem.items i on i.code = x->>'item_code'
   where i.unit_id in ('шт', 'порц') and (x->>'qty')::numeric <> trunc((x->>'qty')::numeric);
  if v_bad is not null then return jsonb_build_object('ok', false, 'error', 'Штучные позиции — только целым числом: ' || v_bad); end if;

  if jsonb_array_length(payload->'lines') = 0 then
    delete from tandem.orders where point_id = p_point and for_date = v_date;
    return tandem.order_get(p_point, v_date);
  end if;
  insert into tandem.orders (point_id, for_date, sent_by, comment)
    values (p_point, v_date, nullif(btrim(coalesce(payload->>'sent_by', '')), ''), nullif(btrim(coalesce(payload->>'comment', '')), ''))
    on conflict (point_id, for_date) do update set sent_by = excluded.sent_by, comment = excluded.comment, updated_at = now()
    returning id into v_id;
  delete from tandem.order_lines where order_id = v_id;
  insert into tandem.order_lines (order_id, item_code, qty)
    select v_id, x->>'item_code', sum((x->>'qty')::numeric) from jsonb_array_elements(payload->'lines') x group by x->>'item_code';
  return tandem.order_get(p_point, v_date);
end $function$;

-- 3, 18: кто смотрит план - по сессии запроса (tandem_gate кладёт токен бэк-офиса в tandem.token): учебная учётка
-- видит только учебные точки и документы учебной кухни, настоящий пользователь - без них. Вызов без сессии - как
-- настоящий. Склад кухни в ответе - свой у каждого (2).
CREATE OR REPLACE FUNCTION tandem.orders_report(p_for_date date)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'tandem', 'public'
AS $function$
  with me as (select coalesce((tandem.office_session(nullif(current_setting('tandem.token', true), ''))).training, false) as tr)
  select jsonb_build_object('ok', true, 'for_date', p_for_date, 'open', tandem.order_open(p_for_date), 'locked', tandem.order_locked(p_for_date),
    'cutoff', coalesce((select value from tandem.settings where key = 'orders_cutoff'), '20:00'),
    'store_id', (select value from tandem.settings where key = case when me.tr then 'training_orders_store_id' else 'orders_store_id' end),
    'orders', (select coalesce(jsonb_agg(jsonb_build_object('point_id', o.point_id, 'point_name', p.name, 'sent_by', o.sent_by,
        'comment', o.comment, 'updated_at', o.updated_at, 'has_store', p.default_store_id is not null,
        'lines', (select count(*) from tandem.order_lines l where l.order_id = o.id)) order by p.sort_order), '[]'::jsonb)
      from tandem.orders o join tandem.points p on p.id = o.point_id where o.for_date = p_for_date and p.training = me.tr),
    'plan', (select coalesce(jsonb_agg(jsonb_build_object('item_code', x.item_code, 'name', i.name, 'unit', i.unit_id, 'qty', x.q,
        'fact', pl.fact_qty, 'has_chart', tandem.active_chart(x.item_code, p_for_date) is not null, 'by_point', x.byp) order by i.name), '[]'::jsonb)
      from (select l.item_code, sum(l.qty) q, jsonb_object_agg(o.point_id, l.qty) byp
              from tandem.order_lines l join tandem.orders o on o.id = l.order_id
              join tandem.points p on p.id = o.point_id
             where o.for_date = p_for_date and p.training = me.tr group by l.item_code) x
      join tandem.items i on i.code = x.item_code
      left join tandem.order_plan pl on pl.for_date = p_for_date and pl.item_code = x.item_code),
    'docs', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'number', d.number, 'doc_type', d.doc_type, 'status', d.status,
        'source_id', d.source_id) order by d.doc_type, d.number), '[]'::jsonb)
      from tandem.documents d where d.source_kind = 'orders' and d.source_id like p_for_date::text || '/%'
       and coalesce((select s.training from tandem.stores s where s.id = d.store_from), false) = me.tr),
    -- 0051: заказы клиентов дня — по позициям (колонка «Клиенты») и списком
    'clients', (select coalesce(jsonb_agg(jsonb_build_object('item_code', x.item_code, 'name', i.name, 'unit', i.unit_id, 'qty', x.q,
        'in_act', x.q_act, 'has_chart', tandem.active_chart(x.item_code, p_for_date) is not null) order by i.name), '[]'::jsonb)
      from (select l.item_code, sum(l.qty) q, coalesce(sum(l.qty) filter (where (o.production_doc is not null or o.act_at is not null)), 0) q_act
              from tandem.client_order_lines l join tandem.client_orders o on o.id = l.order_id
              join tandem.points p on p.id = o.point_id
             where o.for_date = p_for_date and o.status = any(tandem.corder_kitchen()) and p.training = me.tr group by l.item_code) x
      join tandem.items i on i.code = x.item_code),
    'client_orders', (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'no', o.no, 'point_id', o.point_id, 'point_name', p.name,
        'kind', o.kind, 'ready_by', to_char(o.ready_by, 'HH24:MI'), 'status', o.status, 'status_name', tandem.corder_status_name(o.status),
        'in_act', (o.production_doc is not null or o.act_at is not null), 'client_name', o.client_name,
        'lines', (select jsonb_agg(jsonb_build_object('title', l.title, 'qty', l.qty, 'unit', l.unit) order by l.id)
                    from tandem.client_order_lines l where l.order_id = o.id)) order by o.ready_by, o.no), '[]'::jsonb)
      from tandem.client_orders o join tandem.points p on p.id = o.point_id
     where o.for_date = p_for_date and o.status = any(tandem.corder_kitchen()) and p.training = me.tr))
  from me
$function$;

-- 2, 3: документы плана - только заявки «своих» точек (учебная учётка - учебных, настоящий пользователь - рабочих);
-- склад кухни по умолчанию - свой: training_orders_store_id у учебной учётки, orders_store_id у настоящей.
CREATE OR REPLACE FUNCTION tandem.orders_make_docs(p_for_date date, p_user tandem.users, p_force boolean DEFAULT false, p_store uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'tandem', 'public'
AS $function$
declare
  v_tr    boolean := coalesce(p_user.training, false);   -- 0066: чей план - учебный или рабочий
  v_store uuid := coalesce(p_store, nullif((select value from tandem.settings
                                             where key = case when coalesce(p_user.training, false) then 'training_orders_store_id' else 'orders_store_id' end), '')::uuid);
  v_lines jsonb;
  v_r     jsonb;
  v_made  int := 0;
  v_skip  text := '';
  v_bad   text;
  pt      record;
begin
  perform pg_advisory_xact_lock(hashtext('tandem.orders:' || p_for_date::text));
  if p_store is not null and not exists (select 1 from tandem.stores where id = p_store and active) then
    return tandem.err('validation', 'Склад кухни не найден или выключен'); end if;
  if v_store is null or not exists (select 1 from tandem.stores where id = v_store and active) then
    return tandem.err('validation', case when v_tr then 'Не выбран учебный склад кухни для учебных заявок - попросите администратора'
                                         else 'Не выбран склад кухни, с которого отгружаются заявки' end); end if;
  if not exists (select 1 from tandem.orders o join tandem.points p on p.id = o.point_id where o.for_date = p_for_date and p.training = v_tr) then
    return tandem.err('validation', 'На этот день заявок нет'); end if;
  if tandem.order_open(p_for_date) and not p_force then
    return tandem.err('validation', 'Приём заявок на этот день ещё открыт — точки могут поправить заявки. Создать документы всё равно?'); end if;
  -- Дробный выпуск штучных, отмеченный до 0041, при раскладке тихо терялся — пусть его исправят.
  select string_agg(i.name, ', ' order by i.name) into v_bad
    from tandem.order_plan pl join tandem.items i on i.code = pl.item_code
   where pl.for_date = p_for_date and i.unit_id in ('шт', 'порц') and pl.fact_qty <> trunc(pl.fact_qty);
  if v_bad is not null then
    return tandem.err('validation', 'Штучные позиции — выпуск только целым числом, исправьте выпуск: ' || v_bad); end if;

  create temp table if not exists _ord_alloc (point_id text, item_code text, qty numeric) on commit drop;
  truncate _ord_alloc;
  insert into _ord_alloc
  with b as (
    select o.point_id, l.item_code, l.qty, pl.fact_qty, i.unit_id in ('шт', 'порц') as whole,
           sum(l.qty) over (partition by l.item_code) as total
      from tandem.order_lines l join tandem.orders o on o.id = l.order_id
      join tandem.points tp on tp.id = o.point_id
      join tandem.items i on i.code = l.item_code
      left join tandem.order_plan pl on pl.for_date = p_for_date and pl.item_code = l.item_code
     where o.for_date = p_for_date and tp.training = v_tr
  ), e as (
    select *, case when fact_qty is null then qty else qty * fact_qty / total end as exact from b
  ), f as (
    -- База: заявка как есть, если выпуск не отмечен; иначе доля выпуска — у штучных целая часть, у весовых
    -- с точностью 0,001 вниз. Остаток выпуска раздаётся ниже шагом 1 или 0,001 тем, у кого отброшенная
    -- часть больше, — сумма по точкам равна выпуску (у весовых прежде терялось до 0,001 на точку).
    select *, case when fact_qty is null then round(exact, 3)
                   when whole then floor(exact)
                   else trunc(exact, 3) end as base from e
  ), r as (
    select *, row_number() over (partition by item_code order by exact - base desc, point_id) as rn,
           case when fact_qty is null then 0
                when whole then fact_qty - sum(base) over (partition by item_code)
                else round((fact_qty - sum(base) over (partition by item_code)) * 1000) end as rest
      from f
  )
  select point_id, item_code, base + case when rn <= rest then case when whole then 1 else 0.001 end else 0 end from r;

  -- Документы плана датируются днём плана, а он бывает и позже завтрашнего: окно дат doc_save
  -- (не позже завтра) на время этого вызова открыто. Настройка живёт до конца транзакции,
  -- и выставить её можно только изнутри базы — через бэк-офис её не передать.
  perform set_config('tandem.orders_docs', '1', true);

  if not exists (select 1 from tandem.documents where source_kind = 'orders' and source_id = p_for_date::text || '/production') then
    select coalesce(jsonb_agg(jsonb_build_object('item_code', x.item_code, 'qty', x.q)), '[]'::jsonb) into v_lines
      from (select a.item_code, sum(a.qty) q from _ord_alloc a
             where tandem.active_chart(a.item_code, p_for_date) is not null group by a.item_code) x where x.q > 0;
    if jsonb_array_length(v_lines) > 0 then
      v_r := tandem.office_stock('doc_save', jsonb_build_object('doc_type', 'production', 'doc_date', p_for_date,
               'store_from', v_store, 'comment', 'План выпечки на ' || to_char(p_for_date, 'DD.MM.YYYY'), 'lines', v_lines), p_user);
      if not coalesce((v_r->>'ok')::boolean, false) then
        raise exception using errcode = 'P0001', message = 'Акт производства не создан: ' || coalesce(v_r->>'message', v_r->>'error', 'ошибка'); end if;
      update tandem.documents set source_kind = 'orders', source_id = p_for_date::text || '/production' where id = (v_r->>'id')::uuid;
      -- Строки «готовым» (кухня — склад точки) ставит проведение акта, а не черновик (второй круг V4).
      v_made := v_made + 1;
    end if;
  end if;

  for pt in select o.point_id, p.name, p.default_store_id from tandem.orders o join tandem.points p on p.id = o.point_id
             where o.for_date = p_for_date and p.training = v_tr order by p.sort_order loop
    continue when exists (select 1 from tandem.documents where source_kind = 'orders' and source_id = p_for_date::text || '/' || pt.point_id);
    if pt.default_store_id is null or pt.default_store_id = v_store then
      v_skip := v_skip || case when v_skip = '' then '' else ', ' end || pt.name; continue; end if;
    select coalesce(jsonb_agg(jsonb_build_object('item_code', item_code, 'qty', qty)), '[]'::jsonb) into v_lines
      from _ord_alloc where point_id = pt.point_id and qty > 0;
    continue when jsonb_array_length(v_lines) = 0;
    v_r := tandem.office_stock('doc_save', jsonb_build_object('doc_type', 'transfer', 'doc_date', p_for_date,
             'store_from', v_store, 'store_to', pt.default_store_id, 'comment', 'Заявка «' || pt.name || '» на ' || to_char(p_for_date, 'DD.MM.YYYY'),
             'lines', v_lines), p_user);
    if not coalesce((v_r->>'ok')::boolean, false) then
      raise exception using errcode = 'P0001', message = 'Перемещение для «' || pt.name || '» не создано: ' || coalesce(v_r->>'message', v_r->>'error', 'ошибка'); end if;
    update tandem.documents set source_kind = 'orders', source_id = p_for_date::text || '/' || pt.point_id where id = (v_r->>'id')::uuid;
    -- Позиции с картой склад точки получает готовыми с дня плана — строку ставит проведение перемещения
    -- по его фактическим строкам, а не черновик (второй круг V4).
    v_made := v_made + 1;
  end loop;
  perform set_config('tandem.orders_docs', '', true);
  return jsonb_build_object('ok', true, 'made', v_made, 'skipped', nullif(v_skip, ''));
end $function$;

-- 2: учебный план - на свой склад кухни: присланный (p_store) или settings.training_orders_store_id, и он должен
-- быть учебным. Рабочая настройка orders_store_id обучению больше не нужна (раньше её держали на учебной кухне
-- ради уроков, и настоящий план шёл с учебного склада). День с настоящими заявками учебной учётке по-прежнему
-- закрыт: выпуск (order_plan) и документы плана у дня общие.
CREATE OR REPLACE FUNCTION tandem.training_orders_ok(p_date date, p_store uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'tandem', 'public'
AS $function$
  select coalesce((select s.training from tandem.stores s
                    where s.id::text = coalesce(p_store::text, (select value from tandem.settings where key = 'training_orders_store_id'))), false)
     and not exists (select 1 from tandem.orders o
                       join tandem.points p on p.id = o.point_id
                       left join tandem.stores st on st.id = p.default_store_id
                      where o.for_date = p_date and (not p.training or not coalesce(st.training, true)))
$function$;

-- ---------------------------------------------------------------- заказы клиентов (8, 14, 17, 19)
-- 17: незакрытый заказ виден кассе на любую дату (заказ с предоплатой на месяц вперёд), закрытые - за окно дней
CREATE OR REPLACE FUNCTION tandem.corder_list(p_point text, p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'tandem', 'public'
AS $function$
  select jsonb_build_object('ok', true, 'orders', coalesce(jsonb_agg(tandem.corder_json(o.id)
           order by (o.status = 'new') desc, o.for_date, o.ready_by, o.no), '[]'::jsonb))
    from tandem.client_orders o
   where (p_point is null or o.point_id = p_point)
     and (o.for_date between p_from and p_to
          or o.status <> all(array['delivered', 'issued', 'rejected', 'cancelled', 'not_collected']))   -- 0066: незакрытый - на любую дату
$function$;

CREATE OR REPLACE FUNCTION tandem.corder_point(action text, p_point text, payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'tandem', 'public'
AS $function$
declare
  v_by    text := coalesce(left(nullif(btrim(coalesce(payload->>'seller', '')), ''), 100), 'Точка');
  v_today date := tandem.local_now()::date;
  v_id    bigint := tandem.to_num(payload->>'id')::bigint;
  -- 0066 (находка 14): меню заказов бота и стоп-лист - только точкам выдачи (client_pickup_points) и служебным
  -- zz_* (дымовой тест, как в corder_check): касса другой точки не снимает позиции у бота
  v_pickup boolean := coalesce(p_point = any(string_to_array(replace(tandem.setting('client_pickup_points', 'eneshka'), ' ', ''), ','))
                               or left(coalesce(p_point, ''), 3) = 'zz_', false);
begin
  -- 0066 (находки 11, 14): касса узнаёт, точка ли она выдачи (кнопка «Стоп-лист»), и незакрытую смену прошлых дней
  if action = 'corder_list' then
    return tandem.corder_list(p_point, v_today - 1, v_today + 14)
      || jsonb_build_object('pickup', v_pickup, 'open_shift', tandem.report_hints(p_point, v_today)->'open_shift');
  end if;
  if action = 'corder_get' then
    if not exists (select 1 from tandem.client_orders where id = v_id and point_id = p_point) then
      return tandem.err('not_found', 'Заказ не найден'); end if;
    return jsonb_build_object('ok', true, 'order', tandem.corder_json(v_id));
  end if;
  if action = 'corder_status' then return tandem.corder_set_status(v_id, payload->>'to', 'point', v_by, payload, p_point); end if;
  if action = 'corder_edit' then return tandem.corder_edit(v_id, payload - 'pin' - 'point_id' - 'seller' - 'id', 'point', v_by, p_point); end if;
  if action in ('cmenu_point_list', 'cmenu_stop') and not v_pickup then
    return tandem.err('forbidden', 'Меню заказов и стоп-лист - только у точки выдачи заказов'); end if;
  if action = 'cmenu_point_list' then
    return jsonb_build_object('ok', true, 'rows', coalesce((select jsonb_agg(tandem.cmenu_json(m) - 'kassa_price' order by m.section, m.sort_order, m.title_ru)
                                                             from tandem.order_menu m where m.active and m.price_checked_at is not null), '[]'::jsonb));
  end if;
  if action = 'cmenu_stop' then return tandem.cmenu_stop(payload->>'item_code', payload->>'until', 'точка: ' || v_by); end if;
  return tandem.err('unknown_action', 'Неизвестное действие: ' || action);
end $function$;

-- 8: правка заказа продавцом. Правкой считается только то, что действительно меняется (касса шлёт изменённые
-- поля; поле с прежним значением правкой не считается):
--  - адрес и комментарий - без проверок нового заказа;
--  - прежние строки остаются с той ценой, по которой заказ приняли; правила меню заказов (в меню, цена сверена,
--    шаг, минимум, стоп) - для новой позиции и для увеличения количества; уменьшить или убрать строку можно всегда;
--  - новая дата и новое время - по правилам приёма заказов (окно дней, часы, «сегодня - не раньше»); прежние дата
--    и время по текущим часам не перепроверяются: заказ уже принят;
--  - заказ с предоплатой и заказ в акте производства - только адрес и комментарий.
CREATE OR REPLACE FUNCTION tandem.corder_edit(p_id bigint, payload jsonb, p_kind text, p_by text, p_point text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'tandem', 'public'
AS $function$
declare
  o        tandem.client_orders;
  v_by     text := left(nullif(btrim(coalesce(p_by, '')), ''), 100);
  v_now    timestamp := tandem.local_now();
  v_today  date := v_now::date;
  v_from   time := tandem.setting('client_hours_from', '09:00')::time;
  v_to     time := tandem.setting('client_hours_to', '18:00')::time;
  v_cut    time := tandem.setting('client_fresh_cutoff', '12:00')::time;
  v_fready time := tandem.setting('client_fresh_ready', '18:00')::time;
  v_mins   int := tandem.setting('stock_ready_minutes', '120')::int;
  v_days   int := tandem.setting('client_max_days_ahead', '14')::int;
  v_min    numeric := tandem.setting('client_min_order', '7000')::numeric;
  v_rule   text := tandem.setting('client_prepay_rule', 'off');
  v_date   date;
  v_ready  time;
  v_kind   text;
  v_addr   text;
  v_in     jsonb;
  v_lines  jsonb := '[]'::jsonb;
  v_total  numeric := 0;
  v_fresh  boolean := false;
  v_stock  boolean := false;
  v_first  timestamp;
  v_qty    numeric;
  v_dch    boolean;
  v_tch    boolean;
  v_kch    boolean;
  v_lch    boolean := false;
  v_big    boolean;
  v_old    jsonb;
  x        jsonb;
  m        record;
  pl       tandem.client_order_lines;
begin
  select * into o from tandem.client_orders where id = p_id for update;
  if o.id is null or (p_point is not null and o.point_id <> p_point) then return tandem.err('not_found', 'Заказ не найден'); end if;
  if v_by is null then return tandem.err('validation', 'Кто правит - имя обязательно'); end if;
  if o.status not in ('new', 'awaiting_prepay', 'paid', 'confirmed') then
    return tandem.err('validation', 'Заказ уже готовится - правка только словами с кухней'); end if;

  -- что меняется: дата, время, способ получения, строки
  if nullif(btrim(coalesce(payload->>'for_date', '')), '') is null then v_date := o.for_date;
  else
    v_date := tandem.to_date(btrim(payload->>'for_date'));
    if v_date is null then return tandem.err('validation', 'Дата заказа - в виде ГГГГ-ММ-ДД'); end if;
  end if;
  if nullif(btrim(coalesce(payload->>'ready_by', '')), '') is null then v_ready := o.ready_by;
  else
    begin v_ready := (btrim(payload->>'ready_by'))::time; exception when others then v_ready := null; end;
    if v_ready is null then return tandem.err('validation', 'Время готовности - в виде ЧЧ:ММ'); end if;
  end if;
  v_kind := coalesce(nullif(btrim(coalesce(payload->>'kind', '')), ''), o.kind);
  if v_kind not in ('delivery', 'pickup') then return tandem.err('validation', 'Способ получения - доставка или самовывоз'); end if;
  v_old := (select jsonb_agg(jsonb_build_object('item_code', item_code, 'qty', qty) order by id) from tandem.client_order_lines where order_id = o.id);
  if payload ? 'lines' then
    if jsonb_typeof(payload->'lines') is distinct from 'array' or jsonb_array_length(payload->'lines') = 0 then
      return tandem.err('validation', 'В заказе нет позиций'); end if;
    v_in := payload->'lines';
    -- набор «позиция: количество» (количество - как хранится, до 0,001) против прежнего
    v_lch := (select string_agg(s, ',' order by s) from (
                select coalesce(je->>'item_code', '') || ':' || coalesce(trim_scale(round(tandem.to_num(je->>'qty'), 3))::text, '?') s
                  from jsonb_array_elements(v_in) je) a)
             is distinct from
             (select string_agg(s, ',' order by s) from (
                select l.item_code || ':' || trim_scale(l.qty)::text s from tandem.client_order_lines l where l.order_id = o.id) b);
  else
    v_in := v_old;
  end if;
  v_dch := v_date is distinct from o.for_date;
  v_tch := v_ready is distinct from o.ready_by;
  v_kch := v_kind is distinct from o.kind;
  v_big := v_dch or v_tch or v_kch or v_lch;
  -- сумма, о которой клиенту написали реквизиты или которую он уже оплатил, не меняется: только адрес и комментарий
  if v_big and o.status in ('awaiting_prepay', 'paid') then
    return tandem.err('validation', 'Заказ с предоплатой: состав, дату и время не правим - отмените и оформите заново'); end if;
  if v_big and (o.production_doc is not null or o.act_at is not null) then
    return tandem.err('validation', 'Заказ уже в акте производства - состав и время не правятся'); end if;
  -- адрес: присланный непустой или прежний; у доставки обязателен
  if v_kind = 'delivery' and payload ? 'address' and nullif(btrim(coalesce(payload->>'address', '')), '') is null then
    return tandem.err('validation', 'Для доставки нужен адрес'); end if;
  v_addr := coalesce(left(nullif(btrim(coalesce(payload->>'address', '')), ''), 300), o.address);
  if v_kind = 'delivery' and v_addr is null then return tandem.err('validation', 'Для доставки нужен адрес'); end if;

  if not v_big then
    update tandem.client_orders set address = v_addr,
           comment = coalesce(left(nullif(btrim(coalesce(payload->>'comment', '')), ''), 500), comment), updated_at = now()
     where id = o.id;
  else
    if v_dch and (v_date < v_today or v_date > v_today + v_days) then
      return tandem.err('validation', format('Дата заказа - с сегодняшнего дня и не дальше %s дней', v_days)); end if;
    if v_tch and (v_ready < v_from or v_ready > v_to) then
      return tandem.err('validation', format('Время готовности - с %s до %s', to_char(v_from, 'HH24:MI'), to_char(v_to, 'HH24:MI'))); end if;
    for x in select * from jsonb_array_elements(v_in) loop
      v_qty := round(tandem.to_num(x->>'qty'), 3);
      select * into pl from tandem.client_order_lines l where l.order_id = o.id and l.item_code = x->>'item_code' order by l.id limit 1;
      select mm.*, (i.active and i.for_sale and not i.training) as sellable into m
        from tandem.order_menu mm join tandem.items i on i.code = mm.item_code
       where mm.item_code = x->>'item_code';
      if exists (select 1 from jsonb_array_elements(v_lines) l where l->>'item_code' = x->>'item_code') then
        return tandem.err('validation', format('«%s» указан дважды', coalesce(pl.title, m.title_ru, x->>'item_code'))); end if;
      if v_qty is null or v_qty <= 0 then
        return tandem.err('validation', format('Количество «%s» - число больше нуля', coalesce(pl.title, m.title_ru, x->>'item_code'))); end if;
      -- новая позиция или больше прежнего - только из меню заказов, как у нового заказа
      if (pl.id is null or v_qty > pl.qty)
         and (m.item_code is null or not m.active or m.price_checked_at is null or not m.sellable) then
        return tandem.err('validation', 'Позиции нет в меню заказов: ' || coalesce(pl.title, x->>'item_code', '-')); end if;
      if coalesce(m.unit_label, pl.unit) <> 'кг' and v_qty <> trunc(v_qty) then
        return tandem.err('validation', format('«%s» - только целым числом', coalesce(pl.title, m.title_ru))); end if;
      if v_qty is distinct from pl.qty and m.item_code is not null then
        if v_qty < m.min_qty then
          return tandem.err('validation', format('Минимум «%s» - %s %s', m.title_ru, replace(trim_scale(m.min_qty)::text, '.', ','), m.unit_label)); end if;
        if abs(round((v_qty - m.min_qty) / m.step) * m.step - (v_qty - m.min_qty)) > 0.0005 then
          return tandem.err('validation', format('«%s» - шагом %s %s от %s', m.title_ru, replace(trim_scale(m.step)::text, '.', ','), m.unit_label,
                                                 replace(trim_scale(m.min_qty)::text, '.', ','))); end if;
      end if;
      -- стоп на дату заказа: добавить или увеличить позицию на стопе нельзя, перенести заказ на день её стопа - тоже
      if m.stop_until is not null and m.stop_until >= v_date and (pl.id is null or v_qty > pl.qty or v_dch) then
        return tandem.err('stopped', format('«%s» на %s нет', coalesce(m.title_ru, pl.title), to_char(v_date, 'DD.MM'))); end if;
      v_fresh := v_fresh or coalesce(m.ready_kind, 'stock') = 'fresh';
      v_stock := v_stock or coalesce(m.ready_kind, 'stock') = 'stock';
      -- цена: у прежней позиции - та, по которой заказ приняли; у новой - цена меню заказов
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('item_code', x->>'item_code',
        'title', coalesce(pl.title, m.title_ru), 'unit', coalesce(pl.unit, m.unit_label), 'qty', v_qty,
        'price', coalesce(pl.price, m.price), 'sum', round(v_qty * coalesce(pl.price, m.price), 2)));
      v_total := v_total + round(v_qty * coalesce(pl.price, m.price), 2);
    end loop;
    -- новые дата или время на сегодня - «не раньше», как у нового заказа
    if (v_dch or v_tch) and v_date = v_today then
      if v_fresh and (v_now::time >= v_cut or v_ready < v_fready) then
        return tandem.err('slot', format('Свежие пироги на сегодня - заказ до %s, готовность к %s. Позже - на завтра',
                                         to_char(v_cut, 'HH24:MI'), to_char(v_fready, 'HH24:MI'))); end if;
      v_first := greatest(v_now, v_today + v_from) + make_interval(mins => v_mins);
      if v_stock and v_first > v_today + v_to then
        return tandem.err('slot', 'Сегодня уже не успеем - выберите завтра'); end if;
      if v_stock and v_today + v_ready < v_first then
        return tandem.err('slot', format('Сегодня - не раньше %s', to_char(v_first, 'HH24:MI'))); end if;
    end if;
    -- доставка - от суммы минимального заказа, если меняли состав или способ получения
    if v_kind = 'delivery' and (v_lch or v_kch) and v_total < v_min then
      return tandem.err('min_order', format('Доставка - от %s ₸, в заказе %s ₸. Можно забрать самому', trim_scale(v_min), trim_scale(v_total))); end if;
    update tandem.client_orders set kind = v_kind, for_date = v_date, ready_by = v_ready,
           address = case when v_kind = 'delivery' then v_addr end, total = v_total,
           prepay_suggested = (v_rule = 'fresh' and v_fresh) or (v_rule like 'from\_sum:%' and v_total >= substr(v_rule, 10)::numeric),
           comment = coalesce(left(nullif(btrim(coalesce(payload->>'comment', '')), ''), 500), comment), updated_at = now()
     where id = o.id;
    delete from tandem.client_order_lines where order_id = o.id;
    insert into tandem.client_order_lines (order_id, item_code, title, unit, qty, price, sum)
      select o.id, l->>'item_code', l->>'title', l->>'unit', (l->>'qty')::numeric, (l->>'price')::numeric, (l->>'sum')::numeric
        from jsonb_array_elements(v_lines) l;
  end if;
  -- в журнале - что было и что стало: деньги и текст бота восстанавливаются по журналу
  perform tandem.corder_event(o.id, o.status, o.status, p_kind, v_by, (select jsonb_strip_nulls(jsonb_build_object('edited', true,
    'total_from', o.total, 'total_to', n.total, 'lines_from', v_old,
    'lines_to', (select jsonb_agg(jsonb_build_object('item_code', item_code, 'qty', qty) order by id) from tandem.client_order_lines where order_id = o.id),
    'for_date_from', o.for_date, 'for_date_to', n.for_date, 'ready_by_from', to_char(o.ready_by, 'HH24:MI'), 'ready_by_to', to_char(n.ready_by, 'HH24:MI'),
    'address_from', o.address, 'address_to', n.address)) from tandem.client_orders n where n.id = o.id));
  return jsonb_build_object('ok', true, 'order', tandem.corder_json(o.id));
end $function$;

-- 19: отказ создания акта по заказам клиентов (doc_save) - понятной причиной, а не «Ошибка базы данных»: всё
-- сделанное вызовом откатывается, человек видит, что не так (как у документов плана, stock_orders_docs_save).
CREATE OR REPLACE FUNCTION tandem.office_corders(action text, payload jsonb, v_user tandem.users)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'tandem', 'public'
AS $function$
declare v_id bigint := tandem.to_num(payload->>'id')::bigint;
begin
  if action = 'corder_list' then
    return jsonb_build_object('ok', true, 'orders', coalesce((select jsonb_agg(tandem.corder_json(o.id) order by o.for_date desc, o.ready_by, o.no)
      from tandem.client_orders o
     where o.for_date between coalesce(tandem.to_date(payload->>'date_from'), tandem.local_now()::date) and coalesce(tandem.to_date(payload->>'date_to'), tandem.local_now()::date)
       and (nullif(payload->>'point_id', '') is null or o.point_id = payload->>'point_id')
       and (nullif(payload->>'status', '') is null or o.status = payload->>'status')
       -- 0048: учебная учётка видит только заказы учебных точек — телефоны и адреса настоящих клиентов ей закрыты
       and (not v_user.training or o.point_id in (select id from tandem.points where training))), '[]'::jsonb));
  end if;
  if action = 'corder_get' then
    if not exists (select 1 from tandem.client_orders where id = v_id
                    and (not v_user.training or point_id in (select id from tandem.points where training))) then
      return tandem.err('not_found', 'Заказ не найден'); end if;
    return jsonb_build_object('ok', true, 'order', tandem.corder_json(v_id),
      'events', (select coalesce(jsonb_agg(jsonb_build_object('at', e.at, 'status_from', e.status_from, 'status_to', e.status_to,
                   'status_name', tandem.corder_status_name(e.status_to), 'by_kind', e.by_kind, 'by_name', e.by_name, 'payload', e.payload) order by e.id), '[]'::jsonb)
                 from tandem.client_order_events e where e.order_id = v_id));
  end if;
  if action = 'corder_docs_save' then
    if not tandem.office_can(v_user.role, 'doc:production', 'edit') then return tandem.err('forbidden', 'Нет прав на акт производства'); end if;
    begin
      return tandem.corder_make_docs(tandem.to_date(payload->>'for_date'), v_user);
    exception when raise_exception then
      return tandem.err('validation', sqlerrm);   -- 0066: «Акт по заказам клиентов не создан: …»
    end;
  end if;
  if action = 'corder_status' then return tandem.corder_set_status(v_id, payload->>'to', 'office', v_user.name, payload, null); end if;
  return tandem.err('unknown_action', 'Неизвестное действие: ' || action);
end $function$;

-- ---------------------------------------------------------------- права (как в 0042): новые функции получают
-- EXECUTE для PUBLIC - закрываем их и пересозданные; снаружи всё только через tandem_gate
do $$
declare f text;
begin
  foreach f in array array[
      'tandem.login_points(jsonb)', 'tandem.report_hints(text,date)', 'tandem.point_menu_ok(text,text)',
      'tandem.owner_dashboard(date,date,text[],boolean,date)', 'public.tandem_realization(text,text,jsonb)',
      'tandem.order_save(text,jsonb)', 'tandem.orders_report(date)', 'tandem.orders_make_docs(date,tandem.users,boolean,uuid)',
      'tandem.training_orders_ok(date,uuid)', 'tandem.corder_list(text,date,date)', 'tandem.corder_point(text,text,jsonb)',
      'tandem.corder_edit(bigint,jsonb,text,text,text)', 'tandem.office_corders(text,jsonb,tandem.users)'] loop
    execute 'revoke all on function ' || f || ' from public';
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute 'revoke all on function ' || f || ' from anon, authenticated';
      execute 'grant execute on function ' || f || ' to service_role';
    end if;
  end loop;
end $$;

commit;
