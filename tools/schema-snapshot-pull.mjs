// Снимок схемы с боевой базы одной командой: служебное действие гейта schema_snapshot (0056, по служебному ключу)
// отдаёт строки запроса db/schema/snapshot-query.sql, из них собирается db/schema/tandem_full.sql.
// Ключ - data/service_key.txt или TANDEM_SERVICE_KEY. Запуск: node tools/schema-snapshot-pull.mjs
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const API = process.env.TANDEM_API_URL || "https://qeehxcnnuzuwskznhdyg.supabase.co/functions/v1/uchet";
const key = process.env.TANDEM_SERVICE_KEY || fs.readFileSync("data/service_key.txt", "utf8").trim();
const res = await fetch(API, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ action: "schema_snapshot", payload: { service_key: key } }) });
const text = await res.text();
if (!text.startsWith("[")) { console.error("отказ: " + text.slice(0, 300)); process.exit(1); }
fs.mkdirSync("data", { recursive: true });
fs.writeFileSync("data/schema_snapshot.json", text);
console.log("строк снимка: " + JSON.parse(text).length);
execFileSync(process.execPath, ["tools/build-schema-snapshot.mjs", "data/schema_snapshot.json"], { stdio: "inherit" });
