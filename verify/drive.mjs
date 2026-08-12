// verify/drive.mjs — 端到端驅動：把 dev/index.html 真的跑起來、操作五張票的 UI 流程、截圖存證。
// 用法（playwright 裝在 scratchpad）：
//   node verify/drive.mjs
// 環境變數：VERIFY_SCRATCH=scratchpad 路徑（預設用本機已知路徑）。
// 斷言失敗不中止：記錄 ❌ 後繼續；結束時輸出逐步結果與 console error 清單。

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..');
const API_PORT = Number(process.env.VERIFY_API_PORT || 8788);
const STATIC_PORT = Number(process.env.VERIFY_STATIC_PORT || 8787);
const SCRATCH = process.env.VERIFY_SCRATCH ||
  'C:/Users/user/AppData/Local/Temp/claude/G---------00Claude-Working-Directory-scc-tutorsys/a7e8c1dd-bdc7-4338-a667-938ec780236c/scratchpad';
const SHOTS = path.join(SCRATCH, 'verify-shots');
const XLSX_REAL = process.env.VERIFY_XLSX ||
  'G:/我的雲端硬碟/00Claude_Working_Directory/forsystems/114-2 班級、家族會議記錄暨班級業務統計.xlsx';

const requireScratch = createRequire(path.join(SCRATCH, 'noop.js'));
const requireRepo = createRequire(path.join(REPO, 'noop.js'));
const { chromium } = requireScratch('playwright');
const { startServers } = requireRepo('./verify/server.js');

// ── 從 dev/index.html 讀出實際常數（不寫死，跟著本體走）──
const indexHtml = fs.readFileSync(path.join(REPO, 'dev', 'index.html'), 'utf8');
const APPS_SCRIPT_URL = indexHtml.match(/const APPS_SCRIPT_URL = '([^']+)'/)[1];
const ROOT_FOLDER_ID = indexHtml.match(/const ROOT_FOLDER_ID\s*=\s*'([^']+)'/)[1];

fs.mkdirSync(SHOTS, { recursive: true });

// ── 結果記錄 ──
const results = [];
const consoleErrors = [];
const dialogs = [];
let shotNo = 0;
function log(mark, flow, msg) {
  const line = `${mark} [${flow}] ${msg}`;
  results.push(line);
  console.log(line);
}
async function shot(page, desc) {
  shotNo++;
  const name = String(shotNo).padStart(2, '0') + '-' + desc + '.png';
  await page.screenshot({ path: path.join(SHOTS, name), fullPage: false });
  console.log('   📸', name);
  return name;
}
async function check(flow, desc, fn) {
  try {
    await fn();
    log('✅', flow, desc);
    return true;
  } catch (e) {
    log('❌', flow, desc + ' —— ' + (e && e.message ? e.message.split('\n')[0] : e));
    return false;
  }
}
function expect(cond, msg) { if (!cond) throw new Error(msg || 'expect failed'); }
// flow 區塊容器：內部未捕捉的例外（操作 timeout 等）記錄後繼續下一個 flow，不中止整程
async function flow(name, fn) {
  try { await fn(); } catch (e) {
    log('❌', name, '流程中斷：' + (e && e.message ? e.message.split('\n')[0] : e));
  }
}

// ── 直打 API 探針 helper ──
async function apiCall(action, params, token) {
  const payload = JSON.stringify(Object.assign({ action, rootFolderId: ROOT_FOLDER_ID, sessionToken: token }, params || {}));
  const res = await fetch(`http://127.0.0.1:${API_PORT}/exec`, { method: 'POST', body: new URLSearchParams({ payload }) });
  return res.json();
}

const servers = startServers();
const adminToken = servers.em.mint('admin@test.local');
const assistantToken = servers.em.mint('assistant@test.local');
const leadToken = servers.em.mint('lead@test.local');       // 學諮中心主責＝最大權限（2026-08-11）

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

