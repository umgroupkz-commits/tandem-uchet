-- Меню заказов Енешки по анкете Светланы (ответы 23.10.2026, файл «Анкета ответы.xlsx»):
-- цены за 1 кг из её прайса, пачки 0,7 / 0,6 / 0,4 кг отдельными позициями (решение Андрея 23.10.2026),
-- свежие пироги, тарты, наборы и сеты с весом и составом, отметка «цена сверена», курьеры.
-- Повторный прогон ничего не ломает: вставки — on conflict, проверки в конце откатывают всё при расхождении.
-- Выполнять одной транзакцией: psql -1 -f, либо execute из DO-блока (так выкладывается на живую базу:
-- extensions.http_get с raw.githubusercontent по SHA коммита + сверка md5).
-- Не сверено Светланой и остаётся невидимым боту: штучная выпечка и фастфуд, «Пирог с курицей,
-- картофелем и грибами», «Шарлотка» — вопросы ей вынесены отдельно.


-- Кто и когда сверил: одна метка на весь ввод.
create temp table _by on commit drop as
  select 'Светлана (анкета 23.10.2026)'::text as who, 'по анкете Светланы 23.10.2026'::text as upd;

-- 1. Позиции справочника, которые продаются, но были отмечены «не для продажи».
update tandem.items set for_sale = true
 where code in ('3829', '3830', '3814') and not for_sale;

-- 2. Новая позиция справочника: сета «Чайный дастархан» в учёте не было.
insert into tandem.items (code, name, item_type, unit_id, unit, step, group_id, category, active, for_sale, price, source, note)
select nextval('tandem.item_code_seq')::text, 'Сет Чайный дастархан', 'dish', 'шт', 'шт', 1,
       g.group_id, g.group_name, true, true, 21000, 'office', 'заведено по анкете Светланы 23.10.2026'
  from (select group_id, group_name from tandem.items where code = '3375') g
 where not exists (select 1 from tandem.items where name = 'Сет Чайный дастархан' and not training);

-- 3. Фрикадельки говяжьи за 1 кг были привязаны к коду пачки 0,7 (1485). Килограмм — 3829,
--    пачка — 3632 (в одной группе с куриными 3631). Старую строку выключаем, не удаляем.
insert into tandem.order_menu (item_code, title_ru, composition_ru, unit_label, price, min_qty, step, section, ready_kind, sort_order, updated_by)
select '3829', 'Фрикадельки говяжьи (суповые)', m.composition_ru, 'кг', 4600, m.min_qty, m.step, m.section, m.ready_kind, m.sort_order, (select upd from _by)
  from tandem.order_menu m where m.item_code = '1485'
on conflict (item_code) do nothing;
update tandem.order_menu set active = false, updated_at = now(), updated_by = (select upd from _by)
 where item_code = '1485' and active;

-- 4. Цены за 1 кг из прайса Светланы: ставим её цену и отмечаем «сверено».
create temp table _kg (code text primary key, price numeric) on commit drop;
insert into _kg values
 ('2571',3600),('2976',3100),('3456',3150),('3424',4550),('2570',2450),('2974',2500),
 ('1490',2450),('2964',4250),('3602',2200),('2965',1650),('1489',1650),('2973',2200),
 ('3525',4400),('3524',4100),('2545',4550),('2546',3800),('2548',4100),('3569',2500),
 ('3189',4150),('3599',4260),('2921',4400),('2918',4250),('3626',2900),('2978',2700),
 ('3627',3700),('3628',4250),('2942',3800),('3736',2750),('3735',4300),('3737',3750),
 ('3625',4250),('2955',2700),('2953',3700),('3522',4150),('3443',4300),('2963',4000),
 ('3619',4000),('3573',4000),('3418',4400),('2556',4100),('3829',4600),('2557',3400),
 ('2958',4250),('2962',3500),('3609',3000);
