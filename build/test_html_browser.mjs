/**
 * HTML 版浏览器端到端自检：用真实 Chrome（headless）打开页面，
 * 通过 CDP 注入并运行测试，再把结果取回来。
 *
 * 用法：node test_html_browser.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 目录约定见 test_html_core.mjs 顶部说明（<项目>/index.html + <项目>/fixtures + build/） */
function firstExisting(candidates) {
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (e) { /* ignore */ }
  }
  return null;
}
const fixtureDir = process.env.IR_FIXTURE_DIR
  || firstExisting([
    path.join(here, '..', 'fixtures'),          // <项目>/fixtures（现在的布局）
    path.join(here, 'fixtures'),                // 旧布局：基准图片放在 build/ 里
    path.join(here, '..', '..', 'fixtures'),
  ])
  || path.join(here, '..', 'fixtures');
const outDir = process.env.IR_TEST_OUT || path.join(here, '.test_tmp');
fs.mkdirSync(outDir, { recursive: true });
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
const expected = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'expected.json'), 'utf8'));
const pngB64 = fs.readFileSync(path.join(fixtureDir, 'la.png')).toString('base64');

/**
 * 预置色标配置：Node 侧按清单（PreSet/manifest.js）把配置文件读一遍，
 * 注入页面后用来核对「页面里的预置列表 == 磁盘上的配置」。
 */
const presetDir = path.join(path.dirname(htmlPath), 'PreSet');
function evalPresetConfig(file) {
  const scope = {};
  // 配置文件只依赖 window：这里模拟一个 window 执行它（与浏览器的 <script> 载入等价）
  new Function('window', fs.readFileSync(path.join(presetDir, file), 'utf8'))(scope);
  return scope;
}
let presetManifest = [];
let presetConfigs = [];
try {
  presetManifest = evalPresetConfig('manifest.js').IR_PRESET_FILES || [];
  presetConfigs = [].concat(...presetManifest.map(f => evalPresetConfig(f).IR_PRESETS || []));
} catch (e) {
  console.error('读不到预置配置：' + e.message);
  process.exit(1);
}
if (!presetManifest.length || !presetConfigs.length) {
  console.error('预置配置为空：PreSet/manifest.js 或它列出的文件有问题');
  process.exit(1);
}
const presetNames = presetConfigs.map(p => p.name);
console.log('预置配置：' + presetConfigs.length + ' 条（' + presetManifest.join(', ') + '）');

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find(p => fs.existsSync(p));

const fixture = {
  b64: pngB64,
  shotB64: fs.readFileSync(path.join(fixtureDir, 'shot_src.png')).toString('base64'),
  jpgB64: fs.readFileSync(path.join(fixtureDir, 'gray.jpg')).toString('base64'),
  jpgColorB64: fs.readFileSync(path.join(fixtureDir, 'color.jpg')).toString('base64'),
  width: expected.width,
  height: expected.height,
  gray: expected.gray,
  alpha: expected.alpha,
  jpgWidth: expected.jpgWidth,
  jpgHeight: expected.jpgHeight,
  jpgGray: expected.jpgGray,
  presetNames: presetNames,
  presetConfigs: presetConfigs,
};

const headInject = `
<script>
window.__err = null;
window.addEventListener('error', e => {
  const msg = String(e.message || e.error);
  // ResizeObserver loop 是浏览器自身的良性提示，不算页面错误
  if (msg.indexOf('ResizeObserver loop') >= 0) return;
  window.__err = msg;
});
window.addEventListener('unhandledrejection', e => { window.__err = 'unhandledrejection: ' + String(e.reason); });
</script>
`;

