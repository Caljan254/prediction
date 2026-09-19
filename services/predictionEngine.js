const apiAggregator = require('./apiAggregator');
const oddsEngine = require('./oddsEngine');
const weatherEngine = require('./weatherEngine');
const sentimentEngine = require('./sentimentEngine');
const { normalizeOddsApiEvent } = require('./dataNormalizer');
const { apiKeys } = require('../config/apiKeys');
const { getLeagueByName, normalizeTeamName, teamNamesMatch } = require('./leagueConfig');

// Matches IMPLEMENTATION_PLAN.md "Factor Weights (Total = 100%)"
const FACTOR_WEIGHTS = {
  recentForm: 0.20,
  h2h: 0.15,
  homeAwayStrength: 0.12,
  injuries: 0.12,
  oddsConsensus: 0.10,
  xg: 0.08,
  squadDepth: 0.07,
  managerRecord: 0.05,
  weather: 0.04,
  restDays: 0.04,
  communityConsensus: 0.03
};

const LEAGUE_AVG_GOALS = 1.35; // baseline goals/team/game used to derive attack/defense ratings
const LEAGUE_TO_ODDS_SPORT_KEY = {
  'English Premier League': 'soccer_epl',
  'Spanish La Liga': 'soccer_spain_la_liga',
  'Italian Serie A': 'soccer_italy_serie_a',
  'German Bundesliga': 'soccer_germany_bundesliga',
  'French Ligue 1': 'soccer_france_ligue_one',
  'UEFA Champions League': 'soccer_uefa_champs_league',
  'UEFA Europa League': 'soccer_uefa_europa_league',
  'English Championship': 'soccer_efl_champ'
};

function clamp(x, min, max) { return Math.max(min, Math.min(max, x)); }
function round1(x) { return Math.round(x * 10) / 10; }
function pickBest(options) { return options.reduce((a, b) => (b.p > a.p ? b : a)); }

// ---- Poisson goal model ----

function factorial(n) { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; }
function poissonPmf(k, lambda) { return Math.exp(-lambda) * Math.pow(lambda, k) / factorial(k); }

function scoreGrid(lambdaHome, lambdaAway, maxGoals = 6) {
  const grid = [];
  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) {
      grid.push({ h, a, p: poissonPmf(h, lambdaHome) * poissonPmf(a, lambdaAway) });
    }
  }
  return grid;
}

function probsFromGrid(grid) {
  let home = 0, draw = 0, away = 0, over15 = 0, over25 = 0, over35 = 0, btts = 0;
  for (const { h, a, p } of grid) {
    if (h > a) home += p; else if (h < a) away += p; else draw += p;
    const total = h + a;
    if (total > 1.5) over15 += p;
    if (total > 2.5) over25 += p;
    if (total > 3.5) over35 += p;
    if (h > 0 && a > 0) btts += p;
  }
  return { home, draw, away, over15, under15: 1 - over15, over25, under25: 1 - over25, over35, under35: 1 - over35, bttsYes: btts, bttsNo: 1 - btts };
}

function topCorrectScores(grid, n = 3) {
  return [...grid].sort((a, b) => b.p - a.p).slice(0, n).map((g) => ({ score: `${g.h}-${g.a}`, probability: round1(g.p * 100) }));
}

// ---- Additional markets derived from the same Poisson grid ("predict everything", not just 1X2) ----

function oddEvenProbs(grid) {
  let odd = 0, even = 0;
  for (const { h, a, p } of grid) { if ((h + a) % 2 === 0) even += p; else odd += p; }
  return { odd, even };
}

// "Multigoals" — Betika's total-goals-range market (the "basket" the plan/user means).
const MULTIGOAL_RANGES = [[1, 2], [1, 3], [1, 4], [1, 5], [2, 3], [2, 4], [2, 5], [2, 6], [3, 4], [3, 5], [3, 6]];
function multiGoalProbs(grid) {
  return MULTIGOAL_RANGES.map(([min, max]) => {
    let p = 0;
    for (const g of grid) { const t = g.h + g.a; if (t >= min && t <= max) p += g.p; }
    return { range: `${min}-${max}`, p };
  });
}

function cleanSheetProbs(grid) {
  let homeCS = 0, awayCS = 0; // homeCS = away team scores 0; awayCS = home team scores 0
  for (const { h, a, p } of grid) {
    if (a === 0) homeCS += p;
    if (h === 0) awayCS += p;
  }
  return { homeCS, awayCS };
}

