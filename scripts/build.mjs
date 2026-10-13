#!/usr/bin/env node
/*
 * 构建脚本：把 src/ 下的三份源码内联成一个自包含的 index.html。
 *
 * 设计要点（改动前请先读）：
 * 1. 不做任何压缩/转译/打包，只做字符串替换 —— 产物必须能双击用 file:// 打开，
 *    且不依赖任何网络请求，这是这个工具的核心价值。
 * 2. 替换一律用 **函数形式** 的 replace(str, () => content)。
 *    用字符串形式会被 $&、$1、$` 这类替换模式破坏 —— 本项目 app.js 里就有
 *    `"...".replace(/(\d\d)(\d\d)/, "$1:$2")`，用字符串形式会把 "$1:$2" 吃掉。
 * 3. 构建后逐字节校验：产物里必须能找到完整的 css / js 原文（见 verifyInlined）。
 *    这条断言能一次性抓住上面第 2 点以及占位符残留、编码损坏等问题。
 *
 * 用法：
 *   node scripts/build.mjs            构建并写入 index.html（正式版）
 *   node scripts/build.mjs --check    只检查 index.html 是否与 src/ 同步（CI / 提交前用）
 *   node scripts/build.mjs --beta     构建【测试版】到 ../股票收益计算器-测试版.html
 *
 * 为什么要单独做 --beta：
 *   新功能开发期要让用户能放心试用，又不能碰到他正在用的正式数据。
 *   测试版产物做了三件事和正式版隔离：
 *     1. localStorage 键换成独立的 stock-pl-beta-v1（两边互不读写，正式数据零风险）；
 *     2. 关闭旧版本键的迁移（KEY_OLD 置空），避免测试版把历史数据吸过来；
 *     3. 页面顶部挂醒目条幅 + 标题带「测试版」，导出的文件名也带后缀，不会和正式版混淆。
 *   试用期结束后删掉这个分支即可，src/ 本身不需要为差异留任何代码。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = {
  template: path.join(ROOT, 'src/index.template.html'),
  styles: path.join(ROOT, 'src/styles.css'),
  app: path.join(ROOT, 'src/app.js'),
  out: path.join(ROOT, 'index.html')
};
const STYLES_TOKEN = '{{STYLES}}';
const APP_TOKEN = '{{APP_JS}}';
const STAMP_RE = /^[ \t]*<!-- build: .* -->[ \t]*\n?/m;
const BETA_KEY = 'stock-pl-beta-v1';
const BETA_OUT_NAME = '../股票收益计算器-测试版.html';
const BETA_CSS = [
  '',
  '  /* ---------- 测试版专属：醒目条幅与标题标记（仅 --beta 产物有） ---------- */',
  '  .betabar{max-width:1520px;margin:0 auto 12px;padding:10px 14px;border-radius:12px;',
  '    background:#fff8e6;border:1px solid #f0dfc4;color:#7a4f0a;font-size:12.5px;line-height:1.7;}',
  '  .betabar b{color:#633806;font-weight:600;}',
  '  .betabadge{margin-left:10px;padding:2px 8px;border-radius:6px;font-size:12px;font-weight:600;',
  '    vertical-align:middle;background:#fff8e6;border:1px solid #f0dfc4;color:#854F0B;}',
  ''
].join('\n');

const checkOnly = process.argv.includes('--check');
const beta = process.argv.includes('--beta');
if (checkOnly && beta) fail('--check 与 --beta 不能同时使用');

function fail(msg) {
  console.error('\n✗ 构建失败：' + msg + '\n');
  process.exit(1);
}

function read(p, label) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    fail('读不到 ' + label + '（' + path.relative(ROOT, p) + '）：' + e.message);
  }
}

/* 内联进 HTML 的内容有两类危险序列，必须在构建期拦住：
   1. 闭合标签 </script> / </style> —— 标签会被提前闭合，后面的内容变成页面可见文本；
   2. `<script` 或 `<!--` —— HTML 分词器在 script 数据里遇到 `<!--` 会进入「转义」状态，
      之后的 `</script>` 可能**不再闭合**标签（script data double escaped）。
   两种都会把页面弄坏，而且产物"看起来还在"、极难排查，所以宁可构建失败。
   注意：注释里的标签字面量同样算数 —— 分词器不看 JS 注释。 */
