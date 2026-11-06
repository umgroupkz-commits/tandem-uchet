-- 0057: проверка «Готовности» о НТИН (0054-0055) принимает и штрихкод: Webkassa по GTIN сама находит НТИН в
-- Национальном каталоге и печатает его в чеке (проверено на тестовом стенде 30.10.2026: GTIN 4870002326226 →
-- «NTIN: 0200092298709»). Без НТИН и без штрихкода товар уходит в чек без НТИН - такие и показываются.
create or replace function pg_temp.patch(p_fn regprocedure, p_from text, p_to text) returns void language plpgsql as $$
declare d text := pg_get_functiondef(p_fn); n int;
begin
  if position(p_to in d) > 0 then return; end if;   -- уже применено (повторный прогон)
  n := (length(d) - length(replace(d, p_from, ''))) / length(p_from);
  if n <> 1 then raise exception '0057: якорь в % встретился % раз: %', p_fn, n, left(p_from, 80); end if;
  execute replace(d, p_from, p_to);
end $$;

select pg_temp.patch('tandem.quality_report(tandem.users)',
  $a$i.item_type = 'goods' and coalesce(btrim(i.ntin), '') = ''$a$,
  $a$i.item_type = 'goods' and coalesce(btrim(i.ntin), '') = '' and coalesce(btrim(i.gtin), '') = ''$a$);
select pg_temp.patch('tandem.quality_report(tandem.users)',
  $a$'title', 'Товары без НТИН на точках с фискальным чеком',$a$,
  $a$'title', 'Товары без НТИН и штрихкода на точках с фискальным чеком',$a$);
select pg_temp.patch('tandem.quality_report(tandem.users)',
  $a$Откройте позицию и впишите НТИН (его дают поставщик или карточка товара в каталоге).$a$,
  $a$Откройте позицию и впишите НТИН (его дают поставщик или карточка товара в каталоге) или штрихкод с упаковки в поле GTIN - по штрихкоду Webkassa найдёт НТИН сама.$a$);
