/**
 * StockPilot v3.0 — app.js
 * 完整質押風控 + 帳戶費率分開設定 + Google Sheets 對應 + PWA 最終部署版
 */

/* ═══════════════════════════════════════════════════════
   0. CONFIG & STATE
═══════════════════════════════════════════════════════ */
const CFG = window.SP_CONFIG || {};
const RISK = CFG.RISK || { safe:1.66, caution:1.40, marginCall:1.30, forcedSell:1.20, notifyCooldownMs:1800000 };
const TRAILING = CFG.TRAILING || { high:.12, mid:.08, low:.05 };
let SCRIPT_URL = CFG.APPS_SCRIPT_URL || localStorage.getItem('sp_script_url') || '';
let currentData = null;
let deferredPrompt = null;
let pledgePositionsCache = [];
let accountFeesCache = [];
const $ = id => document.getElementById(id);

/* ========================================
   0.5. PASSWORD PROTECTION
======================================== */

(function initPasswordProtection() {
  const CORRECT_PASSWORD = 'rich0829'; // ← 請改成你的密碼
  const SESSION_KEY = 'sp_auth_session';

  // 如果本次瀏覽已驗證過，直接放行
  if (sessionStorage.getItem(SESSION_KEY) === 'authenticated') return;

  // 建立全螢幕密碼輸入介面
  const authOverlay = document.createElement('div');
  authOverlay.style.cssText = `
    position: fixed; top: 0; left: 0; width: 100%; height: 100%;
    background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
    display: flex; align-items: center; justify-content: center;
    z-index: 99999; font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  `;

  authOverlay.innerHTML = `
    <div style="
      background: #1e293b; border: 1px solid #334155; border-radius: 16px;
      padding: 40px; width: 90%; max-width: 360px; text-align: center;
      box-shadow: 0 25px 80px rgba(0,0,0,0.6);
    ">
      <div style="font-size: 48px; margin-bottom: 20px;">🔐</div>
      <h2 style="color: #f1f5f9; margin: 0 0 8px 0; font-size: 24px; font-weight: 600;">
        StockPilot 投資追蹤
      </h2>
      <p style="color: #94a3b8; margin: 0 0 30px 0; font-size: 14px;">
        請輸入存取密碼以保護您的投資資料
      </p>
      
      <input id="sp-auth-input" type="password" placeholder="輸入密碼" style="
        width: 100%; padding: 14px 18px; border-radius: 10px;
        border: 2px solid #475569; background: #0f172a; color: #f1f5f9;
        font-size: 16px; box-sizing: border-box; margin-bottom: 12px;
        outline: none; transition: border-color 0.2s;
      " />
      
      <div id="sp-auth-error" style="
        color: #ef4444; font-size: 13px; margin-bottom: 20px;
        min-height: 18px; font-weight: 500;
      "></div>
      
      <button id="sp-auth-btn" style="
        width: 100%; padding: 14px; background: #3b82f6; color: white;
        border: none; border-radius: 10px; font-size: 16px; font-weight: 600;
        cursor: pointer; transition: background 0.2s;
      " onmouseover="this.style.background='#2563eb'" 
         onmouseout="this.style.background='#3b82f6'">
        🚀 進入系統
      </button>
    </div>
  `;

  document.body.appendChild(authOverlay);

  // 驗證函數
  function authenticateUser() {
    const inputPassword = document.getElementById('sp-auth-input').value.trim();
    const errorDiv = document.getElementById('sp-auth-error');
    
    if (inputPassword === CORRECT_PASSWORD) {
      sessionStorage.setItem(SESSION_KEY, 'authenticated');
      authOverlay.remove();
    } else {
      errorDiv.textContent = inputPassword ? '❌ 密碼錯誤，請重新輸入' : '⚠️ 請輸入密碼';
      document.getElementById('sp-auth-input').value = '';
      document.getElementById('sp-auth-input').focus();
    }
  }

  // 事件監聽
  document.getElementById('sp-auth-btn').addEventListener('click', authenticateUser);
  document.getElementById('sp-auth-input').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') authenticateUser();
  });
  
  // 自動聚焦到密碼輸入框
  setTimeout(() => document.getElementById('sp-auth-input').focus(), 100);
})();

/* ========================================
   1. FALLBACK DEMO DATA
======================================== */