function assertSafeInline(text, kind, label) {
  const rules = kind === 'js'
    ? [['</script', '闭合标签'], ['<script', 'script 开标签'], ['<!--', 'HTML 注释开始']]
    : [['</style', '闭合标签'], ['<style', 'style 开标签'], ['<!--', 'HTML 注释开始']];
  rules.forEach(function (rule) {
    const needle = rule[0], why = rule[1];
    const i = text.toLowerCase().indexOf(needle);
    if (i >= 0) {
      const line = text.slice(0, i).split('\n').length;
      fail(label + ' 第 ' + line + ' 行含 ' + JSON.stringify(needle) + '（' + why +
        '），内联进 HTML 会破坏解析。请改写这段文字 —— 注释里也不要写标签字面量。');
    }
  });
}

function buildStamp(css, js, template) {
  const hash = crypto.createHash('sha256')
    .update(template.replace('{{BUILD_STAMP}}', '') + '\n' + css + '\n' + js)
    .digest('hex').slice(0, 8);
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset() / 60;
  const t = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' +
    p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()) +
    ' UTC' + (off >= 0 ? '+' : '-') + Math.abs(off);
  return t + ' · ' + hash;
}

/* —— 把源码改写为「测试版」版本 ——
   锚点都用「恰好出现 1 次」来保证：源码一改就可能找不到或匹配多处，
   宁可让构建直接失败，也不要静默生成一个看起来正常、实际没隔离的产物。 */
function subOnce(text, needle, replacement, label) {
  const n = text.split(needle).length - 1;
  if (n !== 1) {
    fail('测试版锚点「' + label + '」在源码里出现 ' + n + ' 次（应为 1 次）' +
      '。源码改过了，请同步修改 scripts/build.mjs 里的 makeBeta()。');
  }
  return text.replace(needle, () => replacement);
}
function makeBeta(template, css, js) {
  js = subOnce(js, 'var KEY = "stock-pl-calculator-v4";',
    'var KEY = "' + BETA_KEY + '";', '存储键声明');
  js = subOnce(js, 'var KEY_OLD = ["stock-pl-calculator-v3", "stock-pl-calculator-v2"];',
    'var KEY_OLD = [];', '旧键迁移列表');
  js = subOnce(js, 'downloadRaw("股票收益计算器_备份_" + stampStr() + ".json"',
    'downloadRaw("股票收益计算器-测试版_备份_" + stampStr() + ".json"', '备份 JSON 文件名');
  js = subOnce(js, 'download("股票持仓收益_" + todayStr()',
    'download("股票持仓收益-测试版_" + todayStr()', '持仓 CSV 文件名');
  js = subOnce(js, 'download("已完成交易记录_" + todayStr()',
    'download("已完成交易记录-测试版_" + todayStr()', '已完成记录 CSV 文件名');
  template = subOnce(template, '<title>股票收益计算器（分批建仓 / 分批卖出 / 卖空）</title>',
    '<title>股票收益计算器 · 测试版（数据独立，不影响正式版）</title>', 'title');
  template = subOnce(template, '<h1>股票收益计算器</h1>',
    '<h1>股票收益计算器<span class="betabadge">测试版</span></h1>', '主标题');
  template = subOnce(template, '<body>\n<div class="wrap">',
    '<body>\n<div class="betabar"><b>测试版</b>：新功能试用期，数据存在独立区域' +
    '（' + BETA_KEY + '），与正式版互不读写，不会碰你正在用的任何数据。' +
    '想用真实持仓来试：在正式版点「导出备份 JSON」，到这里用「导入 JSON → 覆盖全部数据」即可。' +
    '正式版文件（index.html / 股票收益计算器.html）仍是稳定可用的那一版。</div>\n<div class="wrap">',
    'body 起始');
  return { template: template, css: css + BETA_CSS, js: js };
}