function winToNilProbs(grid) {
  let homeToNil = 0, awayToNil = 0;
  for (const { h, a, p } of grid) {
    if (h > a && a === 0) homeToNil += p;
    if (a > h && h === 0) awayToNil += p;
  }
  return { homeToNil, awayToNil, neither: 1 - homeToNil - awayToNil };
}

// HT/FT: assumes 45% of a team's expected goals arrive in the first half, 55% in the second —
// a standard football-analytics approximation (real halves aren't scored evenly), not a fitted
// value. We don't capture actual half-time scores anywhere in our data pipeline, so this market
// is generated for informational value but deliberately excluded from auto-verification/topPick.
function htFtProbs(lambdaHome, lambdaAway) {
  const htHome = lambdaHome * 0.45, htAway = lambdaAway * 0.45;
  const secondHome = lambdaHome * 0.55, secondAway = lambdaAway * 0.55;
  const results = {};
  const maxG = 5;
  for (let h1 = 0; h1 <= maxG; h1++) {
    for (let a1 = 0; a1 <= maxG; a1++) {
      const pHt = poissonPmf(h1, htHome) * poissonPmf(a1, htAway);
      if (pHt < 1e-6) continue;
      const htOutcome = h1 > a1 ? 'Home' : h1 < a1 ? 'Away' : 'Draw';
      for (let h2 = 0; h2 <= maxG; h2++) {
        for (let a2 = 0; a2 <= maxG; a2++) {
          const p = pHt * poissonPmf(h2, secondHome) * poissonPmf(a2, secondAway);
          if (p < 1e-7) continue;
          const ftOutcome = (h1 + h2) > (a1 + a2) ? 'Home' : (h1 + h2) < (a1 + a2) ? 'Away' : 'Draw';
          const key = `${htOutcome}/${ftOutcome}`;
          results[key] = (results[key] || 0) + p;
        }
      }
    }
  }
  return results;
}

// ---- Factor: Recent Form (football-data.org competition matches, current-season) ----

async function getLeagueData(footballDataCode) {
  if (!footballDataCode) return { matches: [], standings: [], matchesAvailable: false, standingsAvailable: false };
  const [matchesResult, standingsResult] = await Promise.all([
    apiAggregator.fetchFootballDataOrg(`competitions/${footballDataCode}/matches`, { status: 'FINISHED' }),
    apiAggregator.fetchFootballDataOrg(`competitions/${footballDataCode}/standings`)
  ]);
  return {
    matches: matchesResult.success ? matchesResult.data.matches || [] : [],
    standings: standingsResult.success ? standingsResult.data.standings || [] : [],
    matchesAvailable: matchesResult.success,
    standingsAvailable: standingsResult.success
  };
}

function findTeamMatches(matches, teamName, limit = 20) {
  const filtered = matches.filter((m) => {
    return teamNamesMatch(m.homeTeam && m.homeTeam.name, teamName) || teamNamesMatch(m.awayTeam && m.awayTeam.name, teamName);
  });
  filtered.sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate));
  return filtered.slice(0, limit);
}

// Last 10-20 games, with matches in the last 14 days weighted 2x (per IMPLEMENTATION_PLAN.md).
function computeRecentForm(teamName, teamMatches) {
  const now = Date.now();
  let weightedPoints = 0, weightSum = 0, goalsFor = 0, goalsAgainst = 0, gamesCounted = 0;
  const formLetters = [];

  for (const m of teamMatches) {
    if (!m.score || m.score.fullTime.home == null || m.score.fullTime.away == null) continue;
    const isHome = teamNamesMatch(m.homeTeam.name, teamName);
    const gf = isHome ? m.score.fullTime.home : m.score.fullTime.away;
    const ga = isHome ? m.score.fullTime.away : m.score.fullTime.home;
    const daysAgo = (now - new Date(m.utcDate).getTime()) / (1000 * 60 * 60 * 24);
    const weight = daysAgo <= 14 ? 2 : 1;

    weightedPoints += (gf > ga ? 3 : gf < ga ? 0 : 1) * weight;
    weightSum += weight;
    goalsFor += gf;
    goalsAgainst += ga;
    gamesCounted += 1;
    formLetters.push(gf > ga ? 'W' : gf < ga ? 'L' : 'D');
  }

  if (gamesCounted === 0) return { dataAvailable: false, lean: 0 };

  const pointsPerGame = weightedPoints / weightSum; // 0..3
  const lean = clamp((pointsPerGame - 1.5) / 1.5, -1, 1); // neutral at league-average ~1.5 ppg

  return {
    dataAvailable: true,
    gamesCounted,
    formString: formLetters.slice(0, 10).join(''),
    pointsPerGame: round1(pointsPerGame),
    goalsForPerGame: goalsFor / gamesCounted,
    goalsAgainstPerGame: goalsAgainst / gamesCounted,
    lean
  };
}

