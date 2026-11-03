# Excel с действующими технологическими картами всех п/ф из выгрузки tools/iiko-charts-export.mjs.
# Листы: «Справка» (что внутри, итоги формулами), «Список ПФ» (карта - строка, ссылка на состав), «Техкарты» (строка на
# ингредиент, с фильтром), «Технология» (тексты приготовления).
# Запуск: python tools/iiko-charts-xlsx.py data/iiko/export_<дата>/pf_charts.json "<файл.xlsx>"
# Значения формул в файл кладёт пересчёт: soffice --headless --convert-to xlsx --outdir <папка> <файл.xlsx>
import json, sys
from datetime import date
from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter as col

src, out = sys.argv[1], sys.argv[2]
d = json.load(open(src, encoding="utf-8"))
ORDER = {"Заготовка": 0, "Блюдо в группе п/ф": 1, "Блюдо с п/ф в названии": 2}
R = sorted(d["records"], key=lambda r: (ORDER.get(r["kind"], 9), r["group"].casefold(), r["name"].strip().casefold()))
changed = set(d["changed"])

F = "Arial"
base, bold = Font(name=F, size=10), Font(name=F, size=10, bold=True)
head = Font(name=F, size=10, bold=True, color="FFFFFF")
link = Font(name=F, size=10, color="1F4E9E", underline="single")
HEAD = PatternFill("solid", fgColor="1F3864")
BAND = PatternFill("solid", fgColor="F2F5FA")
ZERO = PatternFill("solid", fgColor="FBE3E0")
NOTE = PatternFill("solid", fgColor="FFF3D6")
TOP = Border(top=Side(style="thin", color="8A97AB"))
WRAP = Alignment(wrap_text=True, vertical="top")
TOPA = Alignment(vertical="top")
AMOUNT = "0.000"


def iso(s):
    return date.fromisoformat(s) if s else None


def header(ws, names, widths):
    for i, (n, w) in enumerate(zip(names, widths), 1):
        c = ws.cell(1, i, n)
        c.font, c.fill = head, HEAD
        c.alignment = Alignment(wrap_text=True, vertical="center")
        ws.column_dimensions[col(i)].width = w
    ws.row_dimensions[1].height = 32
    ws.freeze_panes = "C2"


wb = Workbook()
info = wb.active
info.title = "Справка"
ls = wb.create_sheet("Список ПФ")
tk = wb.create_sheet("Техкарты")
tx = wb.create_sheet("Технология")

# ---------------------------------------------------------------- Техкарты: строка на ингредиент
header(tk, ["Артикул п/ф", "П/ф", "Вид", "Группа", "Выход карты", "Ед. п/ф", "№", "Ингредиент", "Артикул ингредиента", "Тип ингредиента",
            "Ед.", "Брутто", "Нетто", "Выход", "Брутто на 1 ед. п/ф", "Замечание"],
       [11, 38, 18, 12, 8, 6, 4, 38, 14, 14, 5, 9, 9, 9, 10, 24])
row, first_row = 2, {}
for k, r in enumerate(R):
    ch = r["chart"]
    first_row[r["article"]] = row
    lines = ch["lines"] or [None]
    for i, l in enumerate(lines, 1):
        vals = [r["article"], r["name"].strip(), r["kind"], r["group"], ch["output"], r["unit"]]
        if l:
            zero = not (l["gross"] or l["net"] or l["out"])
            note = "; ".join(x for x in ["количество 0" if zero else "", l["dept"], "удалён в iiko" if l["deleted"] else "", "нет в номенклатуре" if l["missing"] else ""] if x)
            vals += [i, l["name"].strip(), l["article"], l["type"], l["unit"], l["gross"], l["net"], l["out"], f'=IF($E{row}>0,L{row}/$E{row},"")', note]
        else:
            zero = False
            vals += [None, None, None, None, None, None, None, None, None, "в карте нет строк"]
        for c, v in enumerate(vals, 1):
            cell = tk.cell(row, c, v)
            cell.font = base
            if k % 2:
                cell.fill = BAND
            if i == 1:
                cell.border = TOP
        for c in (12, 13, 14, 15):
            tk.cell(row, c).number_format = AMOUNT
        tk.cell(row, 5).number_format = "0.###"
        if zero:
            for c in (12, 13, 14, 16):
                tk.cell(row, c).fill = ZERO
        elif vals[15]:
            tk.cell(row, 16).fill = NOTE
        row += 1
