'use strict';
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const { dataPath } = require('./storage');
const monitor = require('./monitor');

const PORT = parseInt(process.env.PORT || '3000', 10);

const F = {
  arbs:   dataPath('arbs.json'),
  trades: dataPath('trades.json'),
  state:  dataPath('state.json'),
};

function loadJSON(f) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

// ── API handlers ──────────────────────────────────────────────────────────────
function apiState(_req, res) {
  const stats = monitor.getStats();
  const state = loadJSON(F.state) || {};
  json(res, { ...state, ...stats });
}

function apiArbs(_req, res) {
  const arbs = (loadJSON(F.arbs) || []).filter(a => a.status === 'OPEN').slice(0, 50);
  json(res, arbs);
}

function apiTrades(_req, res) {
  const trades = (loadJSON(F.trades) || []).slice(0, 100);
  json(res, trades);
}

function apiBankrollHistory(_req, res) {
  const state = loadJSON(F.state) || {};
  json(res, state.bankrollHistory || []);
}

function json(res, data) {
  const body = JSON.stringify(data);
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

// ── Dashboard HTML ────────────────────────────────────────────────────────────
function dashboardHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>1M1B Quant — Sports Arb</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f8f9fa;color:#1a202c;font-size:14px}
header{background:#1a202c;color:#fff;padding:14px 20px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.logo{font-size:18px;font-weight:800;letter-spacing:-.5px}
.logo span{color:#48bb78}
.badge{background:#48bb78;color:#fff;font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px;letter-spacing:.06em;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.7}}
.scan-ts{color:#a0aec0;font-size:12px;margin-left:auto}
.container{max-width:1200px;margin:0 auto;padding:16px}
.stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px;margin-bottom:20px}
.stat{background:#fff;border-radius:10px;padding:14px 16px;box-shadow:0 1px 4px rgba(0,0,0,.07)}
.stat-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#718096;margin-bottom:4px}
.stat-value{font-size:22px;font-weight:700;color:#1a202c}
.stat-value.green{color:#276749}
.stat-value.red{color:#c53030}
.card{background:#fff;border-radius:10px;box-shadow:0 1px 4px rgba(0,0,0,.07);margin-bottom:20px;overflow:hidden}
.card-title{padding:14px 18px;font-weight:700;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#4a5568;border-bottom:1px solid #e2e8f0}
table{width:100%;border-collapse:collapse;font-size:13px}
th{padding:10px 14px;text-align:left;font-weight:600;color:#4a5568;background:#f7fafc;white-space:nowrap}
td{padding:9px 14px;border-bottom:1px solid #f0f4f8;vertical-align:middle}
tr:last-child td{border-bottom:none}
.profit-high{background:#f0fff4}
.profit-mid{background:#fffff0}
.pill{display:inline-block;font-size:11px;font-weight:700;padding:2px 8px;border-radius:10px}
.pill-green{background:#c6f6d5;color:#276749}
.pill-yellow{background:#fefcbf;color:#744210}
.pill-gray{background:#e2e8f0;color:#4a5568}
.pill-red{background:#fed7d7;color:#c53030}
.chart-wrap{padding:16px;height:220px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:600px){.grid2{grid-template-columns:1fr}}
.no-arbs{text-align:center;padding:32px;color:#a0aec0;font-size:13px}
</style>
</head>
<body>

<header>
  <div class="logo">1M1B <span>QUANT</span> — Sports Arb</div>
  <div class="badge" id="badge">SCANNING</div>
  <div class="scan-ts" id="scan-ts">Loading…</div>
</header>

<div class="container">

  <div class="stats" id="stats-row">
    <div class="stat"><div class="stat-label">Virtual Bankroll</div><div class="stat-value" id="s-bankroll">—</div></div>
    <div class="stat"><div class="stat-label">Today P&L</div><div class="stat-value" id="s-today-pnl">—</div></div>
    <div class="stat"><div class="stat-label">Total Profit</div><div class="stat-value" id="s-total-pnl">—</div></div>
    <div class="stat"><div class="stat-label">Arbs Today</div><div class="stat-value" id="s-arbs-today">—</div></div>
    <div class="stat"><div class="stat-label">Win Rate</div><div class="stat-value" id="s-win-rate">—</div></div>
    <div class="stat"><div class="stat-label">Best Arb</div><div class="stat-value" id="s-best-arb">—</div></div>
  </div>

  <div class="card">
    <div class="card-title">Live Arb Opportunities</div>
    <div id="arbs-wrap">
      <div class="no-arbs">No open arbs right now — scanning…</div>
    </div>
  </div>

  <div class="grid2">
    <div class="card">
      <div class="card-title">Bankroll History</div>
      <div class="chart-wrap"><canvas id="bankroll-chart"></canvas></div>
    </div>
    <div class="card">
      <div class="card-title">Bookmaker Pairs</div>
      <div id="pairs-wrap"><div class="no-arbs">No data yet</div></div>
    </div>
  </div>

  <div class="card">
    <div class="card-title">Trade History</div>
    <div id="trades-wrap">
      <div class="no-arbs">No trades yet</div>
    </div>
  </div>

</div>

<script>
var bankrollChart = null;

function fmt(n) {
  if (n == null) return '—';
  return '£' + Number(n).toFixed(2);
}
function fmtPct(n) {
  if (n == null) return '—';
  return (n >= 0 ? '+' : '') + Number(n).toFixed(2) + '%';
}
function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString();
}
function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}
function sportPill(sport) {
  var map = { Football:'#3182ce', Tennis:'#d69e2e', Basketball:'#dd6b20', Cricket:'#38a169' };
  var c = map[sport] || '#718096';
  return '<span style="background:' + c + '22;color:' + c + ';font-size:11px;font-weight:700;padding:2px 8px;border-radius:10px">' + (sport || '?') + '</span>';
}
function profitClass(pct) {
  if (pct >= 2) return 'profit-high';
  if (pct >= 1) return 'profit-mid';
  return '';
}
function profitPill(pct) {
  if (pct >= 2) return '<span class="pill pill-green">+' + pct.toFixed(2) + '%</span>';
  if (pct >= 1) return '<span class="pill pill-yellow">+' + pct.toFixed(2) + '%</span>';
  return '<span class="pill pill-gray">+' + pct.toFixed(2) + '%</span>';
}
function statusPill(s) {
  if (s === 'WON')     return '<span class="pill pill-green">WON</span>';
  if (s === 'LOST')    return '<span class="pill pill-red">LOST</span>';
  if (s === 'EXPIRED') return '<span class="pill pill-gray">EXPIRED</span>';
  return '<span class="pill pill-gray">' + s + '</span>';
}

function renderArbs(arbs) {
  var el = document.getElementById('arbs-wrap');
  if (!arbs || arbs.length === 0) {
    el.innerHTML = '<div class="no-arbs">No open arbs right now — scanning every few minutes…</div>';
    return;
  }
  var rows = arbs.map(function(a) {
    var legs = (a.legs || []).map(function(l) {
      return l.outcome + ': <strong>' + l.bookmaker + '</strong> @ ' + (l.rawOdds ? l.rawOdds.toFixed(2) : '?') + ' &rarr; £' + (l.stake ? l.stake.toFixed(2) : '?');
    }).join('<br>');
    var expiry = a.commenceTime ? new Date(a.commenceTime).toLocaleString() : '—';
    return '<tr class="' + profitClass(a.netProfitPct) + '">' +
      '<td>' + (a.event || '—') + '</td>' +
      '<td>' + sportPill(a.sport) + '</td>' +
      '<td>' + profitPill(a.netProfitPct) + '</td>' +
      '<td style="font-size:12px;line-height:1.6">' + legs + '</td>' +
      '<td>' + fmt(a.totalStake) + '</td>' +
      '<td style="font-size:12px">' + expiry + '</td>' +
    '</tr>';
  }).join('');
  el.innerHTML = '<table>' +
    '<thead><tr><th>Event</th><th>Sport</th><th>Profit</th><th>Stakes</th><th>Total Stake</th><th>Kickoff</th></tr></thead>' +
    '<tbody>' + rows + '</tbody>' +
  '</table>';
}

function renderTrades(trades) {
  var el = document.getElementById('trades-wrap');
  if (!trades || trades.length === 0) {
    el.innerHTML = '<div class="no-arbs">No trades placed yet</div>';
    return;
  }
  var rows = trades.map(function(t) {
    var pnl = t.actualPnl != null ? t.actualPnl : t.expectedProfit;
    var pnlStr = pnl != null ? (pnl >= 0 ? '+' : '') + '£' + Number(pnl).toFixed(2) : '—';
    var pnlColor = pnl >= 0 ? '#276749' : '#c53030';
    return '<tr>' +
      '<td>' + fmtTime(t.placedAt) + '</td>' +
      '<td>' + (t.event || '—') + '</td>' +
      '<td>' + sportPill(t.sport) + '</td>' +
      '<td>' + profitPill(t.netProfitPct || 0) + '</td>' +
      '<td>' + fmt(t.totalStake) + '</td>' +
      '<td>' + statusPill(t.status) + '</td>' +
      '<td style="font-weight:700;color:' + pnlColor + '">' + pnlStr + '</td>' +
    '</tr>';
  }).join('');
  el.innerHTML = '<table>' +
    '<thead><tr><th>Time</th><th>Event</th><th>Sport</th><th>Profit %</th><th>Stake</th><th>Result</th><th>P&L</th></tr></thead>' +
    '<tbody>' + rows + '</tbody>' +
  '</table>';
}

function renderPairs(pairs) {
  var el = document.getElementById('pairs-wrap');
  if (!pairs || pairs.length === 0) {
    el.innerHTML = '<div class="no-arbs">No bookmaker pair data yet</div>';
    return;
  }
  var rows = pairs.map(function(p) {
    return '<tr><td>' + p.pair + '</td><td>' + p.count + '</td><td>' + fmtPct(p.avgProfitPct) + '</td></tr>';
  }).join('');
  el.innerHTML = '<table><thead><tr><th>Pair</th><th>Arbs</th><th>Avg Profit</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

function renderBankroll(history) {
  var ctx = document.getElementById('bankroll-chart').getContext('2d');
  var labels = history.map(function(h) { return fmtTime(h.ts); });
  var values = history.map(function(h) { return h.bankroll; });
  if (bankrollChart) bankrollChart.destroy();
  bankrollChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'Bankroll (£)',
        data: values,
        borderColor: '#48bb78',
        backgroundColor: 'rgba(72,187,120,.08)',
        borderWidth: 2,
        pointRadius: 2,
        tension: 0.3,
        fill: true,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { maxTicksLimit: 6, font: { size: 11 } } },
        y: { ticks: { font: { size: 11 }, callback: function(v) { return '£' + v; } } }
      }
    }
  });
}

function updateStats(s) {
  document.getElementById('scan-ts').textContent = s.lastScanAt ? ('Last scan: ' + fmtTime(s.lastScanAt) + ' | quota: ' + (s.requestsRemaining ?? '?') + ' remaining') : 'Waiting for first scan…';
  var bankroll = s.bankroll != null ? s.bankroll : 1000;
  var el = document.getElementById('s-bankroll');
  el.textContent = fmt(bankroll);
  el.className = 'stat-value';

  var todayPnl = document.getElementById('s-today-pnl');
  todayPnl.textContent = (s.todayPnl >= 0 ? '+' : '') + fmt(s.todayPnl);
  todayPnl.className = 'stat-value ' + (s.todayPnl >= 0 ? 'green' : 'red');

  var totalPnl = document.getElementById('s-total-pnl');
  totalPnl.textContent = (s.totalPnl >= 0 ? '+' : '') + fmt(s.totalPnl);
  totalPnl.className = 'stat-value ' + (s.totalPnl >= 0 ? 'green' : 'red');

  document.getElementById('s-arbs-today').textContent = s.arbsFoundToday ?? 0;
  document.getElementById('s-win-rate').textContent = (s.winRate ?? 100) + '%';
  document.getElementById('s-best-arb').textContent = s.bestArb ? '+' + s.bestArb.netProfitPct.toFixed(2) + '%' : '—';
}

async function refresh() {
  try {
    var [stateRes, arbsRes, tradesRes, histRes] = await Promise.all([
      fetch('/api/state'), fetch('/api/arbs'), fetch('/api/trades'), fetch('/api/bankroll-history')
    ]);
    var state   = await stateRes.json();
    var arbs    = await arbsRes.json();
    var trades  = await tradesRes.json();
    var history = await histRes.json();

    updateStats(state);
    renderArbs(arbs);
    renderTrades(trades);
    renderPairs(state.bookmakerPairs);
    if (history.length > 1) renderBankroll(history);
  } catch(e) {
    console.warn('Refresh error:', e);
  }
}

refresh();
setInterval(refresh, 10000);
</script>

</body>
</html>`;
}

// ── Request router ────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  if (url === '/')                   { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(dashboardHtml()); }
  if (url === '/api/state')          return apiState(req, res);
  if (url === '/api/arbs')           return apiArbs(req, res);
  if (url === '/api/trades')         return apiTrades(req, res);
  if (url === '/api/bankroll-history') return apiBankrollHistory(req, res);

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`[SERVER] Dashboard running on http://localhost:${PORT}`);
});