// ---- Factor: H2H ----

function computeH2H(homeTeamName, awayTeamName, leagueMatches) {
  const meetings = leagueMatches.filter((m) => {
    const h = m.homeTeam && m.homeTeam.name, a = m.awayTeam && m.awayTeam.name;
    return (teamNamesMatch(h, homeTeamName) && teamNamesMatch(a, awayTeamName)) || (teamNamesMatch(h, awayTeamName) && teamNamesMatch(a, homeTeamName));
  });

  if (meetings.length === 0) {
    return { dataAvailable: false, lean: 0, reason: 'No meetings found in current-season match history (free-tier data is season-scoped)' };
  }

  let homeTeamWins = 0, awayTeamWins = 0, draws = 0;
  const meetingsList = [];
  for (const m of meetings) {
    if (!m.score || m.score.fullTime.home == null) continue;
    const gf = m.score.fullTime.home, ga = m.score.fullTime.away;
    meetingsList.push({ date: (m.utcDate || '').slice(0, 10), home: m.homeTeam.name, away: m.awayTeam.name, score: `${gf}-${ga}` });
    if (gf === ga) { draws += 1; continue; }
    const winnerIsFixtureHome = gf > ga;
    const winnerMatchesInputHome = winnerIsFixtureHome ? teamNamesMatch(m.homeTeam.name, homeTeamName) : teamNamesMatch(m.awayTeam.name, homeTeamName);
    if (winnerMatchesInputHome) homeTeamWins += 1; else awayTeamWins += 1;
  }
  meetingsList.sort((a, b) => b.date.localeCompare(a.date));

  const total = homeTeamWins + awayTeamWins + draws;
  const lean = total > 0 ? clamp((homeTeamWins - awayTeamWins) / total, -1, 1) : 0;
  return { dataAvailable: true, meetingsFound: meetings.length, homeTeamWins, awayTeamWins, draws, lean, meetingsList };
}

// ---- Factor: Home/Away Strength (season standings, home/away split) ----

function computeHomeAwayStrength(homeTeamName, awayTeamName, standings) {
  const homeTable = standings.find((s) => s.type === 'HOME');
  const awayTable = standings.find((s) => s.type === 'AWAY');
  if (!homeTable || !awayTable) return { dataAvailable: false, lean: 0, reason: 'Home/Away standings split not available' };

  const homeRow = homeTable.table.find((r) => teamNamesMatch(r.team.name, homeTeamName));
  const awayRow = awayTable.table.find((r) => teamNamesMatch(r.team.name, awayTeamName));
  if (!homeRow || !awayRow || !homeRow.playedGames || !awayRow.playedGames) {
    return { dataAvailable: false, lean: 0, reason: 'Team not found in home/away standings, or no games played yet' };
  }

  const homePpg = homeRow.points / homeRow.playedGames;
  const awayPpg = awayRow.points / awayRow.playedGames;
  const lean = clamp((homePpg - awayPpg) / 3, -1, 1);

  return {
    dataAvailable: true,
    lean,
    homePpg: round1(homePpg),
    awayPpg: round1(awayPpg),
    homeGoalsForPerGame: homeRow.goalsFor / homeRow.playedGames,
    homeGoalsAgainstPerGame: homeRow.goalsAgainst / homeRow.playedGames,
    awayGoalsForPerGame: awayRow.goalsFor / awayRow.playedGames,
    awayGoalsAgainstPerGame: awayRow.goalsAgainst / awayRow.playedGames
  };
}

// ---- Factor: Rest Days & Fatigue ----

