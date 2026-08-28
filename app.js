const API = "https://qeehxcnnuzuwskznhdyg.supabase.co/functions/v1/uchet";

var S = {
  role: null, point: null, pin: '', items: [], mode: null,
  expenses: [], takeout: [], sales: [], dash: null, charts: null
};
var $ = function (id) { return document.getElementById(id); };
var fmt = function (n) {
  n = Number(n || 0);
  return (Math.round(n * 100) / 100).toLocaleString('ru-RU');
};
var num = function (v) {
  if (v === null || v === undefined) return 0;
  var s = String(v).replace(/\s/g, '').replace(',', '.');
  var x = parseFloat(s);
  return isNaN(x) ? 0 : x;
};
var today = function () {
  var d = new Date();
  var m = String(d.getMonth() + 1).padStart(2, '0');
  var dd = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + m + '-' + dd;
};

function api(action, payload) {
  payload = payload || {};
  payload.pin = S.pin;
  if (S.point) payload.point_id = S.point.id;
  return fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: action, payload: payload })
  }).then(function (r) { return r.json(); });
}

function initLogin() {
  fetch(API, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'points', payload: {} })
  }).then(function (r) { return r.json(); }).then(function (pts) {
    var sel = $('lpoint');
    sel.innerHTML = '<option value="">— выберите точку —</option>';
    for (var i = 0; i < pts.length; i++) {
      var o = document.createElement('option');
      o.value = pts[i].id;
      o.textContent = pts[i].name;
      sel.appendChild(o);
    }
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem('tandem_login') || 'null'); } catch (e) { saved = null; }
    if (saved && saved.point_id) { sel.value = saved.point_id; $('lpin').value = saved.pin || ''; }
  });
}

function doLogin(asOwner) {
  var pin = asOwner ? $('opin').value.trim() : $('lpin').value.trim();
  var pid = asOwner ? null : $('lpoint').value;
  if (!asOwner && !pid) { $('lerr').textContent = 'Выберите точку'; return; }
  if (!pin) { $('lerr').textContent = 'Введите код'; return; }
  S.pin = pin;
  fetch(API, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'login', payload: { pin: pin, point_id: pid } })
  }).then(function (r) { return r.json(); }).then(function (res) {
    if (!res.ok) { $('lerr').textContent = res.error || 'Не пустило'; $('oerr').textContent = res.error || 'Не пустило'; return; }
    S.role = res.role;
    if (res.role === 'owner') { showDash(); return; }
    if (res.role === 'driver') { showDriver(); return; }
    S.point = res.point; S.mode = res.point.mode;
    try { localStorage.setItem('tandem_login', JSON.stringify({ point_id: pid, pin: pin })); } catch (e) { }
    showForm();
  });
}

function logout() {
  S.role = null; S.point = null; S.pin = '';
  $('screen-login').hidden = false; $('screen-form').hidden = true;
  $('screen-dash').hidden = true; $('screen-driver').hidden = true;
}

function showForm() {
  $('screen-login').hidden = true; $('screen-form').hidden = false; $('screen-dash').hidden = true;
  $('fpoint').textContent = S.point.name;
  $('fmode').textContent = S.mode === 'takeout' ? 'заборный лист' :
    S.mode === 'position' ? 'продажи по позициям' :
    S.mode === 'import' ? 'загрузка листа продаж' : 'только суммы';
  $('date').value = today();
  $('block-takeout').hidden = (S.mode !== 'takeout');
  $('block-sales').hidden = (S.mode !== 'position' && S.mode !== 'import');
  $('block-import').hidden = (S.mode !== 'import');
  if (S.mode === 'import') mountImport();
  api('items', {}).then(function (r) {
    S.items = (r && r.items) ? r.items : [];
    for (var i = 0; i < S.items.length; i++) S.items[i]._n = norm(S.items[i].name) + ' ' + (S.items[i].artikul || '');
    if (S.mode === 'takeout') mountSearch('tq', 'thint', 'tres', addTakeout);
    if (S.mode === 'position') mountSearch('sq', 'shint', 'sres', addSale);
    drawFav();
    api('charts', {}).then(function (c) { S.charts = (c && c.ok) ? c.charts : null; drawRaw(); });
    loadReport();
  });
}

/* ── поиск по номенклатуре ───────────────────────────────────────────────
   Список позиций точки грузится один раз и ищется в браузере: у Енешки их
   больше четырёхсот, и запрос на каждую букву на плохой связи не годится. */
