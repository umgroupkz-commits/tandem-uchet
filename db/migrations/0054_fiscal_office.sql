-- 0054: фискализация в бэк-офисе (продолжение 0053).
-- - Склады → Точки продаж: включить фискальный чек у точки, заводской номер кассы Webkassa, ставка НДС,
--   ширина ленты. Включить можно только у точки в режиме «касса» и с номером кассы.
-- - Карточка позиции: НТИН, GTIN (штрихкод) и вид позиции в чеке (товар или услуга).
-- - «Готовность»: товары без НТИН, которые продают точки с фискальным чеком.
-- Существующие функции правятся по якорю из текущего текста в базе (якорь обязан встретиться ровно раз).

create or replace function pg_temp.patch(p_fn regprocedure, p_from text, p_to text) returns void language plpgsql as $$
declare d text := pg_get_functiondef(p_fn); n int;
begin
  n := (length(d) - length(replace(d, p_from, ''))) / length(p_from);
  if n = 0 and position(p_to in d) > 0 then return; end if;   -- уже применено (повторный прогон)
  if n <> 1 then raise exception '0054: якорь в % встретился % раз: %', p_fn, n, left(p_from, 80); end if;
  execute replace(d, p_from, p_to);
end $$;

-- ---------------------------------------------------------------- точки продаж
select pg_temp.patch('tandem.office_stores(text,jsonb,tandem.users)',
  $a$'store_name', s.name, 'has_pin', coalesce(p.pin, '') <> '')$a$,
  $a$'store_name', s.name, 'has_pin', coalesce(p.pin, '') <> '',
          'fiscal_enabled', p.fiscal_enabled, 'fiscal_cashbox', p.fiscal_cashbox, 'fiscal_vat', p.fiscal_vat,
          'fiscal_paper', p.fiscal_paper)$a$);

select pg_temp.patch('tandem.office_stores(text,jsonb,tandem.users)',
  $a$    if not exists (select 1 from tandem.points where id = v_point) then
      if v_point !~ '^[a-z][a-z0-9_]{1,30}$' then$a$,
  $a$    -- 0054: фискальный чек (Webkassa). Ключи приходят только из формы, которая их знает: старая форма
    -- без них настройки не трогает. Включённый требует режима «касса» и заводского номера кассы.
    if payload ? 'fiscal_paper' and coalesce(payload->>'fiscal_paper', '') not in ('58', '80') then
      return tandem.err('validation', 'Ширина ленты чека - 58 или 80 мм'); end if;
    if nullif(payload->>'fiscal_vat', '') is not null and payload->>'fiscal_vat' not in ('0', '12', '16') then
      return tandem.err('validation', 'Ставка НДС в чеке - 12 или 16 %, или без НДС'); end if;
    if coalesce((payload->>'fiscal_enabled')::boolean, false) then
      if payload->>'mode' <> 'checks' then
        return tandem.err('validation', 'Фискальный чек пробивает только касса: переключите точку в режим «касса»'); end if;
      if coalesce(btrim(case when payload ? 'fiscal_cashbox' then payload->>'fiscal_cashbox'
                             else (select fiscal_cashbox from tandem.points where id = v_point) end), '') = '' then
        return tandem.err('validation', 'Для фискального чека укажите заводской номер кассы Webkassa (SWK…)'); end if;
    end if;
    if not exists (select 1 from tandem.points where id = v_point) then
      if v_point !~ '^[a-z][a-z0-9_]{1,30}$' then$a$);

select pg_temp.patch('tandem.office_stores(text,jsonb,tandem.users)',
  $a$           pin = coalesce(nullif(payload->>'pin', ''), pin)
     where id = v_point;$a$,
  $a$           pin = coalesce(nullif(payload->>'pin', ''), pin),
           fiscal_enabled = coalesce((payload->>'fiscal_enabled')::boolean, fiscal_enabled),
           fiscal_cashbox = case when payload ? 'fiscal_cashbox' then nullif(upper(btrim(payload->>'fiscal_cashbox')), '') else fiscal_cashbox end,
           fiscal_vat = case when payload ? 'fiscal_vat' then nullif(nullif(payload->>'fiscal_vat', ''), '0')::numeric else fiscal_vat end,
           fiscal_paper = case when payload ? 'fiscal_paper' then (payload->>'fiscal_paper')::smallint else fiscal_paper end
     where id = v_point;$a$);

