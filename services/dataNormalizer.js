const { TIMEZONE, normalizeTeamName } = require('./leagueConfig');

// ---- Time helpers ----

function toEatParts(utcInput) {
  const d = utcInput instanceof Date ? utcInput : new Date(utcInput);
  if (Number.isNaN(d.getTime())) return { date: null, time: null, hour: null, iso: null };

  const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
  const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: false });

  const date = dateFmt.format(d); // YYYY-MM-DD
  const time = timeFmt.format(d); // HH:mm
  const hour = Number(time.split(':')[0]);

  return { date, time, hour, iso: `${date} ${time}` };
}

const STATUS_MAP = {
  // football-data.org
  SCHEDULED: 'SCHEDULED', TIMED: 'SCHEDULED', IN_PLAY: 'LIVE', PAUSED: 'LIVE',
  FINISHED: 'FINISHED', POSTPONED: 'POSTPONED', SUSPENDED: 'POSTPONED', CANCELLED: 'CANCELLED', AWARDED: 'FINISHED',
  // API-Football short codes
  NS: 'SCHEDULED', '1H': 'LIVE', HT: 'LIVE', '2H': 'LIVE', ET: 'LIVE', P: 'LIVE', LIVE: 'LIVE',
  FT: 'FINISHED', AET: 'FINISHED', PEN: 'FINISHED', PST: 'POSTPONED', CANC: 'CANCELLED', ABD: 'CANCELLED'
};

function normalizeStatus(raw) {
  if (!raw) return 'SCHEDULED';
  return STATUS_MAP[String(raw).toUpperCase()] || 'SCHEDULED';
}

// ---- Fixture normalizers (one shape per source -> common matchRecord) ----

function normalizeFootballDataMatch(m) {
  const kickoff = toEatParts(m.utcDate);
  return {
    source: 'footballDataOrg',
    externalId: String(m.id),
    league: m.competition ? m.competition.name : null,
    homeTeam: normalizeTeamName(m.homeTeam && (m.homeTeam.name || m.homeTeam.shortName)),
    awayTeam: normalizeTeamName(m.awayTeam && (m.awayTeam.name || m.awayTeam.shortName)),
    kickoffUtc: m.utcDate,
    kickoffDateEat: kickoff.date,
    kickoffTimeEat: kickoff.time,
    status: normalizeStatus(m.status),
    homeScore: m.score && m.score.fullTime ? m.score.fullTime.home : null,
    awayScore: m.score && m.score.fullTime ? m.score.fullTime.away : null
  };
}

function normalizeApiFootballFixture(f) {
  const kickoff = toEatParts(f.fixture.date);
  return {
    source: 'apiFootball',
    externalId: String(f.fixture.id),
    league: f.league ? f.league.name : null,
    homeTeam: normalizeTeamName(f.teams && f.teams.home && f.teams.home.name),
    awayTeam: normalizeTeamName(f.teams && f.teams.away && f.teams.away.name),
    kickoffUtc: f.fixture.date,
    kickoffDateEat: kickoff.date,
    kickoffTimeEat: kickoff.time,
    status: normalizeStatus(f.fixture.status && f.fixture.status.short),
    homeScore: f.goals ? f.goals.home : null,
    awayScore: f.goals ? f.goals.away : null
  };
}

function normalizeOpenLigaDbMatch(m) {
  const kickoff = toEatParts(m.matchDateTimeUTC);
  const finalResult = Array.isArray(m.matchResults) ? m.matchResults.find((r) => r.resultTypeID === 2) || m.matchResults[0] : null;
  return {
    source: 'openLigaDb',
    externalId: String(m.matchID),
    league: m.leagueName || null,
    homeTeam: normalizeTeamName(m.team1 && m.team1.teamName),
    awayTeam: normalizeTeamName(m.team2 && m.team2.teamName),
    kickoffUtc: m.matchDateTimeUTC,
    kickoffDateEat: kickoff.date,
    kickoffTimeEat: kickoff.time,
    status: m.matchIsFinished ? 'FINISHED' : 'SCHEDULED',
    homeScore: finalResult ? finalResult.pointsTeam1 : null,
    awayScore: finalResult ? finalResult.pointsTeam2 : null
  };
}

