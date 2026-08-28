const API = "https://qeehxcnnuzuwskznhdyg.supabase.co/functions/v1/uchet";

var S = {
  role: null, point: null, pin: '', items: [], mode: null,
  expenses: [], takeout: [], sales: [], dash: null
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
    S.point = res.point; S.mode = res.point.mode;
    try { localStorage.setItem('tandem_login', JSON.stringify({ point_id: pid, pin: pin })); } catch (e) { }
    showForm();
  });
}

function logout() {
  S.role = null; S.point = null; S.pin = '';
  $('screen-login').hidden = false; $('screen-form').hidden = true; $('screen-dash').hidden = true;
}

function showForm() {
  $('screen-login').hidden = true; $('screen-form').hidden = false; $('screen-dash').hidden = true;
  $('fpoint').textContent = S.point.name;
  $('fmode').textContent = S.mode === 'takeout' ? 'заборный лист' :
    (S.mode === 'position' ? 'продажи по позициям' : 'только суммы');
  $('date').value = today();
  $('block-takeout').hidden = (S.mode !== 'takeout');
  $('block-sales').hidden = (S.mode !== 'position');
  api('items', {}).then(function (r) {
    S.items = (r && r.items) ? r.items : [];
    for (var i = 0; i < S.items.length; i++) S.items[i]._n = norm(S.items[i].name);
    if (S.mode === 'takeout') mountSearch('tq', 'thint', 'tres', addTakeout);
    if (S.mode === 'position') mountSearch('sq', 'shint', 'sres', addSale);
    drawFav();
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
      }
    }
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
    qty: step(it.unit), price: it.price || ''
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
    recalc(); return;
  }
  var sum = 0;
  for (var i = 0; i < S.sales.length; i++) {
    var s = S.sales[i];
    var line = num(s.qty) * num(s.price);
    sum += line;
    var row = document.createElement('div'); row.className = 'srow';
    row.innerHTML =
      '<span class="sn">' + esc(s.item_name) +
      '<i>' + esc(s.unit || '') + (s.price ? ' · ' + fmt(s.price) + ' ₸' : ' · цены нет') + '</i></span>' +
      '<button class="pm minus" type="button">−</button>' +
      '<input class="sq" inputmode="decimal" value="' + (s.qty === '' ? '' : s.qty) + '">' +
      '<button class="pm plus" type="button">+</button>' +
      '<span class="ssum">' + fmt(line) + '</span>' +
      '<button class="x" type="button">×</button>';
    (function (idx, row) {
      row.querySelector('.sq').oninput = function () { S.sales[idx].qty = this.value; drawSales(); };
      row.querySelector('.minus').onclick = function () { chgSale(idx, -1); };
      row.querySelector('.plus').onclick = function () { chgSale(idx, +1); };
      row.querySelector('.x').onclick = function () { S.sales.splice(idx, 1); drawSales(); };
    })(i, row);
    w.appendChild(row);
  }
  if ($('stotal')) $('stotal').textContent = fmt(sum) + ' ₸';
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
    $('savemsg').textContent = 'Отчёт сохранён ' + new Date().toLocaleTimeString('ru-RU');
    $('saved').textContent = 'Отчёт за этот день уже был сохранён — можно поправить';
  });
}

function showDash() {
  $('screen-login').hidden = true; $('screen-form').hidden = true; $('screen-dash').hidden = false;
  var d = new Date(); d.setDate(d.getDate() - 30);
  $('dfrom').value = d.toISOString().slice(0, 10);
  $('dto').value = today();
  loadDash();
}
function loadDash() {
  api('dashboard', { from: $('dfrom').value, to: $('dto').value }).then(function (r) {
    if (!r.ok) { $('dbody').innerHTML = '<tr><td colspan="9">' + (r.error || 'нет доступа') + '</td></tr>'; return; }
    S.dash = r;
    var rows = r.rows || [];
    var byPoint = {}, tot = 0, totPod = 0, flags = 0;
    for (var i = 0; i < rows.length; i++) {
      var x = rows[i];
      tot += num(x.revenue_total); totPod += num(x.podotchet);
      var bad = (x.diff_qr !== null && num(x.diff_qr) !== 0) ||
        (x.diff_transfer !== null && num(x.diff_transfer) !== 0) ||
        (x.diff_cash !== null && num(x.diff_cash) !== 0) ||
        num(x.expenses_no_receipt) > 0;
      if (bad) flags++;
      if (!byPoint[x.point_name]) byPoint[x.point_name] = { rev: 0, days: 0 };
      byPoint[x.point_name].rev += num(x.revenue_total);
      byPoint[x.point_name].days++;
    }
    $('k1').textContent = fmt(tot) + ' ₸';
    $('k2').textContent = rows.length;
    $('k3').textContent = fmt(totPod) + ' ₸';
    $('k4').textContent = flags;
    $('k4').className = 'kv' + (flags ? ' bad' : ' ok');

    var pb = $('pbody'); pb.innerHTML = '';
    var names = Object.keys(byPoint).sort(function (a, b) { return byPoint[b].rev - byPoint[a].rev; });
    if (!names.length) pb.innerHTML = '<tr><td colspan="4" class="empty">Отчётов пока нет</td></tr>';
    for (var n = 0; n < names.length; n++) {
      var p = byPoint[names[n]];
      var tr2 = document.createElement('tr');
      tr2.innerHTML = '<td>' + names[n] + '</td><td class="n">' + fmt(p.rev) + '</td>' +
        '<td class="n">' + p.days + '</td><td class="n">' + fmt(p.rev / (p.days || 1)) + '</td>';
      pb.appendChild(tr2);
    }

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
      trr.innerHTML = '<td>' + y.report_date + '</td><td>' + y.point_name + '</td>' +
        '<td class="n">' + fmt(y.cash) + '</td><td class="n">' + fmt(y.kaspi_qr) + '</td>' +
        '<td class="n">' + fmt(y.transfer) + '</td><td class="n b">' + fmt(y.revenue_total) + '</td>' +
        '<td class="n">' + fmt(y.cash_handed) + '</td><td class="n">' + fmt(y.podotchet) + '</td>' +
        '<td>' + (issues.length ? '<span class="pill bad">' + issues.join(' · ') + '</span>' : '<span class="pill ok">ОК</span>') + '</td>';
      b.appendChild(trr);
    }
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
  $('dreload').onclick = loadDash;
  $('dcsv').onclick = exportCsv;
  var ids = ['cash', 'kaspi_qr', 'transfer', 'qr_statement', 'tr_statement', 'cash_open', 'cash_handed', 'cash_counted'];
  for (var i = 0; i < ids.length; i++) { $(ids[i]).oninput = recalc; }
});
