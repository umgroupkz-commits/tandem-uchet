# Excel с действующими технологическими картами всех п/ф из выгрузки tools/iiko-charts-export.mjs: один лист, строка на
# ингредиент, без формул и объединённых ячеек - для загрузки в 1С. Артикулы текстом: ведущие нули важны. Карта без
# строк состава в файл не попадает (о ней скрипт пишет в консоль).
# Запуск: python tools/iiko-charts-xlsx.py data/iiko/export_<дата>/pf_charts.json "<файл.xlsx>"
import json, sys
from openpyxl import Workbook
from openpyxl.styles import Font
from openpyxl.utils import get_column_letter as col

src, out = sys.argv[1], sys.argv[2]
d = json.load(open(src, encoding="utf-8"))
R = sorted(d["records"], key=lambda r: r["name"].strip().casefold())

base, bold = Font(name="Arial", size=10), Font(name="Arial", size=10, bold=True)
wb = Workbook()
ws = wb.active
ws.title = "Техкарты"
HEAD = [("Артикул п/ф", 12), ("Полуфабрикат", 42), ("Выход п/ф", 10), ("Ед. п/ф", 8), ("Артикул ингредиента", 20),
        ("Ингредиент", 42), ("Ед. ингредиента", 15), ("Брутто", 10), ("Нетто", 10), ("Выход", 10)]
for i, (name, width) in enumerate(HEAD, 1):
    ws.cell(1, i, name).font = bold
    ws.column_dimensions[col(i)].width = width
ws.freeze_panes = "A2"

row, empty = 2, []
for r in R:
    ch = r["chart"]
    if not ch["lines"]:
        empty.append(r["name"].strip())
        continue
    for l in ch["lines"]:
        vals = [r["article"], r["name"].strip(), ch["output"], r["unit"], l["article"], l["name"].strip(), l["unit"], l["gross"], l["net"], l["out"]]
        for c, v in enumerate(vals, 1):
            ws.cell(row, c, v).font = base
        row += 1
ws.auto_filter.ref = f"A1:J{row - 1}"
wb.save(out)
print(f"записано: {out}; карт {len(R) - len(empty)}, строк {row - 2}; карты без строк: {', '.join(empty) or '-'}")