const DEMO = {
  kpis:[
    {title:'總投資成本',value:'NT$ 8,460,000'},
    {title:'總市值',value:'NT$ 9,125,300'},
    {title:'未實現損益',value:'+ NT$ 665,300',cls:'up'},
    {title:'已實現損益',value:'+ NT$ 182,600',cls:'up'},
    {title:'整體維持率',value:'168%',cls:'warn'}
  ],
  allocation:[{name:'2330 台積電',value:41},{name:'0050',value:18},{name:'00878',value:15},{name:'AAPL',value:16},{name:'NVDA',value:10}],
  profits:[{name:'2330',value:200000},{name:'0050',value:25000},{name:'00878',value:19200},{name:'AAPL',value:3450},{name:'NVDA',value:-800}],
  equity:{labels:['1月','2月','3月','4月','5月','6月'],values:[780,798,821,845,876,913]},
  cash:{labels:['1月','2月','3月','4月','5月','6月'],values:[110,119,127,166,162,165]},
  holdings:[
    ['使用者','帳戶','股票代碼','股票名稱','持有數量','平均成本','目前價格','目前市值','未實現損益','損益%','預估年股息','波動','手續費率'],
    ['王小明','A01-永豐','2330','台積電','2,000','850','950','1,900,000','+200,000','+11.8%','14,000','中','0.0926%'],
    ['王小明','A02-玉山','0050','元大台灣50','5,000','162','167','835,000','+25,000','+3.1%','17,500','低','0.0713%'],
    ['林小華','A03-富邦','00878','國泰永續高股息','12,000','21.2','22.8','273,600','+19,200','+7.5%','21,600','低','0.0855%'],
    ['林小華','A04-IB','AAPL','Apple','150','182','205','30,750','+3,450','+12.6%','150','中','0%'],
    ['林小華','A05-Firstrade','NVDA','NVIDIA','200','128','124','24,800','-800','-3.1%','32','高','0%']
  ],
  watchlist:[
    ['股票','殖利率','Beta','距52週高點','振幅','評分','訊號'],
    ['00878','7.9%','0.72','-8%','18%','86','Strong Buy'],
    ['2330','2.1%','1.05','-3%','25%','72','Hold'],
    ['AAPL','0.5%','1.12','-5%','22%','69','Hold'],
    ['NVDA','0.1%','1.62','-12%','48%','45','Sell']
  ],
  cashflow:[
    ['月份','入金','買進支出','賣出回收','股利','借款','還款','淨現金流','累計現金'],
    ['1月','800,000','650,000','0','0','0','0','+150,000','1,100,000'],
    ['2月','320,000','280,000','50,000','0','0','0','+90,000','1,190,000'],
    ['3月','460,000','390,000','0','8,200','0','0','+78,200','1,268,200'],
    ['4月','220,000','310,000','180,000','0','300,000','0','+390,000','1,658,200'],
    ['5月','550,000','420,000','0','12,400','0','180,000','-37,600','1,620,600'],
    ['6月','410,000','360,000','95,000','6,800','0','120,000','+31,800','1,652,400']
  ],
  pledgePositions:[
    {user:'王小明',account:'A01-永豐',code:'2330',name:'台積電',pledgedShares:1000,currentPrice:950,loanBalance:555000,pledgeRatio:.6,targetRate:1.66,marginCallRate:1.30,forcedSellRate:1.20},
    {user:'王小明',account:'A02-玉山',code:'0050',name:'元大台灣50',pledgedShares:3000,currentPrice:167,loanBalance:325000,pledgeRatio:.6,targetRate:1.66,marginCallRate:1.30,forcedSellRate:1.20},
    {user:'林小華',account:'A04-IB',code:'AAPL',name:'Apple',pledgedShares:80,currentPrice:205,loanBalance:8700,pledgeRatio:.5,targetRate:1.50,marginCallRate:1.25,forcedSellRate:1.15},
    {user:'林小華',account:'A05-Firstrade',code:'NVDA',name:'NVIDIA',pledgedShares:120,currentPrice:124,loanBalance:11500,pledgeRatio:.5,targetRate:1.50,marginCallRate:1.25,forcedSellRate:1.15}
  ],
  accountFees:[
    {account:'A01-永豐',user:'王小明',broker:'永豐金證券',market:'台股',currency:'TWD',commissionRate:0.001425,discount:0.65,minCommission:20,sellTax:0.003,dividendTax:0,platformFee:0,pledgeRate:0.025,safeRate:1.66,marginCallRate:1.30,forcedSellRate:1.20},
    {account:'A02-玉山',user:'王小明',broker:'玉山證券',market:'台股',currency:'TWD',commissionRate:0.001425,discount:0.50,minCommission:20,sellTax:0.003,dividendTax:0,platformFee:0,pledgeRate:0.028,safeRate:1.66,marginCallRate:1.30,forcedSellRate:1.20},
    {account:'A03-富邦',user:'林小華',broker:'富邦證券',market:'台股',currency:'TWD',commissionRate:0.001425,discount:0.60,minCommission:20,sellTax:0.003,dividendTax:0,platformFee:0,pledgeRate:0.026,safeRate:1.70,marginCallRate:1.35,forcedSellRate:1.25},
    {account:'A04-IB',user:'林小華',broker:'Interactive Brokers',market:'美股',currency:'USD',commissionRate:0.0005,discount:1.00,minCommission:1,sellTax:0.000278,dividendTax:0.30,platformFee:0,pledgeRate:0.065,safeRate:1.50,marginCallRate:1.25,forcedSellRate:1.15},
    {account:'A05-Firstrade',user:'林小華',broker:'Firstrade',market:'美股',currency:'USD',commissionRate:0,discount:1.00,minCommission:0,sellTax:0.000278,dividendTax:0.30,platformFee:0,pledgeRate:0,safeRate:1.50,marginCallRate:1.25,forcedSellRate:1.15}
  ],
  summary:['最大部位：2330 台積電','年股息最高：00878','最需注意風控：NVDA（維持率 129%，接近追繳）','整體建議補繳：NT$ 0（目前安全）']
};

/* ═══════════════════════════════════════════════════════
   2. HELPERS
═══════════════════════════════════════════════════════ */
function n(v){if(v==null||v==='')return 0;return Number(String(v).replace(/,/g,'').replace('%',''))||0;}
function fmtM(v){return 'NT$ '+Math.round(v).toLocaleString('zh-TW');}
function fmtMS(v){return(v>=0?'+ NT$ ':'- NT$ ')+Math.abs(Math.round(v)).toLocaleString('zh-TW');}
function fmtP(v,d=1){return(v*100).toFixed(d)+'%';}
function fmtR(rate,d=1){return(rate*100).toFixed(d)+'%';}
function riskLv(rate){
  if(rate<RISK.forcedSell)return'critical';
  if(rate<RISK.marginCall)return'danger';
  if(rate<RISK.caution)return'alert';
  if(rate<RISK.safe)return'caution';
  return'safe';
}
function riskLb(rate){return({safe:'安全',caution:'注意',alert:'警戒',danger:'追繳',critical:'斷頭'})[riskLv(rate)];}
function lvCls(lv){return({safe:'safe',caution:'caution',alert:'alert',danger:'danger',critical:'critical'})[lv]||'neutral';}

