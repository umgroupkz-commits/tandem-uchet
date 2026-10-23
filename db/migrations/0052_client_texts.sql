-- 0052: тексты бота заказов Енешки в настройках учёта (шаг 5 плана запуска): частые вопросы клиентов,
-- как сказать о доставке и чем можно оплатить. Раньше доставка и способы оплаты были зашиты в код бота;
-- теперь их меняют собственник и администратор в «Заказы клиентов» → «Настройки», бот подхватывает сам.
-- Ключи начинаются с client_, поэтому client_settings() и bot_menu отдают их без правок.

insert into tandem.settings (key, value) values
  ('client_faq', ''),
  ('client_delivery_text', 'по Темиртау бесплатная'),
  ('client_payment_methods', 'наличные, Kaspi QR, перевод, карта')
on conflict (key) do nothing;

-- office_clients: проверка длины новых текстов при сохранении настроек.
do $mig$
declare d text; n text;
begin
  d := pg_get_functiondef('tandem.office_clients(text,jsonb,tandem.users)'::regprocedure);
  if position('client_faq' in d) > 0 then raise notice '0052: office_clients уже знает тексты бота'; return; end if;
  n := replace(d, $a$      elsif k in ('kaspi_details_ru', 'kaspi_details_kz', 'couriers') then$a$,
    $a$      elsif k in ('client_delivery_text', 'client_payment_methods') then
        if length(v) > 300 then return tandem.err('validation', 'Не длиннее 300 знаков: ' || k); end if;
      elsif k = 'client_faq' then
        if length(v) > 6000 then return tandem.err('validation', 'Частые вопросы - не длиннее 6000 знаков'); end if;
      elsif k in ('kaspi_details_ru', 'kaspi_details_kz', 'couriers') then$a$);
  if n = d then raise exception '0052: якорь проверки настроек в office_clients не найден'; end if;
  execute n;
end $mig$;
