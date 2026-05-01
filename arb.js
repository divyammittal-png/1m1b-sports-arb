'use strict';

// Commission charged by exchange bookmakers on winnings
const COMMISSION = {
  betfair:       0.05,
  betfair_ex:    0.05,
  smarkets:      0.02,
  matchbook:     0.02,
};

function commissionFor(bookmakerId) {
  return COMMISSION[bookmakerId?.toLowerCase()] ?? 0;
}

// Shrink raw decimal odds to account for exchange commission on profit
function effectiveOdds(rawOdds, commission) {
  return (rawOdds - 1) * (1 - commission) + 1;
}

// Find the bookmaker offering the highest effective odds for each outcome
// outcomes: array of { name, bookmaker, bookmakerId, odds }
function bestPerOutcome(bookmakers) {
  const best = {};
  for (const bk of bookmakers) {
    const market = bk.markets?.find(m => m.key === 'h2h');
    if (!market) continue;
    const comm = commissionFor(bk.key);
    for (const o of market.outcomes) {
      const eff = effectiveOdds(o.price, comm);
      if (!best[o.name] || eff > best[o.name].effectiveOdds) {
        best[o.name] = {
          outcome:      o.name,
          bookmaker:    bk.title || bk.key,
          bookmakerId:  bk.key,
          rawOdds:      o.price,
          commission:   comm,
          effectiveOdds: eff,
        };
      }
    }
  }
  return Object.values(best);
}

// Optimal stakes so every outcome returns the same profit
// Uses effective odds for actual returns, but displays raw odds to user
function calcStakes(legs, totalStake) {
  const impliedProb = legs.reduce((s, l) => s + 1 / l.effectiveOdds, 0);
  return legs.map(l => ({
    ...l,
    stake: +(totalStake * (1 / l.effectiveOdds) / impliedProb).toFixed(2),
  }));
}

const MIN_DISTINCT_BOOKS = 2;

// Main entry point — given a raw Odds API event, return an arb or null
function findBestArb(event, { totalStake = 100, minNetProfitPct = 0.5 } = {}) {
  const { bookmakers, home_team, away_team, id, sport_key, commence_time } = event;
  if (!bookmakers || bookmakers.length < MIN_DISTINCT_BOOKS) return null;

  const legs = bestPerOutcome(bookmakers);
  if (legs.length < 2 || legs.length > 3) return null;

  const impliedProb = legs.reduce((s, l) => s + 1 / l.effectiveOdds, 0);
  if (impliedProb >= 1.0) return null;

  const netProfitPct   = (1 - impliedProb) * 100;
  if (netProfitPct < minNetProfitPct) return null;

  // Gross: use raw odds (before exchange commission)
  const grossImplied   = legs.reduce((s, l) => s + 1 / l.rawOdds, 0);
  const grossProfitPct = (1 - grossImplied) * 100;

  const stakedLegs = calcStakes(legs, totalStake);

  // Require odds from at least 2 different bookmakers
  const uniqueBooks = new Set(stakedLegs.map(l => l.bookmakerId));
  if (uniqueBooks.size < MIN_DISTINCT_BOOKS) return null;

  return {
    id:            `${id}-${Date.now()}`,
    eventId:       id,
    event:         home_team && away_team ? `${home_team} vs ${away_team}` : id,
    sport:         formatSport(sport_key),
    sportKey:      sport_key,
    commenceTime:  commence_time,
    type:          legs.length === 2 ? 'two-way' : 'three-way',
    legs:          stakedLegs,
    totalStake,
    impliedProb:   +impliedProb.toFixed(6),
    grossProfitPct: +grossProfitPct.toFixed(4),
    netProfitPct:   +netProfitPct.toFixed(4),
    status:        'OPEN',
    foundAt:       new Date().toISOString(),
  };
}

function formatSport(key = '') {
  if (key.startsWith('soccer'))     return 'Football';
  if (key.startsWith('tennis'))     return 'Tennis';
  if (key.startsWith('basketball')) return 'Basketball';
  if (key.startsWith('cricket'))    return 'Cricket';
  return key;
}

module.exports = { findBestArb, effectiveOdds, commissionFor };