// 路由攔截：GAS → 本機 emulator；gsi → stub；SheetJS CDN → 本機 node_modules；ipapi → 空
await context.route(u => u.href.startsWith(APPS_SCRIPT_URL), async (route) => {
  const req = route.request();
  const res = await fetch(`http://127.0.0.1:${API_PORT}/exec`, { method: 'POST', body: req.postData() || '' });
  await route.fulfill({ status: 200, contentType: 'application/json', body: await res.text() });
});
await context.route('https://accounts.google.com/gsi/client*', (route) => route.fulfill({
  status: 200, contentType: 'text/javascript',
  body: 'window.google={accounts:{id:{initialize(){},renderButton(){},disableAutoSelect(){},prompt(){}}}};',
}));
await context.route('https://cdn.sheetjs.com/**', (route) => route.fulfill({
  status: 200, contentType: 'text/javascript',
  body: fs.readFileSync(path.join(SCRATCH, 'node_modules', 'xlsx', 'dist', 'xlsx.full.min.js'), 'utf8'),
}));
await context.route('https://ipapi.co/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));

// 預塞 localStorage（鍵名/形狀照 dev/index.html LS_USER_KEY/LS_SESSION_KEY 與 load 恢復邏輯）
await context.addInitScript(({ rootId, token, exp }) => {
  localStorage.setItem('tutor_user_' + rootId, JSON.stringify({ email: 'admin@test.local', name: '測試管理員', picture: '' }));
  localStorage.setItem('tutor_session_' + rootId, JSON.stringify({ token, exp, email: 'admin@test.local' }));
}, { rootId: ROOT_FOLDER_ID, token: adminToken.token, exp: adminToken.exp });

const page = await context.newPage();
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
page.on('dialog', async (d) => { dialogs.push(d.type() + ': ' + d.message().split('\n')[0]); await d.accept(); });

const evid = {}; // API 探針回應體存證

// ══ 開場：免登入直接進主畫面 ═══════════════════════════════════════════════════
await page.goto(`http://127.0.0.1:${STATIC_PORT}/dev/index.html`);
await check('boot', '載入後直接進主畫面（session 免登入）', async () => {
  await page.locator('#app').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('.nav-btn', { hasText: '後台管理' }).waitFor({ timeout: 10000 });
});
await shot(page, 'boot-主畫面');

// ══ A：按鈕回饋＋checkbox ═══════════════════════════════════════════════════════
await flow('A', async () => {
  await page.locator('.nav-btn', { hasText: '後台管理' }).click();
  await page.locator('[data-admin-tab="colleges"]').click();
  await page.locator('[data-action="college-new"]').waitFor();
  await page.locator('[data-action="college-new"]').click();
  await page.locator('#college-form').waitFor();
  await shot(page, 'A-新增學院表單含停用checkbox');
  await page.locator('#college-form .field label', { hasText: '停用' }).screenshot({ path: path.join(SHOTS, String(++shotNo).padStart(2, '0') + '-A-checkbox特寫.png') });
  await page.fill('#college-name', '測試學院');
  // 正面斷言：#college-id 不再有 required、留空並直接送出，靠程式內「id 留空自動 slugify」
  // 的路徑衍生 id（修法：移除 required、加 placeholder 提示，見回報）。
  await check('A', '學院 ID 欄位無 required 屬性（留空可送出）', async () => {
    const required = await page.locator('#college-id').getAttribute('required');
    expect(required === null, 'required 屬性=' + required);
  });
  await check('A', '學院 ID 欄位有留空提示 placeholder', async () => {
    const ph = await page.locator('#college-id').getAttribute('placeholder');
    expect(ph && ph.includes('自動'), 'placeholder=' + ph);
  });
  expect((await page.locator('#college-id').inputValue()) === '', '#college-id 應維持留空才能驗證自動衍生');
  const saveBtn = page.locator('#college-form button[type=submit]');
  await saveBtn.click();
  await shot(page, 'A-儲存pending態');
  await check('A', '按下儲存後出現「處理中…」pending 態', async () => {
    const txt = await saveBtn.textContent();
    expect(txt.includes('處理中'), '按鈕文字=' + txt);
  });
  await check('A', '儲存成功 toast「已儲存」（留空 ID 未被原生驗證擋下）', async () => {
    await page.locator('.toast', { hasText: '已儲存' }).waitFor({ timeout: 5000 });
  });
  await check('A', '學院列表出現「測試學院」，且 ID 欄非空（自動衍生成功）', async () => {
    const row = page.locator('#admin-tab-content tr', { hasText: '測試學院' });
    await row.waitFor({ timeout: 3000 });
    const idCell = (await row.locator('td').first().textContent() || '').trim();
    evid['A-college-derived-id'] = idCell;
    expect(idCell.length > 0, 'ID 欄=' + JSON.stringify(idCell));
  });
  await shot(page, 'A-學院清單含新列（ID自動衍生）');
});

// ══ B：軟刪除＋fail-closed 探針 ═══════════════════════════════════════════════
await flow('B', async () => {
  const collegeRow = page.locator('#admin-tab-content tr', { hasText: '測試學院' });
  await collegeRow.locator('[data-action="college-delete"]').click();
  await check('B', '刪除學院後列消失（confirm 自動接受）', async () => {
    await page.locator('.toast', { hasText: '已刪除' }).waitFor({ timeout: 5000 });
    await collegeRow.waitFor({ state: 'detached', timeout: 3000 });
  });
  await shot(page, 'B-學院已刪除');

  // 建一個系所再刪，供 classResolve fail-closed 探針
  await page.locator('[data-admin-tab="departments"]').click();
  await page.locator('[data-action="dept-new"]').click();
  await page.locator('#dept-form').waitFor();
  await page.fill('#dept-id', '測試刪除系');
  await page.fill('#dept-name', '測試刪除系');
  await page.locator('#dept-form button[type=submit]').click();
  await page.locator('.toast', { hasText: '已儲存' }).waitFor({ timeout: 5000 });
  const deptRow = page.locator('#admin-tab-content tr', { hasText: '測試刪除系' });
  await deptRow.locator('[data-action="dept-delete"]').click();
  await check('B', '刪除系所後列消失', async () => {
    await deptRow.waitFor({ state: 'detached', timeout: 5000 });
  });
  await shot(page, 'B-系所已刪除');
});
await check('B', '🔍 classResolve 命中已刪除系所名 → fail-closed 拒絕', async () => {
  const r = await apiCall('classResolve', { deptName: '測試刪除系', className: '測試一A' }, adminToken.token);
  evid['B-classResolve-deleted-dept'] = JSON.stringify(r);
  expect(r.success === false && /department disabled/.test(r.error || ''), '回應=' + JSON.stringify(r));
});

// ══ C：導師歷史＋期中更換 ═══════════════════════════════════════════════════════
await flow('C', async () => {
  await page.locator('[data-admin-tab="classes"]').click();
  const clsRowA = page.locator('#admin-tab-content tr', { hasText: '農園系_四技一A' });
  await clsRowA.locator('[data-action="class-history"]').click();
  await check('C', '歷史 modal 顯示「尚無異動紀錄」', async () => {
    await page.locator('#modal-box', { hasText: '尚無異動紀錄' }).waitFor({ timeout: 8000 });
  });
  await shot(page, 'C-歷史尚無異動');
  await page.locator('[data-action="midterm-open"]').click();
  await page.locator('#midterm-form').waitFor();
  await page.fill('#mid-t1-name', '李新師');
  await page.fill('#mid-t1-email', 'lee@test.local');
  await shot(page, 'C-期中更換表單');
  await page.locator('#midterm-form button[type=submit]').click();
  await check('C', '期中更換送出成功 toast', async () => {
    await page.locator('.toast', { hasText: '已更換導師並寫入異動紀錄' }).waitFor({ timeout: 8000 });
  });
  await clsRowA.locator('[data-action="class-history"]').click();
  const todayLabel = (new Date().getMonth() + 1) + '月' + new Date().getDate() + '日更換';
  await check('C', '歷史出現「期中更換」列＋「' + todayLabel + '」', async () => {
    await page.locator('#modal-box td', { hasText: '期中更換' }).first().waitFor({ timeout: 8000 });
    await page.locator('#modal-box td', { hasText: todayLabel }).first().waitFor({ timeout: 2000 });
  });
  await shot(page, 'C-歷史含期中更換列');
  await page.locator('#modal-box [data-action="close-modal"]').click();

  // 編輯加導師2 → 歷史多一筆「手動編輯」
  await clsRowA.locator('[data-action="class-edit"]').click();
  await page.locator('#class-form').waitFor();
  await page.fill('#tutor2-name', '王助教');
  await page.fill('#tutor2-email', 'assistant2@test.local');
  await page.locator('#class-form button[type=submit]').click();
  await page.locator('.toast', { hasText: '已儲存' }).waitFor({ timeout: 8000 });
  await clsRowA.locator('[data-action="class-history"]').click();
  await check('C', '一般編輯改導師後，歷史多一筆「手動編輯」', async () => {
    await page.locator('#modal-box td', { hasText: '手動編輯' }).first().waitFor({ timeout: 8000 });
  });
  await shot(page, 'C-歷史含手動編輯列');
  await page.locator('#modal-box [data-action="close-modal"]').click();
});

// ══ C2：班級管理版面（學院 tabs＋系所分群＋收合/展開，Ticket 班級tab）═══════════
// 種子：農學院（農園系 3 班＋森林系 1 班）、獸醫學院（獸醫系 1 班）。
await flow('C2', async () => {
  await page.locator('[data-admin-tab="classes"]').click();
  await check('C2', '學院 tabs 帶班級數：農學院（4）＋獸醫學院（1）', async () => {
    await page.locator('#admin-tab-content [data-class-tab]').first().waitFor({ timeout: 5000 });
    const tabs = await page.locator('#admin-tab-content [data-class-tab]').allTextContents();
    evid['C2-class-tabs'] = JSON.stringify(tabs);
    expect(tabs.length === 2 && tabs[0] === '農學院（4）' && tabs[1] === '獸醫學院（1）', 'tabs=' + JSON.stringify(tabs));
  });
  await check('C2', '系所群組標題列：農園系（3 班）＋森林系（1 班）', async () => {
    const heads = await page.locator('#admin-tab-content .dept-group-head').allTextContents();
    evid['C2-dept-heads'] = JSON.stringify(heads);
    expect(heads.some((h) => h.includes('農園系（3 班）')), '無農園系標題：' + JSON.stringify(heads));
    expect(heads.some((h) => h.includes('森林系（1 班）')), '無森林系標題：' + JSON.stringify(heads));
  });
  await shot(page, 'C2-班級tab全貌');

  // 收合農園系 → 該組班級列消失、其他組不受影響
  await page.locator('[data-class-dept-toggle="農園系"]').click();
  await check('C2', '收合農園系：該組班級列消失、森林系列仍在', async () => {
    expect((await page.locator('#admin-tab-content tr', { hasText: '農園系_四技一A' }).count()) === 0, '農園系_四技一A 仍可見');
    expect((await page.locator('#admin-tab-content tr', { hasText: '森林系_家族陳美惠' }).count()) === 1, '森林系列消失了');
  });

  // 切 tab 來回 → 收合狀態保留（狀態存模組層級變數非 DOM）
  await page.locator('[data-class-tab="獸醫學院"]').click();
  await check('C2', '獸醫學院 tab：獸醫系（1 班）群組與班級列', async () => {
    await page.locator('#admin-tab-content .dept-group-head', { hasText: '獸醫系（1 班）' }).waitFor({ timeout: 3000 });
    expect((await page.locator('#admin-tab-content tr', { hasText: '獸醫系_四技四A' }).count()) === 1, '獸醫班列不可見');
  });
  await page.locator('[data-class-tab="農學院"]').click();
  await check('C2', '切 tab 來回後：農園系仍收合、森林系仍展開', async () => {
    await page.locator('#admin-tab-content .dept-group-head', { hasText: '農園系' }).waitFor({ timeout: 3000 });
    expect((await page.locator('#admin-tab-content tr', { hasText: '農園系_四技一A' }).count()) === 0, '收合狀態掉了');
    expect((await page.locator('#admin-tab-content tr', { hasText: '森林系_家族陳美惠' }).count()) === 1, '森林系列消失了');
  });
  await shot(page, 'C2-班級tab-收合狀態');

  // 群組內「編輯」開 modal 正常；儲存後重繪仍保留收合
  await page.locator('#admin-tab-content tr', { hasText: '森林系_家族陳美惠' }).locator('[data-action="class-edit"]').click();
  await check('C2', '群組內「編輯」開 modal 正常', async () => {
    await page.locator('#class-form').waitFor({ timeout: 3000 });
  });
  await page.locator('#class-form button[type=submit]').click();
  await check('C2', '編輯儲存後重繪：農園系收合狀態保留', async () => {
    // closeModal 只移除 overlay 的 open class（DOM 保留），等 '#modal-overlay.open' 不再匹配即關閉
    await page.locator('#modal-overlay.open').waitFor({ state: 'detached', timeout: 8000 });
    await page.locator('#admin-tab-content .dept-group-head', { hasText: '農園系' }).waitFor({ timeout: 3000 });
    expect((await page.locator('#admin-tab-content tr', { hasText: '農園系_四技一A' }).count()) === 0, '編輯重繪後收合狀態掉了');
    expect((await page.locator('#admin-tab-content tr', { hasText: '森林系_家族陳美惠' }).count()) === 1, '森林系列消失了');
  });

  // 全部展開／全部收合（作用於當前 tab 的所有系所群組）
  await page.locator('[data-class-expand-all]').click();
  await check('C2', '全部展開：農園系班級列恢復', async () => {
    expect((await page.locator('#admin-tab-content tr', { hasText: '農園系_四技一A' }).count()) === 1, '展開後仍不可見');
  });
  await page.locator('[data-class-collapse-all]').click();
  await check('C2', '全部收合：當前 tab 所有班級列消失（群組標題仍在）', async () => {
    expect((await page.locator('#admin-tab-content tr', { hasText: '農園系_' }).count()) === 0, '農園系列仍可見');
    expect((await page.locator('#admin-tab-content tr', { hasText: '森林系_家族' }).count()) === 0, '森林系列仍可見');
    const heads = await page.locator('#admin-tab-content .dept-group-head').count();
    expect(heads === 2, '群組標題數=' + heads);
  });
  await shot(page, 'C2-班級tab-全部收合');
  await page.locator('[data-class-expand-all]').click();  // 還原展開，避免影響後續流程
});

// ══ D：換學期升級 ═══════════════════════════════════════════════════════════════
await flow('D', async () => {
await page.locator('[data-admin-tab="semesters"]').click();
await page.locator('[data-action="rollover-open"]').click();
await page.locator('#roll-from').waitFor();
await page.selectOption('#roll-from', '114-2');
await page.selectOption('#roll-to', '115-1');
await page.locator('#roll-preview-btn').click();
await check('D', '預覽產生：農園四技一A→四技二A（帶入升級）', async () => {
  const row = page.locator('#roll-preview tr', { hasText: '四農園一A' });
  await row.waitFor({ timeout: 10000 });
  expect(await row.locator('select').inputValue() === 'advance', 'action 非 advance');
  expect(await row.locator('input[data-roll-newname]').inputValue() === '四技二A', 'newName 非四技二A');
});
await check('D', '農園四技四A→畢業；碩二→畢業', async () => {
  expect(await page.locator('#roll-preview tr', { hasText: '四農園四A' }).locator('select').inputValue() === 'graduate', '四技四A 非 graduate');
  expect(await page.locator('#roll-preview tr', { hasText: '碩農園二' }).locator('select').inputValue() === 'graduate', '碩二 非 graduate');
});
await check('D', '獸醫四技四A→四技五A（graduationGrade=5 覆寫）', async () => {
  const row = page.locator('#roll-preview tr', { hasText: '四獸醫四A' });
  expect(await row.locator('select').inputValue() === 'advance', '非 advance');
  expect(await row.locator('input[data-roll-newname]').inputValue() === '四技五A', 'newName 非四技五A');
});
await check('D', '家族陳美惠→keep＋標黃（uncertain）', async () => {
  const row = page.locator('#roll-preview tr', { hasText: '森林家族(陳美惠)' });
  expect(await row.locator('select').inputValue() === 'keep', '非 keep');
  const style = await row.getAttribute('style');
  expect(style && style.includes('warning-bg'), '未標黃：' + style);
});
await shot(page, 'D-升級預覽整表');

// 🔍 撞名探針：把四技一A的新班名改成既有「碩二」→ 套用 → 該列 error、其他列成功
const rowA = page.locator('#roll-preview tr', { hasText: '四農園一A' });
await rowA.locator('input[data-roll-newname]').fill('碩二');
await page.locator('#roll-apply-btn').click();
await check('D', '🔍 套用：撞名列進 errors、其他列成功（改名1/畢業2/保留1/失敗1）', async () => {
  await page.locator('#roll-preview', { hasText: '套用完成' }).waitFor({ timeout: 10000 });
  const txt = await page.locator('#roll-preview').textContent();
  expect(txt.includes('改名 1 班'), '摘要=' + txt.slice(0, 200));
  expect(txt.includes('畢業 2 班'), '畢業數不符');
  expect(/already exists|failed|失敗 1/.test(txt), '無失敗列');
});
await shot(page, 'D-套用結果摘要含撞名失敗');
await page.locator('#modal-box [data-action="close-modal"]').last().click();

await page.locator('[data-admin-tab="classes"]').click();
await page.locator('[data-class-tab="獸醫學院"]').click();  // 獸醫班在獸醫學院分頁
await check('D', '班級列表（獸醫學院 tab）：獸醫班已改名四技五A', async () => {
  await page.locator('#admin-tab-content tr', { hasText: '四技五A' }).waitFor({ timeout: 5000 });
});
await shot(page, 'D-班級列表改名生效');
await check('D', '🔍 overviewStats(114-2) 回舊班名（nameHistory 生效）', async () => {
  const r = await apiCall('overviewStats', { semester: '114-2' }, adminToken.token);
  evid['D-overviewStats-114-2'] = JSON.stringify(r).slice(0, 800);
  const row = (r.data.rows || []).find((x) => x.classId === '獸醫系_四技四A');
  expect(row && row.displayName === '四獸醫四A', '114-2 顯示=' + (row && row.displayName));
  const r2 = await apiCall('overviewStats', { semester: '115-1' }, adminToken.token);
  const row2 = (r2.data.rows || []).find((x) => x.classId === '獸醫系_四技四A');
  evid['D-overviewStats-115-1-row'] = JSON.stringify(row2);
  expect(row2 && /五/.test(row2.displayName), '115-1 顯示=' + (row2 && row2.displayName));
});
});

// ══ E：匯入 v3（真實統計表，仿 Excel 樣態預覽：學院 tabs＋系所分組＋全欄位可修）═══
await flow('E', async () => {
await page.locator('[data-admin-tab="roster"]').click();
await page.setInputFiles('#roster-file', XLSX_REAL);
await check('E', '偵測為統計表格式＋摘要數字（總 369／uncertain 63）', async () => {
  await page.locator('#roster-format', { hasText: '統計表格式' }).waitFor({ timeout: 30000 });
  await page.locator('#roster-preview', { hasText: '共 369 列' }).waitFor({ timeout: 30000 });
  const summary = await page.locator('#roster-summary').textContent();
  evid['E-summary-1st'] = summary;
  expect(summary.includes('待人工確認（標黃）63'), '摘要=' + summary);
});
await check('E', '學院分頁 tabs：每個 tab 帶列數、含「未分學院」（合併分頁），列數總和=369', async () => {
  const tabs = await page.locator('#roster-preview .tab-bar [data-roster-tab]').allTextContents();
  evid['E-tabs'] = JSON.stringify(tabs);
  expect(tabs.length >= 2, 'tabs 數=' + tabs.length);
  expect(tabs.every((t) => /（\d+）$/.test(t)), '有 tab 未帶列數：' + tabs.join(' / '));
  expect(tabs.some((t) => t.startsWith('未分學院（')), '無「未分學院」tab：' + tabs.join(' / '));
  const total = tabs.reduce((s, t) => s + Number((t.match(/（(\d+)）/) || [])[1] || 0), 0);
  expect(total === 369, '各 tab 列數總和=' + total);
});
await check('E', '系所群組標題列（仿系別合併儲存格）：colspan 整寬＋系所名 input', async () => {
  const head = page.locator('#roster-preview-table .roster-dept-head').first();
  await head.waitFor({ timeout: 5000 });
  expect(await head.locator('td').first().getAttribute('colspan') === '10', 'colspan 非 10');
  const deptVal = await head.locator('input[data-roster-dept]').inputValue();
  evid['E-first-dept-group'] = deptVal;
  expect(deptVal.trim().length > 0, '系所群組 input 為空');
});
await check('E', '版面：外層 overflow-x:auto＋表格 min-width:1060 生效', async () => {
  const overflowX = await page.locator('#roster-preview .table-wrap').evaluate((el) => getComputedStyle(el).overflowX);
  expect(overflowX === 'auto', 'overflow-x=' + overflowX);
  const w = await page.locator('#roster-preview-table').evaluate((el) => el.getBoundingClientRect().width);
  expect(w >= 1060, 'table 寬=' + w);
});
await shot(page, 'E-tabs與巢狀分組全貌');
await check('E', '簡稱欄預填且可修：既有班級四技一A 帶現行 displayName「四農園一A」', async () => {
  const firstRow = page.locator('#roster-preview-table [data-roster-row]').first();
  const clsName = await firstRow.locator('input[data-roster-field="classNameRaw"]').inputValue();
  const disp = await firstRow.locator('input[data-roster-field="classDisplayName"]').inputValue();
  evid['E-first-row-prefill'] = JSON.stringify({ clsName, disp });
  expect(clsName === '四技一A', '首列班名=' + clsName);
  expect(disp === '四農園一A', '簡稱預填=' + disp);
  expect(await firstRow.locator('input[data-roster-field="classDisplayName"]').getAttribute('readonly') === null, '簡稱欄不可 readonly');
});
await check('E', '修改導師姓名 → 單列 email 自動比對＋狀態 badge 即時重算（導師變更→無變動）', async () => {
  const row = page.locator('#roster-preview-table [data-roster-row]').first();
  const st0 = (await row.locator('[data-roster-status] .badge').textContent()).trim();
  expect(st0 === '導師變更', '初始狀態=' + st0);
  await row.locator('input[data-roster-field="tutor1Name"]').fill('李新師');
  await row.locator('input[data-roster-field="tutor2Name"]').fill('王助教');
  const e1 = await row.locator('input[data-roster-field="tutor1Email"]').inputValue();
  const e2 = await row.locator('input[data-roster-field="tutor2Email"]').inputValue();
  evid['E-live-email-lookup'] = JSON.stringify({ e1, e2 });
  expect(e1 === 'lee@test.local', 'tutor1 email 自動帶入=' + e1);
  expect(e2 === 'assistant2@test.local', 'tutor2 email 自動帶入=' + e2);
  const st1 = (await row.locator('[data-roster-status] .badge').textContent()).trim();
  expect(st1 === '無變動', '修改後狀態=' + st1);
});
await shot(page, 'E-即時重算差異');
// 班名不合法的紅底標記：打字即套用、切分頁重繪後仍在（原本只在按下確認匯入時 inline 塗一次，
// 顏色極淡且一重繪就沒了——使用者回報「紅色太淡」的那件事）。
await check('E', '班名打成不合法（含「、」）→ 該列即時上紅底標記', async () => {
  const row = page.locator('#roster-preview-table [data-roster-row]').first();
  await row.locator('input[data-roster-field="classNameRaw"]').fill('3A、4A共同指導');
  await row.evaluate((el) => el.offsetHeight);  // 等一次 layout，確保 class 已套上
  const cls = await row.getAttribute('class');
  expect(/roster-row-invalid/.test(cls || ''), 'tr class=' + cls);
  const bg = await row.evaluate((el) => getComputedStyle(el).backgroundColor);
  evid['E-invalid-name-row-bg'] = bg;
  expect(bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent', '紅底未生效：' + bg);
  const note = (await row.locator('[data-roster-notes]').textContent() || '').trim();
  evid['E-invalid-name-note'] = note;
  expect(note.indexOf('班名不合法') === 0, '提示欄未說明原因：' + note);
});
await shot(page, 'E-班名不合法紅底標記');
await check('E', '紅底標記切換學院分頁重繪後仍在（依資料判定而非 inline style）', async () => {
  const row = page.locator('#roster-preview-table [data-roster-row]').first();
  const idx = await row.getAttribute('data-roster-row');
  const tabs = page.locator('#roster-preview .tab-bar [data-roster-tab]');
  await tabs.nth(1).click();
  await page.locator('#roster-preview-table').waitFor({ timeout: 5000 });
  await tabs.nth(0).click();
  const cls = await page.locator('[data-roster-row="' + idx + '"]').getAttribute('class');
  expect(/roster-row-invalid/.test(cls || ''), '重繪後 tr class=' + cls);
});
await check('E', '班名改回合法 → 紅底標記即時解除', async () => {
  const row = page.locator('#roster-preview-table [data-roster-row]').first();
  await row.locator('input[data-roster-field="classNameRaw"]').fill('四技一A');
  await row.evaluate((el) => el.offsetHeight);
  const cls = await row.getAttribute('class');
  expect(!/roster-row-invalid/.test(cls || ''), '仍留著紅底 class=' + cls);
});
await check('E', '切換分頁後編輯值與勾選狀態保留（狀態存 rosterRows 非 DOM）', async () => {
  const row = page.locator('#roster-preview-table [data-roster-row]').first();
  const idx = await row.getAttribute('data-roster-row');
  await row.locator('input[data-roster-field="classDisplayName"]').fill('自訂簡稱X');
  await row.locator('input[data-roster-check]').setChecked(false);
  const tabs = page.locator('#roster-preview .tab-bar [data-roster-tab]');
  await tabs.nth(1).click();
  await page.locator('#roster-preview-table').waitFor({ timeout: 5000 });
  await tabs.nth(0).click();
  const row2 = page.locator('[data-roster-row="' + idx + '"]');
  const disp = await row2.locator('input[data-roster-field="classDisplayName"]').inputValue();
  expect(disp === '自訂簡稱X', '簡稱編輯值未保留：' + disp);
  expect((await row2.locator('input[data-roster-check]').isChecked()) === false, '勾選狀態未保留');
  await row2.locator('input[data-roster-field="classDisplayName"]').fill('四農園一A');  // 還原，避免污染後續
});
// 捲到含「現行→匯入」對照與標黃列處多截幾張
await page.locator('#roster-preview tr', { hasText: '現行：' }).first().scrollIntoViewIfNeeded().catch(() => {});
await shot(page, 'E-預覽表-現行對照');
await page.locator('#roster-preview tr[style*="warning"]').first().scrollIntoViewIfNeeded().catch(() => {});
await shot(page, 'E-預覽表-標黃列');
await page.locator('[data-roster-select="changed"]').click();  // 只作用當前分頁；其他分頁維持預設勾選
await page.locator('[data-action="roster-confirm"]').scrollIntoViewIfNeeded();
const [importReq] = await Promise.all([
  page.waitForRequest((q) => q.url().startsWith(APPS_SCRIPT_URL) && String(q.postData() || '').includes('adminImportRoster'), { timeout: 60000 }),
  page.locator('[data-action="roster-confirm"]').click(),
]);
await check('E', '🔍 確認匯入送出跨分頁勾選列（payload 含非當前分頁的學院）', async () => {
  const payload = JSON.parse(new URLSearchParams(importReq.postData()).get('payload'));
  const colleges = [...new Set((payload.rows || []).map((r) => String(r.collegeName || '')))];
  evid['E-payload-colleges'] = JSON.stringify(colleges) + ' rows=' + (payload.rows || []).length;
  expect(colleges.length >= 2 && colleges.some((c) => c !== '農學院'), '學院集合=' + JSON.stringify(colleges));
});
await check('E', '確認匯入成功（成功/失敗摘要出現）', async () => {
  await page.locator('.toast', { hasText: '匯入完成' }).waitFor({ timeout: 60000 });
  const toast = await page.locator('.toast', { hasText: '匯入完成' }).textContent();
  evid['E-import-1st-toast'] = toast;
});
await shot(page, 'E-第一次匯入結果');

// 🔍 冪等性：同檔再上傳 → 多數列變「無變動」
await page.locator('[data-admin-tab="roster"]').click();
await page.setInputFiles('#roster-file', XLSX_REAL);
await check('E', '🔍 同檔再上傳：多數列變「無變動」（冪等性）', async () => {
  await page.locator('#roster-preview', { hasText: '共 369 列' }).waitFor({ timeout: 30000 });
  const summary = await page.locator('#roster-summary').textContent();
  evid['E-summary-2nd'] = summary;
  const m = summary.match(/無變動 (\d+)/);
  expect(m && Number(m[1]) >= 250, '無變動數=' + (m && m[1]) + '，摘要=' + summary);
});
await shot(page, 'E-二次上傳冪等摘要');
});

// ══ F：畢業／停用班補匯被拒＋補救提示（Ticket 3）═══════════════════════════════
// 流程 D 的 rollover 套用已把「農園系_碩二」畢業（active:false + graduatedSemester）。
// 用標準範本 CSV 直打匯入該班（class disabled fail-closed），連帶一列仍在學的
// 「森林系_家族陳美惠」驗證同批次「單列失敗不中斷整批」＋前端補救提示文字正確出現。
await flow('F', async () => {
  const header = ['學院', '系所', '導師制度', '班級名稱(原始)', '班級顯示名稱(可修改)', '應繳班會份數', '導師1姓名', '導師1email', '導師2姓名', '導師2email'];
  const row1 = ['農學院', '農園系', '', '碩二', '', '', '', '', '', ''];      // 已畢業班 → 預期 class disabled
  const row2 = ['', '森林系', '', '家族陳美惠', '', '', '', '', '', ''];     // 仍在學班 → 預期成功
  const csv = '﻿' + [header, row1, row2].map((r) => r.join(',')).join('\n');
  const csvPath = path.join(SCRATCH, 'verify-disabled-class-import.csv');
  fs.writeFileSync(csvPath, csv, 'utf8');

  await page.locator('[data-admin-tab="roster"]').click();
  await page.setInputFiles('#roster-file', csvPath);
  await check('F', '偵測為標準範本格式，共 2 列；學院分頁=農學院（1）＋未分學院（1）', async () => {
    await page.locator('#roster-format', { hasText: '標準範本格式' }).waitFor({ timeout: 10000 });
    await page.locator('#roster-preview', { hasText: '共 2 列' }).waitFor({ timeout: 10000 });
    const tabs = await page.locator('#roster-preview .tab-bar [data-roster-tab]').allTextContents();
    evid['F-tabs'] = JSON.stringify(tabs);
    expect(tabs.length === 2 && tabs[0] === '農學院（1）' && tabs[1] === '未分學院（1）', 'tabs=' + JSON.stringify(tabs));
  });
  await shot(page, 'F-畢業班補匯預覽表');
  // 全選作用於當前分頁 → 兩個分頁各按一次（同時驗證跨分頁勾選都會送出）
  await page.locator('[data-roster-select="all"]').click();
  await page.locator('#roster-preview .tab-bar [data-roster-tab]').nth(1).click();
  await page.locator('#roster-preview-table').waitFor({ timeout: 5000 });
  await page.locator('[data-roster-select="all"]').click();
  // 不靠 toast 文字比對（4200ms 才自動移除，前一步 E 的 toast 可能還留在 DOM 造成誤判）——
  // 直接攔截這次 adminImportRoster 的真實回應體當事實依據。
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().startsWith(APPS_SCRIPT_URL), { timeout: 20000 }),
    page.locator('[data-action="roster-confirm"]').click(),
  ]);
  const body = await resp.json();
  evid['F-import-response'] = JSON.stringify(body).slice(0, 1500);
  await check('F', 'API 回應：成功 1 列、失敗 1 列，錯誤訊息為 class disabled: 農園系_碩二', async () => {
    const data = body.data || body;
    expect(data.successCount === 1, 'successCount=' + data.successCount + '，body=' + JSON.stringify(body).slice(0, 400));
    expect(Array.isArray(data.errors) && data.errors.length === 1, 'errors=' + JSON.stringify(data.errors));
    expect(/class disabled: 農園系_碩二/.test(data.errors[0].error), 'error=' + JSON.stringify(data.errors[0]));
  });
  await check('F', '畫面渲染出錯誤列＋畢業班補救提示文字', async () => {
    await page.locator('#roster-preview', { hasText: 'class disabled' }).waitFor({ timeout: 10000 });
    const html = await page.locator('#roster-preview').innerHTML();
    evid['F-disabled-class-error-block'] = html.slice(0, 2000);
    expect(html.includes('該班級已畢業／已停用'), '缺少畢業班補救提示文字（「該班級已畢業／已停用」）');
    expect(html.includes('取消勾選「啟用」還原狀態'), '缺少還原步驟提示文字');
  });
  await shot(page, 'F-畢業班補匯被拒＋補救提示');
});