function normalizeBetikaMatch(m) {
  const startTime = m.start_time || null;
  const kickoff = startTime ? toEatParts(startTime.includes('T') ? startTime : startTime.replace(' ', 'T') + 'Z') : { date: null, time: null };
  return {
    source: 'betika',
    externalId: String(m.match_id || m.game_id || ''),
    league: m.competition_name || null,
    homeTeam: normalizeTeamName(m.home_team),
    awayTeam: normalizeTeamName(m.away_team),
    kickoffUtc: startTime,
    kickoffDateEat: kickoff.date,
    kickoffTimeEat: kickoff.time,
    status: 'SCHEDULED',
    odds: {
      home: parseFloat(m.home_odd) || null,
      draw: parseFloat(m.neutral_odd) || null,
      away: parseFloat(m.away_odd) || null
    }
  };
}

// ---- Odds normalizer (The Odds API) ----

function normalizeOddsApiEvent(event) {
  const bookmakers = Array.isArray(event.bookmakers) ? event.bookmakers : [];
  return bookmakers.map((bm) => {
    const h2h = bm.markets.find((mk) => mk.key === 'h2h');
    const totals = bm.markets.find((mk) => mk.key === 'totals');
    const out = { bookmaker: bm.title || bm.key, home: null, draw: null, away: null, over25: null, under25: null };
    if (h2h) {
      for (const o of h2h.outcomes) {
        if (o.name === event.home_team) out.home = o.price;
        else if (o.name === event.away_team) out.away = o.price;
        else if (o.name === 'Draw') out.draw = o.price;
      }
    }
    if (totals) {
      for (const o of totals.outcomes) {
        if (o.point === 2.5 && o.name === 'Over') out.over25 = o.price;
        if (o.point === 2.5 && o.name === 'Under') out.under25 = o.price;
      }
    }
    return out;
  });
}

// ---- Weather normalizers ----

function normalizeOpenMeteoHour(data, targetUtcIso) {
  if (!data || !data.hourly || !Array.isArray(data.hourly.time)) return null;
  const targetHour = targetUtcIso.slice(0, 13); // "YYYY-MM-DDTHH"
  const idx = data.hourly.time.findIndex((t) => t.slice(0, 13) === targetHour);
  if (idx === -1) return null;
  return {
    temperatureC: data.hourly.temperature_2m ? data.hourly.temperature_2m[idx] : null,
    precipitationMm: data.hourly.precipitation ? data.hourly.precipitation[idx] : null,
    windKph: data.hourly.windspeed_10m ? data.hourly.windspeed_10m[idx] : null,
    condition: null
  };
}

function normalizeWeatherApiDay(data) {
  const day = data && data.forecast && data.forecast.forecastday && data.forecast.forecastday[0] && data.forecast.forecastday[0].day;
  if (!day) return null;
  return {
    temperatureC: day.avgtemp_c,
    precipitationMm: day.totalprecip_mm,
    windKph: day.maxwind_kph,
    condition: day.condition ? day.condition.text : null,
    approximate: true // day-level average, not exact kickoff hour
  };
}

// ---- News / Reddit normalizers ----

function normalizeNewsArticles(newsApiResponse) {
  if (!newsApiResponse || !Array.isArray(newsApiResponse.articles)) return [];
  return newsApiResponse.articles.map((a) => ({
    title: a.title || '',
    description: a.description || '',
    source: a.source ? a.source.name : null,
    publishedAt: a.publishedAt || null,
    url: a.url || null
  }));
}

function normalizeRedditPosts(redditListing) {
  const children = redditListing && redditListing.data && Array.isArray(redditListing.data.children) ? redditListing.data.children : [];
  return children.map((c) => ({
    title: c.data.title || '',
    score: c.data.score || 0,
    numComments: c.data.num_comments || 0,
    createdUtc: c.data.created_utc || null,
    permalink: c.data.permalink || null
  }));
}

module.exports = {
  toEatParts,
  normalizeStatus,
  normalizeFootballDataMatch,
  normalizeApiFootballFixture,
  normalizeOpenLigaDbMatch,
  normalizeBetikaMatch,
  normalizeOddsApiEvent,
  normalizeOpenMeteoHour,
  normalizeWeatherApiDay,
  normalizeNewsArticles,
  normalizeRedditPosts
};
