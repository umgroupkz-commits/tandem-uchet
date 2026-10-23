-- Обязательные справочные данные для пустой базы: единицы измерения, права ролей, настройки.
-- Применяется после tandem_full.sql. Коды собственника и водителя в settings — случайные, их не знает никто
-- (файл лежит в публичном репозитории, постоянная заглушка работала бы как код): задайте свои
-- по server/README.md ДО открытия сервера в интернет.

insert into tandem.units (id, name, iiko_id, precision) values
  ('шт','штука','cd19b5ea-1b32-a6e5-1df7-5d2784a0549a',0),('кг','килограмм','7ba81c3a-8de5-8f9d-fb9f-e39efcbc57cc',3),
  ('л','литр','69859c74-db72-b006-cba5-326cf6f4fc6e',3),('порц','порция','6040d92d-e286-f4f9-a613-ed0e6fd241e1',0)
on conflict (id) do nothing;

insert into tandem.role_permissions (role, section, action) values
  ('accountant','charts','view'),
  ('accountant','counteragents','edit'),
  ('accountant','counteragents','view'),
  ('accountant','doc:invoice_in','edit'),
  ('accountant','doc:invoice_in','view'),
  ('accountant','doc:sale','edit'),
  ('accountant','doc:sale','view'),
  ('accountant','nomenclature','view'),
  ('accountant','stock','edit'),
  ('accountant','stock','view'),
  ('accountant','stores','view'),
  ('admin','charts','edit'),
  ('admin','charts','view'),
  ('admin','counteragents','edit'),
  ('admin','counteragents','view'),
  ('admin','doc:inventory','edit'),
  ('admin','doc:inventory','view'),
  ('admin','doc:invoice_in','edit'),
  ('admin','doc:invoice_in','view'),
  ('admin','doc:production','edit'),
  ('admin','doc:production','view'),
  ('admin','doc:sale','edit'),
  ('admin','doc:sale','view'),
  ('admin','doc:transfer','edit'),
  ('admin','doc:transfer','view'),
  ('admin','doc:writeoff','edit'),
  ('admin','doc:writeoff','view'),
  ('admin','nomenclature','edit'),
  ('admin','nomenclature','view'),
  ('admin','stock','edit'),
  ('admin','stock','view'),
  ('admin','stores','edit'),
  ('admin','stores','view'),
  ('admin','users','edit'),
  ('admin','users','view'),
  ('owner','charts','edit'),
  ('owner','charts','view'),
  ('owner','counteragents','edit'),
  ('owner','counteragents','view'),
  ('owner','doc:inventory','edit'),
  ('owner','doc:inventory','view'),
  ('owner','doc:invoice_in','edit'),
  ('owner','doc:invoice_in','view'),
  ('owner','doc:production','edit'),
  ('owner','doc:production','view'),
  ('owner','doc:sale','edit'),
  ('owner','doc:sale','view'),
  ('owner','doc:transfer','edit'),
  ('owner','doc:transfer','view'),
  ('owner','doc:writeoff','edit'),
  ('owner','doc:writeoff','view'),
  ('owner','nomenclature','edit'),
  ('owner','nomenclature','view'),
  ('owner','stock','edit'),
  ('owner','stock','view'),
  ('owner','stores','edit'),
  ('owner','stores','view'),
  ('owner','users','edit'),
  ('owner','users','view'),
  ('storekeeper','charts','view'),
  ('storekeeper','counteragents','view'),
  ('storekeeper','doc:inventory','edit'),
  ('storekeeper','doc:inventory','view'),
  ('storekeeper','doc:invoice_in','edit'),
  ('storekeeper','doc:invoice_in','view'),
  ('storekeeper','doc:production','edit'),
  ('storekeeper','doc:production','view'),
  ('storekeeper','doc:sale','view'),
  ('storekeeper','doc:transfer','edit'),
  ('storekeeper','doc:transfer','view'),
  ('storekeeper','doc:writeoff','edit'),
  ('storekeeper','doc:writeoff','view'),
  ('storekeeper','nomenclature','view'),
  ('storekeeper','stock','edit'),
  ('storekeeper','stock','view'),
  ('storekeeper','stores','view'),
  ('technologist','charts','edit'),
  ('technologist','charts','view'),
  ('technologist','counteragents','view'),
  ('technologist','doc:production','edit'),
  ('technologist','doc:production','view'),
  ('technologist','doc:sale','view'),
  ('technologist','nomenclature','edit'),
  ('technologist','nomenclature','view'),
  ('technologist','stock','edit'),
  ('technologist','stock','view'),
  ('technologist','stores','view')
on conflict do nothing;

