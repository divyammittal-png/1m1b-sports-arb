require('dotenv').config();
'use strict';
const express  = require('express');
const { load } = require('./storage');
const monitor  = require('./monitor');

const PORT = parseInt(process.env.PORT || '3000', 10);
const app  = express();

// ── API endpoints ─────────────────────────────────────────────────────────────
app.get('/api/stats',         (_q, r) => r.json(monitor.getStats()));
app.get('/api/markets',       (_q, r) => r.json(load('markets.json')       || []));
app.get('/api/opportunities', (_q, r) => r.json((load('opportunities.json') || []).filter(o => o.status === 'OPEN').slice(0, 20)));
app.get('/api/positions',     (_q, r) => r.json(load('positions.json')      || []));
app.get('/api/trades',        (_q, r) => r.json((load('trades.json')        || []).slice(0, 100)));
app.get('/api/pnl-breakdown', (_q, r) => r.json(computePnlBreakdown()));

function computePnlBreakdown() {
  const trades = load('trades.json') || [];
  const now    = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const monthStr = now.toISOString().slice(0, 7);
  const diffToMon = now.getDay() === 0 ? -6 : 1 - now.getDay();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() + diffToMon);
  weekStart.setHours(0, 0, 0, 0);

  function summarise(subset) {
    const wins = subset.filter(t => t.result === 'WIN').length;
    const pnl  = +subset.reduce((s, t) => s + (t.pnl || 0), 0).toFixed(2);
    return { trades: subset.length, wins, winRate: subset.length ? +(wins / subset.length * 100).toFixed(1) : null, pnl };
  }

  const bySport = {}, byType = {};
  for (const t of trades) {
    const s = t.sport || 'Unknown';
    const y = (t.trigger || 'Unknown').split(':')[0].trim();
    (bySport[s] = bySport[s] || []).push(t);
    (byType[y]  = byType[y]  || []).push(t);
  }

  return {
    periods: [
      { period: 'Today',        ...summarise(trades.filter(t => (t.closedAt || '').startsWith(todayStr))) },
      { period: 'This Week',    ...summarise(trades.filter(t => t.closedAt && new Date(t.closedAt) >= weekStart)) },
      { period: 'This Month',   ...summarise(trades.filter(t => (t.closedAt || '').startsWith(monthStr))) },
      { period: 'Life-to-Date', ...summarise(trades) },
    ],
    bySport: Object.entries(bySport).map(([sport, ts]) => ({ sport, ...summarise(ts) })),
    byType:  Object.entries(byType).map(([type,  ts]) => ({ type,  ...summarise(ts) })),
  };
}

// ── Dashboard HTML ────────────────────────────────────────────────────────────
app.get('/', (_q, res) => res.send(html()));

