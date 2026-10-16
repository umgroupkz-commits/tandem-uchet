// deno run --allow-net --allow-env --allow-read --allow-write scripts/register.ts /srv/tandem/bot.env
import { UzelClient } from "../src/uzel.ts";
const file = Deno.args[0];
if (!file) throw new Error("укажите путь к .env бота");
const env = Deno.env.toObject();
const uzel = new UzelClient(env.UZEL_BASE_URL, env.UZEL_API_KEY);
const secret = await uzel.registerWebhook(env.PUBLIC_BASE_URL.replace(/\/$/, "") + "/uzel");
const text = await Deno.readTextFile(file);
await Deno.writeTextFile(file, text.replace(/^UZEL_WEBHOOK_SECRET=.*$/m, "") .trimEnd() + "\nUZEL_WEBHOOK_SECRET=" + secret + "\n");
console.log("Вебхук «Узла» зарегистрирован, секрет записан в " + file);
const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ url: env.PUBLIC_BASE_URL.replace(/\/$/, "") + "/tg", secret_token: env.TELEGRAM_WEBHOOK_SECRET, allowed_updates: ["message", "callback_query"] }) });
console.log("Telegram: " + (await r.json()).description);
