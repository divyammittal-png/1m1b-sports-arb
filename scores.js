'use strict';
// Live score feed — polls The Odds API scores endpoint.
// Writes events.json so scanner.js can match events to Betfair markets.
// Free tier: 500 req/month. Default poll: every 5 minutes per sport key.
// Override with SCORES_POLL_MS env var.

const https  = require('https');
const { load, save } = require('./storage');

const ODDS_API_KEY  = process.env.ODDS_API_KEY || 'b88ef03b398dd998a6b6bfdac976a7d2';
const POLL_MS       = parseInt(process.env.SCORES_POLL_MS || '300000', 10); // 5 min default
const DISABLED      = process.env.SCORES_DISABLED === 'true';

// Soccer sport keys to monitor (one API call each per poll cycle)
const SOCCER_KEYS = [
  'soccer_epl',
  'soccer_spain_la_liga',
  'soccer_germany_bundesliga',
  'soccer_uefa_champs_league',
];

// Previous score snapshot per event id
const prevScores = {};
// Dedup emitted events
const emittedKeys = new Set();

let requestsRemaining = null;

// ── HTTP helper ───────────────────────────────────────────────────────────────
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.headers['x-requests-remaining']) {
        requestsRemaining = parseInt(res.headers['x-requests-remaining'], 10);
      }
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode === 401) return reject(new Error('HTTP 401 — check ODDS_API_KEY'));
        if (res.statusCode === 422) return reject(new Error('HTTP 422 — sport key not in season'));
        if (res.statusCode === 429) return reject(new Error('HTTP 429 — quota exhausted'));
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ── Goal detection ────────────────────────────────────────────────────────────
// The Odds API scores response:
// { id, sport_key, home_team, away_team, completed, scores: [{name, score}], last_update }

function detectGoals(event) {
  if (!event.scores || event.completed) return [];

  const id       = event.id;
  const homeTeam = event.home_team;
  const awayTeam = event.away_team;

  const homeEntry = event.scores.find(s => s.name === homeTeam);
  const awayEntry = event.scores.find(s => s.name === awayTeam);

  const homeScore = parseInt(homeEntry?.score ?? '0', 10);
  const awayScore = parseInt(awayEntry?.score ?? '0', 10);

  const prev = prevScores[id] || { homeScore: 0, awayScore: 0 };
  const detected = [];

  if (homeScore > prev.homeScore) {
    detected.push({
      type: 'GOAL', sport: 'football', scoringTeam: 'home',
      homeTeam, awayTeam, homeScore, awayScore, minute: null,
    });
  }
  if (awayScore > prev.awayScore) {
    detected.push({
      type: 'GOAL', sport: 'football', scoringTeam: 'away',
      homeTeam, awayTeam, homeScore, awayScore, minute: null,
    });
  }

  prevScores[id] = { homeScore, awayScore };
  return detected;
}

// ── Poll one soccer sport key ─────────────────────────────────────────────────
async function pollSportKey(sportKey) {
  const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/scores/?apiKey=${ODDS_API_KEY}&daysFrom=1`;
  let events;
  try {
    events = await httpsGet(url);
  } catch (e) {
    if (e.message.includes('422')) return []; // not in season — silent skip
    console.warn(`[SCORES] ${sportKey} error: ${e.message}`);
    return [];
  }

  if (!Array.isArray(events)) return [];

  // Only live events (not completed, has scores)
  const live = events.filter(e => !e.completed && e.scores);
  const detected = [];

  for (const ev of live) {
    const goals = detectGoals(ev);
    for (const g of goals) {
      const key = `${sportKey}-${ev.id}-${g.type}-${g.homeScore}-${g.awayScore}`;
      if (emittedKeys.has(key)) continue;
      emittedKeys.add(key);
      if (emittedKeys.size > 5000) emittedKeys.delete(emittedKeys.values().next().value);
      detected.push({ id: `football-${ev.id}-${Date.now()}`, sportKey, ...g, detectedAt: new Date().toISOString(), processed: false });
    }
  }

  return detected;
}

// ── Main poll ─────────────────────────────────────────────────────────────────
async function poll() {
  if (requestsRemaining != null && requestsRemaining < 5) {
    console.warn(`[SCORES] Quota nearly exhausted (${requestsRemaining} remaining) — skipping poll`);
    return;
  }

  const results = [];
  for (const key of SOCCER_KEYS) {
    const goals = await pollSportKey(key);
    results.push(...goals);
  }

  const quotaStr = requestsRemaining != null ? ` | quota: ${requestsRemaining} remaining` : '';
  console.log(`[SCORES] Poll complete — ${SOCCER_KEYS.length} keys, ${results.length} new event(s)${quotaStr}`);

  if (results.length === 0) return;

  const existing = (load('events.json') || []).filter(e => !e.processed);
  save('events.json', [...results, ...existing].slice(0, 200));

  for (const e of results) {
    console.log(`[SCORES] GOAL: ${e.homeTeam} vs ${e.awayTeam} [${e.homeScore}-${e.awayScore}] — scored by ${e.scoringTeam}`);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────
if (!DISABLED) {
  console.log(`[SCORES] Starting — Odds API scores, polling every ${POLL_MS / 1000}s`);
  poll();
  setInterval(poll, POLL_MS);
} else {
  console.log('[SCORES] Disabled via SCORES_DISABLED=true');
}
