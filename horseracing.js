'use strict';
require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });

const https  = require('https');
const auth   = require('./auth');
const { load, save } = require('./storage');

const APP_KEY  = process.env.BETFAIR_APP_KEY || '';
const POLL_MS  = 60_000;   // refresh markets + detect movers every 60s
const HOLD_MS  = 30_000;   // hold each paper position for 30s then lay off
const MOVE_PCT = 15;       // % shortening required to flag a mover
const STAKE    = 2.50;

// marketId → { eventName, runners: { selectionId → { runnerName, backOdds, layOdds } } }
const markets  = {};
// marketId → { selectionId → backOdds } — snapshot from the previous poll
const prevOdds = {};
// paper positions waiting to be closed
const openTrades = [];

// ── Betfair REST helper ───────────────────────────────────────────────────────
function betfairPost(endpoint, body) {
  return new Promise((resolve, reject) => {
    const token = auth.getToken();
    if (!token) return reject(new Error('Not logged in'));
    const payload = JSON.stringify(body);
    const opts = {
      hostname: 'api.betfair.com',
      path:     `/exchange/betting/rest/v1.0/${endpoint}`,
      method:   'POST',
      headers: {
        'X-Application':    APP_KEY,
        'X-Authentication': token,
        'Content-Type':     'application/json',
        'Accept':           'application/json',
        'Content-Length':   Buffer.byteLength(payload),
      },
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 401) return reject(new Error('BF-401: session expired'));
        if (res.statusCode >= 400)  return reject(new Error(`BF-HTTP-${res.statusCode}`));
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('BF JSON parse error')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('BF Timeout')); });
    req.write(payload);
    req.end();
  });
}

// ── Fetch UK/Irish WIN markets (in-play + starting within 5 min) ──────────────
async function fetchMarkets() {
  const now  = new Date();
  const soon = new Date(now.getTime() + 5 * 60_000).toISOString();
  // Include markets that started up to 2h ago (i.e. in-play races)
  const from = new Date(now.getTime() - 2 * 3600_000).toISOString();

  const base = {
    filter: {
      eventTypeIds:    ['7'],         // Horse Racing
      marketCountries: ['GB', 'IE'],
      marketTypeCodes: ['WIN'],
    },
    marketProjection: ['EVENT', 'RUNNER_DESCRIPTION', 'MARKET_START_TIME'],
    sort:             'FIRST_TO_START',
    maxResults:       '50',
  };

  const [inPlay, upcoming] = await Promise.all([
    betfairPost('listMarketCatalogue/', { ...base, filter: { ...base.filter, inPlayOnly: true } }),
    betfairPost('listMarketCatalogue/', { ...base, filter: { ...base.filter, marketStartTime: { from, to: soon } } }),
  ]);

  const seen = new Set();
  const all  = [...(inPlay || []), ...(upcoming || [])].filter(m => {
    if (seen.has(m.marketId)) return false;
    seen.add(m.marketId);
    return true;
  });

  // Rebuild market registry
  for (const m of all) {
    if (!markets[m.marketId]) markets[m.marketId] = { eventName: m.event?.name || m.marketName || m.marketId, runners: {} };
    for (const r of (m.runners || [])) {
      if (!markets[m.marketId].runners[r.selectionId]) {
        markets[m.marketId].runners[r.selectionId] = { runnerName: r.runnerName, backOdds: null, layOdds: null };
      }
    }
  }
  // Prune stale markets
  const activeIds = new Set(all.map(m => m.marketId));
  for (const id of Object.keys(markets)) {
    if (!activeIds.has(id)) delete markets[id];
  }

  return all.length;
}

