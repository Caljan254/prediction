# 🧠 CALJAN Prediction Engine — Implementation Plan

> **System Date:** September 19, 2026 | **Timezone:** EAT (UTC+3) | **Status:** Active Development
> 
> All data must be **LIVE and real-time** — no hardcoded fixtures, no static seed data.
> The system pulls fresh data from 12 APIs every cycle and predicts matches happening TODAY and TOMORROW.

---

## 🔧 Post-Phase-5 Correctness Pass (real bugs found & fixed)

A round of user-reported issues turned up several genuine bugs, not just missing coverage:

1. **Naive "CALJAN AI, Forebet" placeholder lingering on real matches** — `services/predictionsService.js`'s generation cap was hard-limited to 50 matches while Betika lists 100-130+/day, so most matches never got past the sync-time placeholder. Raised the cap to 200 (`generateDailyPredictions`), fixed the route handler and scheduler call that were silently re-capping it back to 15/50, and renamed the placeholder itself from a fabricated `'CALJAN AI, Forebet'` (Forebet was never actually consulted) to an honest `'Odds-only heuristic (awaiting full analysis)'`. Verified: 0 of 101 currently-Pending matches show the placeholder after a full generation run.
2. **Real matches wrongly marked "Unverified"** — `resultsChecker.js`'s football-data.org check was scoped to only "today/yesterday," so genuinely-covered matches older than that (e.g. Serie A, LaLiga fixtures a few days old) fell through to the Unverified safety net instead of resolving. Fixed by using a filterless `/matches` call (confirmed it returns the whole season, ~380 matches, not just a date window) and checking ALL pending/live/previously-unverified rows in covered leagues regardless of age.
3. **Team-name matching too naive for some real names** — "Real Racing Club de Santander" (football-data.org) never matched our "Racing Santander" (Betika) because the old fuzzy matcher only did substring containment. Upgraded `teamNamesMatch()` to word-set comparison (with a 2-word-minimum safety guard, since the naive substring approach would otherwise have wrongly matched "AC Milan" to "Inter Milan" via the shared word "Milan" — confirmed and fixed that latent false-positive too).
4. **League-name alias over-matching** — `'Primera Division'` was aliased to Spanish La Liga, which would misattribute Venezuela's/Uruguay's/etc. own "Primera Division" leagues (Betika already uses the distinct name `'LaLiga'` for Spain, so this alias was simply wrong). Removed it, and added country-aware disambiguation to `getLeagueByName()` (new `country` column captured from Betika's own `category` field) so generic names like "Premier League" — used by England, Russia, Ukraine, Israel, Egypt, Rwanda, etc. — no longer misattribute to the wrong country's league.
5. **EAT timezone consistency** — audited all `new Date()` usage. Fixed: the frontend's "checked at" timestamps (11 call sites) were using the viewer's own browser timezone instead of EAT; a manual add-match date default and two sync-time UTC fallbacks could show the wrong calendar date during EAT's 00:00-02:59 window (when EAT has already rolled to a new day but UTC hasn't).

All verified against real, live data (not synthetic tests) — see git history for the specific before/after matches checked (Torino/Roma, Inter/Udinese, Atletico Madrid/Osasuna, Barcelona/Racing Santander all now resolve correctly with real scores).

---

## Goal
Build a multi-API, multi-factor football prediction engine that:
- Pulls **LIVE real-time data** from **12 free football & weather APIs** (September 2026 season data)
- Analyses **10–20 past games**, injuries, weather, formations, squad depth, manager H2H, and market sentiment
- Produces **~50 daily predictions** across 8 major leagues that appear on Betika/Odibets
- Considers **match date, kick-off time, timezone** for weather lookups, fatigue calculation, and scheduling
- Targets maximum realistic accuracy through weighted multi-factor scoring

> **On 95% accuracy:** Even the best professional prediction models achieve 55–70% on 1X2 markets. However, we push accuracy higher by:
> 1. Cherry-picking high-confidence matches (only predicting when confidence > 80%)
> 2. Using safer markets (1X, X2, Over 1.5, BTTS instead of pure 1X2)
> 3. Combining 12 data sources for consensus-based predictions
> 4. Filtering to ~50 strongest picks per day
>
> Realistic target: **75–85% hit rate on filtered, high-confidence picks**

---

## 🕐 Date, Time & Timezone Strategy

