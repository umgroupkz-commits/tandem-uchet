// Общее для экранов склада бэк-офиса: справочники документов, права, список складов пользователя
// и мелкие помощники вкладок. Журнал и форма документа — stock.js, отчёты — stock-reports.js.
import { session } from "./api.js?v=21";
import { el } from "./ui.js?v=21";

export const TYPES = { invoice_in: "Приход", transfer: "Перемещение", writeoff: "Списание", production: "Производство", inventory: "Инвентаризация", sale: "Продажа" };
// Продажу заводит отчёт точки, а не человек: в «+ Новый документ» её нет.
export const MANUAL = Object.keys(TYPES).filter((k) => k !== "sale");
// Причины списания — статьи, к которым привыкли в iiko (брак, представительские, хознужды); список тот же,
// что в ограничении documents_reason_check на сервере (0045). «Ввод остатков» — не причина списания,
// а пометка инвентаризации: её здесь нет, чтобы не попасть в выбор у акта списания.
export const REASONS = { spoilage: "порча", defect: "брак", tasting: "проработка", staff_meals: "питание персонала",
  hospitality: "представительские", internal: "хозяйственные нужды", other: "прочее" };
export const perms = () => (session() && session().permissions) || [];
export const canDoc = (type) => perms().includes("doc:" + type + ":edit");
export const canAnyDoc = () => MANUAL.some(canDoc);
export const canSales = () => perms().includes("doc:sale:view");
// Список складов держим полным: выключенный склад должен читаться в карточке старого
// документа и в остатках. Выбирать из него можно только действующие — active().
// Массивы общие для обоих модулей склада и меняются на месте (setStores/setMyIds), а не переприсваиваются.
export const stores = [];
export const setStores = (list) => { stores.splice(0, stores.length, ...(list || [])); };
export const active = () => stores.filter((s) => s.active);
// Склады в выпадающих списках — по алфавиту: в справочнике их три десятка, и «Учебный склад кухни»
// стоял последним, хотя по имени он рядом с другими учебными. Ключи — uuid, поэтому порядок вставки
// в объект сохраняется, и sel() выводит их в этом порядке.
// Учебный склад (training, 0045) подписан «(учебный)»: приходы на него не меняют учётные цены, и
// спутать его с настоящим при выборе не должно быть легко. Сортировка — по самому названию.
export const storeLabel = (s) => String(s.name || "") + (s.training ? " (учебный)" : "");
export const opts = (list) => Object.fromEntries([...list].sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "ru"))
  .map((s) => [s.id, storeLabel(s)]));
// Склады, закреплённые за пользователем (пусто — все). Сервер проверяет сам; здесь лишь
// не предлагаем то, что он отклонит.
export const myIds = [];
export const setMyIds = (list) => { myIds.splice(0, myIds.length, ...(list || [])); };
export const mine = (list) => myIds.length ? list.filter((s) => myIds.includes(s.id)) : list;
// Номер последнего запроса по вкладке: ответ, обогнанный более новым, не рисуется — иначе при
// быстрой смене фильтра на экране складывались таблицы всех запросов, в том числе устаревших.
export const seqs = {};
export const nextSeq = (k) => (seqs[k] = (seqs[k] || 0) + 1);
// Вкладка отчёта: строка фильтров строится один раз при открытии вкладки (build), дальше
// обновляется только область результата .out — пересозданное поле теряло фокус посреди ввода.
export function tabOut(id, build) {
  const host = document.getElementById(id); if (!host) return null;
  if (!host.firstChild) host.append(...build(), el("div", { class: "out" }));
  return host.querySelector(":scope > .out");
}
export function sel(opts, value, onchange, disabled = false) {
  const s = el("select", { disabled, onchange: (e) => onchange(e.target.value) });
  for (const [v, t] of Object.entries(opts)) s.append(el("option", { value: v, selected: v === value }, t));
  return s;
}
// Связи между модулями склада без взаимного импорта: stock.js при загрузке кладёт сюда открытие
// карточки документа и переход в журнал: openDocs(q, opts) — поиск и, если opts передан, фильтр
// {doc_type, store_id, date_from, date_to, status} (щелчок по поставщику в «Закупках» — с типом
// «Приход», складом и периодом отчёта).
export const hooks = { editDoc: () => {}, openDocs: () => {} };