// ══ G：系辦助理（Phase 1：白名單＋唯讀自己系）═══════════════════════════════
// 這一段的重點全在授權邊界：白名單建好之後，該帳號只能讀到自己掛的系，
// 別系的 deptId 要被 forbidden 擋下，沒掛白名單的帳號一律拒絕。
const deptAsstToken = servers.em.mint('deptasst@test.local');
await flow('G', async () => {
  await page.locator('.nav-btn', { hasText: '後台管理' }).click();
  await page.locator('[data-admin-tab="deptAssistants"]').click();
  await check('G', '系辦助理分頁初始為空清單', async () => {
    await page.locator('#admin-tab-content', { hasText: '尚未建立任何系辦助理' }).waitFor({ timeout: 5000 });
  });
  await page.locator('[data-action="deptasst-new"]').click();
  await page.locator('#deptasst-form').waitFor();
  await page.fill('#deptasst-email', 'deptasst@test.local');
  await page.fill('#deptasst-name', '森林系助理');
  await page.locator('[data-deptasst-dept="森林系"]').check();
  await shot(page, 'G-新增系辦助理表單（複選系所）');
  await page.locator('#deptasst-form button[type=submit]').click();
  await check('G', '儲存後清單出現該助理，負責系所欄顯示「森林系」', async () => {
    const row = page.locator('#admin-tab-content tr', { hasText: 'deptasst@test.local' });
    await row.waitFor({ timeout: 5000 });
    const txt = (await row.textContent() || '').trim();
    evid['G-deptasst-row'] = txt;
    expect(txt.includes('森林系'), '列內容=' + txt);
  });
  await shot(page, 'G-系辦助理清單');

  await check('G', '系辦助理分頁的學院篩選：選獸醫學院 → 空清單，選農學院 → 這位助理還在', async () => {
    await page.selectOption('#deptasst-filter-college', '獸醫學院');
    await page.locator('#admin-tab-content', { hasText: '這個篩選條件下沒有系辦助理' }).waitFor({ timeout: 5000 });
    const deptOpts = await page.locator('#deptasst-filter-dept option').allTextContents();
    evid['G-deptasst-filter-獸醫學院'] = deptOpts.join(',');
    expect(deptOpts[0] === '全部系所' && deptOpts.indexOf('森林系') === -1, '系所選單=' + deptOpts.join(','));
    await page.selectOption('#deptasst-filter-college', '農學院');
    await page.locator('#admin-tab-content tr', { hasText: 'deptasst@test.local' }).waitFor({ timeout: 5000 });
    await page.selectOption('#deptasst-filter-dept', '森林系');
    await page.locator('#admin-tab-content tr', { hasText: 'deptasst@test.local' }).waitFor({ timeout: 5000 });
    const shown = await page.locator('#admin-tab-content').textContent();
    expect(/顯示 1 \/ 1 筆/.test(shown || ''), '筆數列＝' + (shown || '').slice(0, 120));
    await page.selectOption('#deptasst-filter-college', '');   // 還原，後面的步驟不受影響
  });

  await check('G', '系辦助理不帶 deptId → 只拿到自己那一系的班級', async () => {
    const r = await apiCall('deptRosterGet', {}, deptAsstToken.token);
    evid['G-roster-own'] = JSON.stringify(r).slice(0, 600);
    const d = r.data || {};
    expect(r.success === true && !d.error, '回應=' + JSON.stringify(r).slice(0, 300));
    expect(JSON.stringify(d.deptIds) === JSON.stringify(['森林系']), 'deptIds=' + JSON.stringify(d.deptIds));
    expect((d.classes || []).every((c) => c.deptId === '森林系'), '混進他系班級');
    expect((d.classes || []).length > 0, '森林系應該有班級');
  });
  await check('G', '🔍 回傳的班級不含 uploadWhitelist / suggestedTutors（欄位投影）', async () => {
    const r = await apiCall('deptRosterGet', {}, deptAsstToken.token);
    const c = ((r.data || {}).classes || [])[0] || {};
    expect(!('uploadWhitelist' in c) && !('suggestedTutors' in c), '外洩欄位：' + Object.keys(c).join(','));
  });
  await check('G', '🔍 系辦助理指定「別系」的 deptId → forbidden', async () => {
    const r = await apiCall('deptRosterGet', { deptId: '農園系' }, deptAsstToken.token);
    evid['G-roster-other-dept'] = JSON.stringify(r);
    expect(/forbidden/.test(JSON.stringify(r)), '回應=' + JSON.stringify(r));
  });
  await check('G', '🔍 沒掛白名單的帳號（學諮助理）打 deptRosterGet → forbidden', async () => {
    const r = await apiCall('deptRosterGet', {}, assistantToken.token);
    evid['G-roster-nonassistant'] = JSON.stringify(r);
    expect(/forbidden/.test(JSON.stringify(r)), '回應=' + JSON.stringify(r));
  });
  await check('G', '🔍 系辦助理打 admin action（adminUpsertDeptAssistant）→ admin only 拒絕', async () => {
    const r = await apiCall('adminUpsertDeptAssistant', { deptAssistant: { email: 'x@y.z', deptIds: ['農園系'] } }, deptAsstToken.token);
    evid['G-deptasst-admin-action'] = JSON.stringify(r);
    expect(/admin only/.test(JSON.stringify(r)), '回應=' + JSON.stringify(r));
  });
  await check('G', '🔍 白名單掛不存在的系所 → 整筆被拒（不靜默丟掉）', async () => {
    const r = await apiCall('adminUpsertDeptAssistant', { deptAssistant: { email: 'bad@test.local', deptIds: ['沒這個系'] } }, adminToken.token);
    evid['G-deptasst-bad-dept'] = JSON.stringify(r);
    expect(/department not found/.test(JSON.stringify(r)), '回應=' + JSON.stringify(r));
  });

  // 以系辦助理身分開新分頁看「導師資料」——驗證頁籤可見、後台管理不可見（前端閘門）
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx2.route((u) => u.href.startsWith(APPS_SCRIPT_URL), async (route) => {
    const rq = route.request();
    const res = await fetch(`http://127.0.0.1:${API_PORT}/exec`, { method: 'POST', body: rq.postData() || '' });
    await route.fulfill({ status: 200, contentType: 'application/json', body: await res.text() });
  });
  await ctx2.route('https://accounts.google.com/gsi/client*', (route) => route.fulfill({
    status: 200, contentType: 'text/javascript',
    body: 'window.google={accounts:{id:{initialize(){},renderButton(){},disableAutoSelect(){},prompt(){}}}};',
  }));
  await ctx2.route('https://cdn.sheetjs.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
  await ctx2.route('https://ipapi.co/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await ctx2.addInitScript(({ rootId, token, exp }) => {
    localStorage.setItem('tutor_user_' + rootId, JSON.stringify({ email: 'deptasst@test.local', name: '森林系助理', picture: '' }));
    localStorage.setItem('tutor_session_' + rootId, JSON.stringify({ token, exp, email: 'deptasst@test.local' }));
  }, { rootId: ROOT_FOLDER_ID, token: deptAsstToken.token, exp: deptAsstToken.exp });
  const page2 = await ctx2.newPage();
  page2.on('console', (m) => { if (m.type() === 'error') consoleErrors.push('[G/page2] ' + m.text()); });
  page2.on('pageerror', (e) => consoleErrors.push('[G/page2] pageerror: ' + e.message));
  await page2.goto(`http://127.0.0.1:${STATIC_PORT}/dev/index.html`);
  await check('G', '系辦助理登入後看得到「導師資料」頁籤、看不到「後台管理」', async () => {
    await page2.locator('.nav-btn', { hasText: '導師資料' }).waitFor({ timeout: 15000 });
    expect(await page2.locator('.nav-btn', { hasText: '後台管理' }).count() === 0, '不該看到後台管理頁籤');
  });
  await check('G', '導師資料頁列出森林系班級與導師，且系所選單只有一個系（自動收起）', async () => {
    await page2.locator('.nav-btn', { hasText: '導師資料' }).click();
    await page2.locator('#deptroster-content table', { hasText: '陳美惠' }).waitFor({ timeout: 15000 });
    const txt = await page2.locator('#deptroster-content').textContent();
    evid['G-deptroster-page'] = (txt || '').trim().slice(0, 300);
    expect(!/四農園/.test(txt || ''), '頁面出現他系班級');
    // 用 isVisible（會考慮祖先）而不是自己的 computed display：單一系所時是整列
    // #deptroster-filters 收起來，欄位本身的 display 仍是 block。
    const selVisible = await page2.locator('#deptroster-dept').isVisible();
    expect(!selVisible, '單一系所時選單應收起');
  });
  await page2.screenshot({ path: path.join(SHOTS, String(++shotNo).padStart(2, '0') + '-G-系辦助理看到的導師資料頁.png') });
  console.log('   📸 G-系辦助理看到的導師資料頁');

  // ── Phase 2：新增班級／填分機與手機／刪除，以及聯絡方式不得外洩的不變量 ──
  await check('G2', '新增班級（含校內分機＋私人手機）→ 列表出現該班且兩欄都顯示', async () => {
    await page2.locator('[data-action="deptroster-new"]').click();
    await page2.locator('#deptroster-form').waitFor({ timeout: 5000 });
    // 表單不該再有 email 欄（2026-08-11 決策：系辦助理不填 email）
    expect(await page2.locator('#deptroster-tutors input[data-tutor-field="email"]').count() === 0,
      '導師表單不該有 email 欄位');
    await page2.fill('#deptroster-name', '四技五A');
    await page2.fill('#deptroster-display', '四森林五A');
    await page2.fill('#deptroster-tutors tbody tr input[data-tutor-field="name"]', '測試導師');
    await page2.fill('#deptroster-tutors tbody tr input[data-tutor-field="ext"]', '7140');
    await page2.fill('#deptroster-tutors tbody tr input[data-tutor-field="mobile"]', '0912-345-678');
    await page2.locator('#deptroster-form button[type=submit]').click();
    await page2.locator('#deptroster-content table', { hasText: '四森林五A' }).waitFor({ timeout: 10000 });
    const txt = await page2.locator('#deptroster-content').textContent();
    expect(/0912-345-678/.test(txt || ''), '列表沒顯示私人手機');
    expect(/7140/.test(txt || ''), '列表沒顯示校內分機');
  });
  await page2.screenshot({ path: path.join(SHOTS, String(++shotNo).padStart(2, '0') + '-G2-新增班級含手機.png') });
  console.log('   📸 G2-新增班級含手機');

  // 注意比對範圍：admin 的 bootstrap 本來就帶 config.deptAssistants（那裡的 ext 是**系辦助理
  // 自己的分機**，屬於後台名單，不是導師聯絡方式）。所以鍵名只在 classes 上驗，
  // 號碼本身才對整包回應驗。
  const CONTACT_KEYS = /"(phone|ext|mobile)"/;
  const bootstrapProbe = async (token, who) => {
    const r = await apiCall('bootstrap', {}, token);
    const classesJson = JSON.stringify((r.data || {}).classes || []);
    const whole = JSON.stringify(r);
    expect(!CONTACT_KEYS.test(classesJson),
      who + ' 的 bootstrap classes 含聯絡欄位：' + (classesJson.match(CONTACT_KEYS) || [])[0]);
    expect(!/0912-345-678/.test(whole), who + ' 的 bootstrap 出現了手機號碼本身');
    return { r, classesJson };
  };
  await check('G2', '🔒 聯絡方式不進 bootstrap：classes 沒有 phone/ext/mobile，號碼也不出現', async () => {
    const { classesJson } = await bootstrapProbe(deptAsstToken.token, '系辦助理');
    evid['G2-bootstrap-classes-clean'] = String(!CONTACT_KEYS.test(classesJson));
    expect(/四森林五A/.test(classesJson), 'bootstrap 應該看得到這個班（只是不含聯絡方式）');
  });
  await check('G2', '🔒 admin 的 bootstrap 也沒有聯絡方式（無例外的不變量）', async () => {
    await bootstrapProbe(adminToken.token, 'admin');
  });
  await check('G2', '🔒 系辦助理在別系新增班級 → forbidden', async () => {
    const r = await apiCall('deptRosterUpsertClass', {
      class: { deptId: '農園系', name: '四技九Z', tutors: [{ name: '壞人' }] },
    }, deptAsstToken.token);
    evid['G2-upsert-other-dept'] = JSON.stringify(r);
    expect(/forbidden/.test(JSON.stringify(r)), '回應=' + JSON.stringify(r));
  });
  await check('G2', '🔒 系辦助理刪別系的班 → forbidden', async () => {
    const r = await apiCall('deptRosterDeleteClass', { classId: '農園系_四技一A' }, deptAsstToken.token);
    evid['G2-delete-other-dept'] = JSON.stringify(r);
    expect(/forbidden/.test(JSON.stringify(r)), '回應=' + JSON.stringify(r));
  });
  await check('G2', '🔒 同系撞班名 → 拒絕（班級身分是 (系所, 班名)）', async () => {
    const r = await apiCall('deptRosterUpsertClass', {
      class: { deptId: '森林系', name: '四技五A', tutors: [{ name: '另一位' }] },
    }, deptAsstToken.token);
    expect(/already exists/.test(JSON.stringify(r)), '回應=' + JSON.stringify(r));
  });
  await check('G2', '🔒 手機含不允許字元 → 拒絕', async () => {
    const r = await apiCall('deptRosterUpsertClass', {
      class: { deptId: '森林系', name: '四技六A', tutors: [{ name: '甲', mobile: '<script>x</script>' }] },
    }, deptAsstToken.token);
    expect(/私人手機格式不正確/.test(JSON.stringify(r)), '回應=' + JSON.stringify(r));
  });
  await check('G2', '🔒 表單沒有 email 欄，存檔後導師的 email 仍在（核章權限不能被清掉）', async () => {
    const before = await apiCall('deptRosterGet', {}, deptAsstToken.token);
    const target = (before.data.classes || []).find((c) => c.name === '家族陳美惠');
    expect(!!target && target.tutors[0].email === 'chen@test.local', '前置：' + JSON.stringify(target && target.tutors));
    // 走 UI：編輯該班、只填分機再存檔（表單根本沒有 email 欄可送）
    await page2.locator('tr', { hasText: '家族陳美惠' }).locator('[data-action="deptroster-edit"]').click();
    await page2.locator('#deptroster-form').waitFor({ timeout: 5000 });
    await page2.fill('#deptroster-tutors tbody tr input[data-tutor-field="ext"]', '7141');
    await page2.locator('#deptroster-form button[type=submit]').click();
    await page2.locator('#deptroster-content table', { hasText: '7141' }).waitFor({ timeout: 10000 });
    const after = await apiCall('deptRosterGet', {}, deptAsstToken.token);
    const t = (after.data.classes || []).find((c) => c.name === '家族陳美惠').tutors[0];
    evid['G2-email-preserved'] = JSON.stringify(t);
    expect(t.email === 'chen@test.local', '存檔後 email 被清掉了：' + JSON.stringify(t));
    expect(t.ext === '7141', '分機沒存進去：' + JSON.stringify(t));
  });
  await check('G2', '🔒 email 保留是靠姓名對應：導師改名後不會把別人的 email 帶過去', async () => {
    const r = await apiCall('deptRosterUpsertClass', {
      class: {
        id: '森林系_家族陳美惠', deptId: '森林系', name: '家族陳美惠',
        tutors: [{ name: '換人做', ext: '', mobile: '' }],
      },
    }, deptAsstToken.token);
    const t = ((r.data || {}).class || {}).tutors[0];
    evid['G2-email-not-carried-to-new-name'] = JSON.stringify(t);
    expect(t && t.email === '', '改名後不該沿用前一位導師的 email：' + JSON.stringify(t));
    // 還原，後面的步驟仍以 陳美惠 為準
    await apiCall('deptRosterUpsertClass', {
      class: {
        id: '森林系_家族陳美惠', deptId: '森林系', name: '家族陳美惠',
        tutors: [{ name: '陳美惠', email: 'chen@test.local', ext: '7141', mobile: '' }],
      },
    }, deptAsstToken.token);
  });
  // ── 主任導師（＝系主任）：助理可維護姓名與聯絡方式，但改不到 email（那是核章身分）──
  await check('G2', '主任導師：助理填分機與手機 → deptRosterGet 讀得到', async () => {
    await page2.locator('[data-action="deptroster-head-edit"]').click();
    await page2.locator('#deptroster-head-form').waitFor({ timeout: 5000 });
    expect(await page2.locator('#deptroster-head-form input[disabled]').count() === 1, 'email 欄應為唯讀');
    await page2.fill('#deptroster-head-name', '吳羽婷');
    await page2.fill('#deptroster-head-ext', '7149');
    await page2.fill('#deptroster-head-mobile', '0955-111-222');
    await page2.locator('#deptroster-head-form button[type=submit]').click();
    await page2.locator('#deptroster-head', { hasText: '0955-111-222' }).waitFor({ timeout: 10000 });
    const r = await apiCall('deptRosterGet', {}, deptAsstToken.token);
    const d = (r.data.departments || [])[0];
    evid['G2-head'] = JSON.stringify(d && d.head);
    expect(d && d.head && d.head.ext === '7149' && d.head.mobile === '0955-111-222', 'head=' + JSON.stringify(d && d.head));
  });
  await shot(page2, 'G2-主任導師（系辦助理視角）');
  await check('G2', '🔒 助理改不到主任導師的 email（改得到＝可以把自己設成系主任來核章）', async () => {
    const r = await apiCall('deptRosterUpsertHead', {
      deptId: '森林系', head: { name: '壞人', email: 'deptasst@test.local', ext: '', mobile: '' },
    }, deptAsstToken.token);
    const after = await apiCall('deptRosterGet', {}, deptAsstToken.token);
    const head = ((after.data.departments || [])[0] || {}).head || {};
    evid['G2-head-email-locked'] = JSON.stringify(head);
    expect(r.success === true, '這個呼叫本身是允許的（改姓名/聯絡方式）：' + JSON.stringify(r).slice(0, 160));
    expect(head.email !== 'deptasst@test.local', 'email 被助理改掉了：' + JSON.stringify(head));
    // 角色不得因此變成系主任
    const boot = await apiCall('bootstrap', {}, deptAsstToken.token);
    expect(JSON.stringify(((boot.data || {}).roles || {}).deptHeadOf || []) === '[]',
      '助理取得了 deptHeadOf：' + JSON.stringify((boot.data.roles || {}).deptHeadOf));
    // 還原姓名
    await apiCall('deptRosterUpsertHead', {
      deptId: '森林系', head: { name: '吳羽婷', ext: '7149', mobile: '0955-111-222' },
    }, deptAsstToken.token);
  });
  await check('G2', '名冊異動會排進主責通知佇列（實際寄信由每 10 分鐘的觸發器合併後送出）', async () => {
    const res = await fetch(`http://127.0.0.1:${API_PORT}/state?path=rosterNotifyQueue.json`);
    const q = await res.json();
    const events = (q && q.events) || [];
    evid['G2-notify-queue'] = JSON.stringify(events.slice(-2));
    expect(events.length > 0, '佇列是空的：' + JSON.stringify(q).slice(0, 200));
    expect(events.every((e) => e.deptId === '森林系' && e.by === 'deptasst@test.local'),
      '佇列內容不對：' + JSON.stringify(events).slice(0, 300));
    expect(events.some((e) => /主任導師/.test(e.summary || '')), '主任導師的異動沒進佇列');
    expect(events.some((e) => /新增班級/.test(e.summary || '')), '新增班級的異動沒進佇列');
  });
  await check('G2', '🔒 助理改別系的主任導師 → forbidden', async () => {
    const r = await apiCall('deptRosterUpsertHead', {
      deptId: '農園系', head: { name: '壞人' },
    }, deptAsstToken.token);
    expect(/forbidden/.test(JSON.stringify(r)), '回應=' + JSON.stringify(r));
  });
  await check('G2', '🔒 主任導師的手機不進 bootstrap 的 departments', async () => {
    const r = await apiCall('bootstrap', {}, deptAsstToken.token);
    const s = JSON.stringify((r.data || {}).departments || []);
    evid['G2-bootstrap-depts-clean'] = String(!/0955-111-222/.test(s));
    expect(!/0955-111-222/.test(s) && !/"mobile"/.test(s) && !/"ext"/.test(s), 'departments 含聯絡欄位：' + s.slice(0, 200));
  });
  await check('G2', '刪除班級 → 列表消失，且是軟刪除（deptRosterGet 不再回它）', async () => {
    const before = await apiCall('deptRosterGet', {}, deptAsstToken.token);
    const target = (before.data.classes || []).find((c) => c.name === '四技五A');
    expect(!!target, '找不到剛建的班');
    const r = await apiCall('deptRosterDeleteClass', { classId: target.id }, deptAsstToken.token);
    expect(r.success === true, '刪除失敗：' + JSON.stringify(r));
    const after = await apiCall('deptRosterGet', {}, deptAsstToken.token);
    expect(!(after.data.classes || []).some((c) => c.id === target.id), '刪除後仍回傳該班');
  });
  await ctx2.close();
});

