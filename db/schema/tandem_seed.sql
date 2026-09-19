-- Обязательные справочные данные для пустой базы: единицы измерения, права ролей, настройки.
-- Применяется после tandem_full.sql. Коды в settings — заглушки: ЗАМЕНИТЕ их сразу после установки.

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
  ('owner_pin', 'CHANGE-ME-OWNER'), ('driver_pin', 'CHANGE-ME-DRIVER'), ('foodcost_alert', '35')
on conflict (key) do nothing;

-- Служебная выключенная точка дымового теста (см. миграцию 0023).
insert into tandem.points (id, name, legal_entity, mode, sort_order, pin, active, note)
values ('zz_test', 'ZZ_TEST_точка', null, 'position', 999, md5(random()::text), false, 'Служебная точка дымового теста. Не включать.')
on conflict (id) do nothing;
insert into tandem.points (id, name, legal_entity, mode, sort_order, pin, active, note)
values ('zz_kassa', 'ZZ_TEST_касса', null, 'checks', 999, md5(random()::text), false, 'Служебная касса дымового теста (миграция 0033). Не включать.')
on conflict (id) do nothing;
