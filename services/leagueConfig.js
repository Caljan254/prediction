const TIMEZONE = process.env.TIMEZONE || 'Africa/Nairobi';

// Matches the 8 target leagues from IMPLEMENTATION_PLAN.md
const LEAGUES = [
  { name: 'English Premier League', apiFootballId: 39, footballDataCode: 'PL', country: 'England', betikaAvailable: true },
  { name: 'Spanish La Liga', apiFootballId: 140, footballDataCode: 'PD', country: 'Spain', betikaAvailable: true },
  { name: 'Italian Serie A', apiFootballId: 135, footballDataCode: 'SA', country: 'Italy', betikaAvailable: true },
  { name: 'German Bundesliga', apiFootballId: 78, footballDataCode: 'BL1', country: 'Germany', betikaAvailable: true },
  { name: 'French Ligue 1', apiFootballId: 61, footballDataCode: 'FL1', country: 'France', betikaAvailable: true },
  { name: 'UEFA Champions League', apiFootballId: 2, footballDataCode: 'CL', country: 'Europe', betikaAvailable: true },
  { name: 'UEFA Europa League', apiFootballId: 3, footballDataCode: null, country: 'Europe', betikaAvailable: true },
  { name: 'English Championship', apiFootballId: 40, footballDataCode: 'ELC', country: 'England', betikaAvailable: true }
];

// Betika (and other feeds) use shorter/different league names than our canonical ones.
const LEAGUE_NAME_ALIASES = {
  'Premier League': 'English Premier League',
  'LaLiga': 'Spanish La Liga',
  'La Liga': 'Spanish La Liga',
  // NOTE: 'Primera Division' is deliberately NOT aliased here — Betika already uses the
  // distinct name 'LaLiga' for Spain's top flight, so a generic 'Primera Division' alias would
  // misattribute Venezuela's, Uruguay's, etc. "Primera Division" leagues to Spanish La Liga.
  'Serie A': 'Italian Serie A',
  'Bundesliga': 'German Bundesliga',
  '1. Bundesliga': 'German Bundesliga',
  'Ligue 1': 'French Ligue 1',
  'Championship': 'English Championship',
  'Champions League': 'UEFA Champions League',
  'UCL': 'UEFA Champions League',
  'Europa League': 'UEFA Europa League',
  'UEL': 'UEFA Europa League'
};

// `country` is Betika's own `category` field (e.g. "England", "Italy") when available. Generic
// league names like "Premier League" or "Serie A" are used by many countries — without a country
// check, a Russian/Ukrainian/Israeli "Premier League" fixture would misattribute to our English
// Premier League data (wrong team names -> silently fails to match, but wastes lookups and,
// worse, muddies which matches we correctly consider "covered"). Skip the check when we don't
// have a country hint (older/legacy call sites) or for genuinely multi-nation competitions.
function getLeagueByName(name, country) {
  if (!name) return null;
  const trimmed = String(name).trim();
  const exact = LEAGUES.find((l) => l.name === trimmed);
  const match = exact || (LEAGUE_NAME_ALIASES[trimmed] ? LEAGUES.find((l) => l.name === LEAGUE_NAME_ALIASES[trimmed]) : null);
  if (!match) return null;
  if (country && match.country !== 'Europe' && match.country !== country) return null;
  return match;
}

function getLeagueByApiFootballId(id) {
  return LEAGUES.find((l) => l.apiFootballId === Number(id)) || null;
}

function getLeagueByFootballDataCode(code) {
  return LEAGUES.find((l) => l.footballDataCode === code) || null;
}