last_tk = row - 1
tk.auto_filter.ref = f"A1:P{last_tk}"

# ---------------------------------------------------------------- Список ПФ: карта - строка
header(ls, ["Артикул", "П/ф", "Вид", "Группа", "Выход карты", "Ед.", "Выход, запись в карте", "Действует с", "Изменена в iiko", "Изменена после 23.10", "Строк в составе", "Строк с количеством 0", "Текст технологии"],
       [10, 42, 20, 12, 8, 6, 10, 11, 11, 10, 8, 10, 10])
for i, r in enumerate(R, 2):
    ch = r["chart"]
    tech = any(ch[k] for k in ("technology", "appearance", "organoleptic"))
    vals = [r["article"], r["name"].strip(), r["kind"], r["group"], ch["output"], r["unit"], ch["outputComment"], iso(ch["from"]), iso(r["modified"]),
            "да" if r["name"] in changed else None, f"=COUNTIFS(Техкарты!$A$2:$A${last_tk},A{i},Техкарты!$H$2:$H${last_tk},\"?*\")",
            f"=COUNTIFS(Техкарты!$A$2:$A${last_tk},A{i},Техкарты!$P$2:$P${last_tk},\"количество 0*\")", "есть" if tech else None]
    for c, v in enumerate(vals, 1):
        cell = ls.cell(i, c, v)
        cell.font = base
    ls.cell(i, 2).hyperlink = f"#Техкарты!A{first_row[r['article']]}"
    ls.cell(i, 2).font = link
    ls.cell(i, 5).number_format = "0.###"
    for c in (8, 9):
        ls.cell(i, c).number_format = "DD.MM.YYYY"
last_ls = len(R) + 1
ls.auto_filter.ref = f"A1:M{last_ls}"

# ---------------------------------------------------------------- Технология: тексты приготовления
header(tx, ["Артикул", "П/ф", "Технология приготовления", "Внешний вид", "Органолептика"], [10, 38, 90, 40, 30])
i = 2
for r in R:
    ch = r["chart"]
    if not any(ch[k] for k in ("technology", "appearance", "organoleptic")):
        continue
    for c, v in enumerate([r["article"], r["name"].strip(), ch["technology"].strip() or None, ch["appearance"].strip() or None, ch["organoleptic"].strip() or None], 1):
        cell = tx.cell(i, c, v)
        cell.font, cell.alignment = base, WRAP
    i += 1
last_tx = i - 1
tx.auto_filter.ref = f"A1:E{last_tx}"

