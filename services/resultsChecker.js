const apiAggregator = require('./apiAggregator');
const { normalizeStatus, normalizeApiFootballFixture, toEatParts } = require('./dataNormalizer');
const { LEAGUES, getLeagueByName, teamNamesMatch } = require('./leagueConfig');
const { apiKeys } = require('../config/apiKeys');

// Judges any of our supported market predictions against a final score. Pattern-matches on
// the prediction string itself rather than trusting prediction_type, since older rows (synced
// but not yet run through the prediction engine) can have a stale/mismatched type.
function evaluatePrediction(prediction, homeScore, awayScore) {
  if (homeScore == null || awayScore == null || !prediction) return null;
  const total = homeScore + awayScore;

  if (prediction === 'Home Win') return homeScore > awayScore;
  if (prediction === 'Away Win') return awayScore > homeScore;
  if (prediction === 'Draw') return homeScore === awayScore;
  if (prediction === '1X') return homeScore >= awayScore;
  if (prediction === 'X2') return awayScore >= homeScore;
  if (prediction === '12') return homeScore !== awayScore;
  if (prediction === 'BTTS Yes') return homeScore > 0 && awayScore > 0;
  if (prediction === 'BTTS No') return !(homeScore > 0 && awayScore > 0);

  if (prediction === 'Odd') return total % 2 === 1;
  if (prediction === 'Even') return total % 2 === 0;

  if (prediction === 'Home Clean Sheet') return awayScore === 0;
  if (prediction === 'Home Concedes') return awayScore > 0;
  if (prediction === 'Away Clean Sheet') return homeScore === 0;
  if (prediction === 'Away Concedes') return homeScore > 0;

  if (prediction === 'Home Win to Nil') return homeScore > awayScore && awayScore === 0;
  if (prediction === 'Away Win to Nil') return awayScore > homeScore && homeScore === 0;
  if (prediction === 'Neither') return !((homeScore > awayScore && awayScore === 0) || (awayScore > homeScore && homeScore === 0));

  // HT/FT ("Home/Away" etc.) can't be verified — we don't capture half-time scores anywhere.
  if (/^(Home|Draw|Away)\/(Home|Draw|Away)$/.test(prediction)) return null;

  let m = prediction.match(/^Over (\d+(?:\.\d+)?)$/);
  if (m) return total > parseFloat(m[1]);
  m = prediction.match(/^Under (\d+(?:\.\d+)?)$/);
  if (m) return total < parseFloat(m[1]);

  m = prediction.match(/^(\d+)-(\d+) Goals$/);
  if (m) return total >= Number(m[1]) && total <= Number(m[2]);

  m = prediction.match(/^(\d+)-(\d+)$/);
  if (m) return Number(m[1]) === homeScore && Number(m[2]) === awayScore;

  return null;
}

async function applyResolution(dbQuery, row, status, homeScore, awayScore) {
  if (status === 'LIVE') {
    if (row.status === 'Live') return false;
    await dbQuery.run(`UPDATE matches SET status = 'Live', checked_at = datetime('now') WHERE id = ?`, [row.id]);
    return true;
  }

  if (status === 'FINISHED' && homeScore != null && awayScore != null) {
    const isCorrect = evaluatePrediction(row.prediction, homeScore, awayScore);
    if (isCorrect === null) return false; // unrecognized prediction format — leave for manual review

    await dbQuery.run(
      `UPDATE matches SET status = ?, result = ?, home_score = ?, away_score = ?, checked_at = datetime('now') WHERE id = ?`,
      [isCorrect ? 'Won' : 'Lost', `${homeScore}-${awayScore} FT`, homeScore, awayScore, row.id]
    );
    await dbQuery.run(
      `UPDATE predictions_log SET actual_result = ?, is_correct = ? WHERE match_id = ?`,
      [`${homeScore}-${awayScore}`, isCorrect ? 1 : 0, row.match_id]
    );
    return true;
  }

  return false;
}

// Primary source: football-data.org, for the 8 leagues it covers — checked against ANY pending
// row in those leagues regardless of how old it is (a filterless /matches call returns the
// WHOLE season, ~380 matches, not just a date window — confirmed by testing). Scoping this to
// "today/yesterday" like the API-Football pass below would silently strand older pending rows
// in genuinely covered leagues, which is exactly what was happening before this fix: real
// finished matches (e.g. Serie A, LaLiga fixtures a few days old) were falling through to the
// Unverified safety net instead of resolving via data we already have access to.
async function checkViaFootballData(dbQuery, pendingRows) {
  const leaguesWithCode = LEAGUES.filter((l) => l.footballDataCode);
  const resolvedIds = new Set();

  for (const league of leaguesWithCode) {
    const rowsInLeague = pendingRows.filter((r) => {
      if (resolvedIds.has(r.id)) return false;
      const lm = getLeagueByName(r.competition_name, r.country);
      return lm && lm.footballDataCode === league.footballDataCode;
    });
    if (rowsInLeague.length === 0) continue;

    const result = await apiAggregator.fetchFootballDataOrg(`competitions/${league.footballDataCode}/matches`, {});
    if (!result.success) continue;
    const fdMatches = result.data.matches || [];

    for (const row of rowsInLeague) {
      const fd = fdMatches.find((m) => teamNamesMatch(m.homeTeam.name, row.home_team) && teamNamesMatch(m.awayTeam.name, row.away_team));
      if (!fd) continue;
      const status = normalizeStatus(fd.status);
      const changed = await applyResolution(dbQuery, row, status, fd.score && fd.score.fullTime ? fd.score.fullTime.home : null, fd.score && fd.score.fullTime ? fd.score.fullTime.away : null);
      if (changed || status === 'FINISHED' || status === 'LIVE') resolvedIds.add(row.id);
    }
  }

  return resolvedIds;
}

