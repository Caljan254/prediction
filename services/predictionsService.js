const predictionEngine = require('./predictionEngine');
const { toEatParts } = require('./dataNormalizer');
const { buildAnalysis } = require('./analysisPresenter');

// Runs the 11-factor engine over today's + tomorrow's Pending matches and persists results
// (matches, match_factors, weather_data, predictions_log). Shared by the
// /api/predictions/generate route and the 11:00 EAT scheduler job.
//
// Cap raised from an earlier 50 to 200: Betika lists 100-130+ fixtures a day, and the old cap
// meant most matches never got past the naive odds-only sync placeholder — every match deserves
// a real attempt at the full engine, even a low-data-quality one, rather than a permanent
// generic stand-in.
async function generateDailyPredictions(dbQuery, { limit = 200 } = {}) {
  const cappedLimit = Math.min(limit, 200);
  const todayEat = toEatParts(new Date()).date;
  const tomorrowEat = toEatParts(new Date(Date.now() + 24 * 60 * 60 * 1000)).date;

  const rows = await dbQuery.all(
    `SELECT * FROM matches WHERE status = 'Pending' AND match_date IN (?, ?) ORDER BY match_date ASC, match_time ASC LIMIT ?`,
    [todayEat, tomorrowEat, cappedLimit]
  );

  const results = [];
  for (const row of rows) {
    const matchTime = row.match_time || '19:45';
    const kickoffUtc = new Date(`${row.match_date}T${matchTime}:00+03:00`).toISOString();
    const betikaOdds = { home: row.odds_home, draw: row.odds_draw, away: row.odds_away };

    const prediction = await predictionEngine.generateMatchPrediction({
      homeTeam: row.home_team,
      awayTeam: row.away_team,
      league: row.competition_name,
      country: row.country,
      kickoffUtc,
      betikaOdds
    });

    await dbQuery.run(
      `UPDATE matches SET prediction = ?, prediction_type = ?, confidence = ?, sources_count = ?, sources_summary = ?, analysis_json = ?, updated_at = datetime('now') WHERE id = ?`,
      [
        prediction.topPick.prediction || row.prediction,
        prediction.topPick.market || row.prediction_type,
        Math.round(prediction.topPick.confidence) || row.confidence,
        prediction.sourcesUsed,
        prediction.sourcesSummary,
        JSON.stringify(buildAnalysis(prediction, betikaOdds)),
        row.id
      ]
    );

    for (const [name, weight] of Object.entries(predictionEngine.FACTOR_WEIGHTS)) {
      const f = prediction.factors[name];
      await dbQuery.run(
        `INSERT INTO match_factors (match_id, factor_name, factor_value, weight)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(match_id, factor_name) DO UPDATE SET
           factor_value = excluded.factor_value, weight = excluded.weight, computed_at = datetime('now')`,
        [String(row.match_id), name, JSON.stringify({ lean: f.lean, dataAvailable: f.dataAvailable }), weight]
      );
    }

    const weatherFactor = prediction.factors.weather;
    if (weatherFactor.dataAvailable && weatherFactor.stadium) {
      await dbQuery.run(
        `INSERT INTO weather_data (stadium_name, match_date, kickoff_hour, temperature_c, precipitation_mm, wind_kph, condition, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(stadium_name, match_date, kickoff_hour) DO UPDATE SET
           temperature_c = excluded.temperature_c, precipitation_mm = excluded.precipitation_mm,
           wind_kph = excluded.wind_kph, condition = excluded.condition, fetched_at = datetime('now')`,
        [weatherFactor.stadium.stadium, row.match_date, new Date(kickoffUtc).getUTCHours(), weatherFactor.temperatureC, weatherFactor.precipitationMm, weatherFactor.windKph, weatherFactor.condition, weatherFactor.source]
      );
    }

    for (const [marketName, m] of Object.entries(prediction.markets)) {
      if (!m.pick) continue;
      await dbQuery.run(
        `INSERT INTO predictions_log (match_id, market, prediction, confidence, factors_json) VALUES (?, ?, ?, ?, ?)`,
        [String(row.match_id), marketName, m.pick, Math.round(m.confidence), JSON.stringify({ dataQuality: prediction.dataQuality })]
      );
    }

    results.push({
      matchId: row.match_id,
      homeTeam: row.home_team,
      awayTeam: row.away_team,
      topPick: prediction.topPick,
      dataQuality: prediction.dataQuality,
      sourcesUsed: prediction.sourcesUsed,
      sourcesSummary: prediction.sourcesSummary
    });
  }

  const publishable = results.filter((r) => r.topPick.publishable);
  return { success: true, processed: results.length, publishableCount: publishable.length, results };
}

module.exports = { generateDailyPredictions };