function computeRestDays(teamMatches, kickoffUtc) {
  if (teamMatches.length === 0 || !kickoffUtc) return null;
  const lastMatchDate = new Date(teamMatches[0].utcDate).getTime();
  return (new Date(kickoffUtc).getTime() - lastMatchDate) / (1000 * 60 * 60 * 24);
}

function combineRestDays(homeDays, awayDays) {
  if (homeDays == null || awayDays == null) return { dataAvailable: false, lean: 0 };
  const lean = clamp((homeDays - awayDays) / 5, -1, 1);
  return {
    dataAvailable: true,
    lean,
    homeRestDays: round1(homeDays),
    awayRestDays: round1(awayDays),
    congestionFlag: homeDays < 3 || awayDays < 3
  };
}

// ---- Factors needing API-Football (graceful no-op until API_FOOTBALL_KEY is set) ----

async function resolveApiFootballTeamId(teamName) {
  const result = await apiAggregator.fetchApiFootball('teams', { search: teamName });
  if (!result.success) return null;
  const teams = result.data.response || [];
  const exact = teams.find((t) => normalizeTeamName(t.team.name) === normalizeTeamName(teamName));
  return exact ? exact.team.id : (teams[0] ? teams[0].team.id : null);
}

async function computeInjuriesFactor(homeTeam, awayTeam) {
  if (apiKeys.apiFootball) {
    try {
      const [homeId, awayId] = await Promise.all([resolveApiFootballTeamId(homeTeam), resolveApiFootballTeamId(awayTeam)]);
      if (homeId && awayId) {
        const season = new Date().getFullYear();
        const [homeInj, awayInj] = await Promise.all([
          apiAggregator.fetchApiFootball('injuries', { team: homeId, season }),
          apiAggregator.fetchApiFootball('injuries', { team: awayId, season })
        ]);
        if (homeInj.success && awayInj.success) {
          const homeCount = (homeInj.data.response || []).length;
          const awayCount = (awayInj.data.response || []).length;
          return { dataAvailable: true, source: 'apiFootball', homeInjuryCount: homeCount, awayInjuryCount: awayCount, lean: clamp((awayCount - homeCount) / 6, -1, 1) };
        }
      }
    } catch (err) { /* fall through to news proxy below */ }
  }

  const [homeSignal, awaySignal] = await Promise.all([
    sentimentEngine.getTeamNewsSignal(homeTeam),
    sentimentEngine.getTeamNewsSignal(awayTeam)
  ]);
  const combined = sentimentEngine.combineInjurySentiment(homeSignal, awaySignal);
  return { ...combined, source: 'newsApi-proxy', homeSignal, awaySignal };
}

// Proxies "squad depth" with current injury count (full lineup data is only available
// ~1hr pre-kickoff via API-Football's lineups endpoint) — upgrade this once that's wired up.
async function computeSquadDepthFactor(homeTeam, awayTeam) {
  if (!apiKeys.apiFootball) return { dataAvailable: false, reason: 'API_FOOTBALL_KEY not configured' };
  try {
    const [homeId, awayId] = await Promise.all([resolveApiFootballTeamId(homeTeam), resolveApiFootballTeamId(awayTeam)]);
    if (!homeId || !awayId) return { dataAvailable: false, reason: 'Could not resolve one or both teams on API-Football' };
    const season = new Date().getFullYear();
    const [homeInj, awayInj] = await Promise.all([
      apiAggregator.fetchApiFootball('injuries', { team: homeId, season }),
      apiAggregator.fetchApiFootball('injuries', { team: awayId, season })
    ]);
    if (!homeInj.success || !awayInj.success) return { dataAvailable: false, reason: 'Injuries endpoint unavailable' };
    const homeDepth = Math.max(0, 1 - (homeInj.data.response || []).length * 0.06);
    const awayDepth = Math.max(0, 1 - (awayInj.data.response || []).length * 0.06);
    return { dataAvailable: true, homeDepth: round1(homeDepth), awayDepth: round1(awayDepth), lean: clamp((homeDepth - awayDepth) * 2, -1, 1) };
  } catch (err) {
    return { dataAvailable: false, reason: err.message };
  }
}

function extractCurrentTenureDays(coachResponse) {
  const coach = Array.isArray(coachResponse) ? coachResponse[0] : null;
  const current = coach && Array.isArray(coach.career) ? coach.career.find((c) => !c.end) : null;
  if (!current || !current.start) return null;
  return (Date.now() - new Date(current.start).getTime()) / (1000 * 60 * 60 * 24);
}