# ---------------------------------------------------------------- Справка
info.column_dimensions["A"].width = 58
info.column_dimensions["B"].width = 12
info.column_dimensions["C"].width = 70
info.sheet_view.showGridLines = False
when = date.fromisoformat(d["date"]).strftime("%d.%m.%Y")
info["A1"] = "Технологические карты п/ф из iiko"
info["A1"].font = Font(name=F, size=15, bold=True, color="1F3864")
info["A2"] = f"Выгружено из iiko {when}. У каждого п/ф карта, которая действует на эту дату."
info["A2"].font = base
rows = [
    ("Всего п/ф", f"=COUNTA('Список ПФ'!$A$2:$A${last_ls})", "По одной строке на листе «Список ПФ»; щелчок по названию ведёт к составу."),
    ("Заготовки (тип в iiko)", f"=COUNTIF('Список ПФ'!$C$2:$C${last_ls},\"Заготовка\")", "В основном группа «П/Ф»."),
    ("Блюда в группах «Блюда ПФ» и «Выпечка Пф»", f"=COUNTIF('Список ПФ'!$C$2:$C${last_ls},\"Блюдо в группе п/ф\")", "В iiko тип «блюдо», но лежат в группах п/ф. Не нужны - отфильтруйте по столбцу «Вид»."),
    ("Блюда с п/ф в названии", f"=COUNTIF('Список ПФ'!$C$2:$C${last_ls},\"Блюдо с п/ф в названии\")", "«Соус карри ПФ»."),
    ("Строк состава", f"=COUNTIF(Техкарты!$H$2:$H${last_tk},\"?*\")", "Лист «Техкарты»: строка на ингредиент, с фильтром."),
    ("Карт с текстом технологии", f"=COUNTA(Технология!$A$2:$A${last_tx})", "Лист «Технология»."),
    ("Карт изменено после прошлой выгрузки 23.10", f"=COUNTIF('Список ПФ'!$J$2:$J${last_ls},\"да\")", "В учёт эти изменения ещё не перенесены: перенос - при обновлении перед запуском."),
    ("Строк с количеством 0", f"=COUNTIF(Техкарты!$P$2:$P${last_tk},\"количество 0*\")", "Ингредиент есть в карте, а брутто, нетто и выход пустые: так в самой iiko. По такой строке ничего не списывается. Стоит проверить технологу."),
    ("Карт, где есть такие строки", f"=COUNTIF('Список ПФ'!$L$2:$L${last_ls},\">0\")", "Столбец «Строк с количеством 0» на листе «Список ПФ»."),
    ("Строк не для всех подразделений", f"=COUNTIF(Техкарты!$P$2:$P${last_tk},\"*подразд*\")", "В iiko строка не списывается в одном из подразделений: см. карту в iiko."),
]
info["A4"], info["B4"], info["C4"] = "Показатель", "Значение", "Пояснение"
for c in ("A4", "B4", "C4"):
    info[c].font, info[c].fill = head, HEAD
for n, (a, b, c) in enumerate(rows, 5):
    info[f"A{n}"], info[f"B{n}"], info[f"C{n}"] = a, b, c
    info[f"A{n}"].font, info[f"B{n}"].font, info[f"C{n}"].font = base, bold, base
    info[f"A{n}"].alignment = info[f"C{n}"].alignment = WRAP
    info[f"B{n}"].alignment = TOPA
n = 5 + len(rows) + 1
info[f"A{n}"] = "Как читать состав"
info[f"A{n}"].font = bold
legend = [
    ("Выход карты", "На сколько единиц п/ф рассчитан состав, в единицах столбца «Ед. п/ф». Чаще 1; у 12 карт другое число (например, 1,9 кг)."),
    ("Брутто", "Сколько ингредиента берут до обработки. По брутто идёт списание."),
    ("Нетто", "Вес после холодной обработки."),
    ("Выход", "Вес в готовом виде после тепловой обработки. У части строк пусто (0): так заведено в iiko."),
    ("Брутто на 1 ед. п/ф", "Брутто, делённое на выход карты: удобно сравнивать карты с разным выходом."),
    ("Выход, запись в карте", "Текстовое поле «выход» в карте iiko, как его заполнили."),
    ("Тип ингредиента «Заготовка»", "Сам ингредиент - п/ф со своей картой, её состав есть в этом же файле."),
]
for k, (a, b) in enumerate(legend, n + 1):
    info[f"A{k}"], info[f"C{k}"] = a, b
    info[f"A{k}"].font, info[f"C{k}"].font = base, base
    info[f"A{k}"].alignment = info[f"C{k}"].alignment = WRAP
n = n + len(legend) + 2
extra = [f"В файл не вошли: {', '.join(d['skippedGoods'])} - товар в группе «П/Ф», карты у товара нет."] if d["skippedGoods"] else []
empty = [r["name"].strip() for r in R if not r["chart"]["lines"]]
if empty:
    extra.append(f"Карта без строк состава: {', '.join(empty)}.")
for k, t in enumerate(extra, n):
    info[f"A{k}"] = t
    info[f"A{k}"].font = base

wb.save(out)
print(f"записано: {out}; п/ф {len(R)}, строк на листе «Техкарты» {last_tk - 1}, технологий {last_tx - 1}")