/* 交易成本計算 */
function calcTxCost(amount, fee){
  const comm = Math.max(amount*fee.commissionRate*fee.discount, fee.minCommission);
  return comm;
}
function calcSellCost(amount, fee){
  const comm = calcTxCost(amount, fee);
  const tax  = amount * fee.sellTax;
  return {comm, tax, total: comm+tax};
}
function getFeeByAccount(account){
  const data = (currentData||DEMO).accountFees||DEMO.accountFees;
  return data.find(f=>f.account===account) || DEMO.accountFees[0];
}

/* ═══════════════════════════════════════════════════════
   3. RISK ENGINE
═══════════════════════════════════════════════════════ */
function calcPosition(p){
  const shares=n(p.pledgedShares), price=n(p.currentPrice), loan=n(p.loanBalance);
  const targetRate=n(p.targetRate)||RISK.safe;
  const mcRate=n(p.marginCallRate)||RISK.marginCall;
  const fsRate=n(p.forcedSellRate)||RISK.forcedSell;
  const coll=shares*price;
  const mRate=loan>0?coll/loan:999;
  const mcPrice=shares>0?loan*mcRate/shares:0;
  const fsPrice=shares>0?loan*fsRate/shares:0;
  const tDrop=price>0?Math.max(0,(price-mcPrice)/price):0;
  const fDrop=price>0?Math.max(0,(price-fsPrice)/price):0;
  const suppCash=Math.max(0,loan*targetRate-coll);
  const repay=Math.max(0,loan-coll/targetRate);
  const stress=[-0.10,-0.20,-0.30].map(s=>{
    const sp=price*(1+s), sc=shares*sp, sr=loan>0?sc/loan:999;
    return{shock:s,stressedPrice:sp,stressedCollateral:sc,stressedRate:sr,level:riskLv(sr),label:riskLb(sr)};
  });
  const lv=riskLv(mRate);
  return{...p,shares,price,loan,targetRate,mcRate,fsRate,coll,mRate,mcPrice,fsPrice,tDrop,fDrop,suppCash,repay,lv,label:riskLb(mRate),stress};
}
function getPledgePositions(){
  const base=currentData?.pledgePositions?.length?currentData.pledgePositions:DEMO.pledgePositions;
  return base.map(calcPosition);
}
function aggregateRisk(positions){
  const tLoan=positions.reduce((s,p)=>s+p.loan,0);
  const tColl=positions.reduce((s,p)=>s+p.coll,0);
  const overall=tLoan>0?tColl/tLoan:999;
  const worst=positions.slice().sort((a,b)=>a.mRate-b.mRate)[0];
  const tSupp=positions.reduce((s,p)=>s+p.suppCash,0);
  const leverage=tColl>0?tLoan/tColl:0;
  const stress=[-0.10,-0.20,-0.30].map(shock=>{
    const c=positions.reduce((s,p)=>s+p.shares*p.price*(1+shock),0);
    const r=tLoan>0?c/tLoan:999;
    return{shock,rate:r,label:riskLb(r),level:riskLv(r)};
  });
  return{tLoan,tColl,overall,worst,tSupp,leverage,stress};
}

/* ═══════════════════════════════════════════════════════
   4. RENDER HELPERS
═══════════════════════════════════════════════════════ */
function renderKPIs(){
  const data=currentData||DEMO;
  $('kpiGrid').innerHTML=data.kpis.map(item=>`
    <article class="kpi-card">
      <div class="kpi-title">${item.title}</div>
      <div class="kpi-value ${item.cls||''}">${item.value}</div>
    </article>`).join('');
}
function renderBars(tid,items,mode){
  const mx=Math.max(...items.map(x=>Math.abs(Number(x.value))),1);
  $(tid).innerHTML=items.map(item=>{
    const w=Math.max(8,Math.round(Math.abs(Number(item.value))/mx*100));
    const cls=Number(item.value)<0?'green':mode==='profit'?'red':'blue';
    const lb=mode==='profit'?(Number(item.value)>=0?'+':'')+Number(item.value).toLocaleString('zh-TW'):`${item.value}%`;
    return`<div class="bar-item"><div class="bar-head"><span>${item.name}</span><strong>${lb}</strong></div><div class="bar-track"><div class="bar-fill ${cls}" style="width:${w}%"></div></div></div>`;
  }).join('');
}
function renderCell(v){
  const t=String(v);
  if(['安全','Strong Buy'].includes(t))return`<td><span class="tag safe">${t}</span></td>`;
  if(t==='注意')return`<td><span class="tag caution">${t}</span></td>`;
  if(['警戒','減碼觀察'].includes(t))return`<td><span class="tag alert">${t}</span></td>`;
  if(['追繳','Sell'].includes(t))return`<td><span class="tag danger">${t}</span></td>`;
  if(t==='斷頭')return`<td><span class="tag critical">${t}</span></td>`;
  if(['Hold','續抱'].includes(t))return`<td><span class="tag neutral">${t}</span></td>`;
  if(t.startsWith('+'))return`<td class="up">${t}</td>`;
  if(t.startsWith('-'))return`<td class="down">${t}</td>`;
  return`<td>${t}</td>`;
}
function renderTable(tid,rows){
  if(!rows||!rows.length)return;
  const[head,...body]=rows;
  $(tid).innerHTML=`<thead><tr>${head.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${body.map(r=>`<tr>${r.map(c=>renderCell(c)).join('')}</tr>`).join('')}</tbody>`;
}
function drawLine(sid,labels,values,stroke,fill){
  const svg=$(sid);if(!svg)return;
  const W=700,H=240,P=32;
  const mn=Math.min(...values),mx=Math.max(...values);
  const xs=(W-P*2)/((values.length-1)||1);
  const sy=v=>H-P-((v-mn)/((mx-mn)||1))*(H-P*2);
  const pts=values.map((v,i)=>`${P+i*xs},${sy(v)}`).join(' ');
  const area=`${P},${H-P} ${pts} ${P+(values.length-1)*xs},${H-P}`;
  svg.innerHTML=`<defs><linearGradient id="${sid}-g" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${fill}"/><stop offset="100%" stop-color="rgba(255,255,255,0)"/></linearGradient></defs>${values.map((_,i)=>`<line x1="${P+i*xs}" y1="${P}" x2="${P+i*xs}" y2="${H-P}" stroke="#edf3fa"/>`).join('')}<polygon points="${area}" fill="url(#${sid}-g)"/><polyline points="${pts}" fill="none" stroke="${stroke}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>${values.map((v,i)=>`<circle cx="${P+i*xs}" cy="${sy(v)}" r="4" fill="${stroke}"/><text x="${P+i*xs}" y="${H-8}" font-size="11" text-anchor="middle" fill="#7b90a7">${labels[i]}</text>`).join('')}`;
}