// Cross-API/Betika team name aliases -> canonical name used internally and as the
// key into config/stadiums.json. Extend as mismatches surface in real fixture data.
const TEAM_ALIASES = {
  'Man United': 'Manchester United',
  'Man Utd': 'Manchester United',
  'Man City': 'Manchester City',
  'Spurs': 'Tottenham Hotspur',
  'Tottenham': 'Tottenham Hotspur',
  'Wolves': 'Wolverhampton Wanderers',
  'Nottm Forest': 'Nottingham Forest',
  "Nott'm Forest": 'Nottingham Forest',
  'Newcastle': 'Newcastle United',
  'West Ham': 'West Ham United',
  'Brighton': 'Brighton & Hove Albion',
  'Leicester': 'Leicester City',
  'West Brom': 'West Bromwich Albion',
  'Sheffield Utd': 'Sheffield United',
  'Sheffield Wed': 'Sheffield Wednesday',
  'QPR': 'Queens Park Rangers',
  'Bayern': 'Bayern Munich',
  'Bayern München': 'Bayern Munich',
  'FC Bayern Munich': 'Bayern Munich',
  'FC Bayern München': 'Bayern Munich',
  'Dortmund': 'Borussia Dortmund',
  'B. Dortmund': 'Borussia Dortmund',
  'BVB': 'Borussia Dortmund',
  'Leverkusen': 'Bayer Leverkusen',
  'Bayer 04 Leverkusen': 'Bayer Leverkusen',
  "M'gladbach": 'Borussia Monchengladbach',
  'Borussia M.Gladbach': 'Borussia Monchengladbach',
  'RB Leipzig': 'RB Leipzig',
  'FC Union Berlin': 'Union Berlin',
  'SC Freiburg': 'Freiburg',
  'VfL Wolfsburg': 'Wolfsburg',
  '1. FSV Mainz 05': 'Mainz 05',
  'Werder': 'Werder Bremen',
  'FC Augsburg': 'Augsburg',
  'Stuttgart': 'VfB Stuttgart',
  'TSG Hoffenheim': 'Hoffenheim',
  'VfL Bochum': 'Bochum',
  '1. FC Koln': 'FC Koln',
  'Koeln': 'FC Koln',
  'Real Madrid CF': 'Real Madrid',
  'FC Barcelona': 'Barcelona',
  'Atletico Madrid': 'Atletico Madrid',
  'Atlético Madrid': 'Atletico Madrid',
  'Atletico de Madrid': 'Atletico Madrid',
  'Real Sociedad de Futbol': 'Real Sociedad',
  'Athletic Club': 'Athletic Bilbao',
  'Villarreal CF': 'Villarreal',
  'Valencia CF': 'Valencia',
  'Celta de Vigo': 'Celta Vigo',
  'CA Osasuna': 'Osasuna',
  'Getafe CF': 'Getafe',
  'Rayo Vallecano de Madrid': 'Rayo Vallecano',
  'RCD Mallorca': 'Mallorca',
  'UD Las Palmas': 'Las Palmas',
  'Deportivo Alaves': 'Alaves',
  'RCD Espanyol': 'Espanyol',
  'CD Leganes': 'Leganes',
  'Real Valladolid CF': 'Real Valladolid',
  'Inter': 'Inter Milan',
  'Internazionale': 'Inter Milan',
  'FC Internazionale Milano': 'Inter Milan',
  'AC Milan': 'Milan',
  'Juventus FC': 'Juventus',
  'Juve': 'Juventus',
  'Napoli': 'Napoli',
  'SSC Napoli': 'Napoli',
  'AS Roma': 'Roma',
  'SS Lazio': 'Lazio',
  'Atalanta BC': 'Atalanta',
  'ACF Fiorentina': 'Fiorentina',
  'Bologna FC 1909': 'Bologna',
  'Torino FC': 'Torino',
  'Udinese Calcio': 'Udinese',
  'US Sassuolo': 'Sassuolo',
  'Genoa CFC': 'Genoa',
  'UC Sampdoria': 'Sampdoria',
  'Cagliari Calcio': 'Cagliari',
  'Empoli FC': 'Empoli',
  'Hellas Verona FC': 'Hellas Verona',
  'US Lecce': 'Lecce',
  'AC Monza': 'Monza',
  'US Salernitana 1919': 'Salernitana',
  'Frosinone Calcio': 'Frosinone',
  'Parma Calcio 1913': 'Parma',
  'Como 1907': 'Como',
  'Venezia FC': 'Venezia',
  'US Cremonese': 'Cremonese',
  'PSG': 'Paris Saint-Germain',
  'Paris SG': 'Paris Saint-Germain',
  'Paris Saint Germain': 'Paris Saint-Germain',
  'Olympique Marseille': 'Marseille',
  'Olympique de Marseille': 'Marseille',
  'OM': 'Marseille',
  'Olympique Lyonnais': 'Lyon',
  'OL': 'Lyon',
  'AS Monaco': 'Monaco',
  'LOSC Lille': 'Lille',
  'Lille OSC': 'Lille',
  'Stade Rennais': 'Rennes',
  'Stade Rennais FC': 'Rennes',
  'OGC Nice': 'Nice',
  'RC Lens': 'Lens',
  'RC Strasbourg': 'Strasbourg',
  'RC Strasbourg Alsace': 'Strasbourg',
  'Toulouse FC': 'Toulouse',
  'FC Nantes': 'Nantes',
  'Montpellier HSC': 'Montpellier',
  'Stade de Reims': 'Reims',
  'Stade Brestois': 'Brest',
  'Stade Brestois 29': 'Brest',
  'Le Havre AC': 'Le Havre',
  'FC Metz': 'Metz',
  'Angers SCO': 'Angers',
  'AJ Auxerre': 'Auxerre',
  'AS Saint-Etienne': 'Saint-Etienne',
  'ASSE': 'Saint-Etienne',
  'Ajax Amsterdam': 'Ajax',
  'AFC Ajax': 'Ajax',
  'PSV': 'PSV Eindhoven',
  'FC Porto': 'Porto',
  'SL Benfica': 'Benfica',
  'Sporting Lisbon': 'Sporting CP',
  'Sporting Clube de Portugal': 'Sporting CP',
  'Celtic FC': 'Celtic',
  'Rangers FC': 'Rangers',
  'Galatasaray SK': 'Galatasaray',
  'Fenerbahce SK': 'Fenerbahce',
  'Besiktas JK': 'Besiktas',
  'Club Brugge KV': 'Club Brugge',
  'RSC Anderlecht': 'Anderlecht'
};

