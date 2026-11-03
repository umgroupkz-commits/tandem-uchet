# Технологические карты из выгрузки tools/iiko-charts-export.mjs (п/ф и «Блюда на продажу») в Excel: форма как в печатной
# техкарте iiko (образец клиента «Вареники с вишней 0,7.xls»), на каждую карту свой лист и страница А4, первый лист -
# оглавление со ссылками. Как в образце: вес в кг = количество × вес единицы (у пакета 1 шт, но 0 кг), внизу - сумма столбца
# «Вес готового продукта», в скобках - поле «выход» карты, дата - начало действия карты.
# Запуск: python tools/iiko-charts-xlsx.py data/iiko/export_<дата>/pf_charts.json "<файл.xlsx>"
import json, math, re, sys
from datetime import date
from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, Side
from openpyxl.utils import get_column_letter as col
from openpyxl.worksheet.hyperlink import Hyperlink
from openpyxl.worksheet.page import PageMargins

src, out = sys.argv[1], sys.argv[2]
d = json.load(open(src, encoding="utf-8"))
R = sorted(d["records"], key=lambda r: (r["group"].casefold(), r["name"].strip().casefold()))

WIDTHS = dict(zip("ABCDEFGHIJKLMNOPQR", [3.1, 8.1, 4.0, 5.0, 2.0, 5.1, 1.9, 5.1, 4.0, 3.1, 3.0, 4.1, 7.1, 11.2, 3.0, 1.0, 22.3, 3.1]))
THIN = Side(style="thin")
NUM = "#,##0.000"


def font(size, bold=False, italic=False):
    return Font(name="Arial", size=size, bold=bold, italic=italic)


def put(ws, rng, value=None, f=None, h="left", v="top", wrap=False, fmt=None, shrink=False):
    """Значение в левую верхнюю ячейку диапазона и объединение."""
    a = rng.split(":")[0]
    c = ws[a]
    c.value = value
    c.font = f or font(8)
    c.alignment = Alignment(horizontal=h, vertical=v, wrap_text=wrap, shrink_to_fit=shrink)
    if fmt:
        c.number_format = fmt
    if ":" in rng:
        ws.merge_cells(rng)


def box(ws, rng, top=True, bottom=True):
    """Рамка по контуру диапазона (у объединённых ячеек рамка хранится в крайних ячейках)."""
    rows = list(ws[rng]) if ":" in rng else [[ws[rng]]]
    for i, row in enumerate(rows):
        for j, c in enumerate(row):
            b = c.border
            c.border = Border(left=THIN if j == 0 else b.left, right=THIN if j == len(row) - 1 else b.right,
                              top=THIN if i == 0 and top else b.top, bottom=THIN if i == len(rows) - 1 and bottom else b.bottom)


def lines_of(text, per_line):
    """Сколько строк займёт текст при переносе: высота объединённых ячеек сама не подбирается."""
    return sum(max(1, math.ceil(len(p) / per_line)) for p in str(text).split("\n")) if text else 1