// ══ G3：導師資料的「學院 → 系所」兩層篩選（admin 管得到全部系所才看得出效果）══
await flow('G3', async () => {
  // 系所數不寫死：跑到這裡時 E 已經把 xlsx 的系所匯進去了，數字會跟著 fixture 走。
  await check('G3', 'admin 開導師資料頁：學院選單列出各學院＋「全部學院」，數字與系所選單一致', async () => {
    await page.locator('.nav-btn', { hasText: '導師資料' }).click();
    await page.locator('#deptroster-content table').waitFor({ timeout: 15000 });
    const colOpts = await page.locator('#deptroster-college option').allTextContents();
    const deptOpts = await page.locator('#deptroster-dept option').allTextContents();
    evid['G3-college-options'] = colOpts.join(' | ');
    expect(/^全部學院（\d+ 系所）$/.test(colOpts[0] || ''), '第一項應為「全部學院（N 系所）」，實得 ' + colOpts[0]);
    expect(Number((colOpts[0].match(/（(\d+) 系所）/) || [])[1]) === deptOpts.length,
      '「全部學院」的系所數應等於系所選單項數：' + colOpts[0] + ' vs ' + deptOpts.length);
    expect(/農學院（\d+）/.test(colOpts.join('')) && /獸醫學院（1）/.test(colOpts.join('')),
      '學院選單應含農學院與獸醫學院（1）：' + colOpts.join(','));
  });
  await check('G3', '選「農學院」→ 系所選單只剩該學院的系（獸醫系消失）', async () => {
    await page.selectOption('#deptroster-college', '農學院');
    await page.locator('#deptroster-content table').waitFor({ timeout: 10000 });
    const deptOpts = await page.locator('#deptroster-dept option').allTextContents();
    const colOpts = await page.locator('#deptroster-college option').allTextContents();
    const n = Number((colOpts.find((t) => t.startsWith('農學院')) || '').match(/（(\d+)）/)[1]);
    evid['G3-depts-in-農學院'] = deptOpts.join(',');
    expect(deptOpts.length === n, '系所選單項數應等於學院選項標的數字 ' + n + '，實得 ' + deptOpts.length);
    expect(deptOpts.indexOf('獸醫系') === -1, '不該出現他學院的系：' + deptOpts.join(','));
    expect(deptOpts.indexOf('農園系') !== -1 && deptOpts.indexOf('森林系') !== -1, '缺農學院的系：' + deptOpts.join(','));
  });
  await page.screenshot({ path: path.join(SHOTS, String(++shotNo).padStart(2, '0') + '-G3-導師資料學院篩選.png') });
  console.log('   📸 G3-導師資料學院篩選');
  await check('G3', '匯出 Excel：選「全部系所」→ 真的下載得到檔案，內容含主任導師與手機欄', async () => {
    await page.locator('[data-action="deptroster-export"]').click();
    await page.locator('[data-action="deptroster-export-all"]').waitFor({ timeout: 5000 });
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 60000 }),
      page.locator('[data-action="deptroster-export-all"]').click(),
    ]);
    const file = path.join(SHOTS, 'roster-export.xlsx');
    await download.saveAs(file);
    const XLSX = requireScratch('xlsx');
    const wb = XLSX.read(fs.readFileSync(file));
    // 版面仿統計表：一個學院一個分頁、三列表頭、系別跨列合併
    const names = wb.SheetNames;
    const first = XLSX.utils.sheet_to_json(wb.Sheets[names[0]], { header: 1, defval: '' });
    const merges = wb.Sheets[names[0]]['!merges'] || [];
    evid['G3-export'] = download.suggestedFilename() + '：分頁=' + names.join('/') +
      '，第一頁 ' + first.length + ' 列，合併 ' + merges.length + ' 處';
    expect(/^導師名冊_全校_\d{8}\.xlsx$/.test(download.suggestedFilename()), '檔名=' + download.suggestedFilename());
    expect(names.length > 1, '應該一個學院一個分頁，實得 ' + names.join('/'));
    expect(first[0][0] === names[0], '第一列應是學院名：' + JSON.stringify(first[0]));
    expect(String(first[2][0]) === '系別' && String(first[3][1]) === '姓名', '三列表頭不對：' + JSON.stringify(first.slice(2, 4)));
    expect(merges.length > 5, '合併儲存格太少（系別/班級應縱向合併）：' + merges.length);
    // 手機欄在這份 fixture 裡本來就沒有資料（G2 建的那班已刪除），所以驗欄位存在＋分機有值就好
    expect(String(first[3][7]) === '私人手機', '第 8 欄應是私人手機：' + JSON.stringify(first[3]));
    expect(first.slice(5).some((r) => r[6]), '校內分機欄整欄空的');
  });
  await check('G3', '選「獸醫學院」→ 系所自動改指獸醫系，表格跟著換系', async () => {
    // 班名不寫死：D 的換學期流程會把獸醫系那班改名（四獸醫四A→四獸醫五A），認「獸醫」就好。
    await page.selectOption('#deptroster-college', '獸醫學院');
    await page.locator('#deptroster-content table', { hasText: '獸醫' }).waitFor({ timeout: 10000 });
    const deptVal = await page.locator('#deptroster-dept').inputValue();
    const txt = await page.locator('#deptroster-content').textContent();
    evid['G3-獸醫學院-table'] = (txt || '').trim().slice(0, 120);
    expect(deptVal === '獸醫系', '系所選單值＝' + deptVal);
    expect(!/四農園/.test(txt || ''), '換學院後仍出現他學院的班級');
  });
});

