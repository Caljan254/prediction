const { FACTOR_WEIGHTS } = require('./predictionEngine');
const oddsEngine = require('./oddsEngine');

// Reshapes a predictionEngine result into the exact object shape the frontend's match-analysis
// modal already expects (h2hSummary, homeForm, squadOut, sentiment percentages, analyst picks).
// The modal was built against a fake generator; this feeds it real engine output instead,
// without needing any UI rewrite — the tabs already fit our real factors almost one-to-one
// (e.g. "Travel & Pitch" -> weather + rest days, "Social Sentiment" -> our probsHDA).

const FACTOR_LABELS = {
  recentForm: 'Recent Form',
  h2h: 'H2H Record',
  homeAwayStrength: 'Home/Away Strength',
  injuries: 'Injuries & Suspensions',
  oddsConsensus: 'Bookmaker Odds Consensus',
  xg: 'xG & Advanced Stats',
  squadDepth: 'Squad Depth',
  managerRecord: 'Manager/Coach Record',
  weather: 'Weather Conditions',
  restDays: 'Rest Days & Fatigue',
  communityConsensus: 'Community Consensus'
};

const MARKET_LABELS = {
  '1X2': '1X2 Model',
  'Double Chance': 'Double Chance Model',
  'Over/Under 1.5': 'O/U 1.5 Model',
  'Over/Under 2.5': 'O/U 2.5 Model',
  'Over/Under 3.5': 'O/U 3.5 Model',
  BTTS: 'BTTS Model',
  'Odd/Even Goals': 'Odd/Even Model',
  Multigoals: 'Multigoals (Basket) Model',
  'Home Clean Sheet': 'Home Clean Sheet Model',
  'Away Clean Sheet': 'Away Clean Sheet Model',
  'Win to Nil': 'Win to Nil Model',
  'HT/FT': 'HT/FT Model (informational — not auto-verified, half-time scores aren\'t captured)'
};

function buildSquadNotes(injuries) {
  if (!injuries.dataAvailable) return { home: null, away: null };

  if (injuries.source === 'apiFootball') {
    return {
      home: [`${injuries.homeInjuryCount} reported injury/suspension concern(s) via API-Football.`],
      away: [`${injuries.awayInjuryCount} reported injury/suspension concern(s) via API-Football.`]
    };
  }

  const home = injuries.homeSignal && injuries.homeSignal.dataAvailable
    ? [`${injuries.homeSignal.injuryFlags} injury-related mention(s) in recent news (NewsAPI signal, not an official list).`]
    : null;
  const away = injuries.awaySignal && injuries.awaySignal.dataAvailable
    ? [`${injuries.awaySignal.injuryFlags} injury-related mention(s) in recent news (NewsAPI signal, not an official list).`]
    : null;
  return { home, away };
}

function buildTravelPitchNote(weather, restDays) {
  const parts = [];
  if (weather.dataAvailable) {
    parts.push(`Kickoff weather at ${weather.stadium.stadium}: ${weather.temperatureC}°C, ${weather.precipitationMm}mm precipitation, ${weather.windKph}km/h wind. ${weather.notes}`);
  }
  if (restDays.dataAvailable) {
    parts.push(`Rest: home team ${restDays.homeRestDays}d, away team ${restDays.awayRestDays}d since their last match.${restDays.congestionFlag ? ' Fixture congestion flag raised.' : ''}`);
  }
  return parts.length ? parts.join(' ') : null;
}

function buildSentiment(probsHDA) {
  return {
    homePct: Math.round(probsHDA.home * 100),
    drawPct: Math.round(probsHDA.draw * 100),
    awayPct: Math.round(probsHDA.away * 100),
    quotes: []
  };
}

function buildAnalystPicks(markets) {
  return Object.entries(markets)
    .filter(([market]) => market !== 'Correct Score')
    .map(([market, m]) => ({
      source: MARKET_LABELS[market] || market,
      pick: m.pick,
      conf: m.confidence >= 70 ? 'High' : m.confidence >= 50 ? 'Medium' : 'Low',
      note: `${m.confidence}% confidence from CALJAN's 11-factor engine.`
    }));
}

