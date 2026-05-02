'use strict';
require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
// Live score feed — polls BSD (Bzzoiro Sports Data) API.
// Writes events.json so scanner.js can match events to Betfair markets.
// Override poll interval with SCORES_POLL_MS env var.

const https  = require('https');
const { load, save } = require('./storage');

const BSD_API_KEY = process.env.BSD_API_KEY || 'bde3b2bf7c4d878851b97c2c1393e1b454a86c3f';
const POLL_MS     = parseInt(process.env.SCORES_POLL_MS || '300000', 10); // 5 min default
const DISABLED    = process.env.SCORES_DISABLED === 'true';

const BSD_BASE    = 'https://sports.bzzoiro.com/api';
// BSD status values for in-play matches
const LIVE_STATUSES = ['1st_half', '2nd_half', 'halftime'];

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

// Fetches all in-play events across all live status values.
async function fetchLiveEvents() {
  const all = [];
  for (const status of LIVE_STATUSES) {
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

// ── Main poll ─────────────────────────────────────────────────────────────────
async function poll() {
  let liveEvents;
  try {
    liveEvents = await fetchLiveEvents();
  } catch (e) {
    console.warn(`[SCORES] Fetch error: ${e.message}`);
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

  console.log(`[SCORES] Poll complete — ${liveEvents.length} live match(es), ${results.length} new goal(s)`);

  if (results.length === 0) return;

  const existing = (load('events.json') || []).filter(e => !e.processed);
  save('events.json', [...results, ...existing].slice(0, 200));

  for (const e of results) {
    console.log(`[SCORES] GOAL: ${e.homeTeam} vs ${e.awayTeam} [${e.homeScore}-${e.awayScore}] — scored by ${e.scoringTeam} (${e.minute}')`);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────
if (!DISABLED) {
  console.log(`[SCORES] Starting — BSD live scores, polling every ${POLL_MS / 1000}s`);
  poll();
  setInterval(poll, POLL_MS);
} else {
  console.log('[SCORES] Disabled via SCORES_DISABLED=true');
}