function normalizeTeamName(name) {
  if (!name) return name;
  const trimmed = String(name).trim();
  return TEAM_ALIASES[trimmed] || trimmed;
}

// Generic loose matcher for cross-API name comparison: strips common club suffixes/prefixes
// (football-data.org returns "Arsenal FC", "Brighton & Hove Albion FC", etc.) and diacritics,
// so we don't need an exhaustive alias entry for every "X FC" / "1. X" variant of every club.
const CLUB_TOKENS = new Set(['fc', 'afc', 'cf', 'sc', 'ac', 'ssc', 'ssd', 'bk', 'if', 'sk', 'cd', 'ud', 'rc', 'ss', '1', 'fk', 'sv', 'vfl', 'vfb', 'tsg', 'sg', 'ka', 'real', 'club', 'de', 'the']);

function cleanForMatch(name) {
  if (!name) return '';
  const canonical = normalizeTeamName(name);
  const ascii = canonical.normalize('NFD').replace(/[̀-ͯ]/g, '');
  const words = ascii.toLowerCase().replace(/[.']/g, '').split(/\s+/).filter((w) => w && !CLUB_TOKENS.has(w));
  return words.join(' ').trim();
}

function teamNamesMatch(a, b) {
  const ca = cleanForMatch(a);
  const cb = cleanForMatch(b);
  if (!ca || !cb) return false;
  if (ca === cb) return true;

  // Word-set comparison (not a raw substring check): every word of the shorter cleaned name
  // must appear in the longer one. This handles names with interspersed extra words, e.g.
  // football-data.org's "Real Racing Club de Santander" vs our "Racing Santander". A plain
  // `.includes()` on the raw strings was tried first but wrongly matched "Milan" inside "Inter
  // Milan" against "AC Milan" — two different clubs sharing one word. Requiring at least 2
  // overlapping words blocks that single-word false positive while single-word abbreviations
  // that really are the same club (Brighton, Newcastle, Wolves, ...) are already resolved via
  // TEAM_ALIASES before reaching here, so they hit the exact-match check above instead.
  const wordsA = ca.split(' ').filter(Boolean);
  const wordsB = cb.split(' ').filter(Boolean);
  const [shorter, longer] = wordsA.length <= wordsB.length ? [wordsA, wordsB] : [wordsB, wordsA];
  if (shorter.length < 2) return false;
  const longerSet = new Set(longer);
  return shorter.every((w) => longerSet.has(w));
}

module.exports = {
  TIMEZONE,
  LEAGUES,
  getLeagueByName,
  getLeagueByApiFootballId,
  getLeagueByFootballDataCode,
  normalizeTeamName,
  teamNamesMatch,
  TEAM_ALIASES
};
