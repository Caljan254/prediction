// Odds math: implied probability, overround (vig) removal, multi-bookmaker consensus, value detection.

function impliedProbability(decimalOdds) {
  if (!decimalOdds || decimalOdds <= 1) return null;
  return 1 / decimalOdds;
}

// Bookmaker odds always overround (sum of implied probs > 1). Strip the vig proportionally
// so probabilities reflect the bookmaker's true model rather than their margin.
function removeOverround(probs) {
  const entries = Object.entries(probs).filter(([, v]) => typeof v === 'number' && v > 0);
  const sum = entries.reduce((acc, [, v]) => acc + v, 0);
  if (sum <= 0) return probs;
  const out = { ...probs };
  for (const [k, v] of entries) out[k] = v / sum;
  return out;
}

function probsFrom1x2Odds({ home, draw, away }) {
  const raw = {
    home: impliedProbability(home),
    draw: impliedProbability(draw),
    away: impliedProbability(away)
  };
  if (!raw.home || !raw.draw || !raw.away) return null;
  return removeOverround(raw);
}

// Averages de-vigged probabilities across every bookmaker quoting a match (from The Odds API).
function consensusFromBookmakers(bookmakerOdds) {
  const deVigged = bookmakerOdds
    .map((bm) => probsFrom1x2Odds(bm))
    .filter(Boolean);

  if (deVigged.length === 0) return null;

  const totals = { home: 0, draw: 0, away: 0 };
  for (const p of deVigged) {
    totals.home += p.home;
    totals.draw += p.draw;
    totals.away += p.away;
  }
  const n = deVigged.length;
  return {
    home: totals.home / n,
    draw: totals.draw / n,
    away: totals.away / n,
    bookmakersUsed: n
  };
}

// Blends Betika's own odds (what the user actually bets against) with the wider
// multi-bookmaker consensus so the "market" factor isn't skewed by one bookmaker.
function blendMarketProbs(betikaOdds, oddsApiConsensus, weights = { betika: 0.4, oddsApi: 0.6 }) {
  const betikaProbs = betikaOdds ? probsFrom1x2Odds(betikaOdds) : null;

  if (betikaProbs && oddsApiConsensus) {
    return {
      home: betikaProbs.home * weights.betika + oddsApiConsensus.home * weights.oddsApi,
      draw: betikaProbs.draw * weights.betika + oddsApiConsensus.draw * weights.oddsApi,
      away: betikaProbs.away * weights.betika + oddsApiConsensus.away * weights.oddsApi,
      sourcesUsed: 2
    };
  }
  if (betikaProbs) return { ...betikaProbs, sourcesUsed: 1 };
  if (oddsApiConsensus) return { ...oddsApiConsensus, sourcesUsed: 1 };
  return null;
}

// Positive expected value: our modeled probability implies the bookmaker's price
// pays out more than fair odds would.
function detectValueBet(modelProb, decimalOdds) {
  if (!modelProb || !decimalOdds) return { edge: null, isValue: false };
  const edge = modelProb * decimalOdds - 1;
  return { edge, isValue: edge > 0.05 };
}

// Signed lean for the "Bookmaker Odds Consensus" factor: +1 fully favors home, -1 fully favors away.
function leanFromProbs(probs) {
  if (!probs) return { lean: 0, dataAvailable: false };
  const lean = Math.max(-1, Math.min(1, (probs.home - probs.away) / Math.max(probs.home + probs.away, 0.01)));
  return { lean, dataAvailable: true };
}

module.exports = {
  impliedProbability,
  removeOverround,
  probsFrom1x2Odds,
  consensusFromBookmakers,
  blendMarketProbs,
  detectValueBet,
  leanFromProbs
};