update tandem.order_menu m
   set price = k.price, price_checked_at = now(), price_checked_by = (select who from _by),
       updated_at = now(), updated_by = (select upd from _by)
  from _kg k where m.item_code = k.code;

-- 5. Пачки: название и раздел — от килограммовой позиции, цена — из прайса Светланы.
create temp table _pack (code text primary key, kg_code text, price numeric, label text) on commit drop;
insert into _pack values
 ('3492','2571',2520,'0,7'),('3489','2976',2170,'0,7'),('3491','3456',2200,'0,7'),('3486','3424',3200,'0,7'),
 ('3490','2570',1720,'0,7'),('3493','2974',1750,'0,7'),('3601','1490',1800,'0,7'),('3466','2964',2980,'0,7'),
 ('3603','3602',1700,'0,7'),('3467','2965',1200,'0,7'),('3468','1489',1200,'0,7'),('3469','2973',1650,'0,7'),
 ('3693','3525',3100,'0,7'),('3694','3524',2870,'0,7'),('3483','2545',3185,'0,7'),('3484','2546',2660,'0,7'),
 ('3485','2548',2870,'0,7'),('3570','3569',1900,'0,7'),('3472','3189',2900,'0,7'),('3783','3599',2980,'0,7'),
 ('3471','2921',3100,'0,7'),('3470','2918',2980,'0,7'),('3830','3626',2000,'0,7'),('3714','2978',1900,'0,7'),
 ('3716','3627',2650,'0,7'),('3679','3628',2980,'0,7'),('3715','2942',2660,'0,7'),('3733','3736',1950,'0,7'),
 ('3732','3735',3000,'0,7'),('3734','3737',2650,'0,7'),('3475','3625',2980,'0,7'),('3476','2955',1900,'0,7'),
 ('3474','2953',2600,'0,7'),('3730','3522',2900,'0,7'),('3478','3443',2990,'0,7'),('3494','2963',2800,'0,7'),
 ('3620','3619',2800,'0,7'),('3574','3573',3000,'0,7'),('3482','3418',3080,'0,7'),('3481','2556',2870,'0,7'),
 ('3632','3829',3220,'0,7'),('3631','2557',2380,'0,7'),('3477','2958',2980,'0,7'),
 ('3612','2962',2300,'0,6'),('3610','3609',2000,'0,6');
insert into tandem.order_menu as m (item_code, title_ru, composition_ru, unit_label, price, min_qty, step, section, ready_kind,
                                    sort_order, price_checked_at, price_checked_by, updated_by)
select p.code, k.title_ru || ', пачка ' || p.label || ' кг', k.composition_ru, 'шт', p.price, 1, 1, k.section, 'stock',
       k.sort_order, now(), (select who from _by), (select upd from _by)
  from _pack p join tandem.order_menu k on k.item_code = p.kg_code
on conflict (item_code) do update set
  title_ru = excluded.title_ru, price = excluded.price, unit_label = 'шт', min_qty = 1, step = 1,
  section = excluded.section, price_checked_at = now(), price_checked_by = excluded.price_checked_by,
  updated_at = now(), updated_by = excluded.updated_by;

-- 6. Позиции без килограммовой пары в меню и свежая выпечка по анкете: всё задаём явно.
create temp table _new (code text primary key, title text, comp text, unit text, price numeric, min_q numeric, step_q numeric,
                        section text, kind text, sort int) on commit drop;