function norm(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function hl(name, words) {
  var out = esc(name);
  for (var i = 0; i < words.length; i++) {
    if (!words[i]) continue;
    var re = new RegExp('(' + words[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig');
    out = out.replace(re, '<b>$1</b>');
  }
  return out;
}
function findItems(q) {
  if (!q) return { list: S.items.slice(0, 40), words: [], all: S.items.length };
  var w = q.split(' ').filter(Boolean);
  var res = S.items.filter(function (m) {
    for (var i = 0; i < w.length; i++) { if (m._n.indexOf(w[i]) < 0) return false; }
    return true;
  });
  res.sort(function (a, b) { return a._n.indexOf(w[0]) - b._n.indexOf(w[0]); });
  return { list: res.slice(0, 60), words: w, all: res.length };
}
function mountSearch(inputId, hintId, resId, onPick) {
  var inp = $(inputId); if (!inp) return;
  function draw() {
    var q = norm(inp.value);
    var r = findItems(q);
    $(hintId).textContent = !q
      ? 'Показаны первые 40 из ' + S.items.length + '. Начните вводить название — список сузится.'
      : (r.all ? 'Найдено ' + r.all + (r.all > 60 ? ', показаны первые 60' : '')
        : 'Ничего не найдено. Попробуйте часть слова — «баур», «котлет».');
    var w = $(resId); w.innerHTML = '';
    for (var i = 0; i < r.list.length; i++) {
      var m = r.list[i];
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'sitem';
      b.innerHTML = '<span style="color:var(--ink);font-size:14px">' + hl(m.name, r.words) + '</span>' +
        '<span>' + esc(m.unit) + (m.price ? ' · ' + fmt(m.price) + ' ₸' : ' · без цены') + '</span>';
      (function (code) { b.onclick = function () { onPick(code); inp.value = ''; draw(); }; })(m.code);
      w.appendChild(b);
    }
  }
  inp.oninput = draw;
  inp.onfocus = draw;
  draw();
}

/* Частые позиции: сверху плитки, чтобы ходовое добавлялось без поиска.
   Порядок берётся из истории продаж iiko (поле rank), пока своей истории нет. */
function drawFav() {
  var isPos = S.mode === 'position';
  var box = $(isPos ? 'sfav' : 'tfav'); if (!box) return;
  var top = S.items.filter(function (m) { return m.rank; })
    .sort(function (a, b) { return a.rank - b.rank; }).slice(0, 12);
  box.innerHTML = '';
  if ($('sfavh')) $('sfavh').hidden = !(isPos && top.length);
  if (!top.length) return;
  for (var i = 0; i < top.length; i++) {
    var b = document.createElement('button');
    b.type = 'button'; b.textContent = top[i].name;
    (function (code) {
      b.onclick = function () { (isPos ? addSale : addTakeout)(code); };
    })(top[i].code);
    box.appendChild(b);
  }
}
function itemByCode(code) {
  for (var i = 0; i < S.items.length; i++) { if (S.items[i].code === code) return S.items[i]; }
  return null;
}

/* Расход сырья: по калькуляциям из iiko считаем, сколько продуктов должно было
   уйти на пробитое за смену. Это ответ на вопрос «спекли 200 пирожков — сколько
   ушло муки и мяса», и материал для сверки с фактическим списанием. */
function drawRaw() {
  var box = $('raw'), card = $('block-raw');
  if (!box || !card) return;
  if (!S.charts) { card.hidden = true; return; }

  var used = {};
  var lines = S.mode === 'takeout'
    ? S.takeout.map(function (t) { return { code: t.item_code, qty: soldOf(t) }; })
    : S.sales.map(function (s) { return { code: s.item_code, qty: num(s.qty) }; });

  var covered = 0, total = 0;
  for (var i = 0; i < lines.length; i++) {
    if (!(lines[i].qty > 0)) continue;
    total++;
    var chart = S.charts[lines[i].code];
    if (!chart) continue;
    covered++;
    for (var k = 0; k < chart.length; k++) {
      var n = chart[k].n;
      used[n] = (used[n] || 0) + Number(chart[k].a) * lines[i].qty;
    }
  }

  var names = Object.keys(used).sort(function (a, b) { return used[b] - used[a]; });
  if (!names.length) { card.hidden = true; return; }
  card.hidden = false;

  var html = '';
  for (var j = 0; j < names.length && j < 20; j++) {
    var v = used[names[j]];
    html += '<div class="rrow"><span>' + esc(names[j]) + '</span><b>' +
      (v < 1 ? (Math.round(v * 1000) / 1000) : fmt(Math.round(v * 100) / 100)) + '</b></div>';
  }
  if (names.length > 20) {
    html += '<div class="empty">и ещё ' + (names.length - 20) + ' позиций сырья</div>';
  }
  html += '<div class="hint" style="margin-top:10px">Карты нашлись у ' + covered + ' позиций из ' + total +
    '. Для остальных калькуляции в iiko пока нет.</div>';
  box.innerHTML = html;
}

function loadReport() {
  api('get_report', { date: $('date').value }).then(function (r) {
    S.expenses = r.expenses || []; S.takeout = r.takeout || []; S.sales = r.sales || [];
    // В строках продаж не хранится единица измерения — восстанавливаем из справочника,
    // иначе шаг «+/−» для килограммов станет штучным.
    for (var q = 0; q < S.sales.length; q++) {
      var ref = itemByCode(S.sales[q].item_code);
      if (ref) {
        S.sales[q].unit = ref.unit;
        if (!S.sales[q].price) S.sales[q].price = ref.price || '';
        if (S.sales[q].price_list === undefined || S.sales[q].price_list === null || S.sales[q].price_list === '') {
          S.sales[q].price_list = ref.price || '';
        }
      }
    }
    restoreDraft(!rep);
    var rep = r.report;
    var f = ['cash', 'kaspi_qr', 'transfer', 'qr_statement', 'tr_statement', 'cash_open', 'cash_handed', 'cash_counted'];
    for (var i = 0; i < f.length; i++) {
      $(f[i]).value = rep && rep[f[i]] !== null && rep[f[i]] !== undefined ? rep[f[i]] : '';
    }
    $('shift_by').value = rep && rep.shift_by ? rep.shift_by : '';
    $('comment').value = rep && rep.comment ? rep.comment : '';
    $('saved').textContent = rep ? 'Отчёт за этот день уже был сохранён — можно поправить' : '';
    // Восстанавливаем фасовку из справочника: в строках листа она не хранится.
    for (var z = 0; z < S.takeout.length; z++) {
      var rt = itemByCode(S.takeout[z].item_code);
      if (rt) {
        S.takeout[z].pack_factor = rt.pack_factor;
        S.takeout[z].pack_unit = rt.pack_unit;
        S.takeout[z].pack_price = rt.pack_price;
      }
    }
    if (S.mode === 'takeout') prefillShortList();
    drawExp(); drawTakeout(); drawSales(); recalc();
  });
}

function addExp() {
  S.expenses.push({ purpose: '', amount: '', receipt_no: '' });
  drawExp();
}
function drawExp() {
  var w = $('exp'); w.innerHTML = '';
  if (!S.expenses.length) { w.innerHTML = '<div class="empty">Расходов нет — и это правильно</div>'; recalc(); return; }
  for (var i = 0; i < S.expenses.length; i++) {
    var e = S.expenses[i];
    var row = document.createElement('div'); row.className = 'erow';
    row.innerHTML =
      '<input class="ep" placeholder="Кому и на что" value="' + String(e.purpose || '').replace(/"/g, '&quot;') + '">' +
      '<input class="ea" inputmode="decimal" placeholder="Сумма" value="' + (e.amount || '') + '">' +
      '<input class="er" placeholder="№ чека" value="' + (e.receipt_no || '') + '">' +
      '<button class="x" type="button">×</button>';
    (function (idx, row) {
      row.querySelector('.ep').oninput = function () { S.expenses[idx].purpose = this.value; };
      row.querySelector('.ea').oninput = function () { S.expenses[idx].amount = this.value; recalc(); };
      row.querySelector('.er').oninput = function () { S.expenses[idx].receipt_no = this.value; recalc(); };
      row.querySelector('.x').onclick = function () { S.expenses.splice(idx, 1); drawExp(); recalc(); };
    })(i, row);
    w.appendChild(row);
  }
  recalc();
}

function addTakeout(code) {
  if (!code) return;
  for (var i = 0; i < S.takeout.length; i++) {
    if (S.takeout[i].item_code === code) { flash('tk'); return; }
  }
  var it = itemByCode(code); if (!it) return;
  S.takeout.push({
    item_code: it.code, item_name: it.name, unit: it.unit,
    issued: '', returned: '', price: it.price || '',
    pack_factor: it.pack_factor, pack_unit: it.pack_unit, pack_price: it.pack_price
  });
  drawTakeout();
}

/* Короткий лист: то, что на точке реально идёт на раздачу.
   Подставляется сам, когда лист ещё пуст — кассиру не нужно ничего искать. */
function shortListItems() {
  return S.items.filter(function (m) { return m.short; })
    .sort(function (a, b) { return (a.rank || 999) - (b.rank || 999); });
}
function prefillShortList() {
  var list = shortListItems();
  if (!list.length || S.takeout.length) return;
  for (var i = 0; i < list.length; i++) addTakeout(list[i].code);
}

/* Сумма строки заборного листа. Если задана фасовка — продано пересчитывается
   в мелкие единицы: 4 литра компота при 5 стаканах в литре дают 20 стаканов. */
function soldOf(t) { return num(t.issued) - num(t.returned); }
function lineSmall(t) {
  var f = num(t.pack_factor);
  return f > 0 ? Math.round(soldOf(t) * f * 100) / 100 : null;
}
function lineSum(t) {
  var small = lineSmall(t);
  if (small !== null && num(t.pack_price) > 0) return small * num(t.pack_price);
  return soldOf(t) * num(t.price);
}
function flash(id) {
  var el = $(id); if (!el) return;
  el.style.transition = 'none'; el.style.background = '#FDF3C7';
  setTimeout(function () { el.style.transition = 'background .5s'; el.style.background = ''; }, 60);
}
function drawTakeout() {
  var w = $('tk'); if (!w) return;
  w.innerHTML = '';
  if (!S.takeout.length) { w.innerHTML = '<div class="empty">Добавьте позиции, которые сегодня выдавали на раздачу</div>'; return; }
  var head = document.createElement('div'); head.className = 'trow th';
  head.innerHTML = '<span class="tn">Позиция</span><span>Выдано</span><span>Остаток</span><span class="tp">Продано</span><span></span>';
  w.appendChild(head);
  for (var i = 0; i < S.takeout.length; i++) {
    var t = S.takeout[i];
    var sold = soldOf(t);
    var small = lineSmall(t);
    // Подпись под названием: единица, а при фасовке — во что и почём пересчитывается.
    var sub = esc(t.unit || '');
    if (small !== null) {
      sub += ' → ' + fmt(t.pack_factor) + ' ' + esc(t.pack_unit || 'шт') +
        (num(t.pack_price) > 0 ? ' по ' + fmt(t.pack_price) + ' ₸' : '');
    }
    var soldText = fmt(sold);
    if (small !== null) soldText += '<b>' + fmt(small) + ' ' + esc(t.pack_unit || 'шт') + '</b>';
    var row = document.createElement('div'); row.className = 'trow';
    row.innerHTML =
      '<span class="tn">' + esc(t.item_name) + '<i>' + sub + '</i></span>' +
      '<input class="ti" inputmode="decimal" value="' + (t.issued || '') + '">' +
      '<input class="tr" inputmode="decimal" value="' + (t.returned || '') + '">' +
      '<span class="tp' + (sold < 0 ? ' bad' : '') + '">' + soldText + '</span>' +
      '<button class="x" type="button">×</button>';
    (function (idx, row) {
      row.querySelector('.ti').oninput = function () { S.takeout[idx].issued = this.value; drawTakeout(); };
      row.querySelector('.tr').oninput = function () { S.takeout[idx].returned = this.value; drawTakeout(); };
      row.querySelector('.x').onclick = function () { S.takeout.splice(idx, 1); drawTakeout(); };
    })(i, row);
    w.appendChild(row);
  }
  if ($('ttotal')) $('ttotal').textContent = fmt(takeoutTotal()) + ' ₸';
  drawRaw();
  recalc();
}

/* Шаг количества: килограммы полкило, штучное — по одной. */
function step(unit) { return unit === 'кг' || unit === 'л' ? 0.5 : 1; }

function addSale(code) {
  if (!code) return;
  var it = itemByCode(code); if (!it) return;
  for (var i = 0; i < S.sales.length; i++) {
    if (S.sales[i].item_code === code) {
      S.sales[i].qty = num(S.sales[i].qty) + step(it.unit);
      drawSales(); flash('sl'); return;
    }
  }
  S.sales.push({
    item_code: it.code, item_name: it.name, unit: it.unit,
    qty: step(it.unit), price: it.price || '', price_list: it.price || ''
  });
  drawSales();
}
function chgSale(idx, d) {
  var s = S.sales[idx];
  var q = Math.round((num(s.qty) + d * step(s.unit)) * 100) / 100;
  if (q <= 0) { S.sales.splice(idx, 1); } else { s.qty = q; }
  drawSales();
}
function drawSales() {
  var w = $('sl'); if (!w) return;
  w.innerHTML = '';
  if (!S.sales.length) {
    w.innerHTML = '<div class="empty">Ничего не пробито. Найдите позицию выше или нажмите частую.</div>';
    if ($('stotal')) $('stotal').textContent = '0 ₸';
    drawRaw(); recalc(); return;
  }
  var sum = 0;
  for (var i = 0; i < S.sales.length; i++) {
    var s = S.sales[i];
    var line = num(s.qty) * num(s.price);
    sum += line;
    // Цена в строке редактируется: «часто сами цены говорят». Отличие от прайса
    // подсвечивается и считается скидкой — собственник видит её в сводке.
    var changed = s.price_list !== undefined && s.price_list !== '' &&
      num(s.price) !== num(s.price_list);
    var row = document.createElement('div'); row.className = 'srow';
    row.innerHTML =
      '<span class="sn">' + esc(s.item_name) +
      '<i>' + esc(s.unit || '') +
      (changed ? ' · по прайсу ' + fmt(s.price_list) + ' ₸' : '') + '</i></span>' +
      '<button class="pm minus" type="button">−</button>' +
      '<input class="sq" inputmode="decimal" value="' + (s.qty === '' ? '' : s.qty) + '">' +
      '<button class="pm plus" type="button">+</button>' +
      '<input class="sq sp' + (changed ? ' spc' : '') + '" inputmode="decimal" value="' + (s.price === '' ? '' : s.price) + '">' +
      '<button class="x" type="button">×</button>';
    (function (idx, row) {
      row.querySelector('.sq').oninput = function () { S.sales[idx].qty = this.value; drawSales(); };
      row.querySelector('.sp').oninput = function () { S.sales[idx].price = this.value; drawSales(); };
      row.querySelector('.minus').onclick = function () { chgSale(idx, -1); };
      row.querySelector('.plus').onclick = function () { chgSale(idx, +1); };
      row.querySelector('.x').onclick = function () { S.sales.splice(idx, 1); drawSales(); };
    })(i, row);
    w.appendChild(row);
  }
  if ($('stotal')) $('stotal').textContent = fmt(sum) + ' ₸';
  drawRaw();
  recalc();
}
function salesTotal() {
  var sum = 0;
  for (var i = 0; i < S.sales.length; i++) sum += num(S.sales[i].qty) * num(S.sales[i].price);
  return sum;
}
function takeoutTotal() {
  var sum = 0;
  for (var i = 0; i < S.takeout.length; i++) sum += lineSum(S.takeout[i]);
  return sum;
}


/* ── Черновик смены ──────────────────────────────────────────────────────
   Связь на точках нестабильная. Всё введённое пишется в localStorage и
   восстанавливается, если смена ещё не была сохранена на сервере. */
function draftKey() { return 'tandem_draft_' + (S.point ? S.point.id : '') + '_' + $('date').value; }
function saveDraft() {
  if (!S.point) return;
  try {
    var f = {};
    ['shift_by','cash','kaspi_qr','transfer','qr_statement','tr_statement',
     'cash_open','cash_handed','cash_counted','comment'].forEach(function (id) {
      var el = $(id); if (el) f[id] = el.value;
    });
    localStorage.setItem(draftKey(), JSON.stringify({
      t: Date.now(), fields: f, expenses: S.expenses, takeout: S.takeout, sales: S.sales
    }));
  } catch (e) { }
}
function restoreDraft(serverEmpty) {
  if (!S.point || !serverEmpty) return;
  var raw = null;
  try { raw = localStorage.getItem(draftKey()); } catch (e) { }
  if (!raw) return;
  try {
    var d = JSON.parse(raw);
    for (var id in (d.fields || {})) { var el = $(id); if (el && !el.value) el.value = d.fields[id]; }
    if (!S.expenses.length && d.expenses) S.expenses = d.expenses;
    if (!S.takeout.length && d.takeout) S.takeout = d.takeout;
    if (!S.sales.length && d.sales) S.sales = d.sales;
    $('savemsg').textContent = 'Восстановлен черновик — данные не потерялись';
  } catch (e) { }
}
function clearDraft() { try { localStorage.removeItem(draftKey()); } catch (e) { } }

/* ── «Как вчера» — заборный лист со вчерашними позициями ────────────── */
function likeYesterday() {
  var d = new Date($('date').value || today());
  d.setDate(d.getDate() - 1);
  var y = d.toISOString().slice(0, 10);
  api('get_report', { date: y }).then(function (r) {
    var rows = (r && r.takeout) || [];
    if (!rows.length) { $('savemsg').textContent = 'За вчера заборного листа нет'; return; }
    var added = 0;
    for (var i = 0; i < rows.length; i++) {
      var exists = S.takeout.some(function (t) { return t.item_code === rows[i].item_code; });
      if (exists) continue;
      var ref = itemByCode(rows[i].item_code) || {};
      S.takeout.push({
        item_code: rows[i].item_code, item_name: rows[i].item_name,
        unit: rows[i].unit || ref.unit || 'шт', issued: '', returned: '',
        price: ref.price || rows[i].price || '',
        pack_factor: ref.pack_factor, pack_unit: ref.pack_unit, pack_price: ref.pack_price
      });
      added++;
    }
    drawTakeout();
    $('savemsg').textContent = added ? 'Подставлено вчерашних позиций: ' + added : 'Все вчерашние позиции уже в листе';
  });
}

/* ── Импорт листа продаж (Актау) ─────────────────────────────────────────
   Формат заводской программы: лист TDSheet, «Сводка по товарообороту»:
   название | цена | количество | сумма полная | сумма со скидкой.
   Названия чужие — сопоставляются с номенклатурой один раз, карта хранится. */
var IMP = { rows: [], aliases: {}, xlsxReady: false };

function mountImport() {
  if (!IMP.mounted) {
    IMP.mounted = true;
    $('impfile').onchange = handleImportFile;
    $('impapply').onclick = applyImport;
  }
  api('aliases', {}).then(function (r) { if (r && r.ok) IMP.aliases = r.aliases || {}; });
}

function loadXlsxLib() {
  return new Promise(function (resolve, reject) {
    if (window.XLSX) return resolve();
    var sc = document.createElement('script');
    sc.src = 'vendor/xlsx.full.min.js';
    sc.onload = resolve;
    sc.onerror = function () { reject(new Error('Не удалось загрузить обработчик Excel')); };
    document.head.appendChild(sc);
  });
}

function normAlias(t) {
  return String(t || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

function handleImportFile() {
  var f = $('impfile').files[0];
  if (!f) return;
  $('impstatus').textContent = 'Читаю файл…';
  loadXlsxLib().then(function () {
    var rd = new FileReader();
    rd.onload = function () {
      try {
        var wb = XLSX.read(new Uint8Array(rd.result), { type: 'array' });
        var ws = wb.Sheets['TDSheet'] || wb.Sheets[wb.SheetNames[0]];
        var arr = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        parseFactoryRows(arr);
      } catch (e) {
        $('impstatus').textContent = 'Не получилось разобрать файл: ' + e.message;
      }
    };
    rd.readAsArrayBuffer(f);
  }).catch(function (e) { $('impstatus').textContent = e.message; });
}

function parseFactoryRows(arr) {
  IMP.rows = [];
  for (var i = 0; i < arr.length; i++) {
    var r = arr[i];
    var name = String(r[0] || '').trim();
    var price = num(r[1]), qty = num(r[2]), sumFull = num(r[3]), sumDisc = num(r[4]);
    // строка данных: есть название, количество и хотя бы одна сумма;
    // шапки и итог (без названия) отсеиваются сами
    if (!name || !(qty > 0) || !(sumFull > 0)) continue;
    if (/^вид номенклатуры|^сводка|^итого/i.test(name)) continue;
    IMP.rows.push({
      name: name, qty: qty,
      price_list: price || (qty ? sumFull / qty : 0),
      price: qty ? (sumDisc || sumFull) / qty : 0,
      code: IMP.aliases[normAlias(name)] || matchByName(name) || ''
    });
  }
  drawImportMap();
}

function matchByName(name) {
  var n = normAlias(name);
  for (var i = 0; i < S.items.length; i++) {
    if (normAlias(S.items[i].name) === n) return S.items[i].code;
  }
  return '';
}

function drawImportMap() {
  var w = $('impmap'); w.innerHTML = '';
  var matched = 0, unmatched = 0;
  IMP.rows.forEach(function (r) { r.code ? matched++ : unmatched++; });
  $('impstatus').textContent = 'Строк: ' + IMP.rows.length + ' · распознано: ' + matched +
    (unmatched ? ' · требуют сопоставления: ' + unmatched : '');
  if (!IMP.rows.length) { $('impapply').hidden = true; return; }

  IMP.rows.forEach(function (r, idx) {
    var row = document.createElement('div');
    row.className = 'irow' + (r.code ? '' : ' miss');
    var right = r.code
      ? '<span class="iok">' + esc((itemByCode(r.code) || {}).name || r.code) + '</span>'
      : '<input class="ialias" placeholder="Найти в номенклатуре" list="impdl">';
    row.innerHTML =
      '<span class="iname">' + esc(r.name) + '<i>' + fmt(r.qty) + ' × ' + fmt(r.price) + ' ₸</i></span>' + right;
    if (!r.code) {
      var inp = row.querySelector('.ialias');
      inp.oninput = function () {
        var q = norm(this.value);
        if (q.length < 2) return;
        var hit = S.items.filter(function (m) { return m._n.indexOf(q) >= 0; });
        if (hit.length === 1 || (hit.length && norm(hit[0].name) === q)) {
          IMP.rows[idx].code = hit[0].code;
          IMP.newAliases = IMP.newAliases || [];
          IMP.newAliases.push({ alias: normAlias(IMP.rows[idx].name), code: hit[0].code });
          drawImportMap();
        }
      };
    }
    w.appendChild(row);
  });

  // подсказки для ручного сопоставления
  if (!document.getElementById('impdl')) {
    var dl = document.createElement('datalist');
    dl.id = 'impdl';
    S.items.forEach(function (m) {
      var o = document.createElement('option'); o.value = m.name; dl.appendChild(o);
    });
    document.body.appendChild(dl);
  }
  $('impapply').hidden = false;
  $('impapply').textContent = 'Добавить в отчёт (' + matched + ' из ' + IMP.rows.length + ')';
}

function applyImport() {
  var added = 0;
  IMP.rows.forEach(function (r) {
    if (!r.code) return;
    var it = itemByCode(r.code); if (!it) return;
    var exists = S.sales.some(function (x) { return x.item_code === r.code; });
    if (exists) return;
    S.sales.push({
      item_code: r.code, item_name: it.name, unit: it.unit,
      qty: r.qty, price: Math.round(r.price * 100) / 100,
      price_list: Math.round(r.price_list * 100) / 100
    });
    added++;
  });
  drawSales();
  if (IMP.newAliases && IMP.newAliases.length) {
    api('save_aliases', { data: IMP.newAliases });
    IMP.newAliases = [];
  }
  $('impstatus').textContent = 'В отчёт добавлено позиций: ' + added + '. Проверьте сумму и сохраните отчёт.';
}

/* ── Экран водителя: реализация и долги ────────────────────────────── */
function showDriver() {
  $('screen-login').hidden = true; $('screen-form').hidden = true;
  $('screen-dash').hidden = true; $('screen-driver').hidden = false;
  $('rdate').value = today();
  loadRealization();
}
function loadRealization() {
  api('realization', { op: 'list' }).then(function (r) {
    if (!r.ok) { $('rdebts').innerHTML = '<div class="empty">' + esc(r.error || 'нет доступа') + '</div>'; return; }
    var sel = $('rclient'); sel.innerHTML = '';
    var w = $('rdebts'); w.innerHTML = '';
    (r.clients || []).forEach(function (c) {
      var o = document.createElement('option');
      o.value = c.id; o.textContent = c.name;
      sel.appendChild(o);
      var d = document.createElement('div');
      d.className = 'rrow';
      d.innerHTML = '<span>' + esc(c.name) + '</span><b style="' +
        (num(c.debt) > 100000 ? 'color:var(--bad)' : num(c.debt) > 0 ? 'color:var(--warn)' : 'color:var(--ok)') +
        '">' + fmt(c.debt) + ' ₸</b>';
      w.appendChild(d);
    });
    var b = $('rbody'); b.innerHTML = '';
    (r.recent || []).forEach(function (x) {
      var tr = document.createElement('tr');
      tr.innerHTML = '<td>' + esc(x.date) + '</td><td>' + esc(x.client) + '</td>' +
        '<td class="n">' + fmt(x.delivered) + '</td><td class="n">' + fmt(x.paid) + '</td>' +
        '<td class="n">' + fmt(x.returned) + '</td><td>' + esc(x.note || '') + '</td>';
      b.appendChild(tr);
    });
    if (!(r.recent || []).length) b.innerHTML = '<tr><td colspan="6" class="empty">Записей пока нет</td></tr>';
  });
}
function saveRealization() {
  var deliv = num($('rdeliv').value), paid = num($('rpaid').value), ret = num($('rret').value);
  if (deliv === 0 && paid === 0 && ret === 0) { $('rmsg').textContent = 'Введите хотя бы одну сумму'; return; }
  $('rsave').disabled = true;
  api('realization', {
    op: 'add',
    data: { client_id: $('rclient').value, date: $('rdate').value,
            delivered: deliv, paid: paid, returned: ret, note: $('rnote').value }
  }).then(function (r) {
    $('rsave').disabled = false;
    if (!r.ok) { $('rmsg').textContent = r.error || 'Не сохранилось'; return; }
    $('rdeliv').value = ''; $('rpaid').value = ''; $('rret').value = ''; $('rnote').value = '';
    $('rmsg').textContent = 'Записано';
    loadRealization();
  });
}

function recalc() {
  var cash = num($('cash').value), qr = num($('kaspi_qr').value), tr = num($('transfer').value);
  var total = cash + qr + tr;
  $('total').textContent = fmt(total) + ' ₸';

  var pod = 0, noReceipt = 0;
  for (var i = 0; i < S.expenses.length; i++) {
    pod += num(S.expenses[i].amount);
    if (num(S.expenses[i].amount) > 0 && !String(S.expenses[i].receipt_no || '').trim()) noReceipt++;
  }
  $('podotchet').textContent = fmt(pod) + ' ₸';

  var expected = num($('cash_open').value) + cash - num($('cash_handed').value) - pod;
  $('cash_expected').textContent = fmt(expected) + ' ₸';

  var checks = [];
  var qs = $('qr_statement').value, ts = $('tr_statement').value, cc = $('cash_counted').value;
  if (qs === '' && ts === '') {
    checks.push(['wait', 'Сверка с выписками не заполнена']);
  } else {
    var dq = qs === '' ? 0 : qr - num(qs);
    var dt = ts === '' ? 0 : tr - num(ts);
    if (dq === 0 && dt === 0) checks.push(['ok', 'Выручка сходится с выписками']);
    else checks.push(['bad', 'Расхождение с выписками: QR ' + fmt(dq) + ', переводы ' + fmt(dt)]);
  }
  if (cc === '') checks.push(['wait', 'Касса не пересчитана']);
  else {
    var dc = expected - num(cc);
    if (dc === 0) checks.push(['ok', 'Касса сходится']);
    else checks.push(['bad', 'Расхождение по кассе: ' + fmt(dc) + ' ₸']);
  }
  if (noReceipt > 0) checks.push(['bad', 'Строк подотчёта без номера чека: ' + noReceipt]);
  else if (pod > 0) checks.push(['ok', 'Подотчёт подтверждён чеками']);

  // Сверка ассортимента с деньгами — до сохранения, чтобы кассир увидел сразу.
  var byItems = S.mode === 'position' ? salesTotal() : (S.mode === 'takeout' ? takeoutTotal() : 0);
  var label = S.mode === 'position' ? 'позициям' : 'заборному листу';
  if (S.mode === 'position' || S.mode === 'takeout') {
    if (byItems === 0) {
      checks.push(['wait', 'По ' + label + ' пока ничего не внесено']);
    } else if (total === 0) {
      checks.push(['wait', 'Выручка не заполнена — сверить не с чем']);
    } else {
      var d = byItems - total;
      var pct = Math.abs(d) / total * 100;
      if (pct < 0.5) checks.push(['ok', 'Сумма по ' + label + ' сходится с выручкой']);
      else checks.push([pct <= 5 ? 'wait' : 'bad',
        'По ' + label + ' ' + fmt(byItems) + ' ₸, в кассе ' + fmt(total) +
        ' ₸ — расхождение ' + fmt(d) + ' ₸ (' + (Math.round(pct * 10) / 10) + ' %)']);
    }
  }

  saveDraft();
  var w = $('checks'); w.innerHTML = '';
  for (var k = 0; k < checks.length; k++) {
    var d = document.createElement('div');
    d.className = 'chk ' + checks[k][0];
    d.textContent = checks[k][1];
    w.appendChild(d);
  }
}

function saveReport() {
  var p = {
    date: $('date').value,
    shift_by: $('shift_by').value,
    cash: num($('cash').value), kaspi_qr: num($('kaspi_qr').value), transfer: num($('transfer').value),
    qr_statement: $('qr_statement').value, tr_statement: $('tr_statement').value,
    cash_open: num($('cash_open').value), cash_handed: num($('cash_handed').value),
    cash_counted: $('cash_counted').value,
    comment: $('comment').value,
    expenses: S.expenses, takeout: S.takeout, sales: S.sales
  };
  $('savebtn').disabled = true;
  $('savemsg').textContent = 'Сохраняю…';
  api('save_report', p).then(function (r) {
    $('savebtn').disabled = false;
    if (!r.ok) { $('savemsg').textContent = 'Ошибка: ' + (r.error || 'не сохранилось'); return; }
    clearDraft();
    $('savemsg').textContent = 'Отчёт сохранён ' + new Date().toLocaleTimeString('ru-RU');
    $('saved').textContent = 'Отчёт за этот день уже был сохранён — можно поправить';
  });
}

function showDash() {
  $('screen-login').hidden = true; $('screen-form').hidden = true;
  $('screen-driver').hidden = true; $('screen-dash').hidden = false;
  setPeriod('week');
}

/* Быстрые периоды: сегодня, вчера, неделя, месяц. Произвольный — через поля С/По. */
function setPeriod(per) {
  var to = new Date(), from = new Date();
  if (per === 'yesterday') { from.setDate(from.getDate() - 1); to = new Date(from); }
  if (per === 'week') from.setDate(from.getDate() - 6);
  if (per === 'month') from.setDate(from.getDate() - 29);
  $('dfrom').value = from.toISOString().slice(0, 10);
  $('dto').value = to.toISOString().slice(0, 10);
  markPeriod(per);
  loadDash();
}
function markPeriod(per) {
  var bs = document.querySelectorAll('.dper');
  for (var i = 0; i < bs.length; i++) bs[i].classList.toggle('on', bs[i].dataset.per === per);
}
function loadDash() {
  api('dashboard', { from: $('dfrom').value, to: $('dto').value }).then(function (r) {
    if (!r.ok) { $('dbody').innerHTML = '<tr><td colspan="9">' + (r.error || 'нет доступа') + '</td></tr>'; return; }
    S.dash = r;
    var rows = r.rows || [];
    var byPoint = {}, tot = 0, totPod = 0, flags = 0;
    // Сколько дней в периоде — чтобы посчитать несданные отчёты по каждой точке
    var dFrom = new Date($('dfrom').value), dTo = new Date($('dto').value);
    var periodDays = Math.max(1, Math.round((Math.min(dTo, new Date()) - dFrom) / 86400000) + 1);
    for (var i = 0; i < rows.length; i++) {
      var x = rows[i];
      tot += num(x.revenue_total); totPod += num(x.podotchet);
      var diffSum = Math.abs(num(x.diff_qr)) + Math.abs(num(x.diff_transfer)) + Math.abs(num(x.diff_cash));
      var bad = diffSum > 0 || num(x.expenses_no_receipt) > 0;
      if (bad) flags++;
      if (!byPoint[x.point_name]) byPoint[x.point_name] = { rev: 0, days: 0, badDays: 0, diff: 0 };
      byPoint[x.point_name].rev += num(x.revenue_total);
      byPoint[x.point_name].days++;
      if (bad) byPoint[x.point_name].badDays++;
      byPoint[x.point_name].diff += diffSum;
    }
    // точки без единого отчёта тоже должны быть видны
    (r.points || []).forEach(function (p) {
      if (!byPoint[p.name]) byPoint[p.name] = { rev: 0, days: 0, badDays: 0, diff: 0 };
    });
    $('k1').textContent = fmt(tot) + ' ₸';
    $('k2').textContent = rows.length;
    $('k3').textContent = fmt(totPod) + ' ₸';
    $('k4').textContent = flags;
    $('k4').className = 'kv' + (flags ? ' bad' : ' ok');

    var pb = $('pbody'); pb.innerHTML = '';
    var names = Object.keys(byPoint).sort(function (a, b) { return byPoint[b].rev - byPoint[a].rev; });
    if (!names.length) pb.innerHTML = '<tr><td colspan="7" class="empty">Отчётов пока нет</td></tr>';
    for (var n = 0; n < names.length; n++) {
      var p = byPoint[names[n]];
      var missed = Math.max(0, periodDays - p.days);
      var tr2 = document.createElement('tr');
      tr2.innerHTML = '<td>' + names[n] + '</td><td class="n b">' + fmt(p.rev) + '</td>' +
        '<td class="n">' + p.days + '</td>' +
        '<td class="n">' + (missed ? '<span style="color:var(--bad);font-weight:700">' + missed + '</span>' : '0') + '</td>' +
        '<td class="n">' + fmt(p.days ? p.rev / p.days : 0) + '</td>' +
        '<td class="n">' + (p.badDays ? '<span style="color:var(--warn);font-weight:700">' + p.badDays + '</span>' : '—') + '</td>' +
        '<td class="n">' + (p.diff ? '<span style="color:var(--bad)">' + fmt(p.diff) + '</span>' : '—') + '</td>';
      pb.appendChild(tr2);
    }

    // ── Не сдали за вчера ──
    var mis = r.missing || [];
    $('dmissing-card').hidden = !mis.length;
    if (mis.length) {
      $('dmissing').innerHTML = mis.map(function (m) {
        return '<span class="pill bad" style="margin:0 6px 6px 0">' + m.name + '</span>';
      }).join('');
    }

    // ── Каналы и юрлица ──
    var ch = r.channels || {};
    var chTotal = num(ch.cash) + num(ch.kaspi_qr) + num(ch.transfer);
    var chHtml = '';
    [['Наличные', ch.cash], ['Kaspi QR', ch.kaspi_qr], ['Перевод на счёт', ch.transfer]].forEach(function (c) {
      var share = chTotal ? Math.round(num(c[1]) / chTotal * 100) : 0;
      chHtml += '<div class="rrow"><span>' + c[0] + '</span><b>' + fmt(c[1]) + ' ₸ · ' + share + ' %</b></div>';
    });
    (r.by_legal || []).forEach(function (l) {
      chHtml += '<div class="rrow"><span style="color:var(--muted)">' + l.legal + '</span><b>' + fmt(l.revenue) + ' ₸</b></div>';
    });
    $('dchannels').innerHTML = chHtml || '<div class="empty">Отчётов за период нет</div>';

    // ── Топ позиций ──
    var tb = $('dtop'); tb.innerHTML = '';
    (r.top_items || []).forEach(function (t) {
      var tr = document.createElement('tr');
      tr.innerHTML = '<td>' + t.name + '</td><td class="n">' + fmt(t.qty) + '</td>' +
        '<td class="n b">' + fmt(t.amount) + '</td>' +
        '<td class="n">' + (num(t.discount) > 0 ? '<span style="color:var(--warn)">' + fmt(t.discount) + '</span>' : '—') + '</td>';
      tb.appendChild(tr);
    });
    if (!(r.top_items || []).length) tb.innerHTML = '<tr><td colspan="4" class="empty">Позиционных данных за период нет</td></tr>';

    // ── Расход сырья ──
    $('draw').innerHTML = (r.raw_usage || []).length
      ? r.raw_usage.map(function (u) {
          return '<div class="rrow"><span>' + u.name + '</span><b>' + fmt(u.amount) + ' кг</b></div>';
        }).join('')
      : '<div class="empty">Продаж с техкартами за период нет</div>';

    // ── Долги по реализации ──
    $('ddebts').innerHTML = (r.realization || []).length
      ? r.realization.map(function (d) {
          return '<div class="rrow"><span>' + d.name + '</span><b style="' +
            (num(d.debt) > 100000 ? 'color:var(--bad)' : 'color:var(--warn)') + '">' + fmt(d.debt) + ' ₸</b></div>';
        }).join('')
      : '<div class="empty">Долгов нет</div>';

    var b = $('dbody'); b.innerHTML = '';
    if (!rows.length) { b.innerHTML = '<tr><td colspan="9" class="empty">Отчётов за период нет</td></tr>'; return; }
    for (var j = 0; j < rows.length; j++) {
      var y = rows[j];
      var issues = [];
      if (y.diff_qr !== null && num(y.diff_qr) !== 0) issues.push('QR ' + fmt(y.diff_qr));
      if (y.diff_transfer !== null && num(y.diff_transfer) !== 0) issues.push('перевод ' + fmt(y.diff_transfer));
      if (y.diff_cash !== null && num(y.diff_cash) !== 0) issues.push('касса ' + fmt(y.diff_cash));
      if (num(y.expenses_no_receipt) > 0) issues.push('без чека: ' + y.expenses_no_receipt);
      if (y.qr_statement === null && y.tr_statement === null) issues.push('нет сверки');
      var trr = document.createElement('tr');
      trr.style.cursor = 'pointer';
      trr.innerHTML = '<td>' + y.report_date + '</td><td>' + y.point_name + '</td>' +
        '<td class="n">' + fmt(y.cash) + '</td><td class="n">' + fmt(y.kaspi_qr) + '</td>' +
        '<td class="n">' + fmt(y.transfer) + '</td><td class="n b">' + fmt(y.revenue_total) + '</td>' +
        '<td class="n">' + fmt(y.cash_handed) + '</td><td class="n">' + fmt(y.podotchet) + '</td>' +
        '<td>' + (issues.length ? '<span class="pill bad">' + issues.join(' · ') + '</span>' : '<span class="pill ok">ОК</span>') + '</td>';
      (function (row, tr) { tr.onclick = function () { toggleReportDetail(tr, row); }; })(y, trr);
      b.appendChild(trr);
    }
  });
}

/* Раскрытие отчёта прямо в сводке: собственник видит весь день точки,
   не выходя из дашборда, — позиции, заборный лист, расходы, комментарий. */
function toggleReportDetail(tr, row) {
  var next = tr.nextElementSibling;
  if (next && next.className === 'detail-row') { next.remove(); return; }
  var open = tr.parentNode.querySelector('.detail-row');
  if (open) open.remove();

  var dtr = document.createElement('tr');
  dtr.className = 'detail-row';
  dtr.innerHTML = '<td colspan="9" style="background:#F7F9FC;padding:14px 16px">Загружаю отчёт…</td>';
  tr.parentNode.insertBefore(dtr, tr.nextSibling);

  fetch(API, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'get_report', payload: { pin: S.pin, point_id: row.point_id, date: row.report_date } })
  }).then(function (r) { return r.json(); }).then(function (d) {
    var html = '<td colspan="9" style="background:#F7F9FC;padding:14px 16px">';
    var sl = d.sales || [], tk = d.takeout || [], ex = d.expenses || [];

    if (sl.length) {
      html += '<b style="font-size:12px;text-transform:uppercase;color:var(--muted)">Продажи по позициям (' + sl.length + ')</b>';
      var sTot = 0, sDisc = 0;
      html += '<div style="margin:6px 0 12px">';
      sl.forEach(function (x) {
        var line = num(x.qty) * num(x.price); sTot += line;
        var disc = num(x.price_list) > num(x.price) ? num(x.qty) * (num(x.price_list) - num(x.price)) : 0;
        sDisc += disc;
        html += '<div class="rrow"><span>' + x.item_name + ' × ' + fmt(x.qty) +
          (disc ? ' <span style="color:var(--warn)">(скидка ' + fmt(disc) + ')</span>' : '') +
          '</span><b>' + fmt(line) + ' ₸</b></div>';
      });
      html += '<div class="rrow"><span><b>Итого по позициям</b>' +
        (sDisc ? ' · скидок на ' + fmt(sDisc) + ' ₸' : '') + '</span><b>' + fmt(sTot) + ' ₸</b></div></div>';
    }
    if (tk.length) {
      html += '<b style="font-size:12px;text-transform:uppercase;color:var(--muted)">Заборный лист (' + tk.length + ')</b>';
      var tTot = 0;
      html += '<div style="margin:6px 0 12px">';
      tk.forEach(function (x) {
        var sold = num(x.issued) - num(x.returned);
        var line = sold * num(x.price); tTot += line;
        html += '<div class="rrow"><span>' + x.item_name + ': выдано ' + fmt(x.issued) +
          ', остаток ' + fmt(x.returned) + ' → продано ' + fmt(sold) + '</span><b>' + fmt(line) + ' ₸</b></div>';
      });
      html += '<div class="rrow"><span><b>Итого по листу</b></span><b>' + fmt(tTot) + ' ₸</b></div></div>';
    }
    if (ex.length) {
      html += '<b style="font-size:12px;text-transform:uppercase;color:var(--muted)">Расходы под отчёт</b>';
      html += '<div style="margin:6px 0 12px">';
      ex.forEach(function (x) {
        html += '<div class="rrow"><span>' + (x.purpose || '—') +
          (x.receipt_no ? ' · чек № ' + x.receipt_no : ' · <span style="color:var(--bad)">без чека</span>') +
          '</span><b>' + fmt(x.amount) + ' ₸</b></div>';
      });
      html += '</div>';
    }
    var rep = d.report || {};
    html += '<b style="font-size:12px;text-transform:uppercase;color:var(--muted)">Деньги</b><div style="margin:6px 0 0">';
    html += '<div class="rrow"><span>Сдал: ' + (rep.shift_by || '—') + '</span><span></span></div>';
    html += '<div class="rrow"><span>Касса: должно ' + fmt(rep.cash_expected) + ' ₸, пересчитано ' +
      (rep.cash_counted === null || rep.cash_counted === undefined ? 'не пересчитана' : fmt(rep.cash_counted) + ' ₸') + '</span>' +
      (num(rep.diff_cash) !== 0 && rep.diff_cash !== null ? '<b style="color:var(--bad)">' + fmt(rep.diff_cash) + ' ₸</b>' : '<b style="color:var(--ok)">ок</b>') + '</div>';
    if (rep.comment) html += '<div class="rrow"><span>Комментарий: ' + rep.comment + '</span><span></span></div>';
    html += '</div>';
    if (!sl.length && !tk.length && !ex.length) {
      html += '<div class="hint">Позиций в этом отчёте нет — точка сдала только суммы.</div>';
    }
    html += '</td>';
    dtr.innerHTML = html;
  }).catch(function () {
    dtr.innerHTML = '<td colspan="9" style="padding:14px 16px;color:var(--bad)">Не удалось загрузить отчёт</td>';
  });
}

function exportCsv() {
  if (!S.dash || !S.dash.rows) return;
  var rows = S.dash.rows;
  var head = ['Дата', 'Точка', 'Наличные', 'Kaspi QR', 'Перевод', 'Итого', 'Сдано', 'Подотчёт', 'Расх. QR', 'Расх. перевод', 'Расх. касса'];
  var lines = [head.join(';')];
  for (var i = 0; i < rows.length; i++) {
    var x = rows[i];
    lines.push([x.report_date, x.point_name, x.cash, x.kaspi_qr, x.transfer, x.revenue_total,
    x.cash_handed, x.podotchet, x.diff_qr === null ? '' : x.diff_qr,
    x.diff_transfer === null ? '' : x.diff_transfer,
    x.diff_cash === null ? '' : x.diff_cash].join(';'));
  }
  var blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'tandem_otchety.csv';
  a.click();
}

window.addEventListener('DOMContentLoaded', function () {
  initLogin();
  $('btn-login').onclick = function () { doLogin(false); };
  $('btn-owner').onclick = function () { doLogin(true); };
  $('btn-owner-toggle').onclick = function () { $('ownerbox').hidden = !$('ownerbox').hidden; };
  $('date').onchange = loadReport;
  $('addexp').onclick = addExp;
  $('savebtn').onclick = saveReport;
  $('logout').onclick = logout;
  $('logout2').onclick = logout;
  $('logout3').onclick = logout;
  $('likeyesterday').onclick = likeYesterday;
  $('rsave').onclick = saveRealization;
  $('dreload').onclick = function () { markPeriod(''); loadDash(); };
  (function () {
    var bs = document.querySelectorAll('.dper');
    for (var i = 0; i < bs.length; i++) {
      bs[i].onclick = (function (b) { return function () { setPeriod(b.dataset.per); }; })(bs[i]);
    }
  })();
  $('dcsv').onclick = exportCsv;
  var ids = ['cash', 'kaspi_qr', 'transfer', 'qr_statement', 'tr_statement', 'cash_open', 'cash_handed', 'cash_counted'];
  for (var i = 0; i < ids.length; i++) { $(ids[i]).oninput = recalc; }
});
