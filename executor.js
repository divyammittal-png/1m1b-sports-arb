'use strict';
const fs = require('fs');
const { dataPath } = require('./storage');

const F = {
  trades:  dataPath('trades.json'),
  state:   dataPath('state.json'),
};

const STARTING_BANKROLL  = 1000;
const MAX_SINGLE_BET     = 200;
const MAX_BANKROLL_PCT   = 0.05;   // never risk more than 5% per arb
const MIN_NET_PROFIT_PCT = 1.0;    // only execute if net profit > 1%
const HALF_KELLY         = 0.5;    // fractional Kelly multiplier

function loadJSON(f) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}
function saveJSON(f, d) {
  try { fs.writeFileSync(f, JSON.stringify(d, null, 2)); } catch (e) { console.error('[EXEC] save error:', e.message); }
}

function getBankroll() {
  const state = loadJSON(F.state) || {};
  return state.bankroll ?? STARTING_BANKROLL;
}

function setBankroll(bankroll) {
  const state = loadJSON(F.state) || {};
  state.bankroll = bankroll;
  state.bankrollUpdatedAt = new Date().toISOString();
  if (!state.bankrollHistory) state.bankrollHistory = [];
  state.bankrollHistory.push({ ts: state.bankrollUpdatedAt, bankroll: +bankroll.toFixed(2) });
  if (state.bankrollHistory.length > 1000) state.bankrollHistory = state.bankrollHistory.slice(-1000);
  saveJSON(F.state, state);
}

// Kelly Criterion: edge / odds — scaled to half-Kelly
function kellyStake(bankroll, netProfitPct) {
  const edge   = netProfitPct / 100;
  const kelly  = edge * HALF_KELLY;
  const kelly$ = bankroll * kelly;
  return Math.min(kelly$, bankroll * MAX_BANKROLL_PCT, MAX_SINGLE_BET);
}

// Scale all leg stakes so they sum to totalStake
function scaleLegs(legs, totalStake) {
  const originalTotal = legs.reduce((s, l) => s + l.stake, 0);
  const factor = totalStake / originalTotal;
  return legs.map(l => ({ ...l, stake: +(l.stake * factor).toFixed(2) }));
}

// ── Paper trading ─────────────────────────────────────────────────────────────

function simulateBet(arb, scaledLegs, totalStake) {
  // Paper mode: assume the arb executes perfectly.
  // In a real arb every outcome is covered, so we always win.
  // Return the guaranteed profit.
  const profit = +(totalStake * arb.netProfitPct / 100).toFixed(2);
  return { success: true, profit, paper: true };
}

// Replace simulateBet with placeBet() using Betfair API when going live:
// async function placeBet(arb, scaledLegs, totalStake) { ... }

function executePaper(arb) {
  if (arb.netProfitPct < MIN_NET_PROFIT_PCT) {
    console.log(`[EXEC] Skip — ${arb.netProfitPct.toFixed(2)}% below ${MIN_NET_PROFIT_PCT}% threshold`);
    return;
  }

  const bankroll   = getBankroll();
  const totalStake = +(kellyStake(bankroll, arb.netProfitPct)).toFixed(2);

  if (totalStake < 1) {
    console.log('[EXEC] Skip — calculated stake < £1');
    return;
  }

  const scaledLegs = scaleLegs(arb.legs, totalStake);
  const result     = simulateBet(arb, scaledLegs, totalStake);

  if (!result.success) {
    console.warn('[EXEC] Bet simulation failed');
    return;
  }

  const newBankroll = +(bankroll + result.profit).toFixed(2);
  setBankroll(newBankroll);

  const trade = {
    id:              `T-${Date.now()}`,
    arbId:           arb.id,
    event:           arb.event,
    sport:           arb.sport,
    sportKey:        arb.sportKey,
    commenceTime:    arb.commenceTime,
    type:            arb.type,
    legs:            scaledLegs,
    totalStake,
    netProfitPct:    arb.netProfitPct,
    grossProfitPct:  arb.grossProfitPct,
    expectedProfit:  result.profit,
    actualPnl:       result.profit,  // paper: guaranteed
    bankrollBefore:  +bankroll.toFixed(2),
    bankrollAfter:   newBankroll,
    placedAt:        new Date().toISOString(),
    status:          'WON',           // paper arb: always wins if executed
    paper:           true,
  };

  const trades = loadJSON(F.trades) || [];
  trades.unshift(trade);
  saveJSON(F.trades, trades.slice(0, 1000));

  console.log(`[EXEC] Paper trade placed: £${totalStake} staked | +£${result.profit} | bankroll £${bankroll.toFixed(2)} → £${newBankroll.toFixed(2)}`);
}

module.exports = { executePaper };
