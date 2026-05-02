require('dotenv').config();
'use strict';
// Main trading process.
// Loop A (30s): listMarketCatalogue — find all in-play MATCH_ODDS markets.
// Loop B (2s):  listMarketBook     — fetch best back/lay odds for each market.
// After each Loop B: run detector against unprocessed score events,
// then hand any opportunities to executor.
//
// NOTE: BETFAIR_APP_KEY=sUGRnGHfDkovos55 is a Delay key — market data
// arrives 60 seconds late. Opportunities will be rare; swap to a real
// Stream API key for production.

const https    = require('https');
const auth     = require('./auth');
const { detectOpportunities } = require('./detector');
const executor = require('./executor');
const { load, save } = require('./storage');

const APP_KEY       = process.env.BETFAIR_APP_KEY || '';
const CATALOGUE_MS  = parseInt(process.env.CATALOGUE_MS  || '30000', 10);
const ODDS_MS       = parseInt(process.env.ODDS_MS        || '2000',  10);

// In-memory market state (shared with detector/executor in same process)
const markets = [];  // array of enriched market objects

// ── Betfair API helper ────────────────────────────────────────────────────────
function betfairPost(endpoint, body) {
  return new Promise((resolve, reject) => {
    const token = auth.getToken();
    if (!token) return reject(new Error('Not logged in'));

    const payload = JSON.stringify(body);
    const opts = {
      hostname: 'api.betfair.com',
      path:     `/exchange/betting/rest/v1.0/${endpoint}`,
      method:   'POST',
      headers:  {
        'X-Application':  APP_KEY,
        'X-Authentication': token,
        'Content-Type':   'application/json',
        'Accept':         'application/json',
        'Content-Length': Buffer.byteLength(payload),
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

// ── Loop A: fetch in-play market catalogue ────────────────────────────────────
async function refreshCatalogue() {
  let catalogue;
  try {
    catalogue = await betfairPost('listMarketCatalogue/', {
      filter: {
        inPlayOnly:       true,
        marketTypeCodes:  ['MATCH_ODDS'],
      },
      marketProjection: ['EVENT', 'MARKET_START_TIME', 'RUNNER_DESCRIPTION'],
      sort:             'FIRST_TO_START',
      maxResults:       '50',
    });
  } catch (e) {
    console.warn('[SCAN] Catalogue error:', e.message);
    if (e.message.includes('401')) await auth.login();
    return;
  }

  if (!Array.isArray(catalogue)) return;

  // Merge new markets into state — keep existing + add new
  const existingIds = new Set(markets.map(m => m.marketId));
  let added = 0;
  for (const m of catalogue) {
    if (existingIds.has(m.marketId)) continue;
    markets.push({
      marketId:   m.marketId,
      eventName:  m.event?.name || m.marketName,
      sport:      guessSport(m),
      startTime:  m.marketStartTime,
      runners:    (m.runners || []).map(r => ({
        selectionId: r.selectionId,
        runnerName:  r.runnerName,
        backOdds:    null,
        layOdds:     null,
      })),
      oddsHistory: [],
      status:     'LIVE',
      lastUpdated: null,
    });
    added++;
  }

  // Remove markets no longer in catalogue
  const liveIds = new Set(catalogue.map(m => m.marketId));
  for (let i = markets.length - 1; i >= 0; i--) {
    if (!liveIds.has(markets[i].marketId)) markets.splice(i, 1);
  }

  if (added) console.log(`[SCAN] Catalogue: ${markets.length} live markets (+${added} new)`);
  saveMarketsFile();
}

function guessSport(m) {
  const name = (m.event?.name || m.marketName || '').toLowerCase();
  if (name.includes('tennis')) return 'Tennis';
  if (name.includes('cricket')) return 'Cricket';
  if (name.includes('basketball')) return 'Basketball';
  return 'Football';
}

// ── Loop B: fetch odds + run detector ────────────────────────────────────────
async function refreshOdds() {
  if (markets.length === 0) return;

  // Betfair allows up to 40 market IDs per request
  const ids = markets.map(m => m.marketId).slice(0, 40);

  let books;
  try {
    books = await betfairPost('listMarketBook/', {
      marketIds:       ids,
      priceProjection: {
        priceData:              ['EX_BEST_OFFERS'],
        exBestOffersOverrides:  { bestPricesDepth: 3 },
      },
    });
  } catch (e) {
    console.warn('[SCAN] Odds error:', e.message);
    if (e.message.includes('401')) await auth.login();
    return;
  }

  if (!Array.isArray(books)) {
    console.warn('[SCAN] listMarketBook returned non-array:', typeof books, JSON.stringify(books)?.slice(0, 200));
    return;
  }

  // Debug: log the field names on the first book so we can spot API shape surprises
  if (books.length > 0) {
    const sample = books[0];
    const firstRunner = sample.runners?.[0];
    console.log(
      `[SCAN] Odds response: ${books.length} book(s)` +
      ` | first book keys: [${Object.keys(sample).join(',')}]` +
      ` | marketId: ${sample.marketId ?? '(missing)'}` +
      ` | first runner backOdds: ${firstRunner?.ex?.availableToBack?.[0]?.price ?? '(none)'}`
    );
  }

  const now = new Date().toISOString();
  let oddsPopulated = 0;

  for (const book of books) {
    // Betfair returns marketId (not id) on MarketBook objects
    const market = markets.find(m => m.marketId === book.marketId);
    if (!market) continue;

    market.status      = book.status;
    market.inPlay      = book.inplay;
    market.lastUpdated = now;

    for (const bkRunner of (book.runners || [])) {
      const runner = market.runners.find(r => r.selectionId === bkRunner.selectionId);
      if (!runner) continue;

      runner.status   = bkRunner.status;
      runner.backOdds = bkRunner.ex?.availableToBack?.[0]?.price ?? null;
      runner.layOdds  = bkRunner.ex?.availableToLay?.[0]?.price  ?? null;
      if (runner.backOdds) oddsPopulated++;
    }

    // Keep last 60s of odds snapshots (30 entries at 2s interval)
    market.oddsHistory.push({ ts: now, runners: market.runners.map(r => ({ id: r.selectionId, b: r.backOdds, l: r.layOdds })) });
    if (market.oddsHistory.length > 30) market.oddsHistory.shift();

    // Update executor's latest odds
    executor.updateMarketOdds(market.marketId, market.runners.filter(r => r.backOdds));
  }

  console.log(`[SCAN] Odds updated: ${oddsPopulated} runner price(s) across ${books.length} market(s)`);
  saveMarketsFile();
  runDetector();
}

// ── Detector integration ──────────────────────────────────────────────────────
const processedEventIds = new Set();

function runDetector() {
  const events = load('events.json') || [];
  const fresh  = events.filter(e => !e.processed && !processedEventIds.has(e.id));
  if (fresh.length === 0) return;

  const opportunities = load('opportunities.json') || [];

  for (const event of fresh) {
    processedEventIds.add(event.id);

    const found = detectOpportunities(markets, event);
    for (const opp of found) {
      console.log(`[DETECT] ${opp.eventType} opportunity: ${opp.runnerName} @ ${opp.currentOdds} → target ${opp.targetLayOdds} | edge ${opp.edgePct}%`);
      opportunities.unshift(opp);
      executor.openPosition(opp);
    }

    // Mark event processed in file
    event.processed = true;
  }

  save('events.json', events);
  save('opportunities.json', opportunities.slice(0, 200));
}

// ── Persist markets to file (for server.js to read) ──────────────────────────
function saveMarketsFile() {
  save('markets.json', markets.map(m => ({
    marketId:   m.marketId,
    eventName:  m.eventName,
    sport:      m.sport,
    status:     m.status,
    inPlay:     m.inPlay,
    lastUpdated: m.lastUpdated,
    runners:    m.runners.map(r => ({
      selectionId: r.selectionId,
      runnerName:  r.runnerName,
      backOdds:    r.backOdds,
      layOdds:     r.layOdds,
    })),
  })));
}

// ── Entry point ───────────────────────────────────────────────────────────────
async function start() {
  console.log('[SCAN] Starting — Betfair in-play scanner');
  console.log(`[SCAN] App key: ${APP_KEY ? APP_KEY.slice(0,4) + '...' : 'NOT SET'}`);

  const ok = await auth.login();
  if (!ok) {
    console.error('[SCAN] Login failed — retrying in 30s');
    setTimeout(start, 30_000);
    return;
  }
  auth.scheduleRefresh();

  await refreshCatalogue();
  setInterval(refreshCatalogue, CATALOGUE_MS);

  await refreshOdds();
  setInterval(refreshOdds, ODDS_MS);

  console.log(`[SCAN] Running — catalogue every ${CATALOGUE_MS/1000}s | odds every ${ODDS_MS/1000}s`);
}

start().catch(e => { console.error('[SCAN] Fatal:', e.message); process.exit(1); });
