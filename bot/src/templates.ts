// Шаблоны сообщений клиенту. Ключевые фразы модель не пересказывает: их шлют инструменты и наблюдатель.
// Номер заказа и имя в каждом статусном шаблоне — тексты разные, правило «Узла» «один текст не больше
// 5 клиентам в час» их не задерживает. Казахские тексты сверены платной моделью (Task 6, Step 5).
import type { Lang, Order, Quote } from "./types.ts";
import { money, qtyText } from "./menu.ts";

const dm = (d: string) => d.slice(8, 10) + "." + d.slice(5, 7);
const hello = (lang: Lang, name: string | null) => name ? (lang === "kz" ? `${name}, ` : `${name}, `) : "";

export function summaryText(q: Quote, lang: Lang, name: string | null): string {
  const lines = q.lines.map((l) => `• ${(lang === "kz" && l.title_kz) || l.title} — ${qtyText(l.qty)} ${l.unit} × ${money(l.price)} = ${money(l.sum)}`);
  if (lang === "kz") {
    return [`${hello(lang, name)}тапсырысты тексеріңіз:`, ...lines, `Барлығы: ${money(q.total)}`,
      q.kind === "delivery" ? `Жеткізу тегін: ${q.address}` : `Өзіңіз алып кетесіз: ${q.point_name}`,
      `${dm(q.for_date)}, ${q.ready_by}-ге дайын болады.`, "Бәрі дұрыс па?"].join("\n");
  }
  return [`${hello(lang, name)}проверьте заказ:`, ...lines, `Итого: ${money(q.total)}`,
    q.kind === "delivery" ? `Доставка бесплатно: ${q.address}` : `Самовывоз: ${q.point_name}`,
    `Готово ${dm(q.for_date)} к ${q.ready_by}.`, "Всё верно?"].join("\n");
}

export function submittedText(no: number, lang: Lang, inHours: boolean, from: string): string {
  if (lang === "kz") return inHours
    ? `Тапсырыс №${no} сатушыға жіберілді, 15 минут ішінде растаймыз.`
    : `Тапсырыс №${no} қабылданды. Таңертең ${from}-ден бастап растаймыз.`;
  return inHours ? `Заказ №${no} передал продавцу, подтвердим в течение 15 минут.`
    : `Заказ №${no} записал. Подтвердим утром, с ${from}.`;
}

export function statusText(o: Order, s: Record<string, string>): string | null {
  const n = o.client_name ? `${o.client_name}, ` : "";
  const kz = o.lang === "kz";
  const when = `${dm(o.for_date)} ${o.ready_by}`;
  switch (o.status) {
    case "confirmed": return kz ? `${n}тапсырыс №${o.no} расталды: ${when}, ${money(o.total)}. Рахмет!`
      : `${n}заказ №${o.no} подтверждён: ${when}, ${money(o.total)}. Спасибо!`;
    case "awaiting_prepay": return kz ? `${n}тапсырыс №${o.no} расталды. Пісіруді бастау үшін алдын ала төлем: ${money(o.total)}.\n${s.kaspi_details_kz || s.kaspi_details_ru}\nТөлеген соң хабарлаңыз.`
      : `${n}заказ №${o.no} подтверждён. Чтобы начать печь, нужна предоплата ${money(o.total)}.\n${s.kaspi_details_ru}\nПосле оплаты напишите, пожалуйста.`;
    case "paid": return kz ? `${n}№${o.no} төлем келді, ${when} дайын болады.` : `${n}оплата по заказу №${o.no} пришла, готово будет ${when}.`;
    case "on_the_way": return kz ? `${n}№${o.no} тапсырыс жолда, курьер жақын арада жетеді.` : `${n}заказ №${o.no} в пути, курьер скоро будет.`;
    case "awaiting_pickup": return kz ? `${n}№${o.no} тапсырыс дайын, алып кетуге болады: ${o.point_name}.` : `${n}заказ №${o.no} готов, можно забирать: ${o.point_name}.`;
    case "rejected": return kz ? `${n}кешіріңіз, №${o.no} тапсырысты орындай алмаймыз: ${o.reason}.` : `${n}к сожалению, заказ №${o.no} выполнить не сможем: ${o.reason}.`;
    case "cancelled": return kz ? `${n}№${o.no} тапсырыс тоқтатылды: ${o.reason}.` : `${n}заказ №${o.no} отменён: ${o.reason}.`;
    default: return null;
  }
}

export function soonText(o: Order): string {
  return o.lang === "kz" ? `${o.client_name ? o.client_name + ", " : ""}№${o.no} тапсырысты сатушы жақын арада растайды.`
    : `${o.client_name ? o.client_name + ", " : ""}продавец скоро подтвердит заказ №${o.no}.`;
}

export function handoffText(lang: Lang, kind: "complaint" | "voice" | "human" | "failed"): string {
  const ru = { complaint: "Простите, пожалуйста. Передаю продавцу — ответит здесь же.", voice: "Голосовые и фото пока не разбираю — передаю продавцу, он ответит здесь же.",
    human: "Передаю продавцу — ответит здесь же.", failed: "Передаю продавцу, чтобы ничего не напутать, — ответит здесь же." };
  const kz = { complaint: "Кешіріңіз. Сатушыға жіберемін — осында жауап береді.", voice: "Дауыстық хабар мен суретті әзірге түсінбеймін — сатушыға жіберемін.",
    human: "Сатушыға жіберемін — осында жауап береді.", failed: "Қателеспеу үшін сатушыға жіберемін — осында жауап береді." };
  return (lang === "kz" ? kz : ru)[kind];
}
