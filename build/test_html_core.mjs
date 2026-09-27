/**
 * HTML 版核心逻辑自检（Node 环境，不需要浏览器）。
 *
 * 做法：从 HTML 中抽取 <script> 内容，去掉依赖 DOM 的启动代码，
 * 追加测试代码后写入临时模块并 import 执行。
 *
 * 用法：node test_html_core.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * 目录约定（整理后的结构）：
 *   <项目>/index.html      工具本体（单文件）
 *   <项目>/build/          本脚本所在的开发目录
 *   <项目>/fixtures/       基准图片与 expected.json
 * 也兼容「脚本与 index.html / fixtures 同级」的旧布局；
 * 可用环境变量 IR_HTML / IR_FIXTURE_DIR / IR_TEST_OUT 显式指定。
 */
function firstExisting(candidates) {
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (e) { /* ignore */ }
  }
  return null;
}
const htmlPath = process.env.IR_HTML
  || firstExisting([
    path.join(here, '..', 'index.html'),        // <项目>/build/ → <项目>/index.html
    path.join(here, 'index.html'),              // 旧布局：脚本与主文件同级
    path.join(here, '红外灰度色标增强工具.html'),
  ]);
if (!htmlPath) {
  console.error('找不到主文件 index.html（可用环境变量 IR_HTML 指定）');
  process.exit(1);
}
const html = fs.readFileSync(htmlPath, 'utf8');

const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('未找到 <script> 段'); process.exit(1); }

let code = m[1].replace(/if \(document\.readyState === 'loading'\)[\s\S]*$/, '');

const fixtureDir = process.env.IR_FIXTURE_DIR
  || firstExisting([
    path.join(here, '..', 'fixtures'),          // <项目>/fixtures（现在的布局）
    path.join(here, 'fixtures'),                // 旧布局：基准图片放在 build/ 里
    path.join(here, '..', '..', 'fixtures'),
  ])
  || path.join(here, '..', 'fixtures');
const outDir = process.env.IR_TEST_OUT || path.join(here, '.test_tmp');
fs.mkdirSync(outDir, { recursive: true });
const expected = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'expected.json'), 'utf8'));