/* ═══════════════════════════════════════════════════════
   5. RISK MODULE RENDERS
═══════════════════════════════════════════════════════ */
function renderRiskKPIs(agg){
  $('riskKpiGrid').innerHTML=[
    {title:'整體維持率',value:fmtR(agg.overall),cls:lvCls(riskLv(agg.overall))},
    {title:'總借款餘額',value:fmtM(agg.tLoan)},
    {title:'總擔保品市值',value:fmtM(agg.tColl)},
    {title:'整體槓桿比率',value:fmtP(agg.leverage)}
  ].map(i=>`<article class="kpi-card"><div class="kpi-title">${i.title}</div><div class="kpi-value ${i.cls||''}">${i.value}</div></article>`).join('');
}
function renderRiskSummaryCards(positions){
  $('riskSummaryCards').innerHTML=positions.map(p=>`
    <div class="risk-card">
      <div class="risk-card-head"><strong>${p.code} ${p.name}</strong><span class="tag ${lvCls(p.lv)}">${p.label}</span></div>
      <div><small>維持率</small> <strong class="${lvCls(p.lv)}">${fmtR(p.mRate)}</strong></div>
      <div><small>追繳價</small> <strong>${fmtM(p.mcPrice)}</strong></div>
      <div><small>可承受跌幅</small> <strong>${fmtP(p.tDrop)}</strong></div>
    </div>`).join('');
}
function renderPledgeTable(positions){
  const head=['使用者','帳戶','股票','質押股數','現價','借款餘額','擔保品市值','維持率','追繳價','斷頭價','可承受跌幅','距斷頭跌幅','補現金建議','還款建議','燈號'];
  const rows=positions.map(p=>[p.user,p.account,`${p.code} ${p.name}`,p.shares.toLocaleString('zh-TW'),fmtM(p.price),fmtM(p.loan),fmtM(p.coll),fmtR(p.mRate),fmtM(p.mcPrice),fmtM(p.fsPrice),fmtP(p.tDrop),fmtP(p.fDrop),fmtM(p.suppCash),fmtM(p.repay),p.label]);
  renderTable('pledgeTable',[head,...rows]);
}
function renderStressTests(positions,agg){
  const labels=['股價下跌 -10%','股價下跌 -20%','股價下跌 -30%'];
  $('stressTestGrid').innerHTML=agg.stress.map((s,i)=>`
    <div class="stress-card">
      <h4>${labels[i]}</h4>
      <div class="stress-list">
        <div class="stress-row"><span>投組整體</span><strong class="${lvCls(s.level)}">${fmtR(s.rate)} / ${s.label}</strong></div>
        ${positions.map(p=>`<div class="stress-row"><span>${p.code}</span><strong class="${lvCls(p.stress[i].level)}">${fmtR(p.stress[i].stressedRate)} / ${p.stress[i].label}</strong></div>`).join('')}
      </div>
    </div>`).join('');
}
function renderToleranceViz(positions){
  $('toleranceViz').innerHTML=positions.map(p=>{
    const mx=Math.max(p.price,p.mcPrice,p.fsPrice)||1;
    const safeEnd=Math.min(100,p.mcPrice/mx*100);
    const warnEnd=Math.min(100,p.fsPrice/mx*100);
    const curPos=Math.min(100,p.price/mx*100);
    return`<div class="tolerance-item">
      <div class="tolerance-head"><strong>${p.code} ${p.name}</strong><span class="tag ${lvCls(p.lv)}">${p.label}</span></div>
      <div class="tolerance-track">
        <div class="tolerance-seg-danger" style="left:0;width:${warnEnd}%"></div>
        <div class="tolerance-seg-warn" style="left:${warnEnd}%;width:${Math.max(0,safeEnd-warnEnd)}%"></div>
        <div class="tolerance-seg-safe" style="left:${safeEnd}%;width:${Math.max(0,100-safeEnd)}%"></div>
        <div class="tolerance-marker" style="left:${curPos}%"></div>
      </div>
      <div class="tolerance-labels"><span>斷頭 ${fmtM(p.fsPrice)}</span><span>追繳 ${fmtM(p.mcPrice)}</span><span>現價 ${fmtM(p.price)}</span></div>
    </div>`;
  }).join('');
}
function renderNotifyPanel(positions,agg){
  const alerts=positions.filter(p=>['alert','danger','critical'].includes(p.lv));
  $('notifyPanel').innerHTML=`
    <div class="notify-card"><h4>瀏覽器推播邏輯</h4><ul>
      <li>維持率 &lt; 140%：警戒通知</li>
      <li>維持率 &lt; 130%：追繳緊急通知</li>
      <li>維持率 &lt; 120%：斷頭緊急通知</li>
      <li>同一檔股票 30 分鐘內不重複通知</li>
    </ul></div>
    <div class="notify-card"><h4>LINE Notify（Apps Script）</h4><ul>
      <li>每 15 分鐘自動檢查質押風控</li>
      <li>有部位落入警戒 / 追繳 / 斷頭時推送 LINE</li>
      <li>通知內容：股票、維持率、追繳價、斷頭價、補繳建議</li>
    </ul></div>
    <div class="notify-card"><h4>目前待通知部位</h4>
      <p>${alerts.length?alerts.map(p=>`${p.code} ${p.label}（${fmtR(p.mRate)}）`).join('、'):'目前無需立即通知的部位。'}</p>
    </div>
    <div class="notify-card"><h4>整體建議補繳</h4>
      <p>回到 ${fmtR(RISK.safe)} 安全維持率，建議補現金合計 <strong>${fmtM(agg.tSupp)}</strong>，或優先償還高風險部位借款。</p>
    </div>`;
}
function renderAlertBanner(positions,agg){
  const danger=positions.filter(p=>['danger','critical'].includes(p.lv));
  const caution=positions.filter(p=>p.lv==='alert');
  const badge=$('globalRiskBadge');
  const banner=$('alertBanner');
  if(danger.length||caution.length){
    const txts=[];
    if(danger.length)txts.push(`高風險 ${danger.map(p=>p.code).join('、')}`);
    if(caution.length)txts.push(`警戒 ${caution.map(p=>p.code).join('、')}`);
    banner.textContent=`風控提醒：${txts.join(' ｜ ')} ｜ 整體維持率 ${fmtR(agg.overall)} ｜ 建議補繳 ${fmtM(agg.tSupp)}`;
    banner.classList.remove('hidden');
    badge.className=`global-risk-badge ${lvCls(riskLv(agg.overall))}`;
    badge.textContent=`整體風控 ${riskLb(agg.overall)} ${fmtR(agg.overall)}`;
    badge.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
    badge.className='global-risk-badge safe';
    badge.textContent=`整體風控安全 ${fmtR(agg.overall)}`;
    badge.classList.remove('hidden');
  }
}