// ══ J：學諮中心主責＝最大權限（2026-08-11 決策）═════════════════════════════
// 主責看得到 admin 的所有畫面、做得到 admin 的所有動作；助理**不會**跟著升級。
await flow('J', async () => {
  await check('J', '主責的 bootstrap 回 isAdmin:true，且拿得到只給 admin 的名單', async () => {
    const r = await apiCall('bootstrap', {}, leadToken.token);
    const d = r.data || {};
    evid['J-lead-roles'] = JSON.stringify(d.roles);
    expect(d.roles && d.roles.isAdmin === true && d.roles.isStaffLead === true, 'roles=' + JSON.stringify(d.roles));
    expect(!!d.users && !!d.staffLeads && !!d.deptAssistants, '主責應拿得到 users/staffLeads/deptAssistants 名單');
  });
  await check('J', '主責可執行 admin action（adminUpsertCollege）', async () => {
    const r = await apiCall('adminUpsertCollege', { college: { id: '主責建的學院', name: '主責建的學院' } }, leadToken.token);
    evid['J-lead-admin-action'] = JSON.stringify(r).slice(0, 160);
    expect(r.success === true, '回應=' + JSON.stringify(r).slice(0, 200));
  });
  await check('J', '主責讀得到全部系所的名冊（deptRosterGet 不指定 deptId）', async () => {
    const r = await apiCall('deptRosterGet', {}, leadToken.token);
    const ids = (r.data || {}).deptIds || [];
    evid['J-lead-roster-scope'] = ids.length + ' depts';
    expect(ids.length > 1 && ids.indexOf('森林系') !== -1, 'deptIds=' + JSON.stringify(ids).slice(0, 200));
  });
  await check('J', 'admin 批次匯入主任導師：一次寫多系，headEmail 同步（系主任那一關才認得出人）', async () => {
    const r = await apiCall('adminBulkUpsertDeptHeads', {
      heads: [
        { deptId: '農園系', name: '梁佑慎', email: 'justinliang@test.local', ext: '6247' },
        { deptId: '獸醫系', name: '蔡宜倫', email: 'yltsai@test.local', ext: '5081' },
      ],
    }, adminToken.token);
    evid['J-bulk-heads'] = JSON.stringify(r).slice(0, 120);
    expect(r.success === true && r.data.count === 2, '回應=' + JSON.stringify(r).slice(0, 200));
    const boot = await apiCall('bootstrap', {}, adminToken.token);
    const d = ((boot.data || {}).departments || []).find((x) => x.id === '農園系');
    expect(d && d.headEmail === 'justinliang@test.local', 'headEmail 沒同步：' + JSON.stringify(d));
    expect(!/"ext"/.test(JSON.stringify(boot.data.departments)), 'bootstrap 的 departments 不該有 ext');
  });
  await check('J', '🔒 批次匯入遇到不存在的系所 → 整批拒絕（不做部分寫入）', async () => {
    const r = await apiCall('adminBulkUpsertDeptHeads', {
      heads: [{ deptId: '森林系', name: '照理說會被寫入' }, { deptId: '沒這個系', name: '壞列' }],
    }, adminToken.token);
    expect(r.success === false && /找不到系所/.test(r.error || ''), '回應=' + JSON.stringify(r));
    const after = await apiCall('deptRosterGet', {}, deptAsstToken.token);
    const head = ((after.data.departments || [])[0] || {}).head || {};
    expect(head.name === '吳羽婷', '整批拒絕時第一列不該被寫進去：' + JSON.stringify(head));
  });
  await check('J', '🔒 系辦助理打 adminBulkUpsertDeptHeads → admin only 拒絕', async () => {
    const r = await apiCall('adminBulkUpsertDeptHeads', {
      heads: [{ deptId: '森林系', name: '壞人', email: 'deptasst@test.local' }],
    }, deptAsstToken.token);
    expect(r.success === false && /admin only/.test(r.error || ''), '回應=' + JSON.stringify(r));
  });
  await check('J', '🔒 學諮助理**不會**跟著升級：打 admin action 仍被拒', async () => {
    const r = await apiCall('adminUpsertCollege', { college: { id: 'x1', name: '助理不該建得出來' } }, assistantToken.token);
    evid['J-assistant-still-blocked'] = JSON.stringify(r);
    expect(r.success === false && /admin only/.test(r.error || ''), '回應=' + JSON.stringify(r));
  });
  await check('J', '🔒 系辦助理也不會升級：打 admin action 仍被拒', async () => {
    const r = await apiCall('adminUpsertCollege', { college: { id: 'x2', name: '系辦助理不該建得出來' } }, deptAsstToken.token);
    expect(r.success === false && /admin only/.test(r.error || ''), '回應=' + JSON.stringify(r));
  });
  // 其他收信信箱：這組設定的失效是安靜的（設錯只會讓人「再也沒收到通知」），所以連
  // 「被擋下來時不可以留下半套設定」都要驗。
  await check('J', '主責可設「其他收信信箱」，alt 正規化成小寫存起來', async () => {
    const r = await apiCall('adminUpsertStaffLead', {
      staffLead: { email: 'lead@test.local', name: '測試主責', altEmail: '  Lead.Alt@Example.COM ' },
    }, adminToken.token);
    const me = ((r.data || {}).staffLeads || []).find((s) => s.email === 'lead@test.local') || {};
    evid['J-mailprefs-alt'] = JSON.stringify({ altEmail: me.altEmail, noPrimaryMail: me.noPrimaryMail });
    expect(r.success === true && me.altEmail === 'lead.alt@example.com', '回應=' + JSON.stringify(r).slice(0, 200));
  });
  await check('J', '🔒 勾「不寄給登入信箱」又沒填 alt → 拒絕，且原設定不被動到', async () => {
    const r = await apiCall('adminUpsertStaffLead', {
      staffLead: { email: 'lead@test.local', name: '測試主責', altEmail: '', noPrimaryMail: true },
    }, adminToken.token);
    evid['J-mailprefs-blocked'] = JSON.stringify(r).slice(0, 160);
    expect(r.success === false && /必須填其他收信信箱/.test(r.error || ''), '回應=' + JSON.stringify(r).slice(0, 200));
    const boot = await apiCall('bootstrap', {}, adminToken.token);
    const me = ((boot.data || {}).staffLeads || []).find((s) => s.email === 'lead@test.local') || {};
    expect(me.altEmail === 'lead.alt@example.com' && me.noPrimaryMail !== true,
      '被拒後不該留下半套設定：' + JSON.stringify(me));
  });
  await check('J', '🔒 alt 格式不對 → 拒絕', async () => {
    const r = await apiCall('adminUpsertStaffLead', {
      staffLead: { email: 'lead@test.local', name: '測試主責', altEmail: 'not-an-email' },
    }, adminToken.token);
    expect(r.success === false && /格式不正確/.test(r.error || ''), '回應=' + JSON.stringify(r).slice(0, 200));
  });
  // UI：主責登入後看得到後台管理與導師資料頁籤
  const ctx3 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx3.route((u) => u.href.startsWith(APPS_SCRIPT_URL), async (route) => {
    const rq = route.request();
    const res = await fetch(`http://127.0.0.1:${API_PORT}/exec`, { method: 'POST', body: rq.postData() || '' });
    await route.fulfill({ status: 200, contentType: 'application/json', body: await res.text() });
  });
  await ctx3.route('https://accounts.google.com/gsi/client*', (route) => route.fulfill({
    status: 200, contentType: 'text/javascript',
    body: 'window.google={accounts:{id:{initialize(){},renderButton(){},disableAutoSelect(){},prompt(){}}}};',
  }));
  await ctx3.route('https://cdn.sheetjs.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
  await ctx3.route('https://ipapi.co/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await ctx3.addInitScript(({ rootId, token, exp }) => {
    localStorage.setItem('tutor_user_' + rootId, JSON.stringify({ email: 'lead@test.local', name: '測試主責', picture: '' }));
    localStorage.setItem('tutor_session_' + rootId, JSON.stringify({ token, exp, email: 'lead@test.local' }));
  }, { rootId: ROOT_FOLDER_ID, token: leadToken.token, exp: leadToken.exp });
  const page3 = await ctx3.newPage();
  page3.on('console', (m) => { if (m.type() === 'error') consoleErrors.push('[J/page3] ' + m.text()); });
  page3.on('pageerror', (e) => consoleErrors.push('[J/page3] pageerror: ' + e.message));
  await page3.goto(`http://127.0.0.1:${STATIC_PORT}/dev/index.html`);
  await check('J', '主責的導覽列＝admin 的導覽列，且兩者都只剩「導師資料／後台管理」', async () => {
    await page3.locator('.nav-btn', { hasText: '後台管理' }).waitFor({ timeout: 15000 });
    const navs = await page3.locator('.nav-btn').allTextContents();
    const adminNavs = await page.locator('.nav-btn').allTextContents();
    const RECORD_TABS = /上傳|核章匣|班級統計|全校總表/;
    expect(!navs.some((t) => RECORD_TABS.test(t)) && !adminNavs.some((t) => RECORD_TABS.test(t)),
      '紀錄流程的頁籤應對 admin／主責全部收起：' + navs.join(',') + ' / ' + adminNavs.join(','));
    expect(navs.some((t) => /導師資料/.test(t)) && navs.some((t) => /後台管理/.test(t)),
      '主責該留的兩個頁籤不見了：' + navs.join(','));
    evid['J-lead-navs'] = navs.join(',');
    expect(JSON.stringify(navs.map((s) => s.replace(/\d+$/, ''))) === JSON.stringify(adminNavs.map((s) => s.replace(/\d+$/, ''))),
      '主責的頁籤與 admin 不一致：' + navs.join(',') + ' vs ' + adminNavs.join(','));
  });
  await shot(page3, 'J-主責看到的畫面（與 admin 同）');
  await ctx3.close();
});

