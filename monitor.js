'use strict';
const { load, save } = require('./storage');

function today()  { return new Date().toISOString().slice(0, 10); }

function std(arr) {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

function getStats() {
  const trades      = load('trades.json') || [];
  const state       = load('state.json')  || {};
  const t           = today();

  const tradesToday = trades.filter(tr => (tr.closedAt || '').slice(0, 10) === t);
  const totalPnl    = trades.reduce((s, tr) => s + (tr.pnl || 0), 0);
  const todayPnl    = tradesToday.reduce((s, tr) => s + (tr.pnl || 0), 0);

  const won  = trades.filter(tr => tr.result === 'WIN').length;
  const lost = trades.filter(tr => tr.result === 'LOSS').length;
  const winRate = (won + lost) > 0 ? (won / (won + lost)) * 100 : 0;

  const best  = trades.reduce((b, tr) => (tr.pnl || 0) > (b?.pnl || -Infinity) ? tr : b, null);
  const worst = trades.reduce((w, tr) => (tr.pnl || 0) < (w?.pnl || Infinity)  ? tr : w, null);

  const avgPnl  = trades.length ? totalPnl / trades.length : 0;
  const holdTimes = trades.filter(tr => tr.holdTimeSec != null).map(tr => tr.holdTimeSec);
  const avgHold = holdTimes.length ? holdTimes.reduce((s, v) => s + v, 0) / holdTimes.length : 0;

  // Sharpe: mean(returns) / std(returns) * sqrt(252) — daily approximation
  const returns = trades.map(tr => tr.pnl || 0);
  const sharpe  = std(returns) > 0
    ? +(avgPnl / std(returns) * Math.sqrt(252)).toFixed(2)
    : 0;

  // By sport
  const bySport = {};
  for (const tr of trades) {
    if (!bySport[tr.sport]) bySport[tr.sport] = { count: 0, pnl: 0, wins: 0 };
    bySport[tr.sport].count++;
    bySport[tr.sport].pnl  += tr.pnl || 0;
    if (tr.result === 'WIN') bySport[tr.sport].wins++;
  }
  for (const s of Object.values(bySport)) {
    s.pnl     = +s.pnl.toFixed(2);
    s.winRate = s.count > 0 ? +(s.wins / s.count * 100).toFixed(1) : 0;
  }

  // By event type
  const byTrigger = {};
  for (const tr of trades) {
    const key = tr.trigger?.split(':')[0] || 'Unknown';
    if (!byTrigger[key]) byTrigger[key] = { count: 0, pnl: 0 };
    byTrigger[key].count++;
    byTrigger[key].pnl += tr.pnl || 0;
  }
  for (const s of Object.values(byTrigger)) s.pnl = +s.pnl.toFixed(2);

  return {
    bankroll:       state.bankroll ?? 1000,
    totalPnl:       +totalPnl.toFixed(2),
    todayPnl:       +todayPnl.toFixed(2),
    tradesTotal:    trades.length,
    tradesToday:    tradesToday.length,
    winRate:        +winRate.toFixed(1),
    avgPnlPerTrade: +avgPnl.toFixed(2),
    avgHoldSec:     +avgHold.toFixed(1),
    sharpe,
    best:  best  ? { event: best.eventName,  pnl: best.pnl,  trigger: best.trigger }  : null,
    worst: worst ? { event: worst.eventName, pnl: worst.pnl, trigger: worst.trigger } : null,
    bySport,
    byTrigger,
    lastScanAt:    state.lastScanAt,
    bankrollHistory: (state.bankrollHistory || []).slice(-200),
    updatedAt: new Date().toISOString(),
  };
}

// Persist stats snapshot every 60s
setInterval(() => {
  try {
    const stats = getStats();
    const state = load('state.json') || {};
    save('state.json', { ...state, ...stats });
  } catch (e) {
    console.error('[MON] Stats error:', e.message);
  }
}, 60_000);

module.exports = { getStats };