async function computeManagerRecordFactor(homeTeam, awayTeam) {
  if (!apiKeys.apiFootball) return { dataAvailable: false, reason: 'API_FOOTBALL_KEY not configured' };
  try {
    const [homeId, awayId] = await Promise.all([resolveApiFootballTeamId(homeTeam), resolveApiFootballTeamId(awayTeam)]);
    if (!homeId || !awayId) return { dataAvailable: false, reason: 'Could not resolve one or both teams' };
    const [homeCoach, awayCoach] = await Promise.all([
      apiAggregator.fetchApiFootball('coachs', { team: homeId }),
      apiAggregator.fetchApiFootball('coachs', { team: awayId })
    ]);
    if (!homeCoach.success || !awayCoach.success) return { dataAvailable: false, reason: 'Coachs endpoint unavailable' };
    const homeTenureDays = extractCurrentTenureDays(homeCoach.data.response);
    const awayTenureDays = extractCurrentTenureDays(awayCoach.data.response);
    if (homeTenureDays == null || awayTenureDays == null) return { dataAvailable: false, reason: 'No current tenure data found' };
    return { dataAvailable: true, homeTenureDays: Math.round(homeTenureDays), awayTenureDays: Math.round(awayTenureDays), lean: clamp((homeTenureDays - awayTenureDays) / 730, -1, 1) };
  } catch (err) {
    return { dataAvailable: false, reason: err.message };
  }
}

// Best-effort: Sportmonks xG is typically gated to higher-tier plans and covers a different
// set of leagues than our free-tier keys reach, so this will often report unavailable.
async function computeXgFactor(homeTeam, awayTeam, dateStr) {
  if (!apiKeys.sportmonks) return { dataAvailable: false, reason: 'SPORTMONKS_KEY not configured' };
  try {
    const result = await apiAggregator.fetchSportmonks(`fixtures/date/${dateStr}`, { include: 'xGFixture;participants' });
    if (!result.success) return { dataAvailable: false, reason: result.error };
    const fixtures = result.data.data || [];
    const match = fixtures.find((f) => {
      const names = (f.participants || []).map((p) => p.name);
      return names.some((n) => teamNamesMatch(n, homeTeam)) && names.some((n) => teamNamesMatch(n, awayTeam));
    });
    if (!match || !match.xGFixture) return { dataAvailable: false, reason: 'No xG data for this fixture (likely outside Sportmonks free-tier coverage)' };
    const homeXg = match.xGFixture.home_xg ?? match.xGFixture.home ?? null;
    const awayXg = match.xGFixture.away_xg ?? match.xGFixture.away ?? null;
    if (homeXg == null || awayXg == null) return { dataAvailable: false, reason: 'xG fields missing in response' };
    return { dataAvailable: true, homeXg, awayXg, lean: clamp((homeXg - awayXg) / 3, -1, 1) };
  } catch (err) {
    return { dataAvailable: false, reason: err.message };
  }
}

// ---- Factor: Bookmaker Odds Consensus ----

async function computeOddsFactor(homeTeam, awayTeam, league, betikaOdds) {
  const sportKey = LEAGUE_TO_ODDS_SPORT_KEY[league];
  let oddsApiConsensus = null;

  if (sportKey) {
    const result = await apiAggregator.fetchOddsApi(sportKey, 'uk,eu');
    if (result.success) {
      const events = Array.isArray(result.data) ? result.data : [];
      const event = events.find((e) => teamNamesMatch(e.home_team, homeTeam) && teamNamesMatch(e.away_team, awayTeam));
      if (event) oddsApiConsensus = oddsEngine.consensusFromBookmakers(normalizeOddsApiEvent(event));
    }
  }

  const blended = oddsEngine.blendMarketProbs(betikaOdds, oddsApiConsensus);
  const { lean, dataAvailable } = oddsEngine.leanFromProbs(blended);
  return { dataAvailable, lean, probs: blended, oddsApiConsensus };
}

// ---- Expected-goals model ----

