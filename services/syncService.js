const fs = require('fs');
const path = require('path');
const { toEatParts } = require('./dataNormalizer');

const DEFAULT_BETIKA_URL = process.env.BETIKA_API_URL || 'https://api.betika.com/v1/uo/matches?tab=today&sport_id=14';

// Pulls today's fixtures+odds from Betika (falling back to the local snapshot if the live
// API is unreachable/geo-blocked) and upserts them into the matches table. Shared by the
// /api/sync route and the 06:00 EAT scheduler job so both paths stay in sync.
async function syncBetikaFixtures(dbQuery, betikaApiUrl = DEFAULT_BETIKA_URL) {
  let betikaData = null;
  let source = 'live_api';

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);
    const response = await fetch(betikaApiUrl, {
      headers: { Accept: 'application/json', 'User-Agent': 'CALJAN-Bot/1.0' },
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (response.ok) betikaData = await response.json();
  } catch (fetchErr) {
    console.warn('Betika live API request timed out/failed, falling back to betika_live.json snapshot:', fetchErr.message);
  }

  if (!betikaData || !betikaData.data) {
    const snapshotPath = path.join(__dirname, '..', 'betika_live.json');
    if (fs.existsSync(snapshotPath)) {
      betikaData = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
      source = 'local_snapshot';
    }
  }

  if (!betikaData || !Array.isArray(betikaData.data)) {
    throw new Error('Could not load Betika fixtures feed');
  }

  let syncedCount = 0;
  for (const match of betikaData.data) {
    if (!match.home_team || !match.away_team) continue;

    const gameId = String(match.game_id || '');
    const matchId = String(match.match_id || '');
    const homeTeam = match.home_team.trim();
    const awayTeam = match.away_team.trim();
    const league = match.competition_name || 'Soccer';
    const country = match.category || null;
    // Fallback format must match Betika's own "YYYY-MM-DD HH:mm:ss" (space-separated, EAT wall
    // clock) since it gets split on the space below — a bare ISO string here would both use the
    // wrong timezone and break that split (ISO uses "T", not a space).
    const eatNow = toEatParts(new Date());
    const startTime = match.start_time || `${eatNow.date} ${eatNow.time}:00`;
    const [mDate, mTimeFull] = startTime.split(' ');
    const mTime = mTimeFull ? mTimeFull.slice(0, 5) : '19:45';

    const oddHome = parseFloat(match.home_odd) || 1.85;
    const oddDraw = parseFloat(match.neutral_odd) || 3.40;
    const oddAway = parseFloat(match.away_odd) || 3.10;

    // Naive placeholder pick from raw odds alone, clearly labeled as such (not a real named
    // source — "Forebet" was never actually consulted) — superseded by predictionsService's
    // real 11-factor engine once /api/predictions/generate (or the 11:00 EAT job) runs on this
    // fixture. That job is sized to cover a full day's fixtures, so this placeholder should be
    // short-lived in practice.
    let prediction = '1X';
    let confidence = 75;
    if (oddHome < 1.45) { prediction = 'Home Win'; confidence = 85; }
    else if (oddAway < 1.65) { prediction = 'Away Win'; confidence = 80; }
    else if (oddHome < 2.00) { prediction = '1X'; confidence = 75; }
    else if (oddAway < 2.10) { prediction = 'X2'; confidence = 72; }
    else if (oddDraw < 3.10) { prediction = 'Draw'; confidence = 65; }
    else { prediction = 'Over 2.5'; confidence = 70; }

    await dbQuery.run(`
      INSERT INTO matches (
        game_id, match_id, home_team, away_team, competition_name, country,
        start_time, match_date, match_time, status, result,
        odds_home, odds_draw, odds_away, prediction, confidence,
        sources_summary
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', '—', ?, ?, ?, ?, ?, 'Odds-only heuristic (awaiting full analysis)')
      ON CONFLICT(game_id, match_id) DO UPDATE SET
        odds_home = excluded.odds_home,
        odds_draw = excluded.odds_draw,
        odds_away = excluded.odds_away,
        country = excluded.country,
        updated_at = datetime('now')
    `, [gameId, matchId, homeTeam, awayTeam, league, country, startTime, mDate, mTime, oddHome, oddDraw, oddAway, prediction, confidence]);

    syncedCount++;
  }

  return { success: true, source, syncedCount, message: `Successfully synchronized ${syncedCount} real Betika matches.` };
}

module.exports = { syncBetikaFixtures };