insert into tandem.settings (key, value) values
  ('owner_pin', encode(gen_random_bytes(12), 'hex')), ('driver_pin', encode(gen_random_bytes(12), 'hex')), ('foodcost_alert', '35')
on conflict (key) do nothing;

-- Служебная выключенная точка дымового теста (см. миграцию 0023).
insert into tandem.points (id, name, legal_entity, mode, sort_order, pin, active, note)
values ('zz_test', 'ZZ_TEST_точка', null, 'position', 999, md5(random()::text), false, 'Служебная точка дымового теста. Не включать.')
on conflict (id) do nothing;
insert into tandem.points (id, name, legal_entity, mode, sort_order, pin, active, note)
values ('zz_kassa', 'ZZ_TEST_касса', null, 'checks', 999, md5(random()::text), false, 'Служебная касса дымового теста (миграция 0033). Не включать.')
on conflict (id) do nothing;
insert into tandem.settings (key, value) values ('orders_cutoff', '20:00') on conflict (key) do nothing;   -- заявки точек, 0038

-- Заказы клиентов (0049–0051): настройки окон и доставки, права раздела «Заказы клиентов», таблица переходов статусов.
insert into tandem.settings (key, value) values
  ('client_fresh_cutoff', '12:00'), ('client_fresh_ready', '18:00'), ('stock_ready_minutes', '120'),
  ('client_min_order', '7000'), ('client_hours_from', '09:00'), ('client_hours_to', '18:00'),
  ('client_max_days_ahead', '14'), ('client_pickup_points', 'eneshka'), ('client_prepay_rule', 'off'),
  ('client_confirm_remind_min', '15'), ('client_confirm_client_notice_min', '30'),
  ('kaspi_details_ru', ''), ('kaspi_details_kz', ''), ('couriers', ''),
  ('client_faq', ''), ('client_delivery_text', 'по Темиртау бесплатная'),   -- тексты бота, 0052
  ('client_payment_methods', 'наличные, Kaspi QR, перевод, карта'),
  ('bot_key_hash', '')   -- sha256 ключа бота; пусто — bot_* принимают служебный ключ
on conflict (key) do nothing;
insert into tandem.role_permissions (role, section, action) values
  ('owner', 'clients', 'view'), ('owner', 'clients', 'edit'),
  ('admin', 'clients', 'view'), ('admin', 'clients', 'edit'),
  ('technologist', 'clients', 'view'), ('technologist', 'clients', 'edit'),
  ('accountant', 'clients', 'view')
on conflict do nothing;
insert into tandem.client_order_moves (status_from, status_to, kinds, need, only_kind) values
  ('new', 'confirmed', '{point,telegram}', null, null),
  ('new', 'awaiting_prepay', '{point,telegram}', null, null),
  ('new', 'rejected', '{point,telegram}', 'reason', null),
  ('new', 'cancelled', '{bot,point,telegram}', 'reason', null),
  ('awaiting_prepay', 'paid', '{point,telegram}', null, null),
  ('awaiting_prepay', 'cancelled', '{bot,point,telegram}', 'reason', null),
  ('paid', 'cooking', '{point,telegram,office}', null, null),
  ('paid', 'cancelled', '{point,telegram}', 'reason', null),
  ('confirmed', 'cooking', '{point,telegram,office}', null, null),
  ('confirmed', 'cancelled', '{bot,point,telegram}', 'reason', null),
  ('cooking', 'assembled', '{point,telegram,office}', null, null),
  ('cooking', 'cancelled', '{point,telegram}', 'reason', null),
  ('assembled', 'handed_to_courier', '{point,telegram}', 'courier', 'delivery'),
  ('assembled', 'awaiting_pickup', '{point,telegram}', null, 'pickup'),
  ('assembled', 'cancelled', '{point,telegram}', 'reason', null),
  ('handed_to_courier', 'on_the_way', '{point,telegram}', null, 'delivery'),
  ('handed_to_courier', 'delivered', '{point,telegram}', 'pay', 'delivery'),
  ('handed_to_courier', 'not_collected', '{point,telegram}', 'reason', 'delivery'),
  ('handed_to_courier', 'cancelled', '{point,telegram}', 'reason', 'delivery'),
  ('on_the_way', 'delivered', '{point,telegram}', 'pay', 'delivery'),
  ('on_the_way', 'not_collected', '{point,telegram}', 'reason', 'delivery'),
  ('on_the_way', 'cancelled', '{point,telegram}', 'reason', 'delivery'),
  ('awaiting_pickup', 'issued', '{point,telegram}', 'pay', 'pickup'),
  ('awaiting_pickup', 'not_collected', '{point,telegram}', 'reason', 'pickup'),
  ('awaiting_pickup', 'cancelled', '{point,telegram}', 'reason', 'pickup')
on conflict do nothing;
