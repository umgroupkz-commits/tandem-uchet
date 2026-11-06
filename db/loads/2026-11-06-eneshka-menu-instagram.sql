-- Меню заказов Енешки строго по прайсу Instagram (актуальное «ПРАЙС» @eneshka.tmr, выложено около 02.11.2026;
-- переписано в docs/eneshka/prais-instagram-2026-11-02.md). Решение Андрея 06.11.2026: цены и ассортимент бота -
-- только по этому прайсу. Убираем 18 позиций, которых в прайсе нет; добавляем 25 (5 есть в справочнике,
-- 20 заводим); правим цены «Грибного лукошка», «Праздничного» и пирога с сёмгой. Казахские названия - Claude
-- (решение Андрея: без платной модели). Составы новых позиций не выдумываем: пусто, бот передаст вопрос продавцу.
-- Выполнять одной транзакцией (DO-блок с extensions.http_get по SHA коммита и сверкой md5, как прежние загрузки).
-- Повторный прогон ничего не ломает: новые позиции ищутся по имени, вставки - on conflict.

create temp table _by on commit drop as
  select 'Андрей (прайс Instagram 02.11.2026)'::text as who, 'по прайсу Instagram 02.11.2026'::text as upd;

-- 1. Нет в прайсе - убрать из меню бота (не удаляем: строки остаются выключенными).
create temp table _off on commit drop as
  select unnest(array['3424','3486',                       -- блины с сыром и ветчиной
                      '3503',                              -- орешки со сгущёнкой
                      '3611','2962','3612','3609','3610',  -- чебуреки
                      '3375','3380','3814','90680',        -- наборы и сеты
                      '3550',                              -- татарский пирог с уткой
                      '3615','3613','3614','3616',         -- татарские пироги 20 см
                      '3360']) as code;                    -- тарт творожный без ягод
update tandem.order_menu set active = false, updated_at = now(), updated_by = (select upd from _by)
 where item_code in (select code from _off) and active;

-- 2. Есть в меню, но название, цена или порядок - по прайсу.
create temp table _fix (code text, title text, kz text, price numeric, sort int, comp text) on commit drop;
insert into _fix values
 ('1916','Татарский пирог с курицей',null,5000,1,null),
 ('1917','Татарский пирог с говядиной',null,8500,2,null),
 ('3695','Татарский пирог с говядиной и картофелем',null,7300,3,null),
 ('3026','Татарский пирог с курицей и картофелем',null,4500,6,null),
 ('3371','Пирог «Грибное лукошко»',null,6000,15,null),
 ('3689','Татарский пирог «Праздничный»',null,8500,16,null),
 ('3696','Татарский пирог с сёмгой и картофелем','Албырт пен картоп салынған татар бәліші',6800,17,null),
 ('3361','Тарт творожный с ягодами',null,5000,1,null),
 ('3363','Тарт «Сметанник»',null,4500,6,null),
 ('3364','Тарт «Восточный»',null,5000,9,null),
 ('3369','Киш с сёмгой и брокколи',null,6000,1,null),
 ('3370','Киш с курицей, грибами, помидорами и сыром','Тауық еті, саңырауқұлақ, қызанақ және ірімшік қосылған киш',6000,4,
  'песочное тесто, курица, грибы, помидоры, сыр, сливки, яйца; вес 1,17 кг'),
 ('3358','Киш с курицей и овощами',null,6000,5,null),
 ('3479','Пельмени цветные со смешанным фаршем, пачка 0,7 кг','Аралас фарш салынған түрлі түсті тұшпара, 0,7 кг қаптама',2600,null,null),
 ('3650','Курник песочный',null,2200,5,null),
 ('3652','Курник песочный, пачка 0,7 кг',null,1600,6,null);
update tandem.order_menu m set
  title_ru = f.title, title_kz = coalesce(f.kz, m.title_kz), price = f.price, sort_order = coalesce(f.sort, m.sort_order),
  composition_ru = coalesce(f.comp, m.composition_ru),
  composition_kz = case when f.comp is not null then null else m.composition_kz end,  -- старый перевод состава 3370 без помидоров
  active = true, price_checked_at = now(), price_checked_by = (select who from _by), updated_at = now(), updated_by = (select upd from _by)
  from _fix f where m.item_code = f.code;
-- Казахский состав 3370 - заново, с помидорами (перевод Claude).
update tandem.order_menu set composition_kz = 'құмды қамыр, тауық еті, саңырауқұлақ, қызанақ, ірімшік, кілегей, жұмыртқа; салмағы 1,17 кг'
 where item_code = '3370';

