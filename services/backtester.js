// Historical backtest of the prediction engine's core goal model.
//
// HONEST SCOPE: only 2 of the 11 factors can be reconstructed point-in-time-correct with our
// current data sources — Recent Form and H2H, both derived purely from football-data.org's
// match history filtered to strictly-before-kickoff results (no lookahead). Every other factor
// needs data we simply don't have historically on a free tier: no historical odds (The Odds API
// only gives current lines), no historical weather archive, no point-in-time injury/lineup
// snapshots, no archived news/Reddit sentiment, and football-data.org's standings endpoint only
// returns the CURRENT full-season table (using it for an early-season historical match would
// leak future information, so it's deliberately excluded here).
//
// This means the backtest measures something real and useful — whether the Poisson goal model
// built from recent scoring form has genuine skill — but it is NOT a backtest of the full
// 11-factor live engine (which also leans on odds-market calibration it can't get historically).
// Treat this as a lower-bound sanity check on the model's core, not a validation of live picks.
//
// DATA VOLUME CAVEAT: football-data.org's free tier is season-scoped. Early in a season there
// simply aren't 500+ finished matches yet across our 8 leagues — this will grow every matchday
// and the plan's 500+ target becomes reachable as the season progresses. Re-run this periodically.

const apiAggregator = require('./apiAggregator');
const predictionEngine = require('./predictionEngine');
const { LEAGUES } = require('./leagueConfig');
const { evaluatePrediction } = require('./resultsChecker');

const MIN_PRIOR_MATCHES_PER_TEAM = 3; // skip a team's earliest fixtures — not enough form history yet

function pick1X2(probs) {
  if (probs.home >= probs.draw && probs.home >= probs.away) return 'Home Win';
  if (probs.away >= probs.draw && probs.away >= probs.home) return 'Away Win';
  return 'Draw';
}

async function backtestLeague(league) {
  const result = await apiAggregator.fetchFootballDataOrg(`competitions/${league.footballDataCode}/matches`, { status: 'FINISHED' });
  if (!result.success) return { league: league.name, error: result.error, tested: 0, records: [] };

  const allMatches = (result.data.matches || []).filter((m) => m.score && m.score.fullTime && m.score.fullTime.home != null);
  allMatches.sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));

  const records = [];
  for (let i = 0; i < allMatches.length; i++) {
    const target = allMatches[i];
    // Strictly-before filter: this match must not influence its own prediction.
    const priorMatches = allMatches.filter((m) => new Date(m.utcDate) < new Date(target.utcDate));

    const homeTeam = target.homeTeam.name, awayTeam = target.awayTeam.name;
    const homeMatches = predictionEngine.findTeamMatches(priorMatches, homeTeam, 20);
    const awayMatches = predictionEngine.findTeamMatches(priorMatches, awayTeam, 20);
    if (homeMatches.length < MIN_PRIOR_MATCHES_PER_TEAM || awayMatches.length < MIN_PRIOR_MATCHES_PER_TEAM) continue;

    const formHome = predictionEngine.computeRecentForm(homeTeam, homeMatches);
    const formAway = predictionEngine.computeRecentForm(awayTeam, awayMatches);
    if (!formHome.dataAvailable || !formAway.dataAvailable) continue;

    const { lambdaHome, lambdaAway } = predictionEngine.estimateLambdas({ formHome, formAway, homeAwayStrength: { dataAvailable: false } });
    const grid = predictionEngine.scoreGrid(lambdaHome, lambdaAway);
    const probs = predictionEngine.probsFromGrid(grid);

    const modelPick = pick1X2(probs);
    const baselinePick = 'Home Win'; // naive "always favor the home team" baseline for context

    const actualHome = target.score.fullTime.home, actualAway = target.score.fullTime.away;

    records.push({
      league: league.name,
      date: target.utcDate.slice(0, 10),
      home: homeTeam,
      away: awayTeam,
      actualScore: `${actualHome}-${actualAway}`,
      modelPick,
      modelConfidence: Math.round(Math.max(probs.home, probs.draw, probs.away) * 1000) / 10,
      modelCorrect: evaluatePrediction(modelPick, actualHome, actualAway),
      baselineCorrect: evaluatePrediction(baselinePick, actualHome, actualAway)
    });
  }

  return { league: league.name, totalFinishedMatches: allMatches.length, tested: records.length, records };
}

function summarize(records) {
  const total = records.length;
  const modelWins = records.filter((r) => r.modelCorrect).length;
  const baselineWins = records.filter((r) => r.baselineCorrect).length;
  return {
    total,
    modelHitRate: total > 0 ? Math.round((modelWins / total) * 1000) / 10 : null,
    baselineHitRate: total > 0 ? Math.round((baselineWins / total) * 1000) / 10 : null,
    edgeOverBaseline: total > 0 ? Math.round(((modelWins - baselineWins) / total) * 1000) / 10 : null
  };
}

async function runBacktest(dbQuery) {
  const leaguesWithCode = LEAGUES.filter((l) => l.footballDataCode);
  const perLeague = [];
  let allRecords = [];

  for (const league of leaguesWithCode) {
    const result = await backtestLeague(league);
    if (result.records) {
      allRecords = allRecords.concat(result.records);
      perLeague.push({ league: league.name, totalFinishedMatches: result.totalFinishedMatches || 0, tested: result.tested, ...summarize(result.records) });
    } else {
      perLeague.push({ league: league.name, error: result.error, tested: 0 });
    }
  }

  const overall = summarize(allRecords);
  const totalFinishedAcrossLeagues = perLeague.reduce((sum, l) => sum + (l.totalFinishedMatches || 0), 0);

  const report = {
    generatedAt: new Date().toISOString(),
    scope: 'Recent Form + H2H only (point-in-time correct, no lookahead) — odds/weather/injury/xG/squad/manager/sentiment factors cannot be reconstructed historically on our current free-tier data sources',
    dataVolumeNote: `${totalFinishedAcrossLeagues} finished matches currently available across covered leagues (season-scoped free tier, early in the 2026/27 season) — short of the plan's 500+ target; this grows every matchday`,
    overall,
    perLeague
  };

  if (dbQuery) {
    await dbQuery.run(
      `INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?)
       ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = datetime('now')`,
      ['backtest_report_latest', JSON.stringify(report)]
    );
  }

  return report;
}

module.exports = { runBacktest, backtestLeague };
