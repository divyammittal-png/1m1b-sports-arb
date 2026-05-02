'use strict';
require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
// Live score feed — polls BSD (Bzzoiro Sports Data) API.
// Writes events.json so scanner.js can match events to Betfair markets.
//
// Two poll rates:
//   FAST (default 30s)  — 1st_half and 2nd_half: goals can occur any time
//   SLOW (default 300s) — halftime: scores frozen, conserves API quota
// Override with SCORES_FAST_POLL_MS / SCORES_SLOW_POLL_MS env vars.

const https  = require('https');
const { load, save } = require('./storage');

const BSD_API_KEY   = process.env.BSD_API_KEY || 'bde3b2bf7c4d878851b97c2c1393e1b454a86c3f';
const FAST_POLL_MS  = parseInt(process.env.SCORES_FAST_POLL_MS || '30000',  10);
const SLOW_POLL_MS  = parseInt(process.env.SCORES_SLOW_POLL_MS || '300000', 10);
const DISABLED      = process.env.SCORES_DISABLED === 'true';

const BSD_BASE = 'https://sports.bzzoiro.com/api';

// Statuses where goals can happen — polled at the fast rate
const FAST_STATUSES = ['1st_half', '2nd_half'];
// Statuses where scores are frozen — polled at the slow rate to save quota
const SLOW_STATUSES = ['halftime'];

// Previous score snapshot per event id
const prevScores  = {};
// Dedup emitted goal events
const emittedKeys = new Set();

// ── HTTP helper ───────────────────────────────────────────────────────────────
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'Authorization': `Token ${BSD_API_KEY}`,
        'User-Agent':    'Mozilla/5.0',
      },
    };
    const req = https.get(url, options, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode === 401) return reject(new Error('HTTP 401 — check BSD_API_KEY'));
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// Follows BSD pagination, returns all results for a given URL.
async function fetchAllPages(url) {
  const results = [];
  let next = url;
  while (next) {
    const data = await httpsGet(next);
    results.push(...(data.results || []));
    next = data.next || null;
  }
  return results;
}

// Fetches events for the given BSD status values.
async function fetchLiveEvents(statuses) {
  const all = [];
  for (const status of statuses) {
    const events = await fetchAllPages(`${BSD_BASE}/events/?status=${status}&limit=50`);
    all.push(...events);
  }
  return all;
}

// ── Goal detection ────────────────────────────────────────────────────────────
// BSD event shape: { id, home_team, away_team, home_score, away_score, current_minute, status }

function detectGoals(event) {
  const { id, home_team: homeTeam, away_team: awayTeam,
          home_score: homeScore, away_score: awayScore,
          current_minute: minute } = event;

  const prev     = prevScores[id] || { homeScore: 0, awayScore: 0 };
  const detected = [];

  if (homeScore > prev.homeScore) {
    detected.push({
      type: 'GOAL', sport: 'football', scoringTeam: 'home',
      homeTeam, awayTeam, homeScore, awayScore, minute: minute || null,
    });
  }
  if (awayScore > prev.awayScore) {
    detected.push({
      type: 'GOAL', sport: 'football', scoringTeam: 'away',
      homeTeam, awayTeam, homeScore, awayScore, minute: minute || null,
    });
  }

  prevScores[id] = { homeScore, awayScore };
  return detected;
}

// ── Poll ──────────────────────────────────────────────────────────────────────
async function poll(statuses) {
  let liveEvents;
  try {
    liveEvents = await fetchLiveEvents(statuses);
  } catch (e) {
    console.warn(`[SCORES] Fetch error (${statuses.join(',')}): ${e.message}`);
    return;
  }

  const results = [];
  for (const ev of liveEvents) {
    const goals = detectGoals(ev);
    for (const g of goals) {
      const key = `${ev.id}-${g.type}-${g.homeScore}-${g.awayScore}`;
      if (emittedKeys.has(key)) continue;
      emittedKeys.add(key);
      if (emittedKeys.size > 5000) emittedKeys.delete(emittedKeys.values().next().value);
      results.push({
        id:        `football-${ev.id}-${Date.now()}`,
        eventName: `${ev.home_team} vs ${ev.away_team}`,
        ...g,
        detectedAt: new Date().toISOString(),
        processed:  false,
      });
    }
  }

  console.log(`[SCORES] Poll (${statuses.join(',')}) — ${liveEvents.length} match(es), ${results.length} new goal(s)`);

  if (results.length === 0) return;

  const existing = (load('events.json') || []).filter(e => !e.processed);
  save('events.json', [...results, ...existing].slice(0, 200));

  for (const e of results) {
    console.log(`[SCORES] GOAL: ${e.homeTeam} vs ${e.awayTeam} [${e.homeScore}-${e.awayScore}] — scored by ${e.scoringTeam} (${e.minute}')`);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────
if (!DISABLED) {
  console.log(`[SCORES] Starting — fast poll ${FAST_POLL_MS / 1000}s (1st/2nd half) | slow poll ${SLOW_POLL_MS / 1000}s (halftime)`);

  poll(FAST_STATUSES);
  setInterval(() => poll(FAST_STATUSES), FAST_POLL_MS);

  // Stagger slow poll by 5s to avoid simultaneous API bursts on startup
  setTimeout(() => {
    poll(SLOW_STATUSES);
    setInterval(() => poll(SLOW_STATUSES), SLOW_POLL_MS);
  }, 5000);
} else {
  console.log('[SCORES] Disabled via SCORES_DISABLED=true');
}
