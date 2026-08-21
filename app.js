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
    fillItemSelect('tsel'); fillItemSelect('ssel');
    loadReport();
  });
}

function fillItemSelect(id) {
  var sel = $(id); if (!sel) return;
  sel.innerHTML = '';
  for (var i = 0; i < S.items.length; i++) {
    var it = S.items[i];
    var o = document.createElement('option');
    o.value = it.code;
    o.textContent = it.name + ' · ' + it.unit;
    sel.appendChild(o);
  }
}

function loadReport() {
  api('get_report', { date: $('date').value }).then(function (r) {
    S.expenses = r.expenses || []; S.takeout = r.takeout || []; S.sales = r.sales || [];
    var rep = r.report;
    var f = ['cash', 'kaspi_qr', 'transfer', 'qr_statement', 'tr_statement', 'cash_open', 'cash_handed', 'cash_counted'];
    for (var i = 0; i < f.length; i++) {
      $(f[i]).value = rep && rep[f[i]] !== null && rep[f[i]] !== undefined ? rep[f[i]] : '';
    }
    $('shift_by').value = rep && rep.shift_by ? rep.shift_by : '';
    $('comment').value = rep && rep.comment ? rep.comment : '';
    $('saved').textContent = rep ? 'Отчёт за этот день уже был сохранён — можно поправить' : '';
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

function addTakeout() {
  var code = $('tsel').value; if (!code) return;
  for (var i = 0; i < S.takeout.length; i++) { if (S.takeout[i].item_code === code) return; }
  var it = null;
  for (var j = 0; j < S.items.length; j++) { if (S.items[j].code === code) it = S.items[j]; }
  if (!it) return;
  S.takeout.push({ item_code: it.code, item_name: it.name, unit: it.unit, issued: '', returned: '', price: it.price || '' });
  drawTakeout();
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
    var sold = num(t.issued) - num(t.returned);
    var row = document.createElement('div'); row.className = 'trow';
    row.innerHTML =
      '<span class="tn">' + t.item_name + '<i>' + t.unit + '</i></span>' +
      '<input class="ti" inputmode="decimal" value="' + (t.issued || '') + '">' +
      '<input class="tr" inputmode="decimal" value="' + (t.returned || '') + '">' +
      '<span class="tp' + (sold < 0 ? ' bad' : '') + '">' + fmt(sold) + '</span>' +
      '<button class="x" type="button">×</button>';
    (function (idx, row) {
      row.querySelector('.ti').oninput = function () { S.takeout[idx].issued = this.value; drawTakeout(); };
      row.querySelector('.tr').oninput = function () { S.takeout[idx].returned = this.value; drawTakeout(); };
      row.querySelector('.x').onclick = function () { S.takeout.splice(idx, 1); drawTakeout(); };
    })(i, row);
    w.appendChild(row);
  }
}

function addSale() {
  var code = $('ssel').value; if (!code) return;
  for (var i = 0; i < S.sales.length; i++) { if (S.sales[i].item_code === code) return; }
  var it = null;
  for (var j = 0; j < S.items.length; j++) { if (S.items[j].code === code) it = S.items[j]; }
  if (!it) return;
  S.sales.push({ item_code: it.code, item_name: it.name, qty: '', price: it.price || '' });
  drawSales();
}
function drawSales() {
  var w = $('sl'); if (!w) return;
  w.innerHTML = '';
  if (!S.sales.length) { w.innerHTML = '<div class="empty">Позиции не добавлены. Это поле необязательное — суммы важнее</div>'; return; }
  for (var i = 0; i < S.sales.length; i++) {
    var s = S.sales[i];
    var row = document.createElement('div'); row.className = 'srow';
    row.innerHTML = '<span class="sn">' + s.item_name + '</span>' +
      '<input class="sq" inputmode="decimal" placeholder="кол-во" value="' + (s.qty || '') + '">' +
      '<button class="x" type="button">×</button>';
    (function (idx, row) {
      row.querySelector('.sq').oninput = function () { S.sales[idx].qty = this.value; };
      row.querySelector('.x').onclick = function () { S.sales.splice(idx, 1); drawSales(); };
    })(i, row);
    w.appendChild(row);
  }
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
  $('addtk').onclick = addTakeout;
  $('addsl').onclick = addSale;
  $('savebtn').onclick = saveReport;
  $('logout').onclick = logout;
  $('logout2').onclick = logout;
  $('dreload').onclick = loadDash;
  $('dcsv').onclick = exportCsv;
  var ids = ['cash', 'kaspi_qr', 'transfer', 'qr_statement', 'tr_statement', 'cash_open', 'cash_handed', 'cash_counted'];
  for (var i = 0; i < ids.length; i++) { $(ids[i]).oninput = recalc; }
});
