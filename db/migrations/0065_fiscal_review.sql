-- 0065: фискализация - исправления по ревизии 22.11.2026 (участок «Касса и фискальный чек»).
-- - «Неизвестно, пробит ли» (fiscal_status = unknown): Webkassa не ответила (таймаут, обрыв, 5xx), ответила «чек
--   уже есть», а в истории он не нашёлся, или ответ не записался в базу. Такой чек, как и «пробивается»
--   (pending) любой давности, не исправляется: иначе повтор записал бы фискальный признак старого чека к новому
--   составу. Отмена такого чека ставит возврат в режим проверки (fiscal_return_status = check): сервер сначала
--   узнаёт у Webkassa, есть ли продажа, и пробивает возврат, только если она есть.
-- - mismatch: Webkassa сказала «уже есть», а найденный чек на другую сумму или с другим типом оплаты (чек
--   исправили после обрыва до 0065). Не исправляется, повтор не идёт; при отмене возврат - через офис (manual).
-- - fiscal_prepare: второй запрос на чек, который пробивается (вторая вкладка, повтор, двойное касание), - отказ
--   «пробивается», а не второй запрос в Webkassa; чек, записанный до включения фискального чека (fiscal_since),
--   не пробивается и после правки; Z-отчёт предупреждает о не пробитых возвратах и чеках прошлых дней (warn);
--   журнал внесений и изъятий дня (op journal) - для сверки во вкладке «Смена» кассы.
-- - РНМ для возврата чека, найденного в истории Webkassa: если его нет в ответе - с прошлых чеков точки.
-- - tandem.fiscal_unfiscal(точка, день) - не пробитые продажи дня: их считает Z-отчёт, а закрытие смены в учёте
--   (save_report) может отказать по тому же счёту.
-- Функции заменяются целиком (текст - с базы стенда 22.11.2026). Миграция повторяемая.

-- возврат «пробивается»: второй запрос на тот же возврат в Webkassa не уходит (как fiscal_at у продажи)
alter table tandem.checks add column if not exists fiscal_return_try_at timestamptz;

-- ---------------------------------------------------------------- правка чека
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
  -- 0065: строка чека под замком: fiscal_prepare берёт её так же, и правка не проскочит между «пробивается»
  -- и телом запроса в Webkassa
  select * into v_chk from tandem.checks where uid = v_uid for update;
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
    -- 0065: правку держат и «пробивается» любой давности, и «неизвестно, пробит ли» (чек мог уйти в налоговую),
    -- и чек, который в налоговой пробит на другую сумму
    if v_closed is not null or v_date < v_today - 2 or v_chk.fiscal_status in ('ok', 'pending', 'unknown', 'mismatch') then
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
      -- 0053: пробитый в налоговой чек не меняется - его отменяют (чек возврата) и пробивают новый.
      if v_chk.fiscal_status = 'ok' then
        return jsonb_build_object('ok', false, 'error', 'Чек уже пробит в налоговой: исправить его нельзя. Отмените чек (будет чек возврата) и пробейте заново'); end if;
      -- 0065: в налоговой этот чек на другую сумму - только отмена и офис
      if v_chk.fiscal_status = 'mismatch' then
        return jsonb_build_object('ok', false, 'error', 'Чек уже пробит в налоговой, и там другая сумма: исправить его нельзя. Отмените чек и позвоните в офис'); end if;
      -- 0056, 0065: ответ Webkassa ещё не пришёл - фискальный чек выйдет по прежним строкам
      if v_chk.fiscal_status = 'pending' then
        return jsonb_build_object('ok', false, 'error', 'Чек пробивается в налоговой: исправить его нельзя. Дождитесь ответа; изменить продажу - отменить чек и пробить новый'); end if;
      -- 0065: Webkassa не ответила - чек мог уйти в налоговую
      if v_chk.fiscal_status = 'unknown' then
        return jsonb_build_object('ok', false, 'error', 'Неизвестно, пробит ли чек в налоговой (Webkassa не ответила): исправить его нельзя. '
                                  || 'Нажмите у чека «Проверить в налоговой»; если продажи не было - отмените чек'); end if;
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
end $function$;