// Broad fallback: API-Football claims coverage of 900+ competitions worldwide, which is what
// actually closes the gap for the ~90 non-major leagues Betika lists (Betika itself has no
// results/live endpoint — its `tab` query param is unvalidated and always returns the same
// fixture+odds feed regardless of value, confirmed by testing). Two cheap calls (today +
// yesterday, globally, cached 10min) rather than one call per league. Only runs once
// API_FOOTBALL_KEY is configured — until then this is a no-op, not a crash.
async function checkViaApiFootball(dbQuery, pendingRows, today, yesterday) {
  const resolvedIds = new Set();
  if (!apiKeys.apiFootball || pendingRows.length === 0) return resolvedIds;

  for (const dateStr of [today, yesterday]) {
    const result = await apiAggregator.fetchApiFootball('fixtures', { date: dateStr });
    if (!result.success) continue;
    const fixtures = (result.data.response || []).map(normalizeApiFootballFixture);

    for (const row of pendingRows) {
      if (resolvedIds.has(row.id)) continue;
      const fx = fixtures.find((f) => teamNamesMatch(f.homeTeam, row.home_team) && teamNamesMatch(f.awayTeam, row.away_team));
      if (!fx) continue;
      const changed = await applyResolution(dbQuery, row, fx.status, fx.homeScore, fx.awayScore);
      if (changed || fx.status === 'FINISHED' || fx.status === 'LIVE') resolvedIds.add(row.id);
    }
  }

  return resolvedIds;
}

// Safety net for matches no configured source can verify (most of Betika's ~90 listed leagues,
// until API_FOOTBALL_KEY is added): after a generous grace period past kickoff, stop silently
// showing them as "Pending" — which implies the game hasn't happened — and mark them honestly
// as Unverified instead. No fake score, no guess; the dashboard/API should tell the truth about
// what we don't know.
const UNVERIFIED_GRACE_HOURS = 3;

async function flagUnverified(dbQuery, stillUnresolvedRows) {
  const cutoff = Date.now() - UNVERIFIED_GRACE_HOURS * 60 * 60 * 1000;
  let flagged = 0;
  for (const row of stillUnresolvedRows) {
    if (row.status !== 'Pending' && row.status !== 'Unverified') continue;
    const kickoff = new Date(`${row.match_date}T${row.match_time || '00:00'}:00+03:00`).getTime();
    if (kickoff < cutoff && row.status !== 'Unverified') {
      await dbQuery.run(`UPDATE matches SET status = 'Unverified', checked_at = datetime('now') WHERE id = ?`, [row.id]);
      flagged++;
    }
  }
  return flagged;
}

async function checkLiveResults(dbQuery) {
  const today = toEatParts(new Date()).date;
  const yesterday = toEatParts(new Date(Date.now() - 24 * 60 * 60 * 1000)).date;

  // football-data.org pass: ALL pending/live/previously-unverified rows, any age, in the 8
  // covered leagues. Unverified rows are retried too — a match wrongly stranded there by an
  // earlier bug (or before API_FOOTBALL_KEY was added) should resolve for real once it can.
  const allPendingRows = await dbQuery.all(`SELECT * FROM matches WHERE status IN ('Pending', 'Live', 'Unverified')`);
  const resolvedByFootballData = allPendingRows.length > 0 ? await checkViaFootballData(dbQuery, allPendingRows) : new Set();

  // API-Football pass: only makes sense scoped to a specific date (its endpoint takes `date`),
  // so restrict to today/yesterday here — older uncovered-league matches fall to Unverified below.
  const recentUnresolved = allPendingRows.filter((r) => !resolvedByFootballData.has(r.id) && (r.match_date === today || r.match_date === yesterday));
  const resolvedByApiFootball = await checkViaApiFootball(dbQuery, recentUnresolved, today, yesterday);

  // Unverified safety net has no date bound: a Pending match from days ago that no source ever
  // resolved shouldn't sit there forever looking like it "hasn't happened yet".
  const justResolvedIds = new Set([...resolvedByFootballData, ...resolvedByApiFootball]);
  const unverified = await flagUnverified(dbQuery, allPendingRows.filter((r) => !justResolvedIds.has(r.id)));

  return {
    checked: allPendingRows.length,
    updated: resolvedByFootballData.size + resolvedByApiFootball.size,
    unverified
  };
}

module.exports = { checkLiveResults, evaluatePrediction };
