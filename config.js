/**
 * StockPilot PWA — config.js
 * ────────────────────────────────────────────────────────────
 * 正式部署時：把下方 APPS_SCRIPT_URL 換成你的 Apps Script Web App URL，
 * 其餘設定保持預設或依需求調整即可。
 *
 * 本機測試時：可直接在 ⚙️ 部署 頁面填入 URL → 點「儲存本機設定」，
 * 不需修改此檔案。
 */

window.SP_CONFIG = {

  /* ── 必填：Google Apps Script Web App URL ─────────────────── */
  APPS_SCRIPT_URL:'https://script.google.com/macros/s/AKfycbyKubS4eyLdOsrTam0L2W_lLWOtOvq4M-7hNnWeWpmNny62Fnr6_xG3grDbRd9Amw1d/exec',

  /* ── 自動同步間隔（毫秒，預設 5 分鐘） ────────────────────── */
  AUTO_SYNC_INTERVAL_MS: 5 * 60 * 1000,

  /* ── 風控門檻（後端會依帳戶設定覆蓋，這裡是前端預設值） ────── */
  RISK: {
    safe:              1.66,   // ≥ 安全
    caution:           1.40,   // ≥ 注意
    marginCall:        1.30,   // ≥ 警戒 / 追繳
    forcedSell:        1.20,   // ＜ 斷頭
    notifyCooldownMs:  30 * 60 * 1000  // 同檔通知冷卻 30 分
  },

  /* ── 通知相關 ─────────────────────────────────────────────── */
  NOTIFICATION: {
    enabled: true,
    levels: ['alert', 'danger', 'critical']  // 哪些燈號觸發通知
  },

  /* ── 帳戶預設費率（當 Google Sheets 未回傳時的前端 fallback） */
  DEFAULT_ACCOUNT_FEES: {
    commissionRate:    0.001425,  // 0.1425%
    commissionDiscount: 0.6,      // 6 折
    minCommission:     20,        // 最低 20 元
    sellTaxRate:       0.003,     // 0.3%（台股）
    dividendTaxRate:   0.00,      // 股利稅（依帳戶不同）
    platformFee:       0          // 平台固定費（美股券商）
  },

  /* ── Trailing Stop 預設參數 ─────────────────────────────────── */
  TRAILING: {
    high:   0.12,  // 高波動
    mid:    0.08,  // 中波動
    low:    0.05   // 低波動
  }
};
