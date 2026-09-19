// Rolls up a day's settled matches into a hit-rate report and stores it in system_settings
// (keyed per date) so the dashboard can show historical accuracy without re-scanning matches.
async function computeDailyAccuracy(dbQuery, dateEat) {
  const rows = await dbQuery.all(
    `SELECT status, prediction_type, confidence FROM matches WHERE match_date = ? AND status IN ('Won', 'Lost')`,
    [dateEat]
  );

  const total = rows.length;
  const won = rows.filter((r) => r.status === 'Won').length;
  const hitRate = total > 0 ? Math.round((won / total) * 1000) / 10 : null;

  const byMarket = {};
  for (const r of rows) {
    const key = r.prediction_type || 'Unknown';
    if (!byMarket[key]) byMarket[key] = { total: 0, won: 0 };
    byMarket[key].total += 1;
    if (r.status === 'Won') byMarket[key].won += 1;
  }

  const report = { date: dateEat, total, won, lost: total - won, hitRate, byMarket, generatedAt: new Date().toISOString() };

  await dbQuery.run(
    `INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?)
     ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = datetime('now')`,
    [`accuracy_report_${dateEat}`, JSON.stringify(report)]
  );

  return report;
}

module.exports = { computeDailyAccuracy };
