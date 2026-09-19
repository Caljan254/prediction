require('dotenv').config();

const apiKeys = {
  apiFootball: process.env.API_FOOTBALL_KEY || '',
  footballDataOrg: process.env.FOOTBALL_DATA_ORG_KEY || '',
  sportmonks: process.env.SPORTMONKS_KEY || '',
  theSportsDb: '123',
  weatherApi: process.env.WEATHER_API_KEY || '',
  oddsApi: process.env.ODDS_API_KEY || '',
  newsApi: process.env.NEWS_API_KEY || '',
  reddit: {
    clientId: process.env.REDDIT_CLIENT_ID || '',
    clientSecret: process.env.REDDIT_CLIENT_SECRET || ''
  },
  betikaApiUrl: process.env.BETIKA_API_URL || 'https://api.betika.com/v1/uo/matches?tab=today&sport_id=14'
};

// Sources that need no registration are always "configured".
const NO_KEY_REQUIRED = new Set(['theSportsDb', 'openLigaDb', 'statsBomb', 'openMeteo', 'betika']);

function isConfigured(source) {
  if (NO_KEY_REQUIRED.has(source)) return true;
  if (source === 'reddit') return Boolean(apiKeys.reddit.clientId && apiKeys.reddit.clientSecret);
  return Boolean(apiKeys[source]);
}

function getStatusReport() {
  const sources = ['apiFootball', 'footballDataOrg', 'sportmonks', 'theSportsDb', 'openLigaDb', 'betika', 'statsBomb', 'openMeteo', 'weatherApi', 'oddsApi', 'reddit', 'newsApi'];
  return sources.map((source) => ({ source, configured: isConfigured(source) }));
}

module.exports = { apiKeys, isConfigured, getStatusReport };
