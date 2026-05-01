'use strict';
// Live score feed — polls SofaScore every 5 seconds.
// Writes events.json so scanner.js can match events to Betfair markets.
// NOTE: SofaScore is a public API. If it blocks server-side requests,
// set SCORES_DISABLED=true and feed events manually via /api/inject-event.

const https  = require('https');
const { load, save } = require('./storage');

const POLL_MS = parseInt(process.env.SCORES_POLL_MS || '5000', 10);
const DISABLED = process.env.SCORES_DISABLED === 'true';

// Previous score snapshot per match id
const prevScores = {};
// Track events we have already emitted (by composite key) to avoid duplicates
const emittedKeys = new Set();

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const opts = {
      method: 'GET',
      headers: {
        'User-Agent': UA,
        'Referer':    'https://www.sofascore.com/',
        'Accept':     'application/json',
      },
    };
    const req = https.get(url, opts, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ── Event detection helpers ───────────────────────────────────────────────────

function detectFootballEvents(event) {
  const id   = String(event.id);
  const home = event.homeTeam?.name || 'Home';
  const away = event.awayTeam?.name || 'Away';
  const hScore = event.homeScore?.current ?? 0;
  const aScore = event.awayScore?.current ?? 0;
  const minute = event.time?.played ?? 0;
  const prev   = prevScores[id] || { hScore: 0, aScore: 0 };

  const events = [];

  if (hScore > prev.hScore) {
    events.push({
      type: 'GOAL', sport: 'football', scoringTeam: 'home',
      homeTeam: home, awayTeam: away,
      homeScore: hScore, awayScore: aScore, minute,
    });
  }
  if (aScore > prev.aScore) {
    events.push({
      type: 'GOAL', sport: 'football', scoringTeam: 'away',
      homeTeam: home, awayTeam: away,
      homeScore: hScore, awayScore: aScore, minute,
    });
  }

  prevScores[id] = { hScore, aScore };
  return events;
}

function detectTennisEvents(event) {
  const id     = String(event.id);
  const home   = event.homeTeam?.name || 'Home';
  const away   = event.awayTeam?.name || 'Away';
  const hSets  = event.homeScore?.current ?? 0;
  const aSets  = event.awayScore?.current ?? 0;
  // Period scores tell us individual sets
  const prev   = prevScores[id] || { hSets: 0, aSets: 0, hGames: 0, aGames: 0 };

  // Count total games from period scores
  const hGames = ['period1','period2','period3','period4','period5']
    .reduce((s, p) => s + (event.homeScore?.[p] ?? 0), 0);
  const aGames = ['period1','period2','period3','period4','period5']
    .reduce((s, p) => s + (event.awayScore?.[p] ?? 0), 0);

  const events = [];

  if (hSets > prev.hSets) {
    events.push({ type: 'SET_WON', sport: 'tennis', winner: 'home', homeTeam: home, awayTeam: away, hSets, aSets });
  }
  if (aSets > prev.aSets) {
    events.push({ type: 'SET_WON', sport: 'tennis', winner: 'away', homeTeam: home, awayTeam: away, hSets, aSets });
  }
  if (hGames > prev.hGames && hSets === prev.hSets) {
    events.push({ type: 'GAME_WON', sport: 'tennis', winner: 'home', homeTeam: home, awayTeam: away, hSets, aSets });
  }
  if (aGames > prev.aGames && aSets === prev.aSets) {
    events.push({ type: 'GAME_WON', sport: 'tennis', winner: 'away', homeTeam: home, awayTeam: away, hSets, aSets });
  }

  prevScores[id] = { hSets, aSets, hGames, aGames };
  return events;
}

// ── Main poll ─────────────────────────────────────────────────────────────────

async function pollSport(sport) {
  const url = `https://api.sofascore.com/api/v1/sport/${sport}/events/live`;
  let data;
  try {
    data = await httpsGet(url);
  } catch (e) {
    console.warn(`[SCORES] ${sport} poll error: ${e.message}`);
    return [];
  }

  const liveEvents = data?.events || [];
  const detected   = [];

  for (const ev of liveEvents) {
    const raw = sport === 'football'
      ? detectFootballEvents(ev)
      : detectTennisEvents(ev);

    for (const r of raw) {
      const key = `${sport}-${ev.id}-${r.type}-${r.homeScore ?? r.hSets ?? 0}-${r.awayScore ?? r.aSets ?? 0}`;
      if (emittedKeys.has(key)) continue;
      emittedKeys.add(key);
      if (emittedKeys.size > 5000) {
        const first = emittedKeys.values().next().value;
        emittedKeys.delete(first);
      }
      detected.push({ id: `${sport}-${ev.id}-${Date.now()}`, ...r, detectedAt: new Date().toISOString(), processed: false });
    }
  }

  return detected;
}

async function poll() {
  const [football, tennis] = await Promise.all([
    pollSport('football'),
    pollSport('tennis'),
  ]);

  const newEvents = [...football, ...tennis];
  if (newEvents.length === 0) return;

  const existing = (load('events.json') || []).filter(e => !e.processed);
  const merged   = [...newEvents, ...existing].slice(0, 200);
  save('events.json', merged);

  for (const e of newEvents) {
    console.log(`[SCORES] ${e.sport.toUpperCase()} ${e.type}: ${e.homeTeam} vs ${e.awayTeam}` +
      (e.homeScore != null ? ` [${e.homeScore}-${e.awayScore}]` : '') +
      (e.minute ? ` ${e.minute}'` : ''));
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────
if (!DISABLED) {
  console.log(`[SCORES] Starting — polling every ${POLL_MS / 1000}s`);
  poll();
  setInterval(poll, POLL_MS);
} else {
  console.log('[SCORES] Disabled via SCORES_DISABLED=true');
}
