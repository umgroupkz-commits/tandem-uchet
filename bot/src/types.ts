// Общие типы бота. Формы заказа и события повторяют tandem.corder_json / corder_events (часть A, 0050).
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
export type Lang = "ru" | "kz";

export interface MenuItem {
  item_code: string; title_ru: string; title_kz: string | null;
  composition_ru: string | null; composition_kz: string | null;
  unit_label: "кг" | "шт" | "сет"; price: number; min_qty: number; step: number;
  section: string; ready_kind: "fresh" | "stock"; stopped: boolean; stop_until: string | null;
  sort_order: number; active: boolean; checked: boolean;
}
export interface Menu { now: string; settings: Record<string, string>; points: { id: string; name: string }[]; items: MenuItem[] }

export interface OrderLine { item_code: string; title: string; unit: string; qty: number; price: number; sum: number }
export interface Order {
  id: number; uid: string; no: number; no_date: string; point_id: string; point_name: string;
  uzel_dialog_id: string | null; client_phone: string; client_name: string | null; lang: Lang;
  kind: "delivery" | "pickup"; address: string | null; for_date: string; ready_by: string; total: number;
  prepay_suggested: boolean; prepay_required: boolean; pay_kind: string | null; courier: string | null;
  status: string; status_name: string; reason: string | null; created_at: string; confirmed_by: string | null;
  lines: OrderLine[];
}
export interface OrderEvent {
  id: number; at: string; status_from: string | null; status_to: string; by_kind: string; by_name: string;
  payload: Record<string, unknown>; order: Order;
}
export interface CartLine { item_code: string; qty: number }
export interface Details {
  kind?: "delivery" | "pickup"; for_date?: string; ready_by?: string; address?: string;
  client_name?: string; point_id?: string;
}
export interface Quote {
  point_id: string; point_name: string; kind: "delivery" | "pickup"; for_date: string; ready_by: string;
  address: string | null; lines: (OrderLine & { title_kz?: string | null })[]; total: number;
  delivery_fee: number; prepay_suggested: boolean;
}
export interface DialogState {
  dialog_id: string; phone: string; name: string | null; lang: Lang;
  convo: unknown[];                  // MessageParam[] Anthropic — только дописывается
  cart: CartLine[]; details: Details; quote: Quote | null;
  stage: "chat" | "awaiting_yes" | "submitted";
  summary_sent_at: string | null; draft_uid: string; last_order_no: number | null;
  last_client_msg_id: string | null; last_activity: string;
  system_text: string | null;       // системная часть, замороженная на весь разговор (null — ещё не начат)
  menu_seen_hash: string | null;    // отпечаток правил и меню, которые модель видела последними
}
