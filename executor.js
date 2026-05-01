'use strict';
// Paper trade executor.
// Opens positions on detected opportunities, monitors every 500ms,
// closes on target/timeout/stop-loss. Replace simulateFill() with
// a real Betfair placeOrders() call to go live.

const { load, save } = require('./storage');

const STARTING_BANKROLL = 1000;
const KELLY_FRACTION    = 0.25;
const MAX_STAKE         = 50;
const MAX_BANKROLL_PCT  = 0.05;
const MAX_POSITIONS     = 3;
const POSITION_TTL_MS   = 30_000;  // close after 30s if target not reached
const MONITOR_MS        = 500;

// In-memory latest odds — updated by scanner every 2s
const latestOdds = {};  // marketId -> { selectionId -> { backOdds, layOdds } }

// Active paper positions (in-memory + persisted to positions.json)
const positions = [];

// ── Bankroll ──────────────────────────────────────────────────────────────────
function getBankroll() {
  const state = load('state.json') || {};
  return state.bankroll ?? STARTING_BANKROLL;
}

function updateBankroll(delta) {
  const state   = load('state.json') || {};
  const before  = state.bankroll ?? STARTING_BANKROLL;
  const after   = +(before + delta).toFixed(2);
  state.bankroll = after;
  state.bankrollUpdatedAt = new Date().toISOString();
  if (!state.bankrollHistory) state.bankrollHistory = [];
  state.bankrollHistory.push({ ts: state.bankrollUpdatedAt, bankroll: after });
  if (state.bankrollHistory.length > 2000) state.bankrollHistory = state.bankrollHistory.slice(-2000);
  save('state.json', state);
  return after;
}

// ── Stake sizing ──────────────────────────────────────────────────────────────
function calcStake(edgePct, bankroll) {
  const edge      = edgePct / 100;
  const kelly     = edge * KELLY_FRACTION;
  const kellyCash = bankroll * kelly;
  return Math.max(1, Math.min(kellyCash, bankroll * MAX_BANKROLL_PCT, MAX_STAKE));
}

// ── P&L for a back-lay trade ──────────────────────────────────────────────────
// Profit = stake * (backOdds - layOdds) / layOdds
function calcPnl(stake, backOdds, layOdds) {
  if (layOdds >= backOdds) return -(stake * 0.05); // odds moved against — small loss
  return stake * (backOdds - layOdds) / layOdds;
}

// ── Paper fill (replace with Betfair placeOrders() to go live) ───────────────
function simulateFill(_opportunity) {
  // In paper mode we assume the back bet is always filled at quoted odds.
  return { filled: true };
}

// ── Open a new paper position ─────────────────────────────────────────────────
function openPosition(opportunity) {
  if (positions.filter(p => p.status === 'OPEN').length >= MAX_POSITIONS) {
    console.log('[EXEC] Max positions reached — skipping');
    return;
  }

  const bankroll = getBankroll();
  const stake    = +calcStake(opportunity.edgePct, bankroll).toFixed(2);

  const fill = simulateFill(opportunity);
  if (!fill.filled) return;

  const position = {
    id:            `P-${Date.now()}`,
    opportunityId: opportunity.id,
    marketId:      opportunity.marketId,
    selectionId:   opportunity.selectionId,
    eventName:     opportunity.eventName,
    sport:         opportunity.sport,
    trigger:       opportunity.trigger,
    runnerName:    opportunity.runnerName,
    backOdds:      opportunity.currentOdds,
    targetLayOdds: opportunity.targetLayOdds,
    stake,
    openedAt:      new Date().toISOString(),
    expiresAt:     new Date(Date.now() + POSITION_TTL_MS).toISOString(),
    currentOdds:   opportunity.currentOdds,
    currentPnl:    0,
    status:        'OPEN',
    paper:         true,
  };

  positions.push(position);
  savePositions();

  console.log(`[EXEC] Opened P-${position.id.slice(-6)}: BACK ${position.runnerName} @ ${position.backOdds} | stake £${stake} | target lay ${position.targetLayOdds}`);
}

// ── Close a position ──────────────────────────────────────────────────────────
function closePosition(pos, reason, layOdds) {
  pos.status    = 'CLOSED';
  pos.closedAt  = new Date().toISOString();
  pos.closeReason = reason;
  pos.layOdds   = +(layOdds || pos.currentOdds || pos.backOdds).toFixed(2);
  pos.holdTimeMs = Date.now() - new Date(pos.openedAt).getTime();
  pos.holdTimeSec = +(pos.holdTimeMs / 1000).toFixed(1);
  pos.pnl       = +calcPnl(pos.stake, pos.backOdds, pos.layOdds).toFixed(2);
  pos.result    = pos.pnl > 0 ? 'WIN' : 'LOSS';

  updateBankroll(pos.pnl);

  // Move to trades.json
  const trades = load('trades.json') || [];
  trades.unshift({ ...pos });
  save('trades.json', trades.slice(0, 1000));

  savePositions();
  console.log(`[EXEC] Closed ${pos.id.slice(-6)}: ${pos.result} | lay @ ${pos.layOdds} | hold ${pos.holdTimeSec}s | P&L £${pos.pnl > 0 ? '+' : ''}${pos.pnl}`);
}

// ── Position monitor (runs every 500ms) ───────────────────────────────────────
function monitorPositions() {
  const now = Date.now();

  for (const pos of positions) {
    if (pos.status !== 'OPEN') continue;

    const mkt  = latestOdds[pos.marketId] || {};
    const odds = mkt[pos.selectionId];
    const currentBack = odds?.backOdds || pos.backOdds;
    const currentLay  = odds?.layOdds  || pos.backOdds;

    pos.currentOdds = currentBack;
    pos.currentPnl  = +calcPnl(pos.stake, pos.backOdds, currentLay).toFixed(2);

    // Target reached: lay odds have dropped to or below target
    if (currentBack <= pos.targetLayOdds) {
      closePosition(pos, 'TARGET_REACHED', currentLay);
      continue;
    }

    // Timeout
    if (now >= new Date(pos.expiresAt).getTime()) {
      closePosition(pos, 'TIMEOUT', currentLay);
      continue;
    }

    // Stop-loss: odds moved 15% above entry (position going wrong)
    if (currentBack > pos.backOdds * 1.15) {
      closePosition(pos, 'STOP_LOSS', currentLay);
    }
  }

  savePositions();
}

// ── Scanner calls this after each odds update ─────────────────────────────────
function updateMarketOdds(marketId, runners) {
  latestOdds[marketId] = {};
  for (const r of runners) {
    latestOdds[marketId][r.selectionId] = {
      backOdds: r.backOdds,
      layOdds:  r.layOdds,
    };
  }
}

function savePositions() {
  save('positions.json', positions.filter(p => p.status === 'OPEN'));
}

function getOpenPositions() {
  return positions.filter(p => p.status === 'OPEN');
}

// Start monitoring loop
setInterval(monitorPositions, MONITOR_MS);

module.exports = { openPosition, updateMarketOdds, getOpenPositions };