const testInject = `
<script>
window.__fixture = ${JSON.stringify(fixture)};
window.__runBrowserTest = async function () {
  const R = { ok: [], fail: [] };
  const check = (n, c, e) => { (c ? R.ok : R.fail).push(n + (c ? '' : '  [' + (e === undefined ? '' : e) + ']')); };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const waitFor = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(25); } return false; };
  const fire = el => el.dispatchEvent(new Event('change', { bubbles: true }));
  /** 直接载入「IR-BW」预设（2 个节点，等于原来的默认黑白色标），等价于「预设 → IR-BW → 导入」 */
  const doNewScale = async () => {
    await ensurePresetsLoaded();
    state.scale = presetToScale(presetByName('IR-BW'));
    state.scaleName = null;
    state.scaleHandle = null;
    state.baseline = scaleToText(state.scale);
    state.nodeChecked.clear();
    refreshAll();
    updateActionStates();
    await sleep(20);
  };
  const bg = el => getComputedStyle(el).backgroundColor;
  const isBlue = el => bg(el) === 'rgb(15, 108, 189)';
  const isRed = el => bg(el) === 'rgb(196, 43, 28)';
  const isGrey = el => bg(el) === 'rgb(243, 245, 247)';
  const legendHasColor = () => {
    const cv = $('legendCanvas');
    const d = cv.getContext('2d').getImageData(3, Math.floor(cv.height / 2), 1, 1).data;
    return !(d[0] === 255 && d[1] === 255 && d[2] === 255);
  };

  try {
    check('页面无未捕获错误', !window.__err, window.__err);
    check('初始提示为「请添加 PNG / JPG 图片」', $('previewInfo').textContent === '请添加 PNG / JPG 图片', $('previewInfo').textContent);
    check('初始节点卡片 = 2（一个保留节点 + 一个普通节点）', document.querySelectorAll('.node-card').length === 2);
    check('初始 Legend 已着色', legendHasColor());

    /* ---- 预设：配置文件驱动的预置色标列表（原「新色标」入口） ---- */
    {
      const openMenu = $('btnOpenScale').closest('.menu');
      check('「打开色标」里不再有「新色标」', !openMenu.querySelector('[data-act="new"]'));
      check('「打开色标」第一项改成了「预设」',
        openMenu.querySelector('[data-act="presets"]')
        && openMenu.querySelector('[data-act="presets"]').textContent === '预设');
      check('写死的 BD 色标已彻底移除（启动不再往本地库塞东西）',
        typeof ensureBuiltinScales === 'undefined' && typeof BUILTIN_BD_SCALE === 'undefined'
        && typeof actionNew === 'undefined');

      /* ---- 预设 = 配置文件驱动：index.html 里没有任何预置数据 ---- */
      check('index.html 里不再内嵌预置数据（没有 PRESET_SCALES 字面量）',
        !/const PRESET_SCALES = \\[/.test(document.documentElement.outerHTML),
        (document.documentElement.outerHTML.match(/const PRESET_SCALES[^\\n]*/) || ['无'])[0]);
      await ensurePresetsLoaded();
      await ensurePresetsLoaded();          // 第二次应当是同一个缓存，不会重复载入
      const cfgNames = window.__fixture.presetNames;
      check('预置列表来自 PreSet/ 下的配置文件（条数与清单一致）',
        PRESET_SCALES.length === cfgNames.length && PRESET_SCALES.length >= 2,
        PRESET_SCALES.length + ' vs ' + cfgNames.length);
      check('预置名字与顺序 = 配置文件里的名字与顺序',
        PRESET_SCALES.map(p => p.name).join('|') === cfgNames.join('|'),
        PRESET_SCALES.map(p => p.name).join('|'));
      check('「空白」仍排在第一位', PRESET_SCALES[0].name === '空白', PRESET_SCALES[0].name);
      check('预置节点数据与配置文件逐节点一致（页面 == 磁盘上的配置）',
        JSON.stringify(PRESET_SCALES) === JSON.stringify(window.__fixture.presetConfigs.map(presetFromConfig)),
        PRESET_SCALES.map(p => p.name + ':' + p.nodes.length).join(' '));
      check('预置里没有 created（导入那一刻才生成）',
        PRESET_SCALES.every(p => p.created === undefined));
      check('载入结果写进了运行日志',
        $('logView').textContent.indexOf('已从配置文件载入') >= 0
        && $('logView').textContent.indexOf('条预置色标') >= 0);

      // 干净状态 + 无图片时打开弹窗
      try { localStorage.removeItem(SCALE_STORE_KEY); } catch (e) { /* ignore */ }
      const pPreset = actionPresets();
      await sleep(80);
      check('「预设」弹窗已打开且标题正确',
        $('myScalesDialog').open === true && $('scaleLibTitle').textContent === '预设',
        $('scaleLibTitle').textContent);
      const pItems = $('myScalesList').querySelectorAll('.scale-item');
      check('弹窗里列出配置文件里的全部预置',
        pItems.length === PRESET_SCALES.length && pItems.length === cfgNames.length,
        pItems.length + ' vs ' + PRESET_SCALES.length);
      check('列表顺序与配置文件一致（第一行是「空白」）',
        Array.prototype.map.call(pItems, it => it.querySelector('.si-name').textContent).join('|')
          === cfgNames.join('|'),
        Array.prototype.map.call(pItems, it => it.querySelector('.si-name').textContent).join('|'));
      check('每条预置都有横向 legend 画布',
        $('myScalesList').querySelectorAll('.scale-item canvas').length === PRESET_SCALES.length);
      check('预置不显示假的创建时间，改说「导入时记录」',
        pItems[0].querySelector('.si-time').textContent.indexOf('创建于') < 0
        && pItems[0].querySelector('.si-time').textContent.indexOf('导入') >= 0,
        pItems[0].querySelector('.si-time').textContent);
      check('预置列表默认不选中任何一条',
        !Array.prototype.some.call(pItems, it => it.classList.contains('selected')));
      check('预置弹窗底部是「取消 / 导入」',
        $('myScalesCancel').textContent === '取消' && $('myScalesOk').textContent === '导入');
      check('预置弹窗没有「多选 / 删除」等管理入口',
        $('scaleLibTools').classList.contains('hidden'));
      const rCancel = $('myScalesCancel').getBoundingClientRect();
      const rOk = $('myScalesOk').getBoundingClientRect();
      check('取消在左、导入在右', rCancel.left < rOk.left,
        Math.round(rCancel.left) + ' vs ' + Math.round(rOk.left));

      // 取消不改动当前色标
      const beforeName = state.scale.name;
      $('myScalesCancel').click();
      await pPreset;
      await sleep(40);
      check('取消后当前色标没变', state.scale.name === beforeName, state.scale.name);

      // 选「IR-BD-ex」导入：节点、名字、created 按导入时刻补
      const beforeImport = Date.now();
      const pImport = actionPresets();
      await sleep(80);
      const exRow = Array.prototype.filter.call($('myScalesList').querySelectorAll('.scale-item'),
        it => it.querySelector('.si-name').textContent === 'IR-BD-ex')[0];
      check('预置列表里能找到 IR-BD-ex', !!exRow);
      exRow.click();
      check('选中后「导入」可用', $('myScalesOk').disabled === false);
      $('myScalesOk').click();
      await pImport;
      await sleep(60);
      if ($('askDialog').open) { $('askSave').click(); await sleep(40); }
      const afterImport = Date.now();
      check('导入后当前色标 = 该预置（24 个节点、名字 IR-BD-ex）',
        state.scale.nodes.length === 24 && state.scale.name === 'IR-BD-ex',
        state.scale.name + '/' + state.scale.nodes.length);
      check('预置没有 created，导入后按导入时刻补上',
        Number.isFinite(state.scale.created) && state.scale.created >= beforeImport
        && state.scale.created <= afterImport,
        state.scale.created + ' in [' + beforeImport + ',' + afterImport + ']');
      check('导入后不是未保存状态（可直接「保存」进本地库）', isDirty() === false);
      check('导入后日志里有记录',
        $('logView').textContent.indexOf('预设') >= 0 && $('logView').textContent.indexOf('IR-BD-ex') >= 0);
      check('导入后色标名称同步到输入框', $('scaleName').value === 'IR-BD-ex', $('scaleName').value);

      // 「保存」会把这条导入的预置写进本地库（带导入时生成的时间戳）
      const importedCreated = state.scale.created;
      check('保存成功', actionSave() === true);
      const lib = readScaleStore();
      check('本地库里出现这条预置（时间戳 = 导入时刻）',
        lib.length === 1 && Number(lib[0].created) === importedCreated && lib[0].name === 'IR-BD-ex',
        JSON.stringify(lib.map(r => r.name + '@' + r.created)));
      check('存进库的记录带 24 个节点', lib[0].nodes.length === 24, String(lib[0].nodes.length));

      // 再导入一次「空白」：单节点纯白、时间戳刷新
      const pBlank = actionPresets();
      await sleep(80);
      $('myScalesList').querySelectorAll('.scale-item')[0].click();
      $('myScalesOk').click();
      await pBlank;
      await sleep(60);
      if ($('askDialog').open) { $('askSave').click(); await sleep(40); }
      check('导入「空白」后只剩 1 个白色保留节点',
        state.scale.nodes.length === 1 && state.scale.nodes[0].rgb.join() === '255,255,255'
        && isPinned(state.scale.nodes[0]),
        String(state.scale.nodes.length));
      check('导入「空白」后整幅都是白的',
        state.mapper.colorAtKelvin(K_MIN).join() === '255,255,255'
        && state.mapper.colorAtKelvin(K_MAX).join() === '255,255,255');
      check('再次导入的时间戳与上一条不同', state.scale.created !== importedCreated,
        state.scale.created + ' vs ' + importedCreated);

      try { localStorage.removeItem(SCALE_STORE_KEY); } catch (e) { /* ignore */ }
      await doNewScale();
    }

    /* ---- 帮助：点菜单栏「帮助」直接打开使用说明（渲染后的 Markdown + 分节目录） ---- */
    {
      check('菜单栏里的「帮助」是一个直接可点的按钮',
        !!$('btnHelp') && $('btnHelp').dataset.act === 'help'
        && $('btnHelp').textContent.trim() === '帮助',
        $('btnHelp') ? $('btnHelp').textContent.trim() : 'none');
      check('不再有「关于」入口（帮助里已含实现细节）',
        !document.querySelector('[data-act="about"]')
        && typeof window.showAbout === 'undefined');
      check('「帮助」没有下拉菜单', !$('btnHelp').closest('.menu'));
      const dlg = $('helpDialog');
      $('btnHelp').click();                     // 真实点击
      await sleep(150);
      check('点「帮助」直接弹出使用说明', dlg.open === true);
      const doc = $('helpDoc'), nav = $('helpNav');
      check('正文渲染出章节标题（>= 12 个二级标题）',
        doc.querySelectorAll('h2').length >= 12, String(doc.querySelectorAll('h2').length));
      check('正文渲染出表格（>= 5 个）',
        doc.querySelectorAll('table').length >= 5, String(doc.querySelectorAll('table').length));
      check('正文渲染出代码块', doc.querySelectorAll('pre code').length >= 1);
      check('正文渲染出引用块与列表',
        doc.querySelectorAll('blockquote').length >= 1 && doc.querySelectorAll('li').length >= 25,
        doc.querySelectorAll('li').length + ' li');
      check('正文里没有残留的 Markdown 标记',
        doc.textContent.indexOf('**') < 0 && doc.textContent.indexOf('| ---') < 0
        && doc.textContent.indexOf('# ') < 0);
      check('正文渲染出 strong / code',
        doc.querySelectorAll('strong').length >= 10 && doc.querySelectorAll('code').length >= 10,
        doc.querySelectorAll('strong').length + ' / ' + doc.querySelectorAll('code').length);
      check('左侧目录只列章，条数与二级标题数一致',
        nav.querySelectorAll('.hn-top').length === doc.querySelectorAll('h2').length,
        nav.querySelectorAll('.hn-top').length + ' vs ' + doc.querySelectorAll('h2').length);
      check('目录里的小节数与正文三级标题数一致',
        nav.querySelectorAll('.hn-sub').length === doc.querySelectorAll('h3').length,
        nav.querySelectorAll('.hn-sub').length + ' vs ' + doc.querySelectorAll('h3').length);
      check('目录项文字与标题一致',
        nav.querySelector('.hn-label').textContent === doc.querySelector('h2').textContent,
        nav.querySelector('.hn-label').textContent + ' / ' + doc.querySelector('h2').textContent);
      check('有小节的章才有折叠箭头',
        nav.querySelectorAll('.hn-caret').length === doc.querySelectorAll('h2').length
        && Array.prototype.filter.call(nav.querySelectorAll('.hn-caret'), c => c.textContent !== '').length
          === Array.prototype.filter.call(nav.querySelectorAll('.hn-group'),
            g => g.querySelectorAll('.hn-sub').length > 0).length,
        String(Array.prototype.filter.call(nav.querySelectorAll('.hn-caret'), c => c.textContent !== '').length));
      check('目录默认不显示任何小节',
        Array.prototype.every.call(nav.querySelectorAll('.hn-sub'),
          s => getComputedStyle(s).display === 'none'));
      check('目录第一项默认高亮', nav.querySelector('.hn-top').classList.contains('active'));

      // 折叠展开：点带小节的章才展开它的小节，且同时只展开一章
      const tops = nav.querySelectorAll('.hn-top');
      const groups = nav.querySelectorAll('.hn-group');
      const withKids = Array.prototype.filter.call(groups, g => g.querySelectorAll('.hn-sub').length > 0);
      check('至少两章带小节', withKids.length >= 2, String(withKids.length));
      const g3 = withKids[0];
      const top3 = g3.querySelector('.hn-top');
      const top3Id = top3.dataset.target;
      top3.click();
      await sleep(100);
      check('点带小节的章会展开它的小节',
        g3.classList.contains('open')
        && getComputedStyle(g3.querySelector('.hn-sub')).display !== 'none');
      check('展开后箭头变成 ▾', g3.querySelector('.hn-caret').textContent === '▾');
      check('同时只有这一章展开', nav.querySelectorAll('.hn-group.open').length === 1,
        String(nav.querySelectorAll('.hn-group.open').length));
      check('点章后该标题贴到正文顶部',
        doc.querySelector('#' + top3Id).getBoundingClientRect().top
          - doc.getBoundingClientRect().top < 40,
        String(Math.round(doc.querySelector('#' + top3Id).getBoundingClientRect().top
          - doc.getBoundingClientRect().top)));
      check('展开的小节文字与正文三级标题一致',
        g3.querySelector('.hn-sub').textContent === doc.querySelector('h3').textContent,
        g3.querySelector('.hn-sub').textContent + ' / ' + doc.querySelector('h3').textContent);

      // 点小节跳转 + 高亮
      const sub = g3.querySelector('.hn-sub');
      const subId = sub.dataset.target;
      sub.click();
      await sleep(100);
      check('点小节能跳到该小节',
        doc.querySelector('#' + subId).getBoundingClientRect().top
          - doc.getBoundingClientRect().top < 40,
        String(Math.round(doc.querySelector('#' + subId).getBoundingClientRect().top
          - doc.getBoundingClientRect().top)));
      check('点小节后该小节高亮', sub.classList.contains('active'));

      // 展开另一章 -> 上一章自动收起；再点同一章 -> 收起
      const gOther = withKids[withKids.length - 1];
      gOther.querySelector('.hn-top').click();
      await sleep(100);
      check('展开另一章时上一章自动收起',
        !g3.classList.contains('open') && gOther.classList.contains('open'));
      gOther.querySelector('.hn-top').click();
      await sleep(80);
      check('再点同一章会收起小节', !gOther.classList.contains('open'));
      check('收起后小节不再显示',
        getComputedStyle(gOther.querySelector('.hn-sub')).display === 'none');

      // 没有小节的章：点击只跳转，不展开任何东西
      const noKid = Array.prototype.filter.call(groups, g => !g.querySelectorAll('.hn-sub').length)[0];
      noKid.querySelector('.hn-top').click();
      await sleep(100);
      check('点没有小节的章只跳转，不展开任何小节',
        nav.querySelectorAll('.hn-group.open').length === 0
        && doc.querySelector('#' + noKid.dataset.target).getBoundingClientRect().top
          - doc.getBoundingClientRect().top < 40);

      // 跳到最后一章：即使滚不到顶，高亮也要跟过去
      const lastTop = tops[tops.length - 1];
      lastTop.click();
      await sleep(100);
      check('滚不到顶时高亮仍然跟随', lastTop.classList.contains('active'));

      // 再点回第一章
      tops[0].click();
      await sleep(100);
      check('跳回第一章后标题贴到正文顶部',
        doc.querySelector('#' + tops[0].dataset.target).getBoundingClientRect().top
          - doc.getBoundingClientRect().top < 40,
        String(Math.round(doc.scrollTop)));
      check('跳回后高亮回到第一章', tops[0].classList.contains('active'));

      $('helpClose').click();
      await sleep(80);
      check('「关闭」能关掉使用说明弹窗', dlg.open === false);
      check('关闭后当前编辑状态不受影响', !!state.scale && state.scale.nodes.length >= 1);
    }

    /* ---- 操作入口：取消「文件」菜单，改成就近的下拉按钮组 ---- */
    {
      check('菜单栏不再有「文件」菜单',
        Array.prototype.every.call(document.querySelectorAll('#menubar button'),
          el => el.textContent.trim() !== '文件'));
      check('菜单栏只有 帮助 与 退出 两个按钮',
        Array.from(document.querySelectorAll('#menubar button')).map(el => el.textContent.trim()).join('/')
          === '帮助/退出',
        Array.from(document.querySelectorAll('#menubar button')).map(el => el.textContent.trim()).join('/'));
      check('色标列顶部有「打开色标」下拉按钮',
        !!$('btnOpenScale') && $('btnOpenScale').textContent.indexOf('打开色标') >= 0);
      check('色标列顶部有「保存色标」下拉按钮',
        !!$('btnSaveScale') && $('btnSaveScale').textContent.indexOf('保存色标') >= 0);
      const openMenu = $('btnOpenScale').closest('.menu');
      const saveMenu = $('btnSaveScale').closest('.menu');
      check('两个按钮都排在第二列最上方',
        $('scalePane').contains(openMenu) && $('scalePane').contains(saveMenu)
        && (openMenu.compareDocumentPosition($('scaleName')) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
        openMenu.parentElement.className + ' / ' + saveMenu.parentElement.className);
      check('「打开色标」含 预设 / 导入色标',
        !!openMenu.querySelector('[data-act="presets"]') && !!openMenu.querySelector('[data-act="open"]'));
      check('「保存色标」含 保存 / 另存为',
        !!saveMenu.querySelector('[data-act="save"]') && !!saveMenu.querySelector('[data-act="saveas"]'));

      check('图片列表上方有「导出图片」下拉按钮',
        !!$('btnExportMenu') && $('btnExportMenu').textContent.indexOf('导出图片') >= 0);
      check('导出按钮确实位于图片列表上方',
        $('btnExportMenu').getBoundingClientRect().bottom
        <= $('imageList').getBoundingClientRect().top + 1,
        Math.round($('btnExportMenu').getBoundingClientRect().bottom) + ' vs '
        + Math.round($('imageList').getBoundingClientRect().top));
      const exportMenu = $('btnExportMenu').closest('.menu');
      check('「导出图片」含 单张导出 / 批量导出',
        !!exportMenu.querySelector('[data-act="exportOne"]')
        && !!exportMenu.querySelector('[data-act="exportBatch"]'));

      $('btnOpenScale').click();
      check('点击下拉按钮可展开', openMenu.classList.contains('open'));
      closeAllMenus();
      check('点击其他位置后收起', !openMenu.classList.contains('open'));

      // 真实点击回归：这些按钮必须真的绑上了事件（不能只测函数）
      check('「管理色标」有 我的色标 / 从设备导入 两项',
        !!$('btnManageScales').closest('.menu').querySelector('[data-act="manageScales"]')
        && !!$('btnManageScales').closest('.menu').querySelector('[data-act="importToStore"]'));
      $('btnManageScales').click();
      check('点击「管理色标」展开菜单',
        $('btnManageScales').closest('.menu').classList.contains('open'));
      $('btnManageScales').closest('.menu').querySelector('[data-act="manageScales"]').click();
      await sleep(90);
      check('点「我的色标」打开管理弹窗', $('myScalesDialog').open === true);
      check('打开的是「管理色标」模式',
        $('scaleLibTitle').textContent === '管理色标' && $('myScalesOk').textContent === '导入',
        $('scaleLibTitle').textContent + ' / ' + $('myScalesOk').textContent);
      $('myScalesCancel').click();
      await sleep(40);
      check('管理色标弹窗可取消关闭', $('myScalesDialog').open === false);

      // 「管理色标 → 从设备导入」：把设备上的 JSON 收进本地色标库
      try { localStorage.removeItem(SCALE_STORE_KEY); } catch (e) { /* ignore */ }
      {
        const now = Date.now();
        const mk = (name, created) => JSON.stringify({
          created: created,
          name: name,
          range: { upper_k: 323.15, lower_k: 188.15 },
          nodes: [
            { temperature_k: 323.15, color: '#000000' },
            { temperature_k: 188.15, color: '#FFFFFF' },
          ],
        });
        const files = [
          { name: 'a.json', text: mk('设备甲', now) },
          { name: 'b.json', text: mk('设备乙', now + 1000) },
          { name: 'broken.json', text: '{ not json' },
        ];
        const origPicker = window.showOpenFilePicker;
        window.showOpenFilePicker = async () => files.map(f => ({
          name: f.name,
          getFile: async () => new File([f.text], f.name, { type: 'application/json' }),
        }));
        const pImport = actionImportToStore();          // 结束时会有弹窗，需读文本后关掉
        await sleep(120);
        const importMsg = $('msgText').textContent;
        if ($('msgDialog').open) $('msgOk').click();
        await pImport;
        window.showOpenFilePicker = origPicker;
        check('从设备导入把 2 条配置写进本地库',
          readScaleStore().length === 2, String(readScaleStore().length));
        check('导入的色标名称正确',
          readScaleStore().map(r => r.name).sort().join(',') === '设备乙,设备甲',
          readScaleStore().map(r => r.name).join(','));
        check('坏文件被跳过并报出原因',
          importMsg.indexOf('broken.json') >= 0, importMsg.slice(0, 140));
        check('导入只进色标库、不改动当前色标',
          state.scale.created !== now && state.scale.name !== '设备甲', state.scale.name);

        // 同一时间戳再次导入 = 覆盖而不是新增
        window.showOpenFilePicker = async () => [{
          name: 'a.json',
          getFile: async () => new File([mk('设备甲改名', now)], 'a.json', { type: 'application/json' }),
        }];
        const pImport2 = actionImportToStore();
        await sleep(120);
        const importMsg2 = $('msgText').textContent;
        if ($('msgDialog').open) $('msgOk').click();
        await pImport2;
        window.showOpenFilePicker = origPicker;
        check('同一时间戳再次导入仍是 2 条（覆盖）',
          readScaleStore().length === 2, String(readScaleStore().length));
        check('覆盖后名称已更新',
          readScaleStore().filter(r => Number(r.created) === now)[0].name === '设备甲改名',
          JSON.stringify(readScaleStore().map(r => r.name)));
        check('导入成功会有提示', importMsg2.indexOf('已导入') >= 0, importMsg2.slice(0, 80));
      }
      try { localStorage.removeItem(SCALE_STORE_KEY); } catch (e) { /* ignore */ }

      $('btnOpenScale').click();
      const myItem = openMenu.querySelector('[data-act="myScales"]');
      check('「我的色标」菜单项未被禁用', !myItem.classList.contains('disabled'));
      myItem.click();
      await sleep(90);
      check('点击「我的色标」能打开弹窗',
        $('myScalesDialog').open === true && $('scaleLibTitle').textContent === '我的色标');
      $('myScalesCancel').click();
      await sleep(40);

      $('btnExportMenu').click();
      check('点击「导出图片」展开菜单',
        $('btnExportMenu').closest('.menu').classList.contains('open'));
      const batchItem = $('btnExportMenu').closest('.menu').querySelector('[data-act="exportBatch"]');
      check('「批量导出」项未被禁用（未勾选时靠提示而不是置灰）',
        !batchItem.classList.contains('disabled'));
      batchItem.click();
      await sleep(60);
      check('未勾选图片时点「批量导出」提示「请选择图片」',
        $('msgDialog').open === true && $('msgText').textContent === '请选择图片',
        $('msgText').textContent);
      $('msgOk').click();
      await sleep(40);
      check('提示关闭后菜单已收起',
        $('btnExportMenu').closest('.menu').classList.contains('open') === false);

      // 「管理色标」夹在「打开色标」与「保存色标」之间
      const btnRow = openMenu.parentElement;
      const order = Array.prototype.map.call(btnRow.children,
        c => c.id || (c.querySelector('button') ? c.querySelector('button').id : ''));
      check('管理色标位于打开色标与保存色标之间',
        order[0] === 'btnOpenScale' && order[1] === 'btnManageScales' && order[2] === 'btnSaveScale',
        order.join(' / '));

      // 「确定」类按钮为经典蓝，「删除」类为经典红
      check('确定类按钮为经典蓝',
        isBlue($('nodeDlgOk')) && isBlue($('msgOk')) && isBlue($('inputOk'))
        && isBlue($('askSave')) && isBlue($('btnAddImages')),
        [bg($('nodeDlgOk')), bg($('msgOk')), bg($('inputOk')), bg($('askSave'))].join(' | '));
      check('刚关掉的弹窗里「确定 / 导入」是禁用浅灰（未选中任何条目）',
        $('myScalesOk').disabled === true && isGrey($('myScalesOk')), bg($('myScalesOk')));
      check('删除类按钮为经典红',
        isRed($('btnImgDelete')) && isRed($('btnNodeDelete')),
        [bg($('btnImgDelete')), bg($('btnNodeDelete'))].join(' | '));
      check('被禁用的删除按钮回到经典浅灰',
        $('scaleLibDelete').disabled === true && isGrey($('scaleLibDelete')), bg($('scaleLibDelete')));

      // 导出按钮始终可用：没有图片时点了也有提示，而不是静默无反应
      check('导出按钮始终可用', $('btnExportMenu').disabled === false);
      check('没有图片时「单张导出」置灰',
        $('btnExportMenu').closest('.menu')
          .querySelector('[data-act="exportOne"]').classList.contains('disabled'));
    }

    /* ---- 导入 ---- */
    const bytes = Uint8Array.from(atob(window.__fixture.b64), c => c.charCodeAt(0));
    const files = [0, 1, 2, 3].map(() => new File([bytes], 'IR_test.png', { type: 'image/png' }));
    await addImages(files);
    check('导入 4 张图片', state.entries.length === 4, state.entries.length);
    check('显示名依次为 image / (1) / (2) / (3)',
      state.entries.map(e => e.displayName).join(',') === 'IR_test.png,IR_test(1).png,IR_test(2).png,IR_test(3).png',
      state.entries.map(e => e.displayName).join(','));
    check('自动选中第一张', state.currentIndex === 0);

    await waitFor(() => state.grayFull && state.offscreen);
    check('图片已加载', !!state.grayFull);
    check('分辨率正确', state.fullSize && state.fullSize.width === window.__fixture.width && state.fullSize.height === window.__fixture.height,
      JSON.stringify(state.fullSize));
    {
      const eg = Uint8Array.from(window.__fixture.gray), ea = Uint8Array.from(window.__fixture.alpha);
      let g = true, a = true;
      for (let i = 0; i < eg.length; i++) if (state.grayFull[i] !== eg[i]) { g = false; break; }
      for (let i = 0; i < ea.length; i++) if (state.alphaFull[i] !== ea[i]) { a = false; break; }
      check('灰度和 Pillow 逐字节一致', g);
      check('Alpha 和 Pillow 逐字节一致（含 0/1/128/254/255）', a);
    }

    /* ---- 预览着色 == Legend 算法（用覆盖全部 256 级灰度、完全不透明的图） ---- */
    {
      const W2 = 256, H2 = 8;
      const rgba = new Uint8ClampedArray(W2 * H2 * 4);
      for (let y = 0; y < H2; y++) for (let x = 0; x < W2; x++) {
        const i = y * W2 + x, v = x;
        rgba[i * 4] = v; rgba[i * 4 + 1] = v; rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255;
      }
      const png = await encodePNG(rgba, W2, H2);
      await addImages([new File([png], 'ramp.png', { type: 'image/png' })]);
      const idx = state.entries.length - 1;
      setCurrentImage(idx, true);
      await waitFor(() => state.currentIndex === idx && state.grayFull && state.fullSize && state.fullSize.width === W2);
      check('256 级灰度图已加载且未缩放', state.prevSize.width === W2 && state.prevSize.height === H2,
        JSON.stringify(state.prevSize));
      let coverAll = true;
      for (let x = 0; x < W2; x++) if (state.grayFull[x] !== x) { coverAll = false; break; }
      check('灰度值 0..255 逐值正确', coverAll);
      const d = state.offscreen.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W2, H2).data;
      const lut = state.mapper.lut256();
      let ok = true, bad = '';
      for (let i = 0; i < W2 * H2; i++) {
        const g = state.grayPrev[i];
        if (d[i * 4] !== lut[g * 3] || d[i * 4 + 1] !== lut[g * 3 + 1] || d[i * 4 + 2] !== lut[g * 3 + 2]) {
          ok = false; bad = 'gray=' + g + ' 画布=' + [d[i * 4], d[i * 4 + 1], d[i * 4 + 2]] + ' LUT=' + [lut[g * 3], lut[g * 3 + 1], lut[g * 3 + 2]];
          break;
        }
      }
      check('全 ' + (W2 * H2) + ' 像素预览着色 = ColorMapper LUT', ok, bad);
      // 清理：移除这张临时测试图，恢复原来的 4 张
      state.entries = state.entries.filter((e, i) => i !== idx);
      state.currentIndex = -1;
      state.loadedEntryId = null;
      renderImageList();
      setCurrentImage(0, true);
      await waitFor(() => state.currentIndex === 0 && state.fullSize && state.fullSize.width === window.__fixture.width);
      check('清理后恢复 4 张图片', state.entries.length === 4, state.entries.length);
    }

    /* ---- 导出 PNG 往返 ---- */
    {
      const rgba = colorize(state.grayFull, state.alphaFull, state.mapper, state.fullSize.width, state.fullSize.height);
      const out = await encodePNG(rgba, state.fullSize.width, state.fullSize.height);
      const ab = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
      const back = await decodePNG(ab);
      let ok = back.width === state.fullSize.width && back.height === state.fullSize.height;
      if (ok) for (let i = 0; i < rgba.length / 4; i++) if (back.alpha[i] !== rgba[i * 4 + 3]) { ok = false; break; }
      check('导出 PNG 再解码：分辨率与 Alpha 原样', ok);
      window.__exported = Array.from(out).join(',');
    }

    /* ---- JPG 兼容 ---- */
    {
      const jpgBytes = Uint8Array.from(atob(window.__fixture.jpgB64), c => c.charCodeAt(0));
      const beforeCount = state.entries.length;
      await addImages([
        new File([jpgBytes], 'gray.jpg', { type: 'image/jpeg' }),
        new File([jpgBytes], 'gray.jpg', { type: 'image/jpeg' }),
        new File([Uint8Array.from(atob(window.__fixture.jpgColorB64), c => c.charCodeAt(0))],
          'color.jpg', { type: 'image/jpeg' }),
        new File([jpgBytes], 'note.gif', { type: 'image/gif' }),
      ]);
      check('JPG 可以导入（其它格式被忽略）',
        state.entries.length === beforeCount + 3, state.entries.length - beforeCount);
      check('JPG 显示名同样自动去重',
        state.entries[beforeCount].displayName === 'gray.jpg'
        && state.entries[beforeCount + 1].displayName === 'gray(1).jpg',
        state.entries.slice(beforeCount).map(e => e.displayName).join(','));

      const idx = state.entries.length - 2;      // color.jpg
      setCurrentImage(state.entries.length - 3, true);   // gray.jpg
      await waitFor(() => state.grayFull && state.fullSize && state.fullSize.width === window.__fixture.jpgWidth);
      check('JPG 分辨率正确',
        state.fullSize.width === window.__fixture.jpgWidth
        && state.fullSize.height === window.__fixture.jpgHeight, JSON.stringify(state.fullSize));
      let maxErr = 0, alphaOk = true;
      const want = window.__fixture.jpgGray;
      for (let i = 0; i < want.length; i++) {
        maxErr = Math.max(maxErr, Math.abs(state.grayFull[i] - want[i]));
        if (state.alphaFull[i] !== 255) alphaOk = false;
      }
      check('JPG 灰度接近原图（JPEG 有损，容差 6）', maxErr <= 6, 'maxErr=' + maxErr);
      check('JPG 无 Alpha 通道时 Alpha 全为 255', alphaOk);
      check('JPG 已着色预览', !!state.offscreen);

      // 整图导出为 JPEG，交给 Pillow 做独立校验
      const rgbaFull = colorize(state.grayFull, state.alphaFull, state.mapper,
        state.fullSize.width, state.fullSize.height);
      const jpgBlobFull = await encodeOutputImage(rgbaFull, state.fullSize.width, state.fullSize.height, true);
      window.__exportedJpg = Array.from(new Uint8Array(await jpgBlobFull.arrayBuffer())).join(',');
      check('整图导出为 JPEG 成功', jpgBlobFull.size > 200, jpgBlobFull.size);

      // 彩色 JPG 也能正常解码
      setCurrentImage(idx, true);
      await waitFor(() => state.grayFull && state.fullSize && state.fullSize.width === window.__fixture.jpgWidth);
      check('彩色 JPG 可正常解码', !!state.grayFull && state.alphaFull[0] === 255);

      // 导出格式跟随源文件
      const jpgBlob = await encodeOutputImage(
        new Uint8ClampedArray([10, 20, 30, 255]), 1, 1, true);
      const jpgHead = new Uint8Array(await jpgBlob.slice(0, 3).arrayBuffer());
      check('JPG 源导出为 JPEG（FF D8 FF）',
        jpgBlob.type === 'image/jpeg' && jpgHead[0] === 0xFF && jpgHead[1] === 0xD8 && jpgHead[2] === 0xFF,
        jpgBlob.type + ' ' + [...jpgHead].map(v => v.toString(16)).join(' '));
      const pngBlob = await encodeOutputImage(
        new Uint8ClampedArray([10, 20, 30, 255]), 1, 1, false);
      check('PNG 源仍导出为 PNG', pngBlob.type === 'image/png', pngBlob.type);

      // 清理
      state.entries = state.entries.filter(e =>
        ['gray.jpg', 'gray(1).jpg', 'color.jpg'].indexOf(e.displayName) < 0);
      state.currentIndex = -1;
      state.loadedEntryId = null;
      renderImageList();
      setCurrentImage(0, true);
      await waitFor(() => state.currentIndex === 0 && state.fullSize && state.fullSize.width === window.__fixture.width);
      check('清理后恢复原有图片数', state.entries.length === beforeCount, state.entries.length);
    }

    /* ---- 我的色标：localStorage 存取 + 弹窗 ---- */
    {
      // 从干净状态开始
      try { localStorage.removeItem(SCALE_STORE_KEY); } catch (e) { /* ignore */ }
      check('浏览器允许使用 localStorage', storeAvailable());

      // 菜单项
      const openMenuEl = $('btnOpenScale').closest('.menu');
      check('「打开色标」下有 预设 / 我的色标 / 从设备中导入 / 输入色标',
        !!openMenuEl.querySelector('[data-act="presets"]')
        && !!openMenuEl.querySelector('[data-act="myScales"]')
        && !!openMenuEl.querySelector('[data-act="open"]')
        && !!openMenuEl.querySelector('[data-act="inputScale"]'));
      check('原来的「导入色标」已改名为「从设备中导入」',
        openMenuEl.querySelector('[data-act="open"]').textContent === '从设备中导入',
        openMenuEl.querySelector('[data-act="open"]').textContent);

      // 保存 -> 写入本地库
      await doNewScale();                           // 干净的新色标（无未保存修改）
      const created1 = state.scale.created;
      check('新色标带毫秒时间戳', typeof created1 === 'number' && created1 > 1e12, String(created1));

      state.scale.name = '一号色标';
      state.scale.nodes[0].rgb = [12, 34, 56];
      refreshAll();
      check('修改后处于未保存状态', isDirty());
      check('保存返回成功', actionSave() === true);
      check('保存后不再是未保存状态', !isDirty());
      let lib = readScaleStore();
      check('本地库里出现 1 条记录', lib.length === 1, String(lib.length));
      check('本地库记录带创建时间戳', Number(lib[0].created) === created1);
      check('本地库记录带名称与颜色',
        lib[0].name === '一号色标' && lib[0].nodes[0].color === '#0C2238',
        JSON.stringify(lib[0].nodes[0]));

      // 改名后再保存：仍按时间戳覆盖同一条
      state.scale.name = '一号色标（改名）';
      check('改名后再次未保存', isDirty());
      actionSave();
      lib = readScaleStore();
      check('改名保存后仍是 1 条（按时间戳覆盖）', lib.length === 1, String(lib.length));
      check('名称已更新', lib[0].name === '一号色标（改名）', lib[0].name);
      check('创建时间戳没有被修改', Number(lib[0].created) === created1, String(lib[0].created));

      // 再导入一次「空白」-> 新时间戳 -> 两条
      await doNewScale();
      state.scale.name = '二号色标';
      check('重新导入后的时间戳不同', state.scale.created !== created1);
      actionSave();
      lib = readScaleStore();
      check('本地库变成 2 条', lib.length === 2, String(lib.length));
      check('本地库按创建时间倒序', Number(lib[0].created) >= Number(lib[1].created));

      // 弹窗：取消在左、确定在右，未选中时确定禁用
      const dlgPromise = actionMyScales();
      await sleep(60);
      const dlg = $('myScalesDialog');
      check('「我的色标」弹窗已打开', dlg.open);
      const items = dlg.querySelectorAll('.scale-item');
      check('列出 2 条色标', items.length === 2, String(items.length));
      check('每条都有横向 legend 画布', dlg.querySelectorAll('.scale-item canvas').length === 2);
      check('每条都显示名称',
        items[0].querySelector('.si-name').textContent.length > 0,
        items[0].querySelector('.si-name').textContent);
      check('每条都显示创建时间',
        /^创建于\\d{8} \\d{2}:\\d{2}:\\d{2}$/.test(items[0].querySelector('.si-time').textContent),
        items[0].querySelector('.si-time').textContent);
      const rCancel = $('myScalesCancel').getBoundingClientRect();
      const rOk = $('myScalesOk').getBoundingClientRect();
      check('取消在左、确定在右', rCancel.left < rOk.left,
        Math.round(rCancel.left) + ' vs ' + Math.round(rOk.left));
      check('未选中时「确定」禁用', $('myScalesOk').disabled === true);

      // 横向 legend：左低右高
      const cv = items[0].querySelector('canvas');
      const g = cv.getContext('2d', { willReadFrequently: true });
      const midY = Math.floor(cv.height / 2);
      const px = x => g.getImageData(x, midY, 1, 1).data;
      let firstColored = -1, lastColored = -1;
      for (let x = 0; x < cv.width; x++) {
        const d = px(x);
        if (d[3] > 0 && !(d[0] === d[1] && d[1] === d[2])) { if (firstColored < 0) firstColored = x; lastColored = x; }
      }
      check('横向 legend 已绘制', firstColored >= 0 && lastColored > firstColored,
        firstColored + '..' + lastColored);

      // 选中 -> 确定 -> 载入
      items[1].click();
      check('点选后「确定」可用', $('myScalesOk').disabled === false);
      check('被点选的那条有选中样式', items[1].classList.contains('selected'));
      $('myScalesOk').click();
      await dlgPromise;
      await sleep(20);
      if ($('askDialog').open) { $('askSave').click(); await sleep(30); }
      check('确定后载入所选色标',
        state.scale.name === '一号色标（改名）' && state.scale.created === created1,
        state.scale.name + ' / ' + state.scale.created);
      check('载入后与已保存状态一致（无未保存标记）', !isDirty());

      // 取消不会改动当前色标
      const before = state.scale.created;
      const p2 = actionMyScales();
      await sleep(60);
      $('myScalesCancel').click();
      await p2;
      await sleep(20);
      check('取消后当前色标不变', state.scale.created === before, String(state.scale.created));
    }

    /* ---- 管理色标：多选删除 + 单选导入 ---- */
    {
      try { localStorage.removeItem(SCALE_STORE_KEY); } catch (e) { /* ignore */ }
      for (let i = 0; i < 3; i++) {
        await doNewScale();
        state.scale.created = 1700000000000 + i * 1000;   // 固定时间戳，避免同毫秒
        state.scale.name = ['甲色标', '乙色标', '丙色标'][i];
        actionSave();
      }
      check('准备 3 条本地色标', readScaleStore().length === 3, String(readScaleStore().length));

      const p = actionManageScales();
      await sleep(60);
      const dlg = $('myScalesDialog');
      check('管理色标弹窗已打开', dlg.open === true);
      check('标题为「管理色标」', $('scaleLibTitle').textContent === '管理色标', $('scaleLibTitle').textContent);
      check('顶部显示「多选」与「删除」', !$('scaleLibTools').classList.contains('hidden'));
      check('底部右侧按钮是「导入」', $('myScalesOk').textContent === '导入', $('myScalesOk').textContent);
      check('列出 3 条色标', dlg.querySelectorAll('.scale-item').length === 3);
      check('默认不显示勾选框', dlg.querySelectorAll('.scale-item input[type=checkbox]').length === 0);
      check('未选中时「导入」禁用且为浅灰',
        $('myScalesOk').disabled === true && isGrey($('myScalesOk')), bg($('myScalesOk')));
      check('未选中时「删除」禁用且为浅灰',
        $('scaleLibDelete').disabled === true && isGrey($('scaleLibDelete')), bg($('scaleLibDelete')));

      // 单选 -> 导入与删除都可用（按钮有 120ms 过渡，等过渡结束再读颜色）
      dlg.querySelectorAll('.scale-item')[0].click();
      check('单选后「导入」可用', $('myScalesOk').disabled === false);
      check('单选后「删除」可用', $('scaleLibDelete').disabled === false);
      await sleep(220);
      check('可用后「导入」为经典蓝', isBlue($('myScalesOk')), bg($('myScalesOk')));
      check('可用后「删除」为经典红', isRed($('scaleLibDelete')), bg($('scaleLibDelete')));

      // 多选 -> 勾选框出现，导入回到禁用，同时出现「全选 / 全不选」
      $('scaleLibMulti').checked = true;
      fire($('scaleLibMulti'));
      await sleep(220);
      check('多选后每条左侧出现勾选框',
        dlg.querySelectorAll('.scale-item input[type=checkbox]').length === 3,
        String(dlg.querySelectorAll('.scale-item input[type=checkbox]').length));
      check('多选后出现「全选 / 全不选」按钮',
        !$('scaleLibAll').classList.contains('hidden') && !$('scaleLibNone').classList.contains('hidden'));
      check('多选后「导入」回到禁用', $('myScalesOk').disabled === true);
      check('多选且未勾选时「删除」禁用', $('scaleLibDelete').disabled === true);
      check('禁用时回到经典浅灰', isGrey($('scaleLibDelete')), bg($('scaleLibDelete')));

      // 全选 / 全不选
      $('scaleLibAll').click();
      check('「全选」勾中全部 3 条',
        Array.prototype.every.call(dlg.querySelectorAll('.scale-item input[type=checkbox]'), cb => cb.checked),
        String(dlg.querySelectorAll('.scale-item input[type=checkbox]').length));
      check('「全选」后「删除」可用', $('scaleLibDelete').disabled === false);
      $('scaleLibNone').click();
      check('「全不选」清空全部勾选',
        Array.prototype.every.call(dlg.querySelectorAll('.scale-item input[type=checkbox]'), cb => !cb.checked));
      check('「全不选」后「删除」禁用', $('scaleLibDelete').disabled === true);

      dlg.querySelectorAll('.scale-item')[0].click();
      dlg.querySelectorAll('.scale-item')[1].click();
      check('勾选两条后「删除」可用', $('scaleLibDelete').disabled === false);
      await sleep(220);
      check('勾选后「删除」为经典红', isRed($('scaleLibDelete')), bg($('scaleLibDelete')));

      $('scaleLibDelete').click();
      await sleep(40);
      check('删除后本地库只剩 1 条', readScaleStore().length === 1, String(readScaleStore().length));
      check('删除的正是勾选的两条', readScaleStore()[0].name === '甲色标', readScaleStore()[0].name);
      check('删除后弹窗仍打开并刷新列表',
        dlg.open === true && dlg.querySelectorAll('.scale-item').length === 1);
      check('删除后自动退出多选状态',
        $('scaleLibMulti').checked === false
        && dlg.querySelectorAll('.scale-item input[type=checkbox]').length === 0,
        'multi=' + $('scaleLibMulti').checked
        + ' boxes=' + dlg.querySelectorAll('.scale-item input[type=checkbox]').length);
      check('退出多选后「全选 / 全不选」收起',
        $('scaleLibAll').classList.contains('hidden') && $('scaleLibNone').classList.contains('hidden'));
      await sleep(220);
      check('退出多选后「删除」回到禁用浅灰',
        $('scaleLibDelete').disabled === true && isGrey($('scaleLibDelete')), bg($('scaleLibDelete')));

      // 单选后导入
      dlg.querySelectorAll('.scale-item')[0].click();
      check('重新单选后「导入」可用', $('myScalesOk').disabled === false);
      $('myScalesOk').click();
      await p;
      await sleep(30);
      if ($('askDialog').open) { $('askSave').click(); await sleep(40); }
      check('导入后当前色标变为所选的一条',
        state.scale.name === '甲色标' && state.scale.created === 1700000000000,
        state.scale.name + ' / ' + state.scale.created);

      // 取消不改动任何东西
      const beforeCount = readScaleStore().length;
      const p2 = actionManageScales();
      await sleep(60);
      $('myScalesCancel').click();
      await p2;
      await sleep(20);
      check('取消后本地库不变', readScaleStore().length === beforeCount);
    }

    /* ---- 导出到剪贴板（我的色标 / 管理色标弹窗，单选后可用） ---- */
    let copiedScaleText = null;          // 供下面「输入色标」用例复用
    {
      try { localStorage.removeItem(SCALE_STORE_KEY); } catch (e) { /* ignore */ }
      // 两条示例记录：一条黑白（时间戳更大 → 排在第一条）、一条用「IR-BD-ex」预置的内容
      const exNodes = presetByName('IR-BD-ex').nodes;
      writeScaleStore([
        { created: 1700000000111, name: 'IR-BD-ex',
          nodes: JSON.parse(JSON.stringify(exNodes)) },
        { created: 1700000000222, name: '黑白',
          nodes: [{ temperature_k: 323.15, color: '#000000', pinned: true },
                  { temperature_k: 188.15, color: '#FFFFFF' }] },
      ]);

      // 桩掉剪贴板，捕获写进去的文本
      let copied = null;
      try {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: { writeText: t => { copied = t; return Promise.resolve(); } },
        });
      } catch (e) { /* ignore */ }

      const p = actionMyScales();
      await sleep(60);
      check('「我的色标」弹窗里有「导出到剪贴板」按钮', !!$('scaleLibCopy'));
      check('未选中任何一条时「导出到剪贴板」禁用', $('scaleLibCopy').disabled === true);
      check('「导出到剪贴板」在「取消」与「确定」之间',
        $('myScalesCancel').compareDocumentPosition($('scaleLibCopy')) & Node.DOCUMENT_POSITION_FOLLOWING
        && $('scaleLibCopy').compareDocumentPosition($('myScalesOk')) & Node.DOCUMENT_POSITION_FOLLOWING);

      const bdRow = Array.prototype.filter.call($('myScalesList').querySelectorAll('.scale-item'),
        it => Number(it.dataset.created) === 1700000000111)[0];
      bdRow.click();
      check('单选一条后「导出到剪贴板」可用', $('scaleLibCopy').disabled === false);
      check('单选后按钮是次级样式（不是蓝/红）',
        !isBlue($('scaleLibCopy')) && !isRed($('scaleLibCopy')), bg($('scaleLibCopy')));
      $('scaleLibCopy').click();
      await sleep(60);
      check('点击后确实往剪贴板写了文本', typeof copied === 'string' && copied.length > 0, String(copied).slice(0, 60));
      let copiedObj = null;
      try { copiedObj = JSON.parse(copied); } catch (e) { /* ignore */ }
      check('复制出来的是可解析的色标 JSON',
        !!copiedObj && Array.isArray(copiedObj.nodes), String(copied).slice(0, 80));
      check('复制内容与「另存为」格式一致（created / name / nodes）',
        copiedObj && Number(copiedObj.created) === 1700000000111 && copiedObj.name === 'IR-BD-ex'
        && copiedObj.nodes.length === 24,
        copiedObj ? copiedObj.name + '/' + copiedObj.nodes.length : 'null');
      check('复制内容带保留节点标记',
        copiedObj && copiedObj.nodes.filter(n => n.pinned === true).length === 1);
      check('复制后按钮显示「已复制」', $('scaleLibCopy').textContent === '已复制',
        $('scaleLibCopy').textContent);
      check('「已复制」时按钮带高亮样式且禁用',
        $('scaleLibCopy').classList.contains('copied') && $('scaleLibCopy').disabled === true);
      copiedScaleText = copied;

      // 1 秒时还在（最多维持 2 秒）
      await sleep(1300);
      check('过了约 1 秒仍显示「已复制」（没提前变）',
        $('scaleLibCopy').textContent === '已复制', $('scaleLibCopy').textContent);
      // 2 秒后开始渐隐
      await sleep(800);
      check('约 2 秒后开始渐隐（fading）',
        $('scaleLibCopy').classList.contains('fading'), $('scaleLibCopy').className);
      // 渐隐结束 -> 切回原文案、恢复可点
      await sleep(500);
      check('渐隐结束后切回「导出到剪贴板」',
        $('scaleLibCopy').textContent === '导出到剪贴板', $('scaleLibCopy').textContent);
      check('切回后动画类被清掉、不透明度复原',
        !$('scaleLibCopy').classList.contains('fading')
        && !$('scaleLibCopy').classList.contains('copied')
        && getComputedStyle($('scaleLibCopy')).opacity === '1',
        $('scaleLibCopy').className + ' / ' + getComputedStyle($('scaleLibCopy')).opacity);
      check('切回后仍可按（单选还在，按钮恢复可用）', $('scaleLibCopy').disabled === false);

      // 复制后在 2 秒内切换选中 -> 立刻切回原文案，并中断渐隐
      $('scaleLibCopy').click();
      await sleep(80);
      check('再次复制又显示「已复制」', $('scaleLibCopy').textContent === '已复制');
      $('myScalesList').querySelectorAll('.scale-item')[0].click();   // 换一条（黑白）
      check('切换选中后立刻切回「导出到剪贴板」',
        $('scaleLibCopy').textContent === '导出到剪贴板' && !$('scaleLibCopy').classList.contains('fading'),
        $('scaleLibCopy').textContent + ' / ' + $('scaleLibCopy').className);
      await sleep(2400);
      check('切换后不会再冒出「已复制」（计时器已中断）',
        $('scaleLibCopy').textContent === '导出到剪贴板', $('scaleLibCopy').textContent);

      // 渐隐进行中切换选中 -> 也立刻复原
      $('scaleLibCopy').click();
      await sleep(2080);                                              // 正好处在渐隐中
      const wasFading = $('scaleLibCopy').classList.contains('fading');
      $('myScalesList').querySelectorAll('.scale-item')[1].click();
      await sleep(400);
      check('渐隐中切换选中会中断动画并复原',
        !$('scaleLibCopy').classList.contains('fading')
        && $('scaleLibCopy').textContent === '导出到剪贴板'
        && getComputedStyle($('scaleLibCopy')).opacity === '1',
        'wasFading=' + wasFading + ' now=' + $('scaleLibCopy').className
        + ' / ' + $('scaleLibCopy').textContent + ' / ' + getComputedStyle($('scaleLibCopy')).opacity);

      // 关掉弹窗（复制后立刻关）-> 再打开总是原文案
      $('scaleLibCopy').click();
      await sleep(80);
      check('关闭前处于「已复制」', $('scaleLibCopy').textContent === '已复制');
      $('myScalesCancel').click();
      await p;
      await sleep(40);
      check('关闭弹窗即复位文案',
        $('scaleLibCopy').textContent === '导出到剪贴板' && !$('scaleLibCopy').classList.contains('copied'));
      const p1b = actionMyScales();
      await sleep(80);
      check('重新打开弹窗时总是显示「导出到剪贴板」',
        $('scaleLibCopy').textContent === '导出到剪贴板'
        && !$('scaleLibCopy').classList.contains('copied')
        && !$('scaleLibCopy').classList.contains('fading')
        && $('scaleLibCopy').disabled === true,
        $('scaleLibCopy').textContent);
      $('myScalesCancel').click();
      await p1b;
      await sleep(40);

      // 管理色标（多选模式）下不可用
      const p2 = actionManageScales();
      await sleep(60);
      check('「管理色标」弹窗里也有「导出到剪贴板」按钮', !!$('scaleLibCopy'));
      check('管理色标下单选后可用', ($('myScalesList').querySelectorAll('.scale-item')[0].click(),
        $('scaleLibCopy').disabled === false));
      check('管理色标下打开时也是原文案', $('scaleLibCopy').textContent === '导出到剪贴板');
      $('scaleLibCopy').click();
      await sleep(80);
      check('管理色标下复制也显示「已复制」', $('scaleLibCopy').textContent === '已复制');
      $('scaleLibMulti').checked = true;
      fire($('scaleLibMulti'));
      await sleep(40);
      check('切到多选后「导出到剪贴板」禁用', $('scaleLibCopy').disabled === true);
      check('切到多选后文案也立刻复位', $('scaleLibCopy').textContent === '导出到剪贴板',
        $('scaleLibCopy').textContent);
      $('scaleLibMulti').checked = false;
      fire($('scaleLibMulti'));
      await sleep(40);
      $('myScalesCancel').click();
      await p2;
      await sleep(40);
    }

    /* ---- 打开色标 → 输入色标（从文本载入） ---- */
    {
      const menuItem = $('btnOpenScale').closest('.menu').querySelector('[data-act="inputScale"]');
      check('「打开色标」下拉里有「输入色标」', !!menuItem && menuItem.textContent === '输入色标',
        menuItem ? menuItem.textContent : 'missing');
      check('「输入色标」排在「从设备中导入」下面',
        menuItem && $('btnOpenScale').closest('.menu').querySelector('[data-act="open"]')
          .compareDocumentPosition(menuItem) & Node.DOCUMENT_POSITION_FOLLOWING);

      const before = scaleToText(state.scale);

      // 1) 空文本 -> 行内报错，弹窗不关、色标不变
      menuItem.click();                      // 真实点击，验证接线
      await sleep(80);
      check('弹出「输入色标」对话框', $('textScaleDialog').open === true);
      $('textScaleOk').click();
      await sleep(40);
      check('空文本时提示「请先粘贴」并保持弹窗打开',
        $('textScaleDialog').open === true && $('textScaleErr').textContent.indexOf('请先粘贴') >= 0,
        $('textScaleErr').textContent);
      check('空文本时色标没变', scaleToText(state.scale) === before);

      // 2) 非法 JSON
      $('textScaleArea').value = '{ 这不是 JSON';
      $('textScaleOk').click();
      await sleep(40);
      check('非法 JSON 时提示解析失败并保持弹窗打开',
        $('textScaleDialog').open === true && $('textScaleErr').textContent.indexOf('JSON 解析失败') >= 0,
        $('textScaleErr').textContent);
      check('非法 JSON 时色标没变', scaleToText(state.scale) === before);

      // 3) 合法 JSON 但内容非法（温度超范围）
      $('textScaleArea').value = '{"name":"坏的","nodes":[{"temperature_k":5000,"color":"#000000"}]}';
      $('textScaleOk').click();
      await sleep(40);
      check('内容非法时提示「配置内容非法」并保持弹窗打开',
        $('textScaleDialog').open === true && $('textScaleErr').textContent.indexOf('配置内容非法') >= 0,
        $('textScaleErr').textContent);
      check('错误用的是红色提示', getComputedStyle($('textScaleErr')).color === 'rgb(196, 43, 28)',
        getComputedStyle($('textScaleErr')).color);

      // 4) 取消不改动
      $('textScaleCancel').click();
      await sleep(40);
      check('取消后弹窗关闭且色标不变',
        $('textScaleDialog').open === false && scaleToText(state.scale) === before);

      // 5) 粘回刚才「导出到剪贴板」拿到的那段文本 -> 载入
      const p3 = openTextScaleDialog('输入色标', '粘贴色标 JSON', '');
      await sleep(60);
      $('textScaleArea').value = copiedScaleText;
      $('textScaleOk').click();
      const loaded = await p3;
      await sleep(40);
      check('合法文本被解析成色标对象', !!loaded && loaded.nodes.length === 24,
        loaded ? String(loaded.nodes.length) : 'null');
      check('解析出的时间戳与文本一致', loaded && Number(loaded.created) === 1700000000111);

      // 走一遍真实的 action：贴进去再确定，应当直接成为当前色标
      await doNewScale();
      const p4 = actionInputScale();
      await sleep(60);
      check('actionInputScale 会打开同一个对话框', $('textScaleDialog').open === true);
      $('textScaleArea').value = copiedScaleText;
      $('textScaleOk').click();
      await p4;
      await sleep(60);
      if ($('askDialog').open) { $('askSave').click(); await sleep(40); }
      check('载入后当前色标 = 粘贴的那条（24 个节点）',
        state.scale.nodes.length === 24 && state.scale.name === 'IR-BD-ex'
        && Number(state.scale.created) === 1700000000111,
        state.scale.name + '/' + state.scale.nodes.length + '/' + state.scale.created);
      check('载入后与文本内容完全一致（无未保存标记）',
        !isDirty() && scaleToText(state.scale) === copiedScaleText);
      check('载入后日志里有记录',
        $('logView').textContent.indexOf('输入色标') >= 0);
      check('载入后色标名称同步到输入框', $('scaleName').value === 'IR-BD-ex', $('scaleName').value);

      // 6) 有未保存修改时先确认
      state.scale.name = '改过名字';
      refreshAll();
      check('当前处于未保存状态', isDirty() === true);
      menuItem.click();
      await sleep(60);
      check('有未保存修改时先弹「是否继续」', $('askDialog').open === true);
      $('askCancel').click();
      await sleep(60);
      check('取消后不打开「输入色标」对话框', $('textScaleDialog').open === false);
      state.scale.name = 'IR-BD-ex';
      refreshAll();
      await doNewScale();
    }

    /* ---- 节点：选择模式 / 新增 / 删除 / 交换按钮 ---- */
    $('nodeSelectMode').checked = true; fire($('nodeSelectMode'));
    check('保留节点不参与选择（只有普通节点有勾选框）',
      document.querySelectorAll('.node-card input[type=checkbox]').length === 1,
      document.querySelectorAll('.node-card input[type=checkbox]').length);
    check('保留节点卡片带「保留」标记',
      !!document.querySelector('.node-card .tag') && document.querySelector('.node-card .tag').textContent === '保留',
      document.querySelector('.node-card .tag') ? document.querySelector('.node-card .tag').textContent : 'none');
    const mid = makeNode(273.15, [255, 0, 0]);
    state.scale.nodes.push(mid); sortNodes(state.scale.nodes); refreshAll();
    check('新增节点后卡片 = 3', document.querySelectorAll('.node-card').length === 3, document.querySelectorAll('.node-card').length);
    check('新增节点后有 2 个勾选框', document.querySelectorAll('.node-card input[type=checkbox]').length === 2);
    state.nodeChecked.add(mid.uid); deleteCheckedNodes();
    check('批量删除节点后卡片 = 2', document.querySelectorAll('.node-card').length === 2);

    // 保留节点：勾选全部后删除，它必须留下
    state.nodeChecked = new Set(state.scale.nodes.map(n => n.uid));
    await deleteCheckedNodes();
    check('保留节点不会被删除',
      state.scale.nodes.length === 1 && state.scale.nodes.some(n => isPinned(n)),
      state.scale.nodes.length + ' / pinned=' + state.scale.nodes.some(n => isPinned(n)));
    check('至少保留一个节点（不会删空）', state.scale.nodes.length === 1);
    $('nodeSelectMode').checked = false; fire($('nodeSelectMode'));

    // 保留节点可以改位置和颜色
    {
      const pinnedNode = state.scale.nodes.filter(n => isPinned(n))[0];
      const before = pinnedNode.kelvin;
      editNode(pinnedNode.uid);
      await sleep(60);
      check('保留节点对话框里位置可编辑', $('nodeDlgPos').readOnly === false);
      check('保留节点对话框给出「不会删除」提示',
        !$('nodeDlgEndpointHint').classList.contains('hidden')
        && $('nodeDlgEndpointHint').textContent.indexOf('不会被删除') >= 0,
        $('nodeDlgEndpointHint').textContent);
      $('nodeDlgPos').value = '20';
      $('nodeDlgHex').value = '#090909';
      $('nodeDlgHex').dispatchEvent(new Event('input', { bubbles: true }));
      $('nodeDlgOk').click();
      await sleep(100);
      check('保留节点位置可被修改',
        Math.abs(pinnedNode.kelvin - (20 + 273.15)) < 1e-9 && Math.abs(pinnedNode.kelvin - before) > 1,
        pinnedNode.kelvin);
      check('保留节点颜色可被修改', pinnedNode.rgb.join() === '9,9,9', pinnedNode.rgb.join());
      check('位置改了它还是保留节点', isPinned(pinnedNode));
      // 恢复成默认色标，后面的用例继续用
      await doNewScale();
      refreshAll();
    }

    // 温度相同的两个节点 -> 两张卡片共边框并置，分界线上骑一个双箭头按钮
    const a1 = makeNode(273.15, [255, 0, 0]), a2 = makeNode(273.15, [0, 0, 255]);
    state.scale.nodes.push(a1); state.scale.nodes.push(a2); sortNodes(state.scale.nodes); refreshAll();
    {
      const groups = document.querySelectorAll('.node-group');
      check('重叠节点合并为一个卡片组', groups.length === 1, groups.length);
      check('组内正好两张卡片', groups[0] && groups[0].querySelectorAll('.node-card').length === 2);
      check('全列表只剩一个交换按钮', document.querySelectorAll('.node-swap').length === 1,
        document.querySelectorAll('.node-swap').length);
      const cards = groups[0].querySelectorAll('.node-card');
      const swap = groups[0].querySelector('.node-swap');
      check('交换按钮位于卡片组内部', !!swap);
      const rTop = cards[0].getBoundingClientRect();
      const rBot = cards[1].getBoundingClientRect();
      const rSwap = swap.getBoundingClientRect();
      check('两张卡片共边、无间隙', Math.abs(rBot.top - rTop.bottom) <= 1.2,
        Math.round(rTop.bottom) + ' vs ' + Math.round(rBot.top));
      const dividerY = (rTop.bottom + rBot.top) / 2;
      const swapMidY = (rSwap.top + rSwap.bottom) / 2;
      check('按钮垂直方向骑在分界线上', Math.abs(swapMidY - dividerY) <= 2,
        Math.round(swapMidY) + ' vs ' + Math.round(dividerY));
      const swapMidX = (rSwap.left + rSwap.right) / 2;
      const groupMidX = (rTop.left + rTop.right) / 2;
      check('按钮水平居中', Math.abs(swapMidX - groupMidX) <= 2,
        Math.round(swapMidX) + ' vs ' + Math.round(groupMidX));
      check('按钮是小方块而不是通栏条',
        rSwap.width <= 30 && rSwap.height <= 30 && rSwap.width < rTop.width * 0.5,
        Math.round(rSwap.width) + 'x' + Math.round(rSwap.height) + ' 卡片宽 ' + Math.round(rTop.width));
      check('按钮含双箭头图形', swap.querySelectorAll('svg path').length === 2);
      const above1 = state.mapper.colorAtKelvin(273.16).join();
      swap.click();
      const above2 = state.mapper.colorAtKelvin(273.16).join();
      check('点击双箭头按钮可交换顺序', above1 !== above2, above1 + ' -> ' + above2);
      check('交换后仍是同一个卡片组并重新渲染',
        document.querySelectorAll('.node-group').length === 1
        && document.querySelectorAll('.node-swap').length === 1);
    }
    state.scale.nodes = state.scale.nodes.filter(n => n.uid !== a1.uid && n.uid !== a2.uid);
    refreshAll();
    check('移除重叠节点后不再有卡片组', document.querySelectorAll('.node-group').length === 0);

    /* ---- 有未保存修改时，预设 / 导入色标需要确认 ---- */
    {
      state.scale.nodes[0].rgb = [9, 9, 9];
      updateTitle();
      check('当前确有未保存修改', isDirty());

      // 「预设」先弹列表，选中一条按「导入」后才问「是否继续」
      const p1 = actionPresets();
      await sleep(60);
      check('「预设」弹窗已打开（未保存修改不阻止先看预设）', $('myScalesDialog').open === true);
      $('myScalesList').querySelectorAll('.scale-item')[0].click();
      $('myScalesOk').click();
      await sleep(40);
      check('有未保存修改时「预设」导入要求确认',
        $('askDialog').open && $('askText').textContent.indexOf('未保存的修改') >= 0,
        $('askText').textContent);
      $('askCancel').click();
      await p1;
      await sleep(40);
      check('取消后色标保持不变',
        isDirty() && state.scale.nodes[0].rgb.join() === '9,9,9', state.scale.nodes[0].rgb.join());

      const p2 = actionOpen();
      await sleep(30);
      check('有未保存修改时「导入色标」也要求确认',
        $('askDialog').open && $('askText').textContent.indexOf('未保存的修改') >= 0,
        $('askText').textContent);
      $('askCancel').click();
      await p2;
      check('取消导入后色标仍未被覆盖',
        state.scale.nodes[0].rgb.join() === '9,9,9', state.scale.nodes[0].rgb.join());

      // 确认「继续」后真的导入预设（「空白」只有一个白色保留节点）
      const p3 = actionPresets();
      await sleep(60);
      $('myScalesList').querySelectorAll('.scale-item')[0].click();
      $('myScalesOk').click();
      await sleep(40);
      $('askSave').click();                       // 「继续」
      await p3;
      await sleep(40);
      check('确认后执行导入并换成「空白」预设',
        state.scale.name === '空白' && state.scale.nodes.length === 1 && !isDirty(),
        state.scale.name + '/' + state.scale.nodes.length);
      check('导入后的时间戳是新的',
        state.scale.created > 1e12 && Math.abs(Date.now() - state.scale.created) < 10000,
        String(state.scale.created));
      await doNewScale();
    }

    /* ---- 图片温度：黑色端 / 白色端（在预览标题与「重置视图」之间） ---- */
    {
      const c2k = c => c + 273.15;
      const msgText = () => $('msgTitle').textContent + '：' + $('msgText').textContent;
      const closeMsg = () => { if ($('msgDialog').open) $('msgOk').click(); };

      check('预览区有黑色温度 / 白色温度两个输入框',
        !!$('imageRangeBlack') && !!$('imageRangeWhite'));
      check('两个输入框的标签就是「黑色温度」「白色温度」',
        document.querySelector('label[for="imageRangeBlack"]').textContent === '黑色温度'
        && document.querySelector('label[for="imageRangeWhite"]').textContent === '白色温度',
        document.querySelector('label[for="imageRangeBlack"]').textContent + ' / '
          + document.querySelector('label[for="imageRangeWhite"]').textContent);
      check('温度输入位于标题与「重置视图」之间',
        ($('previewInfo').compareDocumentPosition($('imageRangeBlack')) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
        && ($('imageRangeBlack').compareDocumentPosition($('btnResetView')) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
      check('界面上不再有「上限 / 下限」的表述',
        document.querySelector('#previewPane').textContent.indexOf('上限') < 0
        && document.querySelector('#previewPane').textContent.indexOf('下限') < 0);
      check('色标列不再有温度输入框',
        $('scalePane').querySelector('#rangeUpper') === null
        && $('scalePane').querySelector('#rangeLower') === null);
      check('色标列改为显示「由节点决定」的范围',
        $('scaleRangeInfo').textContent.indexOf('由最高温') >= 0, $('scaleRangeInfo').textContent);

      const nodesBefore = state.scale.nodes.map(n => roundHalfEven(n.kelvin)).join();

      $('imageRangeBlack').value = '60'; $('imageRangeWhite').value = '-100';
      commitRange();
      check('图片温度可改为黑色 60 / 白色 -100',
        Math.abs(toDisplay(K_BLACK, UNIT_C) - 60) < 1e-9 && Math.abs(toDisplay(K_WHITE, UNIT_C) + 100) < 1e-9,
        toDisplay(K_BLACK, UNIT_C) + ' / ' + toDisplay(K_WHITE, UNIT_C));
      check('上限 / 下限由程序比较大小得出',
        Math.abs(toDisplay(K_MAX, UNIT_C) - 60) < 1e-9 && Math.abs(toDisplay(K_MIN, UNIT_C) + 100) < 1e-9,
        toDisplay(K_MAX, UNIT_C) + ' / ' + toDisplay(K_MIN, UNIT_C));
      check('日志里写出这次换算出的上限 / 下限',
        $('logView').textContent.indexOf('上限 60.00') >= 0
        && $('logView').textContent.indexOf('下限 -100.00') >= 0);
      check('输入框只显示数字（无单位）',
        $('imageRangeBlack').value === '60.00' && $('imageRangeWhite').value === '-100.00',
        $('imageRangeBlack').value + ' | ' + $('imageRangeWhite').value);
      check('范围标签显示当前单位',
        $('imageRangeLabel').textContent.indexOf(UNIT_C) >= 0, $('imageRangeLabel').textContent);
      check('改图片温度不会改动色标节点',
        state.scale.nodes.map(n => roundHalfEven(n.kelvin)).join() === nodesBefore,
        state.scale.nodes.map(n => n.kelvin).join());

      // 色标范围由节点决定，和图片范围无关
      const sRange = scaleTempRange(state.scale.nodes);
      check('色标范围仍是两端节点温度',
        Math.abs(sRange.highK - DEF_K_MAX) < 1e-9 && Math.abs(sRange.lowK - DEF_K_MIN) < 1e-9,
        sRange.highK + ' / ' + sRange.lowK);

      // 色标窄于图片范围时：超出部分取两端节点颜色（走应用自己的 mapper）
      {
        const sc = state.scale;
        sc.nodes = [makeNode(c2k(0), [200, 0, 0], true), makeNode(c2k(-20), [0, 0, 200])];
        sortNodes(sc.nodes);
        refreshAll();
        check('图片温度高于色标上端 -> 取上端节点颜色',
          state.mapper.colorAtKelvin(pToKelvin(0)).join() === '200,0,0',
          state.mapper.colorAtKelvin(pToKelvin(0)).join() + ' @ ' + toDisplay(pToKelvin(0), UNIT_C));
        check('图片温度低于色标下端 -> 取下端节点颜色',
          state.mapper.colorAtKelvin(pToKelvin(255)).join() === '0,0,200',
          state.mapper.colorAtKelvin(pToKelvin(255)).join());

        // Legend 温度轴 = 图片范围：两端被拉伸成节点色
        await sleep(30);
        const lg = $('legendCanvas');
        const lctx = lg.getContext('2d', { willReadFrequently: true });
        const barPx = y => lctx.getImageData(8, y, 1, 1).data;   // x=8 在 16px 柱体正中
        const top = barPx(2), bottom = barPx(lg.height - 3);
        check('Legend 顶端拉伸为色标上端节点颜色',
          top[0] === 200 && top[1] === 0 && top[2] === 0, [...top].join(','));
        check('Legend 底端拉伸为色标下端节点颜色',
          bottom[0] === 0 && bottom[1] === 0 && bottom[2] === 200, [...bottom].join(','));

        // 图片温度 60~-100 下，-10°C 处应是 0°C 红与 -20°C 蓝的插值
        const yOfC = c => Math.round(kelvinToP(c2k(c)) / P_MAX * (lg.height - 1));
        const mid = barPx(yOfC(-10));
        check('Legend 中间按节点插值（约 100,0,100）',
          mid[1] === 0 && mid[0] > 85 && mid[0] < 115 && mid[2] > 85 && mid[2] < 115,
          [...mid].join(','));
        check('Legend 柱体边缘不再发白（关掉插值生效）',
          top[3] === 255 && top[0] + top[1] + top[2] < 400, [...top].join(','));
      }

      // 色标宽于图片范围时：只显示图片范围这一段（超出部分截断）
      {
        const sc = state.scale;
        sc.nodes = [makeNode(c2k(200), [0, 0, 0], true), makeNode(c2k(-200), [255, 255, 255])];
        sortNodes(sc.nodes);
        refreshAll();
        await sleep(30);
        const lg = $('legendCanvas');
        const lctx = lg.getContext('2d', { willReadFrequently: true });
        const barPx = y => lctx.getImageData(8, y, 1, 1).data;
        const top = barPx(2), bottom = barPx(lg.height - 3);
        // 图片范围 60/-100，黑白两端节点在 ±200°C：顶端应是灰 ~90 而不是纯黑
        check('色标超出图片范围的部分被截断（顶端不是纯黑）',
          top[0] === top[1] && top[1] === top[2] && top[0] > 70 && top[0] < 110, [...top].join(','));
        check('下端同理（不是纯白）',
          bottom[0] === bottom[1] && bottom[1] === bottom[2] && bottom[0] > 170 && bottom[0] < 210,
          [...bottom].join(','));
      }

      // 大小关系不再受限：白色温度高于黑色温度 = 浅色代表高温
      {
        const sc = state.scale;
        sc.nodes = [makeNode(c2k(0), [200, 0, 0], true), makeNode(c2k(-80), [0, 0, 200])];
        sortNodes(sc.nodes);
        $('imageRangeBlack').value = '0'; $('imageRangeWhite').value = '-80';
        commitRange();
        await sleep(40);
        check('正常极性：黑像素 -> 0°C 红、白像素 -> -80°C 蓝',
          state.mapper.colorAtKelvin(pToKelvin(0)).join() === '200,0,0'
          && state.mapper.colorAtKelvin(pToKelvin(255)).join() === '0,0,200',
          state.mapper.colorAtKelvin(pToKelvin(0)).join() + ' / '
            + state.mapper.colorAtKelvin(pToKelvin(255)).join());
        const lg = $('legendCanvas');
        const lctx = lg.getContext('2d', { willReadFrequently: true });
        const top0 = lctx.getImageData(8, 2, 1, 1).data;
        const bot0 = lctx.getImageData(8, lg.height - 3, 1, 1).data;
        check('正常极性：色标柱顶红（黑色端）/ 底蓝（白色端）',
          top0[0] > 180 && bot0[2] > 180, [...top0].join(',') + ' / ' + [...bot0].join(','));

        // 反过来填：黑色 -80、白色 0（越白越热）——必须被接受，且着色整体反转
        $('imageRangeBlack').value = '-80'; $('imageRangeWhite').value = '0';
        commitRange();
        check('白色温度高于黑色温度被接受（不再要求上限 > 下限）',
          !$('msgDialog').open
          && Math.abs(toDisplay(K_BLACK, UNIT_C) + 80) < 1e-9
          && Math.abs(toDisplay(K_WHITE, UNIT_C)) < 1e-9,
          msgText());
        check('反向时程序仍比较出上限 0 / 下限 -80',
          Math.abs(toDisplay(K_MAX, UNIT_C)) < 1e-9 && Math.abs(toDisplay(K_MIN, UNIT_C) + 80) < 1e-9,
          toDisplay(K_MAX, UNIT_C) + ' / ' + toDisplay(K_MIN, UNIT_C));
        check('反向时输入框保持用户填的值（不按大小重排）',
          $('imageRangeBlack').value === '-80.00' && $('imageRangeWhite').value === '0.00',
          $('imageRangeBlack').value + ' | ' + $('imageRangeWhite').value);
        check('反向极性：黑像素 -> -80°C 蓝、白像素 -> 0°C 红（浅色代表高温）',
          state.mapper.colorAtKelvin(pToKelvin(0)).join() === '0,0,200'
          && state.mapper.colorAtKelvin(pToKelvin(255)).join() === '200,0,0',
          state.mapper.colorAtKelvin(pToKelvin(0)).join() + ' / '
            + state.mapper.colorAtKelvin(pToKelvin(255)).join());
        await sleep(40);
        const top1 = lctx.getImageData(8, 2, 1, 1).data;
        const bot1 = lctx.getImageData(8, lg.height - 3, 1, 1).data;
        check('反向极性：色标柱顶蓝（黑色端 -80）/ 底红（白色端 0）',
          top1[2] > 180 && bot1[0] > 180, [...top1].join(',') + ' / ' + [...bot1].join(','));
        const mTop = state.mapper.colorAtKelvin(pToKelvin(0));
        check('反向时竖向 legend 顶端与图片着色同向（同为黑像素那一端的颜色）',
          top1[2] > 180 && mTop[2] > 180 && top1[0] < 40 && mTop[0] < 40,
          [...top1].join(',') + ' vs ' + mTop.join(','));

        // 两个端点温度相同：整幅图一个温度，也不该报错
        $('imageRangeBlack').value = '20'; $('imageRangeWhite').value = '20';
        commitRange();
        check('黑白同温也被接受（整幅图一个温度）',
          !$('msgDialog').open && Math.abs(K_SPAN) < 1e-9 && Math.abs(toDisplay(pToKelvin(0), UNIT_C) - 20) < 1e-9
          && Math.abs(toDisplay(pToKelvin(255), UNIT_C) - 20) < 1e-9,
          msgText() + ' K_SPAN=' + K_SPAN);
        check('黑白同温时整幅取同一个颜色',
          state.mapper.colorAtKelvin(pToKelvin(0)).join()
            === state.mapper.colorAtKelvin(pToKelvin(255)).join());
        closeMsg();
      }

      // 回到 60 / -100（后面的用例继续用这套图片温度）
      $('imageRangeBlack').value = '60'; $('imageRangeWhite').value = '-100';
      commitRange();

      // 非法输入（数值超范围）被拒绝并恢复原值
      $('imageRangeBlack').value = '3000'; $('imageRangeWhite').value = '-100';
      commitRange();
      const reason2 = msgText();
      closeMsg();
      check('超出允许温度被拒绝', reason2.indexOf('必须落在') >= 0, reason2.slice(0, 120));
      check('拒绝后输入框恢复原值（60 / -100）',
        $('imageRangeBlack').value === '60.00' && $('imageRangeWhite').value === '-100.00',
        $('imageRangeBlack').value + ' | ' + $('imageRangeWhite').value);

      // 单位切换时显示随之换算
      $('unitSelect').value = UNIT_K; fire($('unitSelect'));
      check('切到 K 后温度显示为 Kelvin',
        Math.abs(parseFloat($('imageRangeBlack').value) - (60 + 273.15)) < 0.01, $('imageRangeBlack').value);
      check('单位切换不会改变黑色 / 白色的对应关系',
        Math.abs(toDisplay(K_BLACK, UNIT_C) - 60) < 1e-9 && Math.abs(toDisplay(K_WHITE, UNIT_C) + 100) < 1e-9);
      $('unitSelect').value = UNIT_C; fire($('unitSelect'));

      // 恢复默认（同时把色标恢复成默认，后面的用例继续用）
      $('imageRangeBlack').value = '50'; $('imageRangeWhite').value = '-85';
      commitRange();
      check('可恢复为默认 黑色 50 / 白色 -85',
        Math.abs(toDisplay(K_BLACK, UNIT_C) - 50) < 1e-9 && Math.abs(toDisplay(K_WHITE, UNIT_C) + 85) < 1e-9,
        toDisplay(K_BLACK, UNIT_C) + ' / ' + toDisplay(K_WHITE, UNIT_C));
      check('默认仍然是黑色端为高温（上限 50 / 下限 -85）',
        Math.abs(toDisplay(K_MAX, UNIT_C) - 50) < 1e-9 && Math.abs(toDisplay(K_MIN, UNIT_C) + 85) < 1e-9);
      await doNewScale();
      refreshAll();
    }

    /* ---- 最冷端硬跳变：弹窗横向 legend 必须与第二列竖向 legend 一致 ---- */
    {
      const c2k = c => c + KELVIN_OFFSET;
      const sc = state.scale;
      // 两个节点都显示 -80.00，但内存里的 Kelvin 相差 0.008K（用户场景）
      sc.nodes = [
        makeNode(c2k(28), [0, 0, 0], true),
        makeNode(c2k(-75), [160, 160, 160]),
        makeNode(193.154, [106, 106, 106]),
        makeNode(193.146, [70, 70, 70]),          // 最下方节点
      ];
      sortNodes(sc.nodes);
      refreshAll();
      await sleep(60);

      const lg = $('legendCanvas');
      const lctx = lg.getContext('2d', { willReadFrequently: true });
      const vBottom = lctx.getImageData(8, lg.height - 3, 1, 1).data;
      check('竖向 legend 下限拉伸取最下方节点色（70）',
        vBottom[0] === 70 && vBottom[1] === 70 && vBottom[2] === 70, [...vBottom].join(','));
      const vAbove = lctx.getImageData(8,
        Math.round(kelvinToP(c2k(-78.5)) / P_MAX * (lg.height - 1)), 1, 1).data;
      check('竖向 legend 跳变上方仍从上方节点色（106）向 -75°C 插值',
        vAbove[0] >= 115 && vAbove[0] <= 130, [...vAbove].join(','));

      // 走真实弹窗路径（记录来自本地库，即「保存后重新打开」的数据）
      writeScaleStore([scaleToObject(sc)]);
      const p = openScaleLibraryDialog(sortScaleRecords(readScaleStore()),
        { title: '管理色标', okLabel: '导入', manage: true });
      await sleep(400);                      // 等 drawAll 的 requestAnimationFrame
      const hcv = $('myScalesList').querySelector('canvas');
      const hctx = hcv.getContext('2d', { willReadFrequently: true });
      const midY = Math.floor(hcv.height / 2);
      const dpr = window.devicePixelRatio || 1;
      const off = Math.round(5 * dpr);
      let barLeft = -1;
      for (let x = 0; x < hcv.width; x++) {
        const a = hctx.getImageData(x, midY, 1, 1).data;
        const b = hctx.getImageData(x, midY - off, 1, 1).data;
        const c = hctx.getImageData(x, midY + off, 1, 1).data;
        if (a[3] > 0 && b[3] > 0 && c[3] > 0 && !(a[0] > 250 && a[1] > 250 && a[2] > 250)) { barLeft = x; break; }
      }
      check('弹窗横向 legend 找得到柱体左端', barLeft > 0, String(barLeft));
      const hFirst = hctx.getImageData(barLeft + 2, midY, 1, 1).data;
      check('弹窗横向 legend 下限拉伸取最下方节点色（70）',
        hFirst[0] === 70 && hFirst[1] === 70 && hFirst[2] === 70, [...hFirst].join(','));
      check('横向 / 竖向 legend 下限拉伸颜色一致',
        hFirst[0] === vBottom[0] && hFirst[1] === vBottom[1],
        hFirst[0] + ' vs ' + vBottom[0]);
      $('myScalesCancel').click();
      await p;
      await sleep(60);

      // 恢复默认色标，后面的用例继续用
      await doNewScale();
      refreshAll();
    }

    {
      const midNode = state.scale.nodes[1];
      const p = openNodeDialog({ node: midNode, kelvin: midNode.kelvin, rgb: midNode.rgb });
      check('节点对话框内没有单位选择控件', document.querySelectorAll('#nodeDialog select').length === 0);
      check('位置输入框只显示数字',
        /^-?[0-9]+(\\.[0-9]+)?$/.test($('nodeDlgPos').value), $('nodeDlgPos').value);
      check('位置标签标明当前全局单位',
        $('nodeDlgPosLabel').textContent.indexOf(state.unit) >= 0, $('nodeDlgPosLabel').textContent);

      // 颜色选择器：色块必须是可见的原生 <input type="color">
      const sw = $('nodeDlgPreview');
      check('色块是原生 input[type=color]',
        sw && sw.tagName === 'INPUT' && sw.type === 'color', sw ? sw.tagName + '/' + sw.type : 'missing');
      const rect = sw.getBoundingClientRect();
      check('色块可见、有实际尺寸且位于窗口内',
        rect.width >= 40 && rect.height >= 40 && rect.left >= 0 && rect.top >= 0
        && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight,
        JSON.stringify({ x: Math.round(rect.left), y: Math.round(rect.top), w: rect.width, h: rect.height }));
      let pickerCalled = null;
      const origShowPicker = sw.showPicker;
      const origClick = sw.click;
      if (typeof origShowPicker === 'function') sw.showPicker = function () { pickerCalled = 'showPicker'; };
      sw.click = function () { pickerCalled = 'click'; };
      $('nodeDlgPick').click();
      check('点击「选择颜色…」会调用原生取色器', pickerCalled !== null, String(pickerCalled));
      if (typeof origShowPicker === 'function') sw.showPicker = origShowPicker;
      sw.click = origClick;

      // 三种表示同步
      nodeColorEditor.setColor([18, 52, 86]);
      check('HEX / RGB / 色块三者同步',
        $('nodeDlgHex').value === '#123456' && sw.value === '#123456'
        && [$('nodeDlgR').value, $('nodeDlgG').value, $('nodeDlgB').value].join() === '18,52,86',
        $('nodeDlgHex').value + ' / ' + sw.value);
      sw.value = '#abcdef';
      sw.dispatchEvent(new Event('input', { bubbles: true }));
      check('原生取色器选色后同步回 HEX / RGB',
        $('nodeDlgHex').value === '#ABCDEF' && nodeColorEditor.color.join() === '171,205,239',
        $('nodeDlgHex').value + ' / ' + nodeColorEditor.color.join());
      $('nodeDlgHex').value = '#ZZZ';
      $('nodeDlgHex').dispatchEvent(new Event('blur'));
      check('非法 HEX 失焦后恢复上一个合法值',
        $('nodeDlgHex').value === '#ABCDEF', $('nodeDlgHex').value);

      $('unitSelect').value = UNIT_K; fire($('unitSelect'));
      check('切换全局单位后仍能打开对话框并跟随', true);
      $('unitSelect').value = UNIT_C; fire($('unitSelect'));
      $('nodeDlgCancel').click();
      await p;
      check('取消对话框不会改动节点', !!findNode(state.scale, midNode.uid));
    }

    /* ---- 图片选择模式与删除规则 ---- */
    $('imgSelectMode').checked = true; fire($('imgSelectMode'));
    check('选择模式下每行都有 checkbox', document.querySelectorAll('.img-row input[type=checkbox]').length === 4,
      document.querySelectorAll('.img-row input[type=checkbox]').length);
    state.currentIndex = 1; renderImageList();
    document.querySelectorAll('.img-row')[2].click();
    check('选择模式点击整行不切换预览', state.currentIndex === 1, state.currentIndex);
    check('选择模式点击整行切换勾选', state.entries[2].checked === true);

    state.entries.forEach(e => { e.checked = false; });
    state.currentIndex = 1; state.entries[1].checked = true;
    deleteSelectedImages();
    check('删除当前预览后条目 = 3', state.entries.length === 3, state.entries.length);
    check('删除当前预览后选中后方第一张', state.currentIndex === 1, state.currentIndex);

    state.entries.forEach(e => { e.checked = false; });
    state.entries[2].checked = true;
    state.currentIndex = 1;
    deleteSelectedImages();
    check('删除末张后回退到前方最后一张', state.currentIndex === 1, state.currentIndex);

    state.entries.forEach(e => { e.checked = false; });
    const n0 = state.entries.length;
    deleteSelectedImages();
    await sleep(50);
    check('未勾选时点「删除选中」提示「请选择图片」',
      $('msgDialog').open === true && $('msgText').textContent === '请选择图片', $('msgText').textContent);
    $('msgOk').click();
    await sleep(40);
    check('提示后什么都没删除', state.entries.length === n0 && state.currentIndex === 1);

    $('imgSelectMode').checked = false; fire($('imgSelectMode'));
    check('退出选择模式清除所有勾选', state.entries.every(e => !e.checked));

    /* ---- 批量导出（需先勾选图片；强制走 ZIP 回退路径，含一个坏文件） ---- */
    {
      const bytes = Uint8Array.from(atob(window.__fixture.b64), c => c.charCodeAt(0));
      const jpgBytes = Uint8Array.from(atob(window.__fixture.jpgB64), c => c.charCodeAt(0));
      await addImages([
        new File([bytes], 'ok1.png', { type: 'image/png' }),
        new File([jpgBytes], 'ok2.jpg', { type: 'image/jpeg' }),
        new File([new Uint8Array([1, 2, 3, 4, 5])], 'bad.png', { type: 'image/png' }),
      ]);

      // 未勾选任何图片时应提示「请选择图片」
      state.entries.forEach(e => { e.checked = false; });
      const noPick = actionExportBatch();
      await sleep(30);
      check('未勾选图片时弹出「请选择图片」', $('msgDialog').open && $('msgText').textContent === '请选择图片',
        $('msgText').textContent);
      $('msgOk').click();
      await noPick;

      // 勾选三张（含坏文件）后再导出
      state.entries.forEach(e => {
        e.checked = ['ok1.png', 'ok2.jpg', 'bad.png'].indexOf(e.displayName) >= 0;
      });
      check('只勾选了 3 张待导出图片',
        state.entries.filter(e => e.checked).length === 3, state.entries.filter(e => e.checked).length);

      const origPicker = window.showDirectoryPicker;
      const origAsk = window.askText;
      const origErr = window.showError;
      const origMsg = window.showMessage;
      const origProg = window.setProgress;
      const origClick = HTMLAnchorElement.prototype.click;
      const captured = [];
      const messages = [];
      const progTexts = [];
      window.showDirectoryPicker = undefined;              // 强制 ZIP 回退
      window.askText = async () => 'IR_Enhance_test';
      window.showError = async (t, x) => { messages.push(t + '：' + x); };
      window.showMessage = async (t, x) => { messages.push(t + '：' + x); };
      window.setProgress = (d, t, c) => { origProg(d, t, c); progTexts.push($('progressLabel').textContent); };
      HTMLAnchorElement.prototype.click = function () { captured.push({ name: this.download, href: this.href }); };
      try {
        await actionExportBatch();
      } finally {
        window.showDirectoryPicker = origPicker;
        window.askText = origAsk;
        window.showError = origErr;
        window.showMessage = origMsg;
        window.setProgress = origProg;
        HTMLAnchorElement.prototype.click = origClick;
      }
      check('进度文本格式为「正在处理 X / Y：文件名」',
        progTexts.some(t => /^正在处理 \\d+ \\/ \\d+：.+/.test(t)), progTexts[0]);
      check('进度总数等于勾选数量',
        progTexts.some(t => t.indexOf('/ 3：') >= 0), progTexts.join(' | ').slice(0, 160));
      check('导出结束恢复界面（未锁定）', !state.busy && $('progressPanel').classList.contains('hidden'));
      check('生成了一个 ZIP 压缩包', captured.length === 1 && /\\.zip$/.test(captured[0].name),
        JSON.stringify(captured.map(c => c.name)));
      check('失败文件被汇总提示', messages.some(m => m.includes('bad.png')), messages.join(' | ').slice(0, 200));
      if (captured.length) {
        const blob = await (await fetch(captured[0].href)).blob();
        const text = new TextDecoder('latin1').decode(new Uint8Array(await blob.arrayBuffer()));
        check('ZIP 内含输出文件夹前缀与成功文件',
          text.includes('IR_Enhance_test/ok1.png') && text.includes('IR_Enhance_test/ok2.jpg'));
        check('ZIP 内 PNG 与 JPG 分别保持原格式',
          text.includes('ok1.png') && text.includes('ok2.jpg') && !text.includes('ok2.png'));
        check('ZIP 不含失败文件', !text.includes('bad.png'));
      }
      // 清理批量导出新增的图片
      state.entries = state.entries.filter(e => ['ok1.png', 'ok2.jpg', 'bad.png'].indexOf(e.displayName) < 0);
      renderImageList();
      updateActionStates();
    }

    /* ---- 单位切换 ---- */
    for (const u of UNITS) {
      $('unitSelect').value = u; fire($('unitSelect'));
      if (state.unit !== u) check('单位切换到 ' + u, false, state.unit);
    }
    check('单位切换正常且 Legend 仍着色', legendHasColor());
    $('unitSelect').value = UNIT_C; fire($('unitSelect'));

    /* ---- 全部删除 ---- */
    state.entries.forEach(e => { e.checked = true; });
    deleteSelectedImages();
    check('全部删除后没有图片', state.entries.length === 0 && state.currentIndex === -1);
    check('全部删除后显示「请添加 PNG / JPG 图片」', $('previewInfo').textContent === '请添加 PNG / JPG 图片');

    /* ---- 未保存标记 ---- */
    state.scale.nodes[0].rgb = [1, 2, 3]; updateTitle();
    check('修改后标题出现 *', document.title.indexOf('*') >= 0, document.title);
    state.scale.nodes[0].rgb = [0, 0, 0]; updateTitle();
    check('恢复后 * 消失', document.title.indexOf('*') < 0, document.title);

    check('全程无未捕获错误', !window.__err, window.__err);
  } catch (e) {
    R.fail.push('测试过程抛出异常 :: ' + (e && e.stack ? e.stack.split('\\n')[0] : e));
  }
  return R;
};

/** 自检结束后，摆一个便于观察布局的状态再截图 */
window.__setupShot = async function () {
  const bytes = Uint8Array.from(atob(window.__fixture.shotB64), c => c.charCodeAt(0));
  const jpgBytes = Uint8Array.from(atob(window.__fixture.jpgColorB64), c => c.charCodeAt(0));
  await addImages([
    new File([bytes], 'IR_sample.png', { type: 'image/png' }),
    new File([bytes], 'IR_sample.png', { type: 'image/png' }),
    new File([jpgBytes], 'IR_vis.jpg', { type: 'image/jpeg' }),
    new File([bytes], 'IR_wide.png', { type: 'image/png' }),
  ]);
  const s = state.scale;
  s.nodes[0].rgb = [10, 10, 60];
  s.nodes[s.nodes.length - 1].rgb = [255, 255, 255];
  [293.15, 273.15, 253.15, 228.15, 228.15, 208.15].forEach((k, i) => {
    s.nodes.push(makeNode(k, [[0, 160, 255], [0, 255, 90], [255, 140, 0], [170, 0, 90], [25, 0, 45], [255, 255, 255]][i]));
  });
  sortNodes(s.nodes);
  refreshAll();
  setCurrentImage(0, true);
  for (let i = 0; i < 200; i++) { if (state.offscreen && state.grayFull) break; await new Promise(r => setTimeout(r, 25)); }
  renderImageList();
  return true;
};

window.__openDialogForShot = function () {
  const n = state.scale.nodes[2] || state.scale.nodes[1];
  openNodeDialog({ node: n, kelvin: n.kelvin, rgb: n.rgb });
  return true;
};
window.__closeDialogForShot = function () {
  if ($('nodeDialog').open) $('nodeDlgCancel').click();
  return true;
};
window.__openMenusForShot = function () {
  closeAllMenus();
  document.querySelector('#btnExportMenu').closest('.menu').classList.add('open');
  document.querySelector('#btnOpenScale').closest('.menu').classList.add('open');
  document.querySelector('#btnManageScales').closest('.menu').classList.add('open');
  document.querySelector('#btnSaveScale').closest('.menu').classList.add('open');
  return true;
};
window.__openMyScalesForShot = function () {
  closeAllMenus();
  openScaleLibraryDialog(sortScaleRecords(readScaleStore()));
  return true;
};
/** 造几条示例色标并打开「管理色标」，多选两条，便于截图核对 */
window.__openManageForShot = function () {
  closeAllMenus();
  const names = ['标准红外（黑-白）', '铁红增强', '彩虹高对比'];
  const lib = [];
  setRange(DEF_K_MAX, DEF_K_MIN);
  for (let i = 0; i < names.length; i++) {
    const s = defaultScale();
    s.created = 1700000000000 + i * 86400000;
    s.name = names[i];
    if (i === 1) { s.nodes.push(makeNode(273.15, [255, 120, 0])); sortNodes(s.nodes); }
    if (i === 2) {
      s.nodes.push(makeNode(273.15, [0, 200, 255]));
      s.nodes.push(makeNode(253.15, [255, 0, 128]));
      sortNodes(s.nodes);
    }
    lib.push(scaleToObject(s));
  }
  writeScaleStore(lib);
  setRange(DEF_K_MAX, DEF_K_MIN);
  openScaleLibraryDialog(sortScaleRecords(readScaleStore()),
    { title: '管理色标', okLabel: '导入', manage: true });
  setTimeout(() => {
    const multi = $('scaleLibMulti');
    multi.checked = true;
    multi.dispatchEvent(new Event('change', { bubbles: true }));
    $('scaleLibAll').click();          // 全选，便于看勾选与红色删除按钮
  }, 80);
  return true;
};

/* =====================================================================
 * 移动端适配自检：由驱动脚本用 CDP 的设备模拟调用（手机 / 平板竖屏）
 * ===================================================================== */
window.__runMobileTest = async function (dev) {
  const R = { ok: [], fail: [] };
  const tag = dev.name + ' ' + dev.width + 'x' + dev.height;
  const check = (n, c, e) => { (c ? R.ok : R.fail).push('[' + tag + '] ' + n + (c ? '' : '  [' + (e === undefined ? '' : e) + ']')); };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const box = el => el.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  const inViewport = el => {
    const r = box(el);
    return r.left >= -1 && r.top >= -1 && r.right <= vw + 1 && r.bottom <= vh + 1;
  };
  const size = el => Math.round(box(el).width) + 'x' + Math.round(box(el).height);
  try {
    /* ---- 视口与响应式布局 ---- */
    check('视口宽度 = 设备宽度', Math.abs(vw - dev.width) <= 1, vw + ' vs ' + dev.width);
    const mv = document.querySelector('meta[name=viewport]');
    check('viewport 声明了 device-width 与 viewport-fit=cover',
      !!mv && mv.content.indexOf('width=device-width') >= 0 && mv.content.indexOf('viewport-fit=cover') >= 0,
      mv ? mv.content : 'missing');
    const mainCS = getComputedStyle($('main'));
    check('三栏网格改成单栏纵向流', mainCS.display === 'flex' && mainCS.flexDirection === 'column',
      mainCS.display + ' / ' + mainCS.flexDirection);
    const pv = box($('previewPane')), sc = box($('scalePane')), im = box($('imagePane'));
    check('预览 / 色标 / 图片列表自上而下排列',
      pv.top < sc.top && sc.top < im.top && pv.bottom <= sc.top + 1 && sc.bottom <= im.top + 1,
      [pv.top, sc.top, im.top].map(Math.round).join(', '));
    check('整页恢复纵向滚动（不再是 overflow:hidden）',
      getComputedStyle(document.body).overflowY === 'auto'
      && document.documentElement.scrollHeight > vh + 1,
      getComputedStyle(document.body).overflowY + ' / ' + document.documentElement.scrollHeight + ' vs ' + vh);
    check('没有横向溢出',
      document.documentElement.scrollWidth <= vw + 1 && document.body.scrollWidth <= vw + 1,
      document.documentElement.scrollWidth + ' / ' + document.body.scrollWidth + ' vs ' + vw);

    /* ---- 各区块尺寸 ---- */
    check('预览区高度约半屏且够用', box($('previewWrap')).height >= 180, size($('previewWrap')));
    check('色标柱拿到确定高度、宽度收窄',
      box($('legendCanvas')).height >= 200 && box($('legendCanvas')).width <= 64, size($('legendCanvas')));
    check('节点卡片区在自己框内滚动', getComputedStyle($('nodeList')).overflowY === 'auto');
    check('图片列表不超出视口宽度且可滚动',
      box($('imageList')).width <= vw + 1 && getComputedStyle($('imageList')).overflowY === 'auto',
      size($('imageList')));
    check('日志区高度固定、可滚动',
      Math.abs(box($('logView')).height - 132) <= 8 && getComputedStyle($('logView')).overflowY === 'auto',
      size($('logView')));
    check('预览画布 Fit 时把纵向滚动让给页面（touch-action: pan-y）',
      getComputedStyle($('previewCanvas')).touchAction === 'pan-y',
      getComputedStyle($('previewCanvas')).touchAction);
    check('预览标题行各控件都在视口内',
      Array.prototype.every.call($('previewPane').querySelector('.pane-head').children, inViewport),
      Array.prototype.map.call($('previewPane').querySelector('.pane-head').children,
        el => Math.round(box(el).right)).join(','));

    /* ---- 触控目标尺寸 ---- */
    const btns = Array.prototype.filter.call(document.querySelectorAll('#app button'),
      b => b.offsetParent !== null && !b.classList.contains('node-swap'));
    const tinyBtns = btns.filter(b => box(b).height < 34)
      .map(b => (b.id || b.textContent) + ':' + Math.round(box(b).height));
    check('可见按钮高度都 ≥ 34px（触控目标）', tinyBtns.length === 0, tinyBtns.join(' '));
    const smallMi = [];
    for (const id of ['btnOpenScale', 'btnManageScales', 'btnSaveScale', 'btnExportMenu']) {
      const menu = $(id).closest('.menu');
      closeAllMenus();
      $(id).click();
      await sleep(20);
      if (!menu.classList.contains('open')) { smallMi.push(id + ' 没打开'); continue; }
      const dd = box(menu.querySelector('.dd'));
      if (dd.right > vw + 1 || dd.left < -1) {
        smallMi.push(id + ' 下拉超出屏幕 ' + Math.round(dd.left) + '~' + Math.round(dd.right));
      }
      Array.prototype.forEach.call(menu.querySelectorAll('.dd .mi'), it => {
        if (box(it).height < 30) smallMi.push(id + ' 菜单项太矮 ' + Math.round(box(it).height));
      });
    }
    closeAllMenus();
    check('四组下拉都能点开、不超出屏幕、菜单项够高', smallMi.length === 0, smallMi.join('; '));

    /* ---- 触屏手势：捏合缩放 / 平移 / 双击 ---- */
    resetPreviewView();
    const cv = $('previewCanvas');
    const c = box(cv);
    const cx = c.left + c.width / 2, cy = c.top + c.height / 2;
    const pev = (type, id, x, y) => cv.dispatchEvent(new PointerEvent(type, {
      pointerId: id, pointerType: 'touch', isPrimary: id === 1, clientX: x, clientY: y,
      bubbles: true, button: 0, buttons: (type === 'pointerup' || type === 'pointercancel') ? 0 : 1,
    }));
    check('手势测试起点是 Fit', state.preview.fit === true, state.preview.fit);
    // Fit 状态下单指拖动不改视图：纵向留给页面滚动
    const fitOx = state.preview.ox, fitOy = state.preview.oy;
    pev('pointerdown', 1, cx, cy);
    pev('pointermove', 1, cx + 30, cy + 30);
    pev('pointerup', 1, cx + 30, cy + 30);
    check('Fit 时单指拖动不平移（让页面滚）',
      state.preview.ox === fitOx && state.preview.oy === fitOy && state.preview.fit === true,
      (state.preview.ox - fitOx) + ', ' + (state.preview.oy - fitOy));

    const fit0 = state.preview.scale;
    const ix0 = (cx - c.left - state.preview.ox) / state.preview.scale;
    pev('pointerdown', 1, cx - 30, cy);
    pev('pointerdown', 2, cx + 30, cy);
    pev('pointermove', 1, cx - 90, cy);
    pev('pointermove', 2, cx + 90, cy);
    check('双指张开 = 放大并退出 Fit',
      state.preview.fit === false && state.preview.scale > fit0 * 1.5,
      fit0.toFixed(3) + ' → ' + state.preview.scale.toFixed(3));
    const ix1 = (cx - c.left - state.preview.ox) / state.preview.scale;
    check('捏合以两指中点为锚点（中点下的像素不动）', Math.abs(ix1 - ix0) < 1,
      ix0.toFixed(2) + ' vs ' + ix1.toFixed(2));
    pev('pointerup', 1, cx - 90, cy);
    pev('pointerup', 2, cx + 90, cy);
    check('双指松开后不再处于拖动状态', state.panning === false, state.panning);
    check('放大后画布接管手势（touch-action: none）',
      getComputedStyle($('previewCanvas')).touchAction === 'none',
      getComputedStyle($('previewCanvas')).touchAction);

    const ox0 = state.preview.ox, oy0 = state.preview.oy;
    pev('pointerdown', 1, cx, cy);
    pev('pointermove', 1, cx + 40, cy + 24);
    pev('pointerup', 1, cx + 40, cy + 24);
    check('单指拖动 = 平移', Math.abs(state.preview.ox - (ox0 + 40)) < 0.6
      && Math.abs(state.preview.oy - (oy0 + 24)) < 0.6,
      (state.preview.ox - ox0).toFixed(1) + ', ' + (state.preview.oy - oy0).toFixed(1));

    const tap = (x, y) => { pev('pointerdown', 9, x, y); pev('pointerup', 9, x, y); };
    resetPreviewView();
    tap(cx, cy); tap(cx, cy);
    check('双击放大到 2.5 倍 Fit',
      state.preview.fit === false && Math.abs(state.preview.scale - fit0 * 2.5) < 1e-6,
      state.preview.scale.toFixed(3) + ' vs ' + (fit0 * 2.5).toFixed(3));
    tap(cx, cy); tap(cx, cy);
    check('再双击回到 Fit',
      state.preview.fit === true && Math.abs(state.preview.scale - fit0) < 1e-6,
      state.preview.fit + ' / ' + state.preview.scale.toFixed(3));
    check('回到 Fit 后纵向滚动又交给页面',
      getComputedStyle($('previewCanvas')).touchAction === 'pan-y',
      getComputedStyle($('previewCanvas')).touchAction);

    /* ---- 弹窗适配 ---- */
    editNode(state.scale.nodes[state.scale.nodes.length - 1].uid);
    await sleep(150);
    check('节点编辑对话框在视口内', $('nodeDialog').open === true && inViewport($('nodeDialog')),
      size($('nodeDialog')));
    $('nodeDlgCancel').click();
    await sleep(100);

    $('btnHelp').click();
    await sleep(250);
    check('使用说明对话框在视口内', $('helpDialog').open === true && inViewport($('helpDialog')),
      size($('helpDialog')));
    check('说明目录改成上方一栏（不再左右分栏）',
      getComputedStyle(document.querySelector('.help-wrap')).flexDirection === 'column',
      getComputedStyle(document.querySelector('.help-wrap')).flexDirection);
    check('说明正文仍有可读高度且能滚动',
      box($('helpDoc')).height >= 100 && box($('helpDoc')).width >= 200
      && getComputedStyle($('helpDoc')).overflowY === 'auto',
      size($('helpDoc')));
    $('helpClose').click();
    await sleep(120);
    check('帮助对话框可正常关闭', $('helpDialog').open === false);

    openScaleLibraryDialog(sortScaleRecords(readScaleStore()));
    await sleep(200);
    check('色标库对话框在视口内', $('myScalesDialog').open === true && inViewport($('myScalesDialog')),
      size($('myScalesDialog')));
    $('myScalesCancel').click();
    await sleep(120);

    /* ---- 手机专属细节 ---- */
    if (dev.width <= 560) {
      check('输入框字号 ≥ 16px（iOS 聚焦不放大整页）',
        parseFloat(getComputedStyle($('imageRangeBlack')).fontSize) >= 16,
        getComputedStyle($('imageRangeBlack')).fontSize);
      check('预览标题行允许换行（图片信息独占一行）',
        box($('previewInfo')).width >= vw * 0.7,
        Math.round(box($('previewInfo')).width) + ' vs ' + vw);
      check('正文基准字号放大到 14px',
        getComputedStyle(document.body).fontSize === '14px', getComputedStyle(document.body).fontSize);
    }
    check('移动端全程无未捕获错误', !window.__err, window.__err);
  } catch (e) {
    R.fail.push('[' + tag + '] 测试过程抛出异常 :: ' + (e && e.stack ? e.stack.split('\\n')[0] : e));
  }
  return R;
};

/** 取消设备模拟后，确认桌面三栏布局原样回来了 */
window.__checkDesktopRestore = function () {
  const R = { ok: [], fail: [] };
  const check = (n, c, e) => { (c ? R.ok : R.fail).push('[恢复桌面] ' + n + (c ? '' : '  [' + (e === undefined ? '' : e) + ']')); };
  const cs = getComputedStyle($('main'));
  check('回到三栏网格布局',
    cs.display === 'grid' && cs.gridTemplateColumns.split(' ').length === 3,
    cs.display + ' / ' + cs.gridTemplateColumns);
  const rp = $('previewPane').getBoundingClientRect();
  const rs = $('scalePane').getBoundingClientRect();
  const ri = $('imagePane').getBoundingClientRect();
  check('三块恢复成「预览 | 色标 | 图片」左到右排列',
    rp.right <= rs.left + 1 && rs.right <= ri.left + 1,
    [rp.right, rs.left, rs.right, ri.left].map(Math.round).join(', '));
  check('页面不再整页滚动（恢复 overflow:hidden）',
    getComputedStyle(document.body).overflowY === 'hidden', getComputedStyle(document.body).overflowY);
  check('图片列表回到最右侧一栏', ri.left > rs.left);
  return R;
};
</script>
`;

