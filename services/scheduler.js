const cron = require('node-cron');
const { syncBetikaFixtures } = require('./syncService');
const { generateDailyPredictions } = require('./predictionsService');
const { checkLiveResults } = require('./resultsChecker');
const { computeDailyAccuracy } = require('./accuracyReport');
const { toEatParts } = require('./dataNormalizer');
const { TIMEZONE } = require('./leagueConfig');

const CRON_TZ = { timezone: 'Africa/Nairobi' };

// Design note: IMPLEMENTATION_PLAN.md's daily schedule lists separate 07:00/08:00/09:00/10:00/10:30
// "pre-warm" steps (form, injuries, odds, weather, sentiment). Those are deliberately NOT
// implemented as standalone cron jobs here — apiAggregator's cache TTLs for those sources
// (3-15 min for football-data/betika/odds, up to 30 min for news/sportmonks) are all shorter
// than the gap to the 11:00 generation run, so pre-warming that early would just burn API quota
// fetching data that'd be stale again by generation time. generateDailyPredictions already
// fetches everything it needs on demand.

function guardOverlap(name, fn) {
  let running = false;
  return async () => {
    if (running) {
      console.warn(`[scheduler] ${name} still running, skipping this tick`);
      return;
    }
    running = true;
    try {
      await fn();
    } catch (err) {
      console.error(`[scheduler] ${name} failed:`, err.message);
    } finally {
      running = false;
    }
  };
}

function startScheduler(dbQuery) {
  // 06:00 EAT — fetch today's + tomorrow's fixtures from Betika
  cron.schedule('0 6 * * *', guardOverlap('fetchFixtures', async () => {
    const result = await syncBetikaFixtures(dbQuery);
    console.log(`[scheduler] 06:00 fetchFixtures: ${result.message} (source: ${result.source})`);
  }), CRON_TZ);

  // 11:00 EAT — run the 11-factor engine over today's + tomorrow's Pending matches.
  // No limit override — uses generateDailyPredictions' own default (200), enough to cover a
  // full day's Betika fixtures rather than leaving most of them on the naive sync placeholder.
  cron.schedule('0 11 * * *', guardOverlap('generatePredictions', async () => {
    const result = await generateDailyPredictions(dbQuery);
    console.log(`[scheduler] 11:00 generatePredictions: processed ${result.processed}, publishable ${result.publishableCount}`);
  }), CRON_TZ);

  // Every 5 minutes — check for live/finished matches (real data only, for leagues football-data.org covers)
  cron.schedule('*/5 * * * *', guardOverlap('checkLiveResults', async () => {
    const result = await checkLiveResults(dbQuery);
    if (result.updated > 0) console.log(`[scheduler] live check: ${result.updated}/${result.checked} matches updated`);
  }), CRON_TZ);

  // 01:00 EAT (the day after) — roll up the previous day's settled matches into a hit-rate report
  cron.schedule('0 1 * * *', guardOverlap('dailyAccuracy', async () => {
    const yesterday = toEatParts(new Date(Date.now() - 24 * 60 * 60 * 1000)).date;
    const report = await computeDailyAccuracy(dbQuery, yesterday);
    console.log(`[scheduler] 01:00 dailyAccuracy for ${yesterday}: ${report.won}/${report.total} (${report.hitRate ?? 'n/a'}%)`);
  }), CRON_TZ);

  console.log(`[scheduler] Started — fixtures@06:00, predictions@11:00, live-check every 5min, accuracy@01:00 (${TIMEZONE})`);
}

module.exports = { startScheduler };