/* ═══════════════════════════════════════════════════════
   6. ACCOUNT FEES MODULE
═══════════════════════════════════════════════════════ */
function renderAccountsTable(){
  const fees=(currentData?.accountFees||DEMO.accountFees);
  accountFeesCache=fees;
  const head=['帳戶','使用者','券商/平台','市場','幣別','手續費率','折扣','最低手續費','賣出稅率','股利稅率','平台費','質押利率','安全維持率','追繳維持率','斷頭維持率'];
  const rows=fees.map(f=>[
    f.account,f.user,f.broker,f.market,f.currency,
    fmtP(f.commissionRate,4),fmtP(f.discount,0),
    f.minCommission>0?`${f.currency==='USD'?'$':'NT$'}${f.minCommission}`:'無',
    fmtP(f.sellTax,4),fmtP(f.dividendTax,0),
    f.platformFee>0?fmtM(f.platformFee):'無',
    fmtP(f.pledgeRate,2),
    fmtR(f.safeRate),fmtR(f.marginCallRate),fmtR(f.forcedSellRate)
  ]);
  renderTable('accountsTable',[head,...rows]);
  // 填補繳試算帳戶選單
  const sel=$('feeCalcAccount');
  if(sel){sel.innerHTML=fees.map(f=>`<option value="${f.account}">${f.account} ${f.broker}</option>`).join('');}
}
function runFeeCalc(){
  const account=$('feeCalcAccount').value;
  const amount=Number($('feeCalcAmount').value)||100000;
  const type=$('feeCalcType').value;
  const fee=getFeeByAccount(account);
  const realRate=fee.commissionRate*fee.discount;
  const comm=Math.max(amount*realRate,fee.minCommission);
  let html=`<strong>${account} ─ ${fee.broker}</strong><br>`;
  html+=`手續費率：${fmtP(realRate,4)}（官方 ${fmtP(fee.commissionRate,4)} × ${fmtP(fee.discount,0)} 折扣）<br>`;
  html+=`交易金額：${fee.currency==='USD'?'US$':'NT$'}${amount.toLocaleString('zh-TW')}<br>`;
  html+=`手續費：<strong>${fee.currency==='USD'?'US$':'NT$'}${Math.round(comm*10)/10}</strong>`;
  if(type==='sell'){
    const tax=amount*fee.sellTax;
    const total=comm+tax;
    html+=`<br>賣出交易稅（${fmtP(fee.sellTax,4)}）：<strong>${fee.currency==='USD'?'US$':'NT$'}${Math.round(tax*10)/10}</strong>`;
    html+=`<br>合計成本：<strong class="up">${fee.currency==='USD'?'US$':'NT$'}${Math.round(total*10)/10}</strong>`;
  }
  $('feeCalcResult').innerHTML=html;
}

/* ═══════════════════════════════════════════════════════
   7. HOLDINGS FILTER
═══════════════════════════════════════════════════════ */
function initHoldingsFilters(){
  const data=(currentData||DEMO).holdings;
  if(!data||data.length<2)return;
  const [,colU,,colA]=[0,1,2,3]; // 使用者=col1, 帳戶=col2
  const users=[...new Set(data.slice(1).map(r=>r[1]))];
  const accs=[...new Set(data.slice(1).map(r=>r[2]))];
  const us=$('holdingsUserFilter');const as=$('holdingsAccFilter');
  us.innerHTML='<option value="">全部使用者</option>'+users.map(u=>`<option value="${u}">${u}</option>`).join('');
  as.innerHTML='<option value="">全部帳戶</option>'+accs.map(a=>`<option value="${a}">${a}</option>`).join('');
  [us,as].forEach(sel=>sel.addEventListener('change',applyHoldingsFilter));
}
function applyHoldingsFilter(){
  const data=(currentData||DEMO).holdings;if(!data||data.length<2)return;
  const uv=$('holdingsUserFilter').value;
  const av=$('holdingsAccFilter').value;
  const [head,...rows]=data;
  const filtered=rows.filter(r=>(!uv||r[1]===uv)&&(!av||r[2]===av));
  renderTable('holdingsTable',[head,...filtered]);
}

