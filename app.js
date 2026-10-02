const API = window.TANDEM_API_URL || "https://qeehxcnnuzuwskznhdyg.supabase.co/functions/v1/uchet";   // адрес меняется в config.js

var S = {
  role: null, point: null, pin: '', items: [], mode: null,
  expenses: [], takeout: [], sales: [], dash: null, charts: null,
  // ready — отчёт выбранного дня загружен с сервера: только тогда можно сохранять и писать черновик
  // (save_report заменяет отчёт целиком — сохранение пустой формы затёрло бы уже сданный).
  // saveSeq — номер сохранения отчёта: выход его меняет, и ответ, ушедший до выхода, ни к чему не применяется.
  ready: false, itemsOk: false, loadSeq: 0, dashSeq: 0, saveSeq: 0, saving: false, realUid: null, realKey: ''
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
// Число из поля для отправки: пробелы (и неразрывные из выписок) убираются, запятая → точка.
// Пусто → null, мусор → NaN (его ловит проверка перед сохранением, num() молча дал бы 0 или «12» из «12абв»).
var numOrNull = function (v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return isFinite(v) ? v : NaN;
  var s = String(v).replace(/\s/g, '').replace(',', '.');
  if (s === '') return null;
  return /^[-+]?(\d+\.?\d*|\.\d+)$/.test(s) ? Number(s) : NaN;
};
// Дата ГГГГ-ММ-ДД по часам устройства (toISOString дал бы UTC: до 05:00 по Алматы — вчерашний день).
var isoDate = function (d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};
var today = function () { return isoDate(new Date()); };
// ГГГГ-ММ-ДД → местная дата (new Date('2026-10-02') читается как полночь UTC).
var parseDate = function (s) {
  var p = String(s || '').split('-');
  return p.length === 3 ? new Date(+p[0], +p[1] - 1, +p[2]) : new Date();
};
// ГГГГ-ММ-ДД (или отметка времени) → ДД.ММ.ГГГГ: на экране даты как в iiko и в бэк-офисе.
var dmy = function (s) {
  var p = String(s || '').slice(0, 10).split('-');
  return p.length === 3 ? p[2] + '.' + p[1] + '.' + p[0] : String(s || '');
};
// Количество (вес, штуки, расход сырья): до 3 знаков, запятая — «0,35», а не «0.35».
var fmtQty = function (n) {
  n = Number(n || 0);
  return (Math.round(n * 1000) / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 3 });
};
// Число в поле ввода — с запятой, как его набирает человек («2,5»); num() и numOrNull() читают и точку, и запятую.
var numStr = function (v) {
  return v === null || v === undefined ? '' : String(v).replace('.', ',');
};
// «1 чек», «2 чека», «5 чеков».
var plural = function (n, one, few, many) {
  var a = Math.abs(n) % 100, b = a % 10;
  return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many;
};
// Расхождение кассы словами: diff_cash = должно − пересчитано, плюс — денег меньше, чем должно.
var cashDiffText = function (d) {
  d = Math.round(num(d) * 100) / 100;
  return d > 0 ? 'Недостача ' + fmt(d) + ' ₸' : d < 0 ? 'Излишек ' + fmt(-d) + ' ₸' : 'Касса сходится';
};
// Доля в процентах — с запятой, как остальные числа: «0,3 %», «10,8 %» (было «10.8 %»).
var pctText = function (p) {
  p = Math.abs(num(p));
  return p > 0 && p < 0.05 ? 'меньше 0,1 %'
    : (Math.round(p * 10) / 10).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' %';
};
var round2 = function (v) { return Math.round(num(v) * 100) / 100; };

/* Чеки после закрытия смены (касса, миграция 0047 / K1). Такой чек касса принимает, и он сразу входит
   в деньги дня (check_rollup на каждом чеке), а пересчёт кассы и выписки остались от закрытия — поэтому
   «должно» и недостача, посчитанные по строке дня, завышены на поздние чеки (ложная недостача, owner Д1).
   lateOf — сколько их и на сколько по способам оплаты; known — сервер отдал разбивку (late_cash и др.):
   без неё «на момент закрытия» не посчитать, и цифры остаются как есть (старый сервер). */
function lateOf(x) {
  var n = x && x.closed_at ? num(x.late_checks) : 0;
  if (!(n > 0)) return null;
  return { n: n, sum: num(x.late_sum), known: x.late_cash !== undefined && x.late_cash !== null,
           cash: num(x.late_cash), kaspi: num(x.late_kaspi), card: num(x.late_card), transfer: num(x.late_transfer) };
}
// Отчёт кассы на момент закрытия: из денег и расхождений вычтены поздние чеки. Повторное закрытие смены
// сворачивает их в отчёт (late_checks снова 0) — тогда это просто цифры отчёта. null в расхождении —
// «не сверяли» (выписки или пересчёта нет) и остаётся null.
function closeView(x) {
  var L = lateOf(x), k = L && L.known ? L : { cash: 0, kaspi: 0, transfer: 0, card: 0 };
  var sub = function (v, d) { return v === null || v === undefined ? null : round2(num(v) - d); };
  return {
    late: L, shifted: !!(L && L.known),
    cash: round2(num(x.cash) - k.cash), kaspi: round2(num(x.kaspi_qr) - k.kaspi),
    transfer: round2(num(x.transfer) - k.transfer), card: round2(num(x.card) - k.card),
    expected: round2(num(x.cash_expected) - k.cash),
    diffCash: sub(x.diff_cash, k.cash), diffQr: sub(x.diff_qr, k.kaspi), diffTr: sub(x.diff_transfer, k.transfer)
  };
}
/* «Смену сдал» у кассы при повторном закрытии (kassa Д6, owner У9): в поле — кто закрывает сейчас
   (продавец, вошедший в кассу на этом планшете), а кто закрыл первым — сохраняется в том же поле
   хвостом « · первым закрыл: …»: отдельной колонки у отчёта нет, а собственник должен видеть обоих. */
var FIRST_BY = ' · первым закрыл: ';
function splitBy(s) {
  s = String(s || '').trim();
  var i = s.indexOf(FIRST_BY.trim());
  if (i < 0) return { who: s, first: '' };
  return { who: s.slice(0, i).replace(/[\s·]+$/, ''), first: s.slice(i + FIRST_BY.trim().length).trim() };
}
function withFirstBy(who, first) {
  who = String(who || '').trim(); first = String(first || '').trim();
  if (!who || !first || splitBy(who).first) return who;
  return norm(who) === norm(first) ? who : who + FIRST_BY + first;
}
// Продавец, вошедший в кассу на этом устройстве (js/kassa/app.js пишет его при входе и «Сменить продавца»).
function kassaSeller() {
  try { return String(JSON.parse(localStorage.getItem('tandem_kassa_seller') || '""') || '').trim(); } catch (e) { return ''; }
}
/* Поле количества или суммы — как numInput бэк-офиса: при входе значение выделяется (новое число
   набирается поверх старого), Enter ведёт к следующему полю строки, с последнего — в поиск позиции.
   Колёсико число не меняет: поля текстовые (inputmode=decimal), запятую понимают при любом языке. */
function numField(inp, next) {
  if (!inp) return;
  inp.addEventListener('focus', function () {
    var t = this;
    setTimeout(function () { try { if (document.activeElement === t) t.select(); } catch (e) { } }, 0);
  });
  inp.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    var n = typeof next === 'function' ? next() : next;
    if (n && !n.disabled) n.focus(); else this.blur();
  });
}
var newUid = function () {
  return crypto.randomUUID ? crypto.randomUUID()
    : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, function (c) {
      return (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16);
    });
};

/* Вызов сервера. Никогда не бросает: обрыв связи, таймаут и непонятный ответ приходят как
   {ok:false, error, offline:true}, чтобы каждая кнопка разблокировалась и сказала, что случилось. */
var NET_ERR = 'Нет связи с сервером. Данные могли не сохраниться — проверьте и повторите';
function post(action, payload) {
  var ctl = window.AbortController ? new AbortController() : null;
  var timer = ctl ? setTimeout(function () { ctl.abort(); }, 20000) : null;
  return fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: action, payload: payload || {} }),
    signal: ctl ? ctl.signal : undefined
  }).then(function (r) {
    return r.json().catch(function () {
      return { ok: false, offline: true, error: 'Сервер ответил непонятно (' + r.status + '). Данные могли не сохраниться — проверьте и повторите' };
    });
  }, function () {
    return { ok: false, offline: true, error: NET_ERR };
  }).then(function (res) {
    if (timer) clearTimeout(timer);
    return res === null || typeof res !== 'object' ? { ok: false, error: 'Пустой ответ сервера' } : res;
  });
}
function api(action, payload) {
  payload = payload || {};
  payload.pin = S.pin;
  if (S.point) payload.point_id = S.point.id;
  return post(action, payload);
}

function initLogin() {
  post('points', {}).then(function (pts) {
    if (!Array.isArray(pts)) { $('lerr').textContent = (pts && pts.error) || 'Список точек не загрузился'; return; }
    var sel = $('lpoint');
    sel.innerHTML = '<option value="">— выберите точку —</option>';
    for (var i = 0; i < pts.length; i++) {
      var o = document.createElement('option');
      o.value = pts[i].id;
      o.textContent = pts[i].name;
      sel.appendChild(o);
    }
    var saved = savedLogin();
    if (saved && saved.point_id) sel.value = saved.point_id;   // точки из памяти может уже не быть в списке
    if (saved && saved.point_id && sel.value === saved.point_id) $('lpin').value = saved.pin || '';
  });
}
function savedLogin() {
  try { return JSON.parse(localStorage.getItem('tandem_login') || 'null'); } catch (e) { return null; }
}
/* Сменили точку в списке — код прежней точки из поля убирается (kassa У2: поверх 1008 дописывали 1006 и
   получали «Неверный код»). Запомненный код подставляется, только если выбрана та же точка, что в памяти. */
function pointChanged() {
  var saved = savedLogin();
  $('lpin').value = saved && saved.point_id && saved.point_id === $('lpoint').value ? saved.pin || '' : '';
  $('lerr').textContent = '';
}

function doLogin(asOwner) {
  var pin = asOwner ? $('opin').value.trim() : $('lpin').value.trim();
  var pid = asOwner ? null : $('lpoint').value;
  var err = $(asOwner ? 'oerr' : 'lerr');
  if (!asOwner && !pid) { err.textContent = 'Выберите точку'; return; }
  if (!pin) { err.textContent = 'Введите код'; return; }
  var btn = $(asOwner ? 'btn-owner' : 'btn-login');
  btn.disabled = true; err.textContent = '';
  post('login', { pin: pin, point_id: pid }).then(function (res) {
    btn.disabled = false;
    if (!res.ok) { err.textContent = res.offline ? 'Нет связи с сервером — проверьте интернет и повторите' : (res.error || 'Не пустило'); return; }
    S.pin = pin;
    // Код собственника и водителя на странице не оставляем: поле очищается сразу после входа.
    $('opin').value = '';
    S.role = res.role;
    if (res.role === 'owner') { showDash(); return; }
    if (res.role === 'driver') { showDriver(); return; }
    S.point = res.point; S.mode = res.point.mode;
    try { localStorage.setItem('tandem_login', JSON.stringify({ point_id: pid, pin: pin })); } catch (e) { }
    showForm();
  });
}

function logout() {
  S.role = null; S.point = null; S.pin = ''; S.dash = null; S.ready = false;
  // Ответы на запросы, ушедшие до выхода, больше не применяются. Незавершённое сохранение отчёта
  // не держит кнопку следующего входа: его ответ отбрасывается по saveSeq.
  S.loadSeq++; S.dashSeq++; S.saveSeq++; S.saving = false;
  $('opin').value = '';
  $('screen-login').hidden = false; $('screen-form').hidden = true;
  $('screen-dash').hidden = true; $('screen-driver').hidden = true;
  showFeedback(false);
}

/* ── Замечания (js/feedback.js) ───────────────────────────────────────────
   Кнопка видна только после входа: замечание уходит с текущим кодом (точки, собственника или
   водителя) — без кода сервер его не примет. Сам код в сведения не кладём: screen() — только
   экран, точка и дата; feedback.js берёт адрес страницы без строки запроса. */