function estimateLambdas({ formHome, formAway, homeAwayStrength }) {
  let attackHome = LEAGUE_AVG_GOALS, defenseAway = LEAGUE_AVG_GOALS, attackAway = LEAGUE_AVG_GOALS, defenseHome = LEAGUE_AVG_GOALS;

  if (homeAwayStrength.dataAvailable) {
    attackHome = homeAwayStrength.homeGoalsForPerGame;
    defenseHome = homeAwayStrength.homeGoalsAgainstPerGame;
    attackAway = homeAwayStrength.awayGoalsForPerGame;
    defenseAway = homeAwayStrength.awayGoalsAgainstPerGame;
  } else {
    if (formHome.dataAvailable) { attackHome = formHome.goalsForPerGame; defenseHome = formHome.goalsAgainstPerGame; }
    if (formAway.dataAvailable) { attackAway = formAway.goalsForPerGame; defenseAway = formAway.goalsAgainstPerGame; }
  }

  const lambdaHome = clamp((attackHome * defenseAway) / LEAGUE_AVG_GOALS, 0.3, 4);
  const lambdaAway = clamp((attackAway * defenseHome) / LEAGUE_AVG_GOALS, 0.3, 4);
  return { lambdaHome, lambdaAway };
}

function adjustLambdas(lambdaHome, lambdaAway, weatherImpact, qualityLean) {
  const weatherFactor = 1 + (weatherImpact || 0) * 0.15;
  const adjHome = clamp(lambdaHome * weatherFactor * (1 + qualityLean * 0.08), 0.2, 5);
  const adjAway = clamp(lambdaAway * weatherFactor * (1 - qualityLean * 0.08), 0.2, 5);
  return { lambdaHome: adjHome, lambdaAway: adjAway };
}

// ---- Orchestrator ----