/* ═══════════════════════════════════════════════════════
   8. NOTIFICATIONS
═══════════════════════════════════════════════════════ */
function maybeNotify(positions){
  if(!('Notification' in window)||Notification.permission!=='granted')return;
  const now=Date.now();
  positions.filter(p=>['alert','danger','critical'].includes(p.lv)).forEach(p=>{
    const key=`sp_risk_${p.code}`;
    const last=Number(localStorage.getItem(key)||0);
    if(now-last<RISK.notifyCooldownMs)return;
    new Notification(`StockPilot 風控通知：${p.label}`,{
      body:`${p.code} ${p.name} 維持率 ${fmtR(p.mRate)}，追繳價 ${fmtM(p.mcPrice)}，斷頭價 ${fmtM(p.fsPrice)}，建議補現金 ${fmtM(p.suppCash)}`,
      icon:'./icon.svg'
    });
    localStorage.setItem(key,String(now));
  });
}

/* ═══════════════════════════════════════════════════════
   9. SETUP PAGE
═══════════════════════════════════════════════════════ */
function updateDeployChecklist(mode){
  const hasUrl=!!(SCRIPT_URL&&!SCRIPT_URL.includes('PASTE_YOUR'));
  $('deployConfigState').textContent=hasUrl?'✅ 已設定':'❌ 未設定';
  $('deployConfigState').className=hasUrl?'down':'up';
  $('deployModeState').textContent=mode||'示範資料';
  $('deployNotifyState').textContent='Notification' in window?Notification.permission==='granted'?'✅ 已授權':'❌ 未授權':'不支援';
  if('serviceWorker' in navigator){
    navigator.serviceWorker.getRegistrations().then(r=>{ $('deploySwState').textContent=r.length?'✅ 已啟用':'❌ 未啟用'; });
  }
}
function bindSetupPage(){
  const urlInput=$('configScriptUrl');
  if(urlInput)urlInput.value=SCRIPT_URL||'';
  $('saveConfigBtn')?.addEventListener('click',()=>{
    const url=urlInput?.value?.trim();
    if(!url){$('configStatus').textContent='請輸入有效 URL';return;}
    localStorage.setItem('sp_script_url',url);
    SCRIPT_URL=url;
    $('configStatus').textContent='✅ 已儲存到本機，下次同步將使用此 URL。';
    updateDeployChecklist();
  });
  $('testConfigBtn')?.addEventListener('click',async()=>{
    const url=$('configScriptUrl')?.value?.trim()||SCRIPT_URL;
    if(!url||url.includes('PASTE_YOUR')){$('configStatus').textContent='❌ 請先填入有效的 Apps Script URL';return;}
    $('configStatus').textContent='測試中...';
    try{
      const r=await fetch(url,{cache:'no-store'});
      if(r.ok){$('configStatus').textContent='✅ 連線成功，API 可正常讀取。';$('deployApiState').textContent='✅ 成功';}
      else{$('configStatus').textContent=`❌ HTTP ${r.status}，請確認 Apps Script 部署設定。`;$('deployApiState').textContent='❌ 失敗';}
    }catch(e){$('configStatus').textContent=`❌ 連線失敗：${e.message}`;$('deployApiState').textContent='❌ 失敗';}
  });
  $('clearConfigBtn')?.addEventListener('click',()=>{
    localStorage.removeItem('sp_script_url');SCRIPT_URL='';
    if(urlInput)urlInput.value='';
    $('configStatus').textContent='已清除本機設定，目前以示範資料運作。';
    updateDeployChecklist();
  });
  $('exportConfigBtn')?.addEventListener('click',()=>{
    const url=$('configScriptUrl')?.value?.trim()||SCRIPT_URL||'YOUR_URL_HERE';
    const box=$('configExportBox');
    box.textContent=`// config.js — 把這段內容貼入你專案的 config.js 第 13 行\nwindow.SP_CONFIG.APPS_SCRIPT_URL = '${url}';`;
    box.classList.remove('hidden');
  });
}

/* ═══════════════════════════════════════════════════════
   10. MAIN RENDER
═══════════════════════════════════════════════════════ */
function renderAll(){
  const data=currentData||DEMO;
  renderKPIs();
  renderBars('allocationBars',data.allocation,'allocation');
  renderBars('profitBars',data.profits,'profit');
  drawLine('equityChart',data.equity.labels,data.equity.values,'#2f80ed','rgba(47,128,237,.18)');
  drawLine('cashChart',data.cash.labels,data.cash.values,'#16a34a','rgba(22,163,74,.18)');
  renderTable('holdingsTable',data.holdings);
  renderTable('watchlistTable',data.watchlist);
  renderTable('cashflowTable',data.cashflow);
  initHoldingsFilters();
  renderAccountsTable();
  const positions=getPledgePositions();
  const agg=aggregateRisk(positions);
  pledgePositionsCache=positions;
  renderRiskKPIs(agg);
  renderRiskSummaryCards(positions);
  renderPledgeTable(positions);
  renderStressTests(positions,agg);
  renderToleranceViz(positions);
  renderNotifyPanel(positions,agg);
  renderAlertBanner(positions,agg);
  $('calcStock').innerHTML=positions.map((p,i)=>`<option value="${i}">${p.code} ${p.name}（${p.account}）</option>`).join('');
  maybeNotify(positions);
  // Summary cards on dashboard
  if(data.summary){
    $('riskSummaryCards').innerHTML=positions.map(p=>`
      <div class="risk-card">
        <div class="risk-card-head"><strong>${p.code} ${p.name}</strong><span class="tag ${lvCls(p.lv)}">${p.label}</span></div>
        <div><small>維持率</small> <strong class="${lvCls(p.lv)}">${fmtR(p.mRate)}</strong></div>
        <div><small>追繳價</small> <strong>${fmtM(p.mcPrice)}</strong></div>
        <div><small>可承受跌幅</small> <strong>${fmtP(p.tDrop)}</strong></div>
      </div>`).join('');
  }
}