function buildFactorsForRadar(factors) {
  return Object.entries(FACTOR_LABELS).map(([name, label]) => {
    const f = factors[name];
    return {
      name,
      label,
      weight: FACTOR_WEIGHTS[name],
      lean: f.dataAvailable ? Math.round(f.lean * 100) / 100 : 0,
      dataAvailable: f.dataAvailable
    };
  });
}

// Flags positive expected-value bets: our modeled probability implies the bookmaker's price
// pays out more than fair odds would (edge > 5%).
//
// Gated on dataQuality >= 40%: when few of the 11 factors have real data, the Poisson model
// falls back to league-average lambda constants, and its probabilities can diverge wildly from
// the market on extreme-odds outcomes (we saw 100%+ "edges" on minor-league matches with almost
// no real inputs during testing). That divergence is model noise, not genuine value — flagging
// it as actionable would be irresponsible. Edges are also capped at 100% as a sanity bound;
// anything beyond that is far more likely a modeling artifact than a real market inefficiency.
const MIN_DATA_QUALITY_FOR_VALUE_BETS = 40;
const MAX_PLAUSIBLE_EDGE = 100;

function buildValueBets(probsHDA, betikaOdds, dataQuality) {
  if (!betikaOdds || dataQuality < MIN_DATA_QUALITY_FOR_VALUE_BETS) return [];
  const checks = [
    { market: 'Home Win', prob: probsHDA.home, odds: betikaOdds.home },
    { market: 'Draw', prob: probsHDA.draw, odds: betikaOdds.draw },
    { market: 'Away Win', prob: probsHDA.away, odds: betikaOdds.away }
  ];
  return checks
    .map(({ market, prob, odds }) => {
      const { edge, isValue } = oddsEngine.detectValueBet(prob, odds);
      return { market, modelProb: Math.round(prob * 1000) / 10, odds, edge: edge != null ? Math.round(edge * 1000) / 10 : null, isValue };
    })
    .filter((v) => v.isValue && v.edge <= MAX_PLAUSIBLE_EDGE);
}

function buildAnalysis(prediction, betikaOdds) {
  const { factors, markets, probsHDA } = prediction;
  const h2h = factors.h2h;
  const squad = buildSquadNotes(factors.injuries);

  return {
    // summary fields (kept for debugging/future use)
    markets,
    probsHDA,
    lambdaHome: prediction.lambdaHome,
    lambdaAway: prediction.lambdaAway,
    blendNote: prediction.blendNote,
    dataQuality: prediction.dataQuality,

    // fields the existing match-analysis modal consumes directly
    h2hSummary: h2h.dataAvailable ? { homeWins: h2h.homeTeamWins, draws: h2h.draws, awayWins: h2h.awayTeamWins, total: h2h.meetingsFound } : null,
    h2hList: h2h.dataAvailable ? h2h.meetingsList.slice(0, 5) : null,
    homeForm: factors.recentForm.formHome.dataAvailable ? factors.recentForm.formHome.formString.split('').slice(0, 5) : null,
    awayForm: factors.recentForm.formAway.dataAvailable ? factors.recentForm.formAway.formString.split('').slice(0, 5) : null,
    homeSquadOut: squad.home,
    awaySquadOut: squad.away,
    travel: buildTravelPitchNote(factors.weather, factors.restDays),
    sentiment: buildSentiment(probsHDA),
    analystPicks: buildAnalystPicks(markets),
    factors: buildFactorsForRadar(factors),
    valueBets: buildValueBets(probsHDA, betikaOdds, prediction.dataQuality),
    weather: factors.weather.dataAvailable ? {
      stadium: factors.weather.stadium.stadium,
      temperatureC: factors.weather.temperatureC,
      precipitationMm: factors.weather.precipitationMm,
      windKph: factors.weather.windKph,
      condition: factors.weather.condition,
      notes: factors.weather.notes,
      exact: factors.weather.exact
    } : null
  };
}

module.exports = { buildAnalysis, FACTOR_LABELS };
