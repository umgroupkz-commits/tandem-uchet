// Шаблоны сообщений клиенту. Ключевые фразы модель не пересказывает: их шлют инструменты и наблюдатель.
// Номер заказа и имя в каждом статусном шаблоне — тексты разные, правило «Узла» «один текст не больше
// 5 клиентам в час» их не задерживает. Казахские тексты вычитаны Claude 23.10.2026 (решение Андрея - без платной
// модели): после времени нет падежных окончаний («15:00-ге» зависит от того, как число звучит). Тексты клиенту - без
// длинных тире (правило владельца). Условия доставки итог не обещает: они в настройках учёта и в правилах модели.
import type { Lang, Order, Quote } from "./types.ts";
import { money, qtyText } from "./menu.ts";

const dm = (d: string) => d.slice(8, 10) + "." + d.slice(5, 7);
// С именем — «Айгуль, заказ…», без имени — «Заказ…»: первая буква фразы заглавная.
const withName = (name: string | null | undefined, s: string) =>
  name ? `${name}, ${s[0].toLowerCase()}${s.slice(1)}` : s[0].toUpperCase() + s.slice(1);
const lines = (...xs: (string | null | undefined)[]) => xs.filter((x) => x).join("\n");

export function summaryText(q: Quote, lang: Lang, name: string | null): string {
  const ls = q.lines.map((l) => `• ${(lang === "kz" && l.title_kz) || l.title} - ${qtyText(l.qty)} ${l.unit} × ${money(l.price)} = ${money(l.sum)}`);
  if (lang === "kz") {
    return [withName(name, "тапсырысты тексеріңіз:"), ...ls, `Барлығы: ${money(q.total)}`,
      q.kind === "delivery" ? `Жеткізу: ${q.address}` : `Өзіңіз алып кетесіз: ${q.point_name}`,
      `Дайын болу уақыты: ${dm(q.for_date)}, сағат ${q.ready_by}.`, "Бәрі дұрыс па?"].join("\n");
  }
  return [withName(name, "проверьте заказ:"), ...ls, `Итого: ${money(q.total)}`,
    q.kind === "delivery" ? `Доставка: ${q.address}` : `Самовывоз: ${q.point_name}`,
    `Готово ${dm(q.for_date)} к ${q.ready_by}.`, "Всё верно?"].join("\n");
}

export function submittedText(no: number, lang: Lang, inHours: boolean, from: string): string {
  if (lang === "kz") return inHours
    ? `Тапсырыс №${no} сатушыға жіберілді, 15 минут ішінде растаймыз.`
    : `Тапсырыс №${no} қабылданды. Таңертең жұмыс басталғанда (сағат ${from}) растаймыз.`;
  return inHours ? `Заказ №${no} передал продавцу, подтвердим в течение 15 минут.`
    : `Заказ №${no} записал. Подтвердим утром, с ${from}.`;
}

export function statusText(o: Order, s: Record<string, string>): string | null {
  const n = (t: string) => withName(o.client_name, t);
  const kz = o.lang === "kz";
  const when = `${dm(o.for_date)} ${o.ready_by}`;
  switch (o.status) {
    case "confirmed": return kz ? n(`тапсырыс №${o.no} расталды: ${when}, ${money(o.total)}. Рахмет!`)
      : n(`заказ №${o.no} подтверждён: ${when}, ${money(o.total)}. Спасибо!`);
    case "awaiting_prepay": return kz
      ? lines(n(`тапсырыс №${o.no} расталды. Пісіруді бастау үшін алдын ала төлем қажет: ${money(o.total)}.`), s.kaspi_details_kz || s.kaspi_details_ru, "Төлегеннен кейін жазып жіберіңіз.")
      : lines(n(`заказ №${o.no} подтверждён. Чтобы начать печь, нужна предоплата ${money(o.total)}.`), s.kaspi_details_ru, "После оплаты напишите, пожалуйста.");
    case "paid": return kz ? n(`№${o.no} тапсырыс бойынша төлем түсті, дайын болу уақыты: ${when}.`) : n(`оплата по заказу №${o.no} пришла, готово будет ${when}.`);
    case "on_the_way": return kz ? n(`№${o.no} тапсырыс жолда, курьер жақын арада жетеді.`) : n(`заказ №${o.no} в пути, курьер скоро будет.`);
    case "awaiting_pickup": return kz ? n(`№${o.no} тапсырыс дайын, алып кетуге болады: ${o.point_name}.`) : n(`заказ №${o.no} готов, можно забирать: ${o.point_name}.`);
    case "rejected": return kz ? n(`кешіріңіз, №${o.no} тапсырысты орындай алмаймыз: ${o.reason}.`) : n(`к сожалению, заказ №${o.no} выполнить не сможем: ${o.reason}.`);
    case "cancelled": return kz ? n(`№${o.no} тапсырыс жойылды: ${o.reason}.`) : n(`заказ №${o.no} отменён: ${o.reason}.`);
    default: return null;
  }
}

export function soonText(o: Order): string {
  return o.lang === "kz" ? withName(o.client_name, `№${o.no} тапсырысты сатушы жақын арада растайды.`)
    : withName(o.client_name, `продавец скоро подтвердит заказ №${o.no}.`);
}

export type HandoffKind = "complaint" | "files" | "human" | "failed";
export function handoffText(lang: Lang, kind: HandoffKind, name: string | null = null): string {
  const ru = { complaint: "Простите, пожалуйста. Передаю продавцу, он ответит здесь же.",
    files: "Файлы, голосовые и стикеры пока не разбираю, передаю продавцу, он ответит здесь же.",
    human: "Передаю продавцу, он ответит здесь же.", failed: "Передаю продавцу, чтобы ничего не напутать, он ответит здесь же." };
  const kz = { complaint: "Кешіріңіз. Сатушыға жіберемін, ол осы чатта жауап береді.",
    files: "Файлдарды, дауыстық хабарламаларды және стикерлерді әзірге оқи алмаймын, сатушыға жіберемін, ол осы чатта жауап береді.",
    human: "Сатушыға жіберемін, ол осы чатта жауап береді.", failed: "Қателеспеу үшін сатушыға жіберемін, ол осы чатта жауап береді." };
  return withName(name, (lang === "kz" ? kz : ru)[kind]);
}