function build() {
  const templateRaw = read(P.template, '模板 src/index.template.html');
  const cssRaw = read(P.styles, '样式 src/styles.css');
  const jsRaw = read(P.app, '脚本 src/app.js');

  /* —— 前置校验（始终打在原始源码上） —— */
  [APP_TOKEN, STYLES_TOKEN].forEach((t) => {
    const n = templateRaw.split(t).length - 1;
    if (n !== 1) fail('模板里 "' + t + '" 出现了 ' + n + ' 次，应当恰好 1 次。');
  });
  if (cssRaw.includes(STYLES_TOKEN) || jsRaw.includes(STYLES_TOKEN) || jsRaw.includes(APP_TOKEN)) {
    fail('源码里出现了占位符字面量，会破坏替换。');
  }
  assertSafeInline(jsRaw, 'js', 'src/app.js');
  assertSafeInline(cssRaw, 'css', 'src/styles.css');
  // 顺手做一次语法检查：坏掉的 JS 不该被构建进产物
  try {
    new vm.Script(jsRaw);
  } catch (e) {
    fail('src/app.js 语法有误：' + e.message);
  }
  if (!templateRaw.includes('{{BUILD_STAMP}}')) fail('模板缺少 {{BUILD_STAMP}} 占位符。');

  /* —— 测试版：先把源码改写成隔离版本（index.html 不会被碰） —— */
  const src = beta ? makeBeta(templateRaw, cssRaw, jsRaw)
    : { template: templateRaw, css: cssRaw, js: jsRaw };
  const template = src.template, css = src.css, js = src.js;

  /* —— 替换（函数形式，见文件头第 2 点） —— */
  const stamp = buildStamp(css, js, template);
  const out = template
    .replace(STYLES_TOKEN, () => css)
    .replace(APP_TOKEN, () => js)
    .replace('{{BUILD_STAMP}}', () => stamp);

  /* —— 后置校验：产物里必须能找到两份原文 —— */
  if (out.indexOf(css) < 0) fail('产物里找不到完整的 styles.css 原文（替换被破坏？）');
  if (out.indexOf(js) < 0) fail('产物里找不到完整的 app.js 原文（替换被破坏？）');
  ['{{STYLES}}', '{{APP_JS}}', '{{BUILD_STAMP}}'].forEach((t) => {
    if (out.includes(t)) fail('产物里残留占位符 ' + t);
  });
  if (out.split('</script>').length - 1 !== 1 || out.split('</style>').length - 1 !== 1) {
    fail('产物里的 </script> / </style> 数量异常');
  }
  return { out, stamp, css, js };
}

/* 去掉构建戳那行，用于「是否同步」的比较 */
const stripStamp = (s) => s.replace(STAMP_RE, '');

if (checkOnly) {
  if (!fs.existsSync(P.out)) fail('index.html 不存在，请先执行 node scripts/build.mjs');
  const { out, stamp } = build();
  const cur = fs.readFileSync(P.out, 'utf8');
  if (stripStamp(cur) === stripStamp(out)) {
    const curStamp = (cur.match(/<!-- build: (.*?) -->/) || [, '(无)'])[1];
    console.log('✓ index.html 与 src/ 同步（产物构建戳 ' + curStamp + '）');
    process.exit(0);
  }
  console.error('\n✗ index.html 与 src/ 不一致：src/ 改过了但没有重新构建。');
  console.error('  请执行：node scripts/build.mjs\n');
  process.exit(1);
}

const { out, stamp } = build();
const betaOut = path.join(ROOT, '..', '股票收益计算器-测试版.html');
const target = beta ? betaOut : P.out;
fs.writeFileSync(target, out, 'utf8');
console.log(beta ? '✓ 已生成 ' + BETA_OUT_NAME + '（测试版）' : '✓ 已生成 index.html（正式版）');
console.log('  构建戳   ' + stamp);
console.log('  存储键   ' + (beta ? BETA_KEY + '（与正式版隔离）' : 'stock-pl-calculator-v4'));
console.log('  体积     ' + out.length + ' 字符 / ' + Buffer.byteLength(out, 'utf8') + ' 字节');
console.log('  来源     styles.css ' + (read(P.styles, '').length) + ' 字符，app.js ' +
  (read(P.app, '').length) + ' 字符');
if (beta) {
  console.log('  提示     正式版 index.html 未被改动，依旧是可正常使用的稳定版本。');
  console.log('           试用期结束后，照常执行 node scripts/build.mjs 让它成为正式版。');
}