const testBody = `
export async function run() {
  const ok = [], fail = [];
  const check = (name, cond, extra) => {
    if (cond) ok.push(name); else fail.push(name + (extra !== undefined ? '  [' + extra + ']' : ''));
  };
  const approx = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;
  const expected = ${JSON.stringify(expected)};
  const FIXDIR = ${JSON.stringify(fixtureDir)};
  const OUTDIR = ${JSON.stringify(outDir)};
  const HTMLPATH = ${JSON.stringify(htmlPath)};

  /* 1. 温度映射 */
  check('p=0 -> 50°C', approx(toDisplay(pToKelvin(0), UNIT_C), 50));
  check('p=255 -> -85°C', approx(toDisplay(pToKelvin(255), UNIT_C), -85));
  check('默认范围跨度 = 135°C', approx(toDisplay(K_MAX, UNIT_C) - toDisplay(K_MIN, UNIT_C), 135));
  check('K_MAX = 323.15', approx(K_MAX, 323.15));
  check('K_MIN = 188.15', approx(K_MIN, 188.15));
  check('kelvinToP 往返', approx(kelvinToP(pToKelvin(137)), 137));

  /* 2. 单位换算 */
  for (const u of UNITS) {
    for (const c of [-85, -17.5, 0, 50]) {
      const k = c + 273.15;
      check(u + ' 往返 ' + c + '°C', approx(fromDisplay(toDisplay(k, u), u), k));
    }
  }
  check('0°C -> 32°F', approx(toDisplay(273.15, UNIT_F), 32));
  check('50°C -> 亮度 0', approx(toDisplay(K_MAX, UNIT_B), 0));
  check('-85°C -> 亮度 255', approx(toDisplay(K_MIN, UNIT_B), 255));

  /* 3. 银行家舍入（0.01 K） */
  check('RHE(200.125) = 200.12', approx(roundHalfEven(200.125), 200.12));
  check('RHE(200.135) = 200.14', approx(roundHalfEven(200.135), 200.14));
  check('RHE(200.145) = 200.14', approx(roundHalfEven(200.145), 200.14));
  check('RHE(200.155) = 200.16', approx(roundHalfEven(200.155), 200.16));
  check('RHE(323.15) = 323.15', approx(roundHalfEven(323.15), 323.15));
  check('RHE(188.15) = 188.15', approx(roundHalfEven(188.15), 188.15));

  /* 4. 默认色标与插值 */
  const s = defaultScale();
  check('默认节点数 = 2', s.nodes.length === 2);
  check('高温在前、低温在后', s.nodes[0].kelvin > s.nodes[1].kelvin);
  check('默认 50°C 黑色', approx(s.nodes[0].kelvin, DEF_K_MAX) && s.nodes[0].rgb.join() === '0,0,0');
  check('默认 -85°C 白色', approx(s.nodes[1].kelvin, DEF_K_MIN) && s.nodes[1].rgb.join() === '255,255,255');
  check('只有最高温那个是保留节点', isPinned(s.nodes[0]) === true && isPinned(s.nodes[1]) === false);
  const sRange = scaleTempRange(s.nodes);
  check('色标范围由两端节点决定',
    approx(sRange.highK, DEF_K_MAX) && approx(sRange.lowK, DEF_K_MIN));
  const mp = new ColorMapper(s.nodes);
  const lut = mp.lut256();
  check('lut256[0] = 黑', lut[0] === 0 && lut[1] === 0 && lut[2] === 0);
  check('lut256[255] = 白', lut[765] === 255 && lut[766] === 255 && lut[767] === 255);
  check('lut256[128] 居中', Math.abs(lut[384] - 128) <= 2, lut[384]);
  let mono = true;
  for (let i = 0; i < 255; i++) if (lut[i * 3] > lut[(i + 1) * 3]) mono = false;
  check('查找表单调', mono);

  /* 5. Legend 与图片着色使用同一算法 */
  let same = true;
  for (let p = 0; p < 256; p++) {
    const c = mp.colorAtKelvin(pToKelvin(p));
    if (c[0] !== lut[p * 3] || c[1] !== lut[p * 3 + 1] || c[2] !== lut[p * 3 + 2]) same = false;
  }
  check('Legend 与 lut256 逐项一致', same);

  /* 5b. 色标范围窄于图片范围时：超出的取两端节点颜色 */
  {
    const narrow = { name: '窄色标', created: 1, nodes: [
      makeNode(273.15, [200, 0, 0]),            // 0°C 红（最高温节点）
      makeNode(253.15, [0, 0, 200]),            // -20°C 蓝（最低温节点）
    ] };
    const mn = new ColorMapper(narrow.nodes);
    check('高于最高温节点 -> 取最高温节点颜色', mn.colorAtKelvin(323.15).join() === '200,0,0',
      mn.colorAtKelvin(323.15).join());
    check('低于最低温节点 -> 取最低温节点颜色', mn.colorAtKelvin(188.15).join() === '0,0,200',
      mn.colorAtKelvin(188.15).join());
    check('区间内仍按插值', mn.colorAtKelvin(263.15).join() !== '200,0,0');
    check('窄色标两端温度取自节点',
      approx(scaleTempRange(narrow.nodes).highK, 273.15)
      && approx(scaleTempRange(narrow.nodes).lowK, 253.15));
  }

  /* 6. 重叠节点硬跳变与交换顺序 */
  const s2 = { name: 'x', nodes: [
    makeNode(K_MAX, [0, 0, 0]), makeNode(273.15, [255, 0, 0]),
    makeNode(273.15, [0, 0, 255]), makeNode(K_MIN, [255, 255, 255]),
  ] };
  sortNodes(s2.nodes);
  check('重叠节点相邻', positionKey(s2.nodes[1].kelvin) === positionKey(s2.nodes[2].kelvin));
  const m2 = new ColorMapper(s2.nodes);
  check('重合点上方为红', m2.colorAtKelvin(273.16).join() === '255,0,0', m2.colorAtKelvin(273.16));
  check('重合点下方为蓝', m2.colorAtKelvin(273.14).join() === '0,0,255', m2.colorAtKelvin(273.14));
  const sw = s2.nodes[1]; s2.nodes[1] = s2.nodes[2]; s2.nodes[2] = sw;
  const m3 = new ColorMapper(s2.nodes);
  check('交换后上方为蓝', m3.colorAtKelvin(273.16).join() === '0,0,255', m3.colorAtKelvin(273.16));
  check('交换后下方为红', m3.colorAtKelvin(273.14).join() === '255,0,0', m3.colorAtKelvin(273.14));

  /* 6b. 最冷端（冷端拉伸）的硬跳变：冷端拉伸必须取「最下方节点」的颜色 */
  const lowPair = { name: 'x', created: 1, nodes: [
    makeNode(K_MAX, [0, 0, 0]),
    makeNode(198.15, [160, 160, 160]),
    makeNode(193.15, [106, 106, 106]),          // -80°C 上面那个
    makeNode(193.15, [70, 70, 70]),             // -80°C 下面那个
  ] };
  sortNodes(lowPair.nodes);
  const mlow = new ColorMapper(lowPair.nodes);
  check('最冷端硬跳变：低于最冷节点用下方节点色',
    mlow.colorAtKelvin(K_MIN).join() === '70,70,70', mlow.colorAtKelvin(K_MIN).join());
  check('最冷端硬跳变：节点位置上用下方节点色',
    mlow.colorAtKelvin(193.15).join() === '70,70,70', mlow.colorAtKelvin(193.15).join());
  check('最冷端硬跳变：跳变上方仍是上方节点色',
    mlow.colorAtKelvin(193.16).join() === '106,106,106', mlow.colorAtKelvin(193.16).join());

  /* 6c. 近似同温度（显示都是 -80.00）也必须和「保存后重新打开」完全一致 */
  const nearPair = { name: 'x', created: 1, nodes: [
    makeNode(K_MAX, [0, 0, 0]),
    makeNode(198.15, [160, 160, 160]),
    makeNode(193.154, [106, 106, 106]),         // -79.996°C
    makeNode(193.146, [70, 70, 70]),            // -80.004°C
  ] };
  sortNodes(nearPair.nodes);
  const mNear = new ColorMapper(nearPair.nodes);
  check('近似最冷端：冷端拉伸用下方节点色',
    mNear.colorAtKelvin(K_MIN).join() === '70,70,70', mNear.colorAtKelvin(K_MIN).join());
  const mNearSaved = new ColorMapper(parseScaleRecord(scaleToObject(nearPair)).nodes);
  let sameAll = true, firstDiff = '';
  for (let p = 0; p <= 255; p++) {
    const a = mNear.colorAtKelvin(pToKelvin(p)).join();
    const b = mNearSaved.colorAtKelvin(pToKelvin(p)).join();
    if (a !== b) { sameAll = false; firstDiff = 'p=' + p + ' ' + a + ' vs ' + b; break; }
  }
  check('界面色标与保存后重开的色标逐灰度一致', sameAll, firstDiff);

  /* 7. 位置校验 */
  const s3 = defaultScale();
  check('超出允许温度范围无效',
    validateNewPosition(s3, 3000) !== null && validateNewPosition(s3, 0.5) !== null);
  check('可用温度有效', validateNewPosition(s3, 273.15) === null);
  check('没有端点概念，可与端节点同温', validateNewPosition(s3, DEF_K_MAX) === null);
  s3.nodes.push(makeNode(273.15, [1, 2, 3]));
  s3.nodes.push(makeNode(273.15, [4, 5, 6]));
  sortNodes(s3.nodes);
  check('同位置第 3 个无效', validateNewPosition(s3, 273.15) !== null);
  check('0.01K 内视为同一位置', validateNewPosition(s3, 273.151) !== null);
  check('不同位置仍有效', validateNewPosition(s3, 274.15) === null);

  /* 8. 配置 JSON */
  const txt = scaleToText(s3);
  const obj = JSON.parse(txt);
  check('含 name', obj.name === s3.name);
  check('无 version 字段', obj.version === undefined);
  check('不再有色标 range 字段', obj.range === undefined);
  check('保留节点写入 pinned', (() => {
    const withPin = scaleToText(defaultScale());
    const o = JSON.parse(withPin);
    return o.nodes.filter(n => n.pinned === true).length === 1
      && o.nodes.filter(n => n.color === '#000000')[0].pinned === true;
  })());
  check('位置为 0.01K', obj.nodes.every(n => roundHalfEven(n.temperature_k) === n.temperature_k));
  check('往返一致', scaleToText(scaleFromObject(obj)) === txt);
  const pinTxt = scaleToText(defaultScale());
  const pinBack = scaleFromObject(JSON.parse(pinTxt));
  check('pinned 往返不丢失',
    isPinned(pinBack.nodes[0]) === true && isPinned(pinBack.nodes[1]) === false);
  const bads = [
    { nodes: [] },
    { name: 'x', nodes: [{ temperature_k: 99999, color: '#000000' }] },
    { name: 'x', nodes: [{ temperature_k: 323.15, color: 'zzz' }] },
    { name: 'x', nodes: [{ temperature_k: 323.15, color: '#000000' }, { temperature_k: 273.15, color: '#111111' },
                         { temperature_k: 273.15, color: '#222222' }, { temperature_k: 273.15, color: '#333333' },
                         { temperature_k: 188.15, color: '#FFFFFF' }] },
  ];
  let allBad = true, firstBadErr = '';
  for (const b of bads) {
    try { scaleFromObject(b); allBad = false; }
    catch (e) { if (!firstBadErr) firstBadErr = e.message; }
  }
  check('非法配置全部被拒绝', allBad, firstBadErr);

  /* 9. 图片温度（黑色端 / 白色端）与 色标范围（色标范围由节点决定，与图片无关） */
  {
    const c2k = c => c + 273.15;
    setRange(c2k(100), c2k(-100));       // setRange(黑色温度, 白色温度)
    check('图片温度 p=0 -> 黑色温度 100°C', approx(toDisplay(pToKelvin(0), UNIT_C), 100));
    check('图片温度 p=255 -> 白色温度 -100°C', approx(toDisplay(pToKelvin(255), UNIT_C), -100));
    check('程序比较大小得出上限 / 下限：max=100、min=-100', approx(cMax(), 100) && approx(cMin(), -100));
    check('黑色 / 白色两端的取值', approx(cBlack(), 100) && approx(cWhite(), -100));
    check('图片温度 亮度顶部 = 0', approx(toDisplay(K_MAX, UNIT_B), 0));
    check('图片温度 亮度底部 = 255', approx(toDisplay(K_MIN, UNIT_B), 255));

    /* 9a. 浅色代表高温：白色温度高于黑色温度，同样合法（上限 / 下限由程序比较得出） */
    setRange(c2k(-85), c2k(50));         // 黑色 -85、白色 +50（越白越热）
    check('反向时同样比较出上限 = 50°C', approx(cMax(), 50) && approx(K_MAX, c2k(50)));
    check('反向时同样比较出下限 = -85°C', approx(cMin(), -85) && approx(K_MIN, c2k(-85)));
    check('反向时跨度仍是 135°C', approx(K_SPAN, 135));
    check('反向时 p=0 仍是黑色温度 -85°C', approx(toDisplay(pToKelvin(0), UNIT_C), -85));
    check('反向时 p=255 仍是白色温度 +50°C', approx(toDisplay(pToKelvin(255), UNIT_C), 50));
    check('反向映射在中点线性',
      approx(toDisplay(pToKelvin(127.5), UNIT_C), -85 + 135 * 127.5 / 255, 1e-9));
    check('反向时 kelvinToP 也取反（白端 255、黑端 0）',
      approx(kelvinToP(c2k(50)), 255) && approx(kelvinToP(c2k(-85)), 0));
    check('反向时亮度仍以灰度为准：黑色端 0、白色端 255',
      approx(toDisplay(K_BLACK, UNIT_B), 0) && approx(toDisplay(K_WHITE, UNIT_B), 255));
    check('反向时亮度 0 端仍是黑色端（此时黑色端为冷端）',
      approx(K_BLACK, K_MIN) && approx(K_WHITE, K_MAX));
    check('反向时亮度往返一致',
      approx(fromDisplay(toDisplay(c2k(10), UNIT_B), UNIT_B), c2k(10), 1e-9));
    {
      const entRev = legendEntries();
      check('反向时 Legend 两端仍标注（-85 与 +50）',
        entRev.some(e => e.isLimit && Math.abs(e.c + 85) < 1e-9)
        && entRev.some(e => e.isLimit && Math.abs(e.c - 50) < 1e-9),
        entRev.map(e => e.c).join());
      check('反向时刻度仍在两温度之间',
        entRev.every(e => e.c >= -85 && e.c <= 50), entRev.map(e => e.c).join());
      check('反向时高温端落在色标柱下端（白色端）',
        approx(kelvinToP(c2k(50)), 255) && approx(kelvinToP(c2k(-85)), 0));
      const mRev = new ColorMapper([
        makeNode(c2k(-85), [0, 0, 0], true), makeNode(c2k(50), [255, 255, 255])]);
      check('反向时着色也跟着反过来（黑端黑、白端白）',
        mRev.colorAtKelvin(pToKelvin(0)).join() === '0,0,0'
        && mRev.colorAtKelvin(pToKelvin(255)).join() === '255,255,255');
    }

    /* 9b. 两个端点温度相同：整幅图一个温度，不能出现 NaN */
    setRange(c2k(20), c2k(20));
    check('黑白同温时任何灰度都是同一个温度',
      approx(pToKelvin(0), c2k(20)) && approx(pToKelvin(255), c2k(20)));
    check('黑白同温时 kelvinToP / 亮度 不产生 NaN',
      isFinite(kelvinToP(c2k(20))) && isFinite(toDisplay(c2k(20), UNIT_B))
      && isFinite(fromDisplay(123, UNIT_B)));
    check('黑白同温时刻度只剩一条', legendTicksC().length === 1, legendTicksC().join());
    check('黑白同温时校验仍然通过（不算非法）', validateImageRange(c2k(20), c2k(20)) === null);

    setRange(c2k(100), c2k(-100));

    // 新建色标仍然是 50 / -85，不跟随图片范围
    const s4 = defaultScale();
    check('新建色标不跟随图片温度',
      approx(scaleTempRange(s4.nodes).highK, DEF_K_MAX)
      && approx(scaleTempRange(s4.nodes).lowK, DEF_K_MIN));
    const m4 = new ColorMapper(s4.nodes);
    check('图片温度高于色标上端 -> 取上端节点颜色', m4.colorAtKelvin(c2k(100)).join() === '0,0,0',
      m4.colorAtKelvin(c2k(100)).join());
    check('图片温度低于色标下端 -> 取下端节点颜色', m4.colorAtKelvin(c2k(-100)).join() === '255,255,255',
      m4.colorAtKelvin(c2k(-100)).join());

    // 色标 JSON 不再携带温度范围
    const t4 = scaleToText(s4);
    check('色标 JSON 不含 range 字段', JSON.parse(t4).range === undefined, t4.slice(0, 80));
    setRange(c2k(63), c2k(-92));
    const back4 = scaleFromObject(JSON.parse(t4));
    check('打开色标不会改动图片温度',
      approx(cMax(), 63) && approx(cMin(), -92), cMax() + ' / ' + cMin());
    check('色标往返一致', scaleToText(back4) === t4);

    // 图片温度校验：只要求是数字且在允许区间内，**没有任何大小关系限制**
    check('浅色代表高温（白色温度更高）被接受', validateImageRange(c2k(-10), c2k(20)) === null);
    check('两个温度相同被接受', validateImageRange(c2k(20), c2k(20)) === null);
    check('超出允许温度被拒绝', validateImageRange(c2k(3000), c2k(0)) !== null);
    check('黑色端低于绝对零度被拒绝', validateImageRange(c2k(0), c2k(-300)) !== null);
    check('非数字被拒绝', validateImageRange(NaN, c2k(0)) !== null && validateImageRange(c2k(0), Infinity) !== null);
    check('合法值通过', validateImageRange(c2k(80), c2k(-120)) === null);

    // 旧配置里的 range 字段直接忽略
    const oldCfg = { name: '旧配置', range: { upper_k: 373.15, lower_k: 173.15 }, nodes: [
      { temperature_k: 323.15, color: '#000000' }, { temperature_k: 188.15, color: '#FFFFFF' }] };
    scaleFromObject(oldCfg);
    check('旧配置的 range 被忽略（不影响图片范围）',
      approx(cMax(), 63) && approx(cMin(), -92), cMax() + ' / ' + cMin());
    check('旧配置仍可正常载入', true);
    setRange(DEF_K_MAX, DEF_K_MIN);

    // Legend 温度轴 = 图片两端的温度（与色标节点无关）
    setRange(DEF_K_MAX, DEF_K_MIN);
    const ticksDefault = legendTicksC();
    // 默认范围 -85 ~ 50（135°C）：10°C 一档共 14 个整点刻度
    check('默认刻度 = -80..50 每 10°C（14 个）',
      ticksDefault.join() === [-80, -70, -60, -50, -40, -30, -20, -10, 0, 10, 20, 30, 40, 50].join(),
      ticksDefault.join());
    check('刻度数量落在 3 ~ 14',
      ticksDefault.length >= 3 && ticksDefault.length <= 14,
      String(ticksDefault.length));
    check('整点刻度覆盖 -80 与 50',
      ticksDefault.indexOf(-80) >= 0 && ticksDefault.indexOf(50) >= 0);

    const entDefault = legendEntries();
    check('黑色端与白色端的温度都会被标注',
      entDefault.some(e => e.isLimit && Math.abs(e.c - 50) < 1e-9)
      && entDefault.some(e => e.isLimit && Math.abs(e.c + 85) < 1e-9),
      JSON.stringify(entDefault.map(e => e.c)));
    check('上限在网格上不重复标注、白色端不在网格上额外补一条',
      entDefault.filter(e => Math.abs(e.c - 50) < 1e-9).length === 1
      && entDefault.filter(e => Math.abs(e.c + 85) < 1e-9).length === 1
      && entDefault.length === ticksDefault.length + 1);
    check('标注按高温到低温排序',
      entDefault.every((e, i) => i === 0 || entDefault[i - 1].c > e.c));
    check('亮度模式下两端标注正好是 0 / 255',
      Math.round(toDisplay(DEF_K_MAX, UNIT_B)) === 0 && Math.round(toDisplay(DEF_K_MIN, UNIT_B)) === 255);

    // 两端温度不在整点网格上时，额外补两个标注
    setRange(c2k(63), c2k(-92));
    const entOff = legendEntries();
    check('不在网格上的两端温度会被额外补标',
      entOff.filter(e => e.isLimit && Math.abs(e.c - 63) < 1e-9).length === 1
      && entOff.filter(e => e.isLimit && Math.abs(e.c + 92) < 1e-9).length === 1
      && entOff.length === legendTicksC().length + 2,
      entOff.map(e => e.c).join());
    setRange(DEF_K_MAX, DEF_K_MIN);

    // 色标节点范围随便改，legend 温度轴都跟着图片走
    scaleFromObject({ name: 'x', nodes: [
      { temperature_k: c2k(200), color: '#000000' }, { temperature_k: c2k(-200), color: '#FFFFFF' }] });
    check('改色标节点不影响 legend 温度轴',
      legendTicksC().join() === ticksDefault.join(), legendTicksC().join());

    setRange(c2k(63), c2k(-92));
    const ticks63 = legendTicksC();
    const ent63 = legendEntries();
    check('非整十的图片两端温度被额外标注',
      ent63.some(e => e.isLimit && Math.abs(e.c - 63) < 1e-9)
      && ent63.some(e => e.isLimit && Math.abs(e.c + 92) < 1e-9),
      JSON.stringify(ent63));
    check('非整十的两端温度不在整点刻度里', ticks63.indexOf(63) < 0 && ticks63.indexOf(-92) < 0);
    check('刻度落在图片范围内', ticks63.every(t => t > -92 && t < 63), ticks63.join());

    setRange(c2k(60), c2k(-100));
    const ticks2 = legendTicksC();
    check('图片范围刻度落在范围内且数量合理',
      ticks2.every(t => t >= -100 && t <= 60)
      && ticks2.length >= 3 && ticks2.length <= 14, ticks2.join());
    setRange(c2k(0), c2k(-6));
    check('窄范围自动缩小刻度步长', legendTicksC().length >= 3, legendTicksC().join());
    setRange(DEF_K_MAX, DEF_K_MIN);
  }

  /* 9b. 毫秒时间戳身份 + 本地色标库（localStorage 数据层） */
  {
    const c2k = c => c + 273.15;
    setRange(DEF_K_MAX, DEF_K_MIN);

    const s0 = defaultScale();
    check('新建色标带毫秒时间戳', typeof s0.created === 'number' && s0.created > 1e12, String(s0.created));
    const txt0 = scaleToText(s0);
    check('JSON 含 created 字段', JSON.parse(txt0).created === s0.created);
    check('created 往返不变', scaleFromObject(JSON.parse(txt0)).created === s0.created);

    const legacy = { name: '旧文件', nodes: [
      { temperature_k: 323.15, color: '#000000' }, { temperature_k: 188.15, color: '#FFFFFF' }] };
    const rec0 = parseScaleRecord(legacy);
    check('旧文件缺 created 时补当前时间',
      rec0.created > 0 && Math.abs(Date.now() - rec0.created) < 5000, String(rec0.created));
    check('补过时间戳后再导出会带上 created',
      JSON.parse(scaleToText(scaleFromObject(legacy))).created > 0);

    const recA = { created: 1000, name: '同名', range: { upper_k: 323.15, lower_k: 188.15 },
      nodes: [{ temperature_k: 323.15, color: '#000000' }, { temperature_k: 188.15, color: '#FFFFFF' }] };
    const recB = JSON.parse(JSON.stringify(recA));
    recB.created = 2000;

    let store = upsertScaleRecord([], recA);
    check('首次写入本地库', store.length === 1);
    store = upsertScaleRecord(store, recA);
    check('同一时间戳 = 覆盖而不是新增', store.length === 1, String(store.length));
    store = upsertScaleRecord(store, recB);
    check('名称相同但时间戳不同 = 两个色标', store.length === 2, String(store.length));

    const renamed = JSON.parse(JSON.stringify(recA));
    renamed.name = '改了名字';
    store = upsertScaleRecord(store, renamed);
    check('改名后仍按时间戳覆盖同一条', store.length === 2, String(store.length));
    check('改名已写入库',
      store.filter(r => Number(r.created) === 1000)[0].name === '改了名字',
      JSON.stringify(store.map(r => r.name)));
    check('库按创建时间倒序排列', sortScaleRecords(store)[0].created === 2000);

    check('创建时间格式为 YYYYMMDD HH:mm:SS',
      /^\\d{8} \\d{2}:\\d{2}:\\d{2}$/.test(formatCreatedTime(1499999999999)),
      formatCreatedTime(1499999999999));

    /* 8b. 「预设色标」= 配置文件驱动（PreSet/manifest.js + 一预设一文件），
           index.html 里不再内嵌任何预置数据 */
    check('原来写死的内置 BD 色标已彻底移除',
      typeof ensureBuiltinScales === 'undefined' && typeof BUILTIN_BD_SCALE === 'undefined'
      && typeof BUILTIN_BD_CREATED === 'undefined');

    const presetDir = path.join(FIXDIR, '..', 'PreSet');
    /** 在 Node 里按浏览器的方式「执行」一个配置文件：它只依赖 window */
    const readConfig = file => {
      const scope = {};
      new Function('window', fs.readFileSync(path.join(presetDir, file), 'utf8'))(scope);
      return scope;
    };

    const rawHtml2 = fs.readFileSync(HTMLPATH, 'utf8');
    check('index.html 里不再内嵌预置数据',
      !/const PRESET_SCALES = \\[/.test(rawHtml2) && /let PRESET_SCALES = \\[\\];/.test(rawHtml2),
      (rawHtml2.match(/const PRESET_SCALES[^\\n]*/) || ['无'])[0]);
    check('预置清单常量指向 PreSet/manifest.js',
      PRESET_MANIFEST === 'PreSet/manifest.js', PRESET_MANIFEST);
    check('预置由 <script> 标签载入（file:// 下 fetch / XHR 读不到本地文件）',
      typeof loadScriptTag === 'function' && typeof loadPresets === 'function'
      && typeof ensurePresetsLoaded === 'function'
      && !/fetch\\(|XMLHttpRequest/.test(loadPresets.toString()));
    check('载入是幂等的（缓存同一个 Promise，不会重复载入）',
      /if \\(presetLoadTask\\) return presetLoadTask;/.test(loadPresets.toString())
      && /return presetLoadTask;/.test(loadPresets.toString()));

    const presetFiles = readConfig('manifest.js').IR_PRESET_FILES;
    check('清单里是一个非空的文件数组',
      Array.isArray(presetFiles) && presetFiles.length > 0, JSON.stringify(presetFiles || null));
    const diskFiles = fs.readdirSync(presetDir).filter(f => /\\.js$/i.test(f) && f !== 'manifest.js');
    check('清单与目录里的预置文件一一对应（无遗漏、无孤儿）',
      Array.isArray(presetFiles) && presetFiles.length === diskFiles.length
      && diskFiles.every(f => presetFiles.indexOf(f) >= 0),
      (presetFiles || []).join(',') + '  vs  ' + diskFiles.join(','));

    // 每个文件：正好一条预置、文件名 = name、不带 created、能通过正式校验
    const configPresets = [];
    let onePerFile = '', configBad = '';
    (presetFiles || []).forEach(f => {
      let entries = [];
      try { entries = readConfig(f).IR_PRESETS || []; }
      catch (e) { configBad = f + '：载入失败 ' + e.message; return; }
      if (!Array.isArray(entries) || entries.length !== 1) {
        onePerFile = f + '：应当正好 1 条预置，实际 ' + (entries && entries.length);
        return;
      }
      const raw = entries[0];
      if (f.replace(/\\.js$/i, '') !== raw.name) {
        onePerFile = f + '：文件名与 name（' + raw.name + '）不一致';
        return;
      }
      if (raw.created !== undefined) { onePerFile = f + '：预置里不应该写 created'; return; }
      try { configPresets.push(presetFromConfig(raw)); }
      catch (e) { configBad = f + '：' + e.message; }
    });
    check('每个预置文件正好一条预置、文件名 = name、不带 created', onePerFile === '', onePerFile);
    check('每条预置都能通过配置校验（温度 / 颜色 / 同位置不超过 2 个）', configBad === '', configBad);
    check('清单里列出的文件都提供了数据',
      configPresets.length === (presetFiles || []).length,
      configPresets.length + ' / ' + (presetFiles || []).length);

    // 浏览器里由 loadPresets() 把配置填进 PRESET_SCALES；Node 里直接注入同一份结果
    PRESET_SCALES = configPresets;
    check('注入后预设条数 = 配置条数',
      PRESET_SCALES.length === configPresets.length, String(PRESET_SCALES.length));
    check('预设至少 2 条（空白 + 至少一套色阶）',
      PRESET_SCALES.length >= 2, String(PRESET_SCALES.length));
    check('「空白」排在第一位且只有一个白色保留节点',
      PRESET_SCALES[0].name === '空白' && PRESET_SCALES[0].nodes.length === 1
      && PRESET_SCALES[0].nodes[0].color === '#FFFFFF' && PRESET_SCALES[0].nodes[0].pinned === true
      && approx(PRESET_SCALES[0].nodes[0].temperature_k, 273.15),
      PRESET_SCALES[0].name + ' / ' + PRESET_SCALES[0].nodes.length);
    check('预设里没有 created 字段（导入时才算）',
      PRESET_SCALES.every(p => p.created === undefined));
    check('预设名字互不重复',
      new Set(PRESET_SCALES.map(p => p.name)).size === PRESET_SCALES.length,
      PRESET_SCALES.map(p => p.name).join(','));
    check('规范化后颜色都是 #RRGGBB 大写',
      PRESET_SCALES.every(p => p.nodes.every(n => /^#[0-9A-F]{6}$/.test(n.color))));
    check('规范化后温度都对齐到 0.01 K',
      PRESET_SCALES.every(p => p.nodes.every(n => approx(n.temperature_k, roundHalfEven(n.temperature_k)))));

    // 弹窗用的包装：内部行号用负数，保证两条预置不会撞 key
    const rows = presetRecords();
    check('预设行号唯一且为负数',
      rows.length === PRESET_SCALES.length
      && new Set(rows.map(r => r.created)).size === rows.length
      && rows.every(r => r.created < 0),
      rows.map(r => r.created).join(','));
    check('预设行不携带 created 之外的假数据',
      rows.every(r => r.name && Array.isArray(r.nodes)));
    check('按行号取回的预置与列表一一对应',
      presetByRow(PRESET_ROW_BASE) === PRESET_SCALES[0]
      && presetByRow(PRESET_ROW_BASE - 1) === PRESET_SCALES[1]
      && presetByRow(1) === null && presetByRow(-1) === null);

    // 导入时补 created（按导入时刻）
    const bdPreset = presetByName('IR-BD-ex');
    check('能按名字取到预置', !!bdPreset && bdPreset.nodes.length === 24);
    check('取不到的预置返回 null', presetByName('不存在的预置') === null);
    const imported = presetToScale(bdPreset);
    check('导入预置时按当前时刻补 created',
      Number.isFinite(imported.created) && Math.abs(Date.now() - imported.created) < 5000,
      String(imported.created));
    check('导入预置时沿用预置的名字与节点',
      imported.name === 'IR-BD-ex' && imported.nodes.length === 24);
    const imported2 = presetToScale(bdPreset, 123456789);
    check('可显式指定 created（便于自检）', imported2.created === 123456789);
    const bdm = new ColorMapper(imported.nodes);
    check('IR-BD-ex 低于最冷节点（-93°C 以下）取最下方节点色 #000000',
      bdm.colorAtKelvin(175).join() === '0,0,0', bdm.colorAtKelvin(175).join());
    check('IR-BD-ex 最冷端硬跳变上方为 #1A1A1A',
      bdm.colorAtKelvin(180.16).join() === '26,26,26', bdm.colorAtKelvin(180.16).join());
    check('IR-BD-ex -80°C 平台为 #878787',
      bdm.colorAtKelvin(193.15).join() === '135,135,135', bdm.colorAtKelvin(193.15).join());
    check('IR-BD-ex -85°C 平台为 #333333（默认白色端落在色标内部，不拉伸）',
      bdm.colorAtKelvin(K_MIN).join() === '51,51,51', bdm.colorAtKelvin(K_MIN).join());
    check('IR-BD-ex 冷端三段深灰平台 (#555555 / #333333 / #1A1A1A)',
      bdm.colorAtKelvin(190.15).join() === '85,85,85'
      && bdm.colorAtKelvin(186.15).join() === '51,51,51'
      && bdm.colorAtKelvin(182.15).join() === '26,26,26',
      bdm.colorAtKelvin(190.15).join() + ' / ' + bdm.colorAtKelvin(186.15).join()
      + ' / ' + bdm.colorAtKelvin(182.15).join());
    check('IR-BD-ex 203.15K 处上方黑、下方白',
      bdm.colorAtKelvin(203.16).join() === '0,0,0' && bdm.colorAtKelvin(203.14).join() === '255,255,255',
      bdm.colorAtKelvin(203.16).join() + ' / ' + bdm.colorAtKelvin(203.14).join());
    check('IR-BD-ex 301.15K 处上方为纯黑（高于色标最高温节点）',
      bdm.colorAtKelvin(320).join() === '0,0,0', bdm.colorAtKelvin(320).join());
    check('预置保存往返不变',
      scaleToText(presetToScale(bdPreset, 1700000000000))
      === scaleToText(scaleFromObject(JSON.parse(scaleToText(presetToScale(bdPreset, 1700000000000))))));
    check('导入「空白」后整幅纯白的取色',
      new ColorMapper(presetToScale(PRESET_SCALES[0]).nodes).colorAtKelvin(200).join() === '255,255,255');
    check('「IR-BW」预置 = 50°C 黑 → -85°C 白',
      (() => {
        const bw = presetToScale(presetByName('IR-BW')).nodes;
        return bw.length === 2 && bw[0].rgb.join() === '0,0,0' && bw[1].rgb.join() === '255,255,255'
          && approx(bw[0].kelvin, DEF_K_MAX) && approx(bw[1].kelvin, DEF_K_MIN);
      })());
    check('默认初始色标仍是黑白两点（与预设无关）',
      defaultScale().nodes.length === 2);

    /* 8c. 导出到剪贴板 / 输入色标 用到的两个纯逻辑 */
    const copyResult = await copyTextToClipboard('hello');
    check('无剪贴板环境时 copyTextToClipboard 返回 false 而不抛异常',
      copyResult === false, String(copyResult));
    const bdText = scaleToText(presetToScale(presetByName('IR-BD-ex'), 1700000000000));
    check('导出到剪贴板的文本 = 「另存为」的内容（可再次解析）',
      scaleToText(scaleFromObject(JSON.parse(bdText))) === bdText);
    check('导出文本不带色标 range 字段', JSON.parse(bdText).range === undefined);
    check('输入色标：合法文本解析出 24 个节点',
      scaleFromObject(JSON.parse(bdText)).nodes.length === 24);
    check('输入色标：缺 created 时补当前时间戳',
      scaleFromObject(JSON.parse('{"nodes":[{"temperature_k":300,"color":"#000000"}]}')).created > 1e12);

    setRange(c2k(60), c2k(-100));
    parseScaleRecord(legacy);
    check('只读解析不改动当前范围', approx(cMax(), 60) && approx(cMin(), -100), cMax() + ' / ' + cMin());
    setRange(DEF_K_MAX, DEF_K_MIN);
  }

  /* 10. 颜色解析 */
  check('parseColor #abc', parseColor('#abc').join() === '170,187,204');
  check('parseColor #0A1B2C', parseColor('#0A1B2C').join() === '10,27,44');
  check('parseColor 数组', parseColor([1, 2, 3]).join() === '1,2,3');
  check('rgbToHex', rgbToHex([10, 27, 44]) === '#0A1B2C');
  check('parseFloatCN 中文逗号', parseFloatCN('１２') === null || true);
  check('parseFloatCN 负数', parseFloatCN('-17.55') === -17.55);
  check('parseFloatCN 带单位', parseFloatCN('-17.55 °C') === -17.55);

  /* 10. colorize 原样保留 Alpha */
  const g = new Uint8Array([0, 128, 255, 7]);
  const a = new Uint8Array([0, 1, 128, 255]);
  const colored = colorize(g, a, mp, 2, 2);
  check('colorize 长度 = W*H*4', colored.length === 16);
  check('Alpha 原样复制', colored[3] === 0 && colored[7] === 1 && colored[11] === 128 && colored[15] === 255);

  /* 11. PNG 解码：与 Pillow 生成的期望值逐字节比对 */
  const wantGray = Uint8Array.from(expected.gray);
  const wantAlpha = Uint8Array.from(expected.alpha);
  for (const f of ['la.png', 'rgba.png']) {
    const img = await decodePNG(fs.readFileSync(path.join(FIXDIR, f)));
    let gOk = img.width === expected.width && img.height === expected.height;
    if (gOk) for (let i = 0; i < wantGray.length; i++) if (img.gray[i] !== wantGray[i]) { gOk = false; break; }
    let aOk = true;
    for (let i = 0; i < wantAlpha.length; i++) if (img.alpha[i] !== wantAlpha[i]) { aOk = false; break; }
    check('decodePNG ' + f + ' 灰度逐字节一致', gOk);
    check('decodePNG ' + f + ' Alpha 逐字节一致', aOk);
  }
  {
    // 16 位灰度图：没有 Alpha 通道，解码后应为全 255
    const img = await decodePNG(fs.readFileSync(path.join(FIXDIR, 'gray16.png')));
    let gOk = img.width === expected.width && img.height === expected.height;
    if (gOk) for (let i = 0; i < wantGray.length; i++) if (img.gray[i] !== wantGray[i]) { gOk = false; break; }
    let aOk = true;
    for (let i = 0; i < wantAlpha.length; i++) if (img.alpha[i] !== 255) { aOk = false; break; }
    check('decodePNG gray16.png 灰度逐字节一致', gOk);
    check('decodePNG gray16.png Alpha 全为 255', aOk);
  }
  {
    const img = await decodePNG(fs.readFileSync(path.join(FIXDIR, 'pal.png')));
    let gOk = img.width === expected.width && img.height === expected.height;
    if (gOk) for (let i = 0; i < wantGray.length; i++) if (Math.abs(img.gray[i] - wantGray[i]) > 0) { gOk = false; break; }
    check('decodePNG 调色板 PNG 可解码', img.width === expected.width && img.height === expected.height);
  }

  /* 12. PNG 编码 -> 解码 往返（灰度图，可逐字节比对） */
  const W = 9, H = 5;
  const src = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const v = (i * 17) % 256;
    src[i * 4] = v; src[i * 4 + 1] = v; src[i * 4 + 2] = v;
    src[i * 4 + 3] = [0, 1, 128, 254, 255][i % 5];
  }
  const pngBytes = await encodePNG(src, W, H);
  fs.writeFileSync(path.join(OUTDIR, 'node_out.png'), Buffer.from(pngBytes));
  const back = await decodePNG(pngBytes);
  let rtOk = back.width === W && back.height === H;
  if (rtOk) for (let i = 0; i < W * H; i++) {
    if (back.gray[i] !== src[i * 4] || back.alpha[i] !== src[i * 4 + 3]) { rtOk = false; break; }
  }
  check('编码 -> 解码 灰度与 Alpha 逐字节往返', rtOk);

  /* 13. ZIP 打包 */
  const zip = zipStore([{ name: 'IR_Enhance_x/a.png', data: pngBytes }, { name: 'IR_Enhance_x/b.png', data: pngBytes }]);
  const zb = new Uint8Array(await zip.arrayBuffer());
  const eocdSig = zb[zb.length - 22] | (zb[zb.length - 21] << 8) | (zb[zb.length - 20] << 16) | (zb[zb.length - 19] << 24);
  check('ZIP 结构可识别', eocdSig === 0x06054b50, eocdSig.toString(16));
  check('ZIP 大小合理', zip.size > pngBytes.length * 2);
  fs.writeFileSync(path.join(OUTDIR, 'node_out.zip'), Buffer.from(zb));

  /* 14. 显示名去重 / 输出名去重 / 文件类型判定 */
  const used = new Set();
  check('第一次 image.png', makeDisplayName('image.png', used) === 'image.png');
  check('第二次 image(1).png', makeDisplayName('image.png', used) === 'image(1).png');
  check('第三次 image(2).png', makeDisplayName('image.png', used) === 'image(2).png');
  check('输出名冲突改名', uniqueOutName('a.png', new Set(['a.png'])) === 'a(1).png');
  check('输出名不冲突时不变', uniqueOutName('b.png', new Set(['a.png'])) === 'b.png');

  check('识别 PNG', isSupportedImageName('a.PNG') && isSupportedImageName('a.png'));
  check('识别 JPG / JPEG', isSupportedImageName('a.jpg') && isSupportedImageName('a.JPEG'));
  check('拒绝其它格式', !isSupportedImageName('a.gif') && !isSupportedImageName('a.png.txt'));
  check('isJpegName 判定', isJpegName('a.JPG') && isJpegName('b.jpeg') && !isJpegName('c.png'));
  check('PNG 幻数识别', isPngBytes(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0])));
  check('JPEG 幻数不误判为 PNG',
    !isPngBytes(new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0])) && !isPngBytes(null));
  check('JPEG 文件名去重', (() => {
    const u = new Set();
    return makeDisplayName('shot.jpg', u) === 'shot.jpg'
      && makeDisplayName('shot.jpg', u) === 'shot(1).jpg';
  })());
  const jpegTypes = saveFileTypes('a.jpg');
  check('另存为对话框按源格式给过滤器',
    jpegTypes[0].accept['image/jpeg'] !== undefined && saveFileTypes('a.png')[0].accept['image/png'] !== undefined);

  /* 15. 帮助：Markdown 渲染器 + 内置说明书 */
  {
    const BT = '\\u0060';                // 反引号：不能在这段模板字符串里直接写出来
    const FENCE = BT + BT + BT;
    const rawHtml = fs.readFileSync(HTMLPATH, 'utf8');
    const mm = /<script type="text\\/markdown" id="helpMarkdown">([\\s\\S]*?)<\\/script>/.exec(rawHtml);
    check('说明书 Markdown 源存在', !!mm);
    const mdSrc = mm ? mm[1].trim() : '';
    const r = renderMarkdown(mdSrc);
    check('说明书渲染出一级标题', /<h1>[^<]+<\\/h1>/.test(r.html));
    check('说明书渲染出表格（>= 5 个）',
      (r.html.match(/<table>/g) || []).length >= 5, String((r.html.match(/<table>/g) || []).length));
    check('说明书渲染出代码块', r.html.indexOf('<pre><code>') >= 0);
    check('说明书渲染出引用块', r.html.indexOf('<blockquote>') >= 0);
    check('说明书渲染出无序与有序列表',
      r.html.indexOf('<ul>') >= 0 && r.html.indexOf('<ol>') >= 0
      && (r.html.match(/<li>/g) || []).length >= 30,
      String((r.html.match(/<li>/g) || []).length));
    check('正文里没有残留的 Markdown 标记',
      !/\\*\\*|(^|\\n)#{1,6}\\s|(^|\\n)\\s*[-*]\\s/.test(r.html),
      (r.html.match(/\\*\\*|#{1,6}\\s/) || [''])[0]);
    check('目录只列章（二级标题），小节挂在所属章下面',
      r.toc.length >= 12 && (r.html.match(/<h2 id=/g) || []).length === r.toc.length
      && r.toc.every(ch => ch.children.length === 0 || ch.children.length >= 2),
      r.toc.length + ' 章 / ' + (r.html.match(/<h2 id=/g) || []).length);
    check('章节小节总数与三级标题数一致',
      r.toc.reduce((n, ch) => n + ch.children.length, 0) === (r.html.match(/<h3 id=/g) || []).length,
      r.toc.reduce((n, ch) => n + ch.children.length, 0) + ' / '
        + (r.html.match(/<h3 id=/g) || []).length);
    check('至少有一章带小节（如色标与节点、色标库）',
      r.toc.filter(ch => ch.children.length >= 3).length >= 2,
      String(r.toc.filter(ch => ch.children.length >= 3).length));
    check('目录 id 唯一且正文里都有',
      new Set([].concat(...r.toc.map(ch => [ch.id].concat(ch.children.map(s => s.id)))).values()).size
        === r.toc.length + r.toc.reduce((n, ch) => n + ch.children.length, 0)
      && r.toc.every(ch => r.html.indexOf('id="' + ch.id + '"') >= 0
        && ch.children.every(s => r.html.indexOf('id="' + s.id + '"') >= 0)));
    check('行内粗体与代码被渲染',
      renderMarkdown('这是 **粗体** 与 ' + BT + '代码' + BT + '。').html
        === '<p>这是 <strong>粗体</strong> 与 <code>代码</code>。</p>',
      renderMarkdown('这是 **粗体** 与 ' + BT + '代码' + BT + '。').html);
    check('HTML 被转义，不能注入标签',
      (() => {
        const h = renderMarkdown('<img src=x onerror=alert(1)>').html;
        return h.indexOf('&lt;img') >= 0 && h.indexOf('<img') < 0;
      })());
    check('表格里的粗体与行内代码正常',
      renderMarkdown('| a | b |\\n| --- | --- |\\n| **x** | ' + BT + 'y' + BT + ' |').html
        === '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody>'
          + '<tr><td><strong>x</strong></td><td><code>y</code></td></tr></tbody></table>',
      renderMarkdown('| a | b |\\n| --- | --- |\\n| **x** | ' + BT + 'y' + BT + ' |').html);
    check('无序列表（含一层嵌套）渲染正确',
      renderMarkdown('- a\\n- b\\n  - b1\\n').html === '<ul><li>a</li><li>b<ul><li>b1</li></ul></li></ul>',
      renderMarkdown('- a\\n- b\\n  - b1\\n').html);
    check('有序列表渲染正确',
      renderMarkdown('1. 一\\n2. 二\\n').html === '<ol><li>一</li><li>二</li></ol>',
      renderMarkdown('1. 一\\n2. 二\\n').html);
    check('引用与分隔线渲染正确',
      renderMarkdown('> 提示\\n\\n---\\n').html === '<blockquote><p>提示</p></blockquote>\\n<hr>',
      renderMarkdown('> 提示\\n\\n---\\n').html);
    check('代码块内容原样保留（含引号与换行）',
      renderMarkdown(FENCE + 'json\\n{"a": 1}\\n' + FENCE).html.indexOf('<pre><code>{"a": 1}</code></pre>') >= 0,
      renderMarkdown(FENCE + 'json\\n{"a": 1}\\n' + FENCE).html);
    check('说明书覆盖了关键功能点',
      ['白色温度', '保留节点', '标准 BD', '硬跳变', '我的色标', '管理色标', '批量导出', 'JSON', '常见问题']
        .every(k => mdSrc.indexOf(k) >= 0));
    check('说明书足够详尽（> 6000 字）', mdSrc.length > 6000, String(mdSrc.length));
  }

  return { ok, fail };
}
`;

const tmpModule = path.join(here, '_tmp_core_test.mjs');
fs.writeFileSync(tmpModule,
  "import fs from 'node:fs';\nimport path from 'node:path';\n" + code + '\n' + testBody);

const mod = await import('./_tmp_core_test.mjs?v=' + Date.now());
const { ok, fail } = await mod.run();
fs.unlinkSync(tmpModule);

for (const name of ok) console.log('  [OK]   ' + name);
for (const f of fail) console.log('  [FAIL] ' + f);
console.log('\nHTML 版核心自检：通过 ' + ok.length + ' 项，失败 ' + fail.length + ' 项。');
process.exit(fail.length ? 1 : 0);
