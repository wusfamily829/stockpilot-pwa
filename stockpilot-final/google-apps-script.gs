/*
StockPilot v3.0 — Google Apps Script 最終部署版
功能：
1. 從 Google Sheets 讀取：持股彙總 / 質押與風控儀表板 / 觀察清單 / 績效現金流 / 每日資產快照 / 帳戶設定
2. 使用 Yahoo Finance 免費來源更新股價
3. 依不同帳戶讀取不同手續費、稅率、股利稅、平台費、質押風控門檻
4. 計算維持率、追繳價、斷頭價、補繳建議、壓力測試
5. 輸出 JSON 給 StockPilot PWA 直接讀取
6. 支援 LINE Notify 與時間觸發器
*/

const SPREADSHEET_ID = 'PASTE_YOUR_SPREADSHEET_ID_HERE';
const LINE_NOTIFY_TOKEN = 'PASTE_YOUR_LINE_NOTIFY_TOKEN_HERE';

const SHEET_ACCOUNT   = '帳戶設定';
const SHEET_HOLDINGS  = '持股彙總';
const SHEET_PLEDGE    = '質押與風控儀表板';
const SHEET_WATCHLIST = '觀察清單';
const SHEET_CASHFLOW  = '績效現金流';
const SHEET_SNAPSHOT  = '每日資產快照';

const RISK = {
  SAFE: 1.66,
  CAUTION: 1.40,
  MARGIN_CALL: 1.30,
  FORCED_SELL: 1.20,
  NOTIFY_COOLDOWN_MINUTES: 30
};

function doGet() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const accountRows = getSheetValues_(ss, SHEET_ACCOUNT);
  const accountMap = buildAccountMap_(accountRows);

  const holdingsRaw = getSheetValues_(ss, SHEET_HOLDINGS);
  const pledgeRaw   = getSheetValues_(ss, SHEET_PLEDGE);
  const watchlist   = getSheetValues_(ss, SHEET_WATCHLIST);
  const cashflow    = getSheetValues_(ss, SHEET_CASHFLOW);
  const snapshot    = getSheetValues_(ss, SHEET_SNAPSHOT);

  const holdings = holdingsRaw.map(r => enrichHoldingWithAccount_(r, accountMap[r['帳戶']]));
  const pledgePositions = pledgeRaw.map(r => buildPledgePosition_(r, accountMap[r['帳戶']]));
  const riskAgg = aggregateRisk_(pledgePositions);

  const result = {
    meta: {
      generated_at: new Date().toISOString(),
      spreadsheet_id: SPREADSHEET_ID
    },
    kpis: buildKpis_(holdings, riskAgg),
    allocation: buildAllocation_(holdings),
    profits: buildProfits_(holdings),
    equity: buildSeries_(snapshot, '日期', '淨資產', 10000),
    cash: buildSeries_(cashflow, '日期', '累計現金餘額', 10000, '月份'),
    holdings: buildHoldingsTable_(holdings),
    watchlist: toTable_(watchlist, ['股票代碼','殖利率%','Beta','股價距52週高點%','振幅%','評分','訊號']),
    cashflow: toTable_(cashflow, ['日期','入金','買進支出','賣出回收','股利收入','借款增加','還款支出','淨現金流','累計現金餘額']),
    pledgePositions: pledgePositions,
    accountFees: buildAccountFees_(accountRows),
    summary: buildSummary_(holdings, pledgePositions, riskAgg)
  };

  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

/* ────────────────────────────────────────────────────────
   價格更新
──────────────────────────────────────────────────────── */
function updatePrices() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  updatePriceSheet_(ss.getSheetByName(SHEET_HOLDINGS));
  updatePriceSheet_(ss.getSheetByName(SHEET_PLEDGE));
}

function updatePriceSheet_(sheet) {
  if (!sheet) return;
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return;

  const headers = values[0];
  const codeCol = headers.indexOf('股票代碼');
  const marketCol = headers.indexOf('市場別');
  const priceCol = headers.indexOf('目前價格');
  if ([codeCol, marketCol, priceCol].includes(-1)) return;

  for (let i = 1; i < values.length; i++) {
    const code = values[i][codeCol];
    if (!code) continue;
    const market = String(values[i][marketCol] || '');
    const symbol = normalizeTicker_(String(code), market);
    const price = fetchYahooPrice_(symbol);
    if (price) sheet.getRange(i + 1, priceCol + 1).setValue(price);
    Utilities.sleep(300);
  }
}