function html() {
return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>1M1B Quant — Betfair In-Play</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f2f5;color:#1a202c;font-size:14px}
header{background:#1a202c;padding:12px 20px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.logo{font-size:17px;font-weight:800;color:#fff;letter-spacing:-.4px}
.logo span{color:#48bb78}
.badge{font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px;letter-spacing:.06em}
.badge-paper{background:#ed8936;color:#fff}
.badge-live{background:#48bb78;color:#fff;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.65}}
.clock{color:#a0aec0;font-size:12px;margin-left:auto}
.container{max-width:1280px;margin:0 auto;padding:14px}
.stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;margin-bottom:16px}
.stat{background:#fff;border-radius:10px;padding:12px 14px;box-shadow:0 1px 3px rgba(0,0,0,.07)}
.stat-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#718096;margin-bottom:3px}
.stat-value{font-size:20px;font-weight:700}
.green{color:#276749} .red{color:#c53030} .blue{color:#2b6cb0}
.card{background:#fff;border-radius:10px;box-shadow:0 1px 3px rgba(0,0,0,.07);margin-bottom:16px;overflow:hidden}
.card-title{padding:12px 16px;font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#4a5568;border-bottom:1px solid #e2e8f0;display:flex;align-items:center;gap:8px}
.count-badge{background:#e2e8f0;color:#4a5568;font-size:11px;padding:1px 7px;border-radius:10px;font-weight:700}
table{width:100%;border-collapse:collapse;font-size:13px}
th{padding:8px 12px;text-align:left;font-weight:600;color:#4a5568;background:#f7fafc;white-space:nowrap}
td{padding:8px 12px;border-bottom:1px solid #f0f4f8;vertical-align:middle}
tr:last-child td{border-bottom:none}
.pill{display:inline-block;font-size:11px;font-weight:700;padding:2px 8px;border-radius:10px;white-space:nowrap}
.p-green{background:#c6f6d5;color:#276749}
.p-red{background:#fed7d7;color:#c53030}
.p-orange{background:#feebc8;color:#c05621}
.p-blue{background:#bee3f8;color:#2b6cb0}
.p-gray{background:#e2e8f0;color:#4a5568}
.p-yellow{background:#fefcbf;color:#744210}
.opp-flash td{animation:flash 1s ease}
@keyframes flash{0%{background:#f0fff4}100%{background:transparent}}
.grid2{display:grid;grid-template-columns:2fr 1fr;gap:14px}
.empty{text-align:center;padding:24px;color:#a0aec0;font-size:13px}
.live-dot{width:8px;height:8px;border-radius:50%;background:#48bb78;display:inline-block;animation:pulse 2s infinite}
.odds-cell{font-weight:700;font-size:13px}
.back-odds{color:#276749}
.lay-odds{color:#c53030}
@media(max-width:700px){.grid2{grid-template-columns:1fr}}
</style>
</head>
<body>

<header>
  <div class="logo">1M1B <span>QUANT</span> — Betfair In-Play</div>
  <div class="badge badge-paper">PAPER MODE</div>
  <div class="clock" id="clock">--:--:--</div>
</header>

<div class="container">

  <div class="stats" id="stats-row">
    <div class="stat"><div class="stat-label">Virtual Bankroll</div><div class="stat-value" id="s-bankroll">£1,000.00</div></div>
    <div class="stat"><div class="stat-label">Today P&L</div><div class="stat-value" id="s-today-pnl">£0.00</div></div>
    <div class="stat"><div class="stat-label">Total P&L</div><div class="stat-value" id="s-total-pnl">£0.00</div></div>
    <div class="stat"><div class="stat-label">Trades Today</div><div class="stat-value" id="s-trades-today">0</div></div>
    <div class="stat"><div class="stat-label">Win Rate</div><div class="stat-value" id="s-win-rate">—</div></div>
    <div class="stat"><div class="stat-label">Avg Hold</div><div class="stat-value" id="s-avg-hold">—</div></div>
  </div>

  <div class="card">
    <div class="card-title">P&amp;L Breakdown</div>
    <div id="breakdown-body"><div class="empty">Loading…</div></div>
  </div>

  <div class="grid2">
    <div class="card">
      <div class="card-title">P&amp;L by Sport</div>
      <div id="sport-body"><div class="empty">Loading…</div></div>
    </div>
    <div class="card">
      <div class="card-title">P&amp;L by Event Type</div>
      <div id="type-body"><div class="empty">Loading…</div></div>
    </div>
  </div>

  <div class="grid2">
    <div>

      <div class="card" id="opps-card">
        <div class="card-title"><span class="live-dot"></span> Live Opportunities <span class="count-badge" id="opps-count">0</span></div>
        <div id="opps-body"><div class="empty">Scanning for in-play opportunities…</div></div>
      </div>

      <div class="card">
        <div class="card-title"><span class="live-dot"></span> Active Positions <span class="count-badge" id="pos-count">0</span></div>
        <div id="pos-body"><div class="empty">No open positions</div></div>
      </div>

      <div class="card">
        <div class="card-title">Trade History <span class="count-badge" id="trades-count">0</span></div>
        <div id="trades-body"><div class="empty">No trades yet</div></div>
      </div>

    </div>
    <div>

      <div class="card">
        <div class="card-title">Live Markets <span class="count-badge" id="markets-count">0</span></div>
        <div id="markets-body"><div class="empty">Waiting for Betfair data…</div></div>
      </div>

    </div>
  </div>


</div>

<script>
// ── Formatters ────────────────────────────────────────────────────────────────
function fmtPound(n) { return n == null ? '—' : (n >= 0 ? '£' : '-£') + Math.abs(n).toFixed(2); }
function fmtPct(n)   { return n == null ? '—' : (n >= 0 ? '+' : '') + Number(n).toFixed(1) + '%'; }
function fmtTime(ts) { return ts ? new Date(ts).toLocaleTimeString() : '—'; }
function fmtSec(s)   { return s == null ? '—' : Number(s).toFixed(0) + 's'; }

function pill(txt, cls) { return '<span class="pill ' + cls + '">' + txt + '</span>'; }
function resultPill(r)  { return r === 'WIN' ? pill('WIN', 'p-green') : pill('LOSS', 'p-red'); }
function sportPill(s)   {
  var map = { Football: 'p-blue', Tennis: 'p-orange', Basketball: 'p-yellow', Cricket: 'p-gray' };
  return pill(s || '?', map[s] || 'p-gray');
}

function pnlColor(n) { return n >= 0 ? '#276749' : '#c53030'; }

// ── Stats ─────────────────────────────────────────────────────────────────────
function renderStats(s) {
  setText('s-bankroll',    '£' + Number(s.bankroll || 1000).toFixed(2));
  setColored('s-today-pnl', s.todayPnl);
  setColored('s-total-pnl', s.totalPnl);
  setText('s-trades-today', s.tradesToday || 0);
  setText('s-win-rate',     s.winRate != null ? s.winRate + '%' : '—');
  setText('s-avg-hold',     s.avgHoldSec != null ? s.avgHoldSec + 's' : '—');
}

function setText(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; }
function setColored(id, v) {
  var el = document.getElementById(id);
  if (!el) return;
  el.textContent = fmtPound(v);
  el.className = 'stat-value ' + (v >= 0 ? 'green' : 'red');
}

// ── Opportunities ─────────────────────────────────────────────────────────────
function renderOpps(opps) {
  setText('opps-count', opps.length);
  var el = document.getElementById('opps-body');
  if (!opps.length) { el.innerHTML = '<div class="empty">No opportunities detected yet</div>'; return; }
  var rows = opps.map(function(o) {
    var edgeCls = o.edgePct >= 5 ? 'p-green' : o.edgePct >= 3 ? 'p-yellow' : 'p-gray';
    return '<tr class="opp-flash">' +
      '<td>' + (o.eventName || '—') + '</td>' +
      '<td>' + sportPill(o.sport) + '</td>' +
      '<td style="font-size:12px;max-width:160px">' + (o.trigger || '—') + '</td>' +
      '<td>' + pill('+' + o.edgePct + '%', edgeCls) + '</td>' +
      '<td class="odds-cell back-odds">' + o.currentOdds + '</td>' +
      '<td class="odds-cell">' + o.targetLayOdds + '</td>' +
      '<td style="color:#718096;font-size:12px">' + fmtTime(o.detectedAt) + '</td>' +
    '</tr>';
  }).join('');
  el.innerHTML = '<table><thead><tr><th>Event</th><th>Sport</th><th>Trigger</th><th>Edge</th><th>Back @</th><th>Target</th><th>Found</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

// ── Active positions ──────────────────────────────────────────────────────────
function renderPositions(positions) {
  setText('pos-count', positions.length);
  var el = document.getElementById('pos-body');
  if (!positions.length) { el.innerHTML = '<div class="empty">No open positions</div>'; return; }
  var rows = positions.map(function(p) {
    var pnlStr = (p.currentPnl >= 0 ? '+' : '') + '£' + Number(p.currentPnl || 0).toFixed(2);
    var pnlCol = pnlColor(p.currentPnl || 0);
    var secsOpen = Math.round((Date.now() - new Date(p.openedAt).getTime()) / 1000);
    return '<tr>' +
      '<td>' + (p.eventName || '—') + '</td>' +
      '<td>' + (p.runnerName || '—') + '</td>' +
      '<td class="odds-cell back-odds">' + p.backOdds + '</td>' +
      '<td class="odds-cell">' + (p.currentOdds || p.backOdds) + '</td>' +
      '<td class="odds-cell" style="color:#718096">' + p.targetLayOdds + '</td>' +
      '<td style="font-weight:700;color:' + pnlCol + '">' + pnlStr + '</td>' +
      '<td>' + secsOpen + 's</td>' +
      '<td>£' + p.stake + '</td>' +
    '</tr>';
  }).join('');
  el.innerHTML = '<table><thead><tr><th>Event</th><th>Selection</th><th>Back</th><th>Now</th><th>Target</th><th>P&L</th><th>Open</th><th>Stake</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

// ── Trades ────────────────────────────────────────────────────────────────────
function renderTrades(trades) {
  setText('trades-count', trades.length);
  var el = document.getElementById('trades-body');
  if (!trades.length) { el.innerHTML = '<div class="empty">No closed trades yet</div>'; return; }
  var rows = trades.slice(0, 50).map(function(t) {
    var pnlCol = pnlColor(t.pnl || 0);
    return '<tr>' +
      '<td style="color:#718096;font-size:12px">' + fmtTime(t.closedAt) + '</td>' +
      '<td>' + (t.eventName || t.event || '—') + '</td>' +
      '<td>' + sportPill(t.sport) + '</td>' +
      '<td style="font-size:12px;max-width:120px;overflow:hidden">' + (t.trigger || '—') + '</td>' +
      '<td class="odds-cell back-odds">' + t.backOdds + '</td>' +
      '<td class="odds-cell">' + (t.layOdds || '—') + '</td>' +
      '<td>' + fmtSec(t.holdTimeSec) + '</td>' +
      '<td style="font-weight:700;color:' + pnlCol + '">' + (t.pnl >= 0 ? '+' : '') + '£' + Number(t.pnl || 0).toFixed(2) + '</td>' +
      '<td>' + resultPill(t.result) + '</td>' +
    '</tr>';
  }).join('');
  el.innerHTML = '<table><thead><tr><th>Time</th><th>Event</th><th>Sport</th><th>Trigger</th><th>Back</th><th>Lay</th><th>Hold</th><th>P&L</th><th>Result</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

// ── Markets ───────────────────────────────────────────────────────────────────
function renderMarkets(markets) {
  setText('markets-count', markets.length);
  var el = document.getElementById('markets-body');
  if (!markets.length) { el.innerHTML = '<div class="empty">No live markets yet</div>'; return; }
  var rows = markets.slice(0, 20).map(function(m) {
    var r1 = m.runners && m.runners[0];
    var r2 = m.runners && m.runners[1];
    return '<tr>' +
      '<td style="font-size:12px;max-width:160px">' + (m.eventName || m.marketId) + '</td>' +
      '<td>' + sportPill(m.sport) + '</td>' +
      '<td class="odds-cell">' +
        (r1 ? '<span class="back-odds">' + (r1.backOdds || '—') + '</span>' : '—') +
        (r1 && r1.runnerName ? '<div style="font-size:10px;color:#718096">' + r1.runnerName + '</div>' : '') +
      '</td>' +
      '<td class="odds-cell">' +
        (r2 ? '<span class="back-odds">' + (r2.backOdds || '—') + '</span>' : '—') +
        (r2 && r2.runnerName ? '<div style="font-size:10px;color:#718096">' + r2.runnerName + '</div>' : '') +
      '</td>' +
    '</tr>';
  }).join('');
  el.innerHTML = '<table><thead><tr><th>Event</th><th>Sport</th><th>Sel 1</th><th>Sel 2</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

// ── P&L Breakdown tables ──────────────────────────────────────────────────────
function fmtWinRate(r) { return r == null ? '—' : r + '%'; }
function fmtPnlCell(n) {
  if (n == null) return '—';
  var cls = n >= 0 ? 'green' : 'red';
  return '<span class="' + cls + '" style="font-weight:700">' + (n >= 0 ? '+' : '') + '£' + Math.abs(n).toFixed(2) + '</span>';
}

function renderBreakdown(data) {
  var el = document.getElementById('breakdown-body');
  if (!data || !data.periods) return;
  var rows = data.periods.map(function(p) {
    return '<tr>' +
      '<td style="font-weight:600">' + p.period + '</td>' +
      '<td>' + p.trades + '</td>' +
      '<td>' + p.wins + '</td>' +
      '<td>' + fmtWinRate(p.winRate) + '</td>' +
      '<td>' + fmtPnlCell(p.pnl) + '</td>' +
    '</tr>';
  }).join('');
  el.innerHTML = '<table><thead><tr><th>Period</th><th>Trades</th><th>Wins</th><th>Win Rate</th><th>P&amp;L</th></tr></thead><tbody>' + rows + '</tbody></table>';

  var sportEl = document.getElementById('sport-body');
  if (data.bySport && data.bySport.length) {
    var sRows = data.bySport.map(function(s) {
      return '<tr>' +
        '<td>' + sportPill(s.sport) + '</td>' +
        '<td>' + s.trades + '</td>' +
        '<td>' + fmtWinRate(s.winRate) + '</td>' +
        '<td>' + fmtPnlCell(s.pnl) + '</td>' +
      '</tr>';
    }).join('');
    sportEl.innerHTML = '<table><thead><tr><th>Sport</th><th>Trades</th><th>Win Rate</th><th>P&amp;L</th></tr></thead><tbody>' + sRows + '</tbody></table>';
  } else {
    sportEl.innerHTML = '<div class="empty">No data yet</div>';
  }

  var typeEl = document.getElementById('type-body');
  if (data.byType && data.byType.length) {
    var tRows = data.byType.map(function(t) {
      return '<tr>' +
        '<td style="font-weight:600">' + t.type + '</td>' +
        '<td>' + t.trades + '</td>' +
        '<td>' + fmtWinRate(t.winRate) + '</td>' +
        '<td>' + fmtPnlCell(t.pnl) + '</td>' +
      '</tr>';
    }).join('');
    typeEl.innerHTML = '<table><thead><tr><th>Event Type</th><th>Trades</th><th>Win Rate</th><th>P&amp;L</th></tr></thead><tbody>' + tRows + '</tbody></table>';
  } else {
    typeEl.innerHTML = '<div class="empty">No data yet</div>';
  }
}

// ── Poll ──────────────────────────────────────────────────────────────────────
async function refresh() {
  try {
    var [stats, markets, opps, positions, trades, breakdown] = await Promise.all([
      fetch('/api/stats').then(function(r) { return r.json(); }),
      fetch('/api/markets').then(function(r) { return r.json(); }),
      fetch('/api/opportunities').then(function(r) { return r.json(); }),
      fetch('/api/positions').then(function(r) { return r.json(); }),
      fetch('/api/trades').then(function(r) { return r.json(); }),
      fetch('/api/pnl-breakdown').then(function(r) { return r.json(); }),
    ]);

    renderStats(stats);
    renderOpps(opps);
    renderPositions(positions);
    renderTrades(trades);
    renderMarkets(markets);
    renderBreakdown(breakdown);
  } catch(e) {
    console.warn('Refresh error:', e);
  }
}

// Live clock
setInterval(function() {
  document.getElementById('clock').textContent = new Date().toLocaleTimeString();
}, 1000);

refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`;
}

app.listen(PORT, () => console.log('[SERVER] Dashboard: http://localhost:' + PORT));