insert into _new values
 -- полуфабрикаты из прайса
 ('3479','Пельмени зелёные со смешанным фаршем, пачка 0,7 кг',null,'шт',2600,1,1,'Пельмени','stock',0),
 ('3611','Чебуреки мини жареные, смешанный фарш, пачка 0,4 кг',null,'шт',1500,1,1,'Хинкали, чебуреки, равиоли','stock',0),
 ('3650','Курник песочный','песочное тесто; на вес','кг',2200,1,0.5,'Выпечка','stock',0),
 ('3652','Курник песочный, пачка 0,7 кг','песочное тесто','шт',1600,1,1,'Выпечка','stock',0),
 ('3503','Орешки со сгущёнкой',null,'кг',3800,1,0.5,'Выпечка','stock',0),
 -- татарские пироги 20 см, 0,8 кг (прайс)
 ('3615','Татарский пирог с говядиной и картофелем, 20 см','вес 0,8 кг','шт',3500,1,1,'Татарские пироги','fresh',20),
 ('3613','Татарский пирог с курицей и картофелем, 20 см','вес 0,8 кг','шт',2500,1,1,'Татарские пироги','fresh',21),
 ('3614','Татарский пирог с сёмгой и картофелем, 20 см','вес 0,8 кг','шт',3400,1,1,'Татарские пироги','fresh',22),
 ('3616','Татарский пирог с уткой и картофелем, 20 см','вес 0,8 кг','шт',2800,1,1,'Татарские пироги','fresh',23),
 -- татарские пироги большие (анкета, №16)
 ('1917','Татарский пирог с говядиной','песочное тесто, лук, говядина; вес 1,1 кг','шт',8500,1,1,'Татарские пироги','fresh',1),
 ('3695','Татарский пирог с говядиной и картофелем','песочное тесто, лук, говядина, картофель; вес 1,2 кг','шт',7300,1,1,'Татарские пироги','fresh',2),
 ('1916','Татарский пирог с курицей','песочное тесто, лук, куриная грудка; вес 1,1 кг','шт',5000,1,1,'Татарские пироги','fresh',3),
 ('3026','Татарский пирог с курицей и картофелем','песочное тесто, лук, куриная грудка, картофель; вес 1,1 кг','шт',4500,1,1,'Татарские пироги','fresh',4),
 ('3689','Татарский пирог «Праздничный»','песочное тесто, говяжий фарш, сыр, лук, майонез; вес 1,2 кг','шт',7500,1,1,'Татарские пироги','fresh',5),
 ('3550','Татарский пирог с уткой','песочное тесто, лук, утка, картофель; вес 0,8 кг','шт',5000,1,1,'Татарские пироги','fresh',6),
 ('3696','Татарский пирог с сёмгой','песочное тесто, лук, сёмга, картофель; вес 1 кг','шт',6000,1,1,'Татарские пироги','fresh',7),
 ('3371','Пирог «Грибное лукошко»','песочное тесто, лук, грибы, майонез, сыр моцарелла, помидор; вес 2 кг; начинки больше, чем теста','шт',7500,1,1,'Татарские пироги','fresh',8),
 -- киши (анкета, цены прежние)
 ('3370','Киш с курицей и грибами','песочное тесто, курица, грибы, сыр, сливки, яйца; вес 1,17 кг','шт',6000,1,1,'Киши','fresh',1),
 ('3369','Киш с сёмгой и брокколи','песочное тесто, сёмга, брокколи, сливки, помидор, яйца, сыр моцарелла; вес 1,1 кг','шт',6000,1,1,'Киши','fresh',2),
 ('3358','Киш с курицей и овощами','песочное тесто, курица, мексиканская овощная смесь, сыр, сливки, яйца; вес 1,17 кг','шт',6000,1,1,'Киши','fresh',3),
 -- тарты
 ('3360','Тарт творожный','песочное тесто, творог, яйца, сахар; вес 1,2 кг','шт',4500,1,1,'Сладкие пироги','fresh',1),
 ('3361','Тарт творожный с ягодами','песочное тесто, творог, яйца, ягоды; вес 1,2 кг','шт',5000,1,1,'Сладкие пироги','fresh',2),
 ('3364','Тарт «Восточный»','песочное тесто, курага, изюм, сгущённое молоко; вес 1,1 кг','шт',5000,1,1,'Сладкие пироги','fresh',3),
 ('3363','Тарт «Сметанник»','песочное тесто, сметана, яйца, сахар; вес 1,1 кг','шт',4500,1,1,'Сладкие пироги','fresh',4),
 -- наборы и сеты
 ('3375','Набор татарской выпечки из 6 видов','мини-пирожки по 6 шт: с луком и яйцом, курицей, фаршем, капустой, картофелем, сыром; вес 1,9 кг','сет',6000,1,1,'Сеты','fresh',1),
 ('3380','Набор татарской выпечки из 12 пирожков','мини-пирожки из дрожжевого теста с капустой и картофелем; вес 1 кг','сет',2000,1,1,'Сеты','fresh',2),
 ('3814','Сет татарский','мини-самса из татарского теста, по 4 шт с курицей, говяжьим фаршем, яйцом с луком, картофелем; вес 1,07 кг','сет',6000,1,1,'Сеты','fresh',3);