-- 3. Есть в справочнике учёта - ставим в меню (или включаем выключенную строку).
create temp table _old (code text, title text, kz text, unit text, price numeric, section text, kind text, sort int) on commit drop;
insert into _old values
 ('1915','Татарский пирог с капустой','Қырыққабат салынған татар бәліші','шт',3500,'Татарские пироги','fresh',11),
 ('3451','Татарский пирог с курицей, картофелем и грибами','Тауық еті, картоп және саңырауқұлақ салынған татар бәліші','шт',4800,'Татарские пироги','fresh',7),
 ('3434','Шарлотка','Шарлотка','шт',4500,'Сладкие пироги','fresh',5),
 ('3607','Самса татарская говяжья','Сиыр еті салынған татар самсасы','кг',3850,'Выпечка','stock',1),
 ('3566','Самса татарская куриная','Тауық еті салынған татар самсасы','кг',2200,'Выпечка','stock',3);
update tandem.items set for_sale = true where code in (select code from _old) and not for_sale;
insert into tandem.order_menu as m (item_code, title_ru, title_kz, unit_label, price, min_qty, step, section, ready_kind,
                                    sort_order, active, price_checked_at, price_checked_by, updated_by)
select o.code, o.title, o.kz, o.unit, o.price, 1, 1, o.section, o.kind, o.sort, true, now(), (select who from _by), (select upd from _by)
  from _old o
on conflict (item_code) do update set
  title_ru = excluded.title_ru, title_kz = excluded.title_kz, unit_label = excluded.unit_label, price = excluded.price,
  min_qty = 1, step = 1, section = excluded.section, ready_kind = excluded.ready_kind, sort_order = excluded.sort_order,
  active = true, price_checked_at = now(), price_checked_by = excluded.price_checked_by, updated_at = now(),
  updated_by = excluded.updated_by;

-- 4. Нет в справочнике - заводим (группа, единица и вид - как у похожей позиции-образца) и ставим в меню.
create temp table _new (tmpl text, title text, kz text, unit text, price numeric, section text, kind text, sort int) on commit drop;
insert into _new values
 ('3625','Пельмени цветные со смешанным фаршем','Аралас фарш салынған түрлі түсті тұшпара','кг',3700,'Пельмени','stock',null),
 ('3652','Самса татарская говяжья, пачка 0,7 кг','Сиыр еті салынған татар самсасы, 0,7 кг қаптама','шт',2750,'Выпечка','stock',2),
 ('3652','Самса татарская куриная, пачка 0,7 кг','Тауық еті салынған татар самсасы, 0,7 кг қаптама','шт',1600,'Выпечка','stock',4),
 ('3369','Киш с сёмгой, грибами и сыром','Албырт, саңырауқұлақ және ірімшік қосылған киш','шт',6000,'Киши','fresh',2),
 ('3369','Киш с курицей и помидором','Тауық еті мен қызанақ қосылған киш','шт',6000,'Киши','fresh',3),
 ('1916','Татарский пирог с говядиной, картофелем и грибами','Сиыр еті, картоп және саңырауқұлақ салынған татар бәліші','шт',7000,'Татарские пироги','fresh',4),
 ('1916','Татарский пирог с курицей и овощами','Тауық еті мен көкөніс салынған татар бәліші','шт',4800,'Татарские пироги','fresh',5),
 ('1916','Татарский пирог с курицей, картофелем и яйцом','Тауық еті, картоп және жұмыртқа салынған татар бәліші','шт',4500,'Татарские пироги','fresh',8),
 ('1916','Татарский пирог с курицей и сыром','Тауық еті мен ірімшік салынған татар бәліші','шт',5000,'Татарские пироги','fresh',9),
 ('1916','Татарский пирог с картофелем и грибами','Картоп пен саңырауқұлақ салынған татар бәліші','шт',4500,'Татарские пироги','fresh',10),
 ('1916','Татарский пирог с капустой и яйцом','Қырыққабат пен жұмыртқа салынған татар бәліші','шт',4500,'Татарские пироги','fresh',12),
 ('1916','Татарский пирог с капустой и фаршем','Қырыққабат пен фарш салынған татар бәліші','шт',4500,'Татарские пироги','fresh',13),
 ('1916','Татарский пирог с капустой и грибами','Қырыққабат пен саңырауқұлақ салынған татар бәліші','шт',5000,'Татарские пироги','fresh',14),
 ('3361','Пирог творожный заливной с ягодой','Жидек қосылған құйма сүзбе бәліші','шт',5500,'Сладкие пироги','fresh',2),
 ('3361','Пирог творожный с маком','Көкнәр қосылған сүзбе бәліші','шт',5000,'Сладкие пироги','fresh',3),
 ('3361','Пирог морковный','Сәбіз бәліші','шт',4500,'Сладкие пироги','fresh',4),
 ('3361','Пирог «Шоколадный сметанник»','«Шоколадты сметанник» бәліші','шт',5500,'Сладкие пироги','fresh',7),
 ('3361','Пирог карамельный с орехом','Жаңғақ қосылған карамель бәліші','шт',6000,'Сладкие пироги','fresh',8),
 ('3361','Пирог шоколадный с вишней','Шие қосылған шоколад бәліші','шт',6000,'Сладкие пироги','fresh',10),
 ('3361','Пирог апельсиновый','Апельсин бәліші','шт',6000,'Сладкие пироги','fresh',11);

