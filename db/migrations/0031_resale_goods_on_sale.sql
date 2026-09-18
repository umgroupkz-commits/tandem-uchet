-- Штучные товары для перепродажи (шоколад, напитки, чай и кофе…) — на продажу на точках.
-- Перенос из iiko выставлял на продажу только блюда, а товары считал сырьём; цены буфетов в iiko
-- заданы прейскурантом по подразделениям и пришли загрузкой «Сводного прейскуранта» (item_prices).
-- Правило: товар с ценой на настоящей точке продаётся. Служебные точки и «Аян» не затрагиваются.
-- Данные, не схема: повторный запуск ничего не ломает.

-- 1. Товары с ценой на точке: на продажу; категория = название группы (по категории точка
--    отбирает свой ассортимент, а у сырья она пустая).
update tandem.items i set for_sale = true,
       category = coalesce((select g.name from tandem.item_groups g where g.id = i.group_id), i.category)
 where i.active and i.item_type = 'goods'
   and exists (select 1 from tandem.item_prices p where p.item_code = i.code
                 and p.point_id in ('eneshka','univer_b','kmk','univer_s','aktau') and p.price > 0)
   and (not i.for_sale or i.category is null);

-- 2. Цена по умолчанию там, где её нет: самая частая цена позиции по точкам.
update tandem.items i set price = m.price
  from (select item_code, mode() within group (order by price) as price
          from tandem.item_prices where price > 0 group by item_code) m
 where m.item_code = i.code and i.price is null and i.active;

-- 3. Точка видит группы тех продаваемых товаров, на которые у неё есть цена.
update tandem.points p set item_categories = (
  select array(select distinct c from unnest(coalesce(p.item_categories, '{}') || coalesce(n.cats, '{}')) c order by c))
  from (select ip.point_id, array_agg(distinct i.category) as cats
          from tandem.item_prices ip join tandem.items i on i.code = ip.item_code
         where i.active and i.for_sale and i.item_type = 'goods' and i.category is not null and ip.price > 0
         group by ip.point_id) n
 where n.point_id = p.id and p.id in ('eneshka','univer_b','kmk','univer_s','aktau')
   and cardinality(coalesce(p.item_categories, '{}')) > 0;
