(function () {
  "use strict";

  var KEY = "stock-pl-calculator-v4";
  var KEY_OLD = ["stock-pl-calculator-v3", "stock-pl-calculator-v2"];
  var $ = function (s) { return document.querySelector(s); };
  var tbody = $("#tbody");
  var hbody = $("#hbody");

  var DEF_FEES = { commBuy: 0.01, commSell: 0.01, stamp: 0.05, transfer: 0, minComm: 0 };
  /* 盈亏提醒：profit / loss 都是"幅度"（正数），0 表示该方向不提醒；
     plan = 是否启用「止损 / 目标到线提醒」（默认开，只对填了止损或目标的头寸生效） */
  var DEF_ALERT = { on: false, profit: 0, loss: 0, plan: true };
  /* 分位提醒：low / high 是 15 日分位的百分比阈值（0~100） */
  var DEF_KLINE = { on: false, low: 25, high: 75 };
  function normalizeAlert(o) {
    o = o && typeof o === "object" ? o : {};
    return {
      on: !!o.on,
      profit: Math.max(0, num(o.profit) || 0),
      loss: Math.max(0, num(o.loss) || 0),
      plan: o.plan !== false            // 止损/目标提醒默认开
    };
  }
  function normalizeKlineAlert(o) {
    o = o && typeof o === "object" ? o : {};
    function clamp(v, d) { var n = num(v); return isFinite(n) ? Math.min(100, Math.max(0, n)) : d; }
    return { on: !!o.on, low: clamp(o.low, DEF_KLINE.low), high: clamp(o.high, DEF_KLINE.high) };
  }
  var DEF_SETTINGS = { auto: false, interval: 30, alert: DEF_ALERT, kline: DEF_KLINE };
  /* 闩锁表（按行情代码存布尔）：分位提醒触发过一次就不再弹，回到线内 5 个百分点才重新武装 */
  function normLatchMap(x) {
    var out = {};
    if (x && typeof x === "object") Object.keys(x).forEach(function (k) { out[k] = !!x[k]; });
    return out;
  }

  /* 侧栏的国际大宗商品。接口代码用腾讯行情，注意这类品种的返回格式是「逗号分隔」，
     和 A股/港股/美股 的「~ 分隔」完全不同，解析要走 fetchCommodities。
     hf_CL 接口里的名字是「纽约原油」，即 NYMEX WTI 轻质原油。 */
  var COMMODITIES = [
    { key: "hf_CL",  label: "WTI 原油",  sub: "NYMEX" },
    { key: "hf_OIL", label: "布伦特原油", sub: "ICE" },
    { key: "hf_XAU", label: "伦敦金现",  sub: "XAU/USD" }
  ];

  var state = { fees: Object.assign({}, DEF_FEES), settings: Object.assign({}, DEF_SETTINGS),
                stocks: [], hist: [], recovery: [], lastBackupAt: "", comm: { updatedAt: "", q: {} },
                watch: [],
                /* K线缓存（行情快照，同 state.comm，故意不进备份 JSON） */
                kline: { updatedAt: "", d: {} },
                /* 提醒的「已触发」闩锁：触发过一次就不再重复弹窗，回到线内才重新武装。
                   只存本地，故意不进备份 JSON（属于运行状态，不是用户数据）。
                   pm = 止损/目标提醒的闩锁，键形如 "<股票id>:s"（止损）/"<股票id>:t"（目标） */
                alertState: { p: false, l: false, k: { low: {}, high: {} }, pm: {} } };
  /* 深拷一层，避免 settings.alert / settings.kline 与默认对象共用同一个引用 */
  state.settings.alert = normalizeAlert(state.settings.alert);
  state.settings.kline = normalizeKlineAlert(state.settings.kline);
  var seq = 0;
  var uid = function (p) { return (p || "x") + (++seq) + Date.now().toString(36); };

  var nf = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var EPS = 1e-6;

  /* ================= 工具 ================= */
  function num(v) {
    if (v === null || v === undefined) return NaN;
    var s = String(v).replace(/[,，\s%]/g, "");
    if (s === "" || s === "-") return NaN;
    var n = Number(s);
    return isFinite(n) ? n : NaN;
  }
  function normalizeFees(fees) {
    var out = {};
    Object.keys(DEF_FEES).forEach(function (k) {
      var v = num(fees && fees[k]);
      out[k] = isFinite(v) && v >= 0 ? v : DEF_FEES[k];
    });
    return out;
  }
  function money(n, withSign) {
    if (!isFinite(n)) return "—";
    var sign = withSign ? (n > 0 ? "+" : (n < 0 ? "-" : "")) : "";
    return sign + "¥" + nf.format(Math.abs(n));
  }
  function yuan(n) { return isFinite(n) ? "¥" + nf.format(n) : "—"; }
  /* 每股价格保留 3 位小数（含费成本 / 开仓均价常有多位精度，与券商 App 展示习惯一致） */
  function price3(n) { return isFinite(n) ? "¥" + n.toFixed(3) : "—"; }
  /* 强制清盘里的均价展示：最多 4 位小数（均价常除不尽），末尾多余的 0 去掉，
     但至少保留 2 位 —— 否则 ¥145.0000 会显示成 ¥145，看起来不像价格。 */
  function pexact(n) {
    if (!isFinite(n)) return "—";
    var t = n.toFixed(4).replace(/0+$/, "");
    var i = t.indexOf(".");
    if (i < 0) return t + ".00";
    return t.length - i - 1 < 2 ? n.toFixed(2) : t;
  }
  function pct(n) {
    if (!isFinite(n)) return "—";
    return (n > 0 ? "+" : "") + (n * 100).toFixed(2) + "%";
  }
  function fmtQty(n) {
    if (!isFinite(n)) return "0";
    return nf.format(Math.round(n * 10000) / 10000).replace(/\.00$/, "");
  }
  function cls(n) {
    if (!isFinite(n) || Math.abs(n) < 0.005) return "flat";
    return n > 0 ? "up" : "down";
  }
  function r2(x) { return Math.round(x * 100) / 100; }
  function qtyEq(a, b) { return Math.abs(a - b) < EPS; }
  function todayStr() {
    var d = new Date(), p = function (x) { return (x < 10 ? "0" : "") + x; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }
  function esc(s) { return '"' + String(s === undefined || s === null ? "" : s).replace(/"/g, '""') + '"'; }
  function nameHtml(s) { return s ? String(s).replace(/[<>&]/g, "") : '<span style="color:#b3bcc9">未命名</span>'; }
  function isShort(s) { return s.dir === "short"; }
  function dirName(s) { return isShort(s) ? "空头" : "多头"; }
  function dirPill(dir, asButton) {
    var sh = dir === "short";
    var title = sh ? "做空：先卖出开仓、后买入平仓（点击切换为多头）" : "做多：先买入建仓、后卖出平仓（点击切换为空头）";
    var t = sh ? "空" : "多";
    if (asButton) return '<button class="dir ' + (sh ? "short" : "long") + '" title="' + title + '">' + t + '</button>';
    return '<span class="dir ' + (sh ? "short" : "long") + '" title="' + (sh ? "做空" : "做多") + '">' + t + '</span>';
  }

  /* ================= 实时行情（腾讯免费接口，浏览器直接跨域可用） ================= */
  /* 把用户填的代码规范成行情接口认识的写法 */
  function toQuoteCode(raw) {
    if (raw === null || raw === undefined) return "";
    var s = String(raw).trim().toLowerCase().replace(/\s+/g, "");
    if (s === "") return "";
    if (/^(sh|sz|bj|hk|us)[0-9a-z.\-]+$/.test(s)) return s;          // 已带前缀
    if (/^\d{3,5}$/.test(s)) return "hk" + ("00000" + s).slice(-5);   // 港股（3~5 位）
    if (/^\d{6}$/.test(s)) {
      /* 北交所 920xxx 是 2024-08 起启用的新代码段，必须排在「9 → 沪市」前面判，
         否则会被当成沪市代码（920002 → sh920002），实时价与K线全都取不到。 */
      if (/^920/.test(s)) return "bj" + s;      // 北交所新代码段
      if (/^[569]/.test(s)) return "sh" + s;    // 沪市 A/B股（900xxx 是沪B）、基金
      if (/^[0123]/.test(s)) return "sz" + s;   // 深市 A/B股、基金
      if (/^[48]/.test(s)) return "bj" + s;     // 北交所存量代码段（43/83/87/88）
      return "sh" + s;
    }
    if (/^[a-z][a-z.\-]{0,9}$/.test(s)) return "us" + s.toUpperCase(); // 美股
    return "";
  }
  function qKey(code) { return String(code === null || code === undefined ? "" : code).toLowerCase(); }
  /* 价格显示：默认 2 位小数；若 2 位会丢精度（如 0.056）则用 3 位 */
  function priceStr(n) {
    if (!isFinite(n)) return "";
    var dec = Math.abs(n * 100 - Math.round(n * 100)) < 1e-9 ? 2 : 3;
    return n.toFixed(dec);
  }
  function nowTimeStr() {
    var d = new Date(), p = function (x) { return (x < 10 ? "0" : "") + x; };
    return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }
  /* 行情缓存：qKey -> {name, price, prevClose, pct, time} */
  var quotes = {};

  /* ============================================================
     取行情原文：优先 fetch，被拦时自动退回 script 标签
     ------------------------------------------------------------
     这个接口返回的本来就是 JS 赋值语句：
         v_sh600519="1~贵州茅台~600519~1264.96~...";
     所以完全可以用 script 标签加载（它的 src 指向该地址）—— 而**脚本标签不受 CORS 限制**，
     于是「fetch 被跨域策略 / 受限的嵌入页面拦掉」这种情况能自动救回来。
     （file:// 打开的页面 Origin 是 null，有些浏览器/安全软件会拦这类请求。）

     quoteVia 记录这次实际走通的通道，用于在状态栏如实说明：
       "fetch" = 正常 ; "script" = 备用方式 ; "" = 两条都不通（真·网络问题）
     ============================================================ */
  var quoteVia = "";

  function loadQuoteText(url, keys) {
    function viaScript() {
      return new Promise(function (resolve, reject) {
        var el = document.createElement("script");
        el.charset = "gbk";                 // 接口是 GBK，不声明中文名会乱码
        el.src = url;
        var settled = false;
        function finish(err) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (el.parentNode) el.parentNode.removeChild(el);
          if (err) { reject(err); return; }
          /* 脚本把值挂在 window.v_xxx 上，拼回与 fetch 一致的文本格式再交给解析 */
          var txt = "";
          keys.forEach(function (k) {
            var v = window["v_" + k];
            if (typeof v !== "string") v = window["v_" + String(k).toLowerCase()];
            if (typeof v !== "string") v = window["v_" + String(k).toUpperCase()];
            if (typeof v === "string") {
              txt += 'v_' + k + '="' + v + '";';
              try { delete window["v_" + k]; } catch (e) {}
            }
          });
          if (!txt) { reject(new Error("备用方式没取到数据")); return; }
          quoteVia = "script";
          resolve(txt);
        }
        var timer = setTimeout(function () { finish(new Error("加载超时")); }, 8000);
        el.onload = function () { finish(null); };
        el.onerror = function () { finish(new Error("脚本加载失败")); };
        document.head.appendChild(el);
      });
    }

    if (typeof fetch !== "function") return viaScript();
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.arrayBuffer();
    }).then(function (buf) {
      /* 接口返回 GBK 编码，必须显式用 gbk 解码，否则中文名乱码 */
      quoteVia = "fetch";
      return new TextDecoder("gbk").decode(buf);
    }).catch(function () {
      return viaScript();                   // fetch 这条路走不通，改用脚本标签
    });
  }

  function parseQuoteLines(txt, fn) {
    var out = {};
    txt.split(";").forEach(function (line) {
      var m = line.match(/v_([\w.\-]+)="([^"]*)"/);
      if (!m) return;
      fn(out, qKey(m[1]), m[2]);
    });
    return out;
  }

  function fetchQuotes(codes) {
    var url = "https://qt.gtimg.cn/q=" + codes.join(",");
    return loadQuoteText(url, codes).then(function (txt) {
      return parseQuoteLines(txt, function (out, key, body) {
        var f = body.split("~");
        var price = num(f[3]);
        if (!(price > 0)) return;               // 停牌 / 代码无效
        out[key] = {
          name: f[1] || "", price: price, prevClose: num(f[4]),
          pct: num(f[32]), time: f[30] || ""
        };
      });
    });
  }

  /* 国际大宗商品（原油 / 贵金属）：同一域名，但返回是逗号分隔，字段位置也不同。
     实测字段：0=现价 1=涨跌幅% 2=买价 3=卖价 4=最高 5=最低 6=行情时间
               7=昨收 8=今开 12=日期 13=名称 */
  function fetchCommodities() {
    var keys = COMMODITIES.map(function (m) { return m.key; });
    var url = "https://qt.gtimg.cn/q=" + keys.join(",");
    return loadQuoteText(url, keys).then(function (txt) {
      return parseQuoteLines(txt, function (out, key, body) {
        var c = body.split(",");
        var price = num(c[0]);
        if (!(price > 0)) return;              // 休市 / 代码无效
        out[key] = {
          name: c[13] || "", price: price, pct: num(c[1]), prevClose: num(c[7]),
          open: num(c[8]), high: num(c[4]), low: num(c[5]),
          time: c[6] || "", date: c[12] || ""
        };
      });
    });
  }

  /* ---------- 侧栏商品的渲染与刷新 ---------- */
  function renderCommodities() {
    var box = $("#commRows");
    if (!box) return;
    box.innerHTML = COMMODITIES.map(function (m) {
      var q = state.comm.q[m.key];
      var price = q ? q.price : NaN, pct = q ? q.pct : NaN;
      var tip = m.label + "（" + (q && q.name ? q.name : m.sub) + "）";
      if (q) {
        tip += "　昨收 " + nf.format(q.prevClose) + "　今开 " + nf.format(q.open) +
          "　最高 " + nf.format(q.high) + "　最低 " + nf.format(q.low) +
          (q.time ? "　行情时间 " + q.time : "");
      }
      tip += "　· 腾讯行情免费接口，仅供参考";
      return '<div class="comm-row" title="' + tip.replace(/"/g, "&quot;") + '">' +
        '<div class="cl"><span class="cn">' + m.label + '</span><span class="cs">' + m.sub + "</span></div>" +
        '<div class="cv"><span class="cp">' + (isFinite(price) ? nf.format(price) : "—") + "</span>" +
        '<span class="cc ' + (isFinite(pct) ? cls(pct) : "flat") + '">' +
        (isFinite(pct) ? (pct > 0 ? "+" : "") + pct.toFixed(2) + "%" : "—") + "</span></div>" +
        "</div>";
    }).join("");
    paintCommNote();
  }

  function paintCommNote(text, isErr) {
    var note = $("#commNote");
    if (!note) return;
    if (text) {
      note.textContent = text;
      note.className = "comm-note" + (isErr ? " warnc" : "");
      return;
    }
    var any = COMMODITIES.some(function (m) { return state.comm.q[m.key]; });
    if (!any) {
      note.textContent = "尚未刷新 · 点右侧 ⟳ 取价";
      note.className = "comm-note";
      return;
    }
    note.textContent = "上次更新 " + isoHhmm(state.comm.updatedAt) + "（点 ⟳ 刷新）";
    note.className = "comm-note";
  }
  function isoHhmm(iso) {
    var d = new Date(iso);
    if (!iso || isNaN(d.getTime())) return "—";
    var p = function (x) { return (x < 10 ? "0" : "") + x; };
    return p(d.getHours()) + ":" + p(d.getMinutes());
  }

  var commRefreshing = false;
  function refreshCommodities() {
    if (commRefreshing) return;
    commRefreshing = true;
    paintCommNote("刷新中…", false);
    fetchCommodities().then(function (res) {
      var hit = 0;
      COMMODITIES.forEach(function (m) {
        var q = res[qKey(m.key)];
        if (q) { state.comm.q[m.key] = q; hit++; }
      });
      if (hit) state.comm.updatedAt = new Date().toISOString();
      save();
      renderCommodities();
      if (hit === COMMODITIES.length) {
        paintCommNote("更新于 " + nowTimeStr() +
          (quoteVia === "script" ? " · 备用取数方式" : ""), false);
      } else if (hit) {
        paintCommNote("更新于 " + nowTimeStr() + " · " + hit + "/" + COMMODITIES.length + " 个取到", true);
      } else {
        paintCommNote("未取到数据（接口可能被拦截）", true);
      }
    }).catch(function (e) {
      /* 失败只改提示文案，保留上一次的价格，不要把面板清空 */
      paintCommNote("刷新失败：" + ((e && e.message) ? e.message : e) + "（保留上次价格）", true);
      renderCommodities();
    }).then(function () { commRefreshing = false; });
  }

  function setVisibleInput(stockId, field, value) {
    var tr = tbody.querySelector('tr.stock-row[data-id="' + stockId + '"]');
    if (!tr) return;
    var el = tr.querySelector('[data-k="' + field + '"]');
    if (el && el.value !== value) el.value = value;
  }

  /* ============================================================
     高低位看板 + 观察池
     ------------------------------------------------------------
     用途：周频高低切换时，判断「相近板块里谁在高位、谁在低位」。
     每支股票（含观察池里的候选）显示：现价在近 N 日高低区间里的位置（分位）、
     距 N 日最高/最低的百分比、现价与 MA5/MA10/MA30 的关系。

     数据源：新浪财经日K（scale=240）。**该接口没有 CORS 头**，
     浏览器 fetch 必被拦，所以走脚本标签通道（返回 var <名>=(数组)）。

     覆盖范围（2026-10-12 实测，改这段前请重测）：
       · 沪 / 深（sh/sz）：✓ 正常，含 ma_price5/10/30
       · 北交所 920xxx 段：✓ 正常（2024-08 起启用的新代码段）
       · 北交所存量代码段 43/83/87/88xxxx：✗ 拿不到可靠历史 ——
         新浪只给到 2025-09-30 就停更，且价格与现价严重不符（实测 430047 新浪末条 25.24，
         腾讯现价 8.17）；腾讯 fqkline 对该段直接返回空数组；网易历史接口 502。
         所以这些代码**明确判为不支持**，宁可显示「暂无历史K线源」也不用错数据算分位。
       · 港股 / 美股：✗ 接口返回 null。
     实时价（腾讯 qt.gtimg.cn）对北交所各段都正常，所以这些股票只是没有分位，
     现价 / 涨跌幅照样能看。

     窗口 KLINE_WINDOW = 15 个交易日（用户定的口径）；取数多取一些（KLINE_FETCH），
     以后改窗口只改这一个数字。分位 =（现价 − 区间最低）÷（区间最高 − 最低）× 100，
     现价用实时价（比最后收盘价新）；突破区间高/低点时按 100/0 显示并标注「创N日新高/新低」。
     K线缓存存 state.kline（行情快照，同 state.comm，故意不进备份 JSON）。
     ============================================================ */
  var KLINE_WINDOW = 15;
  var KLINE_FETCH = 60;
  var KLINE_TTL = 5 * 60 * 1000;        // 5 分钟内不重复拉同一支
  var kRefreshing = false;

  var jsonpSeq = 0;
  function loadJsonp(makeUrl, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var name = "plk" + (++jsonpSeq) + "_" + String(Date.now()).slice(-6);
      var el = document.createElement("script");
      el.charset = "gbk";
      el.src = makeUrl(name);
      var settled = false;
      function finish(err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (el.parentNode) el.parentNode.removeChild(el);
        if (err) { reject(err); return; }
        var v = window[name];
        try { delete window[name]; } catch (e2) {}
        if (v === undefined || v === null) { reject(new Error("接口没返回数据")); return; }
        resolve(v);
      }
      var timer = setTimeout(function () { finish(new Error("加载超时")); }, timeoutMs || 9000);
      el.onload = function () { finish(null); };
      el.onerror = function () { finish(new Error("脚本加载失败")); };
      document.head.appendChild(el);
    });
  }

  function fetchKline(qcode) {
    return loadJsonp(function (name) {
      return "https://money.finance.sina.com.cn/quotes_service/api/jsonp_v2.php/var%20" +
        name + "=/CN_MarketData.getKLineData?symbol=" + qcode +
        "&scale=240&datalen=" + KLINE_FETCH;
    }).then(function (arr) {
      var bars = (Array.isArray(arr) ? arr : []).map(function (b) {
        return { day: String(b.day || ""), open: num(b.open), high: num(b.high),
          low: num(b.low), close: num(b.close), ma5: num(b.ma_price5),
          ma10: num(b.ma_price10), ma30: num(b.ma_price30) };
      }).filter(function (b) { return b.close > 0 && b.day; });
      if (bars.length === 0) throw new Error("没取到K线数据");
      return bars;
    });
  }

  /* 能不能算 15 日分位（=有没有可靠的历史日K）。
     沪/深 + 北交所 920 段可以；北交所存量代码段与港股/美股都不行。
     判定依据与实测记录见文件上方「高低位看板」那段注释。 */
  function klineSupported(qcode) {
    var c = String(qcode || "");
    if (/^(sh|sz)\d{6}$/.test(c)) return true;
    if (/^bj920\d{3}$/.test(c)) return true;
    return false;
  }
  /* 不支持时给人话解释（看板里直接显示这句） */
  function klineWhy(qcode) {
    var c = String(qcode || "");
    if (/^bj\d/.test(c)) return "北交所老代码段暂无历史K线源";
    if (/^hk\d/.test(c)) return "港股不支持历史K线";
    if (/^us/.test(c)) return "美股不支持历史K线";
    return "该代码不支持历史K线";
  }

  /* 看板里要显示的股票 = 持仓表 + 观察池（持仓的排前面）
     观察池里带 closed 标记的，是「已平仓但想继续盯」的股票（存档时自动留下）。 */
  function watchList() {
    var list = [], seen = {};
    state.stocks.forEach(function (s) {
      var c = toQuoteCode(s.code);
      if (!c || seen[c]) return;
      seen[c] = true;
      list.push({ id: s.id, code: c, name: s.name || "", tag: "持仓", sec: s.sec || "", closed: false });
    });
    state.watch.forEach(function (w) {
      var c = toQuoteCode(w.code);
      if (!c || seen[c]) return;
      seen[c] = true;
      list.push({ id: w.id, code: c, name: w.name || "", sec: w.sec || "",
        tag: w.closed ? "已平仓" : "观察", closed: !!w.closed });
    });
    return list;
  }

  /* 存档（逐笔清盘 / 强制清盘）后把股票留在看板上：
     平仓不等于不再关心它 —— 还要盯着它回落、找机会买回。
     带上板块标签一起转过去，分组和排序才不会散。 */
  function keepOnBoard(s) {
    var code = String((s && s.code) || "").trim();
    var c = toQuoteCode(code);
    if (!c) return false;
    var dup = state.watch.some(function (w) { return toQuoteCode(w.code) === c; });
    if (dup) return false;
    state.watch.push({ id: uid("w"), code: code, name: (s && s.name) || "",
      sec: (s && s.sec) || "", closed: true });
    return true;
  }
  /* 按行情代码找当前价（配对列表的「B 现价」要用） */
  function curPriceOf(code) {
    var q = quotes[qKey(code)];
    return q && q.price > 0 ? q.price : 0;
  }
  /* 按行情代码找个股名称：先看行情接口补的全名，再退回用户填的名字 */
  function nameOf(code) {
    var q = quotes[qKey(code)];
    if (q && q.name) return q.name;
    var hit = null;
    state.stocks.concat(state.watch).some(function (x) {
      if (toQuoteCode(x.code) === code) { hit = x; return true; }
      return false;
    });
    return hit ? (hit.name || code) : code;
  }
  /* 给看板里的一行设置板块标签（持仓改 state.stocks，观察改 state.watch） */
  function setSec(tag, id, val) {
    var pool = tag === "持仓" ? state.stocks : state.watch;
    pool.some(function (x) {
      if (x.id !== id) return false;
      x.sec = String(val || "").trim();
      return true;
    });
    save();
    renderWatchPanel();
  }

  function klineStats(bars, cur) {
    var win = bars.slice(-KLINE_WINDOW);
    if (win.length === 0) return null;
    var hi = -Infinity, lo = Infinity;
    win.forEach(function (b) {
      if (b.high > hi) hi = b.high;
      if (b.low < lo) lo = b.low;
    });
    var last = bars[bars.length - 1];
    var price = cur > 0 ? cur : last.close;
    var range = hi - lo;
    return {
      price: price, usingRealtime: cur > 0,
      hi: hi, lo: lo, days: win.length, lastDay: last.day,
      pos: range > 0 ? Math.max(0, Math.min(100, (price - lo) / range * 100)) : 50,
      pctHi: hi > 0 ? (price / hi - 1) * 100 : NaN,     // 距 15 日最高（负数=还没到）
      pctLo: lo > 0 ? (price / lo - 1) * 100 : NaN,     // 距 15 日最低（正数=高出多少）
      newHigh: price >= hi, newLow: price <= lo,
      ma5: last.ma5, ma10: last.ma10, ma30: last.ma30
    };
  }

  /* 持仓行的 15 日分位槽：一条迷你横条代表近 15 日高低区间，
     开仓均价 = 固定刻度（深灰竖线，不会动），当前价 = 浮动圆点
     （颜色随高低位：≥75 红 / ≤25 绿 / 中间蓝，与高低位看板同一套语义）。
     数值细节（区间、各自分位）收进悬停提示，不占版面。
     没有 K 线缓存、非 A 股、两个价格都无效时返回空串（什么都不显示）。 */
  function klinePosBar(qcode, costPrice, curPrice) {
    if (!klineSupported(qcode)) return "";
    var entry = state.kline.d[qcode];
    var bars = (entry && entry.bars) || [];
    if (!bars.length) return "";
    var stCost = costPrice > 0 ? klineStats(bars, costPrice) : null;
    var stCur = curPrice > 0 ? klineStats(bars, curPrice) : null;
    if (!stCost && !stCur) return "";
    var base = stCost || stCur;
    var tip = "近 " + base.days + " 日区间 " + priceStr(base.lo) + "～" + priceStr(base.hi);
    if (stCost) tip += "；开仓均价 " + priceStr(costPrice) + " 分位 " + stCost.pos.toFixed(0);
    if (stCur) tip += "；当前价 " + priceStr(curPrice) + " 分位 " + stCur.pos.toFixed(0);
    var curCls = stCur ? (stCur.pos >= 75 ? "hi" : (stCur.pos <= 25 ? "lo" : "mid")) : "";
    return '<div class="cbar" title="' + tip + '">' +
      '<div class="cbar-track"></div>' +
      (stCost ? '<i class="cbar-cost" style="left:' + stCost.pos.toFixed(1) + '%"></i>' : "") +
      (stCur ? '<i class="cbar-cur ' + curCls + '" style="left:' + stCur.pos.toFixed(1) + '%"></i>' : "") +
      '</div>';
  }

  function klineAged(entry) {
    if (!entry || !entry.at) return true;
    var t = Date.parse(entry.at);
    return !(isFinite(t)) || (Date.now() - t) > KLINE_TTL;
  }

  function refreshWatchKlines(force) {
    if (kRefreshing) return Promise.resolve();
    var codes = [], i;
    watchList().forEach(function (it) {
      if (!klineSupported(it.code)) return;
      if (!force && !klineAged(state.kline.d[it.code])) return;
      if (codes.indexOf(it.code) < 0) codes.push(it.code);
    });
    renderWatchPanel();
    if (codes.length === 0) return Promise.resolve();

    kRefreshing = true;
    renderWatchNote("刷新中…（" + codes.length + " 支）");
    /* 分批（每批 4 支）串行，避免一次打出一堆请求被接口限流 */
    var idx = 0;
    function step() {
      if (idx >= codes.length) {
        kRefreshing = false;
        state.kline.updatedAt = new Date().toISOString();
        save();
        renderWatchPanel();
        refreshAll();                /* 持仓行的「分位」小字要用新 K 线 */
        renderWatchNote("");
        checkKlineAlerts();          /* 分位提醒的检查时机之一：K 线刚更新完 */
        return Promise.resolve();
      }
      var batch = codes.slice(idx, idx + 4);
      idx += 4;
      return Promise.all(batch.map(function (c) {
        return fetchKline(c).then(function (bars) {
          state.kline.d[c] = { bars: bars, at: new Date().toISOString(), err: "" };
        }).catch(function (e) {
          var old = state.kline.d[c] || { bars: [] };
          state.kline.d[c] = { bars: old.bars || [], at: old.at || "",
            err: (e && e.message) || "取数失败" };
        });
      })).then(function () {
        return new Promise(function (r) { setTimeout(r, 150); });
      }).then(step);
    }
    return step();
  }

  function renderWatchNote(txt) {
    var el = $("#watchNote");
    if (el) el.textContent = txt;
  }

  function renderWatchPanel() {
    var body = $("#watchBody");
    if (!body) return;
    var list = watchList();
    if (list.length === 0) {
      body.innerHTML = '<tr class="empty-row"><td colspan="8"><div class="empty">' +
        '看板是空的：持仓表里填了代码的股票会自动出现；候选股用上方输入框加入观察池。</div></td></tr>';
      return;
    }

    /* 预计算每行的分位数据（组内排序、组头均值都要用） */
    var items = list.map(function (it) {
      var q = quotes[qKey(it.code)] || null;
      var cur = q ? q.price : 0;
      var entry = state.kline.d[it.code];
      var bars = (entry && entry.bars) || [];
      var err = entry && entry.err;
      var st = bars.length ? klineStats(bars, cur) : null;
      return { it: it, q: q, cur: cur, err: err, st: st };
    });

    /* 分组：打了板块标签的按板块聚合（板块名排序），没标的排最后 */
    var groups = [], idx = {};
    items.forEach(function (x) {
      var g = x.it.sec || "";
      if (!idx.hasOwnProperty(g)) { idx[g] = []; groups.push(g); }
      idx[g].push(x);
    });
    groups.sort(function (a, b) {
      if (a === "" && b === "") return 0;
      if (a === "") return 1;
      if (b === "") return -1;
      return a.localeCompare(b, "zh-Hans-CN");
    });
    var hasGroups = groups.some(function (g) { return g !== ""; });

    var out = [];
    groups.forEach(function (g) {
      var arr = idx[g].slice().sort(function (a, b) {
        /* 组内按分位从高到低：高位在上（先卖），低位在下（后买）；没有分位的排最后 */
        var pa = a.st ? a.st.pos : null, pb = b.st ? b.st.pos : null;
        if (pa === null && pb === null) return 0;
        if (pa === null) return 1;
        if (pb === null) return -1;
        return pb - pa;
      });
      if (g !== "") {
        var posArr = arr.filter(function (x) { return x.st; }).map(function (x) { return x.st.pos; });
        var avg = posArr.length ? posArr.reduce(function (a, b) { return a + b; }, 0) / posArr.length : null;
        var avgCls = avg === null ? "" : (avg >= 75 ? "gc-up" : (avg <= 25 ? "gc-lo" : ""));
        out.push('<tr class="wgroup"><td colspan="8"><span class="gname">' + escHtml(g) +
          '</span><span class="ginfo">' + arr.length + ' 支' +
          (avg === null ? "" : ' · 平均分位 <span class="' + avgCls + '">' + avg.toFixed(0) + '</span>') +
          ' · 按分位从高到低（上卖下买）</span></td></tr>');
      } else if (hasGroups) {
        out.push('<tr class="wgroup none"><td colspan="8"><span class="gname">未分组</span>' +
          '<span class="ginfo">点股票名下方的「＋板块」打标签，相近板块会自动聚合到一起</span></td></tr>');
      }
      arr.forEach(function (x) { out.push(watchRowHtml(x)); });
    });
    body.innerHTML = out.join("");
  }

  /* 看板单行（分组后调用；x = {it, q, cur, err, st}） */
  function watchRowHtml(x) {
    var it = x.it, q = x.q, st = x.st;
    /* 板块标签：点开可改（持仓 / 观察 / 已平仓都能打标签） */
    var secBtn = '<button class="wsec" data-id="' + it.id + '" data-tag="' + it.tag +
      '" title="点击设置板块标签（用于相近板块的高低位切换）">' + (it.sec ? escHtml(it.sec) : "＋板块") + '</button>';
    var tagCls = it.tag === "持仓" ? "hold" : (it.closed ? "closed" : "obs");
    var c1 = '<td class="lft"><span class="wtag ' + tagCls + '">' +
      it.tag + '</span>' + nameHtml(it.name || (q ? q.name : "") || it.code) +
      '<span class="wcode-l">' + it.code + '</span>' + secBtn + '</td>';
    /* 没取实时价时用 K 线收盘价兜底，并标注来源，避免出现「分位有数、现价是—」的怪相 */
    var c2 = '<td>' + (x.cur > 0 ? priceStr(x.cur)
      : (st ? priceStr(st.price) + '<span class="hint sub">K线收盘</span>' : '<span class="muted">—</span>')) +
      (q && isFinite(q.pct) ? ' <span class="' + cls(q.pct) + '">' + pct(q.pct / 100) + '</span>' : '') + '</td>';

    if (!st) {
      var why = !klineSupported(it.code) ? klineWhy(it.code)
        : (x.err ? "取数失败：" + x.err : "待刷新");
      return '<tr data-id="' + it.id + '" data-code="' + it.code + '">' + c1 + c2 +
        '<td colspan="6" class="mutedc">' + why + '</td>' +
        (it.tag === "持仓" ? '<td></td>' : '<td class="actc"><button class="ico del wdel" data-tag="' + it.tag + '" title="' + (it.closed ? "从看板移除这支已平仓股票（只是不再盯着它，不影响已完成记录）" : "从观察池移除") + '">✕</button></td>') +
        '</tr>';
    }

    /* 分位条：高（≥75）红、低（≤25）绿、中间灰蓝 —— 红卖绿买，贴合操作意图 */
    var posCls = st.pos >= 75 ? "hi" : (st.pos <= 25 ? "lo" : "mid");
    var posLabel = st.newHigh ? "100（创" + st.days + "日新高）"
      : (st.newLow ? "0（创" + st.days + "日新低）" : st.pos.toFixed(0));
    var maCell = ["5", "10", "30"].map(function (n) {
      var ma = st["ma" + n];
      if (!(ma > 0)) return "";
      var d = (st.price / ma - 1) * 100;
      return '<span class="machip ' + (d >= 0 ? "up" : "down") + '" title="现价距 MA' + n +
        (d >= 0 ? " 高出 " : " 低 ") + Math.abs(d).toFixed(2) + '%">MA' + n +
        (d >= 0 ? "↑" : "↓") + "</span>";
    }).join(" ");

    return '<tr data-id="' + it.id + '" data-code="' + it.code + '">' + c1 + c2 +
      '<td><div class="poswrap"><div class="posbar ' + posCls + '"><i style="width:' +
      st.pos.toFixed(1) + '%"></i></div><span class="posnum ' + posCls + '">' + posLabel + '</span></div></td>' +
      '<td><div class="cell-num">' + priceStr(st.hi) + '</div><span class="hint sub ' +
      cls(st.pctHi) + '">' + (isFinite(st.pctHi) ? pct(st.pctHi / 100) : "—") + '</span></td>' +
      '<td><div class="cell-num">' + priceStr(st.lo) + '</div><span class="hint sub ' +
      cls(st.pctLo) + '">' + (isFinite(st.pctLo) ? pct(st.pctLo / 100) : "—") + '</span></td>' +
      '<td class="macell">' + maCell + '</td>' +
      '<td class="mutedc">' + st.lastDay + '</td>' +
      (it.tag === "持仓" ? '<td></td>' : '<td class="actc"><button class="ico del wdel" data-tag="' + it.tag + '" title="' + (it.closed ? "从看板移除这支已平仓股票（只是不再盯着它，不影响已完成记录）" : "从观察池移除") + '">✕</button></td>') +
      '</tr>';
  }

  function addWatch() {
    var el = $("#watch-code");
    var code = el ? el.value : "";
    var c = toQuoteCode(code);
    if (!c) { alert("请填股票代码。\n· A股 6 位，如 600519、000001\n· 也支持 hk00700 / usAAPL（但历史K线只有A股）"); return; }
    var dup = state.watch.some(function (w) { return toQuoteCode(w.code) === c; }) ||
              state.stocks.some(function (s) { return toQuoteCode(s.code) === c; });
    if (dup) { alert("这只已经在看板里了（持仓或观察池）。"); return; }
    state.watch.push({ id: uid("w"), code: code.trim(), name: "" });
    if (el) el.value = "";
    save();
    renderWatchPanel();
    refreshWatchKlines(true);        // 新加的股票没有缓存，强制拉一次
  }

  function removeWatch(id) {
    if (!rememberRemoval("watch", state.watch.filter(function (w) { return w.id === id; }), "移除观察股")) return;
    state.watch = state.watch.filter(function (w) { return w.id !== id; });
    save();
    renderWatchPanel();
  }

  /* ================= 分位提醒（15日高低位越线弹窗，闩锁 + 5 个百分点回差） ================= */
  function paintKlineSettings() {
    var k = state.settings.kline;
    var on = $("#kalert-on"), lo = $("#kalert-low"), hi = $("#kalert-high");
    if (on) on.checked = !!k.on;
    if (lo) lo.value = k.low;
    if (hi) hi.value = k.high;
  }
  function checkKlineAlerts() {
    var k = state.settings.kline;
    if (!k || !k.on) return;
    var lows = [], highs = [], changed = false;
    watchList().forEach(function (it) {
      if (!klineSupported(it.code)) return;
      var entry = state.kline.d[it.code];
      var bars = (entry && entry.bars) || [];
      if (!bars.length) return;
      var st = klineStats(bars, curPriceOf(it.code));
      if (!st) return;
      var nm = nameOf(it.code) + "（" + it.code + "）";
      /* 闩锁：越线弹一次；回到线内 5 个百分点才重新武装（与盈亏提醒同一套思路） */
      if (st.pos <= k.low) {
        if (!state.alertState.k.low[it.code]) {
          state.alertState.k.low[it.code] = true;
          changed = true;
          lows.push(nm + " 分位 " + st.pos.toFixed(0) + "，进入低位区（≤" + k.low + "）");
        }
      } else if (st.pos > k.low + 5) {
        if (state.alertState.k.low[it.code]) { changed = true; }
        state.alertState.k.low[it.code] = false;
      }
      if (st.pos >= k.high) {
        if (!state.alertState.k.high[it.code]) {
          state.alertState.k.high[it.code] = true;
          changed = true;
          highs.push(nm + " 分位 " + st.pos.toFixed(0) + "，进入高位区（≥" + k.high + "）");
        }
      } else if (st.pos < k.high - 5) {
        if (state.alertState.k.high[it.code]) { changed = true; }
        state.alertState.k.high[it.code] = false;
      }
    });
    /* 闩锁状态有变（触发或重新武装）都要落盘，否则刷新后要么重复弹、要么漏弹 */
    if (changed) save();
    var msgs = highs.concat(lows);
    if (msgs.length) {
      alert("分位提醒\n\n" + msgs.join("\n") +
        "\n\n（基于近 15 日高低区间；回到线内 5 个百分点后会重新提醒）");
    }
  }

  var refreshing = false;
  function refreshQuotes(manual) {
    if (refreshing) return;
    var statusEl = $("#qstatus");
    var codes = [], groups = {};
    state.stocks.forEach(function (s) {
      var c = toQuoteCode(s.code);
      if (!c) return;
      if (!groups[c]) { groups[c] = []; codes.push(c); }
      groups[c].push(s);
    });
    /* 观察池的股票也要取实时价（看板的「现价」和涨跌列要用）；
       它们没有持仓成本，只参与显示，不进任何盈亏统计 */
    state.watch.forEach(function (w) {
      var c = toQuoteCode(w.code);
      if (!c) return;
      if (!groups[c]) { groups[c] = []; codes.push(c); }
      groups[c].push(w);
    });

    if (codes.length === 0) {
      statusEl.textContent = "没有可刷新的股票代码";
      statusEl.className = "qstatus";
      refreshCommodities();          // 持仓没填代码时，侧栏商品照样刷新
      if (manual) {
        alert("还没有可刷新的股票代码。\n\n请在「代码」栏填入：\n· A股 6 位代码，如 600519、000001、300750\n· 带前缀的其他市场，如 hk00700、usAAPL、bj430047\n\n填好后点「刷新现价」即可。\n\n（右侧国际大宗商品不受影响，已单独刷新）");
      }
      return;
    }

    refreshing = true;
    statusEl.textContent = "刷新中…";
    statusEl.className = "qstatus loading";
    /* 商品与股票并行请求：商品失败不影响股票状态栏，反之亦然 */
    refreshCommodities();
    /* K线每天才变一次：只在手动刷新时跟着拉（自动刷新用缓存，免得高频打接口） */
    if (manual) refreshWatchKlines(false);

    fetchQuotes(codes).then(function (res) {
      var hit = 0, miss = [], namesFilled = 0;
      /* 写入行情缓存（合并，取不到的代码保留上次的行情） */
      Object.keys(res).forEach(function (k) { quotes[k] = res[k]; });
      codes.forEach(function (code) {
        var q = res[qKey(code)];
        if (!q) { miss.push(code); return; }
        hit++;
        groups[code].forEach(function (s) {
          var v = priceStr(q.price);
          s.cur = v;
          if (!String(s.name || "").trim() && q.name) { s.name = q.name; namesFilled++; }
          setVisibleInput(s.id, "cur", v);
          setVisibleInput(s.id, "name", s.name || "");
        });
      });
      save();
      refreshAll();
      renderWatchPanel();          // 看板的「现价」列要用刚取到的实时价
      statusEl.textContent = "更新于 " + nowTimeStr() + " · " + hit + " 只成功" +
        (miss.length ? " · 未取到 " + miss.join("、") : "") +
        (namesFilled ? " · 补全名称 " + namesFilled + " 个" : "") +
        (quoteVia === "script" ? " · 已改用备用取数方式" : "");
      statusEl.className = "qstatus " + (miss.length ? "err" : "ok");
      /* 取到新价格后检查提醒线（闩锁保证不会每次刷新都弹） */
      checkAlerts();
      checkPlanAlerts();          // 止损 / 目标线用的是刚取到的价
    }).catch(function (e) {
      /* 两条取数通道都失败 —— 这时候基本可以断定是网络 / 代理 / 安全软件的问题，
         而不是页面环境限制（那种情况备用方式能救回来）。 */
      statusEl.textContent = "刷新失败：" + ((e && e.message) ? e.message : e) +
        "（fetch 与备用方式都不通：检查网络 / 代理 / 安全软件，或是否离线）";
      statusEl.title = "正常取数走 fetch；被跨域或环境限制拦掉时会自动改用 script 标签" +
        "（该接口返回的本就是 JS 赋值语句，脚本加载不受 CORS 限制）。\n" +
        "两种方式都失败，通常意味着请求根本没发出去：断网、需要代理、或安全软件拦截了 qt.gtimg.cn。";
      statusEl.className = "qstatus err";
    }).then(function () { refreshing = false; });
  }

  /* 自动刷新（页面切到后台时暂停请求，避免无意义流量） */
  var quoteTimer = null;
  function applyAutoRefresh() {
    if (quoteTimer) { clearInterval(quoteTimer); quoteTimer = null; }
    if (!state.settings.auto) return;
    var sec = Math.max(5, num(state.settings.interval) || 30);
    quoteTimer = setInterval(function () {
      if (document.hidden) return;
      refreshQuotes(false);
    }, sec * 1000);
  }

  /* ================= 费用：每一「笔」成交单独计提（最低佣金逐笔生效） ================= */
  function lotFee(amount, isBuy) {
    var f = state.fees;
    if (!isFinite(amount) || amount <= 0) return { comm: 0, stamp: 0, transfer: 0, total: 0 };
    var rate = isBuy ? f.commBuy / 100 : f.commSell / 100;
    var comm = amount * rate;
    if (isFinite(f.minComm) && f.minComm > 0) comm = Math.max(comm, f.minComm);
    comm = r2(comm);
    var stamp = isBuy ? 0 : r2(amount * f.stamp / 100);
    var transfer = r2(amount * f.transfer / 100);
    return { comm: comm, stamp: stamp, transfer: transfer, total: r2(comm + stamp + transfer) };
  }
  function feeTip(amount, isBuy) {
    var z = lotFee(amount, isBuy);
    if (!(amount > 0)) return "金额为 0，不计费用";
    var f = state.fees;
    var lines = [];
    lines.push("佣金 " + yuan(z.comm) + "（" + (isBuy ? f.commBuy : f.commSell) + "%" +
      ((isFinite(f.minComm) && f.minComm > 0) ? "，最低 " + f.minComm + " 元" : "") + "）");
    if (!isBuy) lines.push("印花税 " + yuan(z.stamp) + "（" + f.stamp + "%）");
    lines.push("过户费 " + yuan(z.transfer) + "（" + f.transfer + "%）");
    lines.push("合计 " + yuan(z.total));
    return lines.join("\n");
  }

  /* ============================================================
     核心计算：一支股票（多笔买 + 多笔卖）
     多头：先买后卖 —— 买入 = 建仓，卖出 = 平仓
     空头：先卖后买 —— 卖出 = 开仓，买入 = 平仓（与多头互为镜像）
     ============================================================ */
  function tradeTime(v) {
    var s = String(v || "");
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) return "";
    if (s.length === 16) s += ":00";
    var d = new Date(s + "Z");
    return isFinite(d.getTime()) && d.toISOString().slice(0, 19) === s ? s : "";
  }
  function nowTradeTime() {
    var d = new Date();
    return todayStr() + "T" + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
  }
  function nextTradeOrder(s) {
    return s.buys.concat(s.sells).reduce(function (n, l) { return Math.max(n, num(l.order) || 0); }, s.buys.length + s.sells.length) + 1;
  }
  function tradeTimeline(s) {
    var rows = [], sh = isShort(s), missing = 0, error = "";
    (sh ? ["sell", "buy"] : ["buy", "sell"]).forEach(function (kind) {
      (kind === "buy" ? s.buys : s.sells).forEach(function (l) {
        var p = num(l.price), q = num(l.qty);
        if (!(p > 0 && q > 0)) return;
        var at = tradeTime(l.at), order = l.order === undefined ? rows.length + 1 : num(l.order);
        if (!at) { missing++; if (l.at) error = "成交时间无效，请检查日期和时分秒。"; }
        if (!(order > 0 && Number.isInteger(order))) error = "同刻顺序必须是正整数。";
        rows.push({ at: at, order: order, kind: kind, price: p, qty: q, amount: r2(p * q), fee: lotFee(p * q, kind === "buy").total });
      });
    });
    var mode = error ? "error" : (!rows.length || missing === rows.length ? "legacy" : missing ? "partial" : "ordered");
    var out = { mode: mode, error: error, rows: rows, balance: 0, basis: 0, grossBasis: 0, carried: 0, realized: 0, grossRealized: 0 };
    if (mode !== "ordered") return out;
    rows.sort(function (a, b) { return a.at.localeCompare(b.at) || a.order - b.order; });
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i], opening = sh ? row.kind === "sell" : row.kind === "buy";
      if (i && row.at === rows[i - 1].at && row.order === rows[i - 1].order) {
        out.error = "同一成交时间的顺序重复，请修改「同刻顺序」。"; break;
      }
      if (opening) {
        out.balance += row.qty;
        out.basis = r2(out.basis + row.amount + (sh ? -row.fee : row.fee));
        out.grossBasis = r2(out.grossBasis + row.amount);
      } else {
        if (row.qty > out.balance + EPS) {
          out.error = row.at.replace("T", " ") + " 的平仓数量超过当时持仓，后续建仓不能补平更早的卖出 / 买回。"; break;
        }
        var cost = qtyEq(row.qty, out.balance) ? out.basis : r2(out.basis * row.qty / out.balance);
        var grossCost = qtyEq(row.qty, out.balance) ? out.grossBasis : r2(out.grossBasis * row.qty / out.balance);
        row.cost = cost;
        row.net = r2(sh ? cost - row.amount - row.fee : row.amount - row.fee - cost);
        row.gross = r2(sh ? grossCost - row.amount : row.amount - grossCost);
        out.carried = r2(out.carried + cost);
        out.realized = r2(out.realized + row.net);
        out.grossRealized = r2(out.grossRealized + row.gross);
        out.balance -= row.qty;
        out.basis = r2(out.basis - cost); out.grossBasis = r2(out.grossBasis - grossCost);
        if (Math.abs(out.balance) < EPS) { out.balance = 0; out.basis = 0; out.grossBasis = 0; }
      }
      row.balance = out.balance; row.basis = out.basis;
      row.unitCost = out.balance > EPS ? out.basis / out.balance : NaN;
    }
    if (out.error) {
      out.mode = "error";
      rows.forEach(function (r) { delete r.net; delete r.gross; delete r.cost; delete r.balance; delete r.basis; delete r.unitCost; });
    }
    return out;
  }
  function calcStock(s) {
    var sh = isShort(s);
    var timeline = tradeTimeline(s);
    var o = { isShort: sh, buyQty: 0, buyAmount: 0, buyFee: 0, buyLots: 0,
                         sellQty: 0, sellAmount: 0, sellFee: 0, sellLots: 0 };

    s.buys.forEach(function (l) {
      var p = num(l.price), q = num(l.qty);
      if (!(isFinite(p) && p > 0 && isFinite(q) && q > 0)) return;
      var amt = timeline.mode === "ordered" ? r2(p * q) : p * q;
      o.buyLots++; o.buyQty += q; o.buyAmount += amt; o.buyFee += lotFee(p * q, true).total;
    });
    s.sells.forEach(function (l) {
      var p = num(l.price), q = num(l.qty);
      if (!(isFinite(p) && p > 0 && isFinite(q) && q > 0)) return;
      var amt = timeline.mode === "ordered" ? r2(p * q) : p * q;
      o.sellLots++; o.sellQty += q; o.sellAmount += amt; o.sellFee += lotFee(p * q, false).total;
    });

    o.buyAmount = r2(o.buyAmount); o.buyFee = r2(o.buyFee);
    o.buyCost = r2(o.buyAmount + o.buyFee);            // 买入端一共付出多少（含费）
    o.sellAmount = r2(o.sellAmount); o.sellFee = r2(o.sellFee);
    o.sellProceeds = r2(o.sellAmount - o.sellFee);     // 卖出端一共净收多少

    o.avgBuyPrice = o.buyQty > 0 ? o.buyAmount / o.buyQty : NaN;         // 买入均价（不含费）
    o.avgSellPrice = o.sellQty > 0 ? o.sellAmount / o.sellQty : NaN;     // 卖出均价（不含费）
    o.avgCostPrice = o.buyQty > 0 ? o.buyCost / o.buyQty : NaN;          // 多头：含费成本价
    o.avgOpenPrice = o.sellQty > 0 ? o.sellProceeds / o.sellQty : NaN;   // 空头：含费开仓均价（每股净得）

    o.openQty = sh ? o.sellQty : o.buyQty;               // 开仓（建仓）股数
    o.closeQty = sh ? o.buyQty : o.sellQty;              // 平仓股数
    o.unitCost = sh ? o.avgOpenPrice : o.avgCostPrice;   // 每单位基准价（含费）
    o.baseAmount = sh ? o.sellAmount : o.buyCost;        // 收益率分母

    o.remainQty = o.openQty - o.closeQty;                // 剩余：多头持仓 / 空头头寸
    o.over = o.remainQty < -EPS;                         // 超卖（多头）/ 超平（空头）

    // 已平仓部分：结转（多头）/ 释放（空头）的基准金额
    o.carriedCost = (o.closeQty > 0 && isFinite(o.unitCost)) ? r2(o.closeQty * o.unitCost) : NaN;
    if (sh) {
      o.realized = isFinite(o.carriedCost) ? r2(o.carriedCost - o.buyCost) : NaN;
    } else {
      o.realized = isFinite(o.carriedCost) ? r2(o.sellProceeds - o.carriedCost) : NaN;
    }
    o.timeline = timeline;
    if (timeline.mode === "ordered") {
      o.carriedCost = o.closeQty > 0 ? timeline.carried : NaN;
      o.realized = o.closeQty > 0 ? timeline.realized : NaN;
      o.unitCost = timeline.balance > EPS ? timeline.basis / timeline.balance : (sh ? o.avgOpenPrice : o.avgCostPrice);
    } else if (timeline.error) {
      o.carriedCost = NaN; o.realized = NaN; o.unitCost = NaN;
    }
    o.realizedRate = (isFinite(o.carriedCost) && o.carriedCost > 0) ? o.realized / o.carriedCost : NaN;

    // 剩余部分：浮动盈亏
    var cur = num(s.cur);
    o.hasCur = isFinite(cur) && cur > 0;
    o.cur = o.hasCur ? cur : NaN;

    if (o.remainQty > EPS) {
      o.holdBase = isFinite(o.unitCost) ? r2(o.remainQty * o.unitCost) : NaN;
      if (o.hasCur) {
        o.marketValue = r2(o.remainQty * cur);
        if (sh) {
          // 空头平仓 = 买回 → 买入费用；当前价越低越赚
          o.estFee = lotFee(o.marketValue, true).total;
          o.floatGross = r2(o.holdBase - o.marketValue);
          o.floatNet = r2(o.holdBase - o.marketValue - o.estFee);
        } else {
          // 多头平仓 = 卖出 → 卖出费用（含印花税）
          o.estFee = lotFee(o.marketValue, false).total;
          o.floatGross = r2(o.marketValue - o.holdBase);
          o.floatNet = r2(o.marketValue - o.estFee - o.holdBase);
        }
        o.floatRate = o.holdBase > 0 ? o.floatNet / o.holdBase : NaN;
        if (timeline.mode === "ordered") o.floatGross = r2(sh ? timeline.grossBasis - o.marketValue : o.marketValue - timeline.grossBasis);
      }
    } else {
      o.holdBase = 0;
    }

    var hasR = isFinite(o.realized), hasF = isFinite(o.floatNet);
    o.total = (hasR ? o.realized : 0) + (hasF ? o.floatNet : 0);
    o.hasTotal = hasR || hasF;
    o.totalRate = o.baseAmount > 0 && o.hasTotal ? o.total / o.baseAmount : NaN;

    o.canArchive = !timeline.error && o.buyLots > 0 && o.sellLots > 0 && o.openQty > 0 && qtyEq(o.openQty, o.closeQty);
    return o;
  }

  /* ================= 持仓表：渲染 ================= */
  function lotTimeLabel(lot) {
    var at = tradeTime(lot.at);
    return at ? at.slice(5, 10) : "补时间";
  }
  function lotRowHtml(kind, lot) {
    return '<tr class="lot-row" data-lot="' + lot.id + '" data-kind="' + kind + '">' +
      '<td><input class="f lot" data-k="price" type="number" step="0.001" min="0" placeholder="0.00" value="' +
        (lot.price === undefined || lot.price === null ? "" : String(lot.price)) + '"></td>' +
      '<td><input class="f lot" data-k="qty" type="number" step="1" min="0" placeholder="0" value="' +
        (lot.qty === undefined || lot.qty === null ? "" : String(lot.qty)) + '"></td>' +
      '<td class="lot-amt mutedc">—</td>' +
      '<td class="lot-fee fee">—</td>' +
      '<td class="lot-time-cell"><button type="button" class="edit-lot-time">' + lotTimeLabel(lot) + '</button>' +
        '<dialog class="lot-time-dialog" aria-label="编辑成交时间">' +
          '<div class="lot-time-heading">成交时间 <button type="button" class="ico close-lot-time" aria-label="关闭时间编辑">✕</button></div>' +
          '<div class="lot-time-fields"><label>成交日期与时间<input class="f lot trade-at" data-k="at" type="datetime-local" step="1" aria-label="成交时间" value="' + escAttr(tradeTime(lot.at)) + '"></label>' +
          '<label>同刻顺序 <input class="f lot trade-order" data-k="order" type="number" min="1" step="1" aria-label="同刻顺序" value="' + escAttr(lot.order || "") + '"></label>' +
          '<p>同一时刻的成交按顺序号结算。修改即保存。</p><button type="button" class="btn primary close-lot-time">完成</button></div></dialog></td>' +
      '<td><button class="ico del-lot" title="删除这笔">✕</button></td>' +
    '</tr>';
  }

  function lotTableHtml(s, kind) {
    var sh = isShort(s);
    var lots = kind === "buy" ? s.buys : s.sells;
    // 多头：买入=建仓 / 卖出=平仓　　空头：卖出=开仓 / 买入=平仓
    var role = sh ? (kind === "sell" ? "opening" : "closing")
                  : (kind === "buy" ? "opening" : "closing");
    var roleText = role === "opening" ? (sh ? "开仓" : "建仓 / 加仓") : "平仓 / 减仓";

    var body = lots.length
      ? lots.map(function (l) { return lotRowHtml(kind, l); }).join("")
      : '<tr class="lot-none"><td colspan="6"><div class="lot-empty">还没有' +
        (kind === "buy" ? "买入" : "卖出") + "记录</div></td></tr>";

    return '<div class="lot-col ' + role + '" data-kind="' + kind + '">' +
      '<div class="lot-head">' +
        '<div class="lt">' + (kind === "buy" ? "买入明细" : "卖出明细") + '<em>' + roleText + '</em></div>' +
        '<button class="btn sm add-lot" data-kind="' + kind + '">＋ 加一笔</button>' +
      '</div>' +
      '<div class="lot-scroll"><table class="lot-table">' +
        '<thead><tr>' +
          '<th style="width:20%">' + (kind === "buy" ? "买入价" : "卖出价") + ' ¥</th>' +
          '<th style="width:16%">股数</th>' +
          '<th style="width:24%">金额</th>' +
          '<th style="width:15%">费用</th>' +
          '<th style="width:17%">时间</th>' +
          '<th style="width:8%"></th>' +
        '</tr></thead>' +
        '<tbody>' + body + '</tbody>' +
        '<tfoot><tr>' +
          '<td class="lft">合计</td>' +
          '<td class="lt-qty">0</td>' +
          '<td class="lt-amt">¥0.00</td>' +
          '<td class="lt-fee">¥0.00</td>' +
          '<td></td>' +
          '<td></td>' +
        '</tr></tfoot>' +
      '</table></div>' +
    '</div>';
  }

  function escAttr(v) { return String(v == null ? "" : v).replace(/"/g, "&quot;"); }

  /* 交易计划输入卡：入场理由 / 策略标签 / 止损 / 目标 / 账户资金 / 单笔风险%
     填了止损价后，下面会实时给出「初始风险、建议股数、当前 R 倍数」。 */
  function planBoxHtml(s) {
    var p = normalizePlan(s.plan);
    function inp(k, ph, type) {
      return '<input class="f pin' + (type === "num" ? " num" : "") + '" data-pk="' + k + '"' +
        (type === "num" ? ' type="number" step="0.001" min="0"' : ' type="text"') +
        ' placeholder="' + escAttr(ph) + '" value="' + escAttr(p[k]) + '">';
    }
    return '<details class="planbox">' +
      '<summary class="ptitle">交易计划 <span class="hint">理由、止损、目标与仓位建议 · 点此编辑</span></summary>' +
      '<div class="prow">' +
        '<label class="pwhy">入场理由' + inp("why", "如：15日低位 + 板块回暖") + '</label>' +
        '<label>策略标签' + inp("tag", "低位轮动 / 做T / …", "text") + '</label>' +
        '<label>止损价 ¥' + inp("stop", "必填", "num") + '</label>' +
        '<label>目标价 ¥' + inp("target", "可空", "num") + '</label>' +
        '<label>账户资金 ¥' + inp("capital", "可选", "num") + '</label>' +
        '<label>单笔风险 %' + inp("riskPct", "如 1", "num") + '</label>' +
      '</div>' +
      '<div class="pnote"></div>' +
    '</details>';
  }

  /* 初始风险 / 建议股数 / 当前 R 倍数：
     R = 盈亏 ÷ 初始风险，短线用它衡量单笔表现，消除「仓位大小」的干扰。 */
  function planMetrics(s) {
    var p = normalizePlan(s.plan);
    var c = calcStock(s);
    var sh = c.isShort;
    var entry = sh ? c.avgSellPrice : c.avgBuyPrice;      // 开仓均价（不含费）
    var stop = num(p.stop);
    var target = num(p.target);
    var cur = effCur(s);            // 手填价优先，没填用行情价
    var riskPerShare = NaN, rMul = NaN;
    if (isFinite(entry) && isFinite(stop) && stop > 0) {
      riskPerShare = sh ? (stop - entry) : (entry - stop);
      if (riskPerShare > 0 && isFinite(cur)) {
        rMul = sh ? (entry - cur) / riskPerShare : (cur - entry) / riskPerShare;
      }
    }
    /* 建议股数 = 账户资金 × 风险% ÷ 每股风险，按 100 股整手取整（向下） */
    var capital = num(p.capital), riskPct = num(p.riskPct), lots = NaN, suggestQty = NaN;
    if (isFinite(capital) && isFinite(riskPct) && isFinite(riskPerShare) && riskPerShare > 0) {
      suggestQty = capital * riskPct / 100 / riskPerShare;
      lots = Math.floor(suggestQty / 100) * 100;
    }
    return { p: p, entry: entry, stop: stop, target: target, cur: cur,
      riskPerShare: riskPerShare, rMul: rMul, suggestQty: suggestQty, lots: lots };
  }

  function planNoteHtml(s) {
    var m = planMetrics(s);
    var bits = [];
    if (!isFinite(m.entry)) {
      bits.push('<span class="mutedc">先填买入明细（多少钱多少股），这里才会出现均价</span>');
    } else if (!(isFinite(m.riskPerShare) && m.riskPerShare > 0)) {
      bits.push('<span class="mutedc">填<b>止损价</b>后自动算出初始风险、建议仓位与 R 倍数</span>');
    } else {
      bits.push('每股初始风险 <b>' + yuan(m.riskPerShare) + '</b>');
      if (isFinite(m.target) && m.target > 0) {
        var rr = m.target === m.stop ? NaN
          : (s.dir === "short" ? (m.entry - m.target) : (m.target - m.entry)) / m.riskPerShare;
        bits.push(isFinite(rr) ? '目标盈亏比 <b>' + rr.toFixed(1) + 'R</b>' : '目标价无效');
      }
      if (isFinite(m.lots) && m.lots > 0) {
        bits.push('按资金 ' + yuan(num(m.p.capital)) + ' × 风险 ' + num(m.p.riskPct) +
          '% → 建议 <b>' + fmtQty(m.lots) + ' 股</b>（约 ' + fmtQty(Math.round(m.suggestQty)) + '）');
      }
      if (isFinite(m.rMul)) bits.push('当前 <b class="' + cls(m.rMul) + '">' + m.rMul.toFixed(2) + 'R</b>');
    }
    return bits.join('　·　');
  }

  function detailHtml(s) {
    // 建仓在左、平仓在右：多头先买后卖，空头先卖后买。
    var order = isShort(s) ? ["sell", "buy"] : ["buy", "sell"];
    return '<tr class="detail-row" data-for="' + s.id + '"><td colspan="8"><div class="detail">' +
      planBoxHtml(s) +
      '<p class="timeline-note"></p>' +
      '<div class="lots">' + order.map(function (k) { return lotTableHtml(s, k); }).join("") + '</div>' +
      '<div class="lot-note"></div>' +
    '</div></td></tr>';
  }

  function stockRowHtml(s) {
    return '<tr class="stock-row' + (s.expanded ? ' open' : '') + '" data-id="' + s.id + '">' +
      '<td class="lft nametd"><span class="caret">' + (s.expanded ? "▾" : "▸") + '</span>' +
        dirPill(s.dir, true) +
        '<input class="f code" data-k="code" type="text" placeholder="代码" value="' +
        String(s.code || "").replace(/"/g, "&quot;") + '">' +
        '<input class="f name" data-k="name" type="text" placeholder="名称（可自动填）" value="' +
        String(s.name || "").replace(/"/g, "&quot;") + '"></td>' +
      '<td class="c-hold"><span class="cell-num hold">—</span><span class="hint sub"></span></td>' +
      '<td class="c-cost"><span class="cell-num cost">—</span><span class="hint sub"></span><div class="cbar-holder"></div><div class="planline"></div></td>' +
      '<td class="curtd"><input class="f cur" data-k="cur" type="number" step="0.001" min="0" placeholder="0.00" value="' +
        String(s.cur || "") + '"><span class="hint qh"></span></td>' +
      '<td class="c-float"><span class="cell-num net">—</span><span class="hint sub"></span></td>' +
      '<td class="c-real"><span class="cell-num net">—</span><span class="hint sub"></span></td>' +
      '<td class="c-total"><span class="cell-num net">—</span><span class="hint sub"></span></td>' +
      '<td class="act">' +
        '<button class="ico done" title="整支存档为已完成交易（需已全部了结）">✓</button>' +
        '<button class="ico del" title="删除这支股票">✕</button>' +
      '</td>' +
    '</tr>';
  }

  function renderTable() {
    var html = "";
    state.stocks.forEach(function (s) {
      html += stockRowHtml(s);
      if (s.expanded) html += detailHtml(s);
    });
    tbody.innerHTML = html || '<tr class="empty-row"><td colspan="8"><div class="empty">' +
      '还没有股票。用右上角「＋ 添加多头」或「＋ 添加空头（卖空）」开始——<b>一支股票可以填多笔价格和多笔股数</b>，' +
      '适合分批建仓、分批卖出、分批平仓。<br>要补录历史交易，填一笔开仓 + 一笔平仓（当前价留空）后点行尾「✓」即可。</div></td></tr>';
    refreshAll();
  }

  function findStock(id) {
    for (var i = 0; i < state.stocks.length; i++) { if (state.stocks[i].id === id) return state.stocks[i]; }
    return null;
  }

  /* ================= 持仓表：数值刷新（不重建 DOM，保住输入焦点） ================= */
  function paintStockRow(tr) {
    var s = findStock(tr.dataset.id);
    if (!s) return null;
    var c = calcStock(s);
    var sh = c.isShort;

    var holdEl = tr.querySelector(".c-hold .hold");
    var holdSub = tr.querySelector(".c-hold .sub");
    var costEl = tr.querySelector(".c-cost .cost");
    var costSub = tr.querySelector(".c-cost .sub");
    var floatEl = tr.querySelector(".c-float .net");
    var floatSub = tr.querySelector(".c-float .sub");
    var realEl = tr.querySelector(".c-real .net");
    var realSub = tr.querySelector(".c-real .sub");
    var totalEl = tr.querySelector(".c-total .net");
    var totalSub = tr.querySelector(".c-total .sub");

    /* —— 持仓股数 —— */
    if (c.timeline.error) {
      holdEl.textContent = fmtQty(c.remainQty); holdEl.className = "cell-num hold warnc";
      holdSub.textContent = "⚠ 成交顺序有误"; holdSub.className = "hint sub warnc";
      holdSub.title = c.timeline.error;
    } else if (c.buyLots === 0 && c.sellLots === 0) {
      holdEl.textContent = "—"; holdEl.className = "cell-num hold flat";
      holdSub.textContent = "填写" + (sh ? "卖出开仓" : "买入") + "明细";
      holdSub.className = "hint sub";
    } else if (c.over) {
      holdEl.textContent = fmtQty(c.remainQty); holdEl.className = "cell-num hold warnc";
      holdSub.textContent = sh ? "⚠ 平仓多于开仓" : "⚠ 卖出多于买入";
      holdSub.className = "hint sub warnc";
    } else {
      holdEl.textContent = fmtQty(c.remainQty);
      holdEl.className = "cell-num hold" + (qtyEq(c.remainQty, 0) ? " flat" : "");
      var done = qtyEq(c.remainQty, 0) && c.openQty > 0 && c.closeQty > 0;
      /* 方向已由行首的多/空标记表达，这里不再重复，用「买/卖」「开/平」单字省宽度。
         数量与标签之间用不断行空格，折行时整段一起走（否则会出现单独一行的「0」）。 */
      holdSub.innerHTML = (sh ? "开\u00a0" : "买\u00a0") + fmtQty(c.openQty) +
        " · " + (sh ? "平\u00a0" : "卖\u00a0") + fmtQty(c.closeQty) +
        (done ? ' · <span class="nb">' + (sh ? "已平完，可存档" : "已清仓，可存档") + "</span>" : "");
      holdSub.className = "hint sub" + (done ? " warnc" : "");
    }

    /* —— 含费成本价 / 开仓均价 —— */
    var qcode = toQuoteCode(String(s.code || "").trim());
    if (isFinite(c.unitCost)) {
      costEl.textContent = price3(c.unitCost);
      costEl.className = "cell-num cost";
      var lotN = sh ? c.sellLots : c.buyLots;
      costSub.innerHTML = "均价\u00a0" + price3(sh ? c.avgSellPrice : c.avgBuyPrice) +
        (lotN > 1 ? " · " + lotN + "\u00a0笔" : "");   // 只有多笔才标笔数，避免单笔时白占一行宽度
      if (c.timeline.mode === "ordered") costSub.textContent = c.remainQty > EPS ? "剩余持仓 · 移动加权成本" : "已清仓 · 历次开仓均价";
    } else {
      costEl.textContent = "—"; costEl.className = "cell-num cost flat";
      costSub.textContent = sh ? "暂无卖出开仓" : "暂无买入";
    }
    /* 分位槽：开仓均价 = 固定刻度；当前价（手填优先，没填用实时价）= 浮动圆点。
       就算还没建仓（无均价），有当前价也画一条只有圆点的槽。 */
    var cbarHolder = tr.querySelector(".c-cost .cbar-holder");
    if (cbarHolder) {
      cbarHolder.innerHTML = klinePosBar(qcode,
        isFinite(sh ? c.avgSellPrice : c.avgBuyPrice) ? (sh ? c.avgSellPrice : c.avgBuyPrice) : 0,
        c.hasCur ? c.cur : 0);
    }

    /* —— 浮动盈亏 —— */
    if (isFinite(c.floatNet)) {
      floatEl.textContent = money(c.floatNet, true);
      floatEl.className = "cell-num net " + cls(c.floatNet);
      floatSub.innerHTML = "毛 " + money(c.floatGross, true) +
        '<span class="dim">' + (sh ? "回买费 " : "卖出费 ") + yuan(c.estFee) + "</span>";
    } else if (c.remainQty > EPS && !c.hasCur) {
      floatEl.textContent = "—"; floatEl.className = "cell-num net flat";
      floatSub.textContent = "待填当前价";
    } else if (qtyEq(c.remainQty, 0) && c.openQty > 0 && c.closeQty > 0) {
      floatEl.textContent = "—"; floatEl.className = "cell-num net flat";
      floatSub.textContent = sh ? "已平完" : "已清仓";
    } else {
      floatEl.textContent = "—"; floatEl.className = "cell-num net flat";
      floatSub.textContent = "";
    }

    /* —— 已实现盈亏 —— */
    if (isFinite(c.realized)) {
      realEl.textContent = money(c.realized, true);
      realEl.className = "cell-num net " + cls(c.realized);
      realSub.innerHTML = (sh ? "释放 " : "结转 ") + yuan(c.carriedCost) +
        '<span class="dim">收益率 ' + pct(c.realizedRate) + "</span>";
    } else {
      realEl.textContent = "—"; realEl.className = "cell-num net flat";
      realSub.textContent = sh ? "尚未平仓" : "尚未卖出";
    }

    /* —— 总盈亏 —— */
    if (c.hasTotal) {
      totalEl.textContent = money(c.total, true);
      totalEl.className = "cell-num net " + cls(c.total);
      totalSub.innerHTML = "收益率 " + pct(c.totalRate) +
        '<span class="dim">按' + (sh ? "开仓 " : "投入 ") + yuan(c.baseAmount) + "</span>";
    } else {
      totalEl.textContent = "—"; totalEl.className = "cell-num net flat";
      totalSub.textContent = "";
    }

    /* —— 交易计划摘要（止损 / 目标 / 当前 R）——
       折叠状态下也能一眼看到这个头寸的边界，R 倍数用红绿标出方向。 */
    var planline = tr.querySelector(".c-cost .planline");
    if (planline) {
      var pm = planMetrics(s);
      var seg = [];
      if (isFinite(pm.stop) && pm.stop > 0) seg.push("止损 " + price3(pm.stop));
      if (isFinite(pm.target) && pm.target > 0) seg.push("目标 " + price3(pm.target));
      if (isFinite(pm.rMul)) seg.push('<span class="' + cls(pm.rMul) + '">' +
        (pm.rMul > 0 ? "+" : "") + pm.rMul.toFixed(1) + "R</span>");
      if (seg.length === 0 && pm.p.tag) seg.push('<span class="ptag">' + escHtml(pm.p.tag) + "</span>");
      else if (pm.p.tag) seg.unshift('<span class="ptag">' + escHtml(pm.p.tag) + "</span>");
      planline.innerHTML = seg.length ? seg.join(" · ") : "";
      planline.title = planline.innerHTML
        ? (pm.p.why ? "计划：" + pm.p.why : "已在展开区填写交易计划")
        : "展开这支股票，在「交易计划」里填止损 / 目标 / 理由";
    }

    /* —— 当前价下方的行情提示 —— */
    var qh = tr.querySelector(".curtd .qh");
    if (qh) {
      var rawCode = String(s.code || "").trim();
      var q = quotes[qKey(qcode)];
      if (q) {
        /* 更新时间移入 title：全表刷新是同一时刻，右上角状态栏已显示「更新于 …」，
           行内不再重复，省下的宽度留给列宽 */
        var tstr = (q.time && q.time.length >= 12)
          ? q.time.slice(8, 12).replace(/(\d\d)(\d\d)/, "$1:$2") : "";
        qh.textContent = priceStr(q.price) + " · " +
          (q.pct > 0 ? "+" : "") + q.pct.toFixed(2) + "%";
        qh.title = "腾讯行情免费接口" + (tstr ? "，更新于 " + tstr : "") + "，仅供参考";
        qh.className = "hint qh " + cls(q.pct);
      } else if (rawCode === "") {
        qh.textContent = "填代码可自动取价";
        qh.title = "";
        qh.className = "hint qh";
      } else if (qcode === "") {
        qh.textContent = "代码无法识别";
        qh.title = "";
        qh.className = "hint qh warnc";
      } else {
        qh.textContent = "待刷新";
        qh.title = "";
        qh.className = "hint qh";
      }
    }

    return c;
  }

  function paintDetailRow(tr) {
    var s = findStock(tr.dataset.for);
    if (!s) return;
    var c = calcStock(s);
    var sh = c.isShort;
    var timelineNote = tr.querySelector(".timeline-note");
    timelineNote.className = "timeline-note" + (c.timeline.mode !== "ordered" ? " warnc" : "");
    timelineNote.textContent = c.timeline.error || (c.timeline.mode === "ordered"
      ? "已按成交时间和同刻顺序，使用移动加权平均法结转成本。清仓后再建仓会重置持仓成本，已实现收益保持不变。"
      : "未补齐全部有效批次的成交时间，暂按原汇总加权平均口径计算。旧记录不会自动编造成交时间；补齐后启用时间顺序结转。");

    /* 计划卡片里的计算行（初始风险 / 建议仓位 / 当前 R）随明细一起刷新 */
    var note = tr.querySelector(".pnote");
    if (note) note.innerHTML = planNoteHtml(s);

    ["buy", "sell"].forEach(function (kind) {
      var col = tr.querySelector('.lot-col[data-kind="' + kind + '"]');
      if (!col) return;
      var lots = kind === "buy" ? s.buys : s.sells;
      var isBuy = kind === "buy";
      var qty = 0, amt = 0, fee = 0, n = 0;

      Array.prototype.forEach.call(col.querySelectorAll("tr.lot-row"), function (lr) {
        var lot = null;
        for (var i = 0; i < lots.length; i++) { if (lots[i].id === lr.dataset.lot) { lot = lots[i]; break; } }
        if (!lot) return;
        var timeButton = lr.querySelector(".edit-lot-time");
        timeButton.textContent = lotTimeLabel(lot);
        timeButton.classList.toggle("missing", !tradeTime(lot.at));
        timeButton.title = (tradeTime(lot.at) || "未填写成交时间").replace("T", " ") + " · 同刻顺序 " + (lot.order || "未填") + "，点击编辑";
        var p = num(lot.price), q = num(lot.qty);
        var ok = isFinite(p) && p > 0 && isFinite(q) && q > 0;
        var a = ok ? p * q : NaN;
        var f = ok ? lotFee(a, isBuy) : null;

        lr.querySelector(".lot-amt").textContent = isFinite(a) ? yuan(a) : "—";
        var fEl = lr.querySelector(".lot-fee");
        fEl.textContent = f ? yuan(f.total) : "—";
        fEl.title = isFinite(a) ? feeTip(a, isBuy) : "填入价格与股数后显示费用明细";

        if (ok) { n++; qty += q; amt += a; fee += (f ? f.total : 0); }
      });

      var foot = col.querySelector("tfoot");
      foot.querySelector("td.lft").textContent = "合计（" + n + " 笔）";
      foot.querySelector(".lt-qty").textContent = fmtQty(qty);
      foot.querySelector(".lt-amt").textContent = yuan(r2(amt));
      var feeCell = foot.querySelector(".lt-fee");
      feeCell.textContent = yuan(r2(fee));
      feeCell.title = n > 1 ? "共 " + n + " 笔成交，费用逐笔计提后相加" : "";

      var tbodyEl = col.querySelector("tbody");
      var noneRow = tbodyEl.querySelector("tr.lot-none");
      if (lots.length === 0 && !noneRow) {
        tbodyEl.innerHTML = '<tr class="lot-none"><td colspan="6"><div class="lot-empty">还没有' +
          (isBuy ? "买入" : "卖出") + "记录</div></td></tr>";
      } else if (lots.length > 0 && noneRow) {
        noneRow.remove();
      }
    });

    /* —— 明细区底部口径说明 —— */
    var note = tr.querySelector(".lot-note");
    var parts = [];
    if (sh) {
      parts.push("<b>加权平均法（空头）</b>：含费开仓均价 <b>" +
        (isFinite(c.avgOpenPrice) ? price3(c.avgOpenPrice) : "—") +
        "</b>（= 卖出净得 " + yuan(c.sellProceeds) + " ÷ 开仓 " + fmtQty(c.sellQty) + " 股）");
      if (isFinite(c.realized)) {
        parts.push("已回买 " + fmtQty(c.buyQty) + " 股释放 " + yuan(c.carriedCost) +
          "，付出 " + yuan(c.buyCost) + "，已实现盈亏 <b class='" + cls(c.realized) + "'>" + money(c.realized, true) + "</b>");
      }
      if (c.remainQty > EPS) {
        parts.push("剩余空头 " + fmtQty(c.remainQty) + " 股，开仓基准 " + yuan(c.holdBase) +
          (isFinite(c.floatNet)
            ? "，当前现值 " + yuan(c.marketValue) + "，浮动盈亏 <b class='" + cls(c.floatNet) + "'>" + money(c.floatNet, true) + "</b>（股价跌则赚）"
            : "（待填当前价）"));
      } else if (qtyEq(c.remainQty, 0) && c.openQty > 0 && c.closeQty > 0) {
        parts.push("<b>已全部买回平仓</b>，可点行尾「✓」存档");
      }
      if (c.over) {
        parts.push("<b class='warnc'>⚠ 平仓（买入 " + fmtQty(c.buyQty) + " 股）多于开仓（卖出 " + fmtQty(c.sellQty) + " 股），请检查明细</b>");
      }
    } else {
      parts.push("<b>加权平均法（多头）</b>：含费成本价 <b>" +
        (isFinite(c.avgCostPrice) ? price3(c.avgCostPrice) : "—") +
        "</b>（= 买入总额 " + yuan(c.buyCost) + " ÷ 买入 " + fmtQty(c.buyQty) + " 股）");
      if (isFinite(c.realized)) {
        parts.push("已卖出 " + fmtQty(c.sellQty) + " 股结转成本 " + yuan(c.carriedCost) +
          "，已实现盈亏 <b class='" + cls(c.realized) + "'>" + money(c.realized, true) + "</b>");
      }
      if (c.remainQty > EPS) {
        parts.push("剩余 " + fmtQty(c.remainQty) + " 股，持仓成本 " + yuan(c.holdBase) +
          (isFinite(c.floatNet) ? "，浮动盈亏 <b class='" + cls(c.floatNet) + "'>" + money(c.floatNet, true) + "</b>" : "（待填当前价）"));
      } else if (qtyEq(c.remainQty, 0) && c.openQty > 0 && c.closeQty > 0) {
        parts.push("<b>已全部卖出</b>，可点行尾「✓」存档");
      }
      if (c.over) {
        parts.push("<b class='warnc'>⚠ 卖出股数超过买入股数 " + fmtQty(-c.remainQty) + " 股，请检查明细</b>");
      }
    }
    if (c.timeline.mode === "ordered") {
      parts = ["<b>移动加权平均法</b>：按每次平仓当时的成本逐笔结转。", "累计结转 / 释放成本 " + yuan(c.carriedCost),
        "已实现盈亏 " + money(c.realized, true), "剩余持仓基准 " + yuan(c.holdBase)];
    } else if (c.timeline.error) parts = ["<b class='warnc'>交易顺序有误，收益暂停计算；请修正成交时间、同刻顺序或股数。</b>"];
    note.innerHTML = parts.join("　·　");
  }

  function refreshAll() {
    Array.prototype.forEach.call(tbody.querySelectorAll("tr.stock-row"), paintStockRow);
    Array.prototype.forEach.call(tbody.querySelectorAll("tr.detail-row"), paintDetailRow);
    updateSummary();
  }

  /* ================= 汇总 ================= */
  function aggregate() {
    var a = {
      lQty: 0, lCost: 0, lCostExact: 0, lValue: 0, lFloat: 0, lHasFloat: false,
      sOpenQty: 0, sOpenAmount: 0, sValue: 0, sRemain: 0, sFloat: 0, sHasFloat: false,
      realized: 0, closeQty: 0, carried: 0, baseAmount: 0,
      buyFee: 0, sellFee: 0, estFee: 0, total: 0, noCur: 0,
      /* 已存档（已完成交易）部分 */
      archNet: 0, archCost: 0, archFees: 0, archN: 0, forcedFees: 0, invalid: 0, pendingTime: 0
    };
    state.stocks.forEach(function (s) {
      var c = calcStock(s);
      if (c.over || c.timeline.error) a.invalid++;
      if (c.timeline.rows.length && (c.timeline.mode === "legacy" || c.timeline.mode === "partial")) a.pendingTime++;
      a.buyFee += c.buyFee; a.sellFee += c.sellFee; a.baseAmount += c.baseAmount;
      if (isFinite(c.realized)) { a.realized += c.realized; a.closeQty += c.closeQty; a.carried += c.carriedCost; }
      if (c.hasTotal) a.total += c.total;
      /* 还有持仓但算不出浮动盈亏（没填当前价）→ 浮动盈亏是不完整的，
         提醒弹窗里要如实说明，避免用户以为数字就是全部 */
      if (c.remainQty > EPS && !c.hasCur) a.noCur++;

      if (c.isShort) {
        a.sOpenAmount += c.sellAmount;
        a.sOpenQty += c.sellQty;
        if (c.remainQty > EPS) {
          a.sRemain += c.remainQty;
          if (isFinite(c.marketValue)) { a.sValue += c.marketValue; a.estFee += c.estFee; }
        }
        if (isFinite(c.floatNet)) { a.sFloat += c.floatNet; a.sHasFloat = true; }
      } else {
        if (c.remainQty > EPS && c.holdBase > 0) {
          a.lQty += c.remainQty; a.lCost += c.holdBase;
          /* 用未四舍五入的持仓基准累加，避免卡片均价与本行显示的含费成本价产生 1 分位偏差 */
          if (isFinite(c.unitCost)) a.lCostExact += c.remainQty * c.unitCost;
          if (isFinite(c.marketValue)) { a.lValue += c.marketValue; a.estFee += c.estFee; }
        }
        if (isFinite(c.floatNet)) { a.lFloat += c.floatNet; a.lHasFloat = true; }
      }
    });

    /* 已存档的交易必须并入总账，否则一笔交易存档之后，
       它的已实现盈亏会从「总收益」里凭空消失（卡片上只剩浮动，看起来像"没算已实现"）。
       已存档的记录已经从 state.stocks 移除，所以不会重复计算。 */
    state.hist.forEach(function (h) {
      var net = num(h.net), cost = num(h.cost), fee = num(h.fees);
      if (isFinite(net)) { a.archNet += net; a.archN++; }
      if (isFinite(cost)) a.archCost += cost;
      if (isFinite(fee)) a.archFees += fee;
      if (h.forced && isFinite(fee)) a.forcedFees += fee;
    });

    ["lCost", "lValue", "lFloat", "sOpenAmount", "sValue", "sFloat", "realized", "carried",
     "buyFee", "sellFee", "estFee", "total", "baseAmount",
     "archNet", "archCost", "archFees"].forEach(function (k) { a[k] = r2(a[k]); });

    /* 全账户口径（持仓表 + 已存档）：顶部汇总卡用这三个 */
    a.realAll = r2(a.realized + a.archNet);
    a.feeAll = r2(a.buyFee + a.sellFee + a.archFees);
    a.baseAll = r2(a.baseAmount + a.archCost);
    a.totalAll = r2(a.total + a.archNet);
    return a;
  }

  function updateSummary() {
    var a = aggregate();
    renderProfitBreakdown(a);
    renderLedger();
    var bothFloat = r2(a.lFloat + a.sFloat);

    var tEl = $("#k-total");
    tEl.textContent = money(a.totalAll, true);
    tEl.className = "v " + cls(a.totalAll);
    /* 拆分写进 title，方便对账 */
    tEl.title = "持仓浮动 " + money(bothFloat, true) + " ＋ 持仓内已实现 " + money(a.realized, true) +
      (a.archN ? " ＋ 已存档已实现 " + money(a.archNet, true) + "（" + a.archN + " 笔）" : "");
    $("#k-total-sub").textContent = "浮动 " + money(bothFloat, true) + " ＋ 已实现 " + money(a.realAll, true) +
      (a.archN ? "（含已存档 " + a.archN + " 笔 " + money(a.archNet, true) + "）" : "") +
      " ｜ 建仓基数 " + yuan(a.baseAll);
    if (a.invalid) $("#k-total-sub").textContent += " ｜ 有成交顺序或数量错误，总收益暂不完整";

    var fEl = $("#k-float");
    fEl.textContent = money(bothFloat, true);
    fEl.className = "v " + cls(bothFloat);
    $("#k-float-sub").textContent = "多头 " + money(a.lFloat, true) + " · 空头 " + money(a.sFloat, true) +
      (a.archN ? "（已存档的持仓浮动已了结，不在此列）" : "");

    var rEl = $("#k-real");
    rEl.textContent = money(a.realAll, true);
    rEl.className = "v " + cls(a.realAll);
    rEl.title = "持仓内结转/释放成本 " + yuan(a.carried) + " · 已平仓 " + fmtQty(a.closeQty) + " 股";
    $("#k-real-sub").textContent = "持仓内 " + money(a.realized, true) + "（已平仓 " + fmtQty(a.closeQty) + " 股）" +
      (a.archN ? " ＋ 已存档 " + money(a.archNet, true) + "（" + a.archN + " 笔）" : "");

    $("#k-fee").textContent = yuan(a.feeAll);
    $("#k-fee-sub").textContent = "持仓 买入 " + yuan(a.buyFee) + " · 卖出 " + yuan(a.sellFee) +
      (a.archN ? " ＋ 已存档 " + yuan(a.archFees) : "") +
      (a.estFee > 0 ? "（另有预估平仓费 " + yuan(a.estFee) + "）" : "");

    var lc = $("#k-lcost"), lcs = $("#k-lcost-sub");
    if (a.lQty > 0) {
      lc.textContent = yuan(a.lCost); lc.className = "v";
      lcs.textContent = "共 " + fmtQty(a.lQty) + " 股 · 含费均价 " + price3(a.lQty > 0 ? a.lCostExact / a.lQty : NaN);
    } else { lc.textContent = "—"; lc.className = "v flat"; lcs.textContent = "暂无多头持仓"; }

    var lv = $("#k-lvalue"), lvs = $("#k-lvalue-sub");
    if (a.lQty > 0 && a.lValue > 0) {
      lv.textContent = yuan(a.lValue); lv.className = "v";
      lvs.textContent = "浮动 " + money(a.lFloat, true) + (a.lHasFloat ? "" : "（待填当前价）");
    } else { lv.textContent = "—"; lv.className = "v flat"; lvs.textContent = "暂无多头持仓"; }

    var so = $("#k-sopen"), sos = $("#k-sopen-sub");
    if (a.sRemain > 0) {
      so.textContent = yuan(a.sOpenAmount); so.className = "v";
      sos.textContent = "开仓卖出 " + fmtQty(a.sOpenQty) + " 股 · 均价 " +
        price3(a.sOpenQty > 0 ? a.sOpenAmount / a.sOpenQty : NaN) + " · 尚余 " + fmtQty(a.sRemain) + " 股";
    } else { so.textContent = "—"; so.className = "v flat"; sos.textContent = "暂无空头持仓"; }

    var sv = $("#k-svalue"), svs = $("#k-svalue-sub");
    if (a.sRemain > 0 && a.sValue > 0) {
      sv.textContent = yuan(a.sValue); sv.className = "v";
      svs.textContent = "浮动 " + money(a.sFloat, true) + (a.sHasFloat ? "" : "（待填当前价）");
    } else { sv.textContent = "—"; sv.className = "v flat"; svs.textContent = "暂无空头持仓"; }

    /* 不断行空格让「空 2,000」折行时整体移动，不会出现「空」孤零零留在上一行末尾 */
    $("#t-hold").innerHTML = fmtQty(a.lQty) +
      (a.sRemain > 0 ? ' / 空\u00a0' + fmtQty(a.sRemain) : "");
    var tc = $("#t-costval");
    tc.textContent = a.lCost > 0 ? yuan(a.lCost) : "—";
    tc.className = a.lCost > 0 ? "" : "mutedc";
    var tf = $("#t-float");
    tf.textContent = money(bothFloat, true); tf.className = cls(bothFloat);
    var tr2 = $("#t-real");
    tr2.textContent = money(a.realized, true); tr2.className = cls(a.realized);
    var tt = $("#t-total");
    tt.textContent = money(a.total, true); tt.className = cls(a.total);

    renderHistSum(a);
  }

  function histProfit(h) {
    var fee = num(h.fees) || 0, book = num(h.net) || 0;
    return { gross: r2(book + (h.forced ? 0 : fee)), net: r2(book - (h.forced ? fee : 0)) };
  }
  function renderProfitBreakdown(a) {
    /* 普通记账已扣费，强平记账未扣费：只补扣强平费用，不能重复扣普通费用。 */
    var net = r2(a.totalAll - a.forcedFees);
    var complete = !a.noCur && !a.invalid;
    var gross = complete ? r2(net + a.feeAll + a.estFee) : NaN;
    [["gross", gross], ["net", complete ? net : NaN]].forEach(function (pair) {
      var el = $("#profit-" + pair[0]);
      el.textContent = money(pair[1], true); el.className = cls(pair[1]);
    });
    $("#profit-fees").textContent = yuan(a.feeAll);
    $("#profit-est-fees").textContent = yuan(a.estFee);
    $("#profit-note").textContent = complete
      ? "毛收益 − 已发生交易费用 − 预估剩余平仓费 = 扣费净收益。" +
        (a.forcedFees ? "强制清盘已补扣费用 " + yuan(a.forcedFees) + "，普通交易不会重复扣费。" : "预估费用按各支剩余持仓一次性平仓计算。") +
        (a.pendingTime ? "有 " + a.pendingTime + " 支持仓未补齐成交时间，已实现与浮动收益仍按原汇总口径分配。" : "")
      : "收益暂不完整：" + (a.noCur ? a.noCur + " 支持仓缺少当前价；" : "") +
        (a.invalid ? a.invalid + " 支持仓数量或成交顺序有误；" : "") + "补齐后显示毛收益与净收益。费用仍显示已知金额。";
  }

  function ledgerEntries() {
    var rows = [];
    function add(log, name, code, scope, dir, mode) {
      log.forEach(function (r) { rows.push(Object.assign({}, r, { name: name, code: code || "", scope: scope, dir: dir, mode: mode })); });
    }
    state.stocks.forEach(function (s) { var t = tradeTimeline(s); add(t.rows, s.name, s.code, "持仓", s.dir, t.mode); });
    state.hist.forEach(function (h) { add(h.tradeLog || [], h.name, h.code, "已存档", h.dir, h.accounting || "legacy"); });
    return rows.sort(function (a, b) { return (a.at || "9999").localeCompare(b.at || "9999") || a.order - b.order; });
  }
  function renderLedger() {
    if (!$("#ledger-panel").open) return;
    var rows = ledgerEntries();
    $("#ledger-note").textContent = "共 " + rows.length + " 笔。只有时间完整且顺序有效的交易显示逐笔结转结果。旧存档没有逐笔明细时，仅保留原汇总记录；强制清盘流水仅作成交记录，收益以其存档结算为准。";
    $("#ledger-body").innerHTML = rows.length ? rows.map(function (r) {
      var known = r.mode === "ordered";
      return '<tr><td>' + (r.at ? escHtml(r.at.replace("T", " ")) : "未填写") + " / " + r.order + '</td>' +
        '<td class="lft">' + nameHtml(r.name) + '<span class="hint">' + escHtml(r.code) + " · " + r.scope + " · " + (r.dir === "short" ? "空头" : "多头") + '</span></td>' +
        '<td>' + (r.kind === "buy" ? "买入" : "卖出") + '</td><td>' + price3(r.price) + '</td><td>' + fmtQty(r.qty) + '</td>' +
        '<td>' + yuan(r.amount) + '</td><td>' + yuan(r.fee) + '</td><td>' + (known ? fmtQty(num(r.balance)) : "—") + '</td>' +
        '<td>' + (known ? price3(num(r.unitCost)) : "—") + '</td><td class="' + cls(num(r.net)) + '">' + (known ? money(num(r.net), true) : "—") + '</td></tr>';
    }).join("") : '<tr class="empty-row"><td colspan="10">暂无逐笔流水。添加持仓批次后即可查看，旧存档汇总保持不变。</td></tr>';
  }
  $("#ledger-panel").addEventListener("toggle", renderLedger);
  $("#export-trades").addEventListener("click", function () {
    var lines = [["成交时间(交易当地时间)", "同刻顺序", "股票名称", "代码", "状态", "方向", "买卖", "价格", "股数", "成交金额", "费用", "成交后剩余", "成交后含费基准价", "本笔已实现净收益", "计算口径"].join(",")];
    ledgerEntries().forEach(function (r) {
      var known = r.mode === "ordered";
      lines.push([esc(r.at.replace("T", " ")), r.order, esc(r.name), esc(r.code), esc(r.scope), esc(r.dir === "short" ? "空头" : "多头"), esc(r.kind === "buy" ? "买入" : "卖出"),
        r.price, r.qty, r.amount.toFixed(2), r.fee.toFixed(2), known ? r.balance : "", known && isFinite(num(r.unitCost)) ? num(r.unitCost).toFixed(4) : "",
        known && isFinite(num(r.net)) ? num(r.net).toFixed(2) : "", esc(known ? "移动加权平均" : "未按时间结转/强制清盘")].join(","));
    });
    download("股票交易流水_" + todayStr() + ".csv", lines.join("\r\n"));
  });

  /* ============================================================
     盈亏提醒
     监视「总浮动盈亏」，越过提醒线就弹窗。
     关键设计：**闩锁 + 回差**，避免每次自动刷新都弹一次
       · 触发过一次就置闩锁，之后即使仍在线上也不再弹
       · 只有回到线内（留 1% 回差，防止在线上抖动反复触发）才重新武装
     ============================================================ */
  function alertCfg() { return state.settings.alert; }

  function alertFloatNow() {
    var a = aggregate();
    return { float: r2(a.lFloat + a.sFloat), long: a.lFloat, short: a.sFloat, noCur: a.noCur,
             any: a.lHasFloat || a.sHasFloat, cnt: state.stocks.length };
  }

  function paintAlertSettings() {
    var c = alertCfg();
    $("#al-on").checked = !!c.on;
    $("#al-profit").value = c.profit > 0 ? String(c.profit) : "";
    $("#al-loss").value = c.loss > 0 ? String(c.loss) : "";
    var pe = $("#al-plan");
    if (pe) pe.checked = c.plan !== false;
    paintAlertStatus();
  }

  function paintAlertStatus() {
    var c = alertCfg();
    var el = $("#al-status");
    var n = alertFloatNow();
    if (!c.on) { el.textContent = "提醒已关闭"; el.className = "tip"; return; }
    if (!(c.profit > 0) && !(c.loss > 0)) {
      el.textContent = "填一个提醒线即可开启（可只填一边）"; el.className = "tip"; return;
    }
    var parts = [];
    if (c.profit > 0) parts.push("浮盈线 " + money(c.profit, true));
    if (c.loss > 0) parts.push("浮亏线 " + money(-c.loss, true));
    var tripped = (c.profit > 0 && n.float >= c.profit) || (c.loss > 0 && n.float <= -c.loss);
    el.className = "tip" + (tripped ? " al-tripped" : "");
    el.textContent = "当前总浮动 " + money(n.float, true) + " ｜ " + parts.join(" / ") +
      (tripped ? " ｜ ⚠ 已越过" : " ｜ 未触发") +
      (n.noCur > 0 ? " ｜ " + n.noCur + " 支待填当前价" : "");
  }

  /* 读取输入并保存；返回是否发生了变化 */
  function readAlertSettings() {
    var c = alertCfg();
    var on = $("#al-on").checked;
    var p = Math.max(0, num($("#al-profit").value) || 0);
    var l = Math.max(0, num($("#al-loss").value) || 0);
    var pe = $("#al-plan");
    var plan = pe ? !!pe.checked : true;
    var changed = (on !== c.on) || (p !== c.profit) || (l !== c.loss) || (plan !== (c.plan !== false));
    c.on = on; c.profit = r2(p); c.loss = r2(l); c.plan = plan;
    /* 改动了提醒线就把闩锁松开，让新阈值立刻生效（不然刚改成更宽/更窄的线不会触发）。
       只重置盈亏提醒的两把闩锁 —— 分位和计划提醒的闩锁各自独立，不该被连带清掉。 */
    if (changed) { state.alertState.p = false; state.alertState.l = false; }
    save();
    paintAlertStatus();
    return changed;
  }

  /* 有效当前价：手填价优先，没填就用行情价（提醒要盯真实市价） */
  function effCur(s) {
    var c = calcStock(s);
    if (c.hasCur && isFinite(c.cur) && c.cur > 0) return c.cur;
    var q = quotes[qKey(toQuoteCode(String(s.code || "").trim()))];
    return (q && q.price > 0) ? q.price : NaN;
  }

  /* ================= 交易计划提醒（止损 / 目标到线） =================
     与盈亏提醒同一套思路：闩锁保证只弹一次，回到线内 1% 以上才重新武装。
     只对填了止损价或目标价的头寸生效 —— 没计划的头寸不该有提醒。 */
  function checkPlanAlerts() {
    if (alertCfg().plan === false) return false;
    var lat = state.alertState.pm;
    if (!lat || typeof lat !== "object") { lat = {}; state.alertState.pm = lat; }
    var msgs = [], touched = false;

    state.stocks.forEach(function (s) {
      var p = planOf(s);
      var stop = num(p.stop), target = num(p.target), cur = effCur(s);
      if (!isFinite(cur)) return;
      var sh = isShort(s);
      var nm = (String(s.name || "").trim() || String(s.code || "").trim() || "未命名") +
        (String(s.code || "").trim() ? "（" + String(s.code).trim() + "）" : "");
      [["s", stop, sh ? ">=" : "<=", "止损"], ["t", target, sh ? "<=" : ">=", "目标"]]
        .forEach(function (spec) {
          var key = s.id + ":" + spec[0], line = spec[1], label = spec[3];
          if (!(line > 0)) { if (lat[key]) { lat[key] = false; touched = true; } return; }
          var hit = spec[2] === "<=" ? (cur <= line) : (cur >= line);
          /* 回差：回到线内 1% 之外才解除闩锁 */
          var back = spec[2] === "<=" ? (cur > line * 1.01) : (cur < line * 0.99);
          if (hit) {
            if (!lat[key]) {
              lat[key] = true; touched = true;
              msgs.push(nm + " 现价 " + priceStr(cur) + " 已" +
                (spec[0] === "s" ? "跌破" : "触及") + label + " " + priceStr(line) +
                "（" + (sh ? "空头" : "多头") + "）");
            }
          } else if (back && lat[key]) { lat[key] = false; touched = true; }
        });
    });

    if (touched) save();          // 闩锁（含解除）都要落盘，否则刷新后会重复弹
    if (msgs.length) {
      alert("交易计划提醒\n\n" + msgs.join("\n") +
        "\n\n（每支、每条线只提醒一次；回到线内 1% 以上后才重新提醒）");
    }
    return msgs.length > 0;
  }

  /* 检查是否越线；force=true 时忽略闩锁（用于「测试提醒」） */
  function checkAlerts(force) {
    var c = alertCfg();
    if (!c.on) { paintAlertStatus(); return false; }
    if (!(c.profit > 0) && !(c.loss > 0)) { paintAlertStatus(); return false; }
    var n = alertFloatNow();
    if (!n.any) { paintAlertStatus(); return false; }   // 一列浮动盈亏都算不出来，不判断

    var lat = state.alertState;
    var kind = null;
    if (c.profit > 0) {
      if (n.float >= c.profit) {
        if (force || !lat.p) { kind = "p"; lat.p = true; }
      } else if (n.float < c.profit * 0.99) { lat.p = false; }   // 回到线内 1% 以下才重新武装
    } else { lat.p = false; }
    if (!kind && c.loss > 0) {
      if (n.float <= -c.loss) {
        if (force || !lat.l) { kind = "l"; lat.l = true; }
      } else if (n.float > -c.loss * 0.99) { lat.l = false; }
    } else if (c.loss <= 0) { lat.l = false; }

    paintAlertStatus();
    if (!kind) { save(); return false; }
    save();
    showAlert(kind, n, force);
    return true;
  }

  function showAlert(kind, n, isTest) {
    var c = alertCfg();
    var isProfit = kind === "p";
    $("#alertTitle").textContent = isTest ? "⚠ 盈亏提醒（测试）" : "⚠ 盈亏提醒";
    var v = $("#alertValue");
    v.textContent = money(n.float, true);
    v.className = "alertbig " + cls(n.float);
    $("#alertCond").innerHTML = isProfit
      ? "总浮动盈利已越过提醒线 <b>" + money(c.profit, true) + "</b>"
      : "总浮动亏损已越过提醒线 <b>" + money(-c.loss, true) + "</b>";

    var rows = [];
    rows.push(kv("多头浮动", money(n.long, true)));
    rows.push(kv("空头浮动", money(n.short, true)));
    rows.push(kv("持仓支数", n.cnt + " 支"));
    rows.push(kv("提醒线", (c.profit > 0 ? "浮盈 " + money(c.profit, true) : "浮盈 不限") + " ／ " +
      (c.loss > 0 ? "浮亏 " + money(-c.loss, true) : "浮亏 不限")));
    if (n.noCur > 0) {
      rows.push('<div class="kv"><span class="warnc">注意</span><span class="warnc">有 ' + n.noCur +
        ' 支未填当前价，浮动盈亏不完整</span></div>');
    }
    if (isTest) {
      rows.push('<div class="kv"><span class="muted">说明</span><span class="muted">这是测试弹窗，' +
        '不会改变提醒状态</span></div>');
    } else {
      rows.push('<div class="kv"><span class="muted">再次提醒</span><span class="muted">' +
        '需等浮动盈亏回到线内（约 1% 回差）后重新越线</span></div>');
    }
    $("#alertDetail").innerHTML = rows.join("");
    $("#alertMask").classList.add("on");
  }

  function closeAlert() { $("#alertMask").classList.remove("on"); }

  $("#alertClose").addEventListener("click", closeAlert);
  $("#alertOk").addEventListener("click", closeAlert);
  $("#alertMask").addEventListener("click", function (e) { if (e.target === this) closeAlert(); });
  $("#alertSettings").addEventListener("click", function () {
    closeAlert();
    var bar = document.querySelector(".alertbar");
    if (bar && bar.scrollIntoView) bar.scrollIntoView({ behavior: "smooth", block: "center" });
    var el = $("#al-profit");
    if (el) { try { el.focus({ preventScroll: true }); } catch (e2) { el.focus(); } }
  });
  $("#al-on").addEventListener("change", function () {
    readAlertSettings();
    if (alertCfg().on) checkAlerts();     // 刚打开就先查一次，符合条件立刻提醒
  });
  ["#al-profit", "#al-loss"].forEach(function (sel) {
    /* 边打字边刷新右侧状态文案 */
    $(sel).addEventListener("input", readAlertSettings);
    /* 编辑完成（失焦 / 回车）才真正检查一次：
       否则输「400」的过程中输到「4」就可能先弹一个窗出来 */
    $(sel).addEventListener("change", function () {
      readAlertSettings();
      checkAlerts();
    });
  });
  $("#al-plan").addEventListener("change", function () {
    readAlertSettings();
    if (alertCfg().plan !== false) checkPlanAlerts();
  });
  $("#al-test").addEventListener("click", function () {
    var n = alertFloatNow();
    if (!n.any) {
      alert("现在还算不出浮动盈亏。\n\n请先填好「当前价」（或点「⟳ 刷新现价」自动取价），再测试提醒。");
      return;
    }
    var c = alertCfg();
    var kind = (c.profit > 0 && n.float >= c.profit) ? "p" : "l";
    showAlert(kind, n, true);
  });

  /* ================= 交互：展开 / 切方向 / 增删 ================= */
  function toggleExpand(id) {
    var s = findStock(id);
    if (!s) return;
    s.expanded = !s.expanded;
    save();
    rerenderDetail(id);
  }

  function rerenderDetail(stockId) {
    var old = tbody.querySelector('tr.detail-row[data-for="' + stockId + '"]');
    if (old) old.remove();
    var s = findStock(stockId);
    var tr = tbody.querySelector('tr.stock-row[data-id="' + stockId + '"]');
    if (s && s.expanded && tr) {
      tr.insertAdjacentHTML("afterend", detailHtml(s));
      var d = tbody.querySelector('tr.detail-row[data-for="' + stockId + '"]');
      if (d) paintDetailRow(d);
    }
    if (tr && s) {
      tr.classList.toggle("open", !!s.expanded);
      var caret = tr.querySelector(".caret");
      if (caret) caret.textContent = s.expanded ? "▾" : "▸";
      paintStockRow(tr);
    }
    updateSummary();
  }

  /* 切换多空方向 */
  function toggleDir(id) {
    var s = findStock(id);
    if (!s) return;
    var c = calcStock(s);
    var next = isShort(s) ? "long" : "short";
    var nextName = next === "short" ? "空头（做空）" : "多头（做多）";
    if (c.buyQty > 0 || c.sellQty > 0) {
      var msg = "把「" + (s.name || "未命名股票") + "」从" + dirName(s) + "切换为" + nextName + "？\n\n";
      msg += (next === "short")
        ? "切换后角色对调：\n· 卖出明细 → 开仓（先融券卖出）\n· 买入明细 → 平仓（后买回还券）\n\n"
        : "切换后角色对调：\n· 买入明细 → 建仓（先买入）\n· 卖出明细 → 平仓（后卖出）\n\n";
      msg += "已有的价格与股数不会改动，只是盈亏方向反过来算。";
      if (!confirm(msg)) return;
    }
    s.dir = next;
    save();
    // 明细顺序会变（开仓腿排前面），整行重建
    var tr = tbody.querySelector('tr.stock-row[data-id="' + id + '"]');
    var old = tbody.querySelector('tr.detail-row[data-for="' + id + '"]');
    if (old) old.remove();
    if (tr) {
      tr.outerHTML = stockRowHtml(s);
      var ntr = tbody.querySelector('tr.stock-row[data-id="' + id + '"]');
      if (s.expanded && ntr) {
        ntr.insertAdjacentHTML("afterend", detailHtml(s));
        var d = tbody.querySelector('tr.detail-row[data-for="' + id + '"]');
        if (d) paintDetailRow(d);
      }
      if (ntr) paintStockRow(ntr);
    }
    updateSummary();
  }

  function addLot(stockId, kind, focus) {
    var s = findStock(stockId);
    if (!s) return;
    var lot = { id: uid("l"), price: "", qty: "", at: nowTradeTime(), order: nextTradeOrder(s) };
    if (kind === "buy") s.buys.push(lot);
    else s.sells.push(lot);
    if (!s.expanded) s.expanded = true;
    save();
    rerenderDetail(stockId);
    if (focus) {
      var d = tbody.querySelector('tr.detail-row[data-for="' + stockId + '"]');
      if (d) {
        var col = d.querySelector('.lot-col[data-kind="' + kind + '"]');
        var rows = col.querySelectorAll("tr.lot-row");
        var last = rows[rows.length - 1];
        if (last) last.querySelector('[data-k="price"]').focus();
      }
    }
  }

  function addStock(opt) {
    opt = opt || {};
    var at = nowTradeTime();
    var s = {
      id: uid("s"), name: opt.name || "", code: opt.code || "", cur: opt.cur || "",
      dir: opt.dir === "short" ? "short" : "long",
      expanded: opt.expanded !== false,
      buys: [{ id: uid("l"), price: "", qty: "", at: at, order: opt.dir === "short" ? 2 : 1 }],
      sells: [{ id: uid("l"), price: "", qty: "", at: at, order: opt.dir === "short" ? 1 : 2 }],
      plan: Object.assign({}, DEF_PLAN)
    };
    state.stocks.push(s);
    save();
    renderTable();
    if (opt.focus) {
      var tr = tbody.querySelector('tr.stock-row[data-id="' + s.id + '"]');
      if (tr) tr.querySelector('[data-k="name"]').focus();
    }
    return s;
  }

  /* 行点击展开（点在输入框 / 按钮 / 明细表上时不触发） */
  tbody.addEventListener("click", function (e) {
    var t = e.target;
    if (t.closest("input") || t.closest("button") || t.closest(".lot-table")) return;
    var tr = t.closest("tr.stock-row");
    if (tr) toggleExpand(tr.dataset.id);
  });

  tbody.addEventListener("click", function (e) {
    var timeButton = e.target.closest(".edit-lot-time");
    if (timeButton) {
      var timeDialog = timeButton.closest("td").querySelector("dialog");
      timeDialog.showModal(); timeDialog.querySelector(".trade-at").focus(); return;
    }
    var timeClose = e.target.closest(".close-lot-time");
    if (timeClose) { timeClose.closest("dialog").close(); return; }
    var dbtn = e.target.closest("button.dir");
    if (dbtn) { e.stopPropagation(); toggleDir(dbtn.closest("tr.stock-row").dataset.id); return; }

    var add = e.target.closest(".add-lot");
    if (add) {
      e.stopPropagation();
      addLot(add.closest("tr.detail-row").dataset.for, add.dataset.kind, true);
      return;
    }
    var dl = e.target.closest(".del-lot");
    if (dl) {
      e.stopPropagation();
      var ltr = dl.closest("tr.lot-row");
      var st = findStock(dl.closest("tr.detail-row").dataset.for);
      if (!st) return;
      var kind = ltr.dataset.kind;
      var lots = kind === "buy" ? st.buys : st.sells;
      var target = null;
      for (var i = 0; i < lots.length; i++) { if (lots[i].id === ltr.dataset.lot) { target = lots[i]; break; } }
      var p = target ? num(target.price) : NaN, q = target ? num(target.qty) : NaN;
      if ((isFinite(p) && p > 0) || (isFinite(q) && q > 0)) {
        if (!confirm("删除这笔" + (kind === "buy" ? "买入" : "卖出") + "记录？\n\n" +
          (isFinite(p) ? "价格 ¥" + nf.format(p) + "　" : "") + (isFinite(q) ? "股数 " + fmtQty(q) : ""))) return;
      }
      if (target && !rememberRemoval("lot", [target], "删除" + (kind === "buy" ? "买入" : "卖出") + "批次", { stockId: st.id, kind: kind })) return;
      st[kind === "buy" ? "buys" : "sells"] = lots.filter(function (x) { return x.id !== ltr.dataset.lot; });
      save();
      rerenderDetail(st.id);
      return;
    }
    var dn = e.target.closest(".ico.done");
    if (dn) { e.stopPropagation(); archiveStock(dn.closest("tr.stock-row").dataset.id); return; }
    var del = e.target.closest(".ico.del");
    if (del) {
      e.stopPropagation();
      var row = del.closest("tr.stock-row");
      var s2 = findStock(row.dataset.id);
      if (!s2) return;
      var c2 = calcStock(s2);
      if (!confirm("删除「" + (s2.name || "未命名股票") + "」（" + dirName(s2) + "）及其全部批次明细？\n\n" +
        "买入 " + c2.buyLots + " 笔 / 卖出 " + c2.sellLots + " 笔\n删除后可在「误删恢复」中找回。")) return;
      if (!rememberRemoval("stocks", [s2], "删除持仓「" + (s2.name || "未命名") + "」")) return;
      state.stocks = state.stocks.filter(function (x) { return x.id !== row.dataset.id; });
      save();
      renderTable();
      return;
    }
  });

  tbody.addEventListener("input", function (e) {
    var el = e.target;
    if (!el.classList || !el.classList.contains("f")) return;

    if (el.classList.contains("lot")) {
      var ltr = el.closest("tr.lot-row");
      var detail = el.closest("tr.detail-row");
      var s = findStock(detail.dataset.for);
      if (!s) return;
      var lots = ltr.dataset.kind === "buy" ? s.buys : s.sells;
      for (var i = 0; i < lots.length; i++) {
        if (lots[i].id === ltr.dataset.lot) { lots[i][el.dataset.k] = el.value; break; }
      }
      save();
      paintDetailRow(detail);
      var srow = tbody.querySelector('tr.stock-row[data-id="' + s.id + '"]');
      if (srow) paintStockRow(srow);
      updateSummary();
      return;
    }

    /* 交易计划字段：直接落在 s.plan 上。
       注意不要重绘整个展开区（会把输入框本身也重建、丢焦点），只刷新计算结果那一行。 */
    if (el.classList.contains("pin")) {
      var d2 = el.closest("tr.detail-row");
      var ps = findStock(d2.dataset.for);
      if (!ps) return;
      ps.plan = normalizePlan(ps.plan);
      ps.plan[el.dataset.pk] = el.value;
      save();
      var note = d2.querySelector(".pnote");
      if (note) note.innerHTML = planNoteHtml(ps);
      var prow = tbody.querySelector('tr.stock-row[data-id="' + ps.id + '"]');
      if (prow) paintStockRow(prow);
      return;
    }

    var tr = el.closest("tr.stock-row");
    var st = findStock(tr.dataset.id);
    if (!st) return;
    st[el.dataset.k] = el.value;
    save();
    paintStockRow(tr);
    var d = tbody.querySelector('tr.detail-row[data-for="' + st.id + '"]');
    if (d) paintDetailRow(d);
    updateSummary();
  });

  tbody.addEventListener("keydown", function (e) {
    if (e.key !== "Enter") return;
    var el = e.target;
    var timeDialog = el.closest(".lot-time-dialog");
    if (timeDialog) { e.preventDefault(); timeDialog.close(); return; }
    if (!el.classList || !el.classList.contains("f")) return;
    e.preventDefault();
    if (el.classList.contains("lot")) {
      var ltr = el.closest("tr.lot-row");
      addLot(ltr.closest("tr.detail-row").dataset.for, ltr.dataset.kind, true);
      return;
    }
    var tr = el.closest("tr.stock-row");
    var next = tr.nextElementSibling;
    while (next && !next.classList.contains("stock-row")) next = next.nextElementSibling;
    var target = next && next.querySelector('[data-k="' + el.dataset.k + '"]');
    if (target) target.focus();
    else addStock({ focus: true, dir: findStock(tr.dataset.id).dir });
  });

  /* ============================================================
     存档（整支了结）
     自动刷新开着时，「当前价」是市场实时价，未必等于你的真实成交价。
     所以存档时单独录入「清盘明细」——可以分多笔、不同价格不同数量，
     这些笔会作为虚拟成交接到"平仓腿"末尾，再走同一套 calcStock —— 不重复实现算法。
     ============================================================ */
  var arcState = null;   // { id, liqQty, tranches: [{id, price, qty}] }

  /* 有效清盘笔 = 价格与数量都填了 */
  function arcValidTranches() {
    if (!arcState) return [];
    return arcState.tranches.filter(function (t) {
      return num(t.price) > 0 && num(t.qty) > 0;
    });
  }
  /* 只填了价格或只填了数量 —— 视为没填完 */
  function arcIncompleteCount() {
    if (!arcState) return 0;
    var n = 0;
    arcState.tranches.forEach(function (t) {
      var hasP = num(t.price) > 0, hasQ = num(t.qty) > 0;
      if (hasP !== hasQ) n++;
    });
    return n;
  }
  /* 清盘明细的合计与校验状态 */
  function arcLiqStat() {
    var valid = arcValidTranches();
    var sumQty = 0, sumAmt = 0;
    valid.forEach(function (t) { sumQty += num(t.qty); sumAmt += num(t.price) * num(t.qty); });
    var need = arcState ? arcState.liqQty : 0;
    return {
      n: valid.length, sumQty: sumQty, sumAmt: r2(sumAmt), need: need,
      left: need - sumQty, incomplete: arcIncompleteCount(),
      ok: Math.abs(need - sumQty) < EPS && arcIncompleteCount() === 0
    };
  }

  /* 把清盘明细当成多笔虚拟成交，接到"平仓腿"上 */
  function arcEffStock(s) {
    var lots = arcValidTranches();
    if (lots.length === 0) return s;
    var c = { id: s.id, dir: s.dir, cur: s.cur, buys: s.buys.slice(), sells: s.sells.slice() };
    lots.forEach(function (t, i) {
      var lot = { id: "__liq" + i + "__", price: String(num(t.price)), qty: String(num(t.qty)),
        at: $("#arcDate").value + "T" + $("#arcTime").value, order: nextTradeOrder(s) + i };
      if (isShort(s)) c.buys.push(lot);   // 空头清盘 = 买回
      else c.sells.push(lot);             // 多头清盘 = 卖出
    });
    return c;
  }

  /* ---------- 清盘明细表 ---------- */
  function liqRowHtml(t) {
    return '<tr data-qid="' + t.id + '">' +
      '<td><input class="f liq" data-k="price" type="number" step="0.001" min="0" placeholder="成交价" value="' +
        String(t.price === undefined || t.price === null ? "" : t.price) + '"></td>' +
      '<td><input class="f liq" data-k="qty" type="number" step="1" min="0" placeholder="股数" value="' +
        String(t.qty === undefined || t.qty === null ? "" : t.qty) + '"></td>' +
      '<td class="liqamt">—</td>' +
      '<td class="actc"><button class="ico del-liq" title="删除这一笔">✕</button></td>' +
    '</tr>';
  }

  function renderLiqRows() {
    var body = $("#arcLiqBody");
    if (!body) return;
    if (!arcState || arcState.tranches.length === 0) {
      body.innerHTML = '<tr class="liq-none"><td colspan="4"><div class="liqempty">' +
        '点右上角「＋ 再添一笔」录入清盘成交（可多笔、不同价格不同数量）</div></td></tr>';
      return;
    }
    body.innerHTML = arcState.tranches.map(liqRowHtml).join("");
  }

  function paintLiqAmounts() {
    if (!arcState) return;
    Array.prototype.forEach.call($("#arcLiqBody").querySelectorAll("tr[data-qid]"), function (tr) {
      var t = null;
      for (var i = 0; i < arcState.tranches.length; i++) {
        if (arcState.tranches[i].id === tr.dataset.qid) { t = arcState.tranches[i]; break; }
      }
      if (!t) return;
      var p = num(t.price), q = num(t.qty);
      var amt = (p > 0 && q > 0) ? p * q : NaN;
      tr.querySelector(".liqamt").textContent = isFinite(amt) ? yuan(amt) : "—";
    });
  }

  function arcAddLiq(qty, noFocus) {
    if (!arcState) return;
    arcState.tranches.push({ id: uid("q"), price: "", qty: qty === undefined ? "" : String(qty) });
    renderLiqRows();
    paintArc();
    if (noFocus) return;
    var rows = $("#arcLiqBody").querySelectorAll("tr[data-qid]");
    var last = rows[rows.length - 1];
    if (last) last.querySelector('[data-k="price"]').focus();
  }

  function kv(k, v) { return '<div class="kv"><span>' + k + '</span><span>' + v + '</span></div>'; }

  function archiveStock(id) {
    var s = findStock(id);
    if (!s) return;
    var sh = isShort(s);
    var label = (s.name || "").trim() || "未命名股票";
    var c = calcStock(s);
    if (c.timeline.error) { alert(c.timeline.error + "\n请先修正流水再存档。"); return; }

    if (!(c.openQty > EPS)) {
      alert(sh ? "「" + label + "」还没有卖出开仓记录，无法存档。"
               : "「" + label + "」还没有买入记录，无法存档。");
      return;
    }
    /* 超卖（平仓多于开仓）时逐笔清盘永远配不平，直接以「强制清盘」模式打开
       —— 这正是这个模式存在的意义（做T 之后数量对不上就属于这类）。 */
    var forceFirst = !!c.over;

    arcState = { id: id, liqQty: c.remainQty > EPS ? c.remainQty : 0, tranches: [] };

    $("#arcTitle").textContent = "存档为已完成交易 · " + label;
    var rows = [];
    if (forceFirst) {
      rows.push('<div class="kv"><span class="warnc">⚠ 数量对不上</span><span class="warnc">' +
        (sh ? "平仓买入 " + fmtQty(c.buyQty) + " 股 > 开仓卖出 " + fmtQty(c.sellQty) + " 股"
            : "卖出 " + fmtQty(c.sellQty) + " 股 > 买入 " + fmtQty(c.buyQty) + " 股") +
        '</span></div>');
      rows.push('<div class="kv"><span class="muted">建议</span><span class="muted">' +
        '用下面的「强制清盘」：直接填你实际成交的价格和数量，盈亏按「价差 × 数量」分两段结算</span></div>');
    }
    rows.push(kv("方向", dirName(s)));
    rows.push(kv(sh ? "开仓（卖出）" : "建仓（买入）",
      fmtQty(c.openQty) + " 股 · " + (sh ? c.sellLots : c.buyLots) + " 笔"));
    rows.push(kv(sh ? "已买回平仓" : "已卖出",
      fmtQty(c.closeQty) + " 股 · " + (sh ? c.buyLots : c.sellLots) + " 笔"));
    rows.push(kv("待清盘", arcState.liqQty > EPS
      ? fmtQty(arcState.liqQty) + " 股（下面逐笔分配）"
      : "无（已全部了结）"));
    $("#arcSummary").innerHTML = rows.join("");

    var wrap = $("#arcLiqWrap");
    if (arcState.liqQty > EPS) {
      wrap.style.display = "";
      $("#arcLiqHint").textContent = "　可分多笔、不同价格不同数量" + (isFinite(c.cur)
        ? "；当前实时价 ¥" + priceStr(c.cur) + " 仅供参考，请填你实际成交的价格"
        : "；请填你实际成交的价格");
      arcAddLiq(undefined, true);   // 先给一笔空行
    } else {
      wrap.style.display = "none";
      renderLiqRows();
    }
    $("#arcDate").value = todayStr();
    $("#arcTime").value = nowTradeTime().slice(11);
    /* 强制清盘的两个输入框每次都清空：数量本来就可能与记录不符，
       预填会把人锚定在错误的数字上；价格也按"不预填实时价"的既定约定留空 */
    $("#arcForcePrice").value = "";
    $("#arcForceQty").value = "";
    $("#arcMask").classList.add("on");
    setArcMode(forceFirst ? "force" : "step");
    setTimeout(function () {
      if (arcMode() === "force") return;          // 强制清盘模式下光标已在价格框
      if (arcState && arcState.liqQty > EPS) {
        var f = $("#arcLiqBody").querySelector('[data-k="price"]');
        if (f) f.focus();
      }
    }, 30);
  }

  function paintArc() {
    if (!arcState) return;
    var s = findStock(arcState.id);
    if (!s) return;

    /* 强制清盘模式：走另一套渲染（价差 × 数量，分两段口径） */
    if (arcMode() === "force") {
      var ff = forceCalc();
      paintForce();
      $("#arcOk").disabled = !(ff && ff.filled && isFinite(ff.net));
      return;
    }

    var needLiq = arcState.liqQty > EPS;
    var st = arcLiqStat();
    var box = $("#arcPreview");

    /* 明细表合计 + 剩余提示 */
    paintLiqAmounts();
    $("#arcLiqQty").textContent = fmtQty(st.sumQty);
    $("#arcLiqAmt").textContent = yuan(st.sumAmt);

    var leftEl = $("#arcLiqLeft");
    var done = needLiq && st.incomplete === 0 && Math.abs(st.left) < EPS;
    leftEl.className = done ? "liqleft good" : "liqleft";
    if (!needLiq) {
      leftEl.innerHTML = "";
    } else if (st.incomplete > 0) {
      leftEl.innerHTML = '<span class="bad">有 ' + st.incomplete + ' 笔没填完</span>（价格和数量都要填）';
    } else if (st.sumQty < st.need - EPS) {
      leftEl.innerHTML = '待清盘 <b>' + fmtQty(st.need) + '</b> 股，已分配 <b>' + fmtQty(st.sumQty) +
        '</b> 股，<span class="bad">还差 ' + fmtQty(st.left) + ' 股</span>';
    } else if (st.sumQty > st.need + EPS) {
      leftEl.innerHTML = '待清盘 <b>' + fmtQty(st.need) + '</b> 股，已分配 <b>' + fmtQty(st.sumQty) +
        '</b> 股，<span class="bad">超出 ' + fmtQty(-st.left) + ' 股</span>';
    } else {
      leftEl.innerHTML = '待清盘 <b>' + fmtQty(st.need) + '</b> 股，<span class="ok">已分配完毕</span>';
    }

    var canOk = !needLiq || st.ok;
    $("#arcOk").disabled = !canOk;

    if (!canOk) {
      box.className = "arcbox";
      box.innerHTML = '<span class="warnc">把待清盘的 ' + fmtQty(st.need) +
        ' 股全部分配完后</span>，这里会实时算出这笔交易最终的盈亏，确认无误再存档。';
      return;
    }

    var c = calcStock(arcEffStock(s));
    if (c.timeline.error) {
      $("#arcOk").disabled = true;
      box.className = "arcbox"; box.textContent = c.timeline.error + " 请检查本次清盘的日期和时间。";
      return;
    }
    var rows = [];
    if (needLiq) {
      rows.push(kv("清盘 " + fmtQty(st.sumQty) + " 股" + (st.n > 1 ? " · " + st.n + " 笔" : "") +
        " · 均价", "¥" + nf.format(st.sumAmt / st.sumQty) + "（金额 " + yuan(st.sumAmt) + "）"));
    }
    rows.push(kv("买入合计 · 加权均价", yuan(c.buyAmount) + " · ¥" + nf.format(c.avgBuyPrice)));
    rows.push(kv("卖出合计 · 加权均价", yuan(c.sellAmount) + " · ¥" + nf.format(c.avgSellPrice)));
    rows.push(kv("交易费用", yuan(r2(c.buyFee + c.sellFee)) +
      "（买 " + yuan(c.buyFee) + " / 卖 " + yuan(c.sellFee) + "）"));
    rows.push(kv(isShort(s) ? "释放成本" : "结转成本", yuan(c.carriedCost)));
    rows.push('<div class="kv"><span>已实现盈亏</span><span class="' + cls(c.realized) + '">' +
      money(c.realized, true) + "（" + pct(c.realizedRate) + "）</span></div>");
    box.className = "arcbox good";
    box.innerHTML = rows.join("");
  }

  function closeArc() {
    arcState = null;
    $("#arcMask").classList.remove("on");
  }

  /* ============================================================
     强制清盘
     用途：做T / 多次进出之后，系统算出来的持仓数量与券商实际对不上
     （例如"卖 100 手、之后用同样的钱买回 101 手"，系统会只剩 1 手）。
     这时直接输入你实际成交的价格和数量：**数量可以比记录的多、也可以少**。

     盈亏口径（2026-09-17 起改为「价差 × 数量」，分两桶结算）：
        已了结部分（记录里已经平掉的那部分）：
          多头 =（已卖出均价 − 建仓买入均价）× 已卖出数量
          空头 =（开仓卖出均价 − 已买回均价）× 已买回数量
        清盘部分（本次输入的成交）：
          多头 =（清盘卖出均价 − 建仓买入均价）×（建仓数量 − 已卖出数量）
          空头 =（开仓卖出均价 − 清盘买回均价）×（开仓数量 − 已买回数量）
     两桶数量之和 = 建仓数量，与「价差 × 建仓数量」一脉相承；
     均价一律用不含费的成交均价，价差取大小、正负由方向决定（谁卖得高谁赚）。

     为什么分两桶：强制清盘前你可能已经先平掉一部分，它的成交价和本次清盘价往往不同。
     把已了结的那部分也按清盘价算，等于用假设价覆盖真实成交价 —— 真实盈亏会被吞掉。

     为什么不用「金额差」（原来的口径）：
       做 T 时"用同样的钱买回更多股"，买卖总金额几乎相等，
       金额差只剩下手续费，看着像没赚 —— 但真实赚到的是「价差 × 数量」。
     费用不进这个公式，仍按当时费率逐笔计提、单独统计在「累计交易费用」卡里。
     ============================================================ */
  function arcMode() {
    var el = document.querySelector('input[name="arcmode"]:checked');
    return el ? el.value : "step";
  }

  function forceCalc() {
    if (!arcState) return null;
    var s = findStock(arcState.id);
    if (!s) return null;
    var sh = isShort(s);
    var c = calcStock(s);
    var price = num($("#arcForcePrice").value);
    var qty = num($("#arcForceQty").value);
    var filled = price > 0 && qty > 0;
    var gross = filled ? r2(price * qty) : 0;
    /* 空头清盘 = 买回（按买入计费）；多头清盘 = 卖出（按卖出计费，含印花税） */
    var fee = filled ? lotFee(gross, sh).total : 0;

    /* 建仓（开仓）侧的成交均价与数量：空头 = 开仓卖出，多头 = 建仓买入 */
    var openQty = c.openQty;
    var openAvg = sh ? c.avgSellPrice : c.avgBuyPrice;   // 成交均价（不含费）

    /* 强制清盘前已经了结的那部分（记录里的平仓腿）：
       空头 = 已买回，多头 = 已卖出。它们的实际均价往往和本次清盘价不同，
       所以要和清盘部分分开算，否则这部分真实盈亏会被吞掉。 */
    var closedQty = sh ? c.buyQty : c.sellQty;
    var closedAvg = sh ? c.avgBuyPrice : c.avgSellPrice;

    /* 金额口径：仍用于「结转成本 / 收益率分母」，并作为界面上的对照参考。
       对照要把全部腿算进来（已了结的 + 本次清盘的），否则与盈亏口径没法比。 */
    var base, close;
    if (sh) {
      base = r2(c.sellAmount - c.sellFee);                          // 开仓卖出实际到手
      close = filled ? r2(c.buyAmount + c.buyFee + gross + fee) : 0; // 全部买回实际付出（含费）
    } else {
      base = r2(c.buyAmount + c.buyFee);                            // 建仓买入实际付出
      close = filled ? r2(c.sellAmount - c.sellFee + gross - fee) : 0; // 全部卖出实际到手（扣费）
    }
    var amountDiff = filled ? r2(sh ? base - close : close - base) : NaN;

    /* 盈亏口径：价差 × 数量，分两桶算（价差取大小，正负由方向决定）
         已了结部分：建仓均价 − 已了结均价（占 closedQty 股）
         清盘部分  ：建仓均价 − 清盘均价（占 建仓数量 − 已了结数量 股）
       两桶的数量之和恰好等于「建仓数量」，与「价差 × 建仓数量」的口径一脉相承；
       刻意不扣费用（费用单列在「累计交易费用」卡）。 */
    var spreadClosed = (closedQty > EPS && isFinite(closedAvg) && isFinite(openAvg))
      ? (sh ? openAvg - closedAvg : closedAvg - openAvg) : NaN;
    /* 清盘桶的数量以「记录剩余」为准：清盘数量填得比记录多/少只影响记录与差额提示，
       不改变盈亏基数（用户定的口径是「按建仓数量」）。记录显示已全部了结时
       剩余为 0，此时回落到用户填的数量，免得盈亏恒为 0。 */
    var partQty = openQty - closedQty;
    if (partQty <= EPS) partQty = qty;
    var spread = (isFinite(openAvg) && partQty > EPS)
      ? (sh ? openAvg - price : price - openAvg) : NaN;
    var partClosed = isFinite(spreadClosed) ? r2(spreadClosed * closedQty) : 0;
    var partForce = (filled && isFinite(spread)) ? r2(spread * partQty) : NaN;
    if (c.timeline.mode === "ordered") {
      /* 已按时间结转的成交不得再用全周期均价重算。强平仍保留不扣费的旧展示规则。 */
      partClosed = c.timeline.grossRealized;
      var remainingAvg = c.remainQty > EPS ? c.timeline.grossBasis / c.remainQty : NaN;
      spread = sh ? remainingAvg - price : price - remainingAvg;
      partForce = filled && isFinite(spread) ? r2(spread * partQty) : NaN;
      spreadClosed = closedQty > EPS ? partClosed / closedQty : NaN;
    }
    var net = (filled && isFinite(partForce)) ? r2(partClosed + partForce) : NaN;

    return { s: s, sh: sh, c: c, price: price, qty: qty, gross: gross, fee: fee,
             filled: filled, base: base, close: close,
             openQty: openQty, openAvg: openAvg,
             closedQty: closedQty, closedAvg: closedAvg, spreadClosed: spreadClosed,
             partQty: partQty, partClosed: partClosed, partForce: partForce,
             spread: spread, amountDiff: amountDiff, net: net,
             recQty: c.remainQty, diff: filled ? r2(qty - c.remainQty) : NaN };
  }

  function paintForce() {
    var f = forceCalc();
    if (!f) return;
    var sh = f.sh, c = f.c;
    var lbl = $("#arcForcePriceLbl");
    if (lbl) lbl.textContent = sh ? "买回价 ¥" : "清盘卖出价 ¥";

    var hint = [];
    hint.push("记录：" + (sh ? "开仓卖出 " : "建仓买入 ") + fmtQty(c.openQty) + " 股" +
      (f.closedQty > EPS
        ? " · " + (sh ? "已买回平仓 " : "已卖出平仓 ") + fmtQty(f.closedQty) + " 股"
        : "") +
      " · 剩余 " + fmtQty(c.remainQty) + " 股" +
      (c.over ? "（⚠ 平仓多于开仓，逐笔清盘配不平）" : ""));
    if (f.filled) {
      var d = f.diff;
      hint.push("本次 " + fmtQty(f.qty) + " 股" +
        (Math.abs(d) > EPS
          ? "（比记录剩余" + (d > 0 ? "多 " : "少 ") + fmtQty(Math.abs(d)) + " 股，允许）"
          : "（与记录剩余一致）"));
    } else {
      hint.push("填成交价与数量即可；数量比记录的多或少都没关系");
    }
    $("#arcForceHint").innerHTML = hint.join("　·　");

    var rows = [];
    rows.push(kv(sh ? "开仓卖出（记录）" : "建仓买入（记录）",
      fmtQty(f.openQty) + " 股 · 成交均价 ¥" + pexact(f.openAvg)));
    if (c.timeline.mode === "ordered") {
      rows.push(kv("剩余部分成交成本（不含费）", c.remainQty > EPS ? price3(c.timeline.grossBasis / c.remainQty) : "已全部平仓，请使用逐笔清盘直接存档"));
    }
    if (f.closedQty > EPS) {
      rows.push(kv(sh ? "已买回平仓（记录）" : "已卖出平仓（记录）",
        fmtQty(f.closedQty) + " 股 · 成交均价 ¥" + pexact(f.closedAvg)));
    }
    rows.push(kv(sh ? "清盘买回（本次）" : "清盘卖出（本次）", f.filled
      ? fmtQty(f.qty) + " 股 · 成交均价 ¥" + pexact(f.price) : "待填"));
    if (f.filled) {
      /* 已了结的那部分单独列：它的成交价与本次清盘价往往不同，混在一起就看不出被吞掉了 */
      if (f.closedQty > EPS && isFinite(f.spreadClosed)) {
        rows.push(kv("已了结部分（记录）", "价差 " + (f.spreadClosed > 0 ? "+" : "") +
          pexact(f.spreadClosed) + " × " + fmtQty(f.closedQty) + " 股 = " +
          money(f.partClosed, true)));
      }
      rows.push(kv("清盘部分（本次）", "价差 " + (f.spread > 0 ? "+" : "") +
        pexact(f.spread) + " × " + fmtQty(f.partQty) + " 股 = " +
        money(f.partForce, true)));
    }
    rows.push('<div class="kv"><span>已实现盈亏（价差 × 数量，合计）</span><span class="' +
      (f.filled ? cls(f.net) : "flat") + '">' + (f.filled ? money(f.net, true) : "—") + "</span></div>");
    /* 口径与对照说明单独占一行整宽：塞进 .kv 的右列会在窄弹窗里折得很碎 */
    var note = [];
    if (c.timeline.mode === "ordered") {
      note.push("<b>口径</b>：已了结部分保留按成交顺序结转的毛收益，其余按剩余持仓的成交成本与本次清盘价结算，不追溯改写历史成交。");
    } else if (f.closedQty > EPS) {
      note.push('<b>口径</b>：已了结的 ' + fmtQty(f.closedQty) + ' 股按记录均价 ¥' +
        pexact(f.closedAvg) + " 算，其余 " + fmtQty(f.partQty) + " 股按本次清盘价 ¥" +
        pexact(f.price) + " 算；两段数量之和 = " + (sh ? "开仓" : "建仓") + "数量 " +
        fmtQty(f.openQty) + " 股");
    } else {
      note.push('<b>口径</b>：卖出均价 − 买入均价，再乘 ' + fmtQty(f.partQty) +
        " 股（= " + (sh ? "开仓" : "建仓") + "数量）；价差取大小，正负由方向决定");
    }
    note.push("<b>不扣费用</b>：费用按当时费率逐笔计提，单列在顶部「累计交易费用」卡");
    if (f.filled && Math.abs(f.diff) > EPS) {
      note.push("<b>数量差异</b>：本次填的 " + fmtQty(f.qty) + " 股与记录剩余 " +
        fmtQty(f.c.remainQty) + " 股相差 " + fmtQty(Math.abs(f.diff)) +
        " 股，盈亏基数取记录剩余（= " + (sh ? "开仓" : "建仓") + "数量 − 已了结数量），" +
        "差异只影响记录里的股数，不影响盈亏");
    }
    if (f.filled && isFinite(f.amountDiff)) {
      note.push('<b>对照</b>：金额差口径（到手 − 付出，含全部腿与费用）= ' +
        money(f.amountDiff, true) + " —— 与上面的差额就是各笔手续费");
    }
    rows.push('<div class="arcnote">' + note.join("<br>") + "</div>");
    var box = $("#arcPreview");
    box.className = f.filled ? "arcbox good" : "arcbox";
    box.innerHTML = rows.join("");
  }

  /* 切换模式：step = 逐笔清盘（原有逻辑），force = 强制清盘 */
  function setArcMode(m) {
    var force = m === "force";
    var radio = document.querySelector('input[name="arcmode"][value="' + m + '"]');
    if (radio) radio.checked = true;
    $("#arcLiqWrap").style.display =
      force ? "none" : (arcState && arcState.liqQty > EPS ? "" : "none");
    $("#arcForceWrap").style.display = force ? "" : "none";
    $("#arcOk").textContent = force ? "确认强制清盘" : "确认存档";
    paintArc();
    if (force) {
      setTimeout(function () { var el = $("#arcForcePrice"); if (el) el.focus(); }, 30);
    }
  }

  function confirmArcForce() {
    if (!arcState) return;
    var s = findStock(arcState.id);
    if (!s) { closeArc(); return; }
    var f = forceCalc();
    if (f && f.c.timeline.mode === "ordered" && !(f.c.remainQty > EPS)) { alert("这支持仓已按流水全部平仓，请用「逐笔清盘」直接存档，无需再录一笔强制清盘。"); return; }
    if (!f || !f.filled) { alert("请先填好成交价和数量（都要大于 0）。"); return; }
    if (!(f.base > 0)) {
      alert("这支股票没有建仓 / 开仓记录，算不出要结算的金额，无法强制清盘。");
      return;
    }
    var sh = f.sh, label = (s.name || "").trim() || "未命名股票";
    var dateStr = $("#arcDate").value || todayStr();
    if (f.c.timeline.mode === "ordered") {
      var at = tradeTime(dateStr + "T" + $("#arcTime").value);
      var last = f.c.timeline.rows[f.c.timeline.rows.length - 1];
      if (!at || at < last.at) { alert("本次清盘时间不能早于最后一笔已有成交，请检查日期和时间。"); return; }
    }
    var priceS = priceStr(f.price);
    var need = [ (sh ? "开仓卖出" : "建仓买入") + "：" + fmtQty(f.openQty) + " 股 · 成交均价 ¥" +
        pexact(f.openAvg),
      (sh ? "清盘买回" : "清盘卖出") + "：" + fmtQty(f.qty) + " 股 @ ¥" + priceS ];
    if (f.closedQty > EPS) {
      need.push((sh ? "已买回平仓（记录）" : "已卖出平仓（记录）") + "：" + fmtQty(f.closedQty) +
        " 股 · 成交均价 ¥" + pexact(f.closedAvg));
      need.push("已了结部分：" + (f.spreadClosed > 0 ? "+" : "") + pexact(f.spreadClosed) + " × " +
        fmtQty(f.closedQty) + " 股 = " + money(f.partClosed, true));
    }
    need.push("清盘部分：" + (f.spread > 0 ? "+" : "") + pexact(f.spread) + " × " +
      fmtQty(f.partQty) + " 股 = " + money(f.partForce, true));
    need.push("已实现盈亏（合计）：" + money(f.net, true));
    need.push("");
    need.push("系统记录的剩余是 " + fmtQty(f.c.remainQty) + " 股，本次清盘 " + fmtQty(f.qty) + " 股" +
      (Math.abs(f.diff) > EPS ? "（相差 " + fmtQty(Math.abs(f.diff)) + " 股）" : "") + "。");
    need.push(f.c.timeline.mode === "ordered" ? "已了结部分保留流水结转的毛收益；其余按剩余成交成本与本次清盘价结算，均不含费；" : "盈亏按「价差 × 数量」分两段结算（已了结的按记录均价、其余的按本次清盘价，均不含费）；");
    need.push("这支股票原来的中间买卖记录不再单独计算盈亏；");
    need.push("整支股票会移到下方「已完成交易记录」。");
    if (!confirm("强制清盘「" + label + "」\n\n" + need.join("\n"))) return;

    /* 记录里的均价/数量/金额要把「已了结的那部分」一起算进来，否则
       均价 × 股数 ≠ 金额，导出的 CSV 会和已实现盈亏对不上。 */
    var histBuyQty = sh ? f.c.buyQty + f.qty : f.c.buyQty;
    var histSellQty = sh ? f.c.sellQty : f.c.sellQty + f.qty;
    var histBuyAmt = sh ? r2(f.c.buyAmount + f.gross) : f.c.buyAmount;
    var histSellAmt = sh ? f.c.sellAmount : r2(f.c.sellAmount + f.gross);
    state.hist.push({
      id: uid("h"), date: dateStr, name: s.name || "", code: s.code || "", dir: s.dir,
      accounting: "forced", tradeLog: tradeTimeline({ dir: s.dir,
        buys: s.buys.concat(sh ? [{ price: String(f.price), qty: String(f.qty), at: dateStr + "T" + $("#arcTime").value, order: nextTradeOrder(s) }] : []),
        sells: s.sells.concat(sh ? [] : [{ price: String(f.price), qty: String(f.qty), at: dateStr + "T" + $("#arcTime").value, order: nextTradeOrder(s) }]) }).rows,
      buy: (histBuyQty > 0 ? histBuyAmt / histBuyQty : f.price).toFixed(4),
      sell: (histSellQty > 0 ? histSellAmt / histSellQty : f.price).toFixed(4),
      qty: String(sh ? histBuyQty : histSellQty),
      buyQty: histBuyQty, sellQty: histSellQty,
      buyLots: sh ? f.c.buyLots + 1 : f.c.buyLots,
      sellLots: sh ? f.c.sellLots : f.c.sellLots + 1,
      buyAmount: histBuyAmt, sellAmount: histSellAmt,
      buyFee: r2(f.c.buyFee + (sh ? f.fee : 0)),
      sellFee: r2(f.c.sellFee + (sh ? 0 : f.fee)),
      fees: r2(f.c.buyFee + f.c.sellFee + f.fee),
      cost: f.base, net: f.net, rate: f.base > 0 ? f.net / f.base : NaN,
      /* 计划快照：为后面按策略归因留数据（止损价是算 R 倍数的分母） */
      planWhy: planOf(s).why, planTag: planOf(s).tag,
      planStop: num(planOf(s).stop) || 0, planTarget: num(planOf(s).target) || 0,
      forced: true, forcePrice: f.price, forceQty: f.qty,
      commBuyAtSave: state.fees.commBuy, commSellAtSave: state.fees.commSell,
      stampAtSave: state.fees.stamp, transferAtSave: state.fees.transfer, minCommAtSave: state.fees.minComm
    });

    state.stocks = state.stocks.filter(function (x) { return x.id !== arcState.id; });
    keepOnBoard(s);              // 平仓不等于不再关心：留在看板上继续盯高低位
    closeArc();
    save();
    renderTable();
    renderHist();
    renderWatchPanel();
    refreshWatchKlines(false);   // 新留在看板上的这支还没有K线缓存，顺手拉一次
    paintBackupStatus("已强制清盘「" + label + "」· " + fmtQty(f.qty) + " 股 @ ¥" + priceS +
      " · 已实现 " + money(f.net, true), "ok");
    var panel = $("#histPanel");
    if (panel && panel.scrollIntoView) panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function confirmArc() {
    if (!arcState) return;
    var s = findStock(arcState.id);
    if (!s) { closeArc(); return; }
    var sh = isShort(s);
    var label = (s.name || "").trim() || "未命名股票";
    var needLiq = arcState.liqQty > EPS;
    var st = arcLiqStat();
    if (needLiq && !st.ok) { paintArc(); return; }

    var c = calcStock(arcEffStock(s));
    if (c.timeline.error) { alert(c.timeline.error); return; }
    if (!qtyEq(c.openQty, c.closeQty)) {
      alert("加上清盘数量后仍未完全了结，请检查明细。\n\n开仓 " + fmtQty(c.openQty) +
        " 股 / 平仓 " + fmtQty(c.closeQty) + " 股");
      return;
    }

    var dateStr = $("#arcDate").value || todayStr();
    state.hist.push({
      id: uid("h"), date: dateStr, name: s.name || "", code: s.code || "", dir: s.dir,
      accounting: c.timeline.mode, tradeLog: c.timeline.rows,
      buy: c.avgBuyPrice.toFixed(4), sell: c.avgSellPrice.toFixed(4), qty: String(c.openQty),
      buyQty: c.buyQty, sellQty: c.sellQty, buyLots: c.buyLots, sellLots: c.sellLots,
      buyAmount: c.buyAmount, sellAmount: c.sellAmount,
      buyFee: c.buyFee, sellFee: c.sellFee, fees: r2(c.buyFee + c.sellFee),
      cost: c.carriedCost, net: c.realized, rate: c.realizedRate,
      /* 计划快照：为后面按策略归因留数据（止损价是算 R 倍数的分母） */
      planWhy: planOf(s).why, planTag: planOf(s).tag,
      planStop: num(planOf(s).stop) || 0, planTarget: num(planOf(s).target) || 0,
      commBuyAtSave: state.fees.commBuy, commSellAtSave: state.fees.commSell,
      stampAtSave: state.fees.stamp, transferAtSave: state.fees.transfer, minCommAtSave: state.fees.minComm
    });

    var liqNote = "";
    if (needLiq) {
      var valid = arcValidTranches();
      liqNote = (valid.length === 1)
        ? "（清盘 " + fmtQty(st.sumQty) + " 股 @ ¥" + priceStr(num(valid[0].price)) + "）"
        : "（清盘 " + fmtQty(st.sumQty) + " 股 · " + valid.length + " 笔均价 ¥" +
          priceStr(st.sumAmt / st.sumQty) + "）";
    }
    state.stocks = state.stocks.filter(function (x) { return x.id !== arcState.id; });
    keepOnBoard(s);              // 平仓不等于不再关心：留在看板上继续盯高低位
    closeArc();
    save();
    renderTable();
    renderHist();
    renderWatchPanel();
    refreshWatchKlines(false);   // 新留在看板上的这支还没有K线缓存，顺手拉一次
    paintBackupStatus("已存档「" + label + "」" + liqNote + " · 已实现 " + money(c.realized, true), "ok");

    var panel = $("#histPanel");
    if (panel && panel.scrollIntoView) panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  $("#arcClose").addEventListener("click", closeArc);
  $("#arcCancel").addEventListener("click", closeArc);
  $("#arcMask").addEventListener("click", function (e) { if (e.target === this) closeArc(); });
  $("#arcOk").addEventListener("click", function () {
    if (arcMode() === "force") confirmArcForce(); else confirmArc();
  });
  Array.prototype.forEach.call(document.querySelectorAll('input[name="arcmode"]'), function (el) {
    el.addEventListener("change", function () { if (this.checked) setArcMode(this.value); });
  });
  ["#arcForcePrice", "#arcForceQty"].forEach(function (sel) {
    $(sel).addEventListener("input", paintArc);
    $(sel).addEventListener("keydown", function (e) {
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (!$("#arcOk").disabled) confirmArcForce();
    });
  });
  ["#arcDate", "#arcTime"].forEach(function (sel) { $(sel).addEventListener("input", paintArc); });
  $("#arcAddLiq").addEventListener("click", function () { arcAddLiq(); });
  $("#arcAutoFill").addEventListener("click", function () {
    if (!arcState) return;
    var st = arcLiqStat();
    if (st.left <= EPS && st.incomplete === 0) { alert("待清盘的 " + fmtQty(st.need) + " 股已经分配完了。"); return; }
    /* 优先补到"已填价格但没填数量"的那一笔，省得再多一行 */
    var target = null;
    arcState.tranches.forEach(function (t) {
      if (num(t.price) > 0 && !(num(t.qty) > 0)) target = t;
    });
    if (target) {
      target.qty = String(st.left > EPS ? st.left : st.need);
      renderLiqRows();
      paintArc();
      return;
    }
    arcAddLiq(st.left > EPS ? st.left : st.need);
  });
  $("#arcLiqBody").addEventListener("input", function (e) {
    var el = e.target;
    if (!el.classList || !el.classList.contains("liq") || !arcState) return;
    var tr = el.closest("tr[data-qid]");
    for (var i = 0; i < arcState.tranches.length; i++) {
      if (arcState.tranches[i].id === tr.dataset.qid) { arcState.tranches[i][el.dataset.k] = el.value; break; }
    }
    paintArc();
  });
  $("#arcLiqBody").addEventListener("keydown", function (e) {
    if (e.key !== "Enter") return;
    var el = e.target;
    if (!el.classList || !el.classList.contains("liq")) return;
    e.preventDefault();
    if (!$("#arcOk").disabled) confirmArc();
    else arcAddLiq();
  });
  $("#arcLiqBody").addEventListener("click", function (e) {
    var d = e.target.closest(".del-liq");
    if (!d || !arcState) return;
    var qid = d.closest("tr[data-qid]").dataset.qid;
    arcState.tranches = arcState.tranches.filter(function (t) { return t.id !== qid; });
    renderLiqRows();
    paintArc();
  });

  /* ================= 已完成记录 ================= */
  function sortedHist() {
    return state.hist.map(function (h, i) { return { h: h, i: i }; })
      .sort(function (a, b) {
        if ((a.h.date || "") !== (b.h.date || "")) return (a.h.date || "") < (b.h.date || "") ? 1 : -1;
        return b.i - a.i;   // 同日：后存档的排前面
      })
      .map(function (x) { return x.h; });
  }
  function lotsHint(n) { return (n > 1) ? '<span class="hint">' + n + ' 笔均价</span>' : ""; }

  function histRowHtml(h) {
    var split = histProfit(h);
    var tag = h.forced
      ? '<span class="ftag" title="强制清盘：按实际成交的价格与数量一次性结清，盈亏 = 各段价差 × 数量（已了结的按记录均价、其余按清盘价），不扣费用">强制清盘</span>'
      : "";
    return '<tr data-id="' + h.id + '">' +
      '<td class="lft"><div class="hist-name">' + dirPill(h.dir, false) + nameHtml(h.name) + tag + '</div></td>' +
      '<td><input type="date" class="hdate" data-k="date" value="' + String(h.date || "") + '"></td>' +
      '<td class="mutedc">¥' + nf.format(num(h.buy)) + lotsHint(h.buyLots) + '</td>' +
      '<td class="mutedc">¥' + nf.format(num(h.sell)) + lotsHint(h.sellLots) + '</td>' +
      '<td>' + fmtQty(num(h.qty)) + '</td>' +
      '<td class="fee" data-tip="buy">¥' + nf.format(h.buyFee) + '</td>' +
      '<td class="fee" data-tip="sell">¥' + nf.format(h.sellFee) + '</td>' +
      '<td>¥' + nf.format(h.fees) + '</td>' +
      '<td><span class="cell-num net ' + cls(h.net) + '">' + money(h.net, true) + '</span>' +
        '<span class="profit-detail">毛 ' + money(split.gross, true) + ' · 净 ' + money(split.net, true) + '</span></td>' +
      '<td><span class="cell-num rate ' + cls(h.net) + '">' + pct(h.rate) + '</span></td>' +
      '<td><button class="ico del" title="删除这条记录">✕</button></td>' +
    '</tr>';
  }

  function renderHist() {
    var list = sortedHist();
    if (list.length === 0) {
      hbody.innerHTML = '<tr class="empty-row"><td colspan="11"><div class="empty">' +
        '还没有已了结的交易。<br>多头<b>全部卖出</b>（或空头<b>全部买回</b>）后，点持仓行尾的「<b>✓</b>」即可整支存档到这里。</div></td></tr>';
    } else {
      hbody.innerHTML = list.map(histRowHtml).join("");
      Array.prototype.forEach.call(hbody.querySelectorAll("tr[data-id]"), function (tr) {
        var h = null;
        for (var i = 0; i < state.hist.length; i++) { if (state.hist[i].id === tr.dataset.id) { h = state.hist[i]; break; } }
        if (!h) return;
        var mc = (h.minCommAtSave > 0) ? "，最低佣金 " + h.minCommAtSave + " 元" : "";
        tr.querySelector('[data-tip="buy"]').title = "存档时买入佣金 " + h.commBuyAtSave + "% + 过户费 " + h.transferAtSave + "%" + mc;
        tr.querySelector('[data-tip="sell"]').title = "存档时卖出佣金 " + h.commSellAtSave + "% + 印花税 " + h.stampAtSave + "% + 过户费 " + h.transferAtSave + "%" + mc;
      });
    }
    updateSummary();
  }

  hbody.addEventListener("change", function (e) {
    var el = e.target;
    if (!el.classList || !el.classList.contains("hdate")) return;
    var tr = el.closest("tr[data-id]");
    for (var i = 0; i < state.hist.length; i++) {
      if (state.hist[i].id === tr.dataset.id) { state.hist[i].date = el.value || state.hist[i].date; break; }
    }
    save();
    renderHistSum();
  });

  hbody.addEventListener("click", function (e) {
    var del = e.target.closest(".ico.del");
    if (!del) return;
    var tr = del.closest("tr[data-id]");
    var h = null;
    for (var i = 0; i < state.hist.length; i++) { if (state.hist[i].id === tr.dataset.id) { h = state.hist[i]; break; } }
    if (!h) return;
    if (!confirm("删除这条记录？\n\n[" + (h.dir === "short" ? "空" : "多") + "] " + (h.name || "未命名") +
      "　" + (h.date || "") + "\n已实现盈亏 " + money(h.net, true) + "\n\n删除后累计收益会同步减少，可在「误删恢复」中找回。")) return;
    if (!rememberRemoval("hist", [h], "删除交易记录「" + (h.name || "未命名") + "」")) return;
    state.hist = state.hist.filter(function (x) { return x.id !== h.id; });
    save();
    renderHist();
  });

  function renderHistSum(agg) {
    var n = state.hist.length, net = 0, fees = 0, buyFee = 0, sellFee = 0, cost = 0, qty = 0;
    var win = 0, lose = 0, flatN = 0, nLong = 0, nShort = 0;
    state.hist.forEach(function (h) {
      net += h.net; fees += h.fees; buyFee += h.buyFee; sellFee += h.sellFee; cost += h.cost; qty += num(h.qty);
      if (h.net > 0.0000001) win++; else if (h.net < -0.0000001) lose++; else flatN++;
      if (h.dir === "short") nShort++; else nLong++;
    });
    var totalRate = cost > 0 ? net / cost : NaN;
    var winRate = (win + lose) > 0 ? win / (win + lose) : NaN;

    var hNet = $("#h-net");
    hNet.textContent = money(net, true); hNet.className = "hs-v " + cls(net);
    var hTr = $("#h-totalrate");
    hTr.textContent = isFinite(totalRate) ? pct(totalRate) : "—"; hTr.className = "hs-v " + cls(net);
    $("#h-n").textContent = n;
    $("#h-n-sub").textContent = "盈利 " + win + " · 亏损 " + lose + " · 持平 " + flatN +
      (n > 0 ? "（多头 " + nLong + " / 空头 " + nShort + "）" : "");
    $("#h-win").textContent = isFinite(winRate) ? (winRate * 100).toFixed(1) + "%" : "—";
    $("#h-fee").textContent = yuan(fees);

    if (!agg) agg = aggregate();
    $("#h-count-tip").textContent = n === 0
      ? (state.stocks.length ? "还没有已了结的交易（了结后可在此存档）" : "还没有已了结的交易")
      : "已存档 " + n + " 笔 ｜ 持仓表 " + money(agg.total, true) + " ＋ 已存档 " + money(net, true) +
        " = 全部总收益 " + money(r2(net + agg.total), true) + "（与顶部「总收益」一致）";

    $("#h-t-qty").textContent = fmtQty(qty);
    $("#h-t-buyfee").textContent = yuan(buyFee);
    $("#h-t-sellfee").textContent = yuan(sellFee);
    $("#h-t-fee").textContent = yuan(fees);
    var htn = $("#h-t-net");
    htn.textContent = money(net, true); htn.className = cls(net);
    var htr = $("#h-t-rate");
    htr.textContent = isFinite(totalRate) ? pct(totalRate) : "—"; htr.className = cls(net);
    renderMonthly();
  }

  /* ================= 月度收益（已完成记录按月汇总，开关控制显示） =================
     按记录的成交日期归月；净收益柱从 0 轴向两侧伸展（右红盈 / 左绿亏，A股习惯），
     长度按所有月份里 |净收益| 的最大值等比；累计列按时间正序滚动累加（含当月）。 */
  function renderMonthly() {
    var box = $("#monthBox"), body = $("#monthBody");
    if (!box || !body || box.hidden) return;   // 收起时不渲染，省得每次刷新都白算
    var byMonth = {}, order = [];
    function add(date, net, fees, cost, closed) {
      var m = /^\d{4}-\d{2}/.test(String(date || "")) ? String(date).slice(0, 7) : "未知";
      if (!byMonth[m]) { byMonth[m] = { n: 0, win: 0, lose: 0, fees: 0, net: 0, cost: 0 }; order.push(m); }
      var o = byMonth[m];
      if (closed) o.n++;
      o.fees += num(fees) || 0; o.net += num(net) || 0; o.cost += num(cost) || 0;
      if (num(net) > 0.0000001) o.win++; else if (num(net) < -0.0000001) o.lose++;
    }
    function addLog(rows) { rows.forEach(function (r) { add(r.at, r.net, r.fee, r.cost, isFinite(num(r.net))); }); }
    state.stocks.forEach(function (s) {
      var t = tradeTimeline(s);
      if (t.mode === "ordered") addLog(t.rows);
    });
    state.hist.forEach(function (h) {
      if (h.accounting === "ordered" && h.tradeLog.length) addLog(h.tradeLog);
      else add(h.date, h.net, h.fees, h.cost, true);
    });
    if (order.length === 0) {
      body.innerHTML = '<tr class="empty-row"><td colspan="6"><div class="empty">' +
        '还没有可按月统计的交易。补齐持仓成交时间，或存档已了结交易后即可查看。</div></td></tr>';
      return;
    }
    order.sort();                              // YYYY-MM 字典序 = 时间序
    var cum = {}, run = 0;
    order.forEach(function (m) { run += byMonth[m].net; cum[m] = run; });
    order.reverse();                           // 新月份显示在上方
    var maxAbs = 0;
    order.forEach(function (m) { maxAbs = Math.max(maxAbs, Math.abs(byMonth[m].net)); });
    body.innerHTML = order.map(function (m) {
      var o = byMonth[m];
      var rate = o.cost > 0 ? o.net / o.cost : NaN;
      var half = maxAbs > 0 ? Math.abs(o.net) / maxAbs * 50 : 0;
      var bar = '<div class="mbar" title="当月净收益 ' + money(o.net, true) +
        (maxAbs > 0 ? '；柱长按 ' + money(maxAbs, true) + '（最大月）等比' : '') + '">' +
        (Math.abs(o.net) < 0.005 ? "" :
          (o.net > 0
            ? '<i class="pos" style="left:50%;width:' + half.toFixed(1) + '%"></i>'
            : '<i class="neg" style="right:50%;width:' + half.toFixed(1) + '%"></i>')) +
        '</div>';
      return '<tr>' +
        '<td class="mutedc">' + m + '</td>' +
        '<td>' + o.n + '<span class="hint">' + o.win + ' / ' + o.lose + '</span></td>' +
        '<td class="mutedc">' + yuan(o.fees) + '</td>' +
        '<td>' + bar + '</td>' +
        '<td><span class="cell-num net ' + cls(o.net) + '">' + money(o.net, true) + '</span>' +
          (isFinite(rate) ? '<span class="hint sub">收益率 ' + pct(rate) + '</span>' : '') + '</td>' +
        '<td><span class="cell-num net ' + cls(cum[m]) + '">' + money(cum[m], true) + '</span></td>' +
        '</tr>';
    }).join("");
  }

  /* ================= 费率 ================= */
  var FEE_FIELDS = ["commBuy", "commSell", "stamp", "transfer", "minComm"];
  function paintFees() { FEE_FIELDS.forEach(function (k) { $("#f-" + k).value = state.fees[k]; }); }
  /* 实时行情相关控件回填（导入备份后需要重新同步） */
  function paintSettings() {
    $("#qinterval").value = String(state.settings.interval);
    $("#autoq").checked = !!state.settings.auto;
    applyAutoRefresh();
  }
  FEE_FIELDS.forEach(function (k) {
    var el = $("#f-" + k);
    el.addEventListener("input", function () {
      var v = num(this.value);
      state.fees[k] = (isFinite(v) && v >= 0) ? v : 0;
      save(); refreshAll();
    });
    el.addEventListener("blur", function () {
      var v = num(this.value);
      state.fees[k] = (isFinite(v) && v >= 0) ? v : 0;
      this.value = state.fees[k];
      save(); refreshAll();
    });
  });

  /* ================= 存储 ================= */
  function save() {
    renderRecovery();
    var warning = $("#save-warning");
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      warning.hidden = true;
      return true;
    } catch (e) {
      warning.hidden = false;
      warning.textContent = "本地保存失败，可能是存储空间不足或浏览器限制。请先导出 JSON 备份；未保存的改动和恢复记录在关闭页面后可能丢失。";
      return false;
    }
  }
  function copyData(value) { return JSON.parse(JSON.stringify(value)); }
  function rememberRecovery(type, label, data) {
    var previous = state.recovery;
    state.recovery = [{ id: uid("r"), at: new Date().toISOString(), type: type, label: label, data: copyData(data) }].concat(previous).slice(0, 10);
    /* 先保存恢复点，失败则由调用方取消删除或覆盖。 */
    if (!save()) {
      state.recovery = previous;
      renderRecovery();
      alert("无法保存恢复点，本次操作已取消。请先导出 JSON 备份，并检查浏览器的本地存储空间。");
      return false;
    }
    return true;
  }
  function rememberRemoval(type, items, label, extra) {
    if (!items.length) return true;
    return rememberRecovery(type, label, Object.assign({ items: items }, extra || {}));
  }
  function userSnapshot() {
    return { stocks: state.stocks, hist: state.hist, watch: state.watch,
      fees: state.fees, settings: state.settings, alertState: state.alertState, lastBackupAt: state.lastBackupAt };
  }
  function renderRecovery() {
    var list = $("#recovery-list");
    $("#recovery-count").textContent = state.recovery.length;
    list.textContent = "";
    if (!state.recovery.length) { list.textContent = "暂无需要恢复的操作。"; return; }
    state.recovery.forEach(function (entry) {
      var row = document.createElement("div"), text = document.createElement("span"), btn = document.createElement("button");
      row.className = "recovery-item";
      text.textContent = prettyTime(entry.at) + " · " + entry.label;
      btn.type = "button"; btn.className = "btn sm"; btn.textContent = "恢复";
      btn.dataset.recovery = entry.id;
      row.appendChild(text); row.appendChild(btn); list.appendChild(row);
    });
  }
  function restoreRecovery(id) {
    var entry = state.recovery.find(function (x) { return x.id === id; });
    if (!entry) return;
    var data = entry.data;
    if (entry.type === "replace") {
      if (!confirm("恢复覆盖导入前的数据？\n\n这会替换当前全部持仓、交易记录、观察池、费率与设置。当前数据也会自动保存为一个恢复点。")) return;
      if (!rememberRecovery("replace", "恢复前的完整数据", userSnapshot())) return;
      state.stocks = normalizeStocks(data.stocks, true);
      state.hist = data.hist.map(normalizeHist);
      state.watch = normalizeWatch(data.watch);
      state.fees = normalizeFees(data.fees);
      state.settings = Object.assign({}, DEF_SETTINGS, copyData(data.settings));
      state.settings.alert = normalizeAlert(state.settings.alert);
      state.settings.kline = normalizeKlineAlert(state.settings.kline);
      state.alertState = copyData(data.alertState);
      state.lastBackupAt = data.lastBackupAt || "";
    } else {
      var dest;
      if (entry.type === "lot") {
        var stock = findStock(data.stockId);
        if (!stock) { alert("对应持仓已不存在，请先恢复这支持仓，再恢复批次。可先恢复覆盖导入前的数据，或从 JSON 备份找回。"); return; }
        dest = data.kind === "buy" ? stock.buys : stock.sells;
      } else dest = state[entry.type];
      if (!Array.isArray(dest) || !Array.isArray(data.items)) return;
      data.items.forEach(function (item) {
        /* 合并恢复只补回缺失项，保留用户之后的新增与修改。 */
        var exists = dest.some(function (x) { return x.id === item.id ||
          (entry.type === "watch" && toQuoteCode(x.code) === toQuoteCode(item.code)); });
        if (!exists) dest.push(entry.type === "hist" ? normalizeHist(item) : entry.type === "stocks" ? normalizeStocks([item], true)[0] : copyData(item));
      });
    }
    state.recovery = state.recovery.filter(function (x) { return x.id !== id; });
    save();
    paintFees(); paintSettings(); paintAlertSettings(); paintKlineSettings();
    renderTable(); renderHist(); renderWatchPanel();
    paintBackupStatus("已恢复：" + entry.label, "ok");
  }
  $("#recovery-list").addEventListener("click", function (e) {
    var btn = e.target.closest("button[data-recovery]");
    if (btn) restoreRecovery(btn.dataset.recovery);
  });
  function normalizeTradeLog(list) {
    return (Array.isArray(list) ? list : []).filter(function (r) { return r && (r.kind === "buy" || r.kind === "sell") && num(r.price) > 0 && num(r.qty) > 0; }).map(function (r, i) {
      var out = { kind: r.kind, at: tradeTime(r.at), order: num(r.order) > 0 ? num(r.order) : i + 1 };
      ["price", "qty", "amount", "fee", "cost", "net", "gross", "balance", "basis", "unitCost"].forEach(function (k) { out[k] = num(r[k]); });
      return out;
    });
  }
  function normalizeHist(h) {
    return {
      id: uid("h"), date: h.date || todayStr(), name: h.name || "", code: String(h.code || ""), dir: h.dir === "short" ? "short" : "long",
      accounting: h.accounting === "ordered" ? "ordered" : h.forced ? "forced" : "legacy", tradeLog: normalizeTradeLog(h.tradeLog),
      buy: h.buy || "", sell: h.sell || "", qty: h.qty || "",
      buyQty: num(h.buyQty), sellQty: num(h.sellQty),
      buyLots: num(h.buyLots) || 1, sellLots: num(h.sellLots) || 1,
      buyAmount: num(h.buyAmount), sellAmount: num(h.sellAmount),
      buyFee: num(h.buyFee) || 0, sellFee: num(h.sellFee) || 0, fees: num(h.fees) || 0,
      cost: num(h.cost) || 0, net: num(h.net) || 0, rate: num(h.rate),
      /* 强制清盘的标记（口径与逐笔清盘不同，需要保留以便记录里区分显示） */
      forced: !!h.forced, forcePrice: num(h.forcePrice) || 0, forceQty: num(h.forceQty) || 0,
      /* 存档当时的交易计划快照（用于按策略归因 / 算 R 倍数，旧记录缺省值为空） */
      planWhy: String(h.planWhy || ""), planTag: String(h.planTag || ""),
      planStop: num(h.planStop) || 0, planTarget: num(h.planTarget) || 0,
      commBuyAtSave: num(h.commBuyAtSave), commSellAtSave: num(h.commSellAtSave),
      stampAtSave: num(h.stampAtSave), transferAtSave: num(h.transferAtSave),
      minCommAtSave: num(h.minCommAtSave) || 0
    };
  }
  function mkLots(list, offset) {
    return (Array.isArray(list) ? list : []).map(function (l, i) {
      return { id: uid("l"), price: l.price === undefined ? "" : l.price, qty: l.qty === undefined ? "" : l.qty,
        at: String(l.at || ""), order: l.order === undefined ? (offset || 0) + i + 1 : l.order };
    });
  }
  function normalizeWatch(arr) {
    var out = [], seen = {};
    (Array.isArray(arr) ? arr : []).forEach(function (w) {
      if (!w || typeof w !== "object") return;
      var code = String(w.code || "").trim();
      if (!code || !toQuoteCode(code)) return;
      var c = toQuoteCode(code);
      if (seen[c]) return;
      seen[c] = true;
      out.push({ id: String(w.id || uid("w")), code: code, name: String(w.name || ""),
        sec: String(w.sec || "").trim(), closed: !!w.closed });
    });
    return out;
  }
  /* 交易计划（每支头寸一份）：把「事前想清楚了没有」落到数据上，
     是后面 R 倍数、止损提醒、按策略归因的共同输入。
     stop 是初始风险的分母（入场均价到止损的价差），没填 stop 就什么都算不出来。 */
  var DEF_PLAN = { why: "", tag: "", stop: "", target: "", capital: "", riskPct: "" };
  function normalizePlan(p) {
    p = p && typeof p === "object" ? p : {};
    return {
      why: String(p.why || "").slice(0, 200),
      tag: String(p.tag || "").trim().slice(0, 24),
      stop: String(p.stop || ""), target: String(p.target || ""),
      capital: String(p.capital || ""), riskPct: String(p.riskPct || "")
    };
  }
  function planOf(s) { return normalizePlan(s && s.plan); }
  function normalizeStocks(arr, preserveIds) {
    var seen = new Set();
    return arr.map(function (s) {
      /* 本地重载保留 ID，让按持仓 ID 保存的提醒闩锁继续生效。
         导入使用新 ID；旧数据缺失、重复或不适合 DOM 选择器的 ID 自动补齐。 */
      var id = preserveIds && typeof s.id === "string" && /^[a-zA-Z0-9_-]+$/.test(s.id) ? s.id : "";
      if (!id || seen.has(id)) {
        do { id = uid("s"); } while (seen.has(id));
      }
      seen.add(id);
      return {
        id: id, name: s.name || "", code: s.code || "", cur: s.cur || "",
        dir: s.dir === "short" ? "short" : "long",
        sec: String(s.sec || "").trim(),
        plan: normalizePlan(s.plan),
        expanded: !!s.expanded,
        buys: mkLots(s.buys, s.dir === "short" && Array.isArray(s.sells) ? s.sells.length : 0),
        sells: mkLots(s.sells, s.dir !== "short" && Array.isArray(s.buys) ? s.buys.length : 0)
      };
    });
  }

  function load() {
    var raw = null;
    try { raw = localStorage.getItem(KEY); } catch (e) { return false; }
    try {
      if (raw) {
        var d = JSON.parse(raw);
        if (!d || !Array.isArray(d.stocks)) return false;
        state.recovery = Array.isArray(d.recovery) ? d.recovery.filter(function (x) {
          return x && typeof x.id === "string" && typeof x.label === "string" && x.data &&
            ["stocks", "hist", "watch", "lot", "replace"].indexOf(x.type) >= 0;
        }).slice(0, 10) : [];
        state.fees = normalizeFees(d.fees);
        state.settings = Object.assign({}, DEF_SETTINGS, d.settings || {});
        state.settings.alert = normalizeAlert(state.settings.alert);
        state.settings.kline = normalizeKlineAlert(state.settings.kline);
        /* 提醒闩锁也恢复：否则每次刷新页面都会因为"仍在线上"再弹一次 */
        var da = d.alertState && typeof d.alertState === "object" ? d.alertState : {};
        state.alertState = { p: !!da.p, l: !!da.l, pm: normLatchMap(da.pm),
          k: { low: normLatchMap(da.k && da.k.low), high: normLatchMap(da.k && da.k.high) } };
        state.lastBackupAt = d.lastBackupAt || "";
        state.stocks = normalizeStocks(d.stocks, true);
        state.hist = Array.isArray(d.hist) ? d.hist.map(normalizeHist) : [];
        /* 侧栏商品只缓存最近一次取到的价格（属于行情快照，不进备份 JSON） */
        var dc = d.comm && typeof d.comm === "object" ? d.comm : null;
        state.comm = {
          updatedAt: (dc && typeof dc.updatedAt === "string") ? dc.updatedAt : "",
          q: (dc && dc.q && typeof dc.q === "object") ? dc.q : {}
        };
        /* 观察池是用户数据（进备份 JSON）；K线缓存是行情快照（同商品，不进备份） */
        state.watch = normalizeWatch(d.watch);
        var dk = d.kline && typeof d.kline === "object" ? d.kline : null;
        state.kline = {
          updatedAt: (dk && typeof dk.updatedAt === "string") ? dk.updatedAt : "",
          d: (dk && dk.d && typeof dk.d === "object") ? dk.d : {}
        };
        return true;
      }
      // 无 v4 数据：逐级向前兼容迁移
      for (var i = 0; i < KEY_OLD.length; i++) {
        var old = localStorage.getItem(KEY_OLD[i]);
        if (!old) continue;
        var o = JSON.parse(old);
        state.fees = normalizeFees(o.fees);
        state.settings = Object.assign({}, DEF_SETTINGS);
        state.lastBackupAt = "";
        state.hist = Array.isArray(o.hist) ? o.hist.map(normalizeHist) : [];
        if (Array.isArray(o.stocks)) {                       // v3 结构
          state.stocks = normalizeStocks(o.stocks);
        } else if (Array.isArray(o.rows)) {                  // v2 单价格结构
          state.stocks = o.rows.map(function (r) {
            var buys = [], sells = [];
            if (r.buy || r.qty) buys.push({ id: uid("l"), price: r.buy || "", qty: r.qty || "" });
            if (r.sell) sells.push({ id: uid("l"), price: r.sell || "", qty: r.qty || "" });
            if (buys.length === 0) buys.push({ id: uid("l"), price: "", qty: "" });
            if (sells.length === 0) sells.push({ id: uid("l"), price: "", qty: "" });
            return { id: uid("s"), name: r.name || "", code: "", cur: r.cur || "", dir: "long", expanded: false, buys: buys, sells: sells };
          });
        } else continue;
        return true;
      }
      return false;
    } catch (e) { return false; }
  }

  /* ================= 导出 ================= */
  function download(name, text) {
    var blob = new Blob(["\uFEFF" + text], { type: "text/csv;charset=utf-8;" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }
  function feeParamsLines() {
    var f = state.fees;
    return ["",
      [esc("费率设置"), esc("买入佣金"), esc("卖出佣金"), esc("印花税(卖出)"), esc("过户费(双向)"), esc("最低佣金(元)")].join(","),
      ["", esc(f.commBuy + "%"), esc(f.commSell + "%"), esc(f.stamp + "%"), esc(f.transfer + "%"), esc(f.minComm)].join(","),
      [esc("成本结转方法"), esc("加权平均法（最低佣金按每一笔成交计提）")].join(",")];
  }

  /* ============================================================
     备份与恢复（JSON）
     localStorage 只能防"关掉网页"，防不住换浏览器 / 清缓存 / 换电脑，
     所以提供一个可复制的 JSON 备份，随时能完整还原。
     ============================================================ */
  function downloadRaw(name, text, mime) {
    /* 注意：JSON 不能加 BOM，所以这里不复用带 BOM 的 download() */
    var blob = new Blob([text], { type: (mime || "application/json") + ";charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function stampStr(d) {
    d = d || new Date();
    return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + "_" +
      pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
  }
  function prettyTime(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " +
      pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }
  function escHtml(s) {
    return String(s === undefined || s === null ? "" : s).replace(/[<>&]/g, "");
  }
  function paintBackupStatus(text, cls) {
    var el = $("#bstatus");
    if (text) { el.textContent = text; el.className = "bstatus" + (cls ? " " + cls : ""); return; }
    el.textContent = state.lastBackupAt ? ("上次备份 " + prettyTime(state.lastBackupAt)) : "尚未备份";
    el.className = "bstatus" + (state.lastBackupAt ? " ok" : "");
  }

  function buildBackup() {
    return {
      app: "股票收益计算器",
      schema: "stock-pl-calculator",
      version: 5,
      exportedAt: new Date().toISOString(),
      fees: state.fees,
      settings: state.settings,
      stocks: state.stocks,
      hist: state.hist,
      watch: state.watch
    };
  }

  $("#export-json").addEventListener("click", function () {
    var data = buildBackup();
    state.lastBackupAt = data.exportedAt;
    save();
    paintBackupStatus();
    downloadRaw("股票收益计算器_备份_" + stampStr() + ".json", JSON.stringify(data, null, 2));
  });

  /* 记录指纹：合并导入时用来判断"这笔是不是已经有了" */
  function hFingerprint(h) {
    return [h.date || "", String(h.name || "").trim(), h.dir === "short" ? "S" : "L",
      num(h.buy).toFixed(4), num(h.sell).toFixed(4), num(h.qty), num(h.net).toFixed(2),
      (h.tradeLog || []).map(function (r) { return [r.at, r.order, r.kind, r.price, r.qty].join(":"); }).join(";")].join("|");
  }

  /* 解析并校验备份对象；失败时抛出可读错误 */
  function parseBackup(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      throw new Error("内容不是一个 JSON 对象。");
    }
    var rawStocks = Array.isArray(obj.stocks) ? obj.stocks : null;
    var rawHist = Array.isArray(obj.hist) ? obj.hist : null;
    if (!rawStocks && !rawHist) {
      throw new Error("既没有 stocks（持仓）也没有 hist（已完成记录）字段，不像是本工具导出的备份。");
    }
    var hist = (rawHist || []).map(normalizeHist);
    var rawWatch = Array.isArray(obj.watch) ? normalizeWatch(obj.watch) : null;
    return {
      stocks: rawStocks ? normalizeStocks(rawStocks) : null,
      hist: hist,
      watch: rawWatch,
      fees: obj.fees ? normalizeFees(obj.fees) : null,
      settings: obj.settings ? Object.assign({}, DEF_SETTINGS, obj.settings) : null,
      meta: {
        app: obj.app || "",
        exportedAt: obj.exportedAt || "",
        version: obj.version || "",
        buyLots: rawStocks ? rawStocks.reduce(function (a, s) { return a + ((s.buys || []).length); }, 0) : 0,
        sellLots: rawStocks ? rawStocks.reduce(function (a, s) { return a + ((s.sells || []).length); }, 0) : 0,
        histNet: r2(hist.reduce(function (a, h) { return a + (num(h.net) || 0); }, 0)),
        histFee: r2(hist.reduce(function (a, h) { return a + (num(h.fees) || 0); }, 0))
      }
    };
  }

  var pendingImport = null;

  function setPreview(html, kind) {
    var el = $("#impPreview");
    el.innerHTML = html;
    el.className = "imppreview on" + (kind ? " " + kind : "");
  }

  function resetImportUI() {
    $("#impText").value = "";
    $("#impFile").value = "";
    pendingImport = null;
    $("#impMerge").disabled = true;
    $("#impReplace").disabled = true;
    var pv = $("#impPreview");
    pv.innerHTML = "";
    pv.className = "imppreview";
  }

  function doParse() {
    var txt = String($("#impText").value || "").trim();
    pendingImport = null;
    $("#impMerge").disabled = true;
    $("#impReplace").disabled = true;
    if (!txt) {
      setPreview("请先选择备份文件，或把 JSON 内容粘贴到上面的输入框。", "err");
      return;
    }
    var obj;
    try {
      obj = JSON.parse(txt);
    } catch (e) {
      setPreview("JSON 解析失败：" + escHtml(e.message) +
        "<br>请确认复制的是完整内容（从第一个 <code>{</code> 到最后一个 <code>}</code>）。", "err");
      return;
    }
    var inc;
    try {
      inc = parseBackup(obj);
    } catch (e2) {
      setPreview(escHtml(e2.message), "err");
      return;
    }
    pendingImport = inc;

    var seen = {};
    state.hist.forEach(function (h) { seen[hFingerprint(h)] = 1; });
    var dup = 0;
    inc.hist.forEach(function (h) { if (seen[hFingerprint(h)]) dup++; });

    var rows = [];
    rows.push('<div class="kv"><span>来源</span><span>' + (escHtml(inc.meta.app) || "未知") +
      (inc.meta.version ? "（v" + escHtml(String(inc.meta.version)) + "）" : "") + '</span></div>');
    if (inc.meta.exportedAt) {
      rows.push('<div class="kv"><span>导出时间</span><span>' + escHtml(prettyTime(inc.meta.exportedAt)) + '</span></div>');
    }
    rows.push('<div class="kv"><span>持仓</span><span>' + (inc.stocks
      ? (inc.stocks.length + " 支 · 买入批次 " + inc.meta.buyLots + " / 卖出批次 " + inc.meta.sellLots)
      : "不含持仓数据") + '</span></div>');
    rows.push('<div class="kv"><span>已完成记录</span><span>' + inc.hist.length + " 笔 · 累计 " +
      money(inc.meta.histNet, true) + " · 费用 " + yuan(inc.meta.histFee) + '</span></div>');
    rows.push('<div class="kv"><span>与现有记录重复</span><span>' + dup + ' 笔（合并时自动跳过）</span></div>');

    var tail = inc.stocks
      ? '<p style="margin:10px 0 0">解析成功，请选择下面的导入方式。</p>'
      : '<p style="margin:10px 0 0">这份备份不含持仓数据，只能用「仅合并已完成记录」导入。</p>';
    setPreview(rows.join("") + tail, "ok");
    $("#impMerge").disabled = inc.hist.length === 0;
    $("#impReplace").disabled = !inc.stocks;
  }

  function openImport() {
    resetImportUI();
    $("#impMask").classList.add("on");
    setTimeout(function () { $("#impText").focus(); }, 30);
  }
  function closeImport() { $("#impMask").classList.remove("on"); }

  function applyImport(mode) {
    if (!pendingImport) { setPreview("请先点「解析内容」。", "err"); return; }
    var inc = pendingImport;
    var added = 0, skipped = 0;

    if (mode === "merge") {
      var seen = {};
      state.hist.forEach(function (h) { seen[hFingerprint(h)] = 1; });
      inc.hist.forEach(function (h) {
        var k = hFingerprint(h);
        if (seen[k]) { skipped++; return; }
        seen[k] = 1;
        state.hist.push(h);
        added++;
      });
    } else {
      if (!inc.stocks) { setPreview("这份备份不含持仓数据，无法覆盖。请改用「仅合并已完成记录」。", "err"); return; }
      if (!confirm("确认用这份备份【覆盖】当前全部数据？\n\n" +
        "覆盖后：\n· 持仓 " + inc.stocks.length + " 支（当前 " + state.stocks.length + " 支）\n" +
        "· 已完成记录 " + inc.hist.length + " 笔（当前 " + state.hist.length + " 笔）\n" +
        "· 费率与设置也会被备份里的值替换\n\n" +
        "覆盖前会自动保存恢复点，可从「误删恢复」找回。仍建议导出 JSON 留作长期备份。")) return;
      if (!rememberRecovery("replace", "覆盖导入前的完整数据", userSnapshot())) return;
      state.stocks = inc.stocks;
      state.hist = inc.hist;
      if (inc.fees) state.fees = inc.fees;
      if (inc.settings) {
        state.settings = Object.assign({}, DEF_SETTINGS, inc.settings);
        state.settings.alert = normalizeAlert(state.settings.alert);
        state.settings.kline = normalizeKlineAlert(state.settings.kline);
      }
      /* 观察池随覆盖一起还原（旧备份没有这个字段就保持现状） */
      if (inc.watch) state.watch = inc.watch;
      added = inc.hist.length;
    }

    save();
    paintFees();
    paintSettings();
    paintKlineSettings();
    renderTable();
    renderHist();
    renderWatchPanel();
    closeImport();
    paintBackupStatus(mode === "merge"
      ? ("导入完成 · 新增 " + added + " 笔记录" + (skipped ? "，跳过 " + skipped + " 笔重复" : ""))
      : ("导入完成 · 持仓 " + state.stocks.length + " 支 / 记录 " + state.hist.length + " 笔"), "ok");
  }

  $("#import-json").addEventListener("click", openImport);
  $("#impClose").addEventListener("click", closeImport);
  $("#impMask").addEventListener("click", function (e) { if (e.target === this) closeImport(); });
  $("#impParse").addEventListener("click", doParse);
  $("#impMerge").addEventListener("click", function () { applyImport("merge"); });
  $("#impReplace").addEventListener("click", function () { applyImport("replace"); });
  $("#impFile").addEventListener("change", function () {
    var f = this.files && this.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () { $("#impText").value = String(reader.result || ""); doParse(); };
    reader.onerror = function () {
      setPreview("读取文件失败。可以改用另一种方式：用文本编辑器打开 .json，把内容复制粘贴到上面的输入框。", "err");
    };
    reader.readAsText(f, "utf-8");
  });

  $("#export").addEventListener("click", function () {
    var head = ["方向", "股票名称", "开仓笔数", "平仓笔数", "开仓股数", "平仓股数", "剩余股数",
                "加权买入均价", "加权卖出均价", "含费成本价/开仓均价", "当前价",
                "买入金额", "卖出金额", "买入费用", "卖出费用", "剩余持仓成本/开仓基准", "当前市值",
                "浮动盈亏", "已实现盈亏", "总盈亏", "总收益率(%)"];
    var lines = [head.join(",")];
    var sum = { open: 0, close: 0, cost: 0, mv: 0, f: 0, r: 0, t: 0, base: 0 };

    state.stocks.forEach(function (s) {
      var c = calcStock(s);
      sum.open += c.openQty; sum.close += c.closeQty;
      sum.cost += c.holdBase || 0;
      sum.mv += isFinite(c.marketValue) ? c.marketValue : 0;
      sum.f += isFinite(c.floatNet) ? c.floatNet : 0;
      sum.r += isFinite(c.realized) ? c.realized : 0;
      sum.t += c.hasTotal ? c.total : 0;
      sum.base += c.baseAmount;
      lines.push([
        esc(c.isShort ? "空头" : "多头"), esc(s.name),
        c.isShort ? c.sellLots : c.buyLots,
        c.isShort ? c.buyLots : c.sellLots,
        fmtQty(c.openQty), fmtQty(c.closeQty), fmtQty(c.remainQty),
        isFinite(c.avgBuyPrice) ? c.avgBuyPrice.toFixed(4) : "",
        isFinite(c.avgSellPrice) ? c.avgSellPrice.toFixed(4) : "",
        isFinite(c.unitCost) ? c.unitCost.toFixed(4) : "",
        esc(s.cur),
        c.buyAmount.toFixed(2), c.sellAmount.toFixed(2),
        c.buyFee.toFixed(2), c.sellFee.toFixed(2),
        isFinite(c.holdBase) ? c.holdBase.toFixed(2) : "",
        isFinite(c.marketValue) ? c.marketValue.toFixed(2) : "",
        isFinite(c.floatNet) ? c.floatNet.toFixed(2) : "",
        isFinite(c.realized) ? c.realized.toFixed(2) : "",
        c.hasTotal ? c.total.toFixed(2) : "",
        isFinite(c.totalRate) ? (c.totalRate * 100).toFixed(2) : ""
      ].join(","));
    });

    lines.push([esc("合计"), "", "", "", fmtQty(sum.open), fmtQty(sum.close), fmtQty(sum.open - sum.close),
      "", "", "", "", "", "", "", "", sum.cost.toFixed(2), sum.mv.toFixed(2),
      sum.f.toFixed(2), sum.r.toFixed(2), sum.t.toFixed(2),
      sum.base > 0 ? (sum.t / sum.base * 100).toFixed(2) : ""].join(","));

    /* 上面的「合计」行只统计持仓表。已存档的已完成交易不在本表内，
       这里把全账户口径写清楚，避免导出后与界面上的「总收益」对不上。 */
    var arch = state.hist.reduce(function (o, x) {
      o.n++; o.net += num(x.net) || 0; o.fee += num(x.fees) || 0; o.cost += num(x.cost) || 0; return o;
    }, { n: 0, net: 0, fee: 0, cost: 0 });
    if (arch.n > 0) {
      lines.push("");
      lines.push([esc("【全账户口径】"), esc("上表合计 = 仅持仓表；已存档交易见「导出记录 CSV」或下方备注")].join(","));
      lines.push([esc("已存档笔数"), esc(arch.n + " 笔"),
        esc("已存档已实现盈亏"), esc(r2(arch.net).toFixed(2)),
        esc("已存档交易费用"), esc(r2(arch.fee).toFixed(2))].join(","));
      lines.push([esc("全部总收益（与界面顶部「总收益」一致）"), esc(r2(sum.t + arch.net).toFixed(2))].join(","));
    }
    var all = aggregate(), complete = !all.noCur && !all.invalid;
    var netAll = r2(all.totalAll - all.forcedFees);
    lines.push([esc("【收益拆分】"), esc("含已存档；强制清盘统一补扣费用；缺价或超卖时毛/净收益留空")].join(","));
    lines.push([esc("毛收益"), complete ? r2(netAll + all.feeAll + all.estFee).toFixed(2) : "",
      esc("已发生费用"), all.feeAll.toFixed(2), esc("预估剩余平仓费"), all.estFee.toFixed(2),
      esc("扣费净收益"), complete ? netAll.toFixed(2) : ""].join(","));
    lines = lines.concat(feeParamsLines());
    download("股票持仓收益_" + todayStr() + ".csv", lines.join("\r\n"));
  });

  /* 月度收益开关：展开时才算、才渲染 */
  $("#month-toggle").addEventListener("click", function () {
    var box = $("#monthBox");
    box.hidden = !box.hidden;
    this.classList.toggle("on", !box.hidden);
    if (!box.hidden) renderMonthly();
  });

  $("#export-hist").addEventListener("click", function () {
    if (state.hist.length === 0) { alert("还没有已完成的交易记录可导出。"); return; }
    var head = ["成交日期", "方向", "股票名称", "开仓笔数", "平仓笔数", "买入均价", "卖出均价", "股数",
                "买入金额", "卖出金额", "买入费用", "卖出费用", "费用合计", "结转/释放成本", "已实现盈亏(记账口径)", "收益率(记账口径%)", "备注", "毛收益", "扣费净收益"];
    var lines = [head.join(",")];
    var s = { bf: 0, sf: 0, cost: 0, net: 0, gross: 0, afterFees: 0 };

    sortedHist().forEach(function (h) {
      var split = histProfit(h);
      s.gross += split.gross; s.afterFees += split.net;
      s.bf += h.buyFee; s.sf += h.sellFee; s.cost += h.cost; s.net += h.net;
      lines.push([esc(h.date), esc(h.dir === "short" ? "空头" : "多头"), esc(h.name),
        h.dir === "short" ? h.sellLots : h.buyLots, h.dir === "short" ? h.buyLots : h.sellLots,
        num(h.buy).toFixed(4), num(h.sell).toFixed(4), fmtQty(num(h.qty)),
        num(h.buyAmount).toFixed(2), num(h.sellAmount).toFixed(2),
        h.buyFee.toFixed(2), h.sellFee.toFixed(2), h.fees.toFixed(2),
        h.cost.toFixed(2), h.net.toFixed(2),
        isFinite(h.rate) ? (h.rate * 100).toFixed(2) : "",
        esc(h.forced ? "强制清盘（原记账盈亏不扣费，扣费净收益已扣费）" : ""),
        split.gross.toFixed(2), split.net.toFixed(2)].join(","));
    });

    lines.push([esc("合计 " + state.hist.length + " 笔"), "", "", "", "", "", "", "",
      "", "", s.bf.toFixed(2), s.sf.toFixed(2), (s.bf + s.sf).toFixed(2), s.cost.toFixed(2),
      s.net.toFixed(2), s.cost > 0 ? (s.net / s.cost * 100).toFixed(2) : "", "",
      r2(s.gross).toFixed(2), r2(s.afterFees).toFixed(2)].join(","));
    lines = lines.concat(feeParamsLines());
    lines.push([esc("说明"), esc("盈亏按存档当时的费率锁定，后续改费率不改变历史记录")].join(","));
    if (state.hist.some(function (h) { return h.forced; })) {
      lines.push([esc("说明"), esc("标「强制清盘」的记录是按实际成交价与数量一次性结清的，" +
        "已实现盈亏 = 各段价差 × 数量（强平前已了结的那部分按记录里的成交均价、其余按清盘价），" +
        "不扣交易费用，也不按 清盘数量 × 加权成本；同口径下做 T 用同样的钱买回更多股时不会失真")].join(","));
    }
    download("已完成交易记录_" + todayStr() + ".csv", lines.join("\r\n"));
  });

  /* ================= 其他按钮 ================= */
  $("#add-long").addEventListener("click", function () { addStock({ focus: true, dir: "long" }); });
  $("#add-short").addEventListener("click", function () { addStock({ focus: true, dir: "short" }); });

  $("#expand-all").addEventListener("click", function () {
    var anyClosed = state.stocks.some(function (s) { return !s.expanded; });
    state.stocks.forEach(function (s) { s.expanded = anyClosed; });
    save();
    renderTable();
    this.textContent = anyClosed ? "全部收起" : "全部展开";
  });

  $("#reset").addEventListener("click", function () {
    if (state.stocks.length === 0) { alert("持仓表已经是空的。"); return; }
    if (!confirm("确定要清空持仓表吗？（已完成交易记录不受影响）\n\n清空后可在「误删恢复」中找回。")) return;
    if (!rememberRemoval("stocks", state.stocks, "清空持仓")) return;
    state.stocks = [];
    save();
    renderTable();
  });

  /* 手工改完输入框（当前价、批次价格/股数）再检查提醒。
     用 change（失焦/回车触发）而不是 input，避免边打字边弹窗。 */
  tbody.addEventListener("change", function (e) {
    var el = e.target;
    if (!el || !el.classList || !el.classList.contains("f")) return;
    checkAlerts();
    checkPlanAlerts();       // 改了止损价 / 目标价 / 当前价，可能当场就越线
  });

  $("#clear-hist").addEventListener("click", function () {
    if (state.hist.length === 0) { alert("还没有任何已完成记录。"); return; }
    var total = 0;
    state.hist.forEach(function (h) { total += h.net; });
    if (!confirm("确定要删除全部 " + state.hist.length + " 条已完成记录吗？\n\n当前累计已实现收益 " +
      money(total, true) + "\n\n清空后可在「误删恢复」中找回。")) return;
    if (!rememberRemoval("hist", state.hist, "清空交易记录")) return;
    state.hist = [];
    save();
    renderHist();
  });

  /* ================= 启动 ================= */
  function boot() {
    if (!load()) {
      state.fees = Object.assign({}, DEF_FEES);
      state.settings = Object.assign({}, DEF_SETTINGS);
      state.stocks = [
        { id: uid("s"), name: "示例 · 贵州茅台（做多）", code: "600519", cur: "1270.00",
          dir: "long", expanded: false,
          buys: [ { id: uid("l"), price: "1200.00", qty: "100" },
                  { id: uid("l"), price: "1230.00", qty: "100" } ],
          sells: [ { id: uid("l"), price: "1290.00", qty: "50" } ] },
        { id: uid("s"), name: "示例 · 融券卖空（做空）", code: "000001", cur: "11.86",
          dir: "short", expanded: true,
          buys: [ { id: uid("l"), price: "11.80", qty: "400" } ],
          sells: [ { id: uid("l"), price: "12.50", qty: "1000" } ] }
      ];
      state.hist = [];
    }
    paintFees();
    paintAlertSettings();
    paintKlineSettings();
    renderRecovery();
    renderTable();
    renderHist();
    renderCommodities();
    renderWatchPanel();

    /* 实时行情控件 */
    paintSettings();
    paintBackupStatus();
    $("#refresh").addEventListener("click", function () { refreshQuotes(true); });
    $("#commRefresh").addEventListener("click", function () { refreshCommodities(); });
    $("#watch-add").addEventListener("click", addWatch);
    $("#watch-code").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); addWatch(); }
    });
    $("#watch-refresh").addEventListener("click", function () { refreshWatchKlines(true); });
    $("#watchBody").addEventListener("click", function (e) {
      var del = e.target.closest(".wdel");
      if (del) {
        var tr = del.closest("tr");
        var id = tr ? tr.getAttribute("data-id") : "";
        var isClosed = del.getAttribute("data-tag") === "已平仓";
        if (id && confirm(isClosed
          ? "把这支已平仓股票从看板移除？\n\n只是不再盯着它的高低位，已完成交易记录与盈亏统计都不受影响。"
          : "从观察池移除这支股票？（不影响持仓表和任何记录）")) removeWatch(id);
        return;
      }
      /* 板块标签：点击弹出修改框（持仓 / 观察都可以打） */
      var sec = e.target.closest(".wsec");
      if (sec) {
        var id2 = sec.getAttribute("data-id"), tag = sec.getAttribute("data-tag");
        var cur = "";
        (tag === "持仓" ? state.stocks : state.watch).some(function (x) {
          if (x.id === id2) { cur = x.sec || ""; return true; }
          return false;
        });
        var v = prompt("板块标签（如：PCB、光模块；留空清除）：", cur);
        if (v !== null) setSec(tag, id2, v);
      }
    });
    /* 分位提醒设置：用 change（失焦/回车）而不是 input，避免输数过程中就弹窗 */
    $("#kalert-on").addEventListener("change", function () {
      state.settings.kline.on = !!this.checked;
      save();
      if (state.settings.kline.on) checkKlineAlerts();
    });
    $("#kalert-low").addEventListener("change", function () {
      var v = num(this.value);
      state.settings.kline.low = isFinite(v) ? Math.min(100, Math.max(0, v)) : 25;
      this.value = state.settings.kline.low;
      save();
    });
    $("#kalert-high").addEventListener("change", function () {
      var v = num(this.value);
      state.settings.kline.high = isFinite(v) ? Math.min(100, Math.max(0, v)) : 75;
      this.value = state.settings.kline.high;
      save();
    });
    /* 打开页面时：K线缓存是空的就拉一次（有缓存就先用，等手动刷新再更新）；
       缓存还新鲜就不重拉，但分位提醒要先用缓存查一遍（闩锁保证不会重复弹） */
    (function () {
      var need = false;
      watchList().forEach(function (it) {
        if (klineSupported(it.code) && klineAged(state.kline.d[it.code])) need = true;
      });
      if (need) refreshWatchKlines(false);
      else checkKlineAlerts();
    })();
    $("#autoq").addEventListener("change", function () {
      state.settings.auto = !!this.checked;
      save();
      applyAutoRefresh();
      if (state.settings.auto) refreshQuotes(false);
    });
    $("#qinterval").addEventListener("change", function () {
      state.settings.interval = num(this.value) || 30;
      save();
      applyAutoRefresh();
    });
    applyAutoRefresh();
    if (state.settings.auto) refreshQuotes(false);

    /* 页面从后台切回时，若开了自动刷新就立即补一次 */
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && state.settings.auto) refreshQuotes(false);
    });

    /* 启动时按已有数据先检查一次提醒；若开了自动刷新则等取到新价后再查，
       避免拿上一次的旧价格弹窗（闩锁会保证不会重复弹） */
    if (!state.settings.auto) { checkAlerts(); checkPlanAlerts(); }
  }

  boot();
})();
