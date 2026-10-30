#!/usr/bin/env node
/*
 * 端到端测试：用 jsdom 加载**构建产物 index.html**，驱动真实 DOM 跑完整交互链路。
 *
 * 为什么测产物而不是测 src/：产物才是用户双击打开的东西。
 * 期望值一律由本文件下方的独立四则运算算出（不复用页面函数），再逐位比对 ——
 * 复写一遍逻辑等于自己证明自己，而"凭感觉填期望值"必然出错。
 *
 * 运行：npm test   （需要 jsdom：npm install）
 *       node test/app.test.mjs          测正式版产物 index.html（默认）
 *       node test/app.test.mjs --beta   测测试版产物 ../股票收益计算器-测试版.html
 *
 * 为什么两套产物共用这一份断言：测试版只是换了存储键的产物，功能必须完全一致，
 * 同一份用例两边都跑过，才能保证「新功能没破坏老功能」这件事对最终交付的那版也成立。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BETA = process.argv.includes('--beta');
const FILE = BETA ? path.join(ROOT, '..', '股票收益计算器-测试版.html') : path.join(ROOT, 'index.html');
const KEY = BETA ? 'stock-pl-beta-v1' : 'stock-pl-calculator-v4';
if (!fs.existsSync(FILE)) {
  console.error((BETA ? '测试版产物不存在，请先执行：node scripts/build.mjs --beta'
    : 'index.html 不存在，请先执行：node scripts/build.mjs'));
  process.exit(1);
}
const html = fs.readFileSync(FILE, 'utf8');

let pass = 0, fail = 0;
const rr = (x) => Math.round(x * 100) / 100;
function check(name, actual, expected) {
  const a = typeof actual === 'number' ? rr(actual) : actual;
  const e = typeof expected === 'number' ? rr(expected) : expected;
  const ok = a === e;
  ok ? pass++ : fail++;
  if (!ok) console.log('  ✗ ' + name + '  实际=' + a + '  期望=' + e);
  return ok;
}
function ok(name, cond, extra) {
  cond ? pass++ : fail++;
  if (!cond) console.log('  ✗ ' + name + (extra !== undefined ? '  ' + extra : ''));
  return cond;
}
function section(t) { console.log('\n' + t); }

/* ================= 独立手算（只用四则运算） ================= */
const F = { commBuy: 0.01, commSell: 0.01, stamp: 0.05, transfer: 0, minComm: 0 };
function fee(amount, isBuy) {
  const comm = rr(amount * (isBuy ? F.commBuy : F.commSell) / 100);
  const stamp = isBuy ? 0 : rr(amount * F.stamp / 100);
  return rr(comm + stamp + rr(amount * F.transfer / 100));
}
const avg = (lots) => lots.reduce((s, [p, q]) => s + p * q, 0) /
                      lots.reduce((s, [, q]) => s + q, 0);
const sumQ = (lots) => lots.reduce((s, [, q]) => s + q, 0);
/* 强制清盘：分两段（已了结部分按记录均价、其余按清盘价），两段数量之和 = 建仓数量 */
function expectForceNet(dir, openLots, closeLots, forcePrice, forceQty) {
  const openAvg = avg(openLots), openQty = sumQ(openLots), closedQty = sumQ(closeLots);
  let net = 0;
  if (closedQty > 0) {
    net += (dir === 'short' ? openAvg - avg(closeLots) : avg(closeLots) - openAvg) * closedQty;
  }
  const q = openQty - closedQty > 0 ? openQty - closedQty : forceQty;
  net += (dir === 'short' ? openAvg - forcePrice : forcePrice - openAvg) * q;
  return rr(net);
}

/* ================= 驱动 ================= */
function loadPage(seed, opt) {
  opt = opt || {};
  return new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'http://localhost/',
    pretendToBeVisual: true,
    beforeParse(window) {
      /* jsdom 不提供浏览器的编码 API，行情解析需要真实的 GBK 解码器。 */
      window.TextDecoder = TextDecoder;
      window.__alerts = [];
      window.__confirms = [];
      window.__errs = [];
      window.__fetches = [];
      window.confirm = (m) => { window.__confirms.push(String(m)); return true; };
      window.alert = (m) => { window.__alerts.push(String(m)); };
      window.Element.prototype.scrollIntoView = function () {};
      window.addEventListener('error', (e) => window.__errs.push(String(e.message)));
      /* 行情桩：用来断言「填 920002 实际请求的是不是 bj920002」这类归一化行为。
         桩返回的文本会被页面按 GBK 解码，所以内容只用 ASCII。 */
      if (opt.fetch) {
        window.fetch = (url) => {
          window.__fetches.push(String(url));
          const body = opt.fetch(String(url));
          if (body === null || body === undefined) return Promise.reject(new Error('stub-miss'));
          return Promise.resolve({
            ok: true, status: 200,
            arrayBuffer: () => Promise.resolve(new TextEncoder().encode(body).buffer)
          });
        };
      }
      if (seed) window.localStorage.setItem(KEY, seed);
      if (opt.storageFailure) window.Storage.prototype.setItem = function () { throw new window.DOMException('Quota exceeded', 'QuotaExceededError'); };
      if (opt.downloadCapture) {
        window.__downloads = [];
        window.URL.createObjectURL = blob => { window.__downloads.push(blob); return 'blob:test'; };
        window.URL.revokeObjectURL = function () {};
        window.HTMLAnchorElement.prototype.click = function () {};
      }
    }
  });
}
const money2num = (s) => {
  const m = String(s).replace(/[^0-9.\-+]/g, '');
  return m === '' || m === '-' || m === '+' ? NaN : parseFloat(m);
};
const mk = (dir, buyLots, sellLots, name) => ({
  id: 's1', name: name || '测试股票', code: '', cur: '', dir, expanded: false,
  buys: buyLots.map((b, i) => ({ id: 'b' + i, price: String(b[0]), qty: String(b[1]) })),
  sells: sellLots.map((b, i) => ({ id: 'l' + i, price: String(b[0]), qty: String(b[1]) }))
});
/* 统一构造：多头「建仓买入 / 已卖出」，空头「开仓卖出 / 已买回」 */
const build = (dir, open, closed) => dir === 'short'
  ? mk('short', closed, open) : mk('long', open, closed);

/* 驱动一次「强制清盘」全流程，返回页面各处读数 */
function runForce(stock, closePrice, closeQty, cb) {
  const seed = JSON.stringify({
    fees: Object.assign({}, F), settings: { auto: false, interval: 30 },
    stocks: [stock], hist: [], lastBackupAt: ''
  });
  const dom = loadPage(seed);
  const w = dom.window, d = w.document;
  const out = {};
  setTimeout(() => {
    try {
      d.querySelector('tr.stock-row').querySelector('.ico.done').click();
      out.defaultMode = (d.querySelector('input[name="arcmode"]:checked') || {}).value;
      const radio = d.querySelector('input[name="arcmode"][value="force"]');
      radio.checked = true;
      radio.dispatchEvent(new w.Event('change', { bubbles: true }));
      out.mode = (d.querySelector('input[name="arcmode"]:checked') || {}).value;
      out.okDisabledEmpty = d.querySelector('#arcOk').disabled;
      const p = d.querySelector('#arcForcePrice'), q = d.querySelector('#arcForceQty');
      p.value = String(closePrice);
      p.dispatchEvent(new w.Event('input', { bubbles: true }));
      q.value = String(closeQty);
      q.dispatchEvent(new w.Event('input', { bubbles: true }));
      out.okDisabledFilled = d.querySelector('#arcOk').disabled;
      out.preview = d.querySelector('#arcPreview').textContent.replace(/\s+/g, ' ').trim();
      out.labels = Array.from(d.querySelectorAll('#arcPreview .kv span:first-child'),
        (x) => x.textContent.trim());
      out.hint = d.querySelector('#arcForceHint').textContent.replace(/\s+/g, ' ').trim();
      d.querySelector('#arcOk').click();
      setTimeout(() => {
        out.confirmText = w.__confirms.join(' || ');
        out.stockRows = d.querySelectorAll('tr.stock-row').length;
        out.histRows = d.querySelectorAll('#hbody tr').length;
        out.histText = (d.querySelector('#hbody tr') || { textContent: '' })
          .textContent.replace(/\s+/g, ' ').trim();
        out.histNet = money2num((d.querySelector('#h-net') || {}).textContent);
        out.cardTotal = money2num(d.querySelector('#k-total').textContent);
        out.cardReal = money2num(d.querySelector('#k-real').textContent);
        out.cardFee = money2num(d.querySelector('#k-fee').textContent);
        out.stored = JSON.parse(w.localStorage.getItem(KEY)).hist[0] || null;
        out.errs = w.__errs.slice();
        cb(out);
      }, 300);
    } catch (e) {
      console.log('  ✗ 抛出异常：' + e.message);
      fail++;
      cb({});
    }
  }, 250);
}

