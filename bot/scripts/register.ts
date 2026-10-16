// deno run --allow-net --allow-env --allow-read --allow-write scripts/register.ts /srv/tandem/bot.env
// Сетевые ошибки печатаются общими словами: в тексте ошибки fetch есть адрес, а в адресе Telegram — токен.
import { UzelClient } from "../src/uzel.ts";
const file = Deno.args[0];
if (!file) throw new Error("укажите путь к .env бота");
const env = Deno.env.toObject();
const base = (env.PUBLIC_BASE_URL ?? "").replace(/\/$/, "");
const uzel = new UzelClient(env.UZEL_BASE_URL, env.UZEL_API_KEY);
let secret: string;
try { secret = await uzel.registerWebhook(base + "/uzel"); }
catch { console.error("«Узел»: вебхук не зарегистрирован — проверьте UZEL_BASE_URL, UZEL_API_KEY и что бот отвечает на " + base + "/uzel."); Deno.exit(1); }
const text = await Deno.readTextFile(file);
await Deno.writeTextFile(file, text.replace(/^UZEL_WEBHOOK_SECRET=.*$/m, "").trimEnd() + "\nUZEL_WEBHOOK_SECRET=" + secret + "\n");
console.log("Вебхук «Узла» зарегистрирован, секрет записан в " + file);
try {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: base + "/tg", secret_token: env.TELEGRAM_WEBHOOK_SECRET, allowed_updates: ["message", "callback_query"] }),
    signal: AbortSignal.timeout(10_000) });
  const j = await r.json();
  console.log(j.ok ? "Telegram: вебхук установлен." : "Telegram: отказ — " + String(j.description ?? r.status));
  if (!j.ok) Deno.exit(1);
} catch {
  console.error("Telegram: вебхук не установлен (сеть или ответ) — проверьте TELEGRAM_BOT_TOKEN и доступ к api.telegram.org.");
  Deno.exit(1);
}
