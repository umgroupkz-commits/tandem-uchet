// Меню и правила для системной части, проверка строки корзины (окончательно проверяет учёт), телефон, язык.
import type { Lang, Menu, MenuItem } from "./types.ts";

export const money = (n: number) => Math.round(n).toLocaleString("ru-RU").replace(/\s/g, " ") + " ₸";
export const qtyText = (n: number) => String(Math.round(n * 1000) / 1000).replace(".", ",");
const READY = { fresh: "печём под заказ", stock: "с витрины или из морозилки" };

export function menuText(menu: Menu): string {
  const out: string[] = [];
  let section = "";
  for (const it of menu.items) {
    if (it.section !== section) { section = it.section; out.push(`\n## ${section}`); }
    const unit = it.unit_label === "кг" ? "кг" : it.unit_label;
    out.push(`• [${it.item_code}] ${it.title_ru} — ${money(it.price)} за ${unit}` +
      (it.title_kz ? ` (каз.: ${it.title_kz})` : "") +
      `; от ${qtyText(it.min_qty)} ${unit}, шаг ${qtyText(it.step)}; ${READY[it.ready_kind]}` +
      (it.composition_ru ? `; состав: ${it.composition_ru}` : "") +
      (it.stopped ? `; стоп до ${it.stop_until} — на эти даты нет` : ""));
  }
  return out.join("\n").trim();
}

export function rulesText(menu: Menu): string {
  const s = menu.settings;
  return [
    `Часы приёма и готовности: с ${s.client_hours_from} до ${s.client_hours_to} (время Темиртау, UTC+5).`,
    `Свежие пироги и сеты «печём под заказ»: на сегодня — если заказ до ${s.client_fresh_cutoff}, готовность к ${s.client_fresh_ready}; позже — на завтра и дальше.`,
    `«С витрины»: сегодня — не раньше чем через ${s.stock_ready_minutes} минут, в часы приёма.`,
    `Заказ вперёд — не дальше ${s.client_max_days_ahead} дней.`,
    `Доставка по Темиртау бесплатная, от ${money(Number(s.client_min_order))}. Меньше — только самовывоз.`,
    `Самовывоз: ${menu.points.map((p) => `[${p.id}] ${p.name}`).join("; ")}.`,
    `Оплата при получении: наличные, Kaspi QR, перевод, карта.`,
  ].join("\n");
}

export const findItem = (menu: Menu, code: string): MenuItem | null => menu.items.find((x) => x.item_code === code) ?? null;

export function cartCheck(it: MenuItem, qty: number): string | null {
  if (!(qty > 0)) return `Количество «${it.title_ru}» — больше нуля`;
  if (it.unit_label !== "кг" && qty !== Math.trunc(qty)) return `«${it.title_ru}» — только целым числом`;
  // стоп не проверяется: он действует на даты заказа (stop_until >= for_date), а дата здесь неизвестна — решает учёт
  if (qty < it.min_qty) return `Минимум «${it.title_ru}» — ${qtyText(it.min_qty)} ${it.unit_label}`;
  const k = (qty - it.min_qty) / it.step;
  if (Math.abs(Math.round(k) - k) > 1e-6) return `«${it.title_ru}» — шагом ${qtyText(it.step)} ${it.unit_label} от ${qtyText(it.min_qty)}`;
  return null;
}

export function phoneFromChat(chatId: string): string | null {
  const d = String(chatId).replace(/\D/g, "");
  return d.length >= 10 && d.length <= 15 ? d : null;
}
// Номер клиента из диалога «Узла». У скрытого адреса WhatsApp (…@lid) chatId — служебные цифры, не номер:
// настоящий — contactPhone, если WhatsApp его присылал. Нет номера — заказ не оформить.
export function phoneOf(d: { chatId: string; addressKind?: "phone" | "lid" | string; contactPhone?: string | null }): string | null {
  if (d.contactPhone) { const p = phoneFromChat(d.contactPhone); if (p) return p; }
  return d.addressKind === "lid" ? null : phoneFromChat(d.chatId);
}
export function maskPhone(p: string): string {
  const d = p.replace(/\D/g, "");
  return d.length === 11 ? `+${d[0]} ${d.slice(1, 4)} *** ** ${d.slice(9)}` : "+***" + d.slice(-2);
}
// Любая запись из 10+ цифр (с пробелами, «+», «-», скобками) — маской, для журнала.
export function maskPhonesIn(text: string): string {
  return text.replace(/\+?\d[\d\s()+-]{8,}\d/g, (run) => run.replace(/\D/g, "").length >= 10 ? maskPhone(run) : run);
}
export function detectLang(text: string): Lang | null {
  if (/[әғқңөұүһі]/i.test(text)) return "kz";
  if (/[а-яё]/i.test(text)) return "ru";
  return null;
}
const hm = (s: string) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
export function localNow(now: Date): string {
  return new Date(now.getTime() + 5 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
}
export function inHours(menu: Menu, now: Date): boolean {
  const l = new Date(now.getTime() + 5 * 3600e3);
  const m = l.getUTCHours() * 60 + l.getUTCMinutes();
  return m >= hm(menu.settings.client_hours_from) && m < hm(menu.settings.client_hours_to);
}