// ── Fetch odds, snapshot, detect movers ───────────────────────────────────────
async function fetchOddsAndDetect() {
  const ids = Object.keys(markets);
  if (ids.length === 0) return;

  const newOpportunities = [];

  // Betfair caps at 40 marketIds per listMarketBook call
  for (let i = 0; i < ids.length; i += 40) {
    let books;
    try {
      books = await betfairPost('listMarketBook/', {
        marketIds:       ids.slice(i, i + 40),
        priceProjection: { priceData: ['EX_BEST_OFFERS'], exBestOffersOverrides: { bestPricesDepth: 1 } },
      });
    } catch (e) {
      console.warn('[HORSE] Odds error:', e.message);
      if (e.message.includes('401')) await auth.login();
      continue;
    }
    if (!Array.isArray(books)) continue;

    for (const book of books) {
      const market = markets[book.marketId];
      if (!market) continue;
      const prev = prevOdds[book.marketId] || {};
      const snap = {};

      for (const bkRunner of (book.runners || [])) {
        if (bkRunner.status !== 'ACTIVE') continue;
        const runner = market.runners[bkRunner.selectionId];
        if (!runner) continue;

        const back = bkRunner.ex?.availableToBack?.[0]?.price ?? null;
        const lay  = bkRunner.ex?.availableToLay?.[0]?.price  ?? null;
        if (!back) continue;

        runner.backOdds = back;
        runner.layOdds  = lay;
        snap[bkRunner.selectionId] = back;

        const prevBack = prev[bkRunner.selectionId];
        if (!prevBack) continue;

        // Positive changePct = odds shortened (price fell) = bullish signal
        const changePct = (prevBack - back) / prevBack * 100;
        if (changePct < MOVE_PCT) continue;

        const opp = {
          id:          `HR-${book.marketId}-${bkRunner.selectionId}-${Date.now()}`,
          marketId:    book.marketId,
          selectionId: bkRunner.selectionId,
          eventName:   market.eventName,
          horseName:   runner.runnerName,
          prevOdds:    +prevBack.toFixed(2),
          currentOdds: +back.toFixed(2),
          currentLay:  lay ? +lay.toFixed(2) : null,
          changePct:   +changePct.toFixed(1),
          detectedAt:  new Date().toISOString(),
          status:      'OPEN',
        };
        newOpportunities.push(opp);
        console.log(`[HORSE] MOVER: ${runner.runnerName} — ${prevBack} → ${back} (${changePct.toFixed(1)}% shorter) in "${market.eventName}"`);
        openPaperTrade(opp);
      }

      prevOdds[book.marketId] = snap;
    }
  }

  if (newOpportunities.length > 0) {
    const existing = (load('horse-opportunities.json') || []).filter(o => o.status === 'OPEN');
    save('horse-opportunities.json', [...newOpportunities, ...existing].slice(0, 100));
  }
}

// ── Paper trade open ──────────────────────────────────────────────────────────
function openPaperTrade(opp) {
  if (!opp.currentOdds || opp.currentOdds < 1.05) return;
  const trade = {
    id:          opp.id,
    marketId:    opp.marketId,
    selectionId: opp.selectionId,
    eventName:   opp.eventName,
    horseName:   opp.horseName,
    backOdds:    opp.currentOdds,
    stake:       STAKE,
    openedAt:    opp.detectedAt,
    closeAt:     new Date(Date.now() + HOLD_MS).toISOString(),
    status:      'OPEN',
  };
  openTrades.push(trade);
  console.log(`[HORSE] Backed ${trade.horseName} @ ${trade.backOdds} | stake £${trade.stake} | closes in ${HOLD_MS / 1000}s`);
}

// ── Paper trade close (runs every 5s) ─────────────────────────────────────────
function closeTrades() {
  const now = Date.now();
  let anyClosed = false;

  for (const trade of openTrades) {
    if (trade.status !== 'OPEN') continue;
    if (now < new Date(trade.closeAt).getTime()) continue;

    const runner  = markets[trade.marketId]?.runners?.[trade.selectionId];
    const layOdds = runner?.layOdds ?? trade.backOdds;

    trade.status   = 'CLOSED';
    trade.closedAt = new Date().toISOString();
    trade.layOdds  = +layOdds.toFixed(2);

    if (layOdds < trade.backOdds) {
      trade.pnl    = +(trade.stake * (trade.backOdds - layOdds) / layOdds).toFixed(2);
      trade.result = 'WIN';
    } else {
      // Odds didn't move far enough — small friction loss
      trade.pnl    = +(-(trade.stake * 0.05)).toFixed(2);
      trade.result = 'LOSS';
    }

    anyClosed = true;
    console.log(`[HORSE] Closed ${trade.horseName}: ${trade.result} | back ${trade.backOdds} → lay ${trade.layOdds} | P&L £${trade.pnl >= 0 ? '+' : ''}${trade.pnl}`);
  }

  if (anyClosed) {
    const closed   = openTrades.filter(t => t.status === 'CLOSED');
    const existing = load('horseracing-trades.json') || [];
    save('horseracing-trades.json', [...closed, ...existing].slice(0, 500));
    // Remove closed from in-memory list
    for (let i = openTrades.length - 1; i >= 0; i--) {
      if (openTrades[i].status === 'CLOSED') openTrades.splice(i, 1);
    }
  }
}

// ── Poll loop ─────────────────────────────────────────────────────────────────
async function poll() {
  try {
    const count = await fetchMarkets();
    await fetchOddsAndDetect();
    console.log(`[HORSE] Poll done — ${count} markets tracked`);
  } catch (e) {
    console.warn('[HORSE] Poll error:', e.message);
    if (e.message.includes('401')) await auth.login();
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────
async function start() {
  console.log('[HORSE] Starting — UK/Irish horse racing mover detector');
  const ok = await auth.login();
  if (!ok) {
    console.error('[HORSE] Login failed — retrying in 30s');
    setTimeout(start, 30_000);
    return;
  }
  auth.scheduleRefresh();

  setInterval(closeTrades, 5_000);
  await poll();
  setInterval(poll, POLL_MS);
}

start().catch(e => { console.error('[HORSE] Fatal:', e.message); process.exit(1); });
