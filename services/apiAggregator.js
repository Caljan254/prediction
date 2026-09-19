const { apiKeys } = require('../config/apiKeys');

// Conservative estimates of each free-tier limit (see IMPLEMENTATION_PLAN.md).
// These only throttle our own outgoing calls; tune against your actual dashboard limits.
const SOURCE_CONFIG = {
  apiFootball: { max: 100, windowMs: 24 * 60 * 60 * 1000 },
  footballDataOrg: { max: 10, windowMs: 60 * 1000 },
  theSportsDb: { max: 30, windowMs: 60 * 1000 },
  openLigaDb: { max: 60, windowMs: 60 * 1000 },
  betika: { max: 30, windowMs: 60 * 1000 },
  statsBomb: { max: 60, windowMs: 60 * 1000 },
  sportmonks: { max: 150, windowMs: 24 * 60 * 60 * 1000 },
  openMeteo: { max: 10000, windowMs: 24 * 60 * 60 * 1000 },
  weatherApi: { max: 1000000, windowMs: 30 * 24 * 60 * 60 * 1000 },
  oddsApi: { max: 500, windowMs: 30 * 24 * 60 * 60 * 1000 },
  reddit: { max: 60, windowMs: 60 * 1000 },
  newsApi: { max: 100, windowMs: 24 * 60 * 60 * 1000 }
};

const rateLimitState = new Map(); // source -> { count, windowStart }
const memoryCache = new Map(); // cacheKey -> { data, expiresAt }

let dbQuery = null;
function attachDatabase(db) {
  dbQuery = db;
}

function checkRateLimit(source) {
  const cfg = SOURCE_CONFIG[source];
  if (!cfg) return true;
  const now = Date.now();
  let state = rateLimitState.get(source);
  if (!state || now - state.windowStart > cfg.windowMs) {
    state = { count: 0, windowStart: now };
  }
  if (state.count >= cfg.max) {
    rateLimitState.set(source, state);
    return false;
  }
  state.count += 1;
  rateLimitState.set(source, state);
  return true;
}

async function persistCache(source, cacheKey, data, ttlMs) {
  memoryCache.set(cacheKey, { data, expiresAt: Date.now() + ttlMs });
  if (!dbQuery) return;
  try {
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    await dbQuery.run(
      `INSERT INTO api_cache (source, cache_key, response_json, expires_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(source, cache_key) DO UPDATE SET
         response_json = excluded.response_json,
         fetched_at = datetime('now'),
         expires_at = excluded.expires_at`,
      [source, cacheKey, JSON.stringify(data), expiresAt]
    );
  } catch (err) {
    console.warn(`[apiAggregator] Failed to persist cache for ${source}:`, err.message);
  }
}

async function readPersistedCache(source, cacheKey) {
  if (!dbQuery) return null;
  try {
    const row = await dbQuery.get(
      `SELECT response_json, expires_at FROM api_cache WHERE source = ? AND cache_key = ?`,
      [source, cacheKey]
    );
    if (!row) return null;
    return { data: JSON.parse(row.response_json), expiresAt: new Date(row.expires_at).getTime() };
  } catch (err) {
    return null;
  }
}

async function fetchWithCache({ source, cacheKey, url, options = {}, ttlMs = 5 * 60 * 1000, timeoutMs = 8000 }) {
  const memHit = memoryCache.get(cacheKey);
  if (memHit && memHit.expiresAt > Date.now()) {
    return { success: true, source, cached: true, data: memHit.data };
  }

  if (!checkRateLimit(source)) {
    const stale = memHit || (await readPersistedCache(source, cacheKey));
    if (stale) {
      return { success: true, source, cached: true, stale: true, rateLimited: true, data: stale.data };
    }
    return { success: false, source, error: 'Rate limit exceeded and no cached data available' };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const data = await response.json();
    await persistCache(source, cacheKey, data, ttlMs);
    return { success: true, source, cached: false, data };
  } catch (err) {
    console.warn(`[apiAggregator] ${source} fetch failed: ${err.message}`);
    const stale = memHit || (await readPersistedCache(source, cacheKey));
    if (stale) {
      return { success: true, source, cached: true, stale: true, data: stale.data, error: err.message };
    }
    return { success: false, source, error: err.message };
  }
}

// ---- Per-source fetchers ----

async function fetchApiFootball(endpoint, params = {}) {
  if (!apiKeys.apiFootball) {
    return { success: false, source: 'apiFootball', error: 'API_FOOTBALL_KEY not configured' };
  }
  const qs = new URLSearchParams(params).toString();
  const url = `https://v3.football.api-sports.io/${endpoint}${qs ? `?${qs}` : ''}`;
  return fetchWithCache({
    source: 'apiFootball',
    cacheKey: `apiFootball:${endpoint}:${qs}`,
    url,
    options: { headers: { 'x-apisports-key': apiKeys.apiFootball } },
    ttlMs: 10 * 60 * 1000
  });
}

async function fetchFootballDataOrg(endpoint, params = {}) {
  if (!apiKeys.footballDataOrg) {
    return { success: false, source: 'footballDataOrg', error: 'FOOTBALL_DATA_ORG_KEY not configured' };
  }
  const qs = new URLSearchParams(params).toString();
  const url = `https://api.football-data.org/v4/${endpoint}${qs ? `?${qs}` : ''}`;
  return fetchWithCache({
    source: 'footballDataOrg',
    cacheKey: `footballDataOrg:${endpoint}:${qs}`,
    url,
    options: { headers: { 'X-Auth-Token': apiKeys.footballDataOrg } },
    ttlMs: 5 * 60 * 1000
  });
}

