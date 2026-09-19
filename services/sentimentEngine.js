const apiAggregator = require('./apiAggregator');
const { apiKeys } = require('../config/apiKeys');
const { normalizeNewsArticles, normalizeRedditPosts } = require('./dataNormalizer');

const INJURY_KEYWORDS = ['injury', 'injured', 'doubt', 'doubtful', 'ruled out', 'sidelined', 'fitness test', 'knock', 'strain', 'surgery', 'suspended', 'suspension'];
const POSITIVE_KEYWORDS = ['return', 'returns', 'boost', 'available again', 'fit again', 'back in training', 'recovered', 'in form', 'winning streak'];
const NEGATIVE_KEYWORDS = ['crisis', 'sacked', 'under pressure', 'poor form', 'winless', 'struggling', 'slump'];

function textOf(article) {
  return `${article.title} ${article.description}`.toLowerCase();
}

function countMatches(text, keywords) {
  return keywords.reduce((count, kw) => (text.includes(kw) ? count + 1 : count), 0);
}

// Scans recent news for a team: proxies for injury/suspension news and general form sentiment
// since we don't have API-Football's official injury endpoint wired up yet (needs API_FOOTBALL_KEY).
async function getTeamNewsSignal(teamName) {
  if (!apiKeys.newsApi) {
    return { dataAvailable: false, reason: 'NEWS_API_KEY not configured' };
  }

  const result = await apiAggregator.fetchNewsApi(`"${teamName}" football`, { pageSize: 20 });
  if (!result.success) {
    return { dataAvailable: false, reason: result.error };
  }

  const articles = normalizeNewsArticles(result.data).filter((a) => textOf(a).includes(teamName.toLowerCase()));
  if (articles.length === 0) {
    return { dataAvailable: false, reason: 'No recent articles mentioning team' };
  }

  let injuryFlags = 0;
  let positiveFlags = 0;
  let negativeFlags = 0;
  for (const a of articles) {
    const text = textOf(a);
    injuryFlags += countMatches(text, INJURY_KEYWORDS);
    positiveFlags += countMatches(text, POSITIVE_KEYWORDS);
    negativeFlags += countMatches(text, NEGATIVE_KEYWORDS);
  }

  // -1 (bad news dominant) .. +1 (good news dominant)
  const netSignal = positiveFlags - negativeFlags - injuryFlags * 0.5;
  const sentimentScore = Math.max(-1, Math.min(1, netSignal / Math.max(articles.length, 1)));

  return {
    dataAvailable: true,
    mentions: articles.length,
    injuryFlags,
    positiveFlags,
    negativeFlags,
    sentimentScore
  };
}

// Rough community-buzz proxy from a betting-focused subreddit: which team gets more
// (and more upvoted) mentions in recent hot posts around match day.
async function getRedditConsensus(homeTeam, awayTeam) {
  if (!apiKeys.reddit.clientId || !apiKeys.reddit.clientSecret) {
    return { dataAvailable: false, reason: 'Reddit credentials not configured' };
  }

  const result = await apiAggregator.fetchReddit('/r/soccerbetting/hot?limit=50');
  if (!result.success) {
    return { dataAvailable: false, reason: result.error };
  }

  const posts = normalizeRedditPosts(result.data);
  let homeWeight = 0;
  let awayWeight = 0;
  for (const p of posts) {
    const title = p.title.toLowerCase();
    const weight = 1 + Math.log10(Math.max(p.score, 1) + 1);
    if (title.includes(homeTeam.toLowerCase())) homeWeight += weight;
    if (title.includes(awayTeam.toLowerCase())) awayWeight += weight;
  }

  if (homeWeight === 0 && awayWeight === 0) {
    return { dataAvailable: false, reason: 'No mentions of either team found' };
  }

  const lean = (homeWeight - awayWeight) / Math.max(homeWeight + awayWeight, 1);
  return { dataAvailable: true, homeWeight, awayWeight, lean };
}

// Combines home/away news sentiment (proxy for injuries/morale) into one signed lean for that factor.
function combineInjurySentiment(homeSignal, awaySignal) {
  if (!homeSignal.dataAvailable && !awaySignal.dataAvailable) {
    return { lean: 0, dataAvailable: false };
  }
  const homeScore = homeSignal.dataAvailable ? homeSignal.sentimentScore : 0;
  const awayScore = awaySignal.dataAvailable ? awaySignal.sentimentScore : 0;
  // Home team having worse news than away team drags the lean toward away, and vice versa.
  const lean = Math.max(-1, Math.min(1, (homeScore - awayScore) / 2));
  return { lean, dataAvailable: true, homeScore, awayScore };
}

function combineCommunityConsensus(redditResult, homeSignal, awaySignal) {
  const leans = [];
  if (redditResult.dataAvailable) leans.push(redditResult.lean);
  // Fold general news sentiment in as a secondary community-consensus signal too.
  if (homeSignal.dataAvailable || awaySignal.dataAvailable) {
    leans.push((homeSignal.sentimentScore || 0) - (awaySignal.sentimentScore || 0));
  }
  if (leans.length === 0) return { lean: 0, dataAvailable: false };
  const avg = leans.reduce((a, b) => a + b, 0) / leans.length;
  return { lean: Math.max(-1, Math.min(1, avg)), dataAvailable: true, sourcesUsed: leans.length };
}

module.exports = { getTeamNewsSignal, getRedditConsensus, combineInjurySentiment, combineCommunityConsensus };