/* ═══════════════════════════════════════════════════════
   11. SYNC
═══════════════════════════════════════════════════════ */
async function syncData(){
  const btn=$('syncBtn');
  const badge=$('connectionBadge');
  btn.disabled=true;btn.textContent='同步中...';
  const url=SCRIPT_URL||localStorage.getItem('sp_script_url')||'';
  if(!url||url.includes('PASTE_YOUR')){
    currentData=null;renderAll();
    btn.disabled=false;btn.textContent='↻ 同步';
    badge.className='status-badge demo';badge.textContent='示範模式';
    updateDeployChecklist('示範資料');return;
  }
  try{
    const r=await fetch(url,{cache:'no-store'});
    if(!r.ok)throw new Error(`HTTP ${r.status}`);
    currentData=await r.json();
    localStorage.setItem('sp_cache',JSON.stringify(currentData));
    renderAll();
    badge.className='status-badge live';badge.textContent='即時資料';
    $('syncStatus').textContent=`最後同步：${new Date().toLocaleTimeString('zh-TW')}`;
    updateDeployChecklist('即時資料（Google Sheets）');
  }catch(e){
    const cached=localStorage.getItem('sp_cache');
    if(cached){currentData=JSON.parse(cached);badge.className='status-badge demo';badge.textContent='快取資料';}
    else{currentData=null;badge.className='status-badge demo';badge.textContent='示範模式';}
    renderAll();updateDeployChecklist(cached?'快取資料':'示範資料');
  }
  btn.disabled=false;btn.textContent='↻ 同步';
  setTimeout(()=>{btn.textContent='↻ 同步';},1200);
}

/* ═══════════════════════════════════════════════════════
   12. NAVIGATION + MOBILE SIDEBAR
═══════════════════════════════════════════════════════ */
function bindTabs(){
  const map={dashboard:'投資總覽儀表板',holdings:'持股彙總',pledge:'質押風控模組',watchlist:'觀察清單',cashflow:'績效現金流',accounts:'帳戶費率設定',setup:'部署指引'};
  document.querySelectorAll('.nav-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      document.querySelectorAll('.nav-btn').forEach(x=>x.classList.remove('active'));
      document.querySelectorAll('.view').forEach(x=>x.classList.remove('active'));
      btn.classList.add('active');
      $(btn.dataset.view)?.classList.add('active');
      $('viewTitle').textContent=map[btn.dataset.view]||'';
      closeSidebar();
    });
  });
}
function closeSidebar(){
  const s=$('sidebar');const o=document.querySelector('.sidebar-overlay');
  if(s)s.classList.remove('open');if(o)o.classList.remove('show');
}
function bindMobileSidebar(){
  const overlay=document.createElement('div');
  overlay.className='sidebar-overlay';
  document.body.appendChild(overlay);
  $('hamburger')?.addEventListener('click',()=>{
    $('sidebar')?.classList.toggle('open');
    overlay.classList.toggle('show');
  });
  overlay.addEventListener('click',closeSidebar);
}

/* ═══════════════════════════════════════════════════════
   13. NOTIFICATIONS + PWA INSTALL
═══════════════════════════════════════════════════════ */
function bindNotifyBtn(){
  $('notifyBtn')?.addEventListener('click',async()=>{
    if(!('Notification' in window)){alert('此瀏覽器不支援推播通知');return;}
    if(Notification.permission==='granted'){$('notifyBtn').textContent='🔔 通知已開';return;}
    const result=await Notification.requestPermission();
    $('notifyBtn').textContent=result==='granted'?'🔔 通知已開':'🔔 通知未授權';
    updateDeployChecklist();
  });
}
function bindPWAInstall(){
  window.addEventListener('beforeinstallprompt',e=>{
    e.preventDefault();deferredPrompt=e;
    $('installBtn')?.classList.remove('hidden');
  });
  $('installBtn')?.addEventListener('click',async()=>{
    if(!deferredPrompt)return;
    deferredPrompt.prompt();await deferredPrompt.userChoice;
    deferredPrompt=null;$('installBtn')?.classList.add('hidden');
  });
}

/* ═══════════════════════════════════════════════════════
   14. MISC BINDINGS
═══════════════════════════════════════════════════════ */
function bindCalcButtons(){
  $('calcBtn')?.addEventListener('click',()=>{
    const positions=pledgePositionsCache.length?pledgePositionsCache:getPledgePositions();
    const idx=Number($('calcStock')?.value)||0;
    const p=positions[idx]||positions[0];
    const targetRate=Number($('calcTargetRate')?.value||166)/100;
    const method=$('calcMethod')?.value;
    const amount=method==='cash'?Math.max(0,p.loan*targetRate-p.coll):Math.max(0,p.loan-p.coll/targetRate);
    $('calcResult').innerHTML=`<strong>${p.code} ${p.name}（${p.account}）</strong><br>目前維持率：${fmtR(p.mRate)}<br>目標維持率：${fmtR(targetRate)}<br>${method==='cash'?'建議補現金':'建議還款'}：<strong>${fmtM(amount)}</strong>`;
  });
  $('feeCalcBtn')?.addEventListener('click',runFeeCalc);
  $('syncBtn')?.addEventListener('click',syncData);
}

