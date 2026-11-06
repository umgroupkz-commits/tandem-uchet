// deno run --allow-read --allow-write scripts/bot-key.ts /srv/tandem/bot.env
// Файл .env должен уже быть: опечатка в пути не должна молча создать новый файл с одним ключом.
const file = Deno.args[0];
if (!file) throw new Error("укажите путь к .env бота");
let text: string;
try { text = await Deno.readTextFile(file); }
catch { console.error("Нет файла " + file + " — проверьте путь к .env бота."); Deno.exit(1); }
const key = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)))].map((b) => b.toString(16).padStart(2, "0")).join("");
await rewrite(file, text.replace(/^UCHET_SERVICE_KEY=.*$/m, "").trimEnd() + "\nUCHET_SERVICE_KEY=" + key + "\n");
console.log("Ключ записан в " + file + ". Отпечаток для учёта (settings.bot_key_hash): " + hash);

// Переписать файл на месте (тот же файл, права 600 остаются). Не Deno.writeTextFile: на сервере Енешки
// (файл с хоста в контейнере) он падает с EACCES, а открытие с усечением проходит (проверено 06.11.2026).
async function rewrite(path: string, text: string) {
  const f = await Deno.open(path, { write: true, truncate: true });
  try { await f.write(new TextEncoder().encode(text)); } finally { f.close(); }
}
