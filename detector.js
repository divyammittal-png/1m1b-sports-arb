'use strict';
// Matches live score events (from scores.js) to Betfair markets,
// estimates what odds SHOULD be after the event, and flags opportunities
// where current Betfair odds still reflect the pre-event price.

const MIN_EDGE_PCT = parseFloat(process.env.MIN_EDGE_PCT || '2.0');

// ── Team name normaliser ──────────────────────────────────────────────────────
function norm(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')                 // é → e + combining acute, ñ → n + combining tilde, etc.
    .replace(/[̀-ͯ]/g, '') // strip combining diacritical marks
    .replace(/[^a-z0-9]/g, '');
}

// Club-type tokens and connectors that carry no identifying information.
// Pure numbers (e.g. '04', '1899') are also stripped via the /^\d+$/ test below.
const NOISE_WORDS = new Set([
  'v', 'vs', 'fc', 'afc', 'sc', 'ac', 'rc', 'cf', 'bk', 'fk',
  'if', 'ik', 'sk', 'sad', 'srl', 'spa', 'bc', 'hfc', 'rfc',
]);

// Returns the meaningful word tokens of a team name after stripping noise.
// e.g. "Bayer 04 Leverkusen" → ["bayer", "leverkusen"]
//      "RB Leipzig"          → ["rb", "leipzig"]
//      "AVS - Futebol SAD"   → ["avs", "futebol"]
function significantWords(teamName) {
  return teamName
    .split(/[\s\-\/]+/)
    .map(w => norm(w))
    .filter(w => w.length > 0 && !/^\d+$/.test(w) && !NOISE_WORDS.has(w));
}

// Every significant word from each BSD team name must appear somewhere in the
// Betfair market name. Falls back to the original exact-substring check if
// significantWords yields nothing (e.g. a team name that is only noise tokens).
function teamsMatchMarket(event, market) {
  const n         = norm(market.eventName);
  const homeWords = significantWords(event.homeTeam);
  const awayWords = significantWords(event.awayTeam);

  if (homeWords.length === 0 || awayWords.length === 0) {
    return n.includes(norm(event.homeTeam)) && n.includes(norm(event.awayTeam));
  }

  return homeWords.every(w => n.includes(w)) && awayWords.every(w => n.includes(w));
}

// ── Expected-odds model ───────────────────────────────────────────────────────
// Returns the estimated new back odds for a runner given a key event.
// Positive scoreDiff = scoring team is now ahead by that margin.

function estimatedOddsAfterGoal({ runnerName, currentBackOdds, scoringTeamName, minute, scoreDiff }) {
  const name    = norm(runnerName);
  const scorer  = norm(scoringTeamName);
  const isDraw  = name.includes('draw') || runnerName === 'The Draw';
  const isScorer = name.includes(scorer);

  // Weight: later goals matter more
  const timeW = 1 + Math.min(1.0, minute / 90);

  // Impact factors tuned for typical Betfair football markets
  if (isScorer) {
    // Scoring team — odds shorten (decrease)
    const drop = scoreDiff === 1 ? 0.22 * timeW : 0.35 * timeW;
    return Math.max(1.02, currentBackOdds * (1 - drop));
  }
  if (isDraw) {
    const drop = scoreDiff === 1 ? 0.15 * timeW : 0.28 * timeW;
    return Math.max(1.02, currentBackOdds * (1 - drop));
  }
  // Conceding team — odds lengthen (increase)
  const rise = scoreDiff === 1 ? 0.35 * timeW : 0.55 * timeW;
  return currentBackOdds * (1 + rise);
}

function estimatedOddsAfterSetWon({ runnerName, currentBackOdds, winner, homeTeam, awayTeam }) {
  const name    = norm(runnerName);
  const winnerName = norm(winner === 'home' ? homeTeam : awayTeam);
  const isWinner = name.includes(winnerName);

  if (isWinner) return Math.max(1.02, currentBackOdds * (1 - 0.20));
  return currentBackOdds * (1 + 0.25);
}

function estimatedOddsAfterGameWon({ runnerName, currentBackOdds, winner, homeTeam, awayTeam }) {
  const name    = norm(runnerName);
  const winnerName = norm(winner === 'home' ? homeTeam : awayTeam);
  const isWinner = name.includes(winnerName);

  if (isWinner) return Math.max(1.02, currentBackOdds * (1 - 0.08));
  return currentBackOdds * (1 + 0.10);
}

// ── Core detector ─────────────────────────────────────────────────────────────
// markets: array from scanner in-memory state
// event:   one detected score event from events.json
// Returns array of opportunity objects (may be empty)