// ══ K：導師端不受「收起上傳頁籤」影響（收的只有 admin／主責）═══════════════════
await flow('K', async () => {
  // 用 lee@test.local：E 的匯入會把種子的導師名單換掉（wang 在那之後就不是導師了），
  // 匯入後農園系_四技一A 的導師是李新師/王助教。
  const tutorToken = servers.em.mint('lee@test.local');
  const ctx4 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx4.route((u) => u.href.startsWith(APPS_SCRIPT_URL), async (route) => {
    const rq = route.request();
    const res = await fetch(`http://127.0.0.1:${API_PORT}/exec`, { method: 'POST', body: rq.postData() || '' });
    await route.fulfill({ status: 200, contentType: 'application/json', body: await res.text() });
  });
  await ctx4.route('https://accounts.google.com/gsi/client*', (route) => route.fulfill({
    status: 200, contentType: 'text/javascript',
    body: 'window.google={accounts:{id:{initialize(){},renderButton(){},disableAutoSelect(){},prompt(){}}}};',
  }));
  await ctx4.route('https://cdn.sheetjs.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
  await ctx4.route('https://ipapi.co/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await ctx4.addInitScript(({ rootId, token, exp }) => {
    localStorage.setItem('tutor_user_' + rootId, JSON.stringify({ email: 'lee@test.local', name: '李新師', picture: '' }));
    localStorage.setItem('tutor_session_' + rootId, JSON.stringify({ token, exp, email: 'lee@test.local' }));
  }, { rootId: ROOT_FOLDER_ID, token: tutorToken.token, exp: tutorToken.exp });
  const page4 = await ctx4.newPage();
  page4.on('console', (m) => { if (m.type() === 'error') consoleErrors.push('[K/page4] ' + m.text()); });
  page4.on('pageerror', (e) => consoleErrors.push('[K/page4] pageerror: ' + e.message));
  await page4.goto(`http://127.0.0.1:${STATIC_PORT}/dev/index.html`);
  await check('K', '導師登入後仍看得到「上傳」頁籤，且點得開表單', async () => {
    await page4.locator('.nav-btn', { hasText: '導師個人後台' }).waitFor({ timeout: 15000 });
    const navs = await page4.locator('.nav-btn').allTextContents();
    evid['K-tutor-navs'] = navs.join(',');
    expect(navs.some((t) => /^上傳$/.test(t)), '導師的導覽列少了「上傳」：' + navs.join(','));
    await page4.locator('.nav-btn', { hasText: /^上傳$/ }).click();
    await page4.locator('#page-root', { hasText: '班會紀錄' }).waitFor({ timeout: 10000 });
  });
  await check('K', '導師沒有「後台管理」，也看不到導師資料頁籤', async () => {
    const navs = await page4.locator('.nav-btn').allTextContents();
    expect(!navs.some((t) => /後台管理|導師資料/.test(t)), '導師不該有這些頁籤：' + navs.join(','));
  });
  await ctx4.close();
});