-- ---------------------------------------------------------------- карточка позиции
select pg_temp.patch('tandem.office_nomenclature(text,jsonb,tandem.users)',
  $a$'cost_price', i.cost_price, 'cost_date', i.cost_date, 'cost_source', i.cost_source)$a$,
  $a$'cost_price', i.cost_price, 'cost_date', i.cost_date, 'cost_source', i.cost_source,
                 'ntin', i.ntin, 'gtin', i.gtin, 'position_type', i.position_type)$a$);

-- проверка до записи: неверный НТИН не должен оставить наполовину сохранённую карточку
select pg_temp.patch('tandem.office_nomenclature(text,jsonb,tandem.users)',
  $a$    if v_code is null and v_name = '' then return tandem.err('validation', 'Название позиции пустое'); end if;$a$,
  $a$    if v_code is null and v_name = '' then return tandem.err('validation', 'Название позиции пустое'); end if;
    -- 0054: НТИН и GTIN - цифры (пустое снимает), вид позиции в чеке: 0 товар, 2 услуга
    if coalesce(btrim(payload->>'ntin'), '') !~ '^([0-9]{8,14})?$' then
      return tandem.err('validation', 'НТИН - только цифры, от 8 до 14'); end if;
    if coalesce(btrim(payload->>'gtin'), '') !~ '^([0-9]{8,14})?$' then
      return tandem.err('validation', 'GTIN (штрихкод) - только цифры, от 8 до 14'); end if;
    if coalesce(nullif(payload->>'position_type', ''), '0') not in ('0', '2') then
      return tandem.err('validation', 'Вид позиции в чеке - товар или услуга'); end if;$a$);

select pg_temp.patch('tandem.office_nomenclature(text,jsonb,tandem.users)',
  $a$    return jsonb_build_object('ok', true, 'code', v_code);
  end if;

  if action = 'item_prices_save' then$a$,
  $a$    -- 0054: НТИН, GTIN и вид позиции - и у новой позиции, и при правке; ключ пришёл - применяется
    -- (пустое снимает), не пришёл - не трогается.
    if payload ? 'ntin' or payload ? 'gtin' or payload ? 'position_type' then
      update tandem.items set
        ntin = case when payload ? 'ntin' then nullif(btrim(payload->>'ntin'), '') else ntin end,
        gtin = case when payload ? 'gtin' then nullif(btrim(payload->>'gtin'), '') else gtin end,
        position_type = case when payload ? 'position_type' then coalesce(nullif(payload->>'position_type', '')::smallint, 0) else position_type end
       where code = v_code;
    end if;
    return jsonb_build_object('ok', true, 'code', v_code);
  end if;

  if action = 'item_prices_save' then$a$);

-- ---------------------------------------------------------------- «Готовность»
-- Товар на перепродажу (тип «товар»), который продаёт точка с фискальным чеком, уходит в чек с НТИН из
-- Национального каталога товаров; без него - чек без НТИН. Проверка появляется, только пока такая точка есть.
select pg_temp.patch('tandem.quality_report(tandem.users)',
  $a$  return jsonb_build_object('ok', true, 'checks', v_checks,$a$,
  $a$  -- 10. 0054: НТИН товаров на точках с фискальным чеком
  if exists (select 1 from tandem.points where active and fiscal_enabled) then
    select count(*), coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name, 'detail', detail) order by rn)
             filter (where rn <= 300), '[]'::jsonb)
      into v_count, v_rows from (
        select i.code, i.name, 'код ' || i.code || coalesce(' · ' || i.category, '') as detail,
               row_number() over (order by i.name) rn
          from tandem.items i
         where i.active and i.for_sale and i.item_type = 'goods' and coalesce(btrim(i.ntin), '') = ''
           and exists (select 1 from tandem.points p where p.active and p.fiscal_enabled
                        and (coalesce(cardinality(p.item_categories), 0) = 0 or i.category = any(p.item_categories)))) x;
    v_checks := v_checks || jsonb_build_object('id', 'fiscal_ntin', 'severity', 'warn', 'target', 'item', 'count', v_count, 'rows', v_rows,
      'title', 'Товары без НТИН на точках с фискальным чеком',
      'hint', 'Товар на перепродажу уходит в фискальный чек с НТИН из Национального каталога товаров. Откройте позицию и впишите НТИН (его дают поставщик или карточка товара в каталоге). Блюда и полуфабрикаты своего производства здесь не проверяются.');
  end if;

  return jsonb_build_object('ok', true, 'checks', v_checks,$a$);