async function fetchTheSportsDb(endpoint) {
  const url = `https://www.thesportsdb.com/api/v1/json/${apiKeys.theSportsDb}/${endpoint}`;
  return fetchWithCache({
    source: 'theSportsDb',
    cacheKey: `theSportsDb:${endpoint}`,
    url,
    ttlMs: 24 * 60 * 60 * 1000
  });
}

async function fetchOpenLigaDb(endpoint) {
  const url = `https://api.openligadb.de/${endpoint}`;
  return fetchWithCache({
    source: 'openLigaDb',
    cacheKey: `openLigaDb:${endpoint}`,
    url,
    ttlMs: 5 * 60 * 1000
  });
}

async function fetchBetika() {
  return fetchWithCache({
    source: 'betika',
    cacheKey: 'betika:today',
    url: apiKeys.betikaApiUrl,
    options: { headers: { Accept: 'application/json', 'User-Agent': 'CALJAN-Bot/1.0' } },
    ttlMs: 3 * 60 * 1000
  });
}

async function fetchStatsBombCompetitions() {
  const url = 'https://raw.githubusercontent.com/statsbomb/open-data/master/data/competitions.json';
  return fetchWithCache({
    source: 'statsBomb',
    cacheKey: 'statsBomb:competitions',
    url,
    ttlMs: 24 * 60 * 60 * 1000
  });
}

async function fetchSportmonks(endpoint, params = {}) {
  if (!apiKeys.sportmonks) {
    return { success: false, source: 'sportmonks', error: 'SPORTMONKS_KEY not configured' };
  }
  const qs = new URLSearchParams({ ...params, api_token: apiKeys.sportmonks }).toString();
  const url = `https://api.sportmonks.com/v3/football/${endpoint}?${qs}`;
  return fetchWithCache({
    source: 'sportmonks',
    cacheKey: `sportmonks:${endpoint}:${JSON.stringify(params)}`,
    url,
    ttlMs: 10 * 60 * 1000
  });
}

async function fetchOpenMeteo(lat, lon, date) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,precipitation,windspeed_10m&start_date=${date}&end_date=${date}&timezone=auto`;
  return fetchWithCache({
    source: 'openMeteo',
    cacheKey: `openMeteo:${lat},${lon},${date}`,
    url,
    ttlMs: 60 * 60 * 1000
  });
}

async function fetchWeatherApi(location, date) {
  if (!apiKeys.weatherApi) {
    return { success: false, source: 'weatherApi', error: 'WEATHER_API_KEY not configured' };
  }
  const url = `https://api.weatherapi.com/v1/forecast.json?key=${apiKeys.weatherApi}&q=${encodeURIComponent(location)}&dt=${date}`;
  return fetchWithCache({
    source: 'weatherApi',
    cacheKey: `weatherApi:${location}:${date}`,
    url,
    ttlMs: 60 * 60 * 1000
  });
}

async function fetchOddsApi(sportKey = 'soccer_epl', regions = 'uk,eu') {
  if (!apiKeys.oddsApi) {
    return { success: false, source: 'oddsApi', error: 'ODDS_API_KEY not configured' };
  }
  const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?apiKey=${apiKeys.oddsApi}&regions=${regions}&markets=h2h,totals`;
  return fetchWithCache({
    source: 'oddsApi',
    cacheKey: `oddsApi:${sportKey}:${regions}`,
    url,
    ttlMs: 15 * 60 * 1000
  });
}

// Reddit requires an OAuth client-credentials token before any API call.
let redditToken = null;
let redditTokenExpiry = 0;
async function getRedditToken() {
  if (redditToken && Date.now() < redditTokenExpiry) return redditToken;
  if (!apiKeys.reddit.clientId || !apiKeys.reddit.clientSecret) {
    throw new Error('REDDIT_CLIENT_ID/REDDIT_CLIENT_SECRET not configured');
  }
  const basicAuth = Buffer.from(`${apiKeys.reddit.clientId}:${apiKeys.reddit.clientSecret}`).toString('base64');
  const response = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'CALJAN-Bot/1.0'
    },
    body: 'grant_type=client_credentials'
  });
  if (!response.ok) throw new Error(`Reddit auth failed: HTTP ${response.status}`);
  const json = await response.json();
  redditToken = json.access_token;
  redditTokenExpiry = Date.now() + (json.expires_in - 60) * 1000;
  return redditToken;
}

async function fetchReddit(pathname) {
  try {
    const token = await getRedditToken();
    const url = `https://oauth.reddit.com${pathname}`;
    return await fetchWithCache({
      source: 'reddit',
      cacheKey: `reddit:${pathname}`,
      url,
      options: { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'CALJAN-Bot/1.0' } },
      ttlMs: 10 * 60 * 1000
    });
  } catch (err) {
    return { success: false, source: 'reddit', error: err.message };
  }
}

async function fetchNewsApi(query, params = {}) {
  if (!apiKeys.newsApi) {
    return { success: false, source: 'newsApi', error: 'NEWS_API_KEY not configured' };
  }
  const qs = new URLSearchParams({ q: query, language: 'en', sortBy: 'publishedAt', ...params }).toString();
  const url = `https://newsapi.org/v2/everything?${qs}`;
  return fetchWithCache({
    source: 'newsApi',
    cacheKey: `newsApi:${qs}`,
    url,
    options: { headers: { 'X-Api-Key': apiKeys.newsApi } },
    ttlMs: 30 * 60 * 1000
  });
}

module.exports = {
  attachDatabase,
  fetchApiFootball,
  fetchFootballDataOrg,
  fetchTheSportsDb,
  fetchOpenLigaDb,
  fetchBetika,
  fetchStatsBombCompetitions,
  fetchSportmonks,
  fetchOpenMeteo,
  fetchWeatherApi,
  fetchOddsApi,
  fetchReddit,
  fetchNewsApi
};