### Critical Time Rules
- **System timezone:** Africa/Nairobi (EAT, UTC+3) — matches on Betika show EAT times
- **API timezone handling:** All API responses are normalized to UTC then converted to EAT for display
- **"Today" definition:** Matches from 00:00 EAT to 05:00 EAT next day (covers late night matches)
- **Prediction window:** Predictions generated for matches kicking off in next 6–24 hours
- **Weather lookup:** Fetched for exact kick-off hour at stadium coordinates
- **Rest days calculation:** Uses actual calendar dates between fixtures

### Daily Schedule (All times EAT — UTC+3)

| Time (EAT) | Action | Details |
|------------|--------|---------|
| 06:00 | **Fetch Fixtures** | Pull today's + tomorrow's fixtures from API-Football, Football-Data.org, Betika API |
| 07:00 | **Collect Form Data** | Last 10-20 matches for each team, H2H records, standings |
| 08:00 | **Injury & Squad Scan** | Pull injuries, suspensions, expected lineups from API-Football & NewsAPI |
| 09:00 | **Odds Collection** | Fetch latest odds from Betika API + The Odds API |
| 10:00 | **Weather Check** | Query Open-Meteo for match-day weather at each stadium (exact kick-off hour) |
| 10:30 | **Sentiment Scan** | Reddit + NewsAPI for team news, community picks |
| 11:00 | **🧠 Generate Predictions** | Run the weighted 11-factor engine, filter to top ~50 picks |
| 12:00 | **Publish to Dashboard** | Predictions visible on frontend with full factor breakdown |
| Every 5min | **Live Result Check** | During match windows (14:00–01:00 EAT), check live scores |
| 01:00+1 | **Daily Report** | Calculate day's accuracy, update lifetime stats |

### Date-Aware Features
- **Match date chips:** Frontend shows date navigation (Yesterday / Today / Tomorrow)
- **Kick-off countdown:** Shows "Starts in 2h 15m" for upcoming matches
- **Time-weighted form:** Matches from last 14 days weighted 2x vs older matches
- **Fixture congestion detector:** Flags teams with < 3 days rest between matches
- **Season context:** Knows current 2026/27 season matchday numbers

---

## 📊 The 12 Free APIs — LIVE Data Sources

### Core Football Data APIs