def card(ws, r):
    ch = r["chart"]
    name = r["name"]
    rows = ch["lines"] or [None]
    n = len(rows)
    last = 10 + n          # последняя строка состава
    t = last + 1           # строка «ИТОГО»
    ws.sheet_view.showGridLines = False
    for k, w in WIDTHS.items():
        ws.column_dimensions[k].width = w

    # шапка
    put(ws, "A1:N1", name, font(20, True), wrap=True); box(ws, "A1:N1")
    put(ws, "O1:R9"); box(ws, "O1:R9")
    put(ws, "A2:K3", f"Технологическая карта № {r['article']}", font(9, True))
    put(ws, "L2:N2", "Название на чеке:", font(6, italic=True))
    put(ws, "L3:N4", name, font(12, True), wrap=True)
    started = " " + date.fromisoformat(ch["from"]).strftime("%d.%m.%Y") if ch["from"] else None
    put(ws, "A4:K4", started)
    box(ws, "A2:K4"); box(ws, "L2:N4")
    put(ws, "A5:D5", "Область применения:", font(10, True))
    put(ws, "E5:N5", "Все подразделения", font(10))
    put(ws, "A6:B6", "Хранение:", font(10, True))
    put(ws, "C6:N6")
    put(ws, "A7:C7", "Срок Хранения:", font(10, True))
    put(ws, "D7:N7")
    put(ws, "A8:G8", "Органолептические показатели:", font(10, True))
    put(ws, "H8:N8")
    put(ws, "A9:N9", ch["organoleptic"].strip() or None, wrap=True)
    box(ws, "A5:N9")

    # заголовок состава
    s6 = font(6)
    put(ws, "A10", "№", s6, h="center", v="center"); box(ws, "A10")
    put(ws, "B10:E10", "Наименование продукта", s6, v="center"); box(ws, "B10:E10")
    put(ws, "F10", "Ед. изм.", s6, h="center", v="center"); box(ws, "F10")
    put(ws, "G10:H10", "Брутто в ед. изм.", s6, h="center", v="center", wrap=True); box(ws, "G10:H10")
    put(ws, "I10:J10", "Вес брутто, кг", s6, h="center", v="center", wrap=True); box(ws, "I10:J10")
    put(ws, "K10:L10", "Вес нетто или п/ф, кг", s6, h="center", v="center", wrap=True); box(ws, "K10:L10")
    put(ws, "M10", "Вес готового продукта, кг", s6, h="center", v="center", wrap=True); box(ws, "M10")
    put(ws, "N10:R10", "Технология приготовления", font(12, True), v="center"); box(ws, "N10:R10", bottom=False)

    # состав
    total, heights = 0.0, []
    for i, l in enumerate(rows, 1):
        y = 10 + i
        num = dict(h="right", v="center", wrap=True, fmt=NUM, f=font(8))
        put(ws, f"A{y}", i if l else None, s6, h="center", v="center"); box(ws, f"A{y}")
        put(ws, f"B{y}:E{y}", l["name"].strip() if l else None, font(8, True), v="center", wrap=True); box(ws, f"B{y}:E{y}")
        put(ws, f"F{y}", l["unit"] if l else None, s6, h="center", v="center"); box(ws, f"F{y}")
        if l:
            w = l["weight"]
            out_kg = l["out"] * w
            total += out_kg
        put(ws, f"G{y}:H{y}", l["gross"] if l else None, **num); box(ws, f"G{y}:H{y}")
        put(ws, f"I{y}:J{y}", round(l["gross"] * w, 6) if l else None, **num); box(ws, f"I{y}:J{y}")
        put(ws, f"K{y}:L{y}", round(l["net"] * w, 6) if l else None, **num); box(ws, f"K{y}:L{y}")
        put(ws, f"M{y}", round(out_kg, 6) if l else None, **num); box(ws, f"M{y}")
        heights.append(max(17.0, lines_of(l["name"] if l else "", 21) * 10.2 + 2))

    # технология: текст, затем заголовок требований к подаче и их текст - как в форме iiko
    tech = ch["technology"].strip() + "\nТРЕБОВАНИЯ К ОФОРМЛЕНИЮ, ПОДАЧЕ И РЕАЛИЗАЦИИ"
    if ch["appearance"].strip():
        tech += "\n" + ch["appearance"].strip()
    put(ws, f"N11:R{last}", tech, wrap=True)
    box(ws, f"N11:R{last}", top=False)
    need = (lines_of(ch["technology"].strip(), 44) + 2 + (lines_of(ch["appearance"].strip(), 44) if ch["appearance"].strip() else 0)) * 10.6 + 6
    if sum(heights) < need:
        add = (need - sum(heights)) / n
        heights = [h + add for h in heights]

    # итог
    put(ws, f"A{t}:O{t}", "ИТОГО", font(10, True, True))
    put(ws, f"P{t}:R{t + 1}")
    put(ws, f"A{t + 1}:I{t + 2}", "вес готового блюда (изделия) в расчете на", font(10, italic=True), shrink=True)
    amount = f"{ch['output']:.3f}".replace(".", ",")
    put(ws, f"J{t + 1}:O{t + 2}", f"{amount} {r['unit']}".rstrip(), font(10, True))
    put(ws, f"P{t + 2}:P{t + 3}")
    put(ws, f"Q{t + 2}:Q{t + 3}", round(total, 6), font(9, True), h="right", fmt="#,##0.0000")
    put(ws, f"R{t + 2}:R{t + 3}", "кг", font(9, True), fmt="#,##0.0000")
    comment = ch["outputComment"].strip()
    put(ws, f"A{t + 3}:O{t + 4}", f"Суммарный выход продукта ({comment})" if comment else "Суммарный выход продукта", font(10, italic=True))
    put(ws, f"P{t + 4}:R{t + 4}")
    put(ws, f"A{t + 5}:R{t + 5}")
    box(ws, f"A{t}:R{t + 5}")

    # высоты: как в образце, но длинные названия и тексты не обрезаются
    per = {1: max(28.6, lines_of(name, 32) * 26 + 3), 2: 11.8, 3: 5.8, 4: max(22.8, lines_of(name, 18) * 14.6 - 5.8 + 2),
           5: 12.8, 6: 12.8, 7: 12.8, 8: 12.8, 9: max(52.2, lines_of(ch["organoleptic"].strip(), 80) * 10.6 + 4), 10: 23.5}
    for y, h in per.items():
        ws.row_dimensions[y].height = h
    for i, h in enumerate(heights):
        ws.row_dimensions[11 + i].height = round(h, 1)
    for y, h in {t: 12.8, t + 1: 6.5, t + 2: 6.5, t + 3: 6.5, t + 4: 6.5, t + 5: 35.3}.items():
        ws.row_dimensions[y].height = h

    # страница: как в образце, А4 книжная; длинная карта уходит на вторую страницу, ширина всегда в одну
    ws.print_area = f"A1:R{t + 5}"
    ws.page_setup.paperSize = ws.PAPERSIZE_A4
    ws.page_setup.orientation = "portrait"
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 0
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.page_margins = PageMargins(left=0.39375, right=0.39375, top=0.39375, bottom=0.39375, header=0.5118, footer=0.5118)