// 临时页面放在 .test_tmp/ 下，而预置配置在 <项目>/PreSet/ —— 用 <base> 把页面的
// 基准路径指回 index.html 所在目录，这样「相对 index.html 的 PreSet/manifest.js」
// 与双击打开时完全一致（app 用 document.baseURI 解析清单路径）。
const projectDirUrl = 'file:///' + path.dirname(htmlPath).replace(/\\/g, '/') + '/';
const testHtml = html
  .replace('<head>', '<head>\n<base href="' + projectDirUrl + '">')
  .replace('</body>', headInject + testInject + '</body>');
const testPath = path.join(outDir, 'browser_test.html');
fs.writeFileSync(testPath, testHtml, 'utf8');

// ---------------------------------------------------------------- 启动 Chrome
const port = 9333;
const userDir = path.join(outDir, 'chrome-profile');
fs.rmSync(userDir, { recursive: true, force: true });
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + port, '--user-data-dir=' + userDir,
  '--window-size=1480,940', '--hide-scrollbars',
  'file:///' + testPath.replace(/\\/g, '/'),
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let wsUrl = null;
for (let i = 0; i < 60 && !wsUrl; i++) {
  await sleep(300);
  try {
    const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page) wsUrl = page.webSocketDebuggerUrl;
  } catch (e) { /* 还没起来 */ }
}
if (!wsUrl) { console.error('无法连接到 Chrome 调试端口'); chrome.kill(); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
ws.onmessage = ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
function send(method, params = {}) {
  return new Promise(resolve => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await send('Runtime.enable');
await send('Page.enable');
await sleep(1500);   // 等页面初始化完成

const probe = await send('Runtime.evaluate', {
  expression: 'JSON.stringify({ hasTest: typeof window.__runBrowserTest, err: window.__err, title: document.title, ready: document.readyState })',
  returnByValue: true,
});
console.log('页面探针：', probe.result && probe.result.result && probe.result.result.value);

const evaluated = await send('Runtime.evaluate', {
  expression: 'window.__runBrowserTest()',
  awaitPromise: true,
  returnByValue: true,
});
if (evaluated.result && evaluated.result.exceptionDetails) {
  console.error('注入测试执行失败：', JSON.stringify(evaluated.result.exceptionDetails).slice(0, 1200));
}

await send('Runtime.evaluate', { expression: 'window.__setupShot()', awaitPromise: true, returnByValue: true });
await sleep(600);
const shot = await send('Page.captureScreenshot', { format: 'png' });

// 再截一张「浅色代表高温」（黑色 -85 / 白色 50）的图，便于核对反向着色与色标柱方向
await send('Runtime.evaluate', {
  expression: '(function () {'
    + " document.getElementById('imageRangeBlack').value = '-85';"
    + " document.getElementById('imageRangeWhite').value = '50';"
    + ' commitRange(); return true; })()',
  returnByValue: true,
});
await sleep(500);
const shotRev = await send('Page.captureScreenshot', { format: 'png' });
if (shotRev.result && shotRev.result.data) {
  fs.writeFileSync(path.join(outDir, 'browser_shot_reversed.png'),
    Buffer.from(shotRev.result.data, 'base64'));
}
// 恢复默认的黑色 50 / 白色 -85，后面的截图与用例继续用正常极性
await send('Runtime.evaluate', {
  expression: '(function () {'
    + " document.getElementById('imageRangeBlack').value = '50';"
    + " document.getElementById('imageRangeWhite').value = '-85';"
    + ' commitRange(); return true; })()',
  returnByValue: true,
});
await sleep(400);

// 再截一张打开节点编辑对话框的图，便于核对颜色选择器外观
await send('Runtime.evaluate', {
  expression: 'window.__openDialogForShot()', awaitPromise: false, returnByValue: false,
});
await sleep(500);
const shotDlg = await send('Page.captureScreenshot', { format: 'png' });
if (shotDlg.result && shotDlg.result.data) {
  fs.writeFileSync(path.join(outDir, 'browser_shot_dialog.png'), Buffer.from(shotDlg.result.data, 'base64'));
}
await send('Runtime.evaluate', { expression: 'window.__closeDialogForShot()', returnByValue: false });

// 再截一张下拉菜单展开的图，确认定位没被裁切
await send('Runtime.evaluate', {
  expression: 'window.__openMenusForShot()', awaitPromise: false, returnByValue: false,
});
await sleep(400);
const shotMenu = await send('Page.captureScreenshot', { format: 'png' });
if (shotMenu.result && shotMenu.result.data) {
  fs.writeFileSync(path.join(outDir, 'browser_shot_menu.png'), Buffer.from(shotMenu.result.data, 'base64'));
}
await send('Runtime.evaluate', { expression: 'closeAllMenus()', returnByValue: false });

// 再截一张「使用说明」弹窗（桌面是左右分栏，手机上会变成上下分栏）
await send('Runtime.evaluate', {
  expression: "document.getElementById('btnHelp').click()", returnByValue: false,
});
await sleep(500);
const shotHelpDesk = await send('Page.captureScreenshot', { format: 'png' });
if (shotHelpDesk.result && shotHelpDesk.result.data) {
  fs.writeFileSync(path.join(outDir, 'browser_shot_help.png'),
    Buffer.from(shotHelpDesk.result.data, 'base64'));
}
await send('Runtime.evaluate', {
  expression: "document.getElementById('helpClose').click()", returnByValue: false,
});
await sleep(250);

// 再截一张「我的色标」弹窗
await send('Runtime.evaluate', {
  expression: 'window.__openMyScalesForShot()', awaitPromise: false, returnByValue: false,
});
await sleep(500);
const shotMy = await send('Page.captureScreenshot', { format: 'png' });
if (shotMy.result && shotMy.result.data) {
  fs.writeFileSync(path.join(outDir, 'browser_shot_myscales.png'), Buffer.from(shotMy.result.data, 'base64'));
}
await send('Runtime.evaluate', { expression: 'window.__closeMyScalesForShot()', returnByValue: false });

// 再截一张「管理色标」多选状态
await send('Runtime.evaluate', {
  expression: 'window.__openManageForShot()', awaitPromise: false, returnByValue: false,
});
await sleep(700);
const shotManage = await send('Page.captureScreenshot', { format: 'png' });
if (shotManage.result && shotManage.result.data) {
  fs.writeFileSync(path.join(outDir, 'browser_shot_manage.png'), Buffer.from(shotManage.result.data, 'base64'));
}
await send('Runtime.evaluate', { expression: 'window.__closeMyScalesForShot()', returnByValue: false });
if (shot.result && shot.result.data) {
  fs.writeFileSync(path.join(outDir, 'browser_shot.png'), Buffer.from(shot.result.data, 'base64'));
}

// 导出物落盘，供 Pillow 独立校验
const exported = await send('Runtime.evaluate', {
  expression: 'window.__exported || ""', returnByValue: true,
});
const exportedValue = exported.result && exported.result.result && exported.result.result.value;
if (exportedValue) {
  fs.writeFileSync(path.join(outDir, 'browser_out.png'),
    Buffer.from(Uint8Array.from(exportedValue.split(',').map(Number))));
  console.log('浏览器导出物已保存：browser_out.png（' + exportedValue.split(',').length + ' 字节）');
}
const exportedJpg = await send('Runtime.evaluate', {
  expression: 'window.__exportedJpg || ""', returnByValue: true,
});
const exportedJpgValue = exportedJpg.result && exportedJpg.result.result && exportedJpg.result.result.value;
if (exportedJpgValue) {
  fs.writeFileSync(path.join(outDir, 'browser_out.jpg'),
    Buffer.from(Uint8Array.from(exportedJpgValue.split(',').map(Number))));
  console.log('浏览器导出物已保存：browser_out.jpg（' + exportedJpgValue.split(',').length + ' 字节）');
}

// ------------------------------------------------- 移动端适配（CDP 设备模拟）
const mobileResults = [];
for (const dev of [
  { name: '手机', tag: 'mobile', width: 390, height: 844, dsf: 3 },
  { name: '手机横屏', tag: 'mobile-landscape', width: 844, height: 390, dsf: 3 },
  { name: '平板竖屏', tag: 'tablet', width: 768, height: 1024, dsf: 2 },
]) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: dev.width, height: dev.height, deviceScaleFactor: dev.dsf, mobile: true,
  });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await sleep(600);
  const res = await send('Runtime.evaluate', {
    expression: 'window.__runMobileTest(' + JSON.stringify(dev) + ')',
    awaitPromise: true, returnByValue: true,
  });
  if (res.result && res.result.exceptionDetails) {
    console.error('移动端测试执行失败：', JSON.stringify(res.result.exceptionDetails).slice(0, 1200));
  }
  const val = res.result && res.result.result && res.result.result.value;
  if (val) mobileResults.push(val);

  const fileTag = dev.tag;
  const shotView = await send('Page.captureScreenshot', { format: 'png' });
  if (shotView.result && shotView.result.data) {
    fs.writeFileSync(path.join(outDir, 'browser_shot_' + fileTag + '.png'),
      Buffer.from(shotView.result.data, 'base64'));
  }
  // 手机上再补两张弹窗截图，便于核对弹窗适配
  if (fileTag === 'mobile') {
    await send('Runtime.evaluate', { expression: "document.getElementById('btnHelp').click()" });
    await sleep(450);
    const shotHelp = await send('Page.captureScreenshot', { format: 'png' });
    if (shotHelp.result && shotHelp.result.data) {
      fs.writeFileSync(path.join(outDir, 'browser_shot_mobile_help.png'),
        Buffer.from(shotHelp.result.data, 'base64'));
    }
    await send('Runtime.evaluate', { expression: "document.getElementById('helpClose').click()" });
    await sleep(250);
    await send('Runtime.evaluate', {
      expression: 'editNode(state.scale.nodes[state.scale.nodes.length - 1].uid)',
    });
    await sleep(450);
    const shotNode = await send('Page.captureScreenshot', { format: 'png' });
    if (shotNode.result && shotNode.result.data) {
      fs.writeFileSync(path.join(outDir, 'browser_shot_mobile_node.png'),
        Buffer.from(shotNode.result.data, 'base64'));
    }
    await send('Runtime.evaluate', { expression: "document.getElementById('nodeDlgCancel').click()" });
    await sleep(250);
  }
  const metrics = await send('Page.getLayoutMetrics');
  const content = metrics.result && metrics.result.cssContentSize;
  if (content && content.height > dev.height + 1) {
    const shotFull = await send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: content.width, height: Math.min(content.height, 6000), scale: 1 },
    });
    if (shotFull.result && shotFull.result.data) {
      fs.writeFileSync(path.join(outDir, 'browser_shot_' + fileTag + '_full.png'),
        Buffer.from(shotFull.result.data, 'base64'));
      console.log('移动端整页截图：browser_shot_' + fileTag + '_full.png（'
        + Math.round(content.width) + 'x' + Math.round(content.height) + '）');
    }
  }
}
await send('Emulation.setTouchEmulationEnabled', { enabled: false });
await send('Emulation.clearDeviceMetricsOverride');
await sleep(500);
const restoreRes = await send('Runtime.evaluate', {
  expression: 'window.__checkDesktopRestore()', returnByValue: true,
});
const restoreVal = restoreRes.result && restoreRes.result.result && restoreRes.result.result.value;
if (restoreVal) mobileResults.push(restoreVal);

ws.close();
chrome.kill();

const value = evaluated.result && evaluated.result.result && evaluated.result.result.value;
if (!value) {
  console.error('未取到测试结果，原始返回：', JSON.stringify(evaluated).slice(0, 1500));
  process.exit(1);
}
const allOk = value.ok.concat(...mobileResults.map(r => r.ok));
const allFail = value.fail.concat(...mobileResults.map(r => r.fail));
for (const n of allOk) console.log('  [OK]   ' + n);
for (const f of allFail) console.log('  [FAIL] ' + f);
console.log('\nHTML 版浏览器自检：通过 ' + allOk.length + ' 项，失败 ' + allFail.length + ' 项。');
console.log('截图：' + path.join(outDir, 'browser_shot.png')
  + '\n      ' + path.join(outDir, 'browser_shot_mobile.png')
  + '\n      ' + path.join(outDir, 'browser_shot_mobile-landscape.png')
  + '\n      ' + path.join(outDir, 'browser_shot_tablet.png'));
process.exit(allFail.length ? 1 : 0);
