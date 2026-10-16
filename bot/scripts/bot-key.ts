// deno run --allow-read --allow-write scripts/bot-key.ts /srv/tandem/bot.env
const file = Deno.args[0];
if (!file) throw new Error("укажите путь к .env бота");
const key = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const text = await Deno.readTextFile(file).catch(() => "");
await Deno.writeTextFile(file, text.replace(/^UCHET_SERVICE_KEY=.*$/m, "").trimEnd() + "\nUCHET_SERVICE_KEY=" + key + "\n");
console.log("Ключ записан в " + file + ". Отпечаток для учёта (settings.bot_key_hash): " + hash);