var FB = { mounted: false };
// Номер сборки — из адреса своего же скрипта (app.js?v=N): отдельной константы, которую надо
// не забыть поменять при выпуске, нет.
var BUILD = (function () {
  var s = document.querySelector('script[src*="app.js?v="]');
  var m = s && /[?&]v=(\d+)/.exec(s.getAttribute('src') || '');
  return m ? m[1] : '';
})();
function fbSource() {
  return S.role === 'owner' ? 'owner' : S.role === 'driver' ? 'driver' : 'point';
}
function fbScreen() {
  if (S.role === 'owner') {
    return 'Сводка собственника · ' + dmy($('dfrom').value) + '–' + dmy($('dto').value);
  }
  if (S.role === 'driver') return 'Журнал развоза';
  if (S.point) {
    return 'Дневной отчёт · ' + S.point.name + ' · ' + $('fmode').textContent + ' · ' + dmy($('date').value);
  }
  return 'Вход';
}
function showFeedback(on) {
  if (!window.TandemFeedback) return;   // скрипт замечаний не загрузился — страница работает и без него
  if (on && !FB.mounted) {
    FB.mounted = true;
    window.TandemFeedback.mount({
      source: 'point', build: BUILD, corner: 'bl',   // слева: справа в строках поля и «×»
      screen: fbScreen,
      send: function (message, context) {
        if (!S.pin) return Promise.resolve({ ok: false, error: 'Сначала войдите — замечание отправляется с кодом входа' });
        return post('feedback', { pin: S.pin, point_id: S.point ? S.point.id : null, source: fbSource(),
          message: message, page: fbScreen(), context: context });
      }
    });
  }
  var b = document.querySelector('.tfb-btn');
  if (b) b.hidden = !on;
}

function showForm() {
  $('screen-login').hidden = true; $('screen-form').hidden = false; $('screen-dash').hidden = true;
  showFeedback(true);
  $('fpoint').textContent = S.point.name;
  $('fmode').textContent = S.mode === 'takeout' ? 'заборный лист' :
    S.mode === 'position' ? 'продажи по позициям' :
    S.mode === 'import' ? 'загрузка листа продаж' :
    S.mode === 'checks' ? 'касса: закрытие смены' : 'только суммы';
  $('date').value = today();
  $('block-takeout').hidden = (S.mode !== 'takeout');
  $('block-sales').hidden = (S.mode !== 'position' && S.mode !== 'import');
  $('block-import').hidden = (S.mode !== 'import');
  // Касса: деньги и продажи приходят из чеков — поля выручки только для чтения, позиции не показываем
  // (они видны в кассе, вкладка «Смена»). Сохранение этой формы и есть закрытие смены.
  var isK = S.mode === 'checks';
  $('block-kassa').hidden = !isK; $('moneyhint').hidden = !isK;
  ['cash', 'kaspi_qr', 'transfer', 'card'].forEach(function (id) { $(id).readOnly = isK; });
  $('savebtn').textContent = isK ? 'Закрыть смену' : 'Сохранить отчёт';
  if (S.mode === 'import') mountImport();
  S.itemsOk = false;
  loadItems();
}
function loadItems() {
  var point = S.point;
  S.itemsLoading = true;
  lockSave('Загружаю список позиций…');
  api('items', {}).then(function (r) {
    if (S.point !== point) return;   // пока грузилось, вышли или вошли в другую точку
    S.itemsLoading = false;
    if (!r.ok || !Array.isArray(r.items)) { loadFailed('Список позиций не загрузился: ' + (r.offline ? 'нет связи с сервером' : (r.error || 'ошибка сервера'))); return; }
    S.items = r.items; S.itemsOk = true;
    for (var i = 0; i < S.items.length; i++) S.items[i]._n = norm(S.items[i].name) + ' ' + (S.items[i].artikul || '');
    if (S.mode === 'takeout') mountSearch('tq', 'thint', 'tres', addTakeout);
    if (S.mode === 'position') mountSearch('sq', 'shint', 'sres', addSale);
    drawFav();
    api('charts', {}).then(function (c) { S.charts = (c && c.ok) ? c.charts : null; drawRaw(); });
    loadReport();
  });
}

/* Кнопка сохранения живёт только при загруженном отчёте. Пока он грузится или не загрузился,
   она неактивна: save_report заменяет отчёт целиком, и пустая форма затёрла бы уже сданный. */
function say(text, bad) {
  var m = $('savemsg'); m.textContent = text || ''; m.className = 'msg' + (bad ? ' bad' : '');
  // Ошибку, которую видел человек, замечание приложит само (js/feedback.js).
  if (bad && text && window.TandemFeedback) window.TandemFeedback.noteError(text);
}
function lockSave(text) {
  S.ready = false;
  $('savebtn').disabled = true; $('reloadbtn').hidden = true;
  say(text);
}
function loadFailed(text) {
  S.ready = false;
  $('savebtn').disabled = true; $('reloadbtn').hidden = false;
  say(text + '. Сохранять нельзя, пока отчёт не загружен, — иначе можно затереть уже сданный.', true);
}
function reloadForm() {
  if (!S.point) return;
  if (S.itemsOk) loadReport(); else if (!S.itemsLoading) loadItems();
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

/* Расход сырья: по техкартам считаем, сколько продуктов должно было
   уйти на пробитое за смену. Это ответ на вопрос «спекли 200 пирожков — сколько
   ушло муки и мяса», и материал для сверки с фактическим списанием.
   Единица — из строки карты (поле u, если сервер его отдаёт): брутто записано в единице ингредиента. */
function drawRaw() {
  var box = $('raw'), card = $('block-raw');
  if (!box || !card) return;
  if (!S.charts) { card.hidden = true; return; }

  var used = {}, units = {};
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
      if (chart[k].u) units[n] = chart[k].u;
    }
  }

  var names = Object.keys(used).sort(function (a, b) { return used[b] - used[a]; });
  if (!names.length) { card.hidden = true; return; }
  card.hidden = false;

  var html = '';
  for (var j = 0; j < names.length && j < 20; j++) {
    // Через fmtQty: «0,6» и «4,53» одинаково с запятой (раньше дробь меньше единицы шла с точкой).
    html += '<div class="rrow"><span>' + esc(names[j]) + '</span><b>' + fmtQty(used[names[j]]) +
      (units[names[j]] ? ' ' + esc(units[names[j]]) : '') + '</b></div>';
  }
  if (names.length > 20) {
    html += '<div class="empty">и ещё ' + (names.length - 20) + ' позиций сырья</div>';
  }
  html += '<div class="hint" style="margin-top:10px">' + (covered === total ? 'Техкарты есть у всех проданных позиций.'
    : 'Техкарты нашлись у ' + covered + ' ' + plural(covered, 'позиции', 'позиций', 'позиций') + ' из ' + total +
      '. У остальных техкарты пока нет — их расход здесь не посчитан.') + '</div>';
  box.innerHTML = html;
}

var MONEY_FIELDS = ['cash', 'kaspi_qr', 'transfer', 'card', 'qr_statement', 'tr_statement', 'cash_open', 'cash_handed', 'cash_counted'];
function fillMoney(rep) {
  for (var i = 0; i < MONEY_FIELDS.length; i++) {
    var v = rep ? rep[MONEY_FIELDS[i]] : null;
    $(MONEY_FIELDS[i]).value = numStr(v);
  }
  // Касса: поздние чеки дня и значения сверки, с которыми смену закрыли, — пока их не меняли,
  // проверки считаются на момент закрытия (recalc), после правки — по всему дню (повторное закрытие).
  S.late = S.mode === 'checks' ? lateOf(rep) : null;
  S.closedAt = rep && rep.closed_at ? rep.closed_at : null;
  S.atClose = { cash_counted: $('cash_counted').value, qr_statement: $('qr_statement').value, tr_statement: $('tr_statement').value };
  if (S.mode === 'checks') { $('kcount').textContent = rep ? rep.checks_count : '0'; drawLate(); }
}
/* Касса: чеки, пробитые после закрытия смены (late_* в отчёте дня, миграция 0047).
   Касса такой чек принимает (продажа не теряется), но закрытый отчёт его не видел — смену надо
   закрыть заново. Старый сервер поля не отдаёт — полосы нет. */
function drawLate() {
  var box = $('klate'); if (!box) return;
  box.hidden = !S.late;
  box.textContent = S.late ? lateText(S.late) : '';
}
// Под полем «Смену сдал» у кассы, если смену уже закрывали: кто закрыл первым и когда.
function drawFirstBy() {
  var box = $('firstby'); if (!box) return;
  var t = S.mode === 'checks' && S.firstBy
    ? 'Смену уже закрывали — ' + (S.firstSure ? 'первым закрыл: ' : 'последним закрыл: ') + S.firstBy +
      (S.firstAt ? ' (' + whenShort(S.firstAt, $('date').value) + ')' : '') + '. В поле «Смену сдал» — кто закрывает сейчас.'
    : '';
  box.textContent = t; box.hidden = !t;
}

function loadReport() {
  if (!S.itemsOk) { reloadForm(); return; }   // отчёт загрузится следом за списком позиций
  var seq = ++S.loadSeq, date = $('date').value;
  S.late = null; S.firstBy = ''; S.firstSure = false; drawLate(); drawFirstBy();   // пометки прошлого дня не должны висеть над другим днём
  lockSave('Загружаю отчёт за ' + dmy(date) + '…');
  api('get_report', { date: date }).then(function (r) {
    if (seq !== S.loadSeq) return;   // пока грузилось, выбрали другой день
    if (!r.ok) { loadFailed('Отчёт не загрузился: ' + (r.offline ? 'нет связи с сервером' : (r.error || 'ошибка сервера'))); return; }
    say('');
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
    // Сначала поля с сервера, потом черновик поверх пустых — не наоборот, иначе введённое
    // до обрыва связи затиралось пустыми значениями сразу после восстановления.
    var rep = r.report;
    fillMoney(rep);
    $('shift_by').value = rep && rep.shift_by ? rep.shift_by : '';
    $('comment').value = rep && rep.comment ? rep.comment : '';
    $('saved').textContent = rep ? 'Отчёт за этот день уже был сохранён — можно поправить' : '';
    // У кассы строка отчёта появляется с первым чеком: «сохранённым» он считается после закрытия смены.
    // До закрытия в её полях остаток/сдано/пересчёт только умолчания (0 и пусто): строку создали чеки,
    // а save_report в этом режиме всегда закрывает смену. Поэтому введённое в черновике их перекрывает —
    // иначе «0» с сервера не давал восстановить остаток на начало и сдачу после похода в кассу и обратно.
    var kassaOpen = S.mode === 'checks' && !!rep && !rep.closed_at;
    restoreDraft(!rep || kassaOpen, kassaOpen);
    if (S.mode === 'checks') {
      // Имя продавца уже введено в кассе — не заставляем набирать второй раз. Смену уже закрывали
      // (повторное закрытие или открыта собственником для исправления): сдаёт тот, кто за кассой сейчас,
      // а не тот, кто закрыл первым (kassa Д6); первый — строкой под полем и в сохранённом отчёте.
      // shift_by у кассы пишет только закрытие смены, поэтому непустое поле — признак, что закрывали.
      var seller = kassaSeller(), prev = splitBy(rep && rep.shift_by);
      if (rep && (rep.closed_at || rep.first_saved_at || prev.who)) {
        // Кто закрыл первым, известно точно, если это записано хвостом поля или смену закрывали один раз.
        // Отчёт, уже пересохранённый до этой сборки, хранит только последнего — его и называем последним.
        var once = !rep.edited_at && !(rep.closed_at && rep.first_saved_at &&
          Math.abs(new Date(rep.closed_at) - new Date(rep.first_saved_at)) > 60000);
        S.firstSure = !!prev.first || once;
        S.firstBy = prev.first || prev.who;
        S.firstAt = S.firstSure ? rep.first_saved_at || rep.closed_at || null : rep.closed_at || null;
        $('shift_by').value = seller || prev.who;
      } else if (!$('shift_by').value) $('shift_by').value = seller;
      drawFirstBy();
      $('saved').textContent = rep && rep.closed_at ? 'Смена за этот день уже закрыта — можно поправить и закрыть заново'
        : (rep ? '' : 'За этот день чеков ещё нет');
      drawKassaQueue();
    }
    // Восстанавливаем фасовку из справочника: в строках листа она не хранится.
    for (var z = 0; z < S.takeout.length; z++) {
      var rt = itemByCode(S.takeout[z].item_code);
      if (rt) {
        S.takeout[z].pack_factor = rt.pack_factor;
        S.takeout[z].pack_unit = rt.pack_unit;
        S.takeout[z].pack_price = rt.pack_price;
      }
    }
    S.ready = true;
    $('savebtn').disabled = S.saving;
    if (S.mode === 'takeout') prefillShortList();
    drawExp(); drawTakeout(); drawSales(); recalc();
  });
}