// ══ L：GAS 把 POST 降級成 GET 時，前端要自己重試而不是撞牆 ═══════════════════
await flow('L', async () => {
  await check('L', '注入一次降級回應 → 畫面照常載入（自動重試），不出現「bootstrap 回應異常」', async () => {
    await fetch(`http://127.0.0.1:${API_PORT}/downgrade-once`);
    // 下一個 proxyCall 會拿到 doGet 形狀；前端應自行重送，使用者看不到錯誤
    await page.locator('.nav-btn', { hasText: '後台管理' }).click();
    await page.locator('[data-admin-tab="departments"]').click();
    await page.locator('#admin-tab-content', { hasText: '系所清單' }).waitFor({ timeout: 15000 });
    await page.locator('.nav-btn', { hasText: '導師資料' }).click();
    await page.locator('#deptroster-content table').first().waitFor({ timeout: 20000 });
    const txt = await page.locator('#page-root').textContent();
    expect(!/回應異常/.test(txt || ''), '畫面出現了降級錯誤訊息：' + (txt || '').slice(0, 160));
  });
  await check('L', '🔒 降級回應不會被當成成功資料吃進去（重試後拿到的是真資料）', async () => {
    await fetch(`http://127.0.0.1:${API_PORT}/downgrade-once`);
    const r = await apiCall('deptRosterGet', {}, adminToken.token);   // 這一趟會吃掉降級回應
    evid['L-downgraded-raw'] = JSON.stringify(r).slice(0, 120);
    // apiCall 是測試自己的 fetch，不含前端重試邏輯——它應該原封不動拿到降級形狀，
    // 這正好證明「前端那層的重試」才是使畫面正常的原因，而不是模擬器沒生效。
    expect(r.data && r.data.via === 'doGet', '注入沒生效？回應=' + JSON.stringify(r).slice(0, 160));
  });
});

// ══ I：切頁順暢度（快取先畫）＋ 視窗不該被「拖曳反白到外面放開」關掉 ═══════════
await flow('I', async () => {
  await check('I', '切到全校總表 → 離開 → 再切回來時直接有表格，不再閃「載入中…」', async () => {
    // admin 的紀錄流程頁籤全收起了（2026-08-11 決策），改用「導師資料 ↔ 後台管理」來回，
    // 導師資料同樣走 loadPageData 的快取路徑。
    await page.locator('.nav-btn', { hasText: '導師資料' }).click();
    await page.locator('#deptroster-content table').first().waitFor({ timeout: 15000 });
    await page.locator('.nav-btn', { hasText: '後台管理' }).click();
    await page.locator('#admin-tab-content').waitFor({ timeout: 10000 });
    await page.locator('.nav-btn', { hasText: '導師資料' }).click();
    // 不等任何東西，立刻讀：有快取時是同一個 tick 內畫好的，沒快取則還停在「載入中…」
    const now = await page.evaluate(() => {
      const el = document.getElementById('deptroster-content');
      return { hasTable: !!(el && el.querySelector('table')), text: (el && el.textContent || '').slice(0, 20) };
    });
    evid['I-instant-render'] = JSON.stringify(now);
    expect(now.hasTable && !/載入中/.test(now.text), '切回來的當下畫面＝' + JSON.stringify(now));
  });
  await check('I', '在輸入框裡拖曳反白、放開時滑鼠已在視窗外 → 視窗不可被關掉', async () => {
    await page.locator('.nav-btn', { hasText: '導師資料' }).click();
    await page.locator('[data-action="deptroster-new"]').click();
    await page.locator('#deptroster-form').waitFor({ timeout: 5000 });
    await page.fill('#deptroster-name', '四技七A');
    const box = await page.locator('#deptroster-name').boundingBox();
    await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 4, box.y + box.height / 2, { steps: 5 });
    await page.mouse.move(8, 8, { steps: 10 });      // 拖到遮罩上（視窗外）才放開
    await page.mouse.up();
    const open = await page.locator('#modal-overlay.open').count();
    const kept = await page.inputValue('#deptroster-name');
    evid['I-drag-out-modal-open'] = String(open === 1) + ' / 內容=' + kept;
    expect(open === 1, '視窗被拖曳放開誤關了');
    expect(kept === '四技七A', '填到一半的內容不見了：' + kept);
  });
  await check('I', '單純點視窗外的空白處 → 照樣關閉（原本的行為要留著）', async () => {
    await page.mouse.click(8, 8);
    await page.waitForTimeout(200);
    expect(await page.locator('#modal-overlay.open').count() === 0, '點空白處應該關閉視窗');
  });
});