-- ---------------------------------------------------------------- отмена чека
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
  select * into v_chk from tandem.checks where uid = v_uid and point_id = p_point for update;   -- 0065: как в fiscal_prepare
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
    -- 0056: продажа сейчас пробивается в налоговой - отмена подождёт ответа, иначе возврат не встанет в очередь
    if v_chk.fiscal_status = 'pending' and v_chk.fiscal_at > now() - interval '2 minutes' then
      return jsonb_build_object('ok', false, 'error', 'Чек пробивается в налоговой - отмените его через минуту'); end if;
    -- 0065: возврат пробитого - в очередь; «неизвестно, пробит ли» и зависший «пробивается» - сначала проверка
    -- в Webkassa (check): возврат будет, только если продажа там есть; пробитый на другую сумму - через офис
    update tandem.checks set status = 'void', updated_at = now(), void_reason = v_reason,
           fiscal_return_status = case when fiscal_status = 'ok' then 'pending'
                                       when fiscal_status in ('unknown', 'pending') then 'check'
                                       when fiscal_status = 'mismatch' then 'manual' end
     where id = v_chk.id;
    perform tandem.check_apply(p_point, v_chk.check_date);
  end if;
  return jsonb_build_object('ok', true);
end $function$;

-- ---------------------------------------------------------------- тело запроса в Webkassa
CREATE OR REPLACE FUNCTION tandem.fiscal_body(p_chk tandem.checks, p_op text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'tandem', 'public'
AS $function$
declare
  v_pt  tandem.points;
  v_pos jsonb;
  v_vat numeric;
begin
  select * into v_pt from tandem.points where id = p_chk.point_id;
  v_vat := nullif(v_pt.fiscal_vat, 0);
  select coalesce(jsonb_agg(x.pos order by x.id), '[]'::jsonb) into v_pos from (
    select l.id, jsonb_strip_nulls(jsonb_build_object(
      'Count', l.qty,
      'Price', case when coalesce(l.price_list, 0) > l.price then l.price_list else l.price end,
      'Discount', case when coalesce(l.price_list, 0) > l.price then round(l.price_list * l.qty, 2) - round(l.price * l.qty, 2) else 0 end,
      'Markup', 0,
      'TaxType', case when v_vat is null then 0 else 100 end,
      'TaxPercent', coalesce(v_vat, 0),
      'Tax', case when v_vat is null then 0 else round(round(l.qty * l.price, 2) * v_vat / (100 + v_vat), 2) end,
      'PositionName', left(l.item_name, 250),
      'PositionCode', l.item_code,
      'SectionCode', '1',
      'UnitCode', case coalesce(i.unit_id, i.unit) when 'кг' then 166 when 'л' then 112 else 796 end,
      'PositionType', coalesce(i.position_type, 0),
      'NTIN', nullif(btrim(coalesce(i.ntin, '')), ''),
      'GTIN', nullif(btrim(coalesce(i.gtin, '')), ''),
      'WarehouseType', 0)) pos
    from tandem.check_lines l left join tandem.items i on i.code = l.item_code
    where l.check_id = p_chk.id and round(l.qty * l.price, 2) > 0) x;
  return jsonb_strip_nulls(jsonb_build_object(
    'CashboxUniqueNumber', v_pt.fiscal_cashbox,
    'OperationType', case when p_op = 'return' then 3 else 2 end,
    'Positions', v_pos,
    'Payments', jsonb_build_array(jsonb_build_object('Sum', p_chk.total,
       'PaymentType', case p_chk.pay_kind when 'cash' then 0 when 'card' then 1 else 4 end)),
    'RoundType', 0,
    'ExternalCheckNumber', p_chk.uid::text || case when p_op = 'return' then ':r' else '' end,
    'ExternalOrderNumber', p_chk.point_id || '-' || to_char(p_chk.check_date, 'YYYYMMDD') || '-' || p_chk.no,
    -- 0065: РНМ обязателен в основании возврата; у чека, найденного в истории Webkassa, его могло не быть -
    -- берём с прошлых пробитых чеков точки (касса точки одна)
    'ReturnBasisDetails', case when p_op = 'return' then jsonb_build_object(
       'CheckNumber', p_chk.fiscal_number, 'DateTime', p_chk.fiscal_dt,
       'RegistrationNumber', coalesce(p_chk.fiscal_rnm, (select c2.fiscal_rnm from tandem.checks c2
                                 where c2.point_id = p_chk.point_id and c2.fiscal_rnm is not null order by c2.fiscal_at desc nulls last limit 1)),
       'Total', p_chk.total, 'IsOffline', coalesce(p_chk.fiscal_offline, false)) end));
end $function$;

-- ---------------------------------------------------------------- не пробитые продажи дня
-- Сколько продаж дня у точки с фискальным чеком не пробито в налоговой (после включения фискального чека, 0058):
-- Z-отчёт с ними не снимается. Закрытие смены в учёте (save_report) может звать то же, чтобы не закрывать смену,
-- которую Webkassa потом не закроет.
CREATE OR REPLACE FUNCTION tandem.fiscal_unfiscal(p_point text, p_date date)
 RETURNS integer
 LANGUAGE sql
 STABLE
 SET search_path TO 'tandem', 'public'
AS $function$
  select count(*)::int
    from tandem.checks c join tandem.points p on p.id = c.point_id
   where c.point_id = p_point and c.check_date = p_date and c.status = 'active' and c.total > 0
     and p.fiscal_enabled and p.mode = 'checks' and coalesce(btrim(p.fiscal_cashbox), '') <> ''
     and c.fiscal_status is distinct from 'ok'
     and (c.fiscal_status is not null or c.created_at >= coalesce(p.fiscal_since, '-infinity'::timestamptz))
$function$;

-- ---------------------------------------------------------------- запрос к Webkassa (гейт, код точки)
CREATE OR REPLACE FUNCTION tandem.fiscal_prepare(p_point text, payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'tandem', 'public'
AS $function$
declare
  v_op  text := coalesce(nullif(payload->>'op', ''), 'sale');
  v_pt  tandem.points;
  v_uid uuid;
  v_chk tandem.checks;
  v_paper int;
  v_kind text; v_sum numeric; v_ext text; v_m tandem.fiscal_money; v_left int;
  v_today date := tandem.local_now()::date;
  v_ret int; v_old int; v_man int; v_warn text; v_date date;   -- 0065: предупреждения Z, журнал дня
begin
  select * into v_pt from tandem.points where id = p_point;
  if not (coalesce(v_pt.fiscal_enabled, false) and v_pt.mode = 'checks' and coalesce(btrim(v_pt.fiscal_cashbox), '') <> '') then
    return jsonb_build_object('ok', true, 'skip', true);
  end if;
  v_paper := case when v_pt.fiscal_paper = 80 then 0 else 3 end;
  if v_op = 'z' then
    v_left := tandem.fiscal_unfiscal(p_point, v_today);
    if v_left > 0 then
      return jsonb_build_object('ok', false, 'unfiscal', v_left, 'error', 'не пробиты в налоговой чеков - ' || v_left
        || '. Пробейте их в кассе (вкладка «Смена», кнопка у чека) и закройте смену ещё раз');
    end if;
    -- 0065: о чём Z предупреждает, но не останавливается: не пробитые возвраты отменённых чеков (продажа в смене
    -- Webkassa уже есть) и не пробитые чеки двух прошлых дней - касса пробивает их сама; чеки с расхождением - офису
    select count(*) filter (where c.status = 'void' and c.fiscal_return_status in ('pending', 'error', 'check')),
           count(*) filter (where c.status = 'active' and c.check_date < v_today and c.total > 0
                              and c.fiscal_status is distinct from 'ok' and c.fiscal_status is distinct from 'mismatch'
                              and (c.fiscal_status is not null or c.created_at >= coalesce(v_pt.fiscal_since, '-infinity'::timestamptz))),
           count(*) filter (where c.fiscal_status = 'mismatch' or c.fiscal_return_status = 'manual')
      into v_ret, v_old, v_man
      from tandem.checks c where c.point_id = p_point and c.check_date >= v_today - 2;
    if v_ret + v_old > 0 then
      v_warn := 'не пробиты в налоговой ' || concat_ws(' и ', case when v_ret > 0 then 'возвраты - ' || v_ret end,
                                                       case when v_old > 0 then 'чеки прошлых дней - ' || v_old end)
                || ': касса пробьёт их сама, проверьте вкладку «Смена» кассы';
    end if;
    if v_man > 0 then
      v_warn := concat_ws('. ', v_warn, 'Чеков с расхождением с налоговой - ' || v_man || ': позвоните в офис');
    end if;
    return jsonb_build_object('ok', true, 'op', v_op, 'cashbox', v_pt.fiscal_cashbox, 'date', v_today,
                              'warn', case when v_warn is not null then 'Внимание: ' || v_warn end);
  end if;
  if v_op = 'x' then
    return jsonb_build_object('ok', true, 'op', v_op, 'cashbox', v_pt.fiscal_cashbox, 'date', v_today);
  end if;
  -- 0065: журнал внесений и изъятий дня - сверка с «Остатком на начало» и «Расходами из кассы» формы закрытия
  if v_op = 'journal' then
    v_date := coalesce(tandem.to_date(payload->>'date'), v_today);
    return jsonb_build_object('ok', true, 'done', true, 'date', v_date,
      'journal', (select coalesce(jsonb_agg(jsonb_build_object('kind', m.kind, 'sum', m.sum, 'reason', m.reason, 'seller', m.seller,
                            'auto', m.auto, 'ok', m.ok, 'error', m.error, 'at', m.created_at) order by m.id), '[]'::jsonb)
                    from tandem.fiscal_money m
                   where m.point_id = p_point and ((m.created_at at time zone 'UTC') + interval '5 hours')::date = v_date),
      'in', (select coalesce(sum(m.sum), 0) from tandem.fiscal_money m where m.point_id = p_point and m.ok and m.kind = 'in'
                and ((m.created_at at time zone 'UTC') + interval '5 hours')::date = v_date),
      'out', (select coalesce(sum(m.sum), 0) from tandem.fiscal_money m where m.point_id = p_point and m.ok and m.kind = 'out'
                and ((m.created_at at time zone 'UTC') + interval '5 hours')::date = v_date));
  end if;
  if v_op = 'money' then
    v_kind := payload->>'kind';
    begin v_sum := round((payload->>'sum')::numeric, 2); exception when others then v_sum := null; end;
    v_ext := left(btrim(coalesce(payload->>'ext', '')), 64);
    if v_kind not in ('in', 'out') then return jsonb_build_object('ok', false, 'error', 'Внесение или изъятие?'); end if;
    if v_sum is null or v_sum <= 0 or v_sum > 10000000 then return jsonb_build_object('ok', false, 'error', 'Сумма - больше нуля'); end if;
    if v_ext = '' then return jsonb_build_object('ok', false, 'error', 'Нет номера операции'); end if;
    if v_kind = 'out' and coalesce(btrim(payload->>'reason'), '') = '' then
      return jsonb_build_object('ok', false, 'error', 'Напишите, на что изъяли наличные'); end if;
    insert into tandem.fiscal_money (point_id, ext, kind, sum, reason, seller)
      values (p_point, v_ext, v_kind, v_sum, nullif(left(btrim(coalesce(payload->>'reason', '')), 300), ''),
              nullif(left(btrim(coalesce(payload->>'seller', '')), 120), ''))
      on conflict (ext) do nothing;
    select * into v_m from tandem.fiscal_money where ext = v_ext;
    if v_m.point_id <> p_point then return jsonb_build_object('ok', false, 'error', 'Нет доступа'); end if;
    if v_m.ok then return jsonb_build_object('ok', true, 'done', true, 'money', to_jsonb(v_m) - 'data'); end if;
    return jsonb_build_object('ok', true, 'op', v_op, 'cashbox', v_pt.fiscal_cashbox, 'kind', v_m.kind, 'sum', v_m.sum, 'ext', v_m.ext);
  end if;
  if v_op not in ('sale', 'return', 'print') then return jsonb_build_object('ok', false, 'error', 'Неизвестная операция кассы'); end if;
  begin v_uid := (payload->>'uid')::uuid; exception when others then v_uid := null; end;
  -- 0065: строка чека под замком до конца запроса: два одновременных запроса не уходят в Webkassa оба
  select * into v_chk from tandem.checks where uid = v_uid and point_id = p_point for update;
  if v_chk.id is null then return jsonb_build_object('ok', false, 'error', 'Чек не найден'); end if;
  if v_op = 'print' then
    if v_chk.fiscal_status is distinct from 'ok' then return jsonb_build_object('ok', false, 'error', 'Чек ещё не пробит в налоговой'); end if;
    return jsonb_build_object('ok', true, 'op', v_op, 'cashbox', v_pt.fiscal_cashbox, 'paper', v_paper,
      'ext', v_chk.uid::text || case when v_chk.fiscal_return_status = 'ok' and payload->>'which' = 'return' then ':r' else '' end);
  end if;
  if v_op = 'sale' then
    if v_chk.fiscal_status = 'ok' then
      return jsonb_build_object('ok', true, 'done', true, 'fiscal', tandem.fiscal_json(v_chk));
    end if;
    if v_chk.status <> 'active' then return jsonb_build_object('ok', true, 'skip', true, 'reason', 'Чек отменён'); end if;
    if v_chk.total <= 0 then return jsonb_build_object('ok', true, 'skip', true, 'reason', 'Сумма чека 0'); end if;
    -- 0065: чек записан до включения фискального чека у точки (0058) - в налоговую не идёт и после правки
    if v_chk.fiscal_status is null and v_chk.created_at < v_pt.fiscal_since then
      return jsonb_build_object('ok', true, 'skip', true, 'reason', 'Чек записан до включения фискального чека'); end if;
    -- 0065: в налоговой этот чек пробит на другую сумму - повтор не поможет
    if v_chk.fiscal_status = 'mismatch' then
      return jsonb_build_object('ok', false, 'mismatch', true,
        'error', coalesce(v_chk.fiscal_error, 'В налоговой этот чек пробит на другую сумму - отмените чек и позвоните в офис')); end if;
    -- 0065: чек уже пробивается (повтор, вторая вкладка, двойное касание) - второй запрос в Webkassa не шлём
    if v_chk.fiscal_status = 'pending' and v_chk.fiscal_at > now() - interval '2 minutes' then
      return jsonb_build_object('ok', false, 'busy', true, 'error', 'Чек пробивается в налоговой - подождите минуту'); end if;
    -- 0056: чек пробивается - правка и отмена ждут ответа Webkassa (check_save, check_void)
    update tandem.checks set fiscal_status = 'pending', fiscal_at = now() where id = v_chk.id returning * into v_chk;
  else
    if v_chk.fiscal_return_status = 'ok' then
      return jsonb_build_object('ok', true, 'done', true, 'fiscal', tandem.fiscal_json(v_chk));
    end if;
    -- 0065: продажа отменённого чека «неизвестно, пробита ли» - сначала узнать у Webkassa: сервер ищет её в
    -- истории смены и при необходимости повторяет тот же запрос продажи (sale_body), затем пробивает возврат.
    -- Тело продажи - не в body: сервер до 0065 пробил бы его как возврат.
    if v_chk.fiscal_return_status = 'check' and v_chk.status = 'void' then
      if v_chk.fiscal_status = 'pending' and v_chk.fiscal_at > now() - interval '2 minutes' then
        return jsonb_build_object('ok', false, 'busy', true, 'error', 'Чек проверяется в налоговой - подождите минуту'); end if;
      update tandem.checks set fiscal_status = 'pending', fiscal_at = now() where id = v_chk.id returning * into v_chk;
      return jsonb_build_object('ok', true, 'op', v_op, 'probe', true, 'cashbox', v_pt.fiscal_cashbox, 'paper', v_paper,
        'shift_hint', v_chk.fiscal_shift, 'sale_body', tandem.fiscal_body(v_chk, 'sale'));
    end if;
    if v_chk.fiscal_return_status = 'manual' then
      return jsonb_build_object('ok', false, 'mismatch', true,
        'error', 'В налоговой этот чек пробит на другую сумму: возврат оформит офис в кабинете Webkassa'); end if;
    if v_chk.fiscal_status is distinct from 'ok' then return jsonb_build_object('ok', true, 'skip', true, 'reason', 'Чек не был пробит'); end if;
    if v_chk.status <> 'void' then return jsonb_build_object('ok', false, 'error', 'Возврат пробивается для отменённого чека'); end if;
    -- 0065: возврат уже пробивается - второй запрос в Webkassa не шлём
    if v_chk.fiscal_return_try_at > now() - interval '2 minutes' then
      return jsonb_build_object('ok', false, 'busy', true, 'error', 'Возврат пробивается в налоговой - подождите минуту'); end if;
    update tandem.checks set fiscal_return_try_at = now() where id = v_chk.id returning * into v_chk;
  end if;
  return jsonb_build_object('ok', true, 'op', v_op, 'cashbox', v_pt.fiscal_cashbox, 'paper', v_paper,
    'shift_hint', v_chk.fiscal_shift, 'body', tandem.fiscal_body(v_chk, v_op));
end $function$;

-- ---------------------------------------------------------------- запись результата (только сервер)
CREATE OR REPLACE FUNCTION public.tandem_fiscal_store(p_point text, p_uid uuid, p_op text, p_ok boolean, p_data jsonb, p_error text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'tandem', 'public'
AS $function$
declare
  v_chk tandem.checks;
  v_num text := coalesce(p_data->>'CheckNumber', p_data->>'Number');
  v_url text := p_data->>'TicketUrl';
  v_m tandem.fiscal_money;
  v_state text;      -- 0065: исход продажи: ok, error, unknown, mismatch
  v_has boolean;     -- 0065: в ответе данные фискального чека (пробит или найден в истории)
begin
  if p_op = 'z' then
    update tandem.daily_reports set fiscal_z_at = case when p_ok then now() else fiscal_z_at end,
           fiscal_z_shift = case when p_ok then coalesce((p_data->>'ShiftNumber')::int, fiscal_z_shift) else fiscal_z_shift end,
           fiscal_z_error = case when p_ok then null else left(p_error, 500) end
     where point_id = p_point and report_date = coalesce((p_data->>'report_date')::date, tandem.local_now()::date);
    return jsonb_build_object('ok', true);
  end if;
  -- 0056: внесение/изъятие. p_data: ext, kind, sum, reason, seller, auto и ответ Webkassa в response.
  if p_op = 'money' then
    insert into tandem.fiscal_money as m (point_id, ext, kind, sum, reason, seller, auto, ok, error, shift, data, done_at)
      values (p_point, p_data->>'ext', p_data->>'kind', (p_data->>'sum')::numeric, p_data->>'reason', p_data->>'seller',
              coalesce((p_data->>'auto')::boolean, false), p_ok, case when p_ok then null else left(p_error, 500) end,
              (p_data->'response'->>'ShiftNumber')::int, p_data->'response', now())
      on conflict (ext) do update set ok = m.ok or excluded.ok,
              error = case when m.ok or excluded.ok then null else excluded.error end,
              shift = coalesce(excluded.shift, m.shift), data = coalesce(excluded.data, m.data), done_at = now()
      returning * into v_m;
    return jsonb_build_object('ok', true, 'money', to_jsonb(v_m) - 'data');
  end if;
  select * into v_chk from tandem.checks where uid = p_uid and point_id = p_point for update;
  if v_chk.id is null then return tandem.err('not_found', 'Чек не найден'); end if;
  if p_op = 'sale' then
    if v_chk.fiscal_status = 'ok' then return jsonb_build_object('ok', true, 'fiscal', tandem.fiscal_json(v_chk)); end if;
    -- 0065: error - Webkassa отказала, чека в налоговой нет; unknown - ответа нет или «уже есть», а чек не нашёлся
    -- (мог уйти в налоговую); mismatch - в налоговой этот чек на другую сумму или с другой оплатой
    v_state := case when p_ok then 'ok' when p_data->>'state' in ('unknown', 'mismatch') then p_data->>'state' else 'error' end;
    v_has := v_state in ('ok', 'mismatch');
    update tandem.checks set
      fiscal_status = v_state,
      fiscal_number = case when v_has then v_num end,
      fiscal_dt = case when v_has then coalesce(p_data->>'DateTime', p_data->>'RegistratedOn') end,
      -- 0065: РНМ - из ответа; у найденного в истории его кладёт сервер из списка касс, иначе - с прошлых чеков точки
      fiscal_rnm = case when v_has then coalesce(p_data->'Cashbox'->>'RegistrationNumber', p_data->>'CashboxRegistrationNumber',
                     (select c2.fiscal_rnm from tandem.checks c2 where c2.point_id = p_point and c2.fiscal_rnm is not null
                       order by c2.fiscal_at desc nulls last limit 1)) end,
      fiscal_shift = case when v_has then (p_data->>'ShiftNumber')::int end,
      fiscal_url = case when v_has then v_url end,
      fiscal_offline = case when v_has then coalesce((p_data->>'OfflineMode')::boolean, (p_data->>'IsOffline')::boolean, false) end,
      fiscal_error = case when v_state = 'ok' then null else left(p_error, 500) end,
      fiscal_tries = fiscal_tries + 1, fiscal_at = now(),
      fiscal_return_status = case
        when status <> 'void' then fiscal_return_status
        -- 0056: чек отменили, пока он пробивался, - продажа в налоговой есть, нужен чек возврата (0065: и после проверки)
        when v_state = 'ok' then case when fiscal_return_status is null or fiscal_return_status = 'check' then 'pending' else fiscal_return_status end
        when v_state = 'mismatch' then 'manual'
        -- 0065: проверка отменённого: в истории Webkassa продажи нет и та же продажа получила отказ - возврат не нужен
        when v_state = 'error' and fiscal_return_status = 'check' then null
        else fiscal_return_status end
     where id = v_chk.id returning * into v_chk;
  elsif p_op = 'return' then
    if v_chk.fiscal_return_status = 'ok' then return jsonb_build_object('ok', true, 'fiscal', tandem.fiscal_json(v_chk)); end if;
    update tandem.checks set
      -- 0065: неудача не снимает «проверить продажу» (check): возврат решится после проверки
      fiscal_return_status = case when p_ok then 'ok' when fiscal_return_status = 'check' then 'check' else 'error' end,
      fiscal_return_number = case when p_ok then v_num end,
      fiscal_return_url = case when p_ok then v_url end,
      fiscal_return_error = case when p_ok then null else left(p_error, 500) end,
      fiscal_return_at = case when p_ok then now() end,
      fiscal_return_try_at = null
     where id = v_chk.id returning * into v_chk;
  else
    return tandem.err('validation', 'Неизвестная операция');
  end if;
  return jsonb_build_object('ok', true, 'fiscal', tandem.fiscal_json(v_chk));
end $function$;

-- ---------------------------------------------------------------- данные
-- Чеки последних трёх дней, у которых сетевой отказ Webkassa записан как «не пробит» (до 0065), - «неизвестно,
-- пробит ли»: их правка закрыта, касса проверит их сама. Отменённые с такой продажей (и с зависшим «пробивается»)
-- - на проверку в Webkassa перед возвратом.
update tandem.checks set fiscal_status = 'unknown'
 where fiscal_status = 'error' and check_date >= tandem.local_now()::date - 2
   and (fiscal_error like 'Нет связи с Webkassa%' or fiscal_error like 'Webkassa ответила HTTP 5%');
update tandem.checks set fiscal_return_status = 'check'
 where status = 'void' and fiscal_return_status is null and check_date >= tandem.local_now()::date - 2
   and (fiscal_status = 'unknown' or (fiscal_status = 'pending' and fiscal_at < now() - interval '2 minutes'));

-- ---------------------------------------------------------------- права (как в 0053: запись результата - только сервер)
revoke all on function public.tandem_fiscal_store(text, uuid, text, boolean, jsonb, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function public.tandem_fiscal_store(text, uuid, text, boolean, jsonb, text) from anon, authenticated;
    grant execute on function public.tandem_fiscal_store(text, uuid, text, boolean, jsonb, text) to service_role;
  end if;
end $$;