/* Касса: чеки, которые планшет ещё не отправил (очередь js/kassa/app.js в localStorage).
   Отправленные из очереди убираются. Правило то же, что у кнопки «Закрыть смену» в кассе:
   - wait (ждёт отправки) и drop (удалён на планшете, отмена ещё не ушла) за этот день — закрывать
     смену нельзя: отчёт выйдет без части продаж, а опоздавший чек потом молча изменит закрытый день;
   - bad (сервер отказал) — только предупреждение: на сервере такого чека нет или он остался прежним
     (отклонённая правка), на отчёт он не влияет, а блокировка заперла бы продавца между кассой и отчётом. */
function kassaPending(date) {
  var q = [], res = { wait: 0, bad: 0 };   // wait — неотправленные (wait и drop), bad — непринятые
  if (!S.point) return res;
  try { q = JSON.parse(localStorage.getItem('tandem_kassa_queue_' + S.point.id) || '[]'); } catch (e) { q = []; }
  if (!Array.isArray(q)) return res;
  for (var i = 0; i < q.length; i++) {
    if (!q[i] || q[i].date !== date) continue;
    if (q[i].state === 'wait' || q[i].state === 'drop') res.wait++;
    else if (q[i].state === 'bad') res.bad++;
  }
  return res;
}
function kassaPendingText(p) {
  var bad = p.bad ? 'Не принято сервером чеков за этот день: ' + p.bad +
    '. В отчёт они не попадут — разберите их в кассе (вкладка «Смена») или позвоните в офис.' : '';
  if (!p.wait) return bad;
  return 'Чеки за этот день ещё не ушли с планшета на сервер: ' + p.wait +
    '. Смену закрывать рано: вернитесь в кассу, дождитесь надписи «Все чеки на сервере», потом закройте смену.' +
    (bad ? ' ' + bad : '');
}
function drawKassaQueue() {
  var box = $('kqueue'); if (!box) return;
  var p = S.mode === 'checks' && S.point ? kassaPending($('date').value) : { wait: 0, bad: 0 };
  var t = kassaPendingText(p);
  box.textContent = t; box.hidden = !t;
  box.className = 'chk ' + (p.wait ? 'bad' : 'wait');   // красное — не даёт закрыть, жёлтое — предупреждение
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
      '<input class="ep" placeholder="Кому и на что" value="' + esc(e.purpose) + '">' +
      '<input class="ea" inputmode="decimal" autocomplete="off" placeholder="Сумма" value="' + esc(numStr(e.amount)) + '">' +
      '<input class="er" placeholder="№ чека" value="' + esc(e.receipt_no) + '">' +
      '<button class="x" type="button" tabindex="-1" aria-label="Убрать">×</button>';
    (function (idx, row) {
      numField(row.querySelector('.ea'), row.querySelector('.er'));
      row.querySelector('.ep').onkeydown = function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); row.querySelector('.ea').focus(); } };
      row.querySelector('.er').onkeydown = function (ev) {
        if (ev.key !== 'Enter') return;
        ev.preventDefault();
        var nx = row.nextElementSibling; (nx && nx.querySelector('.ep') || $('addexp')).focus();
      };
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
    var small = lineSmall(t);
    // Подпись под названием: единица, а при фасовке — во что и почём пересчитывается.
    var sub = esc(t.unit || '');
    if (small !== null) {
      sub += ' → ' + fmt(t.pack_factor) + ' ' + esc(t.pack_unit || 'шт') +
        (num(t.pack_price) > 0 ? ' по ' + fmt(t.pack_price) + ' ₸' : '');
    }
    var row = document.createElement('div'); row.className = 'trow';
    row.innerHTML =
      '<span class="tn">' + esc(t.item_name) + '<i>' + sub + '</i></span>' +
      '<input class="ti" inputmode="decimal" autocomplete="off" aria-label="Выдано: ' + esc(t.item_name) + '" value="' + esc(numStr(t.issued || '')) + '">' +
      '<input class="tr" inputmode="decimal" autocomplete="off" aria-label="Остаток: ' + esc(t.item_name) + '" value="' + esc(numStr(t.returned || '')) + '">' +
      '<span class="tp"></span>' +
      '<button class="x" type="button" tabindex="-1" aria-label="Убрать">×</button>';
    paintTakeoutRow(row, t);
    // Ввод цифры обновляет только «продано» в своей строке и итоги: пересоздание строк на каждую
    // цифру уводило фокус и закрывало клавиатуру телефона. Полная перерисовка — при добавлении/удалении.
    (function (idx, row) {
      var ti = row.querySelector('.ti'), tr = row.querySelector('.tr');
      numField(ti, tr);
      // С остатка — в «выдано» следующей строки (короткий лист подставлен заранее), с последней — в поиск.
      numField(tr, function () { var nx = row.nextElementSibling; return (nx && nx.querySelector('.ti')) || $('tq'); });
      ti.oninput = function () { S.takeout[idx].issued = this.value; takeoutChanged(row, idx); };
      tr.oninput = function () { S.takeout[idx].returned = this.value; takeoutChanged(row, idx); };
      row.querySelector('.x').onclick = function () { S.takeout.splice(idx, 1); drawTakeout(); };
    })(i, row);
    w.appendChild(row);
  }
  if ($('ttotal')) $('ttotal').textContent = fmt(takeoutTotal()) + ' ₸';
  drawRaw();
  recalc();
}
function paintTakeoutRow(row, t) {
  var sold = soldOf(t), small = lineSmall(t);
  var cell = row.querySelector('.tp');
  cell.className = 'tp' + (sold < 0 ? ' bad' : '');
  cell.innerHTML = fmt(sold) + (small !== null ? '<b>' + fmt(small) + ' ' + esc(t.pack_unit || 'шт') + '</b>' : '');
}
function takeoutChanged(row, idx) {
  paintTakeoutRow(row, S.takeout[idx]);
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
  // Подписи колонок (Д17): два поля в строке без подписей не отличить — где количество, где цена.
  var head = document.createElement('div'); head.className = 'srow th';
  head.innerHTML = '<span class="sn">Позиция</span><span class="hq">Кол-во</span><span class="hp">Цена</span><span class="ssum">Сумма</span>';
  w.appendChild(head);
  for (var i = 0; i < S.sales.length; i++) {
    var s = S.sales[i];
    var row = document.createElement('div'); row.className = 'srow';
    // «−», «+» и «×» вне порядка Tab: Tab и Enter идут кол-во → цена → поиск, без остановок на кнопках.
    row.innerHTML =
      '<span class="sn">' + esc(s.item_name) + '<i></i></span>' +
      '<button class="pm minus" type="button" tabindex="-1" aria-label="Меньше">−</button>' +
      '<input class="sq sqty" inputmode="decimal" autocomplete="off" aria-label="Кол-во: ' + esc(s.item_name) + '" value="' + esc(numStr(s.qty)) + '">' +
      '<button class="pm plus" type="button" tabindex="-1" aria-label="Больше">+</button>' +
      '<input class="sq sp" inputmode="decimal" autocomplete="off" aria-label="Цена: ' + esc(s.item_name) + '" value="' + esc(numStr(s.price)) + '">' +
      '<span class="ssum"></span>' +
      '<button class="x" type="button" tabindex="-1" aria-label="Убрать">×</button>';
    paintSaleRow(row, s);
    // Как в заборном листе: ввод обновляет свою строку и итог, не пересоздавая поля под пальцем.
    (function (idx, row) {
      var q = row.querySelector('.sqty'), p = row.querySelector('.sp');
      q.oninput = function () { S.sales[idx].qty = this.value; salesChanged(row, idx); };
      p.oninput = function () { S.sales[idx].price = this.value; salesChanged(row, idx); };
      numField(q, p);
      numField(p, function () { return $('sq'); });
      row.querySelector('.minus').onclick = function () { chgSale(idx, -1); };
      row.querySelector('.plus').onclick = function () { chgSale(idx, +1); };
      row.querySelector('.x').onclick = function () { S.sales.splice(idx, 1); drawSales(); };
    })(i, row);
    w.appendChild(row);
  }
  if ($('stotal')) $('stotal').textContent = fmt(salesTotal()) + ' ₸';
  drawRaw();
  recalc();
}
// Цена в строке редактируется: «часто сами цены говорят». Отличие от прайса
// подсвечивается и считается скидкой — собственник видит её в сводке.
function paintSaleRow(row, s) {
  var changed = s.price_list !== undefined && s.price_list !== null && s.price_list !== '' &&
    num(s.price) !== num(s.price_list);
  row.querySelector('.sn i').textContent = (s.unit || '') + (changed ? ' · по прайсу ' + fmt(s.price_list) + ' ₸' : '');
  row.querySelector('.sp').classList.toggle('spc', changed);
  row.querySelector('.ssum').textContent = fmt(num(s.qty) * num(s.price)) + ' ₸';
}
function salesChanged(row, idx) {
  paintSaleRow(row, S.sales[idx]);
  if ($('stotal')) $('stotal').textContent = fmt(salesTotal()) + ' ₸';
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
  if (!S.point || !S.ready) return;   // пока отчёт дня не загружен, в полях чужие (прошлые) значения
  try {
    var f = {};
    ['shift_by','cash','kaspi_qr','transfer','card','qr_statement','tr_statement',
     'cash_open','cash_handed','cash_counted','comment'].forEach(function (id) {
      var el = $(id); if (el) f[id] = el.value;
    });
    localStorage.setItem(draftKey(), JSON.stringify({
      t: Date.now(), fields: f, expenses: S.expenses, takeout: S.takeout, sales: S.sales
    }));
  } catch (e) { }
}
/* override — касса до закрытия смены: в этих полях сервер отдаёт только умолчания, и непустое значение
   черновика перекрывает серверное, а не заполняет одни пустые поля. Деньги по каналам (только чтение)
   всегда с сервера — они собраны из чеков. Совпадающее с сервером значение «восстановлением» не считается:
   черновик пишется на каждом пересчёте, и сообщение иначе появлялось бы при каждом открытии формы. */
var DRAFT_OVERRIDE = ['cash_open', 'cash_handed', 'cash_counted', 'qr_statement', 'tr_statement', 'shift_by', 'comment'];
function restoreDraft(serverEmpty, override) {
  if (!S.point || !serverEmpty) return;
  var raw = null;
  try { raw = localStorage.getItem(draftKey()); } catch (e) { }
  if (!raw) return;
  try {
    var d = JSON.parse(raw), got = false;
    for (var id in (d.fields || {})) {
      var el = $(id), v = d.fields[id];
      if (!el || el.readOnly || v === null || v === undefined || v === '') continue;
      if (el.value && !(override && DRAFT_OVERRIDE.indexOf(id) >= 0)) continue;
      if (el.value === String(v)) continue;
      el.value = v; got = true;
    }
    if (!S.expenses.length && d.expenses && d.expenses.length) { S.expenses = d.expenses; got = true; }
    if (!S.takeout.length && d.takeout && d.takeout.length) { S.takeout = d.takeout; got = true; }
    if (!S.sales.length && d.sales && d.sales.length && S.mode !== 'checks') { S.sales = d.sales; got = true; }
    if (got) say('Восстановлен черновик — данные не потерялись. Проверьте и сохраните');
  } catch (e) { }
}
function clearDraft() { try { localStorage.removeItem(draftKey()); } catch (e) { } }

/* ── «Как вчера» — заборный лист со вчерашними позициями ────────────── */
function likeYesterday() {
  var d = parseDate($('date').value || today());
  d.setDate(d.getDate() - 1);
  var y = isoDate(d);
  api('get_report', { date: y }).then(function (r) {
    if (!r.ok) { say('Вчерашний лист не загрузился: ' + (r.error || 'ошибка сервера'), true); return; }
    var rows = r.takeout || [];
    if (!rows.length) { say('За вчера заборного листа нет'); return; }
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
    say(added ? 'Подставлено вчерашних позиций: ' + added : 'Все вчерашние позиции уже в листе');
  });
}

