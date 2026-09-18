// Номер сборки — одной командой: node tools/bump-build.mjs [N]. Без N — следующая за текущей.
// Статические import не умеют подставлять переменную в "?v=", поэтому номер живёт в файлах
// буквально; этот скрипт — единственное место, где его меняют. Меняет все "?v=N" в страницах и
// модулях, константу BUILD и надпись «сборка N».
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = ["office.html", "stock.html", "index.html",
  ...["js/office", "js/stock"].flatMap((d) => fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith(".js")).map((f) => d + "/" + f))];
const api = fs.readFileSync(path.join(root, "js/office/api.js"), "utf8");
const cur = Number((api.match(/export const BUILD = (\d+);/) || [])[1] || 0);
const next = Number(process.argv[2]) || cur + 1;
let touched = 0;
for (const f of files) {
  const p = path.join(root, f);
  const before = fs.readFileSync(p, "utf8");
  const after = before.replace(/\?v=\d+/g, "?v=" + next)
    .replace(/export const BUILD = \d+;/, "export const BUILD = " + next + ";")
    .replace(/сборка \d+/g, "сборка " + next);
  if (after !== before) { fs.writeFileSync(p, after); touched++; }
}
console.log(`сборка ${cur} → ${next}, файлов изменено: ${touched}`);