/* ────────────────────────────────────────────────────────
   風險通知
──────────────────────────────────────────────────────── */
function checkRiskAlerts() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const accountMap = buildAccountMap_(getSheetValues_(ss, SHEET_ACCOUNT));
  const pledgeRows = getSheetValues_(ss, SHEET_PLEDGE).map(r => buildPledgePosition_(r, accountMap[r['帳戶']]));
  const alerts = pledgeRows.filter(p => ['alert', 'danger', 'critical'].includes(p.level));
  if (!alerts.length) return;

  const props = PropertiesService.getScriptProperties();
  const now = Date.now();
  const cooldownMs = RISK.NOTIFY_COOLDOWN_MINUTES * 60 * 1000;

  const pending = alerts.filter(p => {
    const key = `risk_alert_${p.code}_${p.account}`;
    const raw = props.getProperty(key);
    if (!raw) return true;
    const last = JSON.parse(raw);
    return !(last.level === p.level && now - Number(last.ts || 0) < cooldownMs);
  });

  if (!pending.length) return;

  const message = pending.map(p => {
    return `【${p.label}】${p.code} ${p.name} (${p.account})\n維持率：${formatPct_(p.maintainRate)}\n追繳價：${formatCurrency_(p.marginCallPrice)}\n斷頭價：${formatCurrency_(p.forcedSellPrice)}\n可承受跌幅：${formatPct_(p.tolerableDropPct)}\n建議補現金：${formatCurrency_(p.supplementCash)}\n建議還款：${formatCurrency_(p.repayAmount)}`;
  }).join('\n\n');

  sendLineNotify_(message);
  pending.forEach(p => {
    props.setProperty(`risk_alert_${p.code}_${p.account}`, JSON.stringify({ level: p.level, ts: now }));
  });
}

function createRiskCheckTrigger() {
  ScriptApp.newTrigger('checkRiskAlerts').timeBased().everyMinutes(15).create();
}

function clearRiskAlertCache() {
  const props = PropertiesService.getScriptProperties();
  Object.keys(props.getProperties()).filter(k => k.indexOf('risk_alert_') === 0).forEach(k => props.deleteProperty(k));
}

function sendLineNotify_(message) {
  if (!LINE_NOTIFY_TOKEN || LINE_NOTIFY_TOKEN.indexOf('PASTE_') === 0) return;
  const url = 'https://notify-api.line.me/api/notify';
  UrlFetchApp.fetch(url, {
    method: 'post',
    headers: { Authorization: 'Bearer ' + LINE_NOTIFY_TOKEN },
    payload: { message: '\n' + message },
    muteHttpExceptions: true
  });
}

/* ────────────────────────────────────────────────────────
   Yahoo Price
──────────────────────────────────────────────────────── */
function fetchYahooPrice_(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
    const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    const json = JSON.parse(response.getContentText());
    return json.chart.result[0].meta.regularMarketPrice || '';
  } catch (e) {
    Logger.log(`價格抓取失敗 ${symbol} / ${e}`);
    return '';
  }
}

function normalizeTicker_(code, market) {
  const clean = code.trim();
  if (market === '台股') return clean + '.TW';
  return clean;
}

/* ────────────────────────────────────────────────────────
   Account Settings
──────────────────────────────────────────────────────── */
function buildAccountMap_(rows) {
  const map = {};
  rows.forEach(r => {
    const acc = String(r['帳戶'] || '').trim();
    if (!acc) return;
    map[acc] = {
      user: r['使用者'] || '',
      account: acc,
      market: r['市場別'] || '',
      currency: r['幣別'] || '',
      broker: r['券商/平台'] || '',
      commissionRate: num_(r['股票手續費率']),
      discount: num_(r['手續費折扣係數']) || 1,
      minCommission: num_(r['最低手續費']),
      sellTax: num_(r['賣出交易稅率']),
      dividendTax: num_(r['股利稅率']),
      platformFee: num_(r['匯費/平台固定費']),
      pledgeRate: num_(r['質押利率']),
      safeRate: num_(r['目標安全維持率']) || RISK.SAFE,
      marginCallRate: num_(r['追繳維持率']) || RISK.MARGIN_CALL,
      forcedSellRate: num_(r['斷頭維持率']) || RISK.FORCED_SELL,
      note: r['備註'] || ''
    };
  });
  return map;
}

