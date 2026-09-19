// Tracks REAL per-factor predictive power from our own accumulated live data (match_factors
// joined against settled matches). Starts sparse — this only gets meaningful once the system
// has been running for a while and has real decided matches to learn from. No fabricated data;
// small-sample results are reported honestly with their sample size so they aren't over-trusted.

async function analyzeFactorPredictivePower(dbQuery) {
  const rows = await dbQuery.all(`
    SELECT mf.factor_name, mf.factor_value, m.status, m.home_score, m.away_score, m.competition_name
    FROM match_factors mf
    JOIN matches m ON m.match_id = mf.match_id
    WHERE m.status IN ('Won', 'Lost') AND m.home_score IS NOT NULL AND m.away_score IS NOT NULL
  `);

  const byFactor = {};
  for (const r of rows) {
    let parsed;
    try { parsed = JSON.parse(r.factor_value); } catch (e) { continue; }
    if (!parsed.dataAvailable || typeof parsed.lean !== 'number' || parsed.lean === 0) continue;

    const outcomeSign = r.home_score > r.away_score ? 1 : (r.home_score < r.away_score ? -1 : 0);
    if (outcomeSign === 0) continue; // draws have no sign to agree/disagree with

    const leanSign = parsed.lean > 0 ? 1 : -1;
    if (!byFactor[r.factor_name]) byFactor[r.factor_name] = { total: 0, agree: 0 };
    byFactor[r.factor_name].total += 1;
    if (leanSign === outcomeSign) byFactor[r.factor_name].agree += 1;
  }

  const factors = Object.entries(byFactor)
    .map(([name, s]) => ({
      factor: name,
      sampleSize: s.total,
      agreementRate: Math.round((s.agree / s.total) * 1000) / 10,
      reliable: s.total >= 30
    }))
    .sort((a, b) => b.sampleSize - a.sampleSize);

  return {
    generatedAt: new Date().toISOString(),
    note: "Agreement rate = % of decided (non-draw) matches where this factor's lean pointed to the actual winner. `reliable: false` means under 30 observations — treat with caution.",
    factors
  };
}

module.exports = { analyzeFactorPredictivePower };