/* ================= 1. 产物自检 ================= */
section('1. 构建产物自检');
ok('index.html 存在且非空', html.length > 100000, html.length + ' 字符');
ok('声明 UTF-8', /<meta charset="UTF-8">/i.test(html));
ok('无外链 <link>', !/<link\b/i.test(html));
ok('无外链脚本 / 远程资源', !/(src|href)\s*=\s*["']https?:/i.test(html));
ok('恰好 1 个 <style> 与 1 个 <script>',
  (html.match(/<style>/g) || []).length === 1 && (html.match(/<script>/g) || []).length === 1);
ok('带构建戳注释', /<!-- build: .+? -->/.test(html));
ok('构建戳未被占位符残留', !/\{\{(STYLES|APP_JS|BUILD_STAMP)\}\}/.test(html));
/* 页面脚本里有 ".replace(/(\d\d)(\d\d)/, "$1:$2")"：
   构建若用字符串形式的 replace，$1/$2 会被吃掉 —— 这条专门守它 */
ok('$1/$2 替换模式原样保留（防构建期被吃掉）', html.includes('"$1:$2"'));

/* ================= 2. 强制清盘 · 分两段口径 ================= */
const cases = [
  /* 无「已了结部分」时，两段法必须退化成上一版式子 —— 期望值与上一版完全相同 */
  { name: '空头 · 亏损 · 无已了结 · 清盘 1,900 @158.00',
    dir: 'short', open: [[152.70, 2000]], closed: [], price: 158.00, qty: 1900,
    feeExp: rr(fee(305400, false) + fee(300200, true)) },
  { name: '空头 · 赚钱 · 无已了结 · 清盘 2,100 @145.00',
    dir: 'short', open: [[152.70, 2000]], closed: [], price: 145.00, qty: 2100,
    feeExp: rr(fee(305400, false) + fee(304500, true)) },
  { name: '多头 · 亏损 · 无已了结 · 清盘 1,000 @9.50',
    dir: 'long', open: [[10.00, 1000]], closed: [], price: 9.50, qty: 1000,
    feeExp: rr(fee(10000, true) + fee(9500, false)) },
  { name: '多头 · 两笔建仓（均价 10.50）· 清盘 2,000 @10.80',
    dir: 'long', open: [[10.00, 1000], [11.00, 1000]], closed: [], price: 10.80, qty: 2000,
    feeExp: rr(fee(21000, true) + fee(21600, false)) },
  /* 有「已了结部分」：它的真实盈亏必须计入（曾漏算，2026-09-17 修） */
  { name: '空头 · 已买回 500 @140.00（比清盘价好）→ 清盘 1,500 @145.00',
    dir: 'short', open: [[152.70, 2000]], closed: [[140.00, 500]], price: 145.00, qty: 1500,
    feeExp: rr(fee(305400, false) + fee(70000, true) + fee(217500, true)) },
  { name: '空头 · 已买回 500 @160.00（比清盘价差）→ 清盘 1,500 @145.00',
    dir: 'short', open: [[152.70, 2000]], closed: [[160.00, 500]], price: 145.00, qty: 1500,
    feeExp: rr(fee(305400, false) + fee(80000, true) + fee(217500, true)) },
  { name: '多头 · 已卖出 800 @10.80 → 清盘 1,200 @10.20',
    dir: 'long', open: [[10.00, 2000]], closed: [[10.80, 800]], price: 10.20, qty: 1200,
    feeExp: rr(fee(20000, true) + fee(8640, false) + fee(12240, false)) },
  { name: '空头 · 已买回两笔（150.00 + 148.00）→ 清盘 1,000 @145.00',
    dir: 'short', open: [[152.70, 2000]], closed: [[150.00, 500], [148.00, 500]],
    price: 145.00, qty: 1000,
    feeExp: rr(fee(305400, false) + fee(75000, true) + fee(74000, true) + fee(145000, true)) }
];

let idx = 0;
function nextCase() {
  if (idx >= cases.length) return regressStep();
  const c = cases[idx++];
  const exp = expectForceNet(c.dir, c.open, c.closed, c.price, c.qty);
  section('2.' + idx + ' 强制清盘 · ' + c.name + '  → 期望 ' + exp);
  runForce(build(c.dir, c.open, c.closed), c.price, c.qty, (o) => {
    check('记录面板「已实现盈亏」', o.histNet, exp);
    check('localStorage 里的 net', o.stored && o.stored.net, exp);
    check('顶部「已实现盈亏」', o.cardReal, exp);
    check('顶部「总收益」= 本次盈亏', o.cardTotal, exp);
    if (c.feeExp !== undefined) check('顶部「累计交易费用」', o.cardFee, c.feeExp);
    ok('持仓表已清空', o.stockRows === 0, '行数=' + o.stockRows);
    ok('生成 1 条已完成记录', o.histRows === 1, '行数=' + o.histRows);
    ok('带「强制清盘」标记', /强制清盘/.test(o.histText));
    ok('默认进「逐笔清盘」、可切「强制清盘」',
      o.defaultMode === 'step' && o.mode === 'force');
    ok('空输入时确认按钮禁用 / 填好后可用',
      o.okDisabledEmpty === true && o.okDisabledFilled === false);
    ok('预览标注「价差 × 数量，合计」口径',
      /已实现盈亏（价差 × 数量，合计）/.test(o.preview));
    ok('预览写明不扣费用', /不扣费用/.test(o.preview));
    ok('预览给出金额差对照', /对照/.test(o.preview));
    ok('二次确认写明「合计」与「分两段」',
      /已实现盈亏（合计）/.test(o.confirmText) && /分两段结算/.test(o.confirmText));
    const hasClosed = sumQ(c.closed) > 0;
    const hasPartRow = o.labels.some((t) => /已了结部分（记录）/.test(t));
    ok(hasClosed ? '列出「已了结部分」行' : '无已了结时不出该行',
      hasClosed ? hasPartRow : !hasPartRow, o.labels.join(' / '));
    /* 记录内部自洽：均价 × 股数 = 金额（专抓"少算了一条腿"） */
    if (o.stored) {
      check('记录：买入均价 × 买入数量 = 买入金额',
        rr(parseFloat(o.stored.buy) * o.stored.buyQty), rr(o.stored.buyAmount));
      check('记录：卖出均价 × 卖出数量 = 卖出金额',
        rr(parseFloat(o.stored.sell) * o.stored.sellQty), rr(o.stored.sellAmount));
      check('记录：股数 = 已了结 + 本次清盘', parseFloat(o.stored.qty), sumQ(c.closed) + c.qty);
      check('记录：费用合计', o.stored.fees, c.feeExp);
    }
    ok('无 JS 运行时错误', o.errs.length === 0, o.errs.join('|'));
    nextCase();
  });
}

/* ================= 3. 逐笔清盘回归 ================= */
function regressStep() {
  section('3. 逐笔清盘回归（原有路径不能被改坏）');
  const seed = JSON.stringify({
    fees: Object.assign({}, F), settings: { auto: false, interval: 30 },
    stocks: [mk('long', [[10.00, 1000]], [])], hist: [], lastBackupAt: ''
  });
  const dom = loadPage(seed);
  const w = dom.window, d = w.document;
  setTimeout(() => {
    d.querySelector('tr.stock-row').querySelector('.ico.done').click();
    setTimeout(() => {
      const p = d.querySelector('#arcLiqBody input[data-k="price"]');
      const q = d.querySelector('#arcLiqBody input[data-k="qty"]');
      p.value = '10.50'; p.dispatchEvent(new w.Event('input', { bubbles: true }));
      q.value = '1000'; q.dispatchEvent(new w.Event('input', { bubbles: true }));
      setTimeout(() => {
        const exp = rr(10500 - fee(10500, false) - rr(10000 + fee(10000, true)));
        d.querySelector('#arcOk').click();
        setTimeout(() => {
          check('已实现盈亏 = ' + exp, money2num(d.querySelector('#h-net').textContent), exp);
          ok('不带「强制清盘」标记', !/强制清盘/.test(d.querySelector('#hbody tr').textContent));
          ok('顶部总收益同步', money2num(d.querySelector('#k-total').textContent) === exp);
          ok('无 JS 运行时错误', (w.__errs || []).length === 0, (w.__errs || []).join('|'));
          posStep();
        }, 300);
      }, 200);
    }, 250);
  }, 250);
}

/* ================= 7. 平仓存档后仍留在看板 ================= */
function boardStep() {
  section('7. 平仓存档后仍留在高低位看板（标记「已平仓」）');
  /* 已全部平掉的多头：买入 1000 @10、卖出 1000 @11 —— 不需要再录清盘明细，直接确认存档 */
  const st = Object.assign(mk('long', [[10.00, 1000]], [[11.00, 1000]]),
    { code: '600519', name: '示例甲', sec: '白酒' });
  const seed = JSON.stringify({
    fees: Object.assign({}, F), settings: { auto: false, interval: 30 },
    stocks: [st], hist: [], lastBackupAt: ''
  });
  const dom = loadPage(seed);
  const w = dom.window, d = w.document;
  /* 打了板块标签会先渲染一行组头（tr.wgroup），这里只数真正的股票行 */
  const stockRows = (doc) => Array.from(doc.querySelectorAll('#watchBody tr'))
    .filter((r) => !r.classList.contains('wgroup') && !r.classList.contains('empty-row'));
  setTimeout(() => {
    const before = stockRows(d);
    check('7.1 存档前看板 1 行', before.length, 1);
    check('7.2 存档前标签是「持仓」', before[0].querySelector('.wtag').textContent.trim(), '持仓');
    d.querySelector('tr.stock-row .ico.done').click();
    setTimeout(() => {
      d.querySelector('#arcOk').click();
      setTimeout(() => {
        const after = stockRows(d);
        check('7.3 存档后看板仍有该股票', after.length, 1);
        check('7.4 标签变为「已平仓」', after[0].querySelector('.wtag').textContent.trim(), '已平仓');
        ok('7.4b 板块分组仍在（组头保留）', !!d.querySelector('#watchBody tr.wgroup'),
          d.querySelector('#watchBody').textContent.slice(0, 40));
        const saved = JSON.parse(w.localStorage.getItem(KEY));
        ok('7.5 观察池里带 closed 标记、板块标签跟着转过来',
          saved.watch.length === 1 && saved.watch[0].closed === true &&
          saved.watch[0].code === '600519' && saved.watch[0].sec === '白酒',
          JSON.stringify(saved.watch));
        check('7.6 持仓表已清空', d.querySelectorAll('tr.stock-row').length, 0);
        /* 重新打开（用刚存下的数据当种子）确认它能持久 */
        const dom2 = loadPage(w.localStorage.getItem(KEY));
        const w2 = dom2.window, d2 = dom2.window.document;
        setTimeout(() => {
          const t2 = stockRows(d2)[0];
          ok('7.7 重开后仍是「已平仓」', !!t2 && t2.querySelector('.wtag').textContent.trim() === '已平仓',
            t2 && t2.querySelector('.wtag').textContent);
          /* 不想再盯时，✕ 能把「已平仓」那一行摘掉 */
          t2.querySelector('.wdel').click();
          setTimeout(() => {
            check('7.8 移除后没有股票行', stockRows(d2).length, 0);
            check('7.9 移除后 watch 为空', JSON.parse(w2.localStorage.getItem(KEY)).watch.length, 0);
            check('7.10 已完成记录不受影响',
              JSON.parse(w2.localStorage.getItem(KEY)).hist.length, 1);
            ok('7.11 无 JS 运行时错误',
              (w.__errs || []).length === 0 && (w2.__errs || []).length === 0,
              (w.__errs || []).concat(w2.__errs || []).join('|'));
            bjStep();
          }, 300);
        }, 300);
      }, 400);
    }, 300);
  }, 300);
}

/* ================= 8. 北交所代码识别与 K 线支持判定 ================= */
/* 腾讯行情的桩：字段 [1]名称 [3]现价 [4]昨收 [30]时间 [32]涨跌幅 */
function txLine(code, price, pct) {
  const f = ['62', 'TESTNAME', code.replace(/^[a-z]+/, ''), String(price), String(price)];
  while (f.length < 30) f.push('0');
  f.push('20261012150000', '0', String(pct));
  return 'v_' + code + '="' + f.join('~') + '";';
}

function bjStep() {
  section('8. 北交所代码识别（920 新段 / 43·83 存量段）与 K 线支持判定');
  /* 持仓里放一只 920 段的北交所股票：填的是 6 位 920002 */
  const st = Object.assign(mk('long', [[48.00, 1000]], []), { code: '920002', name: '', cur: '' });
  const seed = JSON.stringify({
    fees: Object.assign({}, F), settings: { auto: false, interval: 30 },
    stocks: [st], hist: [], lastBackupAt: ''
  });
  const dom = loadPage(seed, {
    /* 任何 qt.gtimg.cn 请求都按请求到的代码回一条行情 —— 于是「请求了哪个代码」本身就是证据 */
    fetch: (url) => {
      const m = url.match(/qt\.gtimg\.cn\/q=([^&]+)/);
      if (!m) return null;
      if (/hf_/.test(m[1])) return null;                 // 商品请求不回应，省得干扰
      return m[1].split(',').map((c) => txLine(c, 48.94, -2.12)).join('');
    }
  });
  const w = dom.window, d = w.document;
  setTimeout(() => {
    d.querySelector('#refresh').click();
    setTimeout(() => {
      const urls = (w.__fetches || []).join(' | ');
      ok('8.1 填 920002 时实际请求的是 bj920002（不是 sh920002）',
        /q=bj920002|,bj920002|bj920002/.test(urls) && !/sh920002/.test(urls), urls.slice(0, 120));
      const curIn = d.querySelector('tr.stock-row .curtd .cur');
      check('8.2 北交所实时价已写入当前价', Number(curIn.value), 48.94);
      const rowTxt = d.querySelector('tr.stock-row').textContent.replace(/\s+/g, ' ');
      const nameVal = d.querySelector('tr.stock-row .nametd input.name').value;
      ok('8.3 名称由接口补全（写进名称输入框）', nameVal === 'TESTNAME', nameVal + ' | ' + rowTxt.slice(0, 40));

      /* —— K 线支持判定（不依赖网络，直接看看板文案）—— */
      const add = (code) => {
        const el = d.querySelector('#watch-code');
        el.value = code;
        d.querySelector('#watch-add').click();
      };
      add('920002');   // 与持仓同代码，会被去重拦下
      add('430047');
      add('833171');
      add('600519');
      add('hk00700');
      setTimeout(() => {
        const rowOf = (code) => Array.from(d.querySelectorAll('#watchBody tr'))
          .find((r) => r.getAttribute('data-code') === code);
        const r920 = rowOf('bj920002');
        ok('8.4 持仓里的 920002 在看板上按 bj920002 显示', !!r920,
          (d.querySelector('#watchBody').textContent || '').slice(0, 60));
        ok('8.5 920 段判为支持K线（显示待刷新，不是「暂无历史K线源」）',
          !!r920 && /待刷新/.test(r920.textContent) && !/暂无历史K线源/.test(r920.textContent),
          r920 && r920.textContent.replace(/\s+/g, ' ').slice(-46));
        const r43 = rowOf('bj430047');
        ok('8.6 43 段存量代码提示「北交所老代码段暂无历史K线源」',
          !!r43 && /北交所老代码段暂无历史K线源/.test(r43.textContent),
          r43 && r43.textContent.replace(/\s+/g, ' ').slice(-52));
        const r83 = rowOf('bj833171');
        ok('8.7 83 段同样提示', !!r83 && /北交所老代码段暂无历史K线源/.test(r83.textContent));
        const rSh = rowOf('sh600519');
        ok('8.8 沪深仍判为支持', !!rSh && /待刷新/.test(rSh.textContent) && !/不支持/.test(rSh.textContent));
        const rHk = rowOf('hk00700');
        ok('8.9 港股提示「港股不支持历史K线」', !!rHk && /港股不支持历史K线/.test(rHk.textContent),
          rHk && rHk.textContent.replace(/\s+/g, ' ').slice(-40));
        /* 看板行 = 持仓那支(920002) + 后加的 4 支；再填一次同代码会被去重拦住 */
        const stockRows = Array.from(d.querySelectorAll('#watchBody tr'))
          .filter((r) => !r.classList.contains('wgroup') && !r.classList.contains('empty-row'));
        check('8.10 看板共 5 行（同为 920002 的重复添加被去重）', stockRows.length, 5);
        ok('8.11 无 JS 运行时错误', (w.__errs || []).length === 0, (w.__errs || []).join('|'));
        done();
      }, 300);
    }, 400);
  }, 300);
}

function done() {
  console.log('\n' + '='.repeat(46));
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('='.repeat(46));
  process.exit(fail ? 1 : 0);
}

/* ================= 5. 月度收益（已完成记录按月汇总） ================= */
/* ================= 6. 交易计划（止损 / 目标 / R 倍数 / 到线提醒） ================= */
function planStep() {
  section('6. 交易计划（初始风险、建议仓位、R 倍数、到线提醒）');
  /* 多头：买入均价 12.00 × 1000 股，止损 11.00 → 每股初始风险 1 元
     现价 12.40 → R = (12.40 − 12.00) ÷ 1 = +0.40R
     资金 100000 × 风险 1% ÷ 每股风险 1 = 1000 股（按 100 股整手取整仍是 1000） */
  const st = Object.assign(mk('long', [[12.00, 1000]], []), {
    code: '600519', cur: '12.4', expanded: true,
    plan: { why: '15日低位 + 板块回暖', tag: '低位轮动', stop: '11', target: '14',
      capital: '100000', riskPct: '1' }
  });
  const seed = JSON.stringify({
    fees: Object.assign({}, F),
    settings: { auto: false, interval: 30, alert: { on: false, profit: 0, loss: 0, plan: true } },
    stocks: [st], hist: [], lastBackupAt: ''
  });
  const dom = loadPage(seed);
  const w = dom.window, d = w.document;
  setTimeout(() => {
    const row = d.querySelector('tr.stock-row');
    const detail = d.querySelector('tr.detail-row');
    ok('6.1 展开区有交易计划卡', !!detail.querySelector('.planbox'));
    const line = row.querySelector('.c-cost .planline').textContent.replace(/\s+/g, ' ');
    ok('6.2 行内摘要含止损与目标', /止损 ¥11\.000/.test(line) && /目标 ¥14\.000/.test(line), line);
    ok('6.3 R 倍数 = +0.4R', /\+0\.4R/.test(line), line);
    const note = detail.querySelector('.pnote').textContent.replace(/\s+/g, ' ');
    ok('6.4 每股初始风险 ¥1.00', /每股初始风险 ¥1\.00/.test(note), note);
    ok('6.5 建议仓位 = 1,000 股（资金 × 1% ÷ 每股风险）', /建议 1,000 股/.test(note), note);
    const saved = JSON.parse(w.localStorage.getItem(KEY)).stocks[0];
    ok('6.6 计划字段落盘', saved.plan.stop === '11' && saved.plan.tag === '低位轮动',
      JSON.stringify(saved.plan));

    /* —— 到线提醒 —— */
    const curIn = row.querySelector('.curtd .cur');
    const setCur = (v) => {
      curIn.value = v;
      curIn.dispatchEvent(new w.Event('input', { bubbles: true }));
      curIn.dispatchEvent(new w.Event('change', { bubbles: true }));
    };
    w.__alerts.length = 0;
    setCur('12.0');                                  // 线内，不该弹
    check('6.7 线内不提醒', w.__alerts.length, 0);
    setCur('10.9');                                  // 跌破止损 11
    check('6.8 跌破止损弹一次', w.__alerts.length, 1);
    ok('6.9 提醒文案写明跌破止损', /跌破止损/.test(w.__alerts[0]), w.__alerts[0]);
    setCur('10.8');                                  // 仍在线外，闩锁生效不再弹
    check('6.10 闩锁：重复触发不再弹', w.__alerts.length, 1);
    setCur('12.4');                                  // 回到线内 1% 以上 → 重新武装
    setCur('10.5');
    check('6.11 回到线内后重新武装', w.__alerts.length, 2);
    /* 关掉开关后不再弹（先回到线内让闩锁解除） */
    const pe = d.querySelector('#al-plan');
    pe.checked = false; pe.dispatchEvent(new w.Event('change', { bubbles: true }));
    setCur('12.4'); setCur('10.4');
    check('6.12 关闭开关后不提醒', w.__alerts.length, 2);

    /* —— 目标价方向：现价触及 14 应提醒「触及目标」 —— */
    setCur('14.2');
    pe.checked = true; pe.dispatchEvent(new w.Event('change', { bubbles: true }));
    setCur('12.0'); setCur('14.3');
    ok('6.13 触及目标价会提醒', w.__alerts.some(a => /触及目标/.test(a)), w.__alerts.join(' | '));
    ok('6.14 无 JS 运行时错误', (w.__errs || []).length === 0, (w.__errs || []).join('|'));
    planStep2();
  }, 300);
}

/* 空头 + 旧数据兼容 */
function planStep2() {
  /* 空头：开仓卖出均价 12.00，止损 13.00 → 现价 13.20 高于止损线才叫触发 */
  const sh = Object.assign(mk('short', [], [[12.00, 1000]]), {
    code: '000001', cur: '13.2', expanded: true,
    plan: { why: '', tag: '做T', stop: '13', target: '11', capital: '', riskPct: '' }
  });
  /* 旧数据：根本没有 plan 字段，不能报错、也不能凭空长出摘要 */
  const legacy = Object.assign(mk('long', [[10.00, 1000]], []), { code: '600000', cur: '10.5' });
  const seed = JSON.stringify({
    fees: Object.assign({}, F),
    settings: { auto: false, interval: 30, alert: { on: false, profit: 0, loss: 0, plan: true } },
    stocks: [sh, legacy], hist: [], lastBackupAt: ''
  });
  const dom = loadPage(seed);
  const w = dom.window, d = w.document;
  setTimeout(() => {
    const rows = d.querySelectorAll('tr.stock-row');
    ok('6.15 空头现价高于止损线会提醒（方向相反）',
      (w.__alerts || []).some(a => /跌破止损/.test(a)), (w.__alerts || []).join(' | '));
    const shLine = rows[0].querySelector('.c-cost .planline').textContent.replace(/\s+/g, ' ');
    ok('6.16 空头 R = −1.2R（(12 − 13.2) ÷ 1）', /-1\.2R/.test(shLine), shLine);
    const lgLine = rows[1].querySelector('.c-cost .planline').textContent.trim();
    check('6.17 旧数据无 plan → 摘要为空且不报错', lgLine, '');
    const st2 = JSON.parse(w.localStorage.getItem(KEY)).stocks;
    ok('6.18 旧数据自动补空计划字段', st2[1].plan && st2[1].plan.stop === '' && st2[1].plan.tag === '',
      JSON.stringify(st2[1].plan));
    ok('6.19 无 JS 运行时错误', (w.__errs || []).length === 0, (w.__errs || []).join('|'));
    boardStep();
  }, 300);
}

function monthStep() {
  section('5. 月度收益（按成交日期归月，柱状分布 + 累计）');
  /* 三条记录：2026-08 两笔（+1000 净、-300 净）→ 当月 +700；
     2026-09 一笔 +500。费用 8 月 60 / 9 月 20，成本 8 月 9000 / 9 月 5000 */
  const hist = [
    { id: 'h1', date: '2026-09-05', name: '甲', dir: 'long', net: 500, fees: 20, cost: 5000, rate: 0.1 },
    { id: 'h2', date: '2026-08-12', name: '乙', dir: 'long', net: 1000, fees: 40, cost: 6000, rate: 0.15 },
    { id: 'h3', date: '2026-08-25', name: '丙', dir: 'short', net: -300, fees: 20, cost: 3000, rate: -0.08 }
  ];
  const seed = JSON.stringify({
    fees: Object.assign({}, F), settings: { auto: false, interval: 30 },
    stocks: [], hist: hist, lastBackupAt: ''
  });
  const dom = loadPage(seed);
  const w = dom.window, d = w.document;
  setTimeout(() => {
    const box = d.querySelector('#monthBox');
    ok('5.1 默认收起（hidden）', box.hidden && d.querySelectorAll('#monthBody tr').length === 0);
    d.querySelector('#month-toggle').click();
    const rows = d.querySelectorAll('#monthBody tr');
    check('5.2 展开后两个月份行', rows.length, 2);
    /* 行序：新月份在上 → 第一行 2026-09，第二行 2026-08；
       净收益/累计取 .cell-num（整格还有「收益率」小字，不能比整格文本） */
    const r1 = rows[0], r2 = rows[1];
    const num1 = r1.cells[4].querySelector('.cell-num'), num2 = r2.cells[4].querySelector('.cell-num');
    const cum1 = r1.cells[5].querySelector('.cell-num'), cum2 = r2.cells[5].querySelector('.cell-num');
    ok('5.3 行序：2026-09 在上', /2026-09/.test(r1.cells[0].textContent), r1.cells[0].textContent);
    ok('5.4 2026-09 当月净收益 +¥500.00（红）', num1.textContent.replace(/\s+/g, '') === '+¥500.00' &&
      num1.classList.contains('up'), num1.textContent);
    ok('5.5 2026-08 当月净收益 +¥700.00（1000 − 300）', num2.textContent.replace(/\s+/g, '') === '+¥700.00', num2.textContent);
    ok('5.6 2026-08 盈/亏 = 1 / 1', /1\s*\/\s*1/.test(r2.cells[1].textContent), r2.cells[1].textContent);
    check('5.7 2026-08 费用合计 ¥60', r2.cells[2].textContent.replace(/[¥,\s]/g, ''), '60.00');
    /* 累计按时间正序滚动：8 月 = +700，9 月 = 700 + 500 = +1,200 */
    check('5.8 2026-09 累计（含当月）= +¥1,200.00', cum1.textContent.replace(/\s+/g, ''), '+¥1,200.00');
    check('5.9 2026-08 累计 = +¥700.00', cum2.textContent.replace(/\s+/g, ''), '+¥700.00');
    /* 柱：8 月 |700|/700 → 半长 50%；9 月 |500|/700 → 半长 35.7% */
    const bar2 = r2.cells[3].querySelector('.mbar i');
    ok('5.10 8月盈利柱右伸满半程（50%）', !!bar2 && bar2.classList.contains('pos') &&
      bar2.style.left === '50%' && parseFloat(bar2.style.width) === 50, bar2 && bar2.style.cssText);
    const bar1 = r1.cells[3].querySelector('.mbar i');
    check('5.11 9月柱半长 35.7%', Math.round(parseFloat(bar1.style.width) * 10) / 10, 35.7);
    /* 日期改月份 → 汇总联动（change 事件里只调了 renderHistSum → renderMonthly） */
    const dateInput = d.querySelector('#hbody .hdate');
    dateInput.value = '2026-07-30';
    dateInput.dispatchEvent(new w.Event('change', { bubbles: true }));
    setTimeout(() => {
      const rows2 = d.querySelectorAll('#monthBody tr');
      check('5.12 改日期后仍是两个月', rows2.length, 2);
      const july = Array.from(rows2).find(r => /2026-07/.test(r.cells[0].textContent));
      const julyNum = july ? july.cells[4].querySelector('.cell-num') : null;
      ok('5.13 7 月出现且净收益 +¥500.00', !!julyNum &&
        julyNum.textContent.replace(/\s+/g, '') === '+¥500.00', july && july.textContent);
      ok('5.14 无 JS 运行时错误', (w.__errs || []).length === 0, (w.__errs || []).join('|'));
      planStep();
    }, 300);
  }, 300);
}

/* ================= 4. 持仓行分位槽 ================= */
function posStep() {
  section('4. 持仓行分位槽（开仓均价=固定刻度，当前价=浮动圆点，近 15 日高低区间）');
  /* 20 根日K，最高 12 / 最低 9：
     开仓均价 10 → 分位 (10−9)/(12−9) = 33.3；当前价 11 → 66.7 */
  const now = new Date().toISOString();
  const bars = [];
  for (let i = 0; i < 20; i++) {
    bars.push({ day: '2026-09-' + String(i + 1).padStart(2, '0'),
      open: 10, high: 12, low: 9, close: 10.5, volume: 1000, ma5: 10, ma10: 10, ma30: 10 });
  }
  const st = Object.assign(mk('long', [[10.00, 1000]], []), { code: '600519', cur: '11' });
  const seed = JSON.stringify({
    fees: Object.assign({}, F), settings: { auto: false, interval: 30 },
    stocks: [st], hist: [], lastBackupAt: '',
    kline: { updatedAt: now, d: { sh600519: { bars: bars, at: now, err: '' } } }
  });
  const dom = loadPage(seed);
  const w = dom.window, d = w.document;
  setTimeout(() => {
    const tr = d.querySelector('tr.stock-row');
    const bar = tr.querySelector('.c-cost .cbar');
    ok('4.1 槽存在且含固定刻度', !!bar && !!bar.querySelector('.cbar-cost'));
    const costLeft = bar && bar.querySelector('.cbar-cost') ? parseFloat(bar.querySelector('.cbar-cost').style.left) : -1;
    check('4.2 固定刻度位置 = 33.3%', Math.round(costLeft * 10) / 10, 33.3);
    const curDot = bar ? bar.querySelector('.cbar-cur') : null;
    const curLeft = curDot ? parseFloat(curDot.style.left) : -1;
    check('4.3 浮动圆点位置 = 66.7%（手填价生效）', Math.round(curLeft * 10) / 10, 66.7);
    ok('4.4 圆点配色 = 中间蓝（mid）', !!curDot && curDot.classList.contains('mid'));
    ok('4.5 悬停提示含区间与两个分位', /区间\s*9\.00～12\.00/.test(bar.title) && /分位\s*33/.test(bar.title) && /分位\s*67/.test(bar.title), bar.title);
    /* 无 K 线缓存的股票不画槽 */
    const st2 = Object.assign(mk('long', [[10.00, 1000]], []), { code: '000001', cur: '11' });
    const seed2 = JSON.stringify({
      fees: Object.assign({}, F), settings: { auto: false, interval: 30 },
      stocks: [st2], hist: [], lastBackupAt: '', kline: { updatedAt: now, d: {} }
    });
    const dom2 = loadPage(seed2);
    const w2 = dom2.window, d2 = dom2.window.document;
    setTimeout(() => {
      const tr2 = d2.querySelector('tr.stock-row');
      ok('4.6 无K线缓存时不画槽', !tr2.querySelector('.c-cost .cbar'));
      ok('4.7 无 JS 运行时错误', (w.__errs || []).length === 0 && (w2.__errs || []).length === 0,
        (w.__errs || []).concat(w2.__errs || []).join('|'));
      monthStep();
    }, 300);
  }, 300);
}

/* 重载、导入都必须经过真实页面入口，防止只测归一化函数而漏掉接线。 */
function persistenceStep() {
  section('9. 重载提醒去重与费率校验');
  const stock = Object.assign(mk('long', [[10, 100]], []), {
    cur: '8', plan: { stop: '9' }
  });
  const seed = JSON.stringify({ stocks: [stock], hist: [], fees: F });
  const first = loadPage(seed);
  check('9.1 首次跌破止损提醒一次', first.window.__alerts.length, 1);
  const saved = first.window.localStorage.getItem(KEY);
  check('9.2 本地重载保留持仓 ID', JSON.parse(saved).stocks[0].id, stock.id);
  const reloaded = loadPage(saved);
  check('9.3 重开页面仍在止损线外不重复提醒', reloaded.window.__alerts.length, 0);
  const input = reloaded.window.document.querySelector('.curtd .cur');
  for (const value of ['10', '8']) {
    input.value = value;
    input.dispatchEvent(new reloaded.window.Event('input', { bubbles: true }));
    input.dispatchEvent(new reloaded.window.Event('change', { bubbles: true }));
  }
  check('9.4 重载后回到线内再越线可以重新提醒', reloaded.window.__alerts.length, 1);
  first.window.close();
  reloaded.window.close();

  const ids = loadPage(JSON.stringify({ stocks: [
    stock, { ...stock }, { ...stock, id: '' }, { ...stock, id: 'bad"id' }
  ], hist: [] }));
  const rows = [...ids.window.document.querySelectorAll('tr.stock-row')];
  check('9.5 缺失、重复和异常 ID 不影响显示全部持仓', rows.length, 4);
  check('9.6 自动修复后的 ID 互不重复', new Set(rows.map(r => r.dataset.id)).size, 4);
  ok('9.7 自动修复后的 ID 可安全用于选择器', rows.every(r => /^[a-zA-Z0-9_-]+$/.test(r.dataset.id)));
  ids.window.close();

  const badFees = { commBuy: '-1', commSell: 'invalid', stamp: null, transfer: 'Infinity', minComm: -5 };
  const feesPage = loadPage(JSON.stringify({ stocks: [mk('long', [[10, 100]], [[11, 100]])],
    hist: [], fees: badFees }));
  const d = feesPage.window.document;
  for (const k of Object.keys(F)) {
    check('9.8 本地异常费率恢复默认 ' + k, Number(d.querySelector('#f-' + k).value), F[k]);
  }
  check('9.9 修复费率后已实现收益正确', money2num(d.querySelector('#k-real').textContent), 99.24);
  d.querySelector('#import-json').click();
  d.querySelector('#impText').value = JSON.stringify({ stocks: [stock], hist: [],
    fees: { ...badFees, commBuy: '0.025', minComm: '5' } });
  d.querySelector('#impParse').click();
  d.querySelector('#impReplace').click();
  check('9.10 导入保留有效小数费率', d.querySelector('#f-commBuy').value, '0.025');
  check('9.11 导入保留有效最低佣金', Number(d.querySelector('#f-minComm').value), 5);
  check('9.12 导入异常费率恢复默认', Number(d.querySelector('#f-commSell').value), F.commSell);
  ok('9.13 重新导入持仓不沿用原提醒 ID', d.querySelector('tr.stock-row').dataset.id !== stock.id);
  ok('9.14 回归场景无运行时错误', feesPage.window.__errs.length === 0, feesPage.window.__errs.join('|'));
  feesPage.window.close();
}

async function profitRecoveryStep() {
  section('10. 收益拆分与误删恢复');
  const makePage = (stocks = [], hist = [], fees = F, extra = {}, opt = {}) => loadPage(JSON.stringify({
    stocks, hist, fees, settings: { auto: false, alert: { plan: false } }, ...extra
  }), opt);
  const value = (dom, id) => money2num(dom.window.document.querySelector(id).textContent);
  const snapshot = dom => JSON.parse(dom.window.localStorage.getItem(KEY));
  const restore = (dom, index = 0) => dom.window.document.querySelectorAll('[data-recovery]')[index].click();
  const stock = Object.assign(mk('long', [[10, 100]], [[12, 40]]), { cur: '11', name: '保留的持仓', expanded: true });
  const archived = [
    { id: 'hn', name: '普通', net: 99, fees: 1, cost: 1000, date: '2026-10-25' },
    { id: 'hf', name: '强平', net: 100, fees: 2, forced: true, cost: 1000, date: '2026-10-26' }
  ];
  const p = makePage([stock], archived, F, {}, { downloadCapture: true });
  // 价差：已卖 40×2 + 剩余 60×1 + 两笔历史各 100 = 340。
  // 费用：买入 .10 + 卖出 .29 + 历史 3 = 3.39；预估卖出 660：.07 + .33 = .40。
  check('10.1 混合普通与强平记录的毛收益', value(p, '#profit-gross'), 340);
  check('10.2 已发生费用单列', value(p, '#profit-fees'), 3.39);
  check('10.3 预估平仓费用单列', value(p, '#profit-est-fees'), 0.40);
  check('10.4 净收益统一扣费且不重复扣普通手续费', value(p, '#profit-net'), 336.21);
  ok('10.5 强平记录展示毛100 / 净98', /毛 \+¥100\.00 · 净 \+¥98\.00/.test(p.window.document.querySelector('#hbody').textContent));
  p.window.document.querySelector('#export-hist').click();
  const readDownload = blob => new Promise((resolve, reject) => {
    const reader = new p.window.FileReader();
    reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsText(blob);
  });
  const csv = await readDownload(p.window.__downloads[0]);
  ok('10.5a 交易CSV包含毛收益与扣费净收益列', /毛收益,扣费净收益/.test(csv));
  ok('10.5b 交易CSV强平记录扣费后为98', csv.split('\r\n').some(row => /强平/.test(row) && /100\.00,98\.00$/.test(row)));
  p.window.document.querySelector('#export').click();
  const holdingCsv = await readDownload(p.window.__downloads[1]);
  ok('10.5c 持仓CSV包含全账户拆分', /"扣费净收益",336\.21/.test(holdingCsv));
  p.window.document.querySelector('#hbody .ico.del').click();
  check('10.6 删除历史记录后顶部净收益即时联动', value(p, '#profit-net'), 238.21);
  restore(p);
  check('10.7 恢复历史记录后收益还原', value(p, '#profit-net'), 336.21);
  p.window.document.querySelector('.del-lot').click();
  check('10.8 删除买入批次成功', snapshot(p).stocks[0].buys.length, 0);
  const afterLotDelete = p.window.localStorage.getItem(KEY);
  p.window.close();
  const reload = loadPage(afterLotDelete);
  restore(reload);
  check('10.9 重开页面仍可恢复批次', snapshot(reload).stocks[0].buys[0].qty, '100');
  reload.window.document.querySelector('tr.stock-row .ico.del').click();
  reload.window.document.querySelector('#add-long').click();
  const name = reload.window.document.querySelector('tr.stock-row input.name');
  name.value = '删除后新增';
  name.dispatchEvent(new reload.window.Event('input', { bubbles: true }));
  restore(reload);
  check('10.10 恢复删除持仓保留之后新增的数据', snapshot(reload).stocks.length, 2);
  ok('10.11 新增名称与恢复名称均保留', snapshot(reload).stocks.some(s => s.name === '删除后新增') && snapshot(reload).stocks.some(s => s.name === '保留的持仓'));
  reload.window.document.querySelector('#reset').click();
  check('10.12 清空持仓成功', snapshot(reload).stocks.length, 0);
  restore(reload);
  check('10.13 批量恢复清空的全部持仓', snapshot(reload).stocks.length, 2);
  reload.window.document.querySelector('#clear-hist').click();
  check('10.14 清空交易记录成功', snapshot(reload).hist.length, 0);
  restore(reload);
  check('10.15 批量恢复交易记录', snapshot(reload).hist.length, 2);
  ok('10.16 交互无运行时错误', reload.window.__errs.length === 0, reload.window.__errs.join('|'));
  reload.window.close();

  const short = Object.assign(mk('short', [[9, 40]], [[10, 100]]), { cur: '8' });
  const sp = makePage([short], [], { ...F, minComm: 5 });
  check('10.17 空头毛收益40×1+60×2', value(sp, '#profit-gross'), 160);
  check('10.18 空头按逐笔最低佣金及卖出印花税计费', value(sp, '#profit-fees'), 10.5);
  check('10.19 空头预估回买费用按最低佣金计提', value(sp, '#profit-est-fees'), 5);
  check('10.20 空头扣费净收益', value(sp, '#profit-net'), 144.5);
  sp.window.close();
  for (const bad of [{ ...stock, cur: '' }, mk('long', [[10, 1]], [[11, 2]])]) {
    const missing = makePage([bad]);
    check('10.21 缺价或超卖时不展示完整净收益', missing.window.document.querySelector('#profit-net').textContent, '—');
    ok('10.22 缺价或超卖有明确说明', /收益暂不完整/.test(missing.window.document.querySelector('#profit-note').textContent));
    missing.window.close();
  }
  let replace = makePage([stock], archived, { ...F, minComm: 5 }, { watch: [{ id: 'w1', code: '600001', name: '观察股' }] });
  const d = replace.window.document;
  d.querySelector('#import-json').click();
  d.querySelector('#impText').value = JSON.stringify({ stocks: [], hist: [], watch: [], fees: F });
  d.querySelector('#impParse').click(); d.querySelector('#impReplace').click();
  check('10.23 覆盖导入自动保留恢复点', snapshot(replace).recovery.length, 1);
  const importedSeed = replace.window.localStorage.getItem(KEY);
  replace.window.close(); replace = loadPage(importedSeed);
  restore(replace);
  check('10.24 恢复覆盖前持仓', snapshot(replace).stocks.length, 1);
  check('10.25 恢复覆盖前历史', snapshot(replace).hist.length, 2);
  check('10.26 恢复覆盖前观察池', snapshot(replace).watch.length, 1);
  check('10.27 恢复覆盖前费率', snapshot(replace).fees.minComm, 5);
  check('10.28 完整恢复前也保留当前数据供撤回', snapshot(replace).recovery.length, 1);
  restore(replace);
  check('10.29 可以撤回完整恢复', snapshot(replace).stocks.length, 0);
  replace.window.close();
  let watch = makePage([], [], F, { watch: [{ id: 'w1', code: '600001', name: '观察股' }] });
  watch.window.document.querySelector('#watchBody .wdel').click();
  check('10.29a 移除观察股成功', snapshot(watch).watch.length, 0);
  const watchSeed = watch.window.localStorage.getItem(KEY);
  watch.window.close(); watch = loadPage(watchSeed);
  restore(watch);
  check('10.29b 重开页面可恢复观察股', snapshot(watch).watch[0].code, '600001');
  watch.window.close();
  const limit = makePage();
  for (let i = 0; i < 12; i++) {
    limit.window.document.querySelector('#add-long').click();
    limit.window.document.querySelector('#reset').click();
  }
  check('10.30 仅保留最近10次操作', snapshot(limit).recovery.length, 10);
  limit.window.close();
  const failSave = makePage([stock], [], F, {}, { storageFailure: true });
  failSave.window.document.querySelector('#reset').click();
  check('10.31 无法保存恢复点时取消清空', failSave.window.document.querySelectorAll('tr.stock-row').length, 1);
  ok('10.32 保存失败显示可见警告', !failSave.window.document.querySelector('#save-warning').hidden);
  ok('10.33 操作取消有明确提示', failSave.window.__alerts.some(s => /本次操作已取消/.test(s)));
  failSave.window.close();
}

async function timelineStep() {
  section('11. 交易时间、移动加权平均与存档流水');
  const zero = { commBuy: 0, commSell: 0, stamp: 0, transfer: 0, minComm: 0 };
  const make = (dir, opens, closes, cur = '21', fees = zero, opt = {}) => {
    const stock = build(dir, opens.map(x => x.slice(0, 2)), closes.map(x => x.slice(0, 2)));
    stock.cur = cur; stock.expanded = true;
    (dir === 'short' ? stock.sells : stock.buys).forEach((l, i) => Object.assign(l, { at: opens[i][2], order: opens[i][3] }));
    (dir === 'short' ? stock.buys : stock.sells).forEach((l, i) => Object.assign(l, { at: closes[i][2], order: closes[i][3] }));
    return loadPage(JSON.stringify({ stocks: [stock], hist: [], fees, settings: { auto: false, alert: { plan: false } } }), opt);
  };
  const opens = [[20, 100, '2026-10-01T09:30:00', 3], [10, 100, '2026-09-01T09:30:00', 1]];
  const closes = [[22, 50, '2026-10-02T09:30:00', 4], [12, 50, '2026-09-02T09:30:00', 2]];
  const val = (dom, selector) => money2num(dom.window.document.querySelector(selector).textContent);
  const saved = dom => JSON.parse(dom.window.localStorage.getItem(KEY));
  const edit = (dom, selector, value) => {
    const el = dom.window.document.querySelector(selector); el.value = value;
    el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  };
  const showLedger = dom => {
    const panel = dom.window.document.querySelector('#ledger-panel'); panel.open = true;
    panel.dispatchEvent(new dom.window.Event('toggle'));
    return [...dom.window.document.querySelectorAll('#ledger-body tr')];
  };
  let p = make('long', opens, closes, '21', zero, { downloadCapture: true });
  check('11.1 乱序录入仍按成交时间结转：已实现366.67', val(p, '.c-real .net'), 366.67);
  check('11.2 剩余100股的成本为16.6667', p.window.document.querySelector('.c-cost .cost').textContent, '¥16.667');
  check('11.3 浮动433.33', val(p, '.c-float .net'), 433.33);
  check('11.4 总净收益800', val(p, '#profit-net'), 800);
  let rows = showLedger(p);
  check('11.5 流水共4笔', rows.length, 4);
  ok('11.6 流水按9月到10月顺序显示', rows[0].cells[0].textContent.startsWith('2026-09-01') && rows[3].cells[0].textContent.startsWith('2026-10-02'));
  check('11.7 先卖出的收益不受后续20元加仓影响', money2num(rows[1].cells[9].textContent), 100);
  check('11.8 再加仓后平仓逐笔结转266.67', money2num(rows[3].cells[9].textContent), 266.67);
  edit(p, '.curtd .cur', '21');
  check('11.9 成交时间原样保存', saved(p).stocks[0].buys[0].at, opens[0][2]);
  const reloadSeed = p.window.localStorage.getItem(KEY); await new Promise(resolve => setTimeout(resolve, 0));
  p.window.close(); p = loadPage(reloadSeed, { downloadCapture: true });
  check('11.10 重开页面时间顺序与收益不变', val(p, '.c-real .net'), 366.67);
  p.window.document.querySelector('#month-toggle').click();
  const monthValue = month => {
    const row = [...p.window.document.querySelectorAll('#monthBody tr')].find(r => r.cells[0].textContent === month);
    return money2num(row.cells[4].querySelector('.cell-num').textContent);
  };
  check('11.11 未存档的9月已实现收益归9月', monthValue('2026-09'), 100);
  check('11.12 未存档的10月已实现收益归10月', monthValue('2026-10'), 266.67);
  p.window.document.querySelector('tr.stock-row .ico.done').click();
  edit(p, '#arcLiqBody [data-k="price"]', '21'); edit(p, '#arcLiqBody [data-k="qty"]', '100');
  edit(p, '#arcDate', '2026-08-01');
  ok('11.13 清盘早于已有成交时不能存档', p.window.document.querySelector('#arcOk').disabled);
  edit(p, '#arcDate', '2026-10-03'); edit(p, '#arcTime', '15:00:00');
  ok('11.14 修正清盘时间后可以存档', !p.window.document.querySelector('#arcOk').disabled);
  p.window.document.querySelector('#arcOk').click();
  check('11.15 存档保留五笔流水', saved(p).hist[0].tradeLog.length, 5);
  check('11.16 已实现收益与清盘前总收益守恒', saved(p).hist[0].net, 800);
  check('11.17 存档后9月仍归9月不搬到存档日', monthValue('2026-09'), 100);
  check('11.18 存档后10月收益包含最后清盘', monthValue('2026-10'), 700);
  edit(p, '#f-minComm', '100');
  check('11.19 改费率不改变存档收益', val(p, '#profit-net'), 800);
  showLedger(p);
  p.window.document.querySelector('#export-trades').click();
  const csv = await new Promise((resolve, reject) => {
    const reader = new p.window.FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject;
    reader.readAsText(p.window.__downloads[0]);
  });
  ok('11.20 流水CSV保留秒、顺序与平仓收益', /2026-09-02 09:30:00/.test(csv) && /100\.00/.test(csv) && /移动加权平均/.test(csv));
  const archivedSeed = p.window.localStorage.getItem(KEY); p.window.close(); p = loadPage(archivedSeed);
  rows = showLedger(p);
  check('11.21 重载后的存档流水完整', rows.length, 5);
  check('11.22 重载后逐笔平仓收益保持锁定', money2num(rows[1].cells[9].textContent), 100);
  ok('11.23 新流程无运行时错误', p.window.__errs.length === 0, p.window.__errs.join('|'));
  await new Promise(resolve => setTimeout(resolve, 0));
  p.window.close();
  const imported = loadPage(archivedSeed, { downloadCapture: true });
  imported.window.document.querySelector('#export-json').click();
  const backupText = await new Promise(resolve => {
    const reader = new imported.window.FileReader(); reader.onload = () => resolve(reader.result);
    reader.readAsText(imported.window.__downloads[0]);
  });
  const backup = JSON.parse(backupText);
  check('11.23a 新备份标明版本5', backup.version, 5);
  check('11.23b JSON备份保留完整五笔存档流水', backup.hist[0].tradeLog.length, 5);
  const merge = obj => {
    const d = imported.window.document; d.querySelector('#import-json').click(); d.querySelector('#impText').value = JSON.stringify(obj);
    d.querySelector('#impParse').click(); d.querySelector('#impMerge').click();
  };
  merge(backup);
  check('11.23c 重复导入同一份流水不会重复记账', saved(imported).hist.length, 1);
  const another = JSON.parse(backupText); another.hist[0].tradeLog[0].at = '2026-08-01T09:30:00';
  merge(another);
  check('11.23d 汇总相同但时间不同的独立流水不会被错误去重', saved(imported).hist.length, 2);
  imported.window.close();
  const sp = make('short', [[10, 100, opens[0][2], 3], [20, 100, opens[1][2], 1]], [[8, 50, closes[0][2], 4], [18, 50, closes[1][2], 2]], '9');
  check('11.24 空头按时间释放成本，已实现366.67', val(sp, '.c-real .net'), 366.67);
  check('11.25 空头剩余净开仓基准13.3333', sp.window.document.querySelector('.c-cost .cost').textContent, '¥13.333');
  check('11.26 空头总收益800', val(sp, '#profit-net'), 800); sp.window.close();
  const min = make('long', opens, closes, '21', { ...zero, minComm: 5 });
  check('11.27 最低佣金逐笔入成本，已实现351.67', val(min, '.c-real .net'), 351.67);
  check('11.28 净收益800扣四笔费用20与预估5', val(min, '#profit-net'), 775); min.window.close();
  const forced = make('long', opens, closes, '21', { ...zero, minComm: 5 });
  forced.window.document.querySelector('tr.stock-row .ico.done').click();
  const forceRadio = forced.window.document.querySelector('input[name="arcmode"][value="force"]');
  forceRadio.checked = true; forceRadio.dispatchEvent(new forced.window.Event('change', { bubbles: true }));
  edit(forced, '#arcForcePrice', '21'); edit(forced, '#arcForceQty', '100');
  edit(forced, '#arcDate', '2026-08-01'); forced.window.document.querySelector('#arcOk').click();
  ok('11.28a 强平也不能倒填到已有成交之前', forced.window.document.querySelector('#arcMask').classList.contains('on'));
  edit(forced, '#arcDate', '2026-10-03'); edit(forced, '#arcTime', '15:00:00'); forced.window.document.querySelector('#arcOk').click();
  check('11.28b 按流水结转后强平保留原毛收益800', saved(forced).hist[0].net, 800);
  check('11.28c 按流水强平的统一扣费净收益775', val(forced, '#profit-net'), 775);
  check('11.28d 强平也保留五笔真实成交供查看', saved(forced).hist[0].tradeLog.length, 5); forced.window.close();
  const recovery = make('long', opens, closes);
  recovery.window.document.querySelector('.lot-col[data-kind="buy"] .del-lot').click();
  recovery.window.document.querySelector('[data-recovery]').click();
  check('11.28e 误删恢复包含成交时间与同刻顺序', val(recovery, '.c-real .net'), 366.67);
  ok('11.28f 误删恢复未丢失原成交时间', saved(recovery).stocks[0].buys.some(l => l.at === opens[0][2] && Number(l.order) === 3));
  recovery.window.document.querySelector('.add-lot').click();
  const lastLot = saved(recovery).stocks[0].buys.at(-1);
  ok('11.28g 新增批次自动填入时间与不重复顺序', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(lastLot.at) && Number(lastLot.order) > 4);
  recovery.window.close();
  const reentry = make('long', [[10, 100, opens[1][2], 1], [20, 100, opens[0][2], 3]], [[12, 100, closes[1][2], 2]]);
  check('11.29 清仓再开仓不追溯修改前笔收益', val(reentry, '.c-real .net'), 200);
  check('11.30 清仓再建仓成本重置为20', reentry.window.document.querySelector('.c-cost .cost').textContent, '¥20.000'); reentry.window.close();
  const tied = make('long', [[10, 100, opens[1][2], 1], [20, 100, opens[1][2], 3]], [[12, 50, opens[1][2], 2]]);
  check('11.31 同一时间按顺序号而非买卖分组结转', val(tied, '.c-real .net'), 100);
  edit(tied, '.lot-col[data-kind="buy"] tr.lot-row:last-child [data-k="order"]', '2');
  ok('11.32 同刻序号重复有提示', /顺序重复/.test(tied.window.document.querySelector('.timeline-note').textContent));
  check('11.33 无效顺序不显示完整净收益', tied.window.document.querySelector('#profit-net').textContent, '—'); tied.window.close();
  const invalid = make('long', [[10, 100, '2026-10-03T09:30:00', 1]], [[11, 100, '2026-10-02T09:30:00', 2]]);
  ok('11.34 总量相等仍拦截先卖后买', /超过当时持仓/.test(invalid.window.document.querySelector('.timeline-note').textContent));
  invalid.window.document.querySelector('tr.stock-row .ico.done').click();
  ok('11.35 无效时间顺序不能通过存档绕过', !invalid.window.document.querySelector('#arcMask').classList.contains('on')); invalid.window.close();
  const partial = make('long', opens, closes.map(x => [x[0], x[1], '', x[3]]));
  check('11.36 旧数据缺时间保留原汇总收益200', val(partial, '.c-real .net'), 200);
  ok('11.37 部分时间明确提示未启用顺序结转', /未补齐/.test(partial.window.document.querySelector('.timeline-note').textContent)); partial.window.close();
  const badDate = make('long', [[10, 100, '2026-02-30T09:30:00', 1]], []);
  ok('11.38 无效日历日期不会静默改日期', /成交时间无效/.test(badDate.window.document.querySelector('.timeline-note').textContent)); badDate.window.close();
}

function layoutStep() {
  section('12. 多空明细方向切换');
  const stock = Object.assign(mk('long', [[10, 100]], [[11, 50]]), { expanded: true });
  const dom = loadPage(JSON.stringify({ stocks: [stock], hist: [], fees: F,
    settings: { auto: false, alert: { plan: false } } }));
  const w = dom.window, d = w.document;
  const columns = () => [...d.querySelectorAll('tr.detail-row .lot-col')];
  check('12.1 多头左买右卖', columns().map(c => c.dataset.kind).join(','), 'buy,sell');
  ok('12.2 多头左侧建仓、右侧平仓', columns()[0].classList.contains('opening') && columns()[1].classList.contains('closing'));
  d.querySelector('tr.stock-row button.dir').click();
  check('12.3 切换空头后左卖右买', columns().map(c => c.dataset.kind).join(','), 'sell,buy');
  ok('12.4 空头左侧开仓、右侧平仓', columns()[0].classList.contains('opening') && columns()[1].classList.contains('closing'));
  check('12.5 空头开仓栏保留原卖出价格', columns()[0].querySelector('[data-k="price"]').value, '11');
  check('12.6 空头平仓栏保留原买入价格', columns()[1].querySelector('[data-k="price"]').value, '10');
  d.querySelector('tr.stock-row button.dir').click();
  check('12.7 切回多头恢复左买右卖', columns().map(c => c.dataset.kind).join(','), 'buy,sell');
  const saved = JSON.parse(w.localStorage.getItem(KEY)).stocks[0];
  ok('12.8 切换方向不修改已录交易', saved.buys[0].price === '10' && saved.sells[0].price === '11');
  ok('12.9 切换无运行时错误', w.__errs.length === 0, w.__errs.join('|'));
  dom.window.close();
  const shortPage = loadPage(JSON.stringify({ stocks: [{ ...stock, dir: 'short' }], hist: [], fees: F,
    settings: { auto: false, alert: { plan: false } } }));
  const sd = shortPage.window.document;
  const shortColumns = () => [...sd.querySelectorAll('tr.detail-row .lot-col')];
  check('12.10 重新打开空头时左卖右买', shortColumns().map(c => c.dataset.kind).join(','), 'sell,buy');
  shortColumns()[0].querySelector('.add-lot').click();
  shortColumns()[1].querySelector('.add-lot').click();
  const shortSaved = JSON.parse(shortPage.window.localStorage.getItem(KEY)).stocks[0];
  check('12.11 左侧新增到卖出开仓', shortSaved.sells.length, 2);
  check('12.12 右侧新增到买入平仓', shortSaved.buys.length, 2);
  shortPage.window.close();
}

layoutStep();
await timelineStep();
await profitRecoveryStep();
persistenceStep();
nextCase();
