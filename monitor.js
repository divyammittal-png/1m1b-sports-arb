'use strict';
const fs = require('fs');
const { dataPath } = require('./storage');

const F = {
  state:  dataPath('state.json'),
  arbs:   dataPath('arbs.json'),
  trades: dataPath('trades.json'),
};

function loadJSON(f) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}
function saveJSON(f, d) {
  try { fs.writeFileSync(f, JSON.stringify(d, null, 2)); } catch (e) { console.error('[MON] save error:', e.message); }
}

function today() { return new Date().toISOString().slice(0, 10); }
function thisWeekStart() {
  const d = new Date();
  d.setDate(d.getDate() - d.getDay());
  return d.toISOString().slice(0, 10);
}

function computeStats() {
  const arbs   = loadJSON(F.arbs)   || [];
  const trades = loadJSON(F.trades) || [];
  const t      = today();
  const w      = thisWeekStart();

  const arbsToday  = arbs.filter(a => (a.foundAt || '').slice(0, 10) === t);
  const arbsWeek   = arbs.filter(a => (a.foundAt || '').slice(0, 10) >= w);

  const tradesToday = trades.filter(a => (a.placedAt || '').slice(0, 10) === t);
  const tradesWeek  = trades.filter(a => (a.placedAt || '').slice(0, 10) >= w);

  const totalPnl   = trades.reduce((s, t) => s + (t.actualPnl || 0), 0);
  const todayPnl   = tradesToday.reduce((s, t) => s + (t.actualPnl || 0), 0);
  const weekPnl    = tradesWeek.reduce((s, t) => s + (t.actualPnl || 0), 0);

  const won  = trades.filter(t => t.status === 'WON').length;
  const lost = trades.filter(t => t.status === 'LOST').length;
  const winRate = won + lost > 0 ? (won / (won + lost)) * 100 : 100;

  const bestArb = arbs.reduce((best, a) =>
    (a.netProfitPct || 0) > (best?.netProfitPct || 0) ? a : best, null);

  const avgProfitPct = arbs.length > 0
    ? arbs.reduce((s, a) => s + (a.netProfitPct || 0), 0) / arbs.length
    : 0;

  // Arbs by sport
  const bySport = {};
  for (const a of arbs) {
    bySport[a.sport] = (bySport[a.sport] || 0) + 1;
  }

  // Arbs by bookmaker pair
  const byPair = {};
  for (const a of arbs) {
    if (!a.legs || a.legs.length < 2) continue;
    const pair = a.legs.slice(0, 2).map(l => l.bookmaker).sort().join(' / ');
    if (!byPair[pair]) byPair[pair] = { count: 0, totalProfitPct: 0 };
    byPair[pair].count++;
    byPair[pair].totalProfitPct += a.netProfitPct || 0;
  }
  const bookmakerPairs = Object.entries(byPair)
    .map(([pair, d]) => ({ pair, count: d.count, avgProfitPct: +(d.totalProfitPct / d.count).toFixed(3) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    arbsFoundToday:  arbsToday.length,
    arbsFoundWeek:   arbsWeek.length,
    arbsFoundTotal:  arbs.length,
    tradesTotal:     trades.length,
    tradesToday:     tradesToday.length,
    winRate:         +winRate.toFixed(1),
    totalPnl:        +totalPnl.toFixed(2),
    todayPnl:        +todayPnl.toFixed(2),
    weekPnl:         +weekPnl.toFixed(2),
    bestArb:         bestArb ? { event: bestArb.event, sport: bestArb.sport, netProfitPct: bestArb.netProfitPct, foundAt: bestArb.foundAt } : null,
    avgProfitPct:    +avgProfitPct.toFixed(4),
    bySport,
    bookmakerPairs,
  };
}

// Called by scanner after each scan cycle
function update(scanMeta) {
  const state = loadJSON(F.state) || {};
  const stats = computeStats();
  saveJSON(F.state, { ...state, ...scanMeta, ...stats, updatedAt: new Date().toISOString() });
}

// Called by server to get a fresh stats snapshot
function getStats() {
  const state = loadJSON(F.state) || {};
  const stats = computeStats();
  return { ...state, ...stats };
}

module.exports = { update, getStats };
