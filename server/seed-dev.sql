-- ТОЛЬКО для репетиции переезда и локальной разработки: известные коды и демо-данные.
-- На боевой сервер не применять.
update tandem.settings set value = '000111' where key = 'owner_pin';
update tandem.settings set value = '000222' where key = 'driver_pin';
insert into tandem.users (login, name, role, pin_hash, must_change_pin)
values ('admin', 'Администратор', 'admin', crypt('123456', gen_salt('bf')), false)
on conflict do nothing;
insert into tandem.points (id, name, legal_entity, mode, sort_order, pin, active)
values ('aian', 'Отдел п/ф «Аян»', 'ТОО', 'position', 1, '1111', true) on conflict (id) do nothing;
insert into tandem.items (code, name, artikul, iiko_code, item_type, unit_id, unit, step, active, for_sale, source)
values ('1', 'Мука пшеничная в/с', '00001', '1', 'goods', 'кг', 'кг', 0.5, true, false, 'iiko'),
       ('2', 'Сахар', '00002', '2', 'goods', 'кг', 'кг', 0.5, true, false, 'iiko')
on conflict (code) do nothing;