/* ═══════════════════════════════════════════════════════
   15. BOOT
═══════════════════════════════════════════════════════ */
bindTabs();
bindMobileSidebar();
bindNotifyBtn();
bindPWAInstall();
bindCalcButtons();
bindSetupPage();
renderAll();
syncData();
setInterval(syncData, (CFG.AUTO_SYNC_INTERVAL_MS||300000));
if('serviceWorker' in navigator){
  window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js'));
}

/* ========================================
   新增交易 - JavaScript 邏輯
======================================== */

function openTransactionModal() {
  const modal = document.getElementById('transaction-modal');
  modal.style.display = 'flex';
  
  // 設定今天日期為預設值
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('tx-date').value = today;
  
  // 清空表單
  clearTransactionForm();
}

function closeTransactionModal() {
  document.getElementById('transaction-modal').style.display = 'none';
  document.getElementById('tx-status').style.display = 'none';
  clearTransactionForm();
}

function clearTransactionForm() {
  const fields = ['tx-account', 'tx-code', 'tx-name', 'tx-qty', 'tx-price', 'tx-note'];
  fields.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  
  const display = document.getElementById('tx-calc-display');
  if (display) display.style.display = 'none';
}

function updateTransactionCalc() {
  const qty = parseFloat(document.getElementById('tx-qty')?.value) || 0;
  const price = parseFloat(document.getElementById('tx-price')?.value) || 0;
  const type = document.getElementById('tx-type')?.value;
  const display = document.getElementById('tx-calc-display');

  if (!qty || !price || !['買入', '賣出'].includes(type)) {
    if (display) display.style.display = 'none';
    return;
  }

  const amount = qty * price;

  // 台股費率計算（可根據你的帳戶設定調整）
  const feeRate = 0.001425;      // 手續費率 0.1425%
  const feeDiscount = 0.6;       // 六折優惠
  const minFee = 20;             // 最低手續費
  const taxRate = type === '賣出' ? 0.003 : 0; // 賣出才有證交稅

  const fee = Math.max(Math.round(amount * feeRate * feeDiscount), minFee);
  const tax = Math.round(amount * taxRate);
  const netAmount = type === '買入' 
    ? -(amount + fee)          // 買入：負值（支出）
    : amount - fee - tax;      // 賣出：正值（收入）

  // 更新顯示
  document.getElementById('tx-calc-amount').textContent = `NT$ ${amount.toLocaleString()}`;
  document.getElementById('tx-calc-fee').textContent = `NT$ ${fee.toLocaleString()}`;
  document.getElementById('tx-calc-tax').textContent = `NT$ ${tax.toLocaleString()}`;
  document.getElementById('tx-calc-net').textContent = `NT$ ${Math.abs(netAmount).toLocaleString()}`;

  display.style.display = 'block';
}

async function submitTransaction() {
  const btn = document.getElementById('tx-submit-btn');
  const status = document.getElementById('tx-status');

  // 顯示載入狀態
  btn.textContent = '⏳ 新增中...';
  btn.disabled = true;

  try {
    // 收集表單資料
    const qty = parseFloat(document.getElementById('tx-qty')?.value) || 0;
    const price = parseFloat(document.getElementById('tx-price')?.value) || 0;
    const type = document.getElementById('tx-type')?.value;
    const amount = qty * price;

    // 計算費用
    const fee = ['買入', '賣出'].includes(type) 
      ? Math.max(Math.round(amount * 0.001425 * 0.6), 20) : 0;
    const tax = type === '賣出' ? Math.round(amount * 0.003) : 0;
    const netAmount = type === '買入' ? -(amount + fee) : amount - fee - tax;

    const payload = {
      date: document.getElementById('tx-date')?.value,
      account: document.getElementById('tx-account')?.value,
      type: type,
      stockCode: document.getElementById('tx-code')?.value,
      stockName: document.getElementById('tx-name')?.value,
      quantity: qty,
      price: price,
      amount: amount,
      fee: fee,
      tax: tax,
      netAmount: netAmount,
      note: document.getElementById('tx-note')?.value
    };

    // 基本驗證
    if (!payload.date || !payload.account || !payload.type) {
      throw new Error('請填寫必要欄位：日期、帳戶和交易類型');
    }

    if (['買入', '賣出'].includes(payload.type) && (!payload.stockCode || !qty || !price)) {
      throw new Error('股票交易請填寫：股票代碼、數量和價格');
    }

    // 呼叫 Apps Script API
    const response = await fetch(SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ 
        action: 'addTransaction', 
        payload: payload 
      })
    });

    const result = await response.json();

    if (result.success) {
      // 成功
      status.style.display = 'block';
      status.style.background = '#064e3b';
      status.style.color = '#34d399';
      status.style.border = '1px solid #059669';
      status.textContent = '✅ ' + result.message;

      // 2 秒後關閉並重新載入資料
      setTimeout(() => {
        closeTransactionModal();
        if (typeof loadData === 'function') {
          loadData(); // 重新載入最新資料
        }
      }, 2000);

    } else {
      throw new Error(result.message || '新增失敗，請稍後再試');
    }

  } catch (err) {
    // 失敗處理
    status.style.display = 'block';
    status.style.background = '#450a0a';
    status.style.color = '#fca5a5';
    status.style.border = '1px solid #dc2626';
    status.textContent = '❌ ' + err.message;
  }

  // 恢復按鈕狀態
  btn.textContent = '✅ 確認新增';
  btn.disabled = false;
}

// 點擊背景關閉 Modal
document.getElementById('transaction-modal')?.addEventListener('click', function(e) {
  if (e.target === this) closeTransactionModal();
});
