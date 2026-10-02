-- Исправления по ревью: точка, касса, водитель, вход и права, пользователи, точки продаж.
-- Тела функций — из канона db/schema/tandem_full.sql, изменены по находкам ревью:
-- 1) save_report (находки 1, 4, контракт 1): числа разбираются безопасно — пробелы и неразрывные пробелы
--    убираются, запятая = точка, пустое — 0 или null; мусор — понятная ошибка с именем поля, а не 22P02 и 500;
--    строки без суммы/количества/названия пропускаются; дата, точка и списки проверяются до записи;
-- 2) название строк продаж и выноса с кодом — из справочника items, присланное игнорируется (5, 14, 19);
-- 3) касса (13, контракт 2–5): причина отмены обязательна; правка и отмена чека в закрытую смену и за дни
--    старше «сегодня − 2» запрещены (досылка без изменений проходит); окно дат — по местному времени;
--    отмены и исправления видны: v_daily.void_count/void_sum/edited_count, get_report.voids, dashboard.voids;
-- 4) сводка: «не сдали за вчера» и период по умолчанию — по местной дате (79), понятные имена ключей
--    счётчика неверных кодов;
-- 5) гейт (27, 28, 29, 63, контракт 7): глобальный порог 60 больше не запирает всех; каждая ошибка пишется
--    в ключ запроса и в общий ключ 'master' (защита кода собственника и водителя), с IP клиента; порог
--    по IP — 30 за 10 минут, в том числе для входа в бэк-офис; заглушки 'CHANGE-ME…' и пустой код не
--    принимаются никогда;
-- 6) реализация (68, контракт 6): запись водителя с uid от устройства — повтор не задваивает долг;
-- 7) change_pin требует текущий PIN, для admin/owner новый PIN — от 6 цифр (64, контракт 9);
--    tandem_office отвечает validation на check_violation, datetime_field_overflow и переполнение числа (66, контракт 10);
-- 8) user_save проверяет склады до записи (50, контракт 13); store_point_save не переводит точку
--    в «касса» поверх сданного сегодня отчёта (71, контракт 18);
-- 9) tandem_test_cleanup убирает ещё «готовым со склада» тестовых складов (0041), заявки служебных точек
--    с фактом выпуска только их позиций и неверные коды служебных ключей с парными строками 'master'.
-- Второй круг (независимая проверка исправлений, contracts2 E, G–J):
-- 10) чек помнит сумму и способ оплаты первого сохранения (checks.first_total, first_pay_kind): voids отдают
--     «было → стало», v_daily.void_sum считается по первой сумме, в конце v_daily — edited_diff (V5);
-- 11) tandem_api 'reopen_shift': собственник снимает закрытие смены кассы, чтобы касса исправила чек;
-- 12) гейт: при замке 'master' верный код собственника и водителя не пишется в неудачи (V20); при пороге
--     по IP проходят верный служебный ключ и верный код присланной активной точки, ответ — про 10 минут (V25);
-- 13) change_pin считает ошибки текущего PIN как вход: после истёкшего замка счёт заново (V12);
-- 14) tandem_office: lock_not_available и query_canceled — «пересчёт уже идёт», а не 500 (V7).

-- ---------------------------------------------------------------- таблицы
-- Адрес клиента у неверного кода: порог по IP и разбор, откуда идёт перебор.
alter table tandem.pin_failures add column if not exists ip text;
create index if not exists pin_failures_ip_at on tandem.pin_failures (ip, at) where ip is not null;

-- Ключ повтора записи водителя: устройство генерирует uid, повтор с тем же uid строки не добавляет.
alter table tandem.realization_ledger add column if not exists uid uuid;
create unique index if not exists realization_ledger_uid_key on tandem.realization_ledger (uid);

-- Сумма и способ оплаты чека при первом сохранении: правка («пробил 5000, взял наличные, исправил на 500»)
-- и отмена после правки видны собственнику как «было → стало». Ставятся один раз в check_save и больше
-- не меняются. Чеки до миграции получают текущие total/pay_kind (прежней суммы нигде нет). Колонки без
-- not null: старые резервные копии без них восстанавливаются, читатели берут coalesce(first_total, total).
alter table tandem.checks add column if not exists first_total numeric;
alter table tandem.checks add column if not exists first_pay_kind text;
update tandem.checks set first_total = coalesce(first_total, total), first_pay_kind = coalesce(first_pay_kind, pay_kind)
 where first_total is null or first_pay_kind is null;

-- ---------------------------------------------------------------- вспомогательные функции
-- Число из поля формы: пробелы (в том числе неразрывные) убираются, запятая — десятичная точка.
create or replace function tandem.num_clean(p text) returns text
language sql immutable as $$
  select replace(regexp_replace(coalesce(p, ''), '[[:space:]\u00a0\u2007\u2009\u202f]', '', 'g'), ',', '.')
$$;

-- Пусто или число («1,5», «12 500», « 1 000,50»). Длина ограничена: огромная строка цифр — тоже мусор.
create or replace function tandem.num_ok(p text) returns boolean
language plpgsql immutable as $$
declare
  v text := tandem.num_clean(p);
