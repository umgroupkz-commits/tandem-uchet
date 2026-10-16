import type { Menu } from "../src/types.ts";

export const MENU: Menu = {
  now: "2026-10-17T10:00",
  settings: { client_hours_from: "09:00", client_hours_to: "18:00", client_fresh_cutoff: "12:00", client_fresh_ready: "18:00",
    stock_ready_minutes: "120", client_min_order: "7000", client_max_days_ahead: "14", client_pickup_points: "eneshka",
    client_prepay_rule: "off", client_confirm_remind_min: "15", client_confirm_client_notice_min: "30",
    kaspi_details_ru: "Kaspi: +7 775 000 00 00, Светлана Г.", kaspi_details_kz: "Kaspi: +7 775 000 00 00, Светлана Г.", couriers: "Ерлан" },
  points: [{ id: "eneshka", name: "Енешка, Караганды 74/2" }],
  items: [
    { item_code: "P1", title_ru: "Пирог с мясом", title_kz: "Етті бәліш", composition_ru: "говядина, картофель, лук", composition_kz: null,
      unit_label: "кг", price: 4550, min_qty: 1, step: 0.5, section: "Татарские пироги", ready_kind: "fresh", stopped: false, stop_until: null,
      sort_order: 1, active: true, checked: true },
    { item_code: "B1", title_ru: "Беляш", title_kz: "Беляш", composition_ru: null, composition_kz: null, unit_label: "шт", price: 500,
      min_qty: 2, step: 1, section: "Выпечка", ready_kind: "stock", stopped: true, stop_until: "2026-10-17", sort_order: 2, active: true, checked: true },
    { item_code: "M1", title_ru: "Манты с говядиной", title_kz: "Сиыр етінен манты", composition_ru: null, composition_kz: null, unit_label: "кг",
      price: 4400, min_qty: 1, step: 0.5, section: "Полуфабрикаты", ready_kind: "stock", stopped: false, stop_until: null, sort_order: 3, active: true, checked: true },
    { item_code: "S1", title_ru: "Сет «Чайный дастархан»", title_kz: "«Шай дастарханы» сеті", composition_ru: "пироги и выпечка к чаю", composition_kz: null,
      unit_label: "сет", price: 19300, min_qty: 1, step: 1, section: "Сеты", ready_kind: "fresh", stopped: false, stop_until: null, sort_order: 4, active: true, checked: true },
  ],
};