insert into _new
select i.code, 'Сет «Чайный дастархан»',
       'мини-самса слоёная с курицей 15 шт, курник 10 шт, мини-самса песочная с говядиной 10 шт, мини-чебуреки 10 шт, манты с картофелем и курицей 34 шт, тарт творожный 26 см 1,1 кг',
       'сет', 21000, 1, 1, 'Сеты', 'fresh', 4
  from tandem.items i where i.name = 'Сет Чайный дастархан' and not i.training
 order by i.code limit 1;

insert into tandem.order_menu as m (item_code, title_ru, composition_ru, unit_label, price, min_qty, step, section, ready_kind,
                                    sort_order, price_checked_at, price_checked_by, updated_by)
select n.code, n.title, n.comp, n.unit, n.price, n.min_q, n.step_q, n.section, n.kind, n.sort, now(), (select who from _by), (select upd from _by)
  from _new n
on conflict (item_code) do update set
  title_ru = excluded.title_ru, composition_ru = excluded.composition_ru, unit_label = excluded.unit_label,
  price = excluded.price, min_qty = excluded.min_qty, step = excluded.step, section = excluded.section,
  ready_kind = excluded.ready_kind, sort_order = excluded.sort_order, price_checked_at = now(),
  price_checked_by = excluded.price_checked_by, updated_at = now(), updated_by = excluded.updated_by;

-- 7. Курьеры (анкета, №4).
insert into tandem.settings (key, value)
values ('couriers', 'Индрайвер, Александр (только днём), Алексей (с 13:00 до 17:00)')
on conflict (key) do update set value = excluded.value;

-- 8. Проверки: всё, что внесено по анкете, видно боту и стоит по цене Светланы. Иначе — откат всего.
do $$
declare v_bad text;
begin
  select string_agg(x.code || ' ' || coalesce(x.why, ''), '; ') into v_bad from (
    select k.code, 'кг: нет в меню / не та цена / не сверено' as why from _kg k
     left join tandem.order_menu m on m.item_code = k.code
     where m.item_code is null or m.price <> k.price or m.price_checked_at is null or not m.active
    union all
    select p.code, 'пачка: нет / не та цена' from _pack p
     left join tandem.order_menu m on m.item_code = p.code
     where m.item_code is null or m.price <> p.price or m.price_checked_at is null
    union all
    select n.code, 'новая: нет / не та цена' from _new n
     left join tandem.order_menu m on m.item_code = n.code
     where m.item_code is null or m.price <> n.price or m.price_checked_at is null
    union all
    select m.item_code, 'в меню и сверено, но в справочнике не для продажи' from tandem.order_menu m
      join tandem.items i on i.code = m.item_code
     where m.active and m.price_checked_at is not null and not (i.active and i.for_sale and not i.training)
  ) x;
  if v_bad is not null then raise exception 'Ввод меню не сошёлся: %', v_bad; end if;
  if (select count(*) from _new) <> 28 then raise exception 'Сет «Чайный дастархан» не заведён в справочник'; end if;
end $$;