/* ── Импорт листа продаж (Актау) ─────────────────────────────────────────
   Формат заводской программы: лист TDSheet, «Сводка по товарообороту»:
   название | цена | количество | сумма полная | сумма со скидкой.
   Названия чужие — сопоставляются с номенклатурой один раз, карта хранится. */
var IMP = { rows: [], aliases: {}, aliasesOk: false, xlsxReady: false };

function mountImport() {
  if (!IMP.mounted) {
    IMP.mounted = true;
    $('impfile').onchange = handleImportFile;
    $('impapply').onclick = applyImport;
  }
  loadAliases();
}
// Без карты сопоставлений знакомые названия показались бы новыми, а ручной выбор переписал бы
// общую карту — поэтому файл разбирается только после того, как карта загрузилась.
function loadAliases() {
  return api('aliases', {}).then(function (r) {
    if (r.ok) { IMP.aliases = r.aliases || {}; IMP.aliasesOk = true; }
    return IMP.aliasesOk;
  });
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
  (IMP.aliasesOk ? Promise.resolve(true) : loadAliases()).then(function (ok) {
    if (!ok) throw new Error('Нет связи: карта сопоставлений не загрузилась. Выберите файл ещё раз, когда связь появится');
    return loadXlsxLib();
  }).then(function () {
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
  }).catch(function (e) { $('impstatus').textContent = e.message; $('impfile').value = ''; });
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
      // код из карты годится, только если позиция есть в списке точки — иначе строка молча пропала бы
      code: (itemByCode(IMP.aliases[normAlias(name)]) ? IMP.aliases[normAlias(name)] : '') || matchByName(name) || '',
      manual: false
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
    row.innerHTML = '<span class="iname">' + esc(r.name) + '<i>' + fmt(r.qty) + ' × ' + fmt(r.price) + ' ₸</i></span>' +
      (r.code
        ? '<div class="iright"><span class="iok">' + esc((itemByCode(r.code) || {}).name || r.code) + '</span>' +
          '<button class="x" type="button" title="Сопоставить с другой позицией">×</button></div>'
        : '<div class="sbox"><input class="ialias" placeholder="Найти в номенклатуре" autocomplete="off">' +
          '<div class="sres"></div></div>');
    if (r.code) {
      // Ошибочное сопоставление снимается до «Добавить в отчёт»; новая позиция заменит запись в карте.
      row.querySelector('.x').onclick = function () { IMP.rows[idx].code = ''; IMP.rows[idx].manual = false; drawImportMap(); };
    } else {
      // Сопоставление — только явным нажатием на позицию из списка, не по первому совпадению при наборе.
      var inp = row.querySelector('.ialias'), res = row.querySelector('.sres');
      inp.oninput = function () {
        var q = norm(this.value);
        res.innerHTML = '';
        if (q.length < 2) return;
        var hit = findItems(q);
        hit.list.slice(0, 8).forEach(function (m) {
          var b = document.createElement('button');
          b.type = 'button'; b.className = 'sitem';
          b.innerHTML = '<span style="color:var(--ink);font-size:14px">' + hl(m.name, hit.words) + '</span><span>' + esc(m.unit) + '</span>';
          b.onclick = function () { pickImport(idx, m.code); };
          res.appendChild(b);
        });
        if (!hit.list.length) res.innerHTML = '<span class="shint" style="display:block;padding:8px 10px">Ничего не найдено</span>';
      };
    }
    w.appendChild(row);
  });

  $('impapply').hidden = false;
  $('impapply').textContent = 'Добавить в отчёт (' + matched + ' из ' + IMP.rows.length + ')';
}

// Строки файла с тем же названием сопоставляются разом: позиция часто идёт двумя строками (цена менялась днём).
function pickImport(idx, code) {
  var alias = normAlias(IMP.rows[idx].name);
  IMP.rows.forEach(function (r) {
    if (normAlias(r.name) === alias && (r === IMP.rows[idx] || !r.code)) { r.code = code; r.manual = true; }
  });
  drawImportMap();
}

/* Строки с одним кодом складываются: количество — сумма, цена — средневзвешенная по количеству
   (раньше вторая строка той же позиции молча выбрасывалась). Повторный импорт заменяет строки
   продаж целиком: в этом режиме они приходят только из файла. */
function aggregateImport(rows) {
  var by = {}, order = [], skipped = 0, merged = 0;
  rows.forEach(function (r) {
    var it = r.code ? itemByCode(r.code) : null;
    if (!it) { skipped++; return; }
    var a = by[r.code];
    if (a) merged++;
    else { a = by[r.code] = { it: it, qty: 0, sum: 0, sumList: 0 }; order.push(r.code); }
    a.qty += r.qty; a.sum += r.qty * r.price; a.sumList += r.qty * r.price_list;
  });
  return {
    skipped: skipped, merged: merged,
    sales: order.map(function (code) {
      var a = by[code];
      return {
        item_code: code, item_name: a.it.name, unit: a.it.unit,
        qty: Math.round(a.qty * 1000) / 1000,
        price: a.qty ? Math.round(a.sum / a.qty * 100) / 100 : 0,
        price_list: a.qty ? Math.round(a.sumList / a.qty * 100) / 100 : 0
      };
    })
  };
}

function applyImport() {
  var agg = aggregateImport(IMP.rows);
  if (!agg.sales.length) { $('impstatus').textContent = 'Нет ни одной сопоставленной строки — сопоставьте позиции и повторите.'; return; }
  if (S.sales.length && !window.confirm('В отчёте уже есть позиции (' + S.sales.length + '). Заменить их данными из файла?')) return;
  S.sales = agg.sales;
  drawSales();
  var msg = 'В отчёт добавлено позиций: ' + agg.sales.length +
    (agg.merged ? ' (строк одной позиции сложено: ' + agg.merged + ')' : '') +
    (agg.skipped ? '. Не сопоставлено и не вошло строк: ' + agg.skipped : '') +
    '. Проверьте сумму и сохраните отчёт.';
  $('impstatus').textContent = msg;
  // В общую карту уходят только ручные сопоставления, по одному на название (иначе сервер споткнётся о дубль).
  var seen = {}, data = [];
  IMP.rows.forEach(function (r) {
    if (!r.manual || !r.code) return;
    var a = normAlias(r.name);
    if (seen[a]) return;
    seen[a] = true; data.push({ alias: a, code: r.code });
  });
  if (data.length) {
    api('save_aliases', { data: data }).then(function (res) {
      if (!res.ok) { $('impstatus').textContent = msg + ' Сопоставления не запомнились: ' + (res.error || 'ошибка сервера'); return; }
      data.forEach(function (x) { IMP.aliases[x.alias] = x.code; });
      IMP.rows.forEach(function (r) { r.manual = false; });
    });
  }
}

/* ── Экран водителя: реализация и долги ────────────────────────────── */
function showDriver() {
  $('screen-login').hidden = true; $('screen-form').hidden = true;
  $('screen-dash').hidden = true; $('screen-driver').hidden = false;
  showFeedback(true);
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
  var f = [['rdeliv', 'Отвёз по накладной'], ['rpaid', 'Принял деньгами'], ['rret', 'Возврат продукции']];
  for (var i = 0; i < f.length; i++) {
    if (isNaN(numOrNull($(f[i][0]).value))) { $('rmsg').textContent = 'Неверное число в поле «' + f[i][1] + '»: ' + $(f[i][0]).value; return; }
  }
  var deliv = num($('rdeliv').value), paid = num($('rpaid').value), ret = num($('rret').value);
  if (deliv === 0 && paid === 0 && ret === 0) { $('rmsg').textContent = 'Введите хотя бы одну сумму'; return; }
  if (!$('rclient').value) { $('rmsg').textContent = 'Выберите, куда возили'; return; }
  var data = { client_id: $('rclient').value, date: $('rdate').value,
               delivered: deliv, paid: paid, returned: ret, note: $('rnote').value };
  // uid записи — один до успеха: если ответ потерялся и водитель жмёт ещё раз с теми же данными,
  // сервер узнаёт повтор и вторую строку (двойной долг клиента) не создаёт. Изменённые данные —
  // уже другая запись: со старым uid сервер принял бы её за повтор и молча не записал.
  var key = JSON.stringify(data);
  if (!S.realUid || S.realKey !== key) { S.realUid = newUid(); S.realKey = key; }
  data.uid = S.realUid;
  $('rsave').disabled = true;
  $('rmsg').textContent = 'Записываю…';
  api('realization', { op: 'add', data: data }).then(function (r) {
    $('rsave').disabled = false;
    if (r.offline) { $('rmsg').textContent = 'Нет связи — не ясно, записалось ли. Нажмите «Записать» ещё раз, не меняя полей: повтор не создаст вторую запись'; return; }
    if (!r.ok) { S.realUid = null; $('rmsg').textContent = r.error || 'Не сохранилось'; return; }
    S.realUid = null;
    $('rdeliv').value = ''; $('rpaid').value = ''; $('rret').value = ''; $('rnote').value = '';
    $('rmsg').textContent = 'Записано';
    loadRealization();
  }).catch(function () { $('rsave').disabled = false; });
}