// ══ H：系辦助理帳密登入（GAS 軌專用的路；校內信箱不是 Google 帳號）═══════════
await flow('H', async () => {
  await check('H', '建立系辦助理白名單＋本機帳號（初始密碼＝分機）', async () => {
    const r1 = await apiCall('adminUpsertDeptAssistant', {
      deptAssistant: { email: 'h-asst@example.com', name: 'H 測試助理', ext: '7788', deptIds: ['森林系'] },
    }, adminToken.token);
    expect(r1.success === true, JSON.stringify(r1).slice(0, 200));
    const r2 = await apiCall('adminLocalAccounts', { op: 'createOrReset', email: 'h-asst@example.com' }, adminToken.token);
    evid['H-create-account'] = JSON.stringify(r2).slice(0, 200);
    expect(r2.success === true, JSON.stringify(r2).slice(0, 200));
  });
  await check('H', '用分機登入（只打 local-part）→ 發 token 且標記須改密碼', async () => {
    const r = await apiCall('localLogin', { email: 'h-asst', password: '7788' });
    evid['H-login'] = JSON.stringify(r).slice(0, 200);
    expect(r.data && r.data.sessionToken, '沒拿到 token：' + JSON.stringify(r).slice(0, 200));
    expect(r.data.mustChangePassword === true, 'mustChangePassword 應為 true');
  });
  await check('H', '🔒 錯誤密碼 → 帳號或密碼錯誤（不透露帳號是否存在）', async () => {
    const bad = await apiCall('localLogin', { email: 'h-asst', password: 'wrong' });
    const ghost = await apiCall('localLogin', { email: 'no-such-user', password: 'wrong' });
    expect(bad.data.error === '帳號或密碼錯誤', JSON.stringify(bad));
    expect(ghost.data.error === '帳號或密碼錯誤', '不存在的帳號應回一樣的訊息：' + JSON.stringify(ghost));
  });
  await check('H', '🔒 新密碼政策：太短、純數字都被擋', async () => {
    const a = await apiCall('localChangePassword', { email: 'h-asst', currentPassword: '7788', newPassword: 'ab1' });
    const b = await apiCall('localChangePassword', { email: 'h-asst', currentPassword: '7788', newPassword: '12345678' });
    expect(/至少 8/.test(a.data.error || ''), JSON.stringify(a));
    expect(/只有數字/.test(b.data.error || ''), JSON.stringify(b));
  });
  await check('H', '改密碼成功，舊密碼失效、新密碼可登入且不再要求改', async () => {
    const c = await apiCall('localChangePassword', { email: 'h-asst', currentPassword: '7788', newPassword: 'newpass-h1' });
    expect(c.data && c.data.changed === true, JSON.stringify(c));
    const old = await apiCall('localLogin', { email: 'h-asst', password: '7788' });
    expect(old.data.error === '帳號或密碼錯誤', '舊密碼仍可用：' + JSON.stringify(old));
    const nw = await apiCall('localLogin', { email: 'h-asst', password: 'newpass-h1' });
    expect(nw.data && nw.data.sessionToken, JSON.stringify(nw).slice(0, 200));
    expect(nw.data.mustChangePassword === false, 'mustChangePassword 應已清除');
  });
  await check('H', '🔁 重送同一次改密碼請求 → 冪等回成功（GAS 偶發 404 重試的情境）', async () => {
    const again = await apiCall('localChangePassword', { email: 'h-asst', currentPassword: '7788', newPassword: 'newpass-h1' });
    evid['H-idempotent-retry'] = JSON.stringify(again);
    expect(again.data && again.data.alreadyChanged === true, '重送應回 alreadyChanged：' + JSON.stringify(again));
  });
  await check('H', '🔒 目前密碼與新密碼都錯 → 仍然拒絕', async () => {
    const r = await apiCall('localChangePassword', { email: 'h-asst', currentPassword: 'nope', newPassword: 'another-pass1' });
    expect(/目前密碼錯誤/.test(r.data.error || ''), JSON.stringify(r));
  });
  await check('H', '系辦助理（合併頁）：一列同時看得到白名單與帳號狀態，學院篩選生效', async () => {
    await page.locator('.nav-btn', { hasText: '後台管理' }).click();
    await page.locator('[data-admin-tab="deptAssistants"]').click();
    // 合併頁：白名單先畫出來，帳號欄位由 serverAdminCall 補上，等到「密碼」欄不再是「…」
    await page.locator('#admin-tab-content table').waitFor({ timeout: 10000 });
    await page.locator('#admin-tab-content tr', { hasText: '仍是初始密碼' }).first().waitFor({ timeout: 15000 })
      .catch(() => {});
    await page.selectOption('#deptasst-filter-college', '獸醫學院');
    await page.locator('#admin-tab-content', { hasText: '這個篩選條件下沒有系辦助理' }).waitFor({ timeout: 5000 });
    // 篩選只影響顯示：總人數那行仍以全部白名單計算（「為所有尚無帳號者建立帳號」是全體動作）
    const filtered = await page.locator('#admin-tab-content').textContent();
    evid['H-account-summary-filtered'] = (filtered || '').replace(/\s+/g, ' ').slice(0, 200);
    expect(/顯示 0 \/ \d+ 筆/.test(filtered || ''), '篩到獸醫學院應該是 0 筆：' + (filtered || '').slice(0, 200));
    await page.selectOption('#deptasst-filter-college', '農學院');
    const row = page.locator('#admin-tab-content tr', { hasText: 'h-asst@example.com' });
    await row.waitFor({ timeout: 5000 });
    const txt = (await row.textContent() || '').trim();
    evid['H-account-row'] = txt;
    expect(/森林系/.test(txt), '系所欄沒顯示：' + txt);
    expect(/h-asst@example.com/.test(await page.locator('#admin-tab-content').textContent()),
      '合併頁應該看得到剛用 API 建的 h-asst（進分頁要重抓，不能只吃 bootstrap 快照）');
    await page.selectOption('#deptasst-filter-college', '');
  });
  await check('H', '操作按鈕在表格上方，且每個可調整的欄位都有拖曳把手', async () => {
    const bar = page.locator('#admin-tab-content .admin-toolbar');
    await bar.waitFor({ timeout: 5000 });
    const barBox = await bar.boundingBox();
    const tableBox = await page.locator('#deptasst-table').boundingBox();
    expect(barBox.y < tableBox.y, `按鈕列（y=${barBox.y}）應該在表格（y=${tableBox.y}）上方`);
    for (const act of ['deptasst-new', 'deptasst-bulk', 'deptacct-create-all', 'deptacct-export', 'deptasst-reset-colw']) {
      expect(await bar.locator(`[data-action="${act}"]`).count() === 1, `按鈕列少了 ${act}`);
    }
    const handles = await page.locator('#deptasst-table thead .col-resize-handle').count();
    expect(handles === 7, `把手應該是 7 個（操作欄不給），實際 ${handles}`);
    expect(await page.locator('#deptasst-table colgroup col').count() === 8, 'colgroup 欄數不是 8');
  });
  await check('H', '拖曳把手可加寬欄位，寬度存進 localStorage 且重繪後保留', async () => {
    const before = await page.locator('#deptasst-table thead th[data-col="3"]').boundingBox();
    const handle = page.locator('#deptasst-table thead th[data-col="3"] .col-resize-handle');
    const hb = await handle.boundingBox();
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + hb.width / 2 + 90, hb.y + hb.height / 2, { steps: 8 });
    await page.mouse.up();
    const after = await page.locator('#deptasst-table thead th[data-col="3"]').boundingBox();
    expect(after.width > before.width + 40, `Email 欄沒被拉寬：${before.width} → ${after.width}`);
    const saved = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) || '{}'), 'tutor_colw_' + ROOT_FOLDER_ID);
    evid['H-colwidths-saved'] = JSON.stringify(saved);
    expect(saved.deptAsstColWidths && Number(saved.deptAsstColWidths['3']) > 0, '欄寬沒寫進 localStorage：' + JSON.stringify(saved));
    // 篩選器會整個重畫表格：偏好要在重畫後自己套回去（infosys 那邊漏掉這步等於沒存）
    await page.selectOption('#deptasst-filter-college', '農學院');
    await page.locator('#deptasst-table').waitFor({ timeout: 5000 });
    const redrawn = await page.locator('#deptasst-table thead th[data-col="3"]').boundingBox();
    expect(Math.abs(redrawn.width - after.width) < 6, `重畫後欄寬掉了：${after.width} → ${redrawn.width}`);
  });
  await check('H', '「重設欄寬」清掉偏好並恢復預設比例', async () => {
    await page.locator('[data-action="deptasst-reset-colw"]').click();
    const saved = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) || '{}'), 'tutor_colw_' + ROOT_FOLDER_ID);
    expect(saved.deptAsstColWidths && Object.keys(saved.deptAsstColWidths).length === 0,
      '重設後 localStorage 仍有欄寬：' + JSON.stringify(saved));
    const cleared = await page.evaluate(() => ({
      layout: document.getElementById('deptasst-table').style.tableLayout,
      col3: document.getElementById('deptasst-col-3').style.width,
    }));
    expect(!cleared.layout && !cleared.col3, '欄寬樣式沒清乾淨：' + JSON.stringify(cleared));
    await page.selectOption('#deptasst-filter-college', '');
  });
  await check('H', '系辦助理帳號分頁可匯出 Excel（帳號＋分機，供通知信使用）', async () => {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 60000 }),
      page.locator('[data-action="deptacct-export"]').click(),
    ]);
    const file = path.join(SHOTS, 'dept-accounts.xlsx');
    await download.saveAs(file);
    const XLSX = requireScratch('xlsx');
    const wb = XLSX.read(fs.readFileSync(file));
    const rows = XLSX.utils.sheet_to_json(wb.Sheets['系辦助理帳號'], { defval: '' });
    evid['H-account-export'] = download.suggestedFilename() + '：' + JSON.stringify(rows);
    expect(/^系辦助理帳號_\d{8}\.xlsx$/.test(download.suggestedFilename()), '檔名=' + download.suggestedFilename());
    const h = rows.find((r) => r['登入帳號'] === 'h-asst');
    expect(!!h, '找不到 h-asst 那列：' + JSON.stringify(rows));
    expect(h['分機'] === 7788 || h['分機'] === '7788', '分機欄=' + h['分機']);
    expect(String(h['初始密碼']) === '', 'h-asst 已自行改過密碼，不該列出初始密碼：' + h['初始密碼']);
    expect(h['系所'] === '森林系', '系所欄=' + h['系所']);
  });
  await shot(page, 'H-系辦助理帳號分頁（學院篩選）');

  // ── 批次套用系所清冊：全名寫進 fullName、助理密碼＝系主任分機 ──
  const SHEET_ROWS = [{ deptId: '森林系', fullName: '森林學系（全名）', ext: '7157' }];
  await check('H', '批次套用系所清冊：預演不寫入，且算得出「建立 1、跳過已自訂密碼 1」', async () => {
    const r = await apiCall('adminBulkApplyDeptSheet', { rows: SHEET_ROWS }, adminToken.token);
    const s = (r.data || {}).summary || {};
    evid['H-deptsheet-preview'] = JSON.stringify(s);
    expect(s['模式'] === '預演（未寫入）', '模式=' + s['模式']);
    expect(s['將建立帳號'] === 1, '應該要建 deptasst 的帳號：' + JSON.stringify(s));
    expect(s['跳過已自訂密碼'] === 1, 'h-asst 已自行改過密碼，應被跳過：' + JSON.stringify(s));
    // 預演真的沒寫：全名還沒出現
    const boot = await apiCall('bootstrap', {}, adminToken.token);
    const d = ((boot.data || {}).departments || []).find((x) => x.id === '森林系');
    expect(!d.fullName, '預演竟然寫進去了：' + JSON.stringify(d));
  });
  await check('H', '套用後：fullName 進去了、**內部簡稱 name 不變**（班級顯示名的來源）', async () => {
    const r = await apiCall('adminBulkApplyDeptSheet', { rows: SHEET_ROWS, apply: true }, adminToken.token);
    expect(r.success === true, JSON.stringify(r).slice(0, 200));
    const boot = await apiCall('bootstrap', {}, adminToken.token);
    const d = ((boot.data || {}).departments || []).find((x) => x.id === '森林系');
    evid['H-deptsheet-applied'] = JSON.stringify({ id: d.id, name: d.name, fullName: d.fullName });
    expect(d.fullName === '森林學系（全名）', 'fullName=' + d.fullName);
    expect(d.name === '森林系', '內部簡稱名被改掉了（會連帶弄壞班級顯示名）：' + d.name);
  });
  await check('H', '套用後：沒帳號的助理可用系主任分機登入；已自訂密碼的人不受影響', async () => {
    const nw = await apiCall('localLogin', { email: 'deptasst@test.local', password: '7157' });
    evid['H-deptsheet-login'] = JSON.stringify(nw.data && { has: !!nw.data.sessionToken, must: nw.data.mustChangePassword });
    expect(nw.data && nw.data.sessionToken, '新密碼登不進去：' + JSON.stringify(nw).slice(0, 200));
    expect(nw.data.mustChangePassword === true, '應要求首次登入改密碼');
    const keep = await apiCall('localLogin', { email: 'h-asst', password: 'newpass-h1' });
    expect(keep.data && keep.data.sessionToken, 'h-asst 自訂的密碼被清掉了：' + JSON.stringify(keep).slice(0, 200));
  });
  await check('H', '🔒 清冊有不存在的系所 → 整批拒絕（不做半套）', async () => {
    const r = await apiCall('adminBulkApplyDeptSheet', {
      rows: [{ deptId: '森林系', fullName: 'A', ext: '1' }, { deptId: '沒這個系', fullName: 'B', ext: '2' }],
      apply: true,
    }, adminToken.token);
    expect(r.success === false && /找不到系所/.test(r.error || ''), '回應=' + JSON.stringify(r));
    const boot = await apiCall('bootstrap', {}, adminToken.token);
    const d = ((boot.data || {}).departments || []).find((x) => x.id === '森林系');
    expect(d.fullName === '森林學系（全名）', '整批拒絕時第一列不該被寫入：' + d.fullName);
  });
  await check('H', '🔒 系辦助理打這個 action → admin only 拒絕', async () => {
    const r = await apiCall('adminBulkApplyDeptSheet', { rows: SHEET_ROWS, apply: true }, deptAsstToken.token);
    expect(r.success === false && /admin only/.test(r.error || ''), '回應=' + JSON.stringify(r));
  });
});

// ══ 🔍 加碼探針 ═══════════════════════════════════════════════════════════════
await check('probe', '🔍 竄改 session token 一字元 → 拒絕', async () => {
  const bad = adminToken.token.slice(0, -2) + (adminToken.token.slice(-2) === 'aa' ? 'bb' : 'aa');
  const r = await apiCall('bootstrap', {}, bad);
  evid['probe-tampered-token'] = JSON.stringify(r);
  expect(r.data && r.data.error === 'Session expired', '回應=' + JSON.stringify(r));
});
await check('probe', '🔍 staffAssistant token 打 adminRolloverApply → admin only 拒絕', async () => {
  const r = await apiCall('adminRolloverApply', { fromSemester: '114-2', toSemester: '115-1', rows: [{ classId: 'x', action: 'keep' }] }, assistantToken.token);
  evid['probe-assistant-admin-action'] = JSON.stringify(r);
  expect(r.success === false && r.error === 'admin only', '回應=' + JSON.stringify(r));
});

// ══ 收尾 ═══════════════════════════════════════════════════════════════════════
fs.writeFileSync(path.join(SHOTS, 'api-evidence.json'), JSON.stringify(evid, null, 2));
console.log('\n══ 結果 ══');
results.forEach((r) => console.log(r));
console.log('\n══ dialogs（自動接受）══');
dialogs.forEach((d) => console.log(' ', d));
console.log('\n══ console errors ══');
if (!consoleErrors.length) console.log('  （無）');
consoleErrors.forEach((e) => console.log(' ', e.slice(0, 300)));
console.log('\n══ API 探針回應體 ══');
Object.entries(evid).forEach(([k, v]) => console.log(' ', k, '=', String(v).slice(0, 240)));

await browser.close();
servers.close();
const failed = results.filter((r) => r.startsWith('❌')).length;
console.log(`\n完成：${results.length} 步，失敗 ${failed}；截圖 ${shotNo} 張 → ${SHOTS}`);
process.exit(0);