| # | API | Free Tier | What We Pull LIVE | Registration |
|---|-----|-----------|-------------------|-------------|
| 1 | **API-Football** (api-football.com via RapidAPI) | 100 req/day | Today's fixtures, injuries, lineups, predictions, H2H (last 20), coaches, player stats | [Register](https://rapidapi.com/api-sports/api/api-football) |
| 2 | **Football-Data.org** | 10 req/min, 12 leagues | Live fixtures, standings, scorers, squads for EPL, LaLiga, Serie A, Bundesliga, Ligue 1, UCL | [Register](https://www.football-data.org/client/register) |
| 3 | **TheSportsDB** | Free key `123` | Team metadata, logos, stadiums (lat/lon), past events, player photos | No registration needed |
| 4 | **OpenLigaDB** | Unlimited, no key | Bundesliga live results, fixtures, standings | No registration needed |
| 5 | **Betika Live API** | Public | Real Betika odds for today, ensures we predict games ON Betika | No registration needed |

### Advanced Statistics APIs

| # | API | Free Tier | What We Pull LIVE | Registration |
|---|-----|-----------|-------------------|-------------|
| 6 | **StatsBomb Open Data** | Fully free (GitHub) | xG data, match events — for teams in covered competitions | No registration needed |
| 7 | **Sportmonks** | Free starter | xG, expected lineups, pressure index, referee data | [Register](https://www.sportmonks.com/register) |

### Weather & Environmental APIs

| # | API | Free Tier | What We Pull LIVE | Registration |
|---|-----|-----------|-------------------|-------------|
| 8 | **Open-Meteo** | 10,000 req/day, NO key | Hourly temperature, rain, wind at stadium lat/lon for exact kick-off time | No registration needed |
| 9 | **WeatherAPI.com** | 1M req/month | Backup weather, 3-day forecast, historical conditions | [Register](https://www.weatherapi.com/signup.aspx) |

### Odds & Market Data APIs

| # | API | Free Tier | What We Pull LIVE | Registration |
|---|-----|-----------|-------------------|-------------|
| 10 | **The Odds API** | 500 req/month | Multi-bookmaker odds comparison, line movement | [Register](https://the-odds-api.com/#get-access) |

### Community & News APIs

| # | API | Free Tier | What We Pull LIVE | Registration |
|---|-----|-----------|-------------------|-------------|
| 11 | **Reddit API** | Free with OAuth | r/SoccerBetting daily picks thread, community consensus | [Register](https://www.reddit.com/prefs/apps) |
| 12 | **NewsAPI.org** | 100 req/day | Breaking team news, injury updates, manager quotes | [Register](https://newsapi.org/register) |

**Registration needed:** 7 APIs | **No registration:** 5 APIs (TheSportsDB, OpenLigaDB, Betika, StatsBomb, Open-Meteo)

---

## 🏆 Target Leagues (8 Major Leagues)

| League | API-Football ID | Football-Data Code | Season 2026/27 | Betika Available |
|--------|----------------|-------------------|----------------|-----------------|
| English Premier League | 39 | PL | Active | ✅ Always |
| Spanish La Liga | 140 | PD | Active | ✅ Always |
| Italian Serie A | 135 | SA | Active | ✅ Always |
| German Bundesliga | 78 | BL1 | Active | ✅ Always |
| French Ligue 1 | 61 | FL1 | Active | ✅ Always |
| UEFA Champions League | 2 | CL | Matchdays | ✅ Always |
| UEFA Europa League | 3 | — | Matchdays | ✅ Always |
| English Championship | 40 | ELC | Active | ✅ Usually |

---

## 🧮 Multi-Factor Prediction Algorithm (11 Factors)

### Factor Weights (Total = 100%)

| # | Factor | Weight | Primary Data Source | Date/Time Relevance |
|---|--------|--------|--------------------|--------------------|
| 1 | Recent Form (last 10-20 games) | 20% | API-Football, Football-Data.org | Time-weighted: last 14 days = 2x importance |
| 2 | H2H Record (last 10-20 meetings) | 15% | API-Football H2H endpoint | Historical dates used for trend |
| 3 | Home/Away Strength | 12% | Football-Data.org standings | Current season home/away splits |
| 4 | Injuries & Suspensions | 12% | API-Football, NewsAPI | Real-time — checked hours before kick-off |
| 5 | Bookmaker Odds Consensus | 10% | Betika API, The Odds API | Live odds at time of prediction |
| 6 | xG & Advanced Stats | 8% | StatsBomb, Sportmonks | Season-to-date xG averages |
| 7 | Squad Depth & Lineup | 7% | API-Football, Sportmonks | Expected lineup for THIS match |
| 8 | Manager/Coach Record | 5% | API-Football coaches endpoint | Career + current tenure record |
| 9 | Weather Conditions | 4% | Open-Meteo, WeatherAPI | Exact kick-off hour weather at stadium |
| 10 | Rest Days & Fatigue | 4% | Fixture schedule analysis | Calendar days between matches |
| 11 | Community Consensus | 3% | Reddit, NewsAPI | Same-day sentiment from social/news |

### Prediction Markets Generated — ✅ EXPANDED

For each match, the engine produces predictions for 12 markets, all derived from the same Poisson goal-distribution grid (`scoreGrid`/`probsFromGrid` in `predictionEngine.js`) so they stay mutually consistent with each other and with the headline 1X2 pick:
- **1X2** (Match Result) — Home Win / Draw / Away Win
- **Double Chance** — 1X, X2, 12
- **Over/Under Goals** — O/U 1.5, O/U 2.5, O/U 3.5
- **BTTS** — Both Teams To Score Yes/No
- **Odd/Even Goals**
- **Multigoals** ("basket" — total-goals range: 1-2, 1-3, 1-4, 1-5, 2-3, 2-4, 2-5, 2-6, 3-4, 3-5, 3-6; picks the highest-confidence range, all 11 exposed as alternatives)
- **Clean Sheet** — Home and Away, each Yes/No
- **Win to Nil** — Home Win to Nil / Away Win to Nil / Neither
- **HT/FT** — all 9 half-time/full-time combinations (assumes a 45%/55% first-half/second-half goal split, a standard football-analytics approximation; **informational only** — we don't capture actual half-time scores anywhere, so this one can't be auto-verified and is excluded from the topPick/headline selection)
- **Correct Score** (top 3 most likely scores)

The single headline "Prediction" shown per match is whichever of these (excluding Correct Score and HT/FT, both inherently fragmented multi-way markets) has the highest confidence — so it now naturally varies across 1X2, Double Chance, O/U, Multigoals, Clean Sheet, etc. per match instead of clustering on just one or two market types. Each market prediction includes a confidence score (0-100%); only predictions with confidence > 70% are marked publishable. `services/resultsChecker.js`'s `evaluatePrediction()` was extended to auto-verify all of these (except HT/FT) once a match settles.

---

## 🏗️ Project File Structure

```
prediction/
├── server.js                         # Express server + REST API
├── package.json                      # Dependencies
├── .env                              # API keys (gitignored)
├── .env.example                      # Template for API keys
│
├── services/
│   ├── apiAggregator.js              # Orchestrates all 12 API calls with rate limiting
│   ├── dataNormalizer.js             # Normalizes different API response formats
│   ├── predictionEngine.js           # Core 11-factor weighted scoring engine
│   ├── oddsEngine.js                 # Odds→probability conversion, sharp money detection
│   ├── weatherEngine.js              # Stadium weather lookup & pitch impact scoring
│   ├── sentimentEngine.js            # Reddit/news sentiment scoring
│   ├── scheduler.js                  # Cron jobs for automated daily pipeline
│   └── leagueConfig.js              # League IDs, team mappings, stadium coordinates
│
├── config/
│   ├── apiKeys.js                    # Reads API keys from .env
│   └── stadiums.json                 # Top 200 stadiums: name → {lat, lon, city}
│
├── database/
│   ├── schema.sql                    # MySQL schema (existing)
│   └── betika_hub.sqlite             # SQLite database (auto-created)
│
├── index.html                        # Frontend HTML
├── style.css                         # Frontend CSS
├── caljan.js                         # Frontend JavaScript
│
├── api/                              # PHP backend (legacy, being replaced by Node.js)
│   ├── config.php
│   └── db.php
│
├── betika_live.json                  # Betika snapshot (fallback only)
├── betika_predictions_seed.json      # Seed data (fallback only)
├── IMPLEMENTATION_PLAN.md            # This file
└── README.md                         # Project documentation
```

---

## 📅 Implementation Phases

### Phase 1: API Integration Layer ✅ DONE
- [x] Create `config/apiKeys.js` — centralized API key management from .env
- [x] Create `config/stadiums.json` — stadium coordinates for weather (~140 clubs across the 8 leagues + common UCL/UEL participants; extend as needed)
- [x] Create `services/leagueConfig.js` — league IDs, team name aliases, timezone mappings
- [x] Create `services/apiAggregator.js` — unified fetch with rate limiting, caching, error handling
- [x] Wire up all 12 APIs with proper error fallbacks (10/12 live-tested OK; `API_FOOTBALL_KEY` and Reddit OAuth creds still need registering — see `.env`)
- [x] Add SQLite tables: `api_cache`, `team_form`, `match_factors`, `weather_data`, `predictions_log`
- [x] Test data flow: API → normalize → store in SQLite (verified via `GET /api/test/aggregator?source=<name>`)

### Phase 2: Prediction Engine Core ✅ DONE
- [x] Create `services/predictionEngine.js` — 11-factor weighted scorer + Poisson goal model
- [x] Create `services/oddsEngine.js` — de-vigged implied probability, multi-bookmaker consensus, value-bet detection
- [x] Create `services/weatherEngine.js` — exact kickoff-hour stadium weather + pitch impact score
- [x] Create `services/sentimentEngine.js` — NewsAPI keyword sentiment + Reddit community-buzz proxy
- [x] Create `services/dataNormalizer.js` — unifies fixture/odds/weather/news shapes across all sources + EAT timezone conversion
- [x] Build confidence threshold system (publish only > 70%) — also dampens confidence by data-quality (% of the 11 factors with real data), so a 90% pick always means well-supported, not just an unopposed model guess
- [x] Generate predictions for all 8 target markets per match (1X2, Double Chance, O/U 1.5/2.5/3.5, BTTS, Correct Score)
- [x] Add `/api/predictions/generate` endpoint to server.js — verified end-to-end against real fixtures (form, odds, weather all confirmed live; persists to `matches`, `match_factors`, `weather_data`, `predictions_log`)

**Known limitations (honest, not silently faked):**
- `homeAwayStrength`, `xg`, `squadDepth`, `managerRecord` report `dataAvailable:false` until you add `API_FOOTBALL_KEY` — free-tier football-data.org only returns TOTAL standings, not home/away splits, and Sportmonks' free plan doesn't expose xG for these leagues.
- `injuries`/`communityConsensus` fall back to a NewsAPI/Reddit keyword-sentiment proxy rather than an official injury list, until `API_FOOTBALL_KEY`/Reddit creds are added.
- Betika's league names ("Premier League", "Serie A") aren't country-scoped, so non-English/Italian matches sharing those names can get misassigned to the wrong football-data.org competition — harmless (fails gracefully to unavailable) but worth a smarter fix later.
- Running predictions across many leagues in one batch can hit football-data.org's 10 req/min cap, degrading some matches' data quality — Phase 3's scheduler should sequence/throttle this properly.

### Phase 3: Automation & Scheduling ✅ DONE
- [x] Install `node-cron` package
- [x] Create `services/scheduler.js` — 4 cron jobs, all pinned to Africa/Nairobi via node-cron's `timezone` option
- [x] Auto-fetch fixtures at 06:00 EAT — `services/syncService.js` (extracted from the `/api/sync` route so both share one code path)
- [x] Auto-generate predictions at 11:00 EAT — `services/predictionsService.js` (extracted from `/api/predictions/generate`)
- [x] Auto-check live results every 5 minutes — `services/resultsChecker.js`. Real data only, two layers: (1) football-data.org for the 8 covered leagues, (2) a broad API-Football fallback (`fixtures?date=X`, covers 900+ competitions in 2 cheap calls) that activates the moment `API_FOOTBALL_KEY` is added — confirmed Betika's own API has no results/live endpoint (its `tab` query param is unvalidated and always returns the same fixture+odds feed regardless of value). Judges any market prediction format via `evaluatePrediction()` (unit-tested 20/20). For the ~90 minor leagues Betika lists that neither source resolves, matches sit honestly as `Pending` only for a 3-hour grace period past kickoff, then flip to a new `Unverified` status (surfaced in the UI with a distinct badge and filter option) — telling the truth about what we don't know rather than implying the game hasn't happened. Found 28 real matches (some 5 days stale) stuck this way during testing.
- [x] Auto-calculate daily accuracy at 01:00 EAT — `services/accuracyReport.js` (new), rolls up settled matches into a hit-rate report stored in `system_settings`, readable via `GET /api/reports/accuracy/:date`
- [x] Add timezone-aware date handling throughout — cron jobs run in EAT, date math goes through `toEatParts()`/`+03:00` offsets consistently

**Design decision:** the plan's 07:00/08:00/09:00/10:00/10:30 "pre-warm" steps (form/injuries/odds/weather/sentiment) were deliberately *not* built as separate cron jobs — `apiAggregator`'s cache TTLs for those sources (3-15 min) are shorter than the gap to the 11:00 generation run, so pre-warming that early would just burn API quota re-fetching data that'd already be stale by generation time. `generateDailyPredictions` fetches everything it needs on demand instead.

**New endpoints:** `POST /api/results/check` (manual live-check trigger), `GET`/`POST /api/reports/accuracy/:date`.

### Phase 4: Dashboard Enhancement ✅ DONE
- [x] Show prediction factor breakdown per match (radar chart) — new "11-Factor Breakdown" tab in the match analysis modal, Chart.js radar of all 11 factors (weight + lean + data-availability), unavailable factors visibly grayed out rather than faked
- [x] Accuracy tracking by league, market type, confidence level — Results Tracker tab: fixed the League chart and replaced the *hardcoded fake* 7-day Performance Trend (literally frozen "Sep 10-16" data) with real per-date aggregation; added two new charts (Hit Rate by Market Type, Hit Rate by Confidence Level)
- [x] Weather badge on each match card — real temperature badge next to the league pill, sourced from Open-Meteo/WeatherAPI
- [x] Injury count & key absences per team — real injury indicator icon next to team names (API-Football when available, NewsAPI signal proxy otherwise)
- [x] Live API status panel (12 API connection indicators) — new card at the top of the API & Data tab, live from `/api/status/apis`
- [x] Date navigation: Yesterday / Today / Tomorrow — fixed another hardcoded-date bug here too (`renderDateTabs()` had "Yesterday" literally frozen to "Sep 15"); now computed dynamically, with a real "Tomorrow" label
- [x] Kick-off countdown timers — "Starts in Xh Ym" per pending match, refreshed every 60s

**How this was implemented:** the match-analysis modal (H2H, Form, Squad, Travel & Pitch, Sentiment, Analysts tabs) already existed but was wired to a fake data generator. Rather than rebuilding the UI, `services/analysisPresenter.js` reshapes real `predictionEngine` output into the exact object shape that UI already expected — so every tab now shows genuine engine output (real H2H meetings, real form strings, real injury signals, real weather+rest-day notes, real Poisson/market-blended probabilities, real per-market picks) with no frontend rewrite needed beyond the new radar tab.

**Bugs found and fixed along the way:** `/api/matches` never exposed `prediction_type`, silently breaking any market-type breakdown; and a large set of CSS classes the modal's JS actually emits (`.h2h-stat-box`, `.form-pill`, `.squad-card`, `.sent-box`, `.analyst-pick-card`, etc.) had no matching rules in style.css at all — a parallel, unused CSS design existed under different class names. Added the missing rules.

### Phase 5: Accuracy Optimization (Ongoing) — 🟡 STARTED
- [x] Backtest over 500+ historical matches — **honest shortfall**: `services/backtester.js` tested against all 309 finished matches currently available across the 8 leagues (free-tier football-data.org is season-scoped, and we're only ~1 month into 2026/27 — 500+ isn't reachable yet, but grows every matchday; re-run `POST /api/backtest/run` periodically). Of those, 111 had enough prior-match history per team to test. Result: model 45.0% hit rate on 1X2 vs. a 40.5% "always-home-win" baseline (+4.5% edge), noisy per-league (ranges from +36% to -18% on samples as small as 11 matches — expect this to stabilize as more matches accumulate)
- [x] Track per-league, per-factor predictive power — `services/factorAnalytics.js` / `GET /api/analytics/factors`, computed from our own accumulated `match_factors` + settled matches. Currently near-empty (few real settled matches so far) — will fill in as the live system runs
- [x] Value bet detection engine — wired `oddsEngine.detectValueBet` into every generated prediction (`GET /api/value-bets`), gated on `dataQuality >= 40%` and edges capped at 100%, after testing uncovered the ungated version flagging 13/15 matches with edges up to 158% — pure noise from the Poisson model's league-average fallback on low-data matches, not real value
- [ ] A/B test different factor weight configurations — **not built**: our only reconstructable historical factors (Recent Form + H2H) don't exercise the weight-blending logic in a way real A/B testing could validate; the other 9 factors need data (historical odds, weather, injuries) we have no historical source for. This becomes meaningful once `predictions_log`/`match_factors` accumulate enough of the live system's own real settled history to compare configurations against actual outcomes
- [ ] Adaptive weight adjustment based on recent performance — **not built deliberately**: auto-mutating live weights off a handful of settled matches would be overfitting noise, not learning. `factorAnalytics`'s `reliable` flag (30+ observation minimum) is the gate this needs before any adjustment — automatic or suggested — would be responsible to build

**Key limitation running through all of Phase 5:** our data sources only give *current-moment* snapshots (live odds, live weather, current injuries) — none of them expose historical point-in-time data on their free tiers. Genuine backtesting of the full 11-factor engine (not just the 2 reconstructable factors) is only possible prospectively, by letting the live system run and accumulate its own `predictions_log`/`match_factors` history over the season.

---

## 🔑 Required `.env` Configuration

```env
# === Core Settings ===
PORT=8000
NODE_ENV=development
DB_PATH=./database/betika_hub.sqlite
TIMEZONE=Africa/Nairobi

# === Football Data APIs ===
API_FOOTBALL_KEY=your_rapidapi_key_here
FOOTBALL_DATA_ORG_KEY=your_key_here
SPORTMONKS_KEY=your_key_here
# TheSportsDB: uses free key "123" — no env var needed
# OpenLigaDB: no key needed
# StatsBomb: no key needed (GitHub open data)

# === Betika ===
BETIKA_API_URL=https://api.betika.com/v1/uo/matches?tab=today&sport_id=14

# === Weather APIs ===
# Open-Meteo: NO key needed
WEATHER_API_KEY=your_weatherapi_com_key

# === Odds & Market Data ===
ODDS_API_KEY=your_the_odds_api_key

# === News & Sentiment ===
NEWS_API_KEY=your_newsapi_org_key
REDDIT_CLIENT_ID=your_reddit_app_id
REDDIT_CLIENT_SECRET=your_reddit_secret

# === Admin ===
ADMIN_USER=caljan
ADMIN_PASS=Caljan@2024
```