function buildAccountFees_(rows) {
  return rows.map(r => ({
    account: r['帳戶'] || '',
    user: r['使用者'] || '',
    broker: r['券商/平台'] || '',
    market: r['市場別'] || '',
    currency: r['幣別'] || '',
    commissionRate: num_(r['股票手續費率']),
    discount: num_(r['手續費折扣係數']) || 1,
    minCommission: num_(r['最低手續費']),
    sellTax: num_(r['賣出交易稅率']),
    dividendTax: num_(r['股利稅率']),
    platformFee: num_(r['匯費/平台固定費']),
    pledgeRate: num_(r['質押利率']),
    safeRate: num_(r['目標安全維持率']) || RISK.SAFE,
    marginCallRate: num_(r['追繳維持率']) || RISK.MARGIN_CALL,
    forcedSellRate: num_(r['斷頭維持率']) || RISK.FORCED_SELL,
    realCommissionRate: round4_(num_(r['股票手續費率']) * (num_(r['手續費折扣係數']) || 1))
  }));
}

/* ────────────────────────────────────────────────────────
   Holdings / Pledge Enrich
──────────────────────────────────────────────────────── */
function enrichHoldingWithAccount_(row, accountCfg) {
  const feeCfg = accountCfg || {};
  return Object.assign({}, row, {
    帳戶手續費率: round4_((feeCfg.commissionRate || 0) * (feeCfg.discount || 1)),
    帳戶賣出交易稅率: feeCfg.sellTax || 0,
    帳戶股利稅率: feeCfg.dividendTax || 0,
    帳戶安全維持率: feeCfg.safeRate || RISK.SAFE
  });
}

function buildHoldingsTable_(rows) {
  return toTable_(rows, ['使用者','帳戶','股票代碼','股票名稱','持有數量','平均成本','目前價格','目前市值','未實現損益金額','未實現損益%','預估每年股息收入','波動分類','帳戶手續費率']);
}

function buildPledgePosition_(row, accountCfg) {
  const cfg = accountCfg || {};
  const shares = num_(row['質押股數']);
  const price = num_(row['目前價格']);
  const loan = num_(row['借款餘額']);
  const targetRate = num_(row['目標安全維持率']) || cfg.safeRate || RISK.SAFE;
  const marginCallRate = num_(row['追繳維持率']) || cfg.marginCallRate || RISK.MARGIN_CALL;
  const forcedSellRate = num_(row['斷頭維持率']) || cfg.forcedSellRate || RISK.FORCED_SELL;
  const collateralValue = shares * price;
  const maintainRate = loan > 0 ? collateralValue / loan : 999;
  const marginCallPrice = shares > 0 ? loan * marginCallRate / shares : 0;
  const forcedSellPrice = shares > 0 ? loan * forcedSellRate / shares : 0;
  const tolerableDropPct = price > 0 ? Math.max(0, (price - marginCallPrice) / price) : 0;
  const forcedDropPct = price > 0 ? Math.max(0, (price - forcedSellPrice) / price) : 0;
  const supplementCash = Math.max(0, loan * targetRate - collateralValue);
  const repayAmount = Math.max(0, loan - collateralValue / targetRate);
  const level = riskLevel_(maintainRate);
  return {
    user: row['使用者'] || cfg.user || '',
    account: row['帳戶'] || cfg.account || '',
    market: row['市場別'] || cfg.market || '',
    code: row['股票代碼'] || '',
    name: row['股票名稱'] || '',
    pledgedShares: shares,
    currentPrice: price,
    loanBalance: loan,
    pledgeRatio: num_(row['質押成數']) || 0,
    targetRate: targetRate,
    marginCallRate: marginCallRate,
    forcedSellRate: forcedSellRate,
    collateralValue: collateralValue,
    maintainRate: maintainRate,
    marginCallPrice: marginCallPrice,
    forcedSellPrice: forcedSellPrice,
    tolerableDropPct: tolerableDropPct,
    forcedDropPct: forcedDropPct,
    supplementCash: supplementCash,
    repayAmount: repayAmount,
    pledgeRate: cfg.pledgeRate || 0,
    stress10Rate: loan > 0 ? (shares * price * 0.9) / loan : 999,
    stress20Rate: loan > 0 ? (shares * price * 0.8) / loan : 999,
    stress30Rate: loan > 0 ? (shares * price * 0.7) / loan : 999,
    level: level,
    label: riskLabel_(level)
  };
}

function aggregateRisk_(positions) {
  const totalLoan = positions.reduce((s, p) => s + p.loanBalance, 0);
  const totalCollateral = positions.reduce((s, p) => s + p.collateralValue, 0);
  const overallMaintainRate = totalLoan > 0 ? totalCollateral / totalLoan : 999;
  const totalSupplementCash = positions.reduce((s, p) => s + p.supplementCash, 0);
  return {
    totalLoan: totalLoan,
    totalCollateral: totalCollateral,
    overallMaintainRate: overallMaintainRate,
    totalSupplementCash: totalSupplementCash,
    worst: positions.slice().sort((a, b) => a.maintainRate - b.maintainRate)[0] || null
  };
}

