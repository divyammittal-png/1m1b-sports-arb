'use strict';
const https    = require('https');
const fs       = require('fs');
const { dataPath } = require('./storage');
const { findBestArb } = require('./arb');
const executor = require('./executor');
const monitor  = require('./monitor');
const alerts   = require('./alerts');

// ── Config ────────────────────────────────────────────────────────────────────
const ODDS_API_KEY   = process.env.ODDS_API_KEY || '';
const SCAN_INTERVAL  = parseInt(process.env.SCAN_INTERVAL_MS || '300000', 10); // 5 min default (free tier: 500 req/month)
const MIN_PROFIT_PCT = parseFloat(process.env.MIN_PROFIT_PCT || '0.5');
const ALERT_THRESHOLD = parseFloat(process.env.ALERT_PROFIT_PCT || '1.0');
const PAPER_MODE     = process.env.PAPER_MODE !== 'false';

// Sports scanned in priority order — each costs 1 API credit
const SPORT_KEYS = [
  'soccer_epl',
  'soccer_spain_la_liga',
  'soccer_uefa_champs_league',
  'soccer_uefa_europa_league',
  'tennis_atp',
  'tennis_wta',
  'basketball_nba',
  'basketball_euroleague',
  'cricket_test_match',
];

// ── File paths ────────────────────────────────────────────────────────────────
const F = {
  arbs:  dataPath('arbs.json'),
  state: dataPath('state.json'),
};

let requestsRemaining = 500;
let requestsUsed      = 0;
let lastScanAt        = null;
let scanCount         = 0;

// ── JSON helpers ──────────────────────────────────────────────────────────────
function loadJSON(f) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}
function saveJSON(f, d) {
  try { fs.writeFileSync(f, JSON.stringify(d, null, 2)); } catch (e) { console.error('[SCAN] save error:', e.message); }
}

// ── HTTP helper ───────────────────────────────────────────────────────────────
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      // Capture remaining quota from headers
      if (res.headers['x-requests-remaining']) requestsRemaining = parseInt(res.headers['x-requests-remaining'], 10);
      if (res.headers['x-requests-used'])      requestsUsed      = parseInt(res.headers['x-requests-used'], 10);

      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode === 401) return reject(new Error('HTTP 401 — check ODDS_API_KEY'));
        if (res.statusCode === 422) return reject(new Error('HTTP 422 — sport not in season'));
        if (res.statusCode === 429) return reject(new Error('HTTP 429 — quota exhausted'));
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ── Odds API fetch ────────────────────────────────────────────────────────────
async function fetchOdds(sportKey) {
  const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds?apiKey=${ODDS_API_KEY}&regions=uk,eu&markets=h2h&oddsFormat=decimal`;
  return httpsGet(url);
}

// ── Betfair (optional) ────────────────────────────────────────────────────────
// Betfair requires session login; results are merged with Odds API data.
// Fill in placeBet() in executor.js to go live.
let betfairSession = null;

async function betfairLogin() {
  const user = process.env.BETFAIR_USERNAME;
  const pass = process.env.BETFAIR_PASSWORD;
  const key  = process.env.BETFAIR_APP_KEY;
  if (!user || !pass || !key) return;

  return new Promise((resolve) => {
    const payload = `username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`;
    const opts = {
      hostname: 'identitysso.betfair.com',
      path:     '/api/login',
      method:   'POST',
      headers:  {
        'X-Application':  key,
        'Content-Type':   'application/x-www-form-urlencoded',
        'Accept':         'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = https.request(opts, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          if (j.status === 'SUCCESS') {
            betfairSession = { token: j.token, key, loggedInAt: Date.now() };
            console.log('[BETFAIR] Logged in');
          } else {
            console.warn('[BETFAIR] Login failed:', j.error);
          }
        } catch { console.warn('[BETFAIR] Login parse error'); }
        resolve();
      });
    });
    req.on('error', e => { console.warn('[BETFAIR] Login error:', e.message); resolve(); });
    req.write(payload);
    req.end();
  });
}

// Refresh Betfair session every 4 hours
function scheduleBetfairRefresh() {
  setInterval(betfairLogin, 4 * 3600_000);
}

// ── Arb tracking ──────────────────────────────────────────────────────────────
function loadArbs()      { return loadJSON(F.arbs) || []; }
function saveArbs(arbs)  { saveJSON(F.arbs, arbs); }

// Expire arbs whose event has started
function expireArbs(arbs) {
  const now = Date.now();
  return arbs.map(a => {
    if (a.status === 'OPEN' && new Date(a.commenceTime).getTime() < now) {
      return { ...a, status: 'EXPIRED' };
    }
    return a;
  });
}

function isDuplicate(arbs, newArb) {
  return arbs.some(a => a.eventId === newArb.eventId && a.status === 'OPEN');
}

// ── Main scan ─────────────────────────────────────────────────────────────────
async function scanSport(sportKey) {
  let events;
  try {
    events = await fetchOdds(sportKey);
  } catch (e) {
    if (e.message.includes('422')) return 0; // sport out of season — silent skip
    console.warn(`[SCAN] ${sportKey}: ${e.message}`);
    return 0;
  }

  if (!Array.isArray(events)) return 0;

  let found = 0;
  let arbs  = loadArbs();
  arbs      = expireArbs(arbs);

  for (const event of events) {
    const arb = findBestArb(event, { minNetProfitPct: MIN_PROFIT_PCT });
    if (!arb) continue;
    if (isDuplicate(arbs, arb)) continue;

    console.log(`[ARB] ${arb.event} | ${arb.sport} | +${arb.netProfitPct.toFixed(2)}% net`);

    arbs.unshift(arb);
    found++;

    // Paper-trade it
    if (PAPER_MODE) {
      executor.executePaper(arb);
    }

    // Alert if above threshold
    if (arb.netProfitPct >= ALERT_THRESHOLD) {
      alerts.sendArbAlert(arb).catch(e => console.warn('[ALERT]', e.message));
    }
  }

  if (found) saveArbs(arbs.slice(0, 500));
  return found;
}

async function runScan() {
  if (!ODDS_API_KEY) {
    console.error('[SCAN] ODDS_API_KEY not set — set it in Railway environment variables');
    return;
  }
  if (requestsRemaining < 5) {
    console.warn(`[SCAN] Quota nearly exhausted (${requestsRemaining} remaining) — skipping scan`);
    return;
  }

  scanCount++;
  lastScanAt = new Date().toISOString();
  console.log(`[SCAN] #${scanCount} | quota: ${requestsRemaining} remaining`);

  let totalFound = 0;
  for (const sport of SPORT_KEYS) {
    totalFound += await scanSport(sport);
  }

  monitor.update({ lastScanAt, scanCount, requestsRemaining, requestsUsed, arbsFoundScan: totalFound });
  console.log(`[SCAN] Done — ${totalFound} new arb(s) found`);
}

// ── Entry point ───────────────────────────────────────────────────────────────
async function start() {
  console.log(`[SCAN] Starting — interval ${SCAN_INTERVAL / 1000}s | paper=${PAPER_MODE}`);

  await betfairLogin();
  scheduleBetfairRefresh();

  // Run immediately, then on interval
  await runScan();
  setInterval(runScan, SCAN_INTERVAL);
}

start().catch(e => { console.error('[SCAN] Fatal:', e.message); process.exit(1); });