function recalc() {
  var cash = num($('cash').value), qr = num($('kaspi_qr').value), tr = num($('transfer').value);
  var total = cash + qr + tr + num($('card').value);
  $('total').textContent = fmt(total) + ' ₸';

  var pod = 0, noReceipt = 0;
  for (var i = 0; i < S.expenses.length; i++) {
    pod += num(S.expenses[i].amount);
    if (num(S.expenses[i].amount) > 0 && !String(S.expenses[i].receipt_no || '').trim()) noReceipt++;
  }
  $('podotchet').textContent = fmt(pod) + ' ₸';

  // «Должно» — по всему дню, с поздними чеками: с этим числом сверяют новый пересчёт при повторном закрытии.
  var expected = num($('cash_open').value) + cash - num($('cash_handed').value) - pod;
  $('cash_expected').textContent = fmt(expected) + ' ₸';

  var checks = [];
  var qs = $('qr_statement').value, ts = $('tr_statement').value, cc = $('cash_counted').value;
  // Касса, смена закрыта, после закрытия пробиты чеки (owner Д1, kassa Д1). Пересчёт и выписки в полях —
  // с закрытия, а суммы по каналам уже с поздними чеками. Пока пересчёт (выписку) не меняли, сверяем на
  // момент закрытия — без поздних чеков; новый пересчёт сверяется со всем днём («как сейчас»).
  var L = S.mode === 'checks' ? S.late : null, LK = L && L.known ? L : null, at = S.atClose || {};
  var closedHm = S.closedAt ? hhmm(S.closedAt) : '';
  var lc = $('klatecash');
  if (lc) {
    lc.hidden = !LK;
    lc.textContent = LK ? 'Сюда уже вошли наличные чеков после закрытия: ' + fmt(LK.cash) + ' ₸. На момент закрытия' +
      (closedHm ? ' (' + closedHm + ')' : '') + ' должно было быть ' + fmt(expected - LK.cash) + ' ₸.' : '';
  }
  if (qs === '' && ts === '') {
    checks.push(['wait', 'Сверка с выписками не заполнена']);
  } else {
    var qAt = !!LK && qs === at.qr_statement, tAt = !!LK && ts === at.tr_statement;
    var dq = qs === '' ? 0 : round2(qr - (qAt ? LK.kaspi : 0) - num(qs));
    var dt = ts === '' ? 0 : round2(tr - (tAt ? LK.transfer : 0) - num(ts));
    // «На момент закрытия» — только если каждая внесённая выписка сверяется с закрытием; выписку, которую
    // поправили, программа сверяет со всем днём — тогда подпись вводила бы в заблуждение.
    var atTxt = (qAt || tAt) && (qs === '' || qAt) && (ts === '' || tAt) ? ' на момент закрытия' : '';
    if (dq === 0 && dt === 0) checks.push(['ok', 'Выручка сходится с выписками' + atTxt]);
    else checks.push(['bad', 'Расхождение с выписками' + atTxt + ': Kaspi QR ' + fmt(dq) + ' ₸, переводы ' + fmt(dt) + ' ₸']);
    // Повторное закрытие сверит выписку со всем днём — напоминаем внести её заново, если пришли поздние оплаты.
    var more = [];
    if (qAt && LK.kaspi) more.push('Kaspi QR ' + fmt(LK.kaspi) + ' ₸');
    if (tAt && LK.transfer) more.push('переводами ' + fmt(LK.transfer) + ' ₸');
    if (more.length) checks.push(['wait', 'После закрытия пришло ещё ' + more.join(', ') + ' — перед повторным закрытием внесите выписку заново']);
  }
  if (cc === '') checks.push(['wait', 'Касса не пересчитана']);
  else if (L && !LK && cc === at.cash_counted) {
    // Старый сервер: разбивки поздних чеков нет — «на момент закрытия» не посчитать, а сравнивать старый
    // пересчёт со всем днём — ложная недостача. Просим пересчитать заново.
    checks.push(['wait', 'Пересчёт кассы сделан при закрытии, а после него пробиты чеки — пересчитайте кассу заново: сейчас должно быть ' + fmt(expected) + ' ₸']);
  } else {
    // Словами, а не «расхождение 60 ₸»: недостача — денег меньше, чем должно, излишек — больше.
    var cAt = !!LK && cc === at.cash_counted, exp2 = cAt ? expected - LK.cash : expected;
    var dc = round2(exp2 - num(cc));
    checks.push([dc === 0 ? 'ok' : 'bad', (cAt ? 'На момент закрытия' + (closedHm ? ' (' + closedHm + ')' : '') + ': ' +
      cashDiffText(dc).toLowerCase() : cashDiffText(dc)) +
      (dc ? ' (должно ' + fmt(exp2) + ' ₸, пересчитано ' + fmt(num(cc)) + ' ₸)' : '')]);
  }
  if (noReceipt > 0) checks.push(['bad', 'Расходов из кассы без номера чека: ' + noReceipt]);
  else if (pod > 0) checks.push(['ok', 'Расходы из кассы подтверждены чеками']);

  // Сверка ассортимента с деньгами — до сохранения, чтобы кассир увидел сразу.
  // Загруженный лист продаж сверяется так же, как набранные позиции: потерянная строка файла видна сразу.
  var bySales = S.mode === 'position' || S.mode === 'import';
  var byItems = bySales ? salesTotal() : (S.mode === 'takeout' ? takeoutTotal() : 0);
  var label = bySales ? 'позициям' : 'заборному листу';
  if (bySales || S.mode === 'takeout') {
    if (byItems === 0) {
      checks.push(['wait', 'По ' + label + ' пока ничего не внесено']);
    } else if (total === 0) {
      checks.push(['wait', 'Выручка не заполнена — сверить не с чем']);
    } else {
      // «Сходится» — только при разнице до 1 ₸ (округление цен); раньше зелёным шло всё меньше 0,5 %,
      // и на выручке 300 000 ₸ пряталось до 1 500 ₸ (kassa Д2). До 5 % — жёлтое, больше — красное.
      var d = round2(byItems - total);
      var pct = Math.abs(d) / total * 100;
      if (Math.abs(d) <= 1) checks.push(['ok', 'Сумма по ' + label + ' сходится с выручкой' + (d ? ' (разница ' + fmt(Math.abs(d)) + ' ₸ — округление)' : '')]);
      else checks.push([pct <= 5 ? 'wait' : 'bad',
        'По ' + label + ' ' + fmt(byItems) + ' ₸, в кассе ' + fmt(total) +
        ' ₸ — расхождение ' + fmt(Math.abs(d)) + ' ₸ (' + pctText(pct) + ')']);
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

/* Отчёт для отправки: все числа — уже числа (пробелы и запятая разобраны), пустые выписки и
   пересчёт — null («не заполнено», а не ноль), пустые строки расходов, заборного листа и продаж
   не отправляются. Мусор в числе — ошибка с названием поля, а не 500 от сервера. */
var MONEY_TITLES = { cash: 'Наличные', kaspi_qr: 'Kaspi QR', transfer: 'Перевод на счёт', card: 'Карта через терминал',
  qr_statement: 'QR по выписке', tr_statement: 'Переводы по выписке', cash_open: 'Остаток на начало',
  cash_handed: 'Сдано / инкассация', cash_counted: 'Фактически пересчитано' };
function buildReport(date, fields, expenses, takeout, sales) {
  var bad = null;
  var n = function (v, title, nullable) {
    var x = numOrNull(v);
    if (x !== null && isNaN(x)) { if (!bad) bad = 'Неверное число в поле «' + title + '»: ' + String(v).trim(); return 0; }
    return x === null && !nullable ? 0 : x;
  };
  var p = {
    date: date, shift_by: String(fields.shift_by || '').trim(), comment: fields.comment || '',
    cash: n(fields.cash, MONEY_TITLES.cash), kaspi_qr: n(fields.kaspi_qr, MONEY_TITLES.kaspi_qr),
    transfer: n(fields.transfer, MONEY_TITLES.transfer), card: n(fields.card, MONEY_TITLES.card),
    qr_statement: n(fields.qr_statement, MONEY_TITLES.qr_statement, true),
    tr_statement: n(fields.tr_statement, MONEY_TITLES.tr_statement, true),
    cash_open: n(fields.cash_open, MONEY_TITLES.cash_open), cash_handed: n(fields.cash_handed, MONEY_TITLES.cash_handed),
    cash_counted: n(fields.cash_counted, MONEY_TITLES.cash_counted, true),
    expenses: [], takeout: [], sales: []
  };
  expenses.forEach(function (e, i) {
    var purpose = String(e.purpose || '').trim(), receipt = String(e.receipt_no || '').trim();
    var amount = n(e.amount, 'Сумма расхода в строке ' + (i + 1));
    if (!purpose && !receipt && !amount) return;   // пустая добавленная строка
    if (!(amount > 0) && !bad) bad = 'В строке расхода ' + (i + 1) + (purpose ? ' («' + purpose + '»)' : '') + ' укажите сумму или удалите строку';
    p.expenses.push({ purpose: purpose, amount: amount, receipt_no: receipt });
  });
  takeout.forEach(function (t) {
    var issued = n(t.issued, 'Выдано — ' + t.item_name), returned = n(t.returned, 'Остаток — ' + t.item_name);
    if (!t.item_code && !t.item_name) return;
    if (!issued && !returned) return;   // позиция короткого листа, которую сегодня не выдавали
    p.takeout.push({ item_code: t.item_code || '', item_name: t.item_name || '', unit: t.unit || 'шт',
      issued: issued, returned: returned, price: n(t.price, 'Цена — ' + t.item_name, true) });
  });
  sales.forEach(function (s) {
    var qty = n(s.qty, 'Количество — ' + s.item_name);
    if (!qty) return;   // стёртое или нулевое количество
    p.sales.push({ item_code: s.item_code || '', item_name: s.item_name || '', qty: qty,
      price: n(s.price, 'Цена — ' + s.item_name, true), price_list: n(s.price_list, 'Цена по прайсу — ' + s.item_name, true) });
  });
  return { p: p, error: bad };
}

function saveReport() {
  if (!S.ready || S.saving) return;
  var date = $('date').value;
  if (!date) { say('Укажите дату отчёта', true); return; }
  if (S.mode === 'checks') {
    var pend = kassaPending(date);
    drawKassaQueue();   // непринятые (bad) остаются предупреждением над формой и закрыть не мешают
    if (pend.wait) { say(kassaPendingText(pend), true); return; }
  }
  var fields = {};
  ['shift_by', 'comment'].concat(MONEY_FIELDS).forEach(function (id) { fields[id] = $(id).value; });
  // Повторное закрытие смены другим продавцом: первый закрывший остаётся в отчёте (собственник видит обоих).
  if (S.mode === 'checks' && S.firstBy && S.firstSure) fields.shift_by = withFirstBy(fields.shift_by, S.firstBy);
  var b = buildReport(date, fields, S.expenses, S.takeout, S.sales);
  if (b.error) { say(b.error, true); return; }
  var before = num($('cash').value) + num($('kaspi_qr').value) + num($('transfer').value) + num($('card').value);
  // Ответ привязан к этому входу: после выхода (и входа в другую точку или заново в эту) он не
  // трогает ни форму, ни черновик, ни кнопку — иначе суммы точки A легли бы в форму точки B,
  // черновик B был бы удалён, а на экране стояло бы ложное «Отчёт сохранён».
  var sseq = ++S.saveSeq, point = S.point;
  var stale = function () { return sseq !== S.saveSeq || S.point !== point; };
  S.saving = true;
  $('savebtn').disabled = true;
  say('Сохраняю…');
  api('save_report', b.p).then(function (r) {
    if (stale()) return;
    S.saving = false;
    $('savebtn').disabled = !S.ready;
    if (!r.ok) {
      say(r.offline ? 'Нет связи — неизвестно, сохранился ли отчёт. Черновик на телефоне, нажмите «' +
        $('savebtn').textContent + '» ещё раз' : 'Ошибка: ' + (r.error || 'не сохранилось'), true);
      return;
    }
    if ($('date').value !== date || !S.ready) return;   // пока сохранялось, открыли другой день
    var msg = (S.mode === 'checks' ? 'Смена закрыта ' : 'Отчёт сохранён ') + new Date().toLocaleTimeString('ru-RU');
    var changed = false;
    // Показываем то, что сервер сохранил, а не то, что было в форме: у кассы деньги пересобраны
    // из чеков, и чек, дошедший пока форма была открыта, меняет «должно в кассе».
    if (r.report) {
      fillMoney(r.report);
      var after = num(r.report.revenue_total);
      changed = S.mode === 'checks' && Math.abs(after - before) >= 0.01;
      if (changed) msg += '. Выручка по чекам изменилась: было ' + fmt(before) + ' ₸, стало ' + fmt(after) + ' ₸ — проверьте пересчёт кассы';
    }
    $('saved').textContent = S.mode === 'checks' ? 'Смена за этот день уже закрыта — можно поправить и закрыть заново'
      : 'Отчёт за этот день уже был сохранён — можно поправить';
    // Закрыли впервые — следующее закрытие в этом сеансе уже повторное, и первый известен точно.
    // Первый неизвестен (старый пересохранённый отчёт) — «последним закрыл» теперь тот, кто закрыл сейчас.
    if (S.mode === 'checks' && (!S.firstBy || !S.firstSure)) {
      var firstNow = !S.firstBy, nowAt = new Date().toISOString();
      S.firstBy = splitBy(b.p.shift_by).who; S.firstSure = firstNow;
      S.firstAt = (r.report && (firstNow ? r.report.first_saved_at || r.report.closed_at : r.report.closed_at)) || nowAt;
      drawFirstBy();
    }
    recalc();
    clearDraft();   // отчёт на сервере; recalc только что записал черновик заново
    say(msg, changed);
  }).catch(function (e) {
    if (stale()) return;
    S.saving = false; $('savebtn').disabled = !S.ready;
    say('Ошибка на странице: ' + e.message, true);
  });
}

function showDash() {
  $('screen-login').hidden = true; $('screen-form').hidden = true;
  $('screen-driver').hidden = true; $('screen-dash').hidden = false;
  showFeedback(true);
  // Как в отчётах бэк-офиса: по умолчанию — этот месяц, иначе цифры сводки и «Прибыли по точкам» не сравнить.
  setPeriod('month');
}

/* Быстрые периоды: сегодня, вчера, неделя (7 дней), этот месяц (с 1-го по сегодня) и прошлый месяц
   целиком — те же даты, что у кнопок отчётов бэк-офиса. Произвольный — через поля С/По.
   Даты — по часам устройства: toISOString до 05:00 по Алматы давал «сегодня» вчерашним числом. */
function setPeriod(per) {
  var to = new Date(), from = new Date();
  if (per === 'yesterday') { from.setDate(from.getDate() - 1); to = new Date(from); }
  if (per === 'week') from.setDate(from.getDate() - 6);
  if (per === 'month') from = new Date(to.getFullYear(), to.getMonth(), 1);
  if (per === 'prevmonth') {
    from = new Date(to.getFullYear(), to.getMonth() - 1, 1);
    to = new Date(to.getFullYear(), to.getMonth(), 0);   // нулевое число месяца — последний день прошлого
  }
  $('dfrom').value = isoDate(from);
  $('dto').value = isoDate(to);
  markPeriod(per);
  loadDash();
}
function markPeriod(per) {
  var bs = document.querySelectorAll('.dper');
  for (var i = 0; i < bs.length; i++) bs[i].classList.toggle('on', bs[i].dataset.per === per);
}

/* Всё, что пришло с сервера, выводится через esc(): названия позиций, расходы, комментарии
   и имена вводит точка, и разметка из них не должна исполняться на экране собственника. */
var PAY_TITLES = { cash: 'наличные', kaspi_qr: 'Kaspi QR', transfer: 'перевод', card: 'карта' };
function hhmm(at) {
  var d = at ? new Date(at) : null;
  return d && !isNaN(d) ? d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '';
}
function dayTime(at) {
  var d = at ? new Date(at) : null;
  return d && !isNaN(d) ? d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
}
var payTitle = function (k) { return PAY_TITLES[k] || k || ''; };
// edited_diff (v_daily) — на сколько исправления изменили выручку: сумма first_total − total по исправленным
// активным чекам. Плюс — исправили вниз (выручка меньше, чем пробили сначала), показываем «−».
function editDiff(ed) {
  ed = num(ed);
  return Math.abs(ed) >= 0.01 ? ' (' + (ed > 0 ? '−' : '+') + fmt(Math.abs(ed)) + ' ₸)' : '';
}
// Значок отчёта кассы: «отмены: N на X ₸, исправлено: M (−Z ₸)» (колонки v_daily void_count, void_sum —
// по первой сумме чека, edited_count, edited_diff; на старом сервере без edited_diff — без скобок).
function voidBadge(x) {
  var vc = num(x.void_count), ec = num(x.edited_count), parts = [];
  if (vc) parts.push('отмены: ' + vc + ' на ' + fmt(x.void_sum) + ' ₸');
  if (ec) parts.push('исправлено: ' + ec + editDiff(x.edited_diff));
  return parts.join(', ');
}
/* «Было → стало» по отменённому или исправленному чеку: first_total/first_pay_kind — сумма и способ оплаты
   при первом сохранении, total/pay_kind — последние (у отменённого — перед отменой). Правка вниз перед
   отменой и смена наличных на перевод так видны собственнику. Старый сервер first_* не отдаёт — только итог. */
function wasNow(v) {
  var ft = v.first_total, fp = v.first_pay_kind;
  var sumCh = ft !== null && ft !== undefined && ft !== '' && Math.abs(num(ft) - num(v.total)) >= 0.01;
  var payCh = !!fp && !!v.pay_kind && fp !== v.pay_kind;
  return {
    sum: sumCh ? 'было ' + fmt(ft) + ' → стало ' + fmt(v.total) + ' ₸' + (v.kind === 'void' ? ' перед отменой' : '')
      : fmt(v.total) + ' ₸',
    pay: payCh ? 'было ' + payTitle(fp) + ' → стало ' + payTitle(v.pay_kind) : payTitle(v.pay_kind)
  };
}

/* Цифры сводки по ответу dashboard — отдельно от отрисовки (проверяются node-скриптом без экрана).
   Сдан — отчёт точки без кассы (его строку создаёт только сохранение) или закрытая смена кассы (строку
   кассы создаёт первый чек дня, и до закрытия день не сдан). Выручка незакрытой смены в итог идёт.
   «Не сдано» — дни без сданного отчёта по вчерашний день (сегодняшний ещё идёт), начиная с первого
   отчёта точки: до него точка в программе не работала (points[].first_report, миграция 0047; null —
   отчётов ещё не было). Старый сервер first_report не отдаёт — тогда с начала периода, как раньше. */
function dashStats(r, from, to, todayIso) {
  var rows = r.rows || [], pts = r.points || [];
  var hasFirst = pts.some(function (p) { return p && Object.prototype.hasOwnProperty.call(p, 'first_report'); });
  var st = { tot: 0, totPod: 0, flags: 0, submitted: 0, checks: 0, checksTotal: 0,
             hasChecks: Array.isArray(r.checks), hasFirst: hasFirst, list: [] };
  var byId = {};
  var P = function (id, name, mode) {
    if (!byId[id]) {
      byId[id] = { id: id, name: name, mode: mode, first: undefined, rev: 0, rowDays: 0, days: 0, dates: {},
                   badDays: 0, diff: 0, checks: null, missed: 0 };
      st.list.push(byId[id]);
    }
    return byId[id];
  };
  pts.forEach(function (p) { P(p.id, p.name, p.mode).first = hasFirst ? (p.first_report || null) : undefined; });
  rows.forEach(function (x) {
    var p = P(x.point_id, x.point_name, x.mode);
    st.tot += num(x.revenue_total); st.totPod += num(x.podotchet);
    p.rev += num(x.revenue_total); p.rowDays++;
    if (x.mode === 'checks' && !x.closed_at) return;   // смена идёт: сверять и считать сданным рано
    // Расхождения — на момент закрытия: чеки после закрытия не делают ложной недостачи (owner Д1).
    var v = closeView(x);
    var diffSum = Math.abs(num(v.diffQr)) + Math.abs(num(v.diffTr)) + Math.abs(num(v.diffCash));
    if (diffSum > 0 || num(x.expenses_no_receipt) > 0) { st.flags++; p.badDays++; }
    p.diff += diffSum;
    p.days++; p.dates[String(x.report_date).slice(0, 10)] = true; st.submitted++;
  });
  if (st.hasChecks) {
    r.checks.forEach(function (c) {
      var p = P(c.point_id, c.point_name, 'checks');
      p.checks = { n: num(c.checks), total: num(c.total), avg: num(c.avg) };
      st.checks += p.checks.n; st.checksTotal += p.checks.total;
    });
  }
  var y = parseDate(todayIso); y.setDate(y.getDate() - 1);
  var end = isoDate(y) < to ? isoDate(y) : to;   // ГГГГ-ММ-ДД сравниваются как строки
  st.list.forEach(function (p) {
    var start = from;
    if (p.first === null) { p.missed = null; return; }   // точка ещё ни разу не сдавала отчёт
    if (p.first && p.first > start) start = p.first;
    var n = 0;
    for (var d = parseDate(start), k = 0; isoDate(d) <= end && k < 3700; d.setDate(d.getDate() + 1), k++) {
      if (!p.dates[isoDate(d)]) n++;
    }
    p.missed = n;
  });
  st.list.sort(function (a, b) { return b.rev - a.rev; });
  return st;
}
function drawPointsTable(st) {
  var R = ' style="text-align:right"';
  $('phead').innerHTML = '<tr><th>Точка</th><th' + R + '>Выручка</th>' +
    (st.hasChecks ? '<th' + R + '>Чеков</th><th' + R + '>Средний чек</th>' : '') +
    '<th' + R + '>Сдано дней</th><th' + R + '>Не сдано</th><th' + R + '>В среднем в день</th>' +
    '<th' + R + '>Дней с расхождением</th><th' + R + '>Расхождение, ₸</th></tr>';
  var pb = $('pbody'); pb.innerHTML = '';
  if (!st.list.length) pb.innerHTML = '<tr><td colspan="' + (st.hasChecks ? 9 : 7) + '" class="empty">Отчётов пока нет</td></tr>';
  st.list.forEach(function (p) {
    var tr = document.createElement('tr');
    tr.innerHTML = '<td>' + esc(p.name) + '</td><td class="n b">' + fmt(p.rev) + '</td>' +
      (st.hasChecks
        ? '<td class="n">' + (p.checks ? p.checks.n : (p.mode === 'checks' ? '0' : '—')) + '</td>' +
          '<td class="n">' + (p.checks && p.checks.n ? fmt(p.checks.avg) : '—') + '</td>'
        : '') +
      '<td class="n">' + p.days + '</td>' +
      '<td class="n">' + (p.missed === null ? '<span title="Точка ещё не сдавала отчётов">—</span>'
        : p.missed ? '<span style="color:var(--bad);font-weight:700">' + p.missed + '</span>' : '0') + '</td>' +
      '<td class="n">' + fmt(p.rowDays ? p.rev / p.rowDays : 0) + '</td>' +
      '<td class="n">' + (p.badDays ? '<span style="color:var(--warn);font-weight:700">' + p.badDays + '</span>' : '—') + '</td>' +
      '<td class="n">' + (p.diff ? '<span style="color:var(--bad)">' + fmt(p.diff) + '</span>' : '—') + '</td>';
    pb.appendChild(tr);
  });
  $('phint').textContent = (st.hasChecks ? '«Чеков» и «Средний чек» — по чекам кассы (отменённые не считаются); у точек без кассы чеков нет. ' : '') +
    '«Не сдано» — дни без сданного отчёта ' + (st.hasFirst ? 'с первого отчёта точки' : 'с начала периода') +
    ' по вчерашний день; смена кассы считается сданной после закрытия.';
}
// 'master' — общий счётчик неверных кодов. Старый сервер называл его «общий замок входа собственника
// и водителя» — непонятно; пишем, что он делает (порог — в tandem_gate: 10 неверных за 5 минут).
function pinName(x) {
  if (x.key === 'master' && /общий замок/.test(x.name || '')) {
    return 'все неверные коды вместе (точки, собственник, водитель): после 10 ошибок за 5 минут вход собственника и водителя закрывается на 5 минут';
  }
  return x.name || x.key || '';
}
// Активные чеки, пришедшие после закрытия смены (L — из lateOf). kind: 'pill' — пометка в списке
// отчётов, 'owner' — раскрытый отчёт у собственника, иначе — полоса на экране закрытия смены.
function lateText(L, kind) {
  var what = L.n + ' ' + plural(L.n, 'чек', 'чека', 'чеков') + ' на ' + fmt(L.sum) + ' ₸' +
    (L.known ? ', наличными ' + fmt(L.cash) + ' ₸' : '');
  if (kind === 'pill') return 'после закрытия: ' + what + ' — закрыть смену заново';
  if (kind === 'owner') {
    return 'После закрытия смены пробито ' + what + (L.known
      ? ' — в «должно» и сверке выше их нет, это цифры на момент закрытия'
      : ' — они уже в суммах отчёта, а пересчёт кассы сделан до них') + '. Касса должна закрыть смену заново.';
  }
  return 'После закрытия пробито ' + what + ' — пересчитайте кассу и закройте смену заново';
}
// Время правки: в день отчёта — «ЧЧ:ММ», позже — «ДД.ММ, ЧЧ:ММ».
function whenShort(at, day) {
  var d = at ? new Date(at) : null;
  if (!d || isNaN(d)) return '';
  return isoDate(d) === String(day || '').slice(0, 10) ? hhmm(at) : dayTime(at);
}
// Пометки строки дня (миграция 0047): чеки после закрытия смены и правка уже сданного отчёта.
// Старый сервер этих полей не отдаёт — пометок нет.
function reportMarks(y) {
  var out = '', L = lateOf(y);
  if (L) out += ' <span class="pill bad">' + esc(lateText(L, 'pill')) + '</span>';
  if (y.edited_at) {
    out += ' <span class="pill warn" title="' + esc('Первая сдача ' + (dayTime(y.first_saved_at) || '—') +
      ', последнее изменение ' + dayTime(y.edited_at)) + '">исправлен ' + esc(whenShort(y.edited_at, y.report_date)) + '</span>';
  }
  return out;
}

// Возвращает обещание: true — сводка перерисована этим запросом (по нему раскрывается отчёт после
// «Открыть смену для исправления»), false — не обновилась или устарела.
function loadDash() {
  var seq = ++S.dashSeq;
  return api('dashboard', { from: $('dfrom').value, to: $('dto').value }).then(function (r) {
    if (seq !== S.dashSeq) return false;   // пока грузилось, выбрали другой период
    if (!r.ok) {
      $('derr').textContent = 'Сводка не обновилась: ' + (r.error || 'нет доступа') + (S.dash ? '. Ниже — данные прошлого запроса' : '');
      if (!S.dash) $('dbody').innerHTML = '<tr><td colspan="10" class="empty">' + esc(r.error || 'нет доступа') + '</td></tr>';
      return false;
    }
    $('derr').textContent = '';
    S.dash = r;
    var rows = r.rows || [];
    var stats = dashStats(r, $('dfrom').value, $('dto').value, today());
    $('k1').textContent = fmt(stats.tot) + ' ₸';
    $('k2').textContent = stats.submitted;
    $('k3').textContent = fmt(stats.totPod) + ' ₸';
    $('k4').textContent = stats.flags;
    $('k4').className = 'kv' + (stats.flags ? ' bad' : ' ok');
    // Чеки и средний чек — только когда сервер их считает (миграция 0047) и в периоде были чеки кассы.
    $('k5c').hidden = !stats.hasChecks || !stats.checks;
    $('k5').textContent = stats.checks ? stats.checks + ' · ' + fmt(stats.checksTotal / stats.checks) + ' ₸' : '—';

    drawPointsTable(stats);

    // ── Неверные коды за сутки ──
    var pins = r.pin_failures || [];
    $('dpins-card').hidden = !pins.length;
    $('dpins').textContent = '';
    pins.forEach(function (x) {
      var s = document.createElement('span');
      s.className = 'pill ' + (x.count >= 10 ? 'bad' : 'warn');
      s.style.margin = '0 6px 6px 0';
      s.textContent = pinName(x) + ': ' + x.count + ', последняя в ' + hhmm(x.last);
      $('dpins').appendChild(s);
    });

    // ── Не сдали за вчера ──
    var mis = r.missing || [];
    $('dmissing-card').hidden = !mis.length;
    if (mis.length) {
      $('dmissing').innerHTML = mis.map(function (m) {
        return '<span class="pill bad" style="margin:0 6px 6px 0">' + esc(m.name) + '</span>';
      }).join('');
    }

    // ── Отмены и исправления чеков за период ──
    // Касса уменьшает выручку отменой чека — собственник должен видеть каждую отмену с причиной.
    var voids = r.voids || [], vc = 0, vs = 0, ec = 0, ed = 0;
    rows.forEach(function (x) { vc += num(x.void_count); vs += num(x.void_sum); ec += num(x.edited_count); ed += num(x.edited_diff); });
    var hasKassa = (r.points || []).some(function (p) { return p.mode === 'checks'; });
    $('dvoids-card').hidden = !(voids.length || vc || ec || hasKassa);
    $('dvoids-sum').textContent = (vc || ec || voids.length)
      ? 'Отменено чеков: ' + vc + ' на ' + fmt(vs) + ' ₸ · исправлено: ' + ec + editDiff(ed) + (voids.length >= 300 ? ' · в списке последние 300' : '')
      : 'За период чеки не отменяли и не исправляли';
    var vb = $('dvoids'); vb.innerHTML = '';
    voids.forEach(function (v) {
      var tr = document.createElement('tr'), wn = wasNow(v);
      tr.innerHTML = '<td>' + esc(dmy(v.date)) + ' ' + esc(hhmm(v.at)) + '</td><td>' + esc(v.point_name) + '</td>' +
        '<td>' + (v.kind === 'void' ? '<span class="pill bad">отменён</span>' : '<span class="pill warn">исправлен</span>') + '</td>' +
        '<td class="n">' + (v.no === null || v.no === undefined ? '—' : '№ ' + esc(v.no)) + '</td>' +
        '<td class="n b">' + esc(wn.sum) + '</td><td>' + esc(wn.pay) + '</td>' +
        '<td>' + esc(v.reason || (v.kind === 'void' ? 'не указана' : '—')) + '</td><td>' + esc(v.seller || '—') + '</td>';
      vb.appendChild(tr);
    });
    $('dvoids-table').hidden = !voids.length;

    // ── Каналы и юрлица ──
    var ch = r.channels || {};
    var chTotal = num(ch.cash) + num(ch.kaspi_qr) + num(ch.transfer) + num(ch.card);
    var chHtml = '';
    [['Наличные', ch.cash], ['Kaspi QR', ch.kaspi_qr], ['Перевод на счёт', ch.transfer], ['Карта через терминал', ch.card]].forEach(function (c) {
      var share = chTotal ? Math.round(num(c[1]) / chTotal * 100) : 0;
      chHtml += '<div class="rrow"><span>' + c[0] + '</span><b>' + fmt(c[1]) + ' ₸ · ' + share + ' %</b></div>';
    });
    (r.by_legal || []).forEach(function (l) {
      chHtml += '<div class="rrow"><span style="color:var(--muted)">' + esc(l.legal) + '</span><b>' + fmt(l.revenue) + ' ₸</b></div>';
    });
    $('dchannels').innerHTML = chHtml || '<div class="empty">Отчётов за период нет</div>';

    // ── Топ позиций ──
    var tb = $('dtop'); tb.innerHTML = '';
    (r.top_items || []).forEach(function (t) {
      var tr = document.createElement('tr');
      tr.innerHTML = '<td>' + esc(t.name) + '</td><td class="n">' + fmt(t.qty) + '</td>' +
        '<td class="n b">' + fmt(t.amount) + '</td>' +
        '<td class="n">' + (num(t.discount) > 0 ? '<span style="color:var(--warn)">' + fmt(t.discount) + '</span>' : '—') + '</td>';
      tb.appendChild(tr);
    });
    if (!(r.top_items || []).length) tb.innerHTML = '<tr><td colspan="4" class="empty">Позиционных данных за период нет</td></tr>';

    // ── Расход сырья ──
    // Единица — ингредиента (брутто в техкарте в ней же): яйца в штуках, чай в пачках. Старый сервер
    // единицу не отдаёт — тогда без единицы, а не «кг» всем подряд, как было.
    $('draw').innerHTML = (r.raw_usage || []).length
      ? r.raw_usage.map(function (u) {
          return '<div class="rrow"><span>' + esc(u.name) + '</span><b>' + fmtQty(u.amount) +
            (u.unit_id ? ' ' + esc(u.unit_id) : '') + '</b></div>';
        }).join('')
      : '<div class="empty">Продаж с техкартами за период нет</div>';

    // ── Долги по реализации ──
    $('ddebts').innerHTML = (r.realization || []).length
      ? r.realization.map(function (d) {
          return '<div class="rrow"><span>' + esc(d.name) + '</span><b style="' +
            (num(d.debt) > 100000 ? 'color:var(--bad)' : 'color:var(--warn)') + '">' + fmt(d.debt) + ' ₸</b></div>';
        }).join('')
      : '<div class="empty">Долгов нет</div>';

    var b = $('dbody'); b.innerHTML = '';
    if (!rows.length) { b.innerHTML = '<tr><td colspan="10" class="empty">Отчётов за период нет</td></tr>'; return true; }
    for (var j = 0; j < rows.length; j++) {
      var y = rows[j];
      // Расхождения — на момент закрытия (closeView): чеки после закрытия — отдельной пометкой, не недостачей.
      // «QR 660» было непонятно (owner У1) — пишем, с чем не сошлось.
      var issues = [], cv = closeView(y);
      if (num(cv.diffQr) !== 0) issues.push('Kaspi QR: расхождение с выпиской ' + fmt(Math.abs(cv.diffQr)) + ' ₸');
      if (num(cv.diffTr) !== 0) issues.push('переводы: расхождение с выпиской ' + fmt(Math.abs(cv.diffTr)) + ' ₸');
      if (num(cv.diffCash) !== 0) issues.push(cashDiffText(cv.diffCash).toLowerCase());
      if (num(y.expenses_no_receipt) > 0) issues.push('без чека: ' + num(y.expenses_no_receipt));
      if (y.qr_statement === null && y.tr_statement === null) issues.push('нет сверки');
      var vbadge = voidBadge(y);
      var open = y.mode === 'checks' && !y.closed_at;   // касса: строку создал первый чек, смена ещё идёт
      var trr = document.createElement('tr');
      trr.style.cursor = 'pointer';
      trr.dataset.key = y.point_id + '|' + y.report_date;
      trr.innerHTML = '<td>' + esc(dmy(y.report_date)) + '</td><td>' + esc(y.point_name) + '</td>' +
        '<td class="n">' + fmt(y.cash) + '</td><td class="n">' + fmt(y.kaspi_qr) + '</td>' +
        '<td class="n">' + fmt(y.transfer) + '</td><td class="n">' + fmt(y.card) + '</td><td class="n b">' + fmt(y.revenue_total) + '</td>' +
        '<td class="n">' + fmt(y.cash_handed) + '</td><td class="n">' + fmt(y.podotchet) + '</td>' +
        // У незакрытой смены сверки и пересчёта ещё нет по определению — «нет сверки» там шум.
        '<td>' + (open ? '<span class="pill warn">смена не закрыта</span>'
          : issues.length ? '<span class="pill bad">' + esc(issues.join(' · ')) + '</span>' : '<span class="pill ok">ОК</span>') +
        reportMarks(y) +
        (vbadge ? ' <span class="pill warn">' + esc(vbadge) + '</span>' : '') + '</td>';
      (function (row, tr) { tr.onclick = function () { toggleReportDetail(tr, row); }; })(y, trr);
      b.appendChild(trr);
    }
    return true;
  }).catch(function (e) { $('derr').textContent = 'Ошибка на странице: ' + e.message; return false; });
}

/* Раскрытие отчёта прямо в сводке: собственник видит весь день точки,
   не выходя из дашборда, — позиции, заборный лист, расходы, отмены чеков, комментарий.
   note — строка сверху раскрытого отчёта (итог «Открыть смену для исправления»). */
function toggleReportDetail(tr, row, note) {
  var next = tr.nextElementSibling;
  if (next && next.className === 'detail-row') { next.remove(); return; }
  var open = tr.parentNode.querySelector('.detail-row');
  if (open) open.remove();

  var dtr = document.createElement('tr');
  dtr.className = 'detail-row';
  dtr.innerHTML = '<td colspan="10" style="background:#F7F9FC;padding:14px 16px">Загружаю отчёт…</td>';
  tr.parentNode.insertBefore(dtr, tr.nextSibling);

  var H = function (t) { return '<b style="font-size:12px;text-transform:uppercase;color:var(--muted)">' + t + '</b>'; };
  post('get_report', { pin: S.pin, point_id: row.point_id, date: row.report_date }).then(function (d) {
    if (!d.ok) {
      dtr.innerHTML = '<td colspan="10" style="padding:14px 16px;color:var(--bad)">Не удалось загрузить отчёт: ' + esc(d.error || 'ошибка сервера') + '</td>';
      return;
    }
    var html = '<td colspan="10" style="background:#F7F9FC;padding:14px 16px">';
    if (note) html += '<div class="msg" style="text-align:left;margin:0 0 12px">' + esc(note) + '</div>';
    var sl = d.sales || [], tk = d.takeout || [], ex = d.expenses || [], vl = d.voids || [];

    if (sl.length) {
      html += H('Продажи по позициям (' + sl.length + ')');
      var sTot = 0, sDisc = 0;
      html += '<div style="margin:6px 0 12px">';
      sl.forEach(function (x) {
        var line = num(x.qty) * num(x.price); sTot += line;
        var disc = num(x.price_list) > num(x.price) ? num(x.qty) * (num(x.price_list) - num(x.price)) : 0;
        sDisc += disc;
        html += '<div class="rrow"><span>' + esc(x.item_name) + ' × ' + fmt(x.qty) +
          (disc ? ' <span style="color:var(--warn)">(скидка ' + fmt(disc) + ')</span>' : '') +
          '</span><b>' + fmt(line) + ' ₸</b></div>';
      });
      html += '<div class="rrow"><span><b>Итого по позициям</b>' +
        (sDisc ? ' · скидок на ' + fmt(sDisc) + ' ₸' : '') + '</span><b>' + fmt(sTot) + ' ₸</b></div></div>';
    }
    if (tk.length) {
      html += H('Заборный лист (' + tk.length + ')');
      var tTot = 0;
      html += '<div style="margin:6px 0 12px">';
      tk.forEach(function (x) {
        var sold = num(x.issued) - num(x.returned);
        var line = sold * num(x.price); tTot += line;
        html += '<div class="rrow"><span>' + esc(x.item_name) + ': выдано ' + fmt(x.issued) +
          ', остаток ' + fmt(x.returned) + ' → продано ' + fmt(sold) + '</span><b>' + fmt(line) + ' ₸</b></div>';
      });
      html += '<div class="rrow"><span><b>Итого по листу</b></span><b>' + fmt(tTot) + ' ₸</b></div></div>';
    }
    if (ex.length) {
      html += H('Расходы из кассы (изъятие)');
      html += '<div style="margin:6px 0 12px">';
      ex.forEach(function (x) {
        html += '<div class="rrow"><span>' + esc(x.purpose || '—') +
          (x.receipt_no ? ' · чек № ' + esc(x.receipt_no) : ' · <span style="color:var(--bad)">без чека</span>') +
          '</span><b>' + fmt(x.amount) + ' ₸</b></div>';
      });
      html += '</div>';
    }
    // Отмены и исправления чеков этого дня: что, когда, кто и почему.
    if (vl.length) {
      html += H('Отмены и исправления чеков (' + vl.length + ')');
      html += '<div style="margin:6px 0 12px">';
      vl.forEach(function (v) {
        var isVoid = v.kind === 'void', wn = wasNow(v);
        html += '<div class="rrow"><span>' +
          (isVoid ? '<b style="color:var(--bad)">Отменён</b>' : '<b style="color:var(--warn)">Исправлен</b>') +
          ' чек' + (v.no === null || v.no === undefined ? '' : ' № ' + esc(v.no)) +
          (hhmm(v.at) ? ' · ' + esc(hhmm(v.at)) : '') +
          ' · ' + esc(v.seller || 'продавец не указан') +
          (isVoid ? ' · причина: ' + esc(v.reason || 'не указана') : (v.reason ? ' · ' + esc(v.reason) : '')) +
          (wn.pay ? ' · ' + esc(wn.pay) : '') +
          '</span><b>' + esc(wn.sum) + '</b></div>';
      });
      html += '</div>';
    }
    var rep = d.report || {};
    var isKassa = (rep.mode || row.mode) === 'checks';
    // Пометки дня (миграция 0047) get_report отдаёт в report, строка сводки — тоже; report свежее.
    var src = {}, kk;
    for (kk in row) src[kk] = row[kk];
    for (kk in rep) src[kk] = rep[kk];
    var cv = closeView(src), late = cv.late, edited = src.edited_at;
    html += H('Деньги') + '<div style="margin:6px 0 0">';
    var by = splitBy(src.shift_by);
    html += '<div class="rrow"><span>Сдал: ' + esc(by.who || '—') + (by.first ? ' · первым закрыл: ' + esc(by.first) +
      (src.first_saved_at ? ' (' + esc(whenShort(src.first_saved_at, src.report_date)) + ')' : '') : '') + '</span><span></span></div>';
    // Чеки после закрытия смены (owner Д1): ниже — цифры на момент закрытия, поздние чеки — отдельной строкой.
    if (cv.shifted) {
      html += '<div class="hint" style="margin:2px 0 4px">Сверка и касса — на момент закрытия смены' +
        (src.closed_at ? ' ' + esc(whenShort(src.closed_at, src.report_date)) : '') + ': чеки после закрытия в них не входят.</div>';
    }
    // Сверка с выписками словами (owner У1): «Kaspi QR: по чекам X, по выписке Y — расхождение Z» вместо «QR 660».
    var stLine = function (title, sum, st, diff) {
      if (!num(sum) && (st === null || st === undefined)) return '';
      var noSt = st === null || st === undefined;
      return '<div class="rrow"><span>' + title + ': ' + (isKassa ? 'по чекам ' : 'по отчёту ') + fmt(sum) + ' ₸' +
        (noSt ? ' · по выписке не сверяли' : ', по выписке ' + fmt(st) + ' ₸') + '</span>' +
        (noSt ? '<b style="color:var(--muted)">—</b>'
          : num(diff) ? '<b style="color:var(--bad)">расхождение ' + fmt(Math.abs(diff)) + ' ₸</b>'
          : '<b style="color:var(--ok)">сходится</b>') + '</div>';
    };
    html += stLine('Kaspi QR', cv.kaspi, src.qr_statement, cv.diffQr);
    html += stLine('Переводы', cv.transfer, src.tr_statement, cv.diffTr);
    // «Должно» с расшифровкой: без неё «должно 11 460 ₸» при наличных 2 960 ₸ непонятно, откуда взялось.
    var counted = src.cash_counted !== null && src.cash_counted !== undefined;
    var dc = num(cv.diffCash);
    html += '<div class="rrow"><span>Касса: должно ' + fmt(cv.expected) + ' ₸ = размен ' + fmt(src.cash_open) +
      ' + наличные ' + fmt(cv.cash) + (num(src.cash_handed) ? ' − сдано ' + fmt(src.cash_handed) : '') +
      ' − расходы из кассы ' + fmt(src.podotchet) + ' · пересчитано ' +
      (counted ? fmt(src.cash_counted) + ' ₸' : 'не пересчитана') + '</span>' +
      (!counted ? '<b style="color:var(--muted)">—</b>'
        : dc > 0 ? '<b style="color:var(--bad)">' + cashDiffText(dc) + '</b>'
        : dc < 0 ? '<b style="color:var(--warn)">' + cashDiffText(dc) + '</b>'
        : '<b style="color:var(--ok)">сходится</b>') + '</div>';
    if (late) {
      html += '<div class="rrow"><span style="color:var(--bad);font-weight:600">' + esc(lateText(late, 'owner')) + '</span><span></span></div>';
    }
    if (src.comment) html += '<div class="rrow"><span>Комментарий: ' + esc(src.comment) + '</span><span></span></div>';
    if (edited) {
      html += '<div class="rrow"><span style="color:var(--warn)">Отчёт исправлен ' + esc(dayTime(edited)) +
        ' (первая сдача ' + esc(dayTime(rep.first_saved_at || row.first_saved_at) || '—') + ')</span><span></span></div>';
    }
    html += '</div>';
    if (!sl.length && !tk.length && !ex.length && !isKassa) {
      html += '<div class="hint">Позиций в этом отчёте нет — точка сдала только суммы.</div>';
    }
    // Касса: закрытую смену собственник может открыть для исправления — после закрытия касса не принимает
    // ни правок, ни отмен чеков этого дня («Смена закрыта — чек уже не изменить. Обратитесь в офис»).
    if (isKassa) {
      html += '<div style="margin-top:12px">' + (rep.closed_at
        ? '<div class="hint" style="margin:0 0 8px">Смена закрыта ' + esc(dayTime(rep.closed_at)) + '. Если нужно исправить ' +
          'или отменить чек этого дня, откройте смену: касса снова примет правки, потом точка закроет смену заново.</div>' +
          '<button class="small ghost" type="button" data-act="reopen">Открыть смену для исправления</button>'
        : '<div class="hint" style="margin:0">Смена ещё не закрыта: точка закроет её на экране отчёта.</div>') +
        '<div class="hint" data-msg="reopen" style="margin-top:6px"></div></div>';
    }
    html += '</td>';
    dtr.innerHTML = html;
    var rb = dtr.querySelector('[data-act="reopen"]');
    if (rb) rb.onclick = function () { reopenShift(row, rb, dtr.querySelector('[data-msg="reopen"]')); };
  }).catch(function () {
    dtr.innerHTML = '<td colspan="10" style="padding:14px 16px;color:var(--bad)">Не удалось показать отчёт</td>';
  });
}

/* «Открыть смену для исправления» (tandem_api reopen_shift, только код собственника): снимает закрытие
   с отчёта кассы за этот день — касса снова принимает правки и отмены чеков, точка потом закрывает смену
   заново. После ответа сводка перечитывается (день снова не сдан, значки отмен) и отчёт раскрывается обновлённым. */
function reopenShift(row, btn, msg) {
  var day = dmy(row.report_date);
  if (!window.confirm('Открыть смену «' + (row.point_name || '') + '» за ' + day + ' для исправления?\n\n' +
      'Касса снова сможет исправлять и отменять чеки этого дня. Потом точка должна закрыть смену заново — ' +
      'до этого день считается несданным.')) return;
  var seq = S.dashSeq;
  btn.disabled = true;
  msg.className = 'hint'; msg.textContent = 'Открываю смену…';
  post('reopen_shift', { pin: S.pin, point_id: row.point_id, date: row.report_date }).then(function (r) {
    if (S.role !== 'owner' || seq !== S.dashSeq) return;   // пока ждали, вышли или перестроили сводку
    if (!r.ok) {
      btn.disabled = false; msg.className = 'err';
      msg.textContent = r.offline ? 'Нет связи — не ясно, открылась ли смена. Нажмите «Показать» и проверьте'
        : 'Смена не открылась: ' + (r.error || 'ошибка сервера');
      return;
    }
    msg.className = 'hint'; msg.textContent = 'Смена открыта. Обновляю сводку…';
    var key = row.point_id + '|' + row.report_date;
    loadDash().then(function (ok) {
      if (!ok) { msg.textContent = 'Смена открыта, но сводка не обновилась — нажмите «Показать»'; return; }
      var trs = $('dbody').children, rows = (S.dash && S.dash.rows) || [];
      for (var i = 0; i < trs.length; i++) {
        if (!trs[i].dataset || trs[i].dataset.key !== key) continue;
        for (var j = 0; j < rows.length; j++) {
          if (rows[j].point_id + '|' + rows[j].report_date !== key) continue;
          toggleReportDetail(trs[i], rows[j], 'Смена открыта для исправления: касса снова принимает правки и отмены ' +
            'чеков этого дня. После исправления точка закроет смену заново.');
          return;
        }
      }
    });
  });
}

function exportCsv() {
  if (!S.dash || !S.dash.rows) return;
  var rows = S.dash.rows;
  var head = ['Дата', 'Точка', 'Наличные', 'Kaspi QR', 'Перевод', 'Карта', 'Итого', 'Сдано', 'Расходы из кассы',
    'Расх. QR', 'Расх. перевод', 'Касса: недостача (+) / излишек (−)', 'Чеков после закрытия', 'Чеки после закрытия, ₸',
    'Отчёт исправлен'];
  // Расхождения — на момент закрытия смены, как на экране (closeView); суммы по каналам — весь день.
  // Точка с запятой — разделитель колонок для русского Excel: в названиях и тексте её заменяем запятой.
  // Числа — с запятой: «1234.5» русский Excel читает как текст или дату.
  var cell = function (v) {
    if (v === null || v === undefined) return '';
    return typeof v === 'number' ? numStr(v) : String(v).replace(/[;\r\n]+/g, ', ');
  };
  var lines = [head.join(';')];
  for (var i = 0; i < rows.length; i++) {
    var x = rows[i], cv = closeView(x);
    lines.push([dmy(x.report_date), x.point_name, x.cash, x.kaspi_qr, x.transfer, x.card, x.revenue_total,
      x.cash_handed, x.podotchet, cv.diffQr, cv.diffTr, cv.diffCash,
      cv.late ? cv.late.n : '', cv.late ? cv.late.sum : '', x.edited_at ? dayTime(x.edited_at) : ''].map(cell).join(';'));
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
  $('btn-owner-toggle').onclick = function () {
    $('ownerbox').hidden = !$('ownerbox').hidden;
    if (!$('ownerbox').hidden) $('opin').focus();
  };
  // Enter в поле кода — вход, как кнопка рядом (owner У6): без мыши.
  var enterTo = function (id, asOwner) {
    $(id).addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      if (!$(asOwner ? 'btn-owner' : 'btn-login').disabled) doLogin(asOwner);
    });
    // Новый код набирается поверх старого, а не дописывается к нему.
    $(id).addEventListener('focus', function () {
      var t = this;
      setTimeout(function () { try { if (document.activeElement === t) t.select(); } catch (e) { } }, 0);
    });
  };
  enterTo('opin', true); enterTo('lpin', false);
  $('lpoint').addEventListener('change', pointChanged);
  $('date').onchange = loadReport;
  $('addexp').onclick = addExp;
  $('savebtn').onclick = saveReport;
  $('reloadbtn').onclick = reloadForm;
  // Касса в соседней вкладке досылает чеки — предупреждение о неотправленных обновляется само.
  window.addEventListener('storage', function (e) { if (e.key && e.key.indexOf('tandem_kassa_queue_') === 0) drawKassaQueue(); });
  window.addEventListener('focus', drawKassaQueue);
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
  var ids = ['cash', 'kaspi_qr', 'transfer', 'card', 'qr_statement', 'tr_statement', 'cash_open', 'cash_handed', 'cash_counted'];
  for (var i = 0; i < ids.length; i++) {
    $(ids[i]).oninput = recalc;
    // Enter — к следующему изменяемому полю денег (у кассы суммы по каналам только для чтения), с последнего — в комментарий.
    (function (k) {
      numField($(ids[k]), function () {
        for (var j = k + 1; j < ids.length; j++) { if (!$(ids[j]).readOnly) return $(ids[j]); }
        return $('comment');
      });
    })(i);
  }
  ['rdeliv', 'rpaid', 'rret'].forEach(function (id, k, a) { numField($(id), $(a[k + 1] || 'rnote')); });
});