begin
  return v = '' or (length(v) <= 24 and v ~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$');
end $$;

-- Число или null (пусто и мусор). Мусор отсекается заранее через tandem.num_ok — с именем поля.
-- plpgsql, а не sql: иначе планировщик мог бы свернуть приведение константы до проверки.
create or replace function tandem.to_num(p text) returns numeric
language plpgsql immutable as $$
declare
  v text := tandem.num_clean(p);
begin
  if v = '' or not tandem.num_ok(p) then return null; end if;
  return v::numeric;
end $$;

-- Дата строго ГГГГ-ММ-ДД, иначе null: '31.02.2026' и 'вчера' не роняют функцию исключением.
create or replace function tandem.to_date(p text) returns date
language plpgsql immutable as $$
begin
  if p is null or p !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return null; end if;
  return p::date;
exception when others then
  return null;
end $$;

-- Список строк отчёта: массив как есть, отсутствие и null — пустой список, иное — null (ошибка формата).
create or replace function tandem.jlist(p jsonb) returns jsonb
language sql immutable as $$
  select case when p is null or jsonb_typeof(p) = 'null' then '[]'::jsonb
              when jsonb_typeof(p) = 'array' then p end
$$;

-- Порог по адресу клиента: 30 неверных кодов и паролей за 10 минут с одного IP. Строки 'master' —
-- пары к строкам ключей, их не считаем, иначе одна ошибка шла бы за две.
create or replace function tandem.pin_ip_blocked(p_ip text) returns boolean
language sql stable set search_path to 'tandem', 'public' as $$
  select p_ip is not null
     and (select count(*) from tandem.pin_failures
           where ip = p_ip and key <> 'master' and at > now() - interval '10 minutes') >= 30
$$;

-- ---------------------------------------------------------------- представление дня
-- В конец — отмены и исправления чеков дня (контракт 2): собственник видит их рядом с выручкой.
-- void_sum — по сумме первого сохранения: «исправил на 500, потом отменил» показывает отмену на 5000.
-- edited_diff — на сколько исправления уменьшили (минус — увеличили) активные чеки дня.
create or replace view tandem.v_daily as
 SELECT r.id, r.report_date, r.point_id, p.name AS point_name, p.mode, r.shift_by,
    r.cash, r.kaspi_qr, r.transfer,
    r.cash + r.kaspi_qr + r.transfer + r.card AS revenue_total,
    r.qr_statement, r.tr_statement,
    CASE WHEN r.qr_statement IS NULL THEN NULL::numeric ELSE r.kaspi_qr - r.qr_statement END AS diff_qr,
    CASE WHEN r.tr_statement IS NULL THEN NULL::numeric ELSE r.transfer - r.tr_statement END AS diff_transfer,
    r.cash_open, r.cash_handed,
    COALESCE(( SELECT sum(e.amount) FROM tandem.cash_expenses e WHERE e.report_id = r.id), 0::numeric) AS podotchet,
    r.cash_open + r.cash - r.cash_handed - COALESCE(( SELECT sum(e.amount) FROM tandem.cash_expenses e WHERE e.report_id = r.id), 0::numeric) AS cash_expected,
    r.cash_counted,
    CASE WHEN r.cash_counted IS NULL THEN NULL::numeric
         ELSE r.cash_open + r.cash - r.cash_handed - COALESCE(( SELECT sum(e.amount) FROM tandem.cash_expenses e WHERE e.report_id = r.id), 0::numeric) - r.cash_counted
    END AS diff_cash,
    COALESCE(( SELECT count(*) FROM tandem.cash_expenses e
          WHERE e.report_id = r.id AND (e.receipt_no IS NULL OR btrim(e.receipt_no) = ''::text)), 0::bigint) AS expenses_no_receipt,
    COALESCE(( SELECT sum((t.issued - t.returned) * COALESCE(t.price, 0::numeric)) FROM tandem.takeout_lines t WHERE t.report_id = r.id), 0::numeric) AS takeout_amount,
    COALESCE(( SELECT sum(s.qty * COALESCE(s.price, 0::numeric)) FROM tandem.sale_lines s WHERE s.report_id = r.id), 0::numeric) AS sales_amount,
    r.comment, r.created_at,
    r.card, r.closed_at,
    ( SELECT count(*) FROM tandem.checks c WHERE c.point_id = r.point_id AND c.check_date = r.report_date AND c.status = 'active') AS checks_count,
    ( SELECT count(*)::integer FROM tandem.checks c WHERE c.point_id = r.point_id AND c.check_date = r.report_date AND c.status = 'void') AS void_count,
    ( SELECT COALESCE(sum(COALESCE(c.first_total, c.total)), 0::numeric) FROM tandem.checks c WHERE c.point_id = r.point_id AND c.check_date = r.report_date AND c.status = 'void') AS void_sum,
    ( SELECT count(*)::integer FROM tandem.checks c WHERE c.point_id = r.point_id AND c.check_date = r.report_date AND c.status = 'active' AND c.edited) AS edited_count,
    ( SELECT COALESCE(sum(COALESCE(c.first_total, c.total) - c.total), 0::numeric) FROM tandem.checks c WHERE c.point_id = r.point_id AND c.check_date = r.report_date AND c.status = 'active' AND c.edited) AS edited_diff
   FROM tandem.daily_reports r
     JOIN tandem.points p ON p.id = r.point_id;

-- ---------------------------------------------------------------- касса
create or replace function tandem.check_save(p_point text, payload jsonb)
returns jsonb language plpgsql set search_path to 'tandem', 'public' as $$
declare
  v_uid   uuid;
  v_date  date := tandem.to_date(payload->>'date');
  v_pay   text := payload->>'pay_kind';
  v_chk   tandem.checks;
  v_id    bigint;
  v_bad   text;
  v_total numeric;
  v_was   text;
  v_new   text;
  v_today date := tandem.local_now()::date;   -- окно дат — по местному времени, не по часам сервера (UTC)
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
    if exists (select 1 from tandem.daily_reports where point_id = p_point and report_date = v_date and closed_at is not null)
       or v_date < v_today - 2 then
      select v_pay || '|' || string_agg(i.code || ':' || tandem.to_num(x->>'qty')::text || ':'
                                        || coalesce(tandem.to_num(x->>'price'), pp.price, i.price, 0)::text, ',' order by ord) into v_new
        from jsonb_array_elements(payload->'lines') with ordinality t(x, ord)
        join tandem.items i on i.code = x->>'item_code'
        left join tandem.item_prices pp on pp.item_code = i.code and pp.point_id = p_point;
      if v_new is not distinct from v_was then
        return jsonb_build_object('ok', true, 'check', (select jsonb_build_object('uid', uid, 'no', no, 'total', total,
                 'date', check_date, 'edited', edited) from tandem.checks where id = v_id));
      end if;
      if exists (select 1 from tandem.daily_reports where point_id = p_point and report_date = v_date and closed_at is not null) then
        return jsonb_build_object('ok', false, 'error', 'Смена закрыта — чек уже не изменить. Обратитесь в офис'); end if;
      return jsonb_build_object('ok', false, 'error', 'Чек слишком старый — исправление через офис');
    end if;
    -- Чек, пробитый старой функцией во время миграции (first_* пусты), запоминает сумму и оплату до правки.
    update tandem.checks set first_total = coalesce(first_total, total), first_pay_kind = coalesce(first_pay_kind, pay_kind),
           pay_kind = v_pay, updated_at = now() where id = v_id;
    delete from tandem.check_lines where check_id = v_id;
  end if;

  insert into tandem.check_lines (check_id, item_code, item_name, qty, price, price_list)
    select v_id, i.code, i.name, tandem.to_num(x->>'qty'),
           coalesce(tandem.to_num(x->>'price'), pp.price, i.price, 0), coalesce(pp.price, i.price)
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
end $$;

create or replace function tandem.check_void(p_point text, payload jsonb)
returns jsonb language plpgsql set search_path to 'tandem', 'public' as $$
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
    -- Как и правка: закрытую смену и старые дни отмена не переписывает.
    if exists (select 1 from tandem.daily_reports where point_id = p_point and report_date = v_chk.check_date and closed_at is not null) then
      return jsonb_build_object('ok', false, 'error', 'Смена закрыта — чек уже не изменить. Обратитесь в офис'); end if;
    if v_chk.check_date < tandem.local_now()::date - 2 then
      return jsonb_build_object('ok', false, 'error', 'Чек слишком старый — исправление через офис'); end if;
    update tandem.checks set status = 'void', updated_at = now(), void_reason = v_reason where id = v_chk.id;
    perform tandem.check_apply(p_point, v_chk.check_date);
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- точка, касса, сводка
create or replace function public.tandem_api(action text, payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path to 'tandem', 'public' as $$
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

    select to_jsonb(v) into v_res from tandem.v_daily v where v.id = v_id;
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
  -- Закрытую смену чек уже не меняет (check_save/check_void). Собственник снимает закрытие, касса
  -- исправляет или отменяет чек (правка видна в voids как «было → стало»), затем закрывает смену снова.
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
      'rows', (select coalesce(jsonb_agg(to_jsonb(v) order by v.report_date desc, v.point_name), '[]'::jsonb)
               from tandem.v_daily v
               where v.report_date between v_from and v_to),
      'points', (select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'mode',mode) order by sort_order),'[]'::jsonb)
                 from tandem.points where active),
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
      'missing', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name) order by p.sort_order), '[]'::jsonb)
        from tandem.points p
        where p.active and not exists (
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
      'raw_usage', (select coalesce(jsonb_agg(jsonb_build_object(
          'name', t.ingredient_name, 'amount', t.total) order by t.total desc), '[]'::jsonb)
        from (
          -- Карта берётся на дату отчёта, а не на сегодня: иначе новая версия карты
          -- переписала бы расход сырья за прошлые дни.
          select ing.name as ingredient_name, sum(cl.brutto / ch.output_amount * u.q) total from (
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
          group by ing.name order by total desc limit 15
        ) t),
      -- Неверные коды за сутки (счётчик единого входа, 0029/0042): кто-то подбирает код точки, собственника
      -- или PIN бэк-офиса. 'master' — общий счётчик всех неверных кодов сети (он запирает вход собственника и водителя).
      'pin_failures', (select coalesce(jsonb_agg(jsonb_build_object('key', f.key, 'count', f.n, 'last', f.last,
          'name', coalesce(p.name, case
            when f.key = 'service' then 'служебный ключ'
            when f.key = '-' then 'вход без точки (собственник, водитель)'
            when f.key = 'master' then 'все неверные коды точек, собственника и водителя (общий замок входа собственника и водителя)'
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
$$;

-- ---------------------------------------------------------------- единый вход
create or replace function public.tandem_gate(action text, payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path to 'tandem', 'public', 'extensions' as $$
declare
  v_pin   text := coalesce(payload->>'pin', '');
  -- IP клиента кладёт Edge Function или прокси своего сервера, перезаписывая присланное клиентом.
  v_ip    text := left(nullif(btrim(coalesce(payload->>'_ip', '')), ''), 64);
  v_key   text;
  v_res   jsonb;
  v_hash  text;
  v_owner text;
  v_service boolean := action in ('migrate','test_cleanup','sync_items','sync_prices','recalc_ranks','set_packaging','set_short_list');
  v_busy  jsonb := jsonb_build_object('ok', false, 'error', 'Слишком много неверных кодов. Подождите 5 минут', 'code', 'throttled');
  v_svc_ok   boolean := false;   -- служебное действие с верным ключом
  v_point_ok boolean := false;   -- верный код присланной активной точки
  v_staff    boolean := false;   -- верный код собственника или водителя
begin
  if action like 'office\_%' then
    -- Токен текущей сессии — в настройку транзакции: триггер смены PIN закроет все сессии
    -- пользователя, кроме этой (см. tandem.users_pin_sessions).
    perform set_config('tandem.token', coalesce(payload->>'token', ''), true);
    if action = 'office_login' then
      -- Вход в бэк-офис: у логина свой замок (5 ошибок — 15 минут), сверху — порог по адресу, иначе
      -- перебор шёл бы по многим логинам параллельно и без конца.
      if tandem.pin_ip_blocked(v_ip) then
        return jsonb_build_object('ok', false, 'error', 'throttled', 'code', 'throttled',
                                  'message', 'Слишком много неверных попыток входа с этого адреса. Подождите 10 минут');
      end if;
      v_res := public.tandem_office('login', payload);
      if (v_res->>'ok') = 'false' then
        insert into tandem.pin_failures (key, ip)
          values ('office:' || left(lower(btrim(coalesce(payload->>'login', ''))), 40), v_ip);
        delete from tandem.pin_failures where at < now() - interval '1 day';
      end if;
      return v_res;
    end if;
    return public.tandem_office(substr(action, 8), payload);
  end if;

  -- Список точек для экрана входа кода не требует и не запирается: иначе чужие ошибки оставили бы
  -- все точки без выбора точки.
  if action = 'points' then
    return public.tandem_api(action, payload);
  end if;

  -- Ключ счётчика — настоящая точка из запроса; всё остальное (вход собственника и водителя,
  -- выдуманные точки) падает в общий ключ «-».
  v_key := case when v_service then 'service'
                else coalesce((select p.id from tandem.points p
                                where p.id = coalesce(nullif(payload->>'point_id',''), nullif(payload->>'point',''))), '-') end;
  -- Что из присланного верно — до порогов: порог по адресу и замок 'master' пропускают верный код точки
  -- и верный служебный ключ, а верный код собственника и водителя не засчитывают неудачей.
  if v_service then
    select value into v_hash from tandem.settings where key = 'service_key_hash';
    v_svc_ok := v_hash is not null and coalesce(payload->>'service_key', '') <> ''
                and encode(digest(payload->>'service_key', 'sha256'), 'hex') = v_hash;
  elsif v_pin <> '' and v_pin not ilike 'CHANGE-ME%' then
    v_point_ok := exists (select 1 from tandem.points p where p.id = v_key and p.pin = v_pin and p.active);
    v_staff := v_pin in (select value from tandem.settings where key in ('owner_pin', 'driver_pin'));
  end if;
  -- 1) адрес клиента: 30 неверных за 10 минут. Верный служебный ключ и верный код присланной активной
  -- точки проходят: общий адрес (мобильный CGNAT, NAT офиса) не запирает точку и уборку дымового теста.
  -- Остальное — отказ без записи. Общего порога на всю сеть больше нет: он позволял анонимно запереть
  -- все точки, в том числе с верным кодом.
  if not v_svc_ok and not v_point_ok and tandem.pin_ip_blocked(v_ip) then
    return jsonb_build_object('ok', false, 'error', 'Слишком много неверных кодов с этого адреса. Подождите 10 минут', 'code', 'throttled');
  end if;
  -- 2) ключ запроса: 10 за 5 минут.
  if (select count(*) from tandem.pin_failures f where f.key = v_key and f.at > now() - interval '5 minutes') >= 10 then
    return v_busy;
  end if;
  -- 3) 'master' — все неверные коды сети: любой из них мог быть попыткой кода собственника или водителя,
  -- и разнести перебор по ключам точек больше нельзя. Пока он заперт, проходит только верный код
  -- присланной точки: точки работают, а код собственника и водителя получает тот же отказ, что и неверный.
  -- Неверный код точки при этом засчитывается её ключу — иначе замок дал бы перебирать коды точек даром.
  -- Верный код собственника или водителя (раскрытие отчёта точки в уже открытой сводке) неудачей не
  -- считается: иначе обычные клики собственника запирали бы точку и продлевали сам замок.
  if not v_service and not v_point_ok
     and (select count(*) from tandem.pin_failures f where f.key = 'master' and f.at > now() - interval '5 minutes') >= 10 then
    if v_pin <> '' and v_key <> '-' and not v_staff then
      insert into tandem.pin_failures (key, ip) values (v_key, v_ip), ('master', v_ip);
    end if;
    return v_busy;
  end if;

  if v_service then
    if not v_svc_ok then
      insert into tandem.pin_failures (key, ip) values ('service', v_ip);
      return jsonb_build_object('ok', false, 'error', 'forbidden', 'message', 'Нужен служебный ключ');
    end if;
    select value into v_owner from tandem.settings where key = 'owner_pin';
    -- Уборка теста снимает и неверные коды служебных точек (см. tandem_test_cleanup): иначе проверка
    -- счётчика запирала бы следующий прогон и вход собственника.
    v_res := case action
      when 'migrate'        then public.tandem_migrate(v_owner, coalesce(payload->>'kind',''), coalesce(payload->'rows','[]'::jsonb))
      when 'test_cleanup'   then public.tandem_test_cleanup(v_owner)
      when 'sync_items'     then public.tandem_sync_items(v_owner, coalesce(payload->'items','[]'::jsonb))
      when 'sync_prices'    then public.tandem_sync_prices(v_owner, coalesce(payload->'data','[]'::jsonb))
      when 'recalc_ranks'   then public.tandem_recalc_ranks(v_owner, coalesce((payload->>'days')::int, 30))
      when 'set_packaging'  then public.tandem_set_packaging(v_owner, coalesce(payload->'data','[]'::jsonb))
      when 'set_short_list' then public.tandem_set_short_list(v_owner, coalesce(payload->>'point',''), coalesce(payload->'codes','[]'::jsonb))
    end;
    return v_res;
  end if;

  -- Пустой код и заглушки из публичного seed ('CHANGE-ME-OWNER', 'CHANGE-ME-DRIVER') не открывают ничего,
  -- даже если в настройках так и остались: при переезде без смены кодов они были бы входом собственником.
  if v_pin = '' or v_pin ilike 'CHANGE-ME%' then
    v_res := jsonb_build_object('ok', false, 'error', case when action = 'login' then 'Неверный код' else 'Нет доступа' end);
  else
    v_res := case action
      when 'charts'       then public.tandem_charts(v_pin, coalesce(payload->>'point_id',''))
      when 'realization'  then public.tandem_realization(v_pin, coalesce(payload->>'op','list'), coalesce(payload->'data','{}'::jsonb))
      when 'save_aliases' then public.tandem_save_aliases(v_pin, coalesce(payload->>'point_id',''), coalesce(payload->'data','[]'::jsonb))
      else public.tandem_api(action, payload)
    end;
  end if;

  -- Неверный код узнаём по ответу нижележащей функции: их тела не трогаем. Две строки — ключ запроса
  -- и общий 'master' (то же время и адрес: уборка теста снимает их парой).
  if v_pin <> '' and jsonb_typeof(v_res) = 'object' and (v_res->>'ok') = 'false'
     and (v_res->>'error' in ('Неверный код', 'Нет доступа')
          or (v_res->>'error' = 'forbidden' and v_res->>'message' = 'Нет доступа')) then
    insert into tandem.pin_failures (key, ip) values (v_key, v_ip), ('master', v_ip);
    delete from tandem.pin_failures where at < now() - interval '1 day';
  end if;
  return v_res;
end $$;

-- ---------------------------------------------------------------- бэк-офис: вход, PIN, ошибки ввода
create or replace function public.tandem_office(action text, payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path to 'tandem', 'public', 'extensions' as $$
declare
  v_token    text := payload->>'token';
  v_user     tandem.users;
  v_pin      text;
  v_hash     text;
  v_calc     text;
  v_ok       boolean;
  v_section  text;
  v_need     text;
  v_attempts int;
  v_con      text;
begin
  if action = 'login' then
    v_pin := coalesce(payload->>'pin','');
    select * into v_user from tandem.users
      where login = lower(btrim(coalesce(payload->>'login',''))) and active;

    -- crypt считается всегда, отдельными операторами: если сложить всё в одно
    -- выражение, Postgres вправе оборвать вычисление на первом false, и ответ
    -- «такого логина нет» вернётся заметно быстрее ответа «неверный PIN».
    -- Хэш-заглушка — обычный bcrypt-хэш от произвольной строки, не секрет:
    -- он нужен только чтобы crypt было над чем работать.
    v_hash := coalesce(v_user.pin_hash, '$2a$06$nok4o3iwBUM19xMpLFJzoeTS1iAyq43SB1ybN/Yq5Zt2PyGfXmZF6');
    v_calc := crypt(v_pin, v_hash);
    v_ok   := v_user.id is not null and v_calc = v_user.pin_hash;

    -- Пока логин заблокирован, ответ один и тот же при любом PIN — и тот же, что при обычной
    -- ошибке. Отдельный ответ на верный PIN (так было в 0021) давал перебору подсказку:
    -- блокировка не мешала узнать PIN по тексту ответа. Отдельный ответ «заблокирован»
    -- подтверждал бы существование логина. Поэтому про блокировку сказано в самом тексте ошибки.
    if v_user.id is not null and v_user.locked_until > now() then
      perform pg_sleep(0.3);
      return tandem.err('unauthorized', 'Неверный логин или PIN. После пяти ошибок подряд вход закрывается на 15 минут');
    end if;

    if not v_ok then
      if v_user.id is not null then
        -- храповик: локом, чей срок уже истёк, счётчик не наследуется, а начинается заново.
        v_attempts := case when v_user.locked_until is not null and v_user.locked_until <= now()
                            then 1 else v_user.failed_attempts + 1 end;
        update tandem.users set
          failed_attempts = v_attempts,
          locked_until = case when v_attempts >= 5 then now() + interval '15 minutes' else null end
        where id = v_user.id;
      end if;
      perform pg_sleep(0.3);
      return tandem.err('unauthorized', 'Неверный логин или PIN. После пяти ошибок подряд вход закрывается на 15 минут');
    end if;

    update tandem.users set failed_attempts = 0, locked_until = null where id = v_user.id;
    delete from tandem.sessions where expires_at < now();
    v_token := encode(gen_random_bytes(24), 'hex');
    insert into tandem.sessions (token, user_id, expires_at)
      values (v_token, v_user.id, now() + interval '12 hours');
    return jsonb_build_object('ok', true, 'token', v_token, 'user', tandem.office_user_json(v_user),
      'must_change_pin', v_user.must_change_pin, 'permissions', tandem.office_permissions(v_user.role));
  end if;

  v_user := tandem.office_session(coalesce(v_token,''));
  if v_user.id is null then
    return tandem.err('unauthorized', 'Войдите заново');
  end if;

  -- I2: временный PIN держится на сервере, а не на доброй воле фронта.
  if v_user.must_change_pin and action not in ('me','logout','change_pin') then
    return tandem.err('forbidden', 'Сначала смените временный PIN');
  end if;

  if action = 'logout' then
    delete from tandem.sessions where token = v_token;
    return jsonb_build_object('ok', true);
  end if;

  if action = 'me' then
    return jsonb_build_object('ok', true, 'user', tandem.office_user_json(v_user),
      'must_change_pin', v_user.must_change_pin, 'permissions', tandem.office_permissions(v_user.role));
  end if;

  if action = 'change_pin' then
    v_pin := coalesce(payload->>'pin','');
    if length(v_pin) < 4 or v_pin !~ '^[0-9]+$' then
      return tandem.err('validation', 'PIN — не меньше 4 цифр');
    end if;
    if v_user.role in ('admin', 'owner') and length(v_pin) < 6 then
      return tandem.err('validation', 'PIN администратора и собственника — не меньше 6 цифр');
    end if;
    -- Текущий PIN спрашивается всегда, кроме первого входа с временным: оставленная открытой сессия
    -- или утёкший токен не должны уводить учётную запись навсегда. Подбор текущего PIN через сессию
    -- ограничен как вход: пять ошибок подряд — вход закрыт на 15 минут, все сессии пользователя закрыты.
    if not v_user.must_change_pin then
      if coalesce(payload->>'old_pin', '') = '' then
        return tandem.err('validation', 'Введите текущий PIN');
      end if;
      if crypt(payload->>'old_pin', v_user.pin_hash) <> v_user.pin_hash then
        -- Счёт — как у входа (храповик): после истёкшего замка начинается заново. Иначе посторонний,
        -- зная логин, «заряжал» бы счётчик неверными входами, и первая же опечатка владельца сессии
        -- запирала бы его и закрывала все сессии.
        v_attempts := case when v_user.locked_until is not null and v_user.locked_until <= now()
                            then 1 else v_user.failed_attempts + 1 end;
        update tandem.users set failed_attempts = v_attempts,
               locked_until = case when v_attempts >= 5 then now() + interval '15 minutes' else null end
         where id = v_user.id;
        if v_attempts >= 5 then
          delete from tandem.sessions where user_id = v_user.id;
        end if;
        perform pg_sleep(0.3);
        return tandem.err('validation', 'Неверный текущий PIN');
      end if;
    end if;
    -- Текущую сессию не закрываем: остальные закроет триггер tandem.users_pin_sessions.
    update tandem.users set pin_hash = crypt(v_pin, gen_salt('bf')), must_change_pin = false,
           failed_attempts = 0, locked_until = null
      where id = v_user.id;
    return jsonb_build_object('ok', true, 'must_change_pin', false);
  end if;

  -- раздел и требуемое право выводятся из имени действия
  v_section := case
    -- Склад стоит первым: doc%/stock% и карточка остатков позиции уходят в него,
    -- иначе item_stock перехватил бы правилом item% раздел номенклатуры.
    when action like 'doc%' or action like 'stock%' or action = 'item_stock' then 'stock'
    when action like 'chart%' or action like 'foodcost%' then 'charts'
    when action like 'group%' or action like 'item%'     then 'nomenclature'
    when action like 'store%'        then 'stores'
    when action like 'counteragent%' then 'counteragents'
    when action like 'user%'         then 'users'
  end;
  if v_section is null then
    return tandem.err('unknown_action', 'Неизвестное действие: ' || action);
  end if;
  v_need := case when action like '%\_list' or action like '%\_search' or action like '%\_get'
                      or action like '%\_report' or action like '%\_preview'
                      or action in ('stock_balances','stock_moves','item_stock')
                 then 'view' else 'edit' end;
  if not tandem.office_can(v_user.role, v_section, v_need) then
    return tandem.err('forbidden', 'Нет прав на это действие');
  end if;

  if v_section = 'nomenclature' then
    return tandem.office_nomenclature(action, payload, v_user);
  elsif v_section = 'charts' then
    return tandem.office_charts(action, payload, v_user);
  elsif v_section = 'stores' then
    return tandem.office_stores(action, payload, v_user);
  elsif v_section = 'counteragents' then
    return tandem.office_counteragents(action, payload, v_user);
  elsif v_section = 'users' then
    return tandem.office_users(action, payload, v_user);
  elsif v_section = 'stock' then
    return tandem.office_stock(action, payload, v_user);
  end if;
exception
  -- Minor: кривой uuid/число/boolean в payload — это ошибка ввода, а не сбой базы.
  when invalid_text_representation then
    return tandem.err('validation', 'Неверный формат поля');
  -- ссылка на несуществующий склад/контрагента/позицию — тоже ошибка ввода, не 500.
  when foreign_key_violation then
    return tandem.err('validation', 'Ссылка на несуществующую запись (склад, контрагент или позиция)');
  -- I4: взаимная блокировка двух проведений — не сбой базы, а «повторите»: одна
  -- транзакция снята Postgres'ом, её документ остался черновиком и проводится заново.
  when deadlock_detected then
    return tandem.err('validation', 'Документ проводится параллельно — повторите');
  -- Чужой лок не дождались (lock_timeout) или сработал statement_timeout прокси: пересчёт продаж по складу
  -- (stock_ready_*, doc_sales_sync) ещё идёт в другом запросе. Всё сделанное этим вызовом откатилось.
  -- query_canceled не входит в others — перехватывается только по имени.
  when lock_not_available or query_canceled then
    return tandem.err('validation', 'Пересчёт по этому складу уже идёт — подождите и обновите список');
  -- дата накладной или периода, пришедшая мусором ('31.02.2026', 'вчера').
  when invalid_datetime_format then
    return tandem.err('validation', 'Неверный формат даты');
  -- Несуществующая дата в верном формате (2026-02-31) — тоже ошибка ввода, не 500.
  when datetime_field_overflow then
    return tandem.err('validation', 'Такой даты нет — проверьте число и месяц');
  -- Отрицательное количество, причина не из списка и прочие ограничения таблиц: всё откатывается,
  -- человек видит, что исправить, вместо пустой ошибки «база данных».
  when check_violation then
    get stacked diagnostics v_con = constraint_name;
    return tandem.err('validation', case
      when v_con in ('document_lines_qty_check', 'order_lines_qty_check') then 'Количество не может быть отрицательным'
      when v_con = 'order_plan_fact_qty_check' then 'Выпуск не может быть отрицательным'
      when v_con = 'documents_reason_check' then 'Причина списания не из списка'
      when v_con = 'documents_stores_by_type' then 'Склады не подходят к типу документа'
      when v_con like 'chart\_lines\_%' then 'Брутто, нетто и выход не могут быть отрицательными'
      when v_con = 'charts_output_amount_check' then 'Выход блюда должен быть больше нуля'
      when v_con = 'charts_dates' then 'Дата окончания раньше даты начала'
      when v_con = 'items_item_type_check' then 'Тип позиции не из списка'
      when v_con = 'counteragents_kind_check' then 'Вид контрагента не из списка'
      else 'Недопустимое значение поля' end);
  when numeric_value_out_of_range then
    return tandem.err('validation', 'Слишком большое число');
end $$;

-- ---------------------------------------------------------------- водитель: реализация
create or replace function public.tandem_realization(p_pin text, p_action text, p_data jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path to 'tandem', 'public' as $$
declare
  v_owner  text;
  v_driver text;
  v_who    text;
  v_uid    uuid;
  v_date   date;
  v_lbl    text;
begin
  select value into v_owner  from tandem.settings where key = 'owner_pin';
  select value into v_driver from tandem.settings where key = 'driver_pin';
  if p_pin = v_owner then v_who := 'собственник';
  elsif p_pin = v_driver then v_who := 'водитель';
  else return jsonb_build_object('ok', false, 'error', 'Нет доступа');
  end if;

  if p_action = 'list' then
    return jsonb_build_object('ok', true,
      'clients', (select coalesce(jsonb_agg(jsonb_build_object(
          'id', c.id, 'name', c.name,
          'debt', coalesce(t.debt, 0)) order by c.sort_order), '[]'::jsonb)
        from tandem.realization_clients c
        left join (select client_id, sum(delivered - paid - returned) debt
                   from tandem.realization_ledger group by client_id) t on t.client_id = c.id
        where c.active),
      'recent', (select coalesce(jsonb_agg(jsonb_build_object(
          'date', l.entry_date, 'client', c.name, 'delivered', l.delivered,
          'paid', l.paid, 'returned', l.returned, 'note', l.note, 'by', l.created_by)
          order by l.entry_date desc, l.id desc), '[]'::jsonb)
        from (select * from tandem.realization_ledger order by entry_date desc, id desc limit 30) l
        join tandem.realization_clients c on c.id = l.client_id));
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

  return jsonb_build_object('ok', false, 'error', 'Неизвестное действие');
end;
$$;

-- ---------------------------------------------------------------- уборка дымового теста
create or replace function public.tandem_test_cleanup(p_pin text)
returns jsonb language plpgsql security definer set search_path to 'tandem', 'public' as $$
declare
  v_owner text;
  v_items int; v_groups int; v_stores int; v_ca int; v_users int; v_charts int; v_left int;
  v_docs int;
begin
  select value into v_owner from tandem.settings where key = 'owner_pin';
  if p_pin is distinct from v_owner then
    return jsonb_build_object('ok', false, 'error', 'forbidden', 'message', 'Нет доступа');
  end if;

  -- Движения держат документ (stock_moves_document_id_fkey on delete restrict) — с 0018
  -- они больше не уходят каскадом и снимаются здесь явно, до удаления самих документов.
  delete from tandem.stock_moves
    where store_id in (select id from tandem.stores where name like 'ZZ\_TEST\_%')
       or item_code in (select code from tandem.items where name like 'ZZ\_TEST\_%' or code like 'ZZ\_TEST\_%')
       or document_id in (
            select id from tandem.documents
              where store_from in (select id from tandem.stores where name like 'ZZ\_TEST\_%')
                 or store_to   in (select id from tandem.stores where name like 'ZZ\_TEST\_%')
                 or id in (select l.document_id from tandem.document_lines l join tandem.items i on i.code = l.item_code
                           where i.name like 'ZZ\_TEST\_%' or i.code like 'ZZ\_TEST\_%'));

  -- «Готовым со склада» (0041): строки тестовых складов, складов служебных точек и тестовых позиций —
  -- до удаления складов и позиций. Без таблицы (база до 0041) шаг пропускается.
  if to_regclass('tandem.store_ready') is not null then
    delete from tandem.store_ready
      where store_id in (select id from tandem.stores where name like 'ZZ\_TEST\_%' or point_id like 'zz\_%')
         or item_code in (select code from tandem.items where name like 'ZZ\_TEST\_%' or code like 'ZZ\_TEST\_%');
  end if;

  -- Отчёты служебной точки теста zz_test (выключена, на экранах не видна): их продажи сидят
  -- на тестовых складах и уйдут ниже вместе с документами склада. Настоящие точки тест не трогает.
  delete from tandem.checks where point_id = 'zz_kassa';   -- касса теста: чеки, затем отчёты
  -- Заявки служебных точек: факт выпуска их дней снимается, только если позицию в этот день не заказывала
  -- ни одна настоящая точка, — чужой план пекаря тест не трогает. Затем сами заявки (строки — каскадом).
  delete from tandem.order_plan pl
   where exists (select 1 from tandem.order_lines l join tandem.orders o on o.id = l.order_id
                  where left(o.point_id, 3) = 'zz_' and o.for_date = pl.for_date and l.item_code = pl.item_code)
     and not exists (select 1 from tandem.order_lines l join tandem.orders o on o.id = l.order_id
                      where left(o.point_id, 3) <> 'zz_' and o.for_date = pl.for_date and l.item_code = pl.item_code);
  delete from tandem.orders where left(point_id, 3) = 'zz_';
  delete from tandem.order_plan where item_code in (select code from tandem.items where name like 'ZZ_TEST_%' or code like 'ZZ_TEST_%');
  update tandem.settings set value = '' where key = 'orders_store_id'
     and value in (select id::text from tandem.stores where name like 'ZZ_TEST_%');
  delete from tandem.daily_reports where point_id in ('zz_test', 'zz_kassa');

  -- Неверные коды служебных точек вместе с парной строкой общего счётчика 'master' (то же время и адрес)
  -- и неудачные входы тестовых логинов бэк-офиса: замок, который тест ставит себе сам, иначе держал бы
  -- вход собственника и следующий прогон.
  with z as (delete from tandem.pin_failures where key like 'zz\_%' returning at, ip)
  delete from tandem.pin_failures m
   using (select distinct at, ip from z) zz
   where m.key = 'master' and m.at = zz.at and m.ip is not distinct from zz.ip;
  delete from tandem.pin_failures where key like 'office:zz\_test\_%';

  -- Документы тестовых складов и позиций уходят первыми: на них ссылаются строки,
  -- а сами документы держат FK на stores и items.
  with d as (delete from tandem.documents
      where store_from in (select id from tandem.stores where name like 'ZZ\_TEST\_%')
         or store_to   in (select id from tandem.stores where name like 'ZZ\_TEST\_%')
         or id in (select l.document_id from tandem.document_lines l join tandem.items i on i.code = l.item_code
                   where i.name like 'ZZ\_TEST\_%' or i.code like 'ZZ\_TEST\_%')
      returning 1)
    select count(*) into v_docs from d;
  delete from tandem.stock_balances
    where store_id in (select id from tandem.stores where name like 'ZZ\_TEST\_%')
       or item_code in (select code from tandem.items where name like 'ZZ\_TEST\_%' or code like 'ZZ\_TEST\_%');
  -- Счётчики номеров (doc_counters) не трогаем: номера документов не должны повторяться.

  delete from tandem.item_prices where item_code in
    (select code from tandem.items where name like 'ZZ\_TEST\_%' or code like 'ZZ\_TEST\_%');
  delete from tandem.item_rank where item_code in
    (select code from tandem.items where name like 'ZZ\_TEST\_%' or code like 'ZZ\_TEST\_%');

  -- Техкарты: сначала строки, где тестовая позиция стоит ингредиентом (в том числе в чужих
  -- картах — иначе FK не даст удалить позицию), затем сами карты тестовых блюд (строки уйдут каскадом).
  delete from tandem.chart_lines where ingredient_code in
    (select code from tandem.items where name like 'ZZ\_TEST\_%' or code like 'ZZ\_TEST\_%');
  with d as (delete from tandem.charts where item_code in
      (select code from tandem.items where name like 'ZZ\_TEST\_%' or code like 'ZZ\_TEST\_%') returning 1)
    select count(*) into v_charts from d;

  with d as (delete from tandem.items where name like 'ZZ\_TEST\_%' or code like 'ZZ\_TEST\_%' returning 1)
    select count(*) into v_items from d;

  -- склад по умолчанию точки ссылается на stores: сначала отвязать, иначе delete упрётся в FK
  update tandem.points set default_store_id = null
    where default_store_id in (select id from tandem.stores where name like 'ZZ\_TEST\_%');

  with d as (delete from tandem.item_groups where name like 'ZZ\_TEST\_%' returning 1)
    select count(*) into v_groups from d;
  with d as (delete from tandem.stores where name like 'ZZ\_TEST\_%' returning 1)
    select count(*) into v_stores from d;
  with d as (delete from tandem.counteragents where name like 'ZZ\_TEST\_%' returning 1)
    select count(*) into v_ca from d;
  -- сессии тестовых пользователей уходят каскадом (sessions_user_id_fkey on delete cascade)
  with d as (delete from tandem.users where login like 'zz\_test\_%' returning 1)
    select count(*) into v_users from d;

  delete from tandem.sessions where expires_at < now();

  select (select count(*) from tandem.items where name like 'ZZ\_TEST\_%' or code like 'ZZ\_TEST\_%')
       + (select count(*) from tandem.item_groups where name like 'ZZ\_TEST\_%')
       + (select count(*) from tandem.stores where name like 'ZZ\_TEST\_%')
       + (select count(*) from tandem.counteragents where name like 'ZZ\_TEST\_%')
       + (select count(*) from tandem.users where login like 'zz\_test\_%')
    into v_left;

  return jsonb_build_object('ok', true, 'deleted', jsonb_build_object(
    'items', v_items, 'groups', v_groups, 'stores', v_stores,
    'counteragents', v_ca, 'users', v_users, 'charts', v_charts, 'documents', v_docs), 'leftovers', v_left);
end $$;

-- ---------------------------------------------------------------- точки продаж и склады
create or replace function tandem.office_stores(action text, payload jsonb, v_user tandem.users)
returns jsonb language plpgsql set search_path to 'tandem', 'public' as $$
declare
  v_id uuid; v_name text; v_point text;
begin
  if action = 'stores_list' then
    return jsonb_build_object('ok', true,
      'stores', (select coalesce(jsonb_agg(jsonb_build_object(
          'id', s.id, 'name', s.name, 'point_id', s.point_id, 'point_name', p.name,
          'is_default', (p.default_store_id = s.id), 'active', s.active,
          'organization_id', s.organization_id) order by s.active desc, p.sort_order nulls last, s.name), '[]'::jsonb)
        from tandem.stores s left join tandem.points p on p.id = s.point_id),
      'points', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name) order by sort_order), '[]'::jsonb)
        from tandem.points where active));
  end if;

  if action = 'store_save' then
    v_name := btrim(coalesce(payload->>'name',''));
    if v_name = '' then return tandem.err('validation', 'Название склада пустое'); end if;
    v_point := nullif(payload->>'point_id','');
    if v_point is not null and not exists (select 1 from tandem.points where id = v_point) then
      return tandem.err('validation', 'Точка не найдена');
    end if;
    v_id := nullif(payload->>'id','')::uuid;
    if v_id is null then
      insert into tandem.stores (name, point_id, active)
        values (v_name, v_point, coalesce((payload->>'active')::boolean, true)) returning id into v_id;
    else
      update tandem.stores set name = v_name, point_id = v_point,
        active = coalesce((payload->>'active')::boolean, active) where id = v_id;
      if not found then return tandem.err('not_found', 'Склад не найден'); end if;
      -- отвязанный или выключенный склад не может быть складом по умолчанию
      update tandem.points set default_store_id = null
        where default_store_id = v_id and (v_point is null or id <> v_point or not coalesce((payload->>'active')::boolean, true));
    end if;
    if coalesce((payload->>'is_default')::boolean, false) and v_point is not null
       and exists (select 1 from tandem.stores where id = v_id and active) then
      update tandem.points set default_store_id = v_id where id = v_point;
    elsif payload ? 'is_default' and not (payload->>'is_default')::boolean then
      update tandem.points set default_store_id = null where default_store_id = v_id;
    end if;
    return jsonb_build_object('ok', true, 'id', v_id);
  end if;

  -- Точки продаж: режим экрана точки, код входа, юрлицо, группы меню. Служебные точки теста (zz_*)
  -- не показываются и не правятся. Код точки не отдаётся — только признак «задан»; новый код задаётся явно.
  if action = 'store_points_list' then
    return jsonb_build_object('ok', true,
      'points', (select coalesce(jsonb_agg(jsonb_build_object(
          'id', p.id, 'name', p.name, 'mode', p.mode, 'legal_entity', p.legal_entity, 'active', p.active,
          'sort_order', p.sort_order, 'item_categories', coalesce(to_jsonb(p.item_categories), '[]'::jsonb),
          'store_name', s.name, 'has_pin', coalesce(p.pin, '') <> '') order by p.sort_order, p.name), '[]'::jsonb)
        from tandem.points p left join tandem.stores s on s.id = p.default_store_id
       where p.id not like 'zz\_%'),
      'categories', (select coalesce(jsonb_agg(c order by c), '[]'::jsonb)
        from (select distinct category c from tandem.items where active and for_sale and category is not null) x),
      'legal_entities', (select coalesce(jsonb_agg(distinct legal_entity), '[]'::jsonb) from tandem.points where legal_entity is not null));
  end if;

  if action = 'store_point_save' then
    v_point := btrim(coalesce(payload->>'id', ''));
    v_name := btrim(coalesce(payload->>'name', ''));
    if v_point = '' or v_point like 'zz\_%' then return tandem.err('validation', 'Не указана точка'); end if;
    if v_name = '' then return tandem.err('validation', 'Название точки обязательно'); end if;
    if coalesce(payload->>'mode', '') not in ('position', 'takeout', 'import', 'manual', 'checks') then
      return tandem.err('validation', 'Неизвестный режим точки'); end if;
    if nullif(payload->>'pin', '') is not null then
      if payload->>'pin' !~ '^[0-9]{4,8}$' then
        return tandem.err('validation', 'Код точки — от 4 до 8 цифр'); end if;
      -- Вход на экран точки сначала сверяет код собственника и водителя: совпадение с ними открыло бы
      -- чужую роль. Совпадение с кодом другой точки путает людей.
      if payload->>'pin' in (select value from tandem.settings where key in ('owner_pin', 'driver_pin'))
         or exists (select 1 from tandem.points where pin = payload->>'pin' and id <> v_point) then
        return tandem.err('validation', 'Этот код уже занят — придумайте другой'); end if;
    end if;
    -- Перевод в «касса» посреди дня: первый чек пересобрал бы деньги и продажи дня из чеков и стёр
    -- уже сданный отчёт. Если сегодня (по местной дате) отчёт с данными уже есть и он не из чеков —
    -- режим меняют завтра.
    if payload->>'mode' = 'checks'
       and exists (select 1 from tandem.points where id = v_point and mode <> 'checks')
       and exists (select 1 from tandem.daily_reports d
                    where d.point_id = v_point and d.report_date = tandem.local_now()::date
                      and (d.cash <> 0 or d.kaspi_qr <> 0 or d.transfer <> 0 or d.card <> 0
                           or exists (select 1 from tandem.sale_lines s where s.report_id = d.id)
                           or exists (select 1 from tandem.takeout_lines t where t.report_id = d.id)
                           or exists (select 1 from tandem.cash_expenses e where e.report_id = d.id)))
       and not exists (select 1 from tandem.checks c where c.point_id = v_point and c.check_date = tandem.local_now()::date) then
      return tandem.err('validation', 'Сегодня у точки уже есть отчёт — переключите режим завтра');
    end if;
    if not exists (select 1 from tandem.points where id = v_point) then
      if v_point !~ '^[a-z][a-z0-9_]{1,30}$' then
        return tandem.err('validation', 'Код новой точки — латиница, цифры и подчёркивание, например eneshka2'); end if;
      if nullif(payload->>'pin', '') is null then return tandem.err('validation', 'Для новой точки задайте код входа'); end if;
      insert into tandem.points (id, name, mode, pin, legal_entity, active, sort_order)
        values (v_point, v_name, payload->>'mode', payload->>'pin', nullif(btrim(coalesce(payload->>'legal_entity', '')), ''),
                coalesce((payload->>'active')::boolean, true), coalesce((select max(sort_order) from tandem.points where id not like 'zz\_%'), 0) + 10);
    end if;
    update tandem.points set name = v_name, mode = payload->>'mode',
           legal_entity = nullif(btrim(coalesce(payload->>'legal_entity', '')), ''),
           active = coalesce((payload->>'active')::boolean, active),
           item_categories = case when jsonb_typeof(payload->'item_categories') = 'array'
                                  then array(select jsonb_array_elements_text(payload->'item_categories')) else item_categories end,
           pin = coalesce(nullif(payload->>'pin', ''), pin)
     where id = v_point;
    return jsonb_build_object('ok', true, 'id', v_point);
  end if;

  return tandem.err('unknown_action', 'Неизвестное действие: ' || action);
end $$;

-- ---------------------------------------------------------------- пользователи бэк-офиса
create or replace function tandem.office_users(action text, payload jsonb, v_user tandem.users)
returns jsonb language plpgsql set search_path to 'tandem', 'public', 'extensions' as $$
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
      'roles', jsonb_build_array('admin','owner','accountant','technologist','storekeeper'));
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
    if length(v_pin) < 4 or v_pin !~ '^[0-9]+$' then return tandem.err('validation', 'PIN — не меньше 4 цифр'); end if;
    update tandem.users set pin_hash = crypt(v_pin, gen_salt('bf')), must_change_pin = true,
      failed_attempts = 0, locked_until = null where id = v_id;
    if not found then return tandem.err('not_found', 'Пользователь не найден'); end if;
    delete from tandem.sessions where user_id = v_id;
    return jsonb_build_object('ok', true);
  end if;

  return tandem.err('unknown_action', 'Неизвестное действие: ' || action);
end $$;

-- ---------------------------------------------------------------- права
do $$
declare f text;
begin
  foreach f in array array[
      'tandem.num_clean(text)', 'tandem.num_ok(text)', 'tandem.to_num(text)', 'tandem.to_date(text)',
      'tandem.jlist(jsonb)', 'tandem.pin_ip_blocked(text)',
      'tandem.check_save(text,jsonb)', 'tandem.check_void(text,jsonb)',
      'public.tandem_api(text,jsonb)', 'public.tandem_gate(text,jsonb)', 'public.tandem_office(text,jsonb)',
      'public.tandem_realization(text,text,jsonb)', 'public.tandem_test_cleanup(text)',
      'tandem.office_stores(text,jsonb,tandem.users)', 'tandem.office_users(text,jsonb,tandem.users)'] loop
    execute 'revoke all on function ' || f || ' from public';
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute 'revoke all on function ' || f || ' from anon, authenticated';
      execute 'grant execute on function ' || f || ' to service_role';
    end if;
  end loop;
end $$;