def sheet_name(r, used):
    base = re.sub(r"\s+", " ", re.sub(r"[\[\]:*?/\\]", " ", f"{r['article']} {r['name']}")).strip()[:31].rstrip(" '")
    assert base not in used, base
    used.add(base)
    return base


wb = Workbook()
idx = wb.active
idx.title = "Оглавление"
idx.sheet_view.showGridLines = False
for i, (name, width) in enumerate([("Группа", 20), ("Артикул", 10), ("Наименование", 60)], 1):
    c = idx.cell(1, i, name)
    c.font = font(10, True)
    c.border = Border(bottom=THIN)
    idx.column_dimensions[col(i)].width = width
idx.freeze_panes = "A2"
idx.page_setup.paperSize = idx.PAPERSIZE_A4
idx.page_setup.fitToWidth = 1
idx.page_setup.fitToHeight = 0
idx.sheet_properties.pageSetUpPr.fitToPage = True
idx.auto_filter.ref = f"A1:C{len(R) + 1}"

used = set()
for i, r in enumerate(R, 2):
    r["name"] = r["name"].strip()
    title = sheet_name(r, used)
    ws = wb.create_sheet(title)
    card(ws, r)
    back = ws["T1"]            # вне области печати
    back.value = "← Оглавление"
    back.hyperlink = Hyperlink(ref="T1", location="'Оглавление'!A1")
    back.font = Font(name="Arial", size=10, color="1F4E9E", underline="single")
    ws.column_dimensions["S"].width = 2
    ws.column_dimensions["T"].width = 14
    quoted = title.replace("'", "''")
    idx.cell(i, 1, r["group"]).font = font(10)
    idx.cell(i, 2, r["article"]).font = font(10)
    c = idx.cell(i, 3, r["name"])
    c.hyperlink = Hyperlink(ref=c.coordinate, location=f"'{quoted}'!A1")
    c.font = Font(name="Arial", size=10, color="1F4E9E", underline="single")

wb.save(out)
empty = [r["name"] for r in R if not r["chart"]["lines"]]
print(f"записано: {out}; карт {len(R)}, листов {len(wb.sheetnames)}; карты без состава: {', '.join(empty) or '-'}")