function detectOpportunities(markets, event) {
  const results = [];

  // Debug: log every incoming BSD score event and its significant word tokens
  console.log(
    `[DETECTOR] Event received: "${event.homeTeam} vs ${event.awayTeam}"` +
    ` | words: [${significantWords(event.homeTeam).join(',')}] / [${significantWords(event.awayTeam).join(',')}]` +
    ` | checking ${markets.length} market(s)`
  );

  let matchedMarkets = 0;
  for (const market of markets) {
    if (!teamsMatchMarket(event, market)) {
      // Log the first few misses so name-format differences are visible
      if (matchedMarkets === 0 && markets.indexOf(market) < 5) {
        console.log(
          `[DETECTOR]   no match — market "${market.eventName}"` +
          ` (norm: "${norm(market.eventName)}")`
        );
      }
      continue;
    }

    matchedMarkets++;
    console.log(
      `[DETECTOR]   MATCHED market "${market.eventName}" (${market.marketId})`
    );

    for (const runner of (market.runners || [])) {
      const currentBackOdds = runner.backOdds;
      if (!currentBackOdds || currentBackOdds < 1.02) continue;

      let expectedOdds;

      if (event.type === 'GOAL') {
        const minute       = event.minute || 0;
        const homeAfter    = event.homeScore || 0;
        const awayAfter    = event.awayScore || 0;
        const homeBefore   = homeAfter - (event.scoringTeam === 'home' ? 1 : 0);
        const awayBefore   = awayAfter - (event.scoringTeam === 'away' ? 1 : 0);
        const marginBefore = Math.abs(homeBefore - awayBefore);
        const marginAfter  = Math.abs(homeAfter  - awayAfter);

        const isLateGoal      = minute >= 75;
        const isEqualiser     = marginAfter === 0;
        const isBigLead       = marginAfter >= 3;
        const isLateCloseGame = minute > 60 && marginBefore <= 1;

        if (!isLateGoal && !isEqualiser && !isBigLead && !isLateCloseGame) continue;

        const scoringTeamName = event.scoringTeam === 'home' ? event.homeTeam : event.awayTeam;
        const scoreDiff = Math.abs((event.homeScore || 0) - (event.awayScore || 0));
        expectedOdds = estimatedOddsAfterGoal({
          runnerName:      runner.runnerName,
          currentBackOdds,
          scoringTeamName,
          minute:          event.minute || 45,
          scoreDiff,
        });
      } else if (event.type === 'SET_WON') {
        expectedOdds = estimatedOddsAfterSetWon({ runnerName: runner.runnerName, currentBackOdds, ...event });
      } else if (event.type === 'GAME_WON') {
        expectedOdds = estimatedOddsAfterGameWon({ runnerName: runner.runnerName, currentBackOdds, ...event });
      } else {
        continue;
      }

      // Only look for "back then lay" opportunities: current odds > expected (about to shorten)
      if (expectedOdds >= currentBackOdds * 0.98) continue;

      // Edge = profit % from back-lay trade (after commission modelled into targetOdds)
      const edgePct = +((currentBackOdds - expectedOdds) / expectedOdds * 100).toFixed(2);
      if (edgePct < MIN_EDGE_PCT) continue;

      results.push({
        id:            `${market.marketId}-${runner.selectionId}-${Date.now()}`,
        marketId:      market.marketId,
        eventName:     market.eventName,
        sport:         event.sport === 'football' ? 'Football' : 'Tennis',
        eventType:     event.type,
        trigger:       buildTriggerLabel(event),
        selectionId:   runner.selectionId,
        runnerName:    runner.runnerName,
        currentOdds:   currentBackOdds,
        targetLayOdds: +expectedOdds.toFixed(2),
        edgePct,
        detectedAt:    new Date().toISOString(),
        expiresAt:     new Date(Date.now() + 30_000).toISOString(),
        status:        'OPEN',
      });
    }
  }

  if (matchedMarkets === 0) {
    console.log(
      `[DETECTOR]   no Betfair market matched — ` +
      `BSD names may differ from Betfair names (e.g. "Bayer 04 Leverkusen" vs "Bayer Leverkusen")`
    );
  } else {
    console.log(`[DETECTOR]   ${results.length} opportunity(ies) found across ${matchedMarkets} matched market(s)`);
  }

  return results;
}

function buildTriggerLabel(event) {
  if (event.type === 'GOAL') {
    const who = event.scoringTeam === 'home' ? event.homeTeam : event.awayTeam;
    return `Goal: ${who} [${event.homeScore}-${event.awayScore}] ${event.minute}'`;
  }
  if (event.type === 'SET_WON') {
    const who = event.winner === 'home' ? event.homeTeam : event.awayTeam;
    return `Set won: ${who} [${event.hSets}-${event.aSets}]`;
  }
  if (event.type === 'GAME_WON') {
    const who = event.winner === 'home' ? event.homeTeam : event.awayTeam;
    return `Game won: ${who}`;
  }
  return event.type;
}

module.exports = { detectOpportunities };