/* ────────────────────────────────────────────────────────
   Build JSON Payload
──────────────────────────────────────────────────────── */
function buildKpis_(holdings, riskAgg) {
  const totalCost = sumCol_(holdings, '買進成本總額');
  const totalMarket = sumCol_(holdings, '目前市值');
  const unrealized = sumCol_(holdings, '未實現損益金額');
  const realized = sumCol_(holdings, '已實現損益金額');
  return [
    { title: '總投資成本', value: formatCurrency_(totalCost) },
    { title: '總市值', value: formatCurrency_(totalMarket) },
    { title: '未實現損益', value: formatSignedCurrency_(unrealized), cls: unrealized >= 0 ? 'up' : 'down' },
    { title: '已實現損益', value: formatSignedCurrency_(realized), cls: realized >= 0 ? 'up' : 'down' },
    { title: '整體維持率', value: formatPct_(riskAgg.overallMaintainRate), cls: riskAgg.overallMaintainRate < RISK.CAUTION ? 'warn' : '' }
  ];
}

function buildAllocation_(holdings) {
  const total = sumCol_(holdings, '目前市值') || 1;
  return holdings.filter(r => num_(r['目前市值']) > 0).map(r => ({
    name: `${r['股票代碼']} ${r['股票名稱']}`,
    value: Math.round((num_(r['目前市值']) / total) * 1000) / 10
  }));
}

function buildProfits_(holdings) {
  return holdings.filter(r => r['股票代碼']).map(r => ({
    name: r['股票代碼'],
    value: num_(r['未實現損益金額']) + num_(r['已實現損益金額'])
  }));
}

function buildSeries_(rows, labelKey, valueKey, divisor, fallbackLabelKey) {
  const last = rows.slice(-6);
  return {
    labels: last.map(r => r[labelKey] || r[fallbackLabelKey] || ''),
    values: last.map(r => num_(r[valueKey]) / (divisor || 1))
  };
}

function buildSummary_(holdings, pledgePositions, riskAgg) {
  const topHolding = holdings.slice().sort((a, b) => num_(b['目前市值']) - num_(a['目前市值']))[0];
  const topDividend = holdings.slice().sort((a, b) => num_(b['預估每年股息收入']) - num_(a['預估每年股息收入']))[0];
  return [
    `最大部位：${topHolding ? topHolding['股票代碼'] : '-'}`,
    `年股息最高：${topDividend ? topDividend['股票代碼'] : '-'}`,
    `最需注意風控：${riskAgg.worst ? riskAgg.worst.code : '-'}`,
    `整體建議補繳：${formatCurrency_(riskAgg.totalSupplementCash)}`
  ];
}

/* ────────────────────────────────────────────────────────
   Common Utils
──────────────────────────────────────────────────────── */
function riskLevel_(rate) {
  if (rate < RISK.FORCED_SELL) return 'critical';
  if (rate < RISK.MARGIN_CALL) return 'danger';
  if (rate < RISK.CAUTION) return 'alert';
  if (rate < RISK.SAFE) return 'caution';
  return 'safe';
}

function riskLabel_(level) {
  return { safe: '安全', caution: '注意', alert: '警戒', danger: '追繳', critical: '斷頭' }[level] || '安全';
}

function getSheetValues_(ss, name) {
  const sheet = ss.getSheetByName(name);
  if (!sheet) return [];
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0];
  return values.slice(1).filter(row => row.join('') !== '').map(row => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = row[i]);
    return obj;
  });
}

function toTable_(rows, columns) {
  return [columns].concat(rows.map(r => columns.map(c => r[c] ?? '')));
}

function sumCol_(rows, key) {
  return rows.reduce((sum, row) => sum + num_(row[key]), 0);
}

function num_(v) {
  if (v === null || v === undefined || v === '') return 0;
  return Number(String(v).replace(/,/g, '').replace('%', '')) || 0;
}

function round4_(v) {
  return Math.round((v || 0) * 10000) / 10000;
}

function formatCurrency_(v) {
  return 'NT$ ' + Math.round(v || 0).toLocaleString('zh-TW');
}

function formatSignedCurrency_(v) {
  return (v >= 0 ? '+ NT$ ' : '- NT$ ') + Math.abs(Math.round(v || 0)).toLocaleString('zh-TW');
}

function formatPct_(v) {
  return (v * 100).toFixed(1) + '%';
}