async function generateMatchPrediction({ homeTeam, awayTeam, league, country, kickoffUtc, betikaOdds }) {
  const leagueMeta = getLeagueByName(league, country);
  const canonicalLeague = leagueMeta ? leagueMeta.name : league;
  const dateStr = (kickoffUtc || new Date().toISOString()).slice(0, 10);

  const leagueData = await getLeagueData(leagueMeta ? leagueMeta.footballDataCode : null);
  const homeMatches = findTeamMatches(leagueData.matches, homeTeam);
  const awayMatches = findTeamMatches(leagueData.matches, awayTeam);

  const formHome = computeRecentForm(homeTeam, homeMatches);
  const formAway = computeRecentForm(awayTeam, awayMatches);
  const formFactor = {
    dataAvailable: formHome.dataAvailable || formAway.dataAvailable,
    lean: clamp(((formHome.lean || 0) - (formAway.lean || 0)) / 2, -1, 1),
    formHome, formAway
  };

  const h2h = computeH2H(homeTeam, awayTeam, leagueData.matches);
  const homeAwayStrength = computeHomeAwayStrength(homeTeam, awayTeam, leagueData.standings);
  const restDaysFactor = combineRestDays(computeRestDays(homeMatches, kickoffUtc), computeRestDays(awayMatches, kickoffUtc));

  const [injuries, squadDepth, managerRecord, xg, oddsFactor, weather, homeNews, awayNews, reddit] = await Promise.all([
    computeInjuriesFactor(homeTeam, awayTeam),
    computeSquadDepthFactor(homeTeam, awayTeam),
    computeManagerRecordFactor(homeTeam, awayTeam),
    computeXgFactor(homeTeam, awayTeam, dateStr),
    computeOddsFactor(homeTeam, awayTeam, canonicalLeague, betikaOdds),
    weatherEngine.getMatchWeather({ homeTeam, kickoffUtc }),
    sentimentEngine.getTeamNewsSignal(homeTeam),
    sentimentEngine.getTeamNewsSignal(awayTeam),
    sentimentEngine.getRedditConsensus(homeTeam, awayTeam)
  ]);

  const weatherFactor = { dataAvailable: weather.dataAvailable, lean: weather.dataAvailable ? weather.impactScore * -0.3 : 0, ...weather };
  const communityConsensus = sentimentEngine.combineCommunityConsensus(reddit, homeNews, awayNews);

  const factors = {
    recentForm: formFactor,
    h2h,
    homeAwayStrength,
    injuries,
    oddsConsensus: oddsFactor,
    xg,
    squadDepth,
    managerRecord,
    weather: weatherFactor,
    restDays: restDaysFactor,
    communityConsensus
  };

  // Composite "team quality" lean drives the goal model; odds are blended in separately
  // afterwards as a market anchor, so they don't get counted twice.
  let qualityWeightSum = 0, qualityLeanSum = 0, availableCount = 0;
  for (const [name, weight] of Object.entries(FACTOR_WEIGHTS)) {
    const f = factors[name];
    if (name === 'oddsConsensus') { if (f.dataAvailable) availableCount++; continue; }
    if (f.dataAvailable) {
      qualityWeightSum += weight;
      qualityLeanSum += weight * f.lean;
      availableCount++;
    }
  }
  const qualityLean = qualityWeightSum > 0 ? clamp(qualityLeanSum / qualityWeightSum, -1, 1) : 0;
  const dataQuality = availableCount / Object.keys(FACTOR_WEIGHTS).length;

  const baseLambdas = estimateLambdas({ formHome, formAway, homeAwayStrength });
  const { lambdaHome, lambdaAway } = adjustLambdas(baseLambdas.lambdaHome, baseLambdas.lambdaAway, weatherFactor.impactScore, qualityLean);

  const grid = scoreGrid(lambdaHome, lambdaAway);
  const poissonProbs = probsFromGrid(grid);
  const correctScores = topCorrectScores(grid);

  let probsHDA = { home: poissonProbs.home, draw: poissonProbs.draw, away: poissonProbs.away };
  let blendNote = 'Model-only (no market odds available)';
  if (oddsFactor.dataAvailable && oddsFactor.probs) {
    probsHDA = {
      home: poissonProbs.home * 0.6 + oddsFactor.probs.home * 0.4,
      draw: poissonProbs.draw * 0.6 + oddsFactor.probs.draw * 0.4,
      away: poissonProbs.away * 0.6 + oddsFactor.probs.away * 0.4
    };
    blendNote = '60% Poisson goal model / 40% bookmaker market consensus';
  }
  const sumHDA = probsHDA.home + probsHDA.draw + probsHDA.away;
  probsHDA = { home: probsHDA.home / sumHDA, draw: probsHDA.draw / sumHDA, away: probsHDA.away / sumHDA };

  // Dampen confidence when few factors actually had real data, so a 90% pick always means
  // 90% AND well-supported — not just an unopposed Poisson guess off league averages.
  const confidenceMultiplier = 0.55 + 0.45 * dataQuality;
  const applyConfidence = (p) => Math.min(99, round1(p * 100 * confidenceMultiplier));

  const oneXTwo = pickBest([{ key: 'Home Win', p: probsHDA.home }, { key: 'Draw', p: probsHDA.draw }, { key: 'Away Win', p: probsHDA.away }]);
  const doubleChance = pickBest([{ key: '1X', p: probsHDA.home + probsHDA.draw }, { key: 'X2', p: probsHDA.away + probsHDA.draw }, { key: '12', p: probsHDA.home + probsHDA.away }]);
  const ou15 = pickBest([{ key: 'Over 1.5', p: poissonProbs.over15 }, { key: 'Under 1.5', p: poissonProbs.under15 }]);
  const ou25 = pickBest([{ key: 'Over 2.5', p: poissonProbs.over25 }, { key: 'Under 2.5', p: poissonProbs.under25 }]);
  const ou35 = pickBest([{ key: 'Over 3.5', p: poissonProbs.over35 }, { key: 'Under 3.5', p: poissonProbs.under35 }]);
  const btts = pickBest([{ key: 'BTTS Yes', p: poissonProbs.bttsYes }, { key: 'BTTS No', p: poissonProbs.bttsNo }]);

  const oddEven = oddEvenProbs(grid);
  const oddEvenPick = pickBest([{ key: 'Odd', p: oddEven.odd }, { key: 'Even', p: oddEven.even }]);

  const multiGoals = multiGoalProbs(grid);
  const bestMultiGoal = multiGoals.reduce((best, g) => (g.p > best.p ? g : best), multiGoals[0]);

  const cleanSheet = cleanSheetProbs(grid);
  const homeCSPick = pickBest([{ key: 'Home Clean Sheet', p: cleanSheet.homeCS }, { key: 'Home Concedes', p: 1 - cleanSheet.homeCS }]);
  const awayCSPick = pickBest([{ key: 'Away Clean Sheet', p: cleanSheet.awayCS }, { key: 'Away Concedes', p: 1 - cleanSheet.awayCS }]);

  const winToNil = winToNilProbs(grid);
  const winToNilPick = pickBest([{ key: 'Home Win to Nil', p: winToNil.homeToNil }, { key: 'Away Win to Nil', p: winToNil.awayToNil }, { key: 'Neither', p: winToNil.neither }]);

  const htFt = htFtProbs(lambdaHome, lambdaAway);
  const htFtEntries = Object.entries(htFt).map(([key, p]) => ({ key, p }));
  const bestHtFt = htFtEntries.reduce((best, g) => (g.p > best.p ? g : best), htFtEntries[0]);

  const markets = {
    '1X2': { pick: oneXTwo.key, confidence: applyConfidence(oneXTwo.p) },
    'Double Chance': { pick: doubleChance.key, confidence: applyConfidence(doubleChance.p) },
    'Over/Under 1.5': { pick: ou15.key, confidence: applyConfidence(ou15.p) },
    'Over/Under 2.5': { pick: ou25.key, confidence: applyConfidence(ou25.p) },
    'Over/Under 3.5': { pick: ou35.key, confidence: applyConfidence(ou35.p) },
    BTTS: { pick: btts.key, confidence: applyConfidence(btts.p) },
    'Odd/Even Goals': { pick: oddEvenPick.key, confidence: applyConfidence(oddEvenPick.p) },
    Multigoals: { pick: `${bestMultiGoal.range} Goals`, confidence: applyConfidence(bestMultiGoal.p), alternatives: multiGoals.map((g) => ({ range: g.range, probability: round1(g.p * 100) })) },
    'Home Clean Sheet': { pick: homeCSPick.key, confidence: applyConfidence(homeCSPick.p) },
    'Away Clean Sheet': { pick: awayCSPick.key, confidence: applyConfidence(awayCSPick.p) },
    'Win to Nil': { pick: winToNilPick.key, confidence: applyConfidence(winToNilPick.p) },
    'HT/FT': { pick: bestHtFt.key, confidence: applyConfidence(bestHtFt.p) },
    'Correct Score': { pick: correctScores[0] ? correctScores[0].score : null, confidence: correctScores[0] ? correctScores[0].probability : 0, alternatives: correctScores }
  };

  // Correct Score and HT/FT are excluded from topPick selection: both are inherently fragmented
  // multi-way markets (many similar-probability outcomes) not meant to be "the" headline pick,
  // and HT/FT can't be auto-verified since we don't capture half-time scores anywhere.
  const topMarketEntry = Object.entries(markets)
    .filter(([key]) => key !== 'Correct Score' && key !== 'HT/FT')
    .reduce((best, [key, m]) => (m.confidence > best.confidence ? { market: key, ...m } : best), { market: null, confidence: -1 });

  const sourceLabels = {
    recentForm: 'Recent Form (football-data.org)',
    h2h: 'H2H Record',
    homeAwayStrength: 'Home/Away Splits',
    injuries: injuries.source === 'apiFootball' ? 'Injuries (API-Football)' : 'Injury News Signal (NewsAPI)',
    oddsConsensus: 'Odds Consensus (Betika/OddsAPI)',
    xg: 'xG (Sportmonks)',
    squadDepth: 'Squad Depth (API-Football)',
    managerRecord: 'Manager Tenure (API-Football)',
    weather: `Weather (${weather.source || 'unavailable'})`,
    restDays: 'Rest Days & Fatigue',
    communityConsensus: 'Community Consensus (Reddit/News)'
  };
  const sourcesSummary = Object.entries(factors).filter(([, f]) => f.dataAvailable).map(([name]) => sourceLabels[name]).join(', ') || 'Baseline model only';

  return {
    homeTeam, awayTeam, league,
    lambdaHome: round1(lambdaHome), lambdaAway: round1(lambdaAway),
    probsHDA, blendNote,
    markets,
    topPick: {
      market: topMarketEntry.market,
      prediction: topMarketEntry.pick,
      confidence: Math.max(0, topMarketEntry.confidence),
      publishable: topMarketEntry.confidence >= 70
    },
    factors,
    dataQuality: round1(dataQuality * 100),
    sourcesUsed: availableCount,
    sourcesSummary
  };
}

module.exports = {
  FACTOR_WEIGHTS,
  generateMatchPrediction,
  // exported for testing/tuning/backtesting — all pure functions, no network calls
  poissonPmf,
  scoreGrid,
  probsFromGrid,
  findTeamMatches,
  computeRecentForm,
  computeH2H,
  estimateLambdas
};