insert into tandem.items (code, name, item_type, unit_id, unit, step, group_id, category, active, for_sale, price, source, note)
select nextval('tandem.item_code_seq')::text, n.title, t.item_type, t.unit_id, t.unit, t.step, t.group_id, t.category,
       true, true, n.price, 'office', 'заведено по прайсу Instagram 02.11.2026'
  from _new n join tandem.items t on t.code = n.tmpl
 where not exists (select 1 from tandem.items i where i.name = n.title and not i.training);

insert into tandem.order_menu as m (item_code, title_ru, title_kz, unit_label, price, min_qty, step, section, ready_kind,
                                    sort_order, active, price_checked_at, price_checked_by, updated_by)
select i.code, n.title, n.kz, n.unit, n.price, 1, 1, n.section, n.kind,
       coalesce(n.sort, (select max(sort_order) from tandem.order_menu where section = n.section)),
       true, now(), (select who from _by), (select upd from _by)
  from _new n join lateral (select code from tandem.items i where i.name = n.title and not i.training order by code limit 1) i on true
on conflict (item_code) do update set
  title_ru = excluded.title_ru, title_kz = excluded.title_kz, unit_label = excluded.unit_label, price = excluded.price,
  section = excluded.section, ready_kind = excluded.ready_kind, active = true, price_checked_at = now(),
  price_checked_by = excluded.price_checked_by, updated_at = now(), updated_by = excluded.updated_by;

-- 5. Проверки. Иначе - откат всего.
do $$
declare v_bad text; v_n int;
begin
  select string_agg(x.what, '; ') into v_bad from (
    select 'убрано, но видно боту: ' || m.item_code as what from tandem.order_menu m
     where m.item_code in (select code from _off) and m.active
    union all
    select 'не по прайсу: ' || f.code from _fix f join tandem.order_menu m on m.item_code = f.code
     where m.price <> f.price or not m.active or m.price_checked_at is null or m.title_ru <> f.title
    union all
    select 'из справочника не встало: ' || o.code from _old o left join tandem.order_menu m on m.item_code = o.code
     where m.item_code is null or m.price <> o.price or not m.active or m.price_checked_at is null
    union all
    select 'новая не встала: ' || n.title from _new n
     left join tandem.order_menu m on m.title_ru = n.title and m.active and m.price = n.price and m.price_checked_at is not null
     where m.item_code is null
    union all
    select 'видно боту без казахского названия: ' || m.item_code from tandem.order_menu m
      join tandem.items i on i.code = m.item_code
     where m.active and m.price_checked_at is not null and i.for_sale and coalesce(m.title_kz, '') = ''
    union all
    select 'в меню и сверено, но в справочнике не для продажи: ' || m.item_code from tandem.order_menu m
      join tandem.items i on i.code = m.item_code
     where m.active and m.price_checked_at is not null and not (i.active and i.for_sale and not i.training)
  ) x;
  if v_bad is not null then raise exception 'Меню по прайсу Instagram не сошлось: %', v_bad; end if;
  select count(*) into v_n from tandem.order_menu m join tandem.items i on i.code = m.item_code
   where m.active and m.price_checked_at is not null and i.for_sale;
  if v_n <> 125 then raise exception 'Боту видно % позиций, по прайсу Instagram должно быть 125', v_n; end if;
end $$;
