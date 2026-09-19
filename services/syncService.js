const fs = require('fs');
const path = require('path');
const { toEatParts } = require('./dataNormalizer');

const DEFAULT_BETIKA_URL = process.env.BETIKA_API_URL || 'https://api.betika.com/v1/uo/matches?tab=today&sub_type_id=1,186&sport_id=14&tag_id=1&sort_id=1&period_id=-1&esports=false';
const DEFAULT_BETIKA_BBALL_URL = 'https://api.betika.com/v1/uo/matches?tab=today&sport_id=30&sub_type_id=1,225';

// Pulls today's fixtures+odds from Betika (both Football and Basketball Total Incl. Overtime)
async function syncBetikaFixtures(dbQuery, betikaApiUrl = DEFAULT_BETIKA_URL) {
  let combinedMatches = [];
  let source = 'live_api';

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const [fbRes, bbRes] = await Promise.allSettled([
      fetch(betikaApiUrl, {
        headers: { Accept: 'application/json', 'User-Agent': 'CALJAN-Bot/1.0' },
        signal: controller.signal
      }),
      fetch(DEFAULT_BETIKA_BBALL_URL, {
        headers: { Accept: 'application/json', 'User-Agent': 'CALJAN-Bot/1.0' },
        signal: controller.signal
      })
    ]);
    clearTimeout(timeoutId);

    if (fbRes.status === 'fulfilled' && fbRes.value.ok) {
      const fbData = await fbRes.value.json();
      if (fbData && Array.isArray(fbData.data)) combinedMatches.push(...fbData.data);
    }
    if (bbRes.status === 'fulfilled' && bbRes.value.ok) {
      const bbData = await bbRes.value.json();
      if (bbData && Array.isArray(bbData.data)) combinedMatches.push(...bbData.data);
    }
  } catch (fetchErr) {
    console.warn('Betika live API request timed out/failed, falling back to betika_live.json snapshot:', fetchErr.message);
  }

  const snapshotPath = path.join(__dirname, '..', 'betika_live.json');
  let snapshotMatches = [];
  if (fs.existsSync(snapshotPath)) {
    try {
      const snap = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
      snapshotMatches = Array.isArray(snap.data) ? snap.data : (Array.isArray(snap) ? snap : []);
    } catch (e) {}
  }

  if (combinedMatches.length === 0) {
    combinedMatches = snapshotMatches;
    source = 'local_snapshot';
  } else {
    // Preserve games in snapshot that kicked off or finished earlier today
    const liveIds = new Set(combinedMatches.map(m => String(m.game_id || m.match_id || '')));
    const retained = snapshotMatches.filter(m => !liveIds.has(String(m.game_id || m.match_id || '')));
    combinedMatches = [...combinedMatches, ...retained];

    // Save updated combined snapshot
    try {
      fs.writeFileSync(snapshotPath, JSON.stringify({
        success: true,
        count: combinedMatches.length,
        timestamp: new Date().toISOString(),
        data: combinedMatches
      }, null, 2));
    } catch (e) {}
  }

  if (!Array.isArray(combinedMatches) || combinedMatches.length === 0) {
    throw new Error('Could not load Betika fixtures feed');
  }

  let syncedCount = 0;
  for (const match of combinedMatches) {
    if (!match.home_team || !match.away_team) continue;

    const isBball = String(match.sport_id) === '30' || 
                    match.sport_name === 'Basketball' || 
                    (match.category && match.category.toLowerCase().includes('basketball')) ||
                    (match.competition_name && match.competition_name.toLowerCase().includes('basketball'));

    const gameId = String(match.game_id || '');
    const matchId = String(match.match_id || '');
    const homeTeam = match.home_team.trim();
    const awayTeam = match.away_team.trim();
    const cleanComp = (match.competition_name || (isBball ? 'Basketball' : 'Soccer')).replace(/^🏀\s*/, '');
    const league = (isBball ? '🏀 ' : '') + cleanComp;
    const country = match.category || (isBball ? 'Basketball' : null);

    const eatNow = toEatParts(new Date());
    const startTime = match.start_time || `${eatNow.date} ${eatNow.time}:00`;
    const [mDate, mTimeFull] = startTime.split(' ');
    const mTime = mTimeFull ? mTimeFull.slice(0, 5) : '19:45';

    const oddHome = parseFloat(match.home_odd) || (isBball ? 1.85 : 1.85);
    const oddDraw = parseFloat(match.neutral_odd) || (isBball ? 15.0 : 3.40);
    const oddAway = parseFloat(match.away_odd) || (isBball ? 1.85 : 3.10);

    let prediction = '1X';
    let confidence = 75;
    let sourcesSummary = 'CALJAN AI';

    if (isBball) {
      sourcesSummary = 'CALJAN BasketAI, Total (Incl. OT)';
      let totalMarket = null;
      if (Array.isArray(match.odds)) {
        totalMarket = match.odds.find(o => String(o.sub_type_id) === '225' || (o.name && o.name.toUpperCase().includes('TOTAL')));
      }
      const linesMap = {};
      if (totalMarket && Array.isArray(totalMarket.odds)) {
        totalMarket.odds.forEach(o => {
          const totalVal = o.parsed_special_bet_value?.total || (o.display ? o.display.replace(/[^0-9.]/g, '') : null);
          if (!totalVal) return;
          if (!linesMap[totalVal]) linesMap[totalVal] = {};
          const disp = (o.display || '').toUpperCase();
          const val = parseFloat(o.odd_value) || 1.85;
          if (disp.includes('OVER')) linesMap[totalVal].over = val;
          if (disp.includes('UNDER')) linesMap[totalVal].under = val;
        });
      }

      let bestDiff = 999;
      let mainLine = null;
      for (const line in linesMap) {
        const pair = linesMap[line];
        if (pair.over && pair.under) {
          const diff = Math.abs(pair.over - pair.under);
          if (diff < bestDiff) {
            bestDiff = diff;
            mainLine = line;
          }
        }
      }
      if (!mainLine && Object.keys(linesMap).length > 0) mainLine = Object.keys(linesMap)[0];

      if (mainLine && linesMap[mainLine]) {
        const pair = linesMap[mainLine];
        const overOdd = pair.over || 1.85;
        const underOdd = pair.under || 1.85;
        if (overOdd <= underOdd) {
          prediction = `Over ${mainLine}`;
          confidence = overOdd <= 1.75 ? 85 : 75;
        } else {
          prediction = `Under ${mainLine}`;
          confidence = underOdd <= 1.75 ? 85 : 75;
        }
      } else {
        prediction = 'Over 165.5';
        confidence = 72;
      }
    } else {
      sourcesSummary = 'CALJAN Football AI, Odds Consensus';
      if (oddHome < 1.45) { prediction = 'Home Win'; confidence = 85; }
      else if (oddAway < 1.65) { prediction = 'Away Win'; confidence = 80; }
      else if (oddHome < 2.00) { prediction = '1X'; confidence = 75; }
      else if (oddAway < 2.10) { prediction = 'X2'; confidence = 72; }
      else if (oddDraw < 3.10) { prediction = 'Draw'; confidence = 65; }
      else { prediction = 'Over 2.5'; confidence = 70; }
    }

    const predType = isBball ? 'Total (Incl. Overtime)' : '1X2';

    await dbQuery.run(`
      INSERT INTO matches (
        game_id, match_id, home_team, away_team, competition_name, country,
        start_time, match_date, match_time, status, result,
        odds_home, odds_draw, odds_away, prediction, prediction_type, confidence,
        sources_summary
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', '—', ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(game_id, match_id) DO UPDATE SET
        odds_home = excluded.odds_home,
        odds_draw = excluded.odds_draw,
        odds_away = excluded.odds_away,
        country = excluded.country,
        prediction_type = excluded.prediction_type,
        updated_at = datetime('now')
    `, [gameId, matchId, homeTeam, awayTeam, league, country, startTime, mDate, mTime, oddHome, oddDraw, oddAway, prediction, predType, confidence, sourcesSummary]);

    syncedCount++;
  }

  return { success: true, source, syncedCount, message: `Successfully synchronized ${syncedCount} real Betika matches (Football & Basketball).` };
}

module.exports = { syncBetikaFixtures };
