/**
 * CALJAN - Football Prediction Intelligence System
 * Node.js Express Backend & Frontend Static Server
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');

const { getStatusReport } = require('./config/apiKeys');
const apiAggregator = require('./services/apiAggregator');
const { LEAGUES } = require('./services/leagueConfig');
const predictionEngine = require('./services/predictionEngine');
const { toEatParts } = require('./services/dataNormalizer');
const { syncBetikaFixtures } = require('./services/syncService');
const { generateDailyPredictions } = require('./services/predictionsService');
const { checkLiveResults } = require('./services/resultsChecker');
const { computeDailyAccuracy } = require('./services/accuracyReport');
const { runBacktest } = require('./services/backtester');
const { analyzeFactorPredictivePower } = require('./services/factorAnalytics');
const { startScheduler } = require('./services/scheduler');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 8000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'database', 'betika_hub.sqlite');
const BETIKA_API_URL = process.env.BETIKA_API_URL || 'https://api.betika.com/v1/uo/matches?tab=today&sport_id=14';

// Ensure database directory exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// Initialize SQLite Database (supports sqlite3 package or Node.js built-in node:sqlite)
let dbQuery;
try {
  const sqlite3 = require('sqlite3').verbose();
  const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) throw err;
    console.log(`Connected to SQLite database via sqlite3 at: ${DB_PATH}`);
    initDatabase();
  });
  dbQuery = {
    all: (sql, params = []) => new Promise((res, rej) => {
      db.all(sql, params, (err, rows) => err ? rej(err) : res(rows));
    }),
    get: (sql, params = []) => new Promise((res, rej) => {
      db.get(sql, params, (err, row) => err ? rej(err) : res(row));
    }),
    run: (sql, params = []) => new Promise((res, rej) => {
      db.run(sql, params, function (err) { err ? rej(err) : res({ lastID: this.lastID, changes: this.changes }); });
    })
  };
} catch (nativeErr) {
  // Built-in node:sqlite for Node v22.5+ (no native C++ compilation required)
  const { DatabaseSync } = require('node:sqlite');
  console.log(`Connected to SQLite database via built-in node:sqlite at: ${DB_PATH}`);
  const syncDb = new DatabaseSync(DB_PATH);
  dbQuery = {
    all: async (sql, params = []) => {
      const stmt = syncDb.prepare(sql);
      return stmt.all(...params);
    },
    get: async (sql, params = []) => {
      const stmt = syncDb.prepare(sql);
      return stmt.get(...params);
    },
    run: async (sql, params = []) => {
      const stmt = syncDb.prepare(sql);
      const info = stmt.run(...params);
      return { lastID: info.lastInsertRowid, changes: info.changes };
    }
  };
  setImmediate(() => initDatabase());
}

// Let apiAggregator persist/read its response cache through the same SQLite connection
apiAggregator.attachDatabase(dbQuery);

// Adds a column to an existing table if it isn't already there (SQLite has no
// "ADD COLUMN IF NOT EXISTS", so we just swallow the "duplicate column" error).
async function addColumnIfMissing(table, column, definition) {
  try {
    await dbQuery.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }
}

// Auto-migrate schema and seed starter data
async function initDatabase() {
  try {
    await dbQuery.run(`
      CREATE TABLE IF NOT EXISTS matches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id TEXT NOT NULL,
        match_id TEXT NOT NULL,
        parent_match_id TEXT,
        home_team TEXT NOT NULL,
        away_team TEXT NOT NULL,
        competition_name TEXT NOT NULL,
        category TEXT DEFAULT 'Soccer',
        start_time TEXT NOT NULL,
        match_date TEXT NOT NULL,
        match_time TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'Pending',
        result TEXT NOT NULL DEFAULT '—',
        live_minute TEXT,
        home_score INTEGER,
        away_score INTEGER,
        odds_home REAL NOT NULL DEFAULT 1.00,
        odds_draw REAL NOT NULL DEFAULT 1.00,
        odds_away REAL NOT NULL DEFAULT 1.00,
        odds_over25 REAL,
        odds_under25 REAL,
        odds_btts REAL,
        prediction TEXT NOT NULL,
        prediction_type TEXT NOT NULL DEFAULT '1X2',
        confidence INTEGER NOT NULL DEFAULT 70,
        sources_count INTEGER NOT NULL DEFAULT 3,
        sources_summary TEXT,
        tactical_notes TEXT,
        analysis_json TEXT,
        checked_at TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(game_id, match_id)
      )
    `);

    await dbQuery.run(`
      CREATE TABLE IF NOT EXISTS accumulator_tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_ref TEXT NOT NULL UNIQUE,
        ticket_name TEXT NOT NULL,
        stake REAL NOT NULL DEFAULT 100.00,
        total_odds REAL NOT NULL DEFAULT 1.00,
        potential_win REAL NOT NULL DEFAULT 0.00,
        status TEXT NOT NULL DEFAULT 'Pending',
        legs_json TEXT NOT NULL,
        legs_count INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await dbQuery.run(`
      CREATE TABLE IF NOT EXISTS prediction_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_name TEXT NOT NULL,
        match_id TEXT,
        match_teams TEXT NOT NULL,
        pick TEXT NOT NULL,
        confidence INTEGER NOT NULL DEFAULT 75,
        notes TEXT,
        status TEXT NOT NULL DEFAULT 'Pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await dbQuery.run(`
      CREATE TABLE IF NOT EXISTS system_settings (
        setting_key TEXT PRIMARY KEY,
        setting_value TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await dbQuery.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'admin',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Phase 1 tables: raw API response cache + normalized data storage for the prediction engine
    await dbQuery.run(`
      CREATE TABLE IF NOT EXISTS api_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        cache_key TEXT NOT NULL,
        response_json TEXT NOT NULL,
        fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NOT NULL,
        UNIQUE(source, cache_key)
      )
    `);

    await dbQuery.run(`
      CREATE TABLE IF NOT EXISTS team_form (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        team_name TEXT NOT NULL,
        league TEXT NOT NULL,
        match_date TEXT NOT NULL,
        opponent TEXT NOT NULL,
        venue TEXT NOT NULL,
        goals_for INTEGER,
        goals_against INTEGER,
        result TEXT,
        source TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(team_name, match_date, opponent)
      )
    `);

    await dbQuery.run(`
      CREATE TABLE IF NOT EXISTS match_factors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        match_id TEXT NOT NULL,
        factor_name TEXT NOT NULL,
        factor_value TEXT,
        weight REAL,
        computed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(match_id, factor_name)
      )
    `);

    await dbQuery.run(`
      CREATE TABLE IF NOT EXISTS weather_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stadium_name TEXT NOT NULL,
        match_date TEXT NOT NULL,
        kickoff_hour INTEGER,
        temperature_c REAL,
        precipitation_mm REAL,
        wind_kph REAL,
        condition TEXT,
        source TEXT,
        fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(stadium_name, match_date, kickoff_hour)
      )
    `);

    await dbQuery.run(`
      CREATE TABLE IF NOT EXISTS predictions_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        match_id TEXT NOT NULL,
        market TEXT NOT NULL,
        prediction TEXT NOT NULL,
        confidence INTEGER NOT NULL,
        factors_json TEXT,
        actual_result TEXT,
        is_correct INTEGER,
        generated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Seed default admin users
    await dbQuery.run(
      `INSERT OR IGNORE INTO users (username, password_hash, role) VALUES (?, ?, ?)`,
      ['caljan', 'Caljan@2024', 'admin']
    );
    await dbQuery.run(
      `INSERT OR IGNORE INTO users (username, password_hash, role) VALUES (?, ?, ?)`,
      ['Admin', 'Admin@123_', 'admin']
    );

    // Seed initial fixtures if matches table is empty
    const matchCountRow = await dbQuery.get('SELECT COUNT(*) as cnt FROM matches');
    if (matchCountRow && matchCountRow.cnt === 0) {
      console.log('Seeding initial fixtures from betika_predictions_seed.json...');
      const seedFilePath = path.join(__dirname, 'betika_predictions_seed.json');
      if (fs.existsSync(seedFilePath)) {
        const seedRaw = fs.readFileSync(seedFilePath, 'utf8');
        const fixtures = JSON.parse(seedRaw);
        if (Array.isArray(fixtures)) {
          for (const f of fixtures) {
            const gameId = f.betikaGameId || f.game_id || String(Math.floor(10000 + Math.random() * 90000));
            const matchId = f.matchId || f.match_id || String(Math.floor(10000000 + Math.random() * 90000000));
            const time = f.time || '19:45';
            const date = f.date || '2026-09-16';
            const startTime = `${date} ${time}:00`;
            const bOdds = f.betikaOdds || {};
            const oddsHome = bOdds.home || f.odds || 1.85;
            const oddsDraw = bOdds.draw || 3.40;
            const oddsAway = bOdds.away || 3.10;
            const confidence = typeof f.confidence === 'number' ? f.confidence : (f.confidence === 'High' ? 85 : 70);

            await dbQuery.run(`
              INSERT OR IGNORE INTO matches (
                game_id, match_id, home_team, away_team, competition_name,
                start_time, match_date, match_time, status, result, live_minute,
                odds_home, odds_draw, odds_away, prediction, confidence,
                sources_summary, analysis_json, checked_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
              String(gameId),
              String(matchId),
              f.homeTeam || 'Home Team',
              f.awayTeam || 'Away Team',
              f.league || 'Premier League',
              startTime,
              date,
              time,
              f.status || 'Pending',
              f.result || '—',
              f.liveMinute || null,
              oddsHome,
              oddsDraw,
              oddsAway,
              f.prediction || '1X',
              confidence,
              f.sources || 'CALJAN AI',
              f.analysis ? JSON.stringify(f.analysis) : null,
              f.checkedAt || null
            ]);
          }
          console.log(`Successfully seeded ${fixtures.length} matches into database.`);
        }
      }
    }

    // country: Betika's own `category` field (e.g. "England", "Italy") — distinct from this
    // table's existing `category` column, which is sport type ("Soccer"). Used to disambiguate
    // generic league names ("Premier League", "Serie A") that many countries share.
    await addColumnIfMissing('matches', 'country', 'TEXT');

    startScheduler(dbQuery);
  } catch (err) {
    console.error('Database migration/seed error:', err);
  }
}

// Middleware
app.use(cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Static files (Frontend: index.html, style.css, caljan.js, etc.)
app.use(express.static(__dirname));

// ==========================================
// REST API ROUTES
// ==========================================

// 1. Health & Server Status
app.get('/api/status', async (req, res) => {
  try {
    const matchCount = await dbQuery.get('SELECT COUNT(*) as count FROM matches');
    const pendingCount = await dbQuery.get("SELECT COUNT(*) as count FROM matches WHERE status = 'Pending'");
    const wonCount = await dbQuery.get("SELECT COUNT(*) as count FROM matches WHERE status = 'Won'");
    const lostCount = await dbQuery.get("SELECT COUNT(*) as count FROM matches WHERE status = 'Lost'");
    const unverifiedCount = await dbQuery.get("SELECT COUNT(*) as count FROM matches WHERE status = 'Unverified'");
    const ticketCount = await dbQuery.get('SELECT COUNT(*) as count FROM accumulator_tickets');
    const sourceCount = await dbQuery.get('SELECT COUNT(*) as count FROM prediction_sources');

    res.json({
      success: true,
      service: 'CALJAN Football Prediction Intelligence API',
      status: 'online',
      version: '1.0.0',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      database: {
        engine: 'SQLite',
        path: DB_PATH,
        status: 'connected'
      },
      stats: {
        totalMatches: matchCount ? matchCount.count : 0,
        pending: pendingCount ? pendingCount.count : 0,
        won: wonCount ? wonCount.count : 0,
        lost: lostCount ? lostCount.count : 0,
        unverified: unverifiedCount ? unverifiedCount.count : 0,
        totalTickets: ticketCount ? ticketCount.count : 0,
        totalSources: sourceCount ? sourceCount.count : 0
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 1b. API Configuration Status (which of the 12 sources have keys set)
app.get('/api/status/apis', (req, res) => {
  res.json({ success: true, data: getStatusReport(), leagues: LEAGUES.map((l) => l.name) });
});

// 1c. Live API Data Flow Test (API -> cache -> SQLite). Hits the real endpoint for one
// source so you can confirm a key actually works. Costs 1 request against that source's quota.
app.get('/api/test/aggregator', async (req, res) => {
  const source = req.query.source || 'footballDataOrg';
  try {
    let result;
    switch (source) {
      case 'apiFootball':
        result = await apiAggregator.fetchApiFootball('status');
        break;
      case 'footballDataOrg':
        result = await apiAggregator.fetchFootballDataOrg('competitions/PL/matches', { status: 'SCHEDULED' });
        break;
      case 'theSportsDb':
        result = await apiAggregator.fetchTheSportsDb('search_all_teams.php?l=English%20Premier%20League');
        break;
      case 'openLigaDb':
        result = await apiAggregator.fetchOpenLigaDb('getbltable/bl1/2025');
        break;
      case 'betika':
        result = await apiAggregator.fetchBetika();
        break;
      case 'statsBomb':
        result = await apiAggregator.fetchStatsBombCompetitions();
        break;
      case 'sportmonks':
        result = await apiAggregator.fetchSportmonks('leagues');
        break;
      case 'openMeteo':
        result = await apiAggregator.fetchOpenMeteo(51.5549, -0.1084, toEatParts(new Date()).date);
        break;
      case 'weatherApi':
        result = await apiAggregator.fetchWeatherApi('London', toEatParts(new Date()).date);
        break;
      case 'oddsApi':
        result = await apiAggregator.fetchOddsApi('soccer_epl', 'uk');
        break;
      case 'reddit':
        result = await apiAggregator.fetchReddit('/r/soccerbetting/hot?limit=5');
        break;
      case 'newsApi':
        result = await apiAggregator.fetchNewsApi('premier league injury');
        break;
      default:
        return res.status(400).json({ success: false, error: `Unknown source: ${source}` });
    }

    // Confirm it actually landed in SQLite via the cache table
    const cacheRow = await dbQuery.get(
      'SELECT source, cache_key, fetched_at, expires_at FROM api_cache WHERE source = ? ORDER BY fetched_at DESC LIMIT 1',
      [source]
    );

    res.json({
      success: result.success,
      source,
      cached: result.cached || false,
      stale: result.stale || false,
      error: result.error,
      persistedToSqlite: Boolean(cacheRow),
      cacheRow,
      sample: result.data ? JSON.stringify(result.data).slice(0, 500) : null
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 1d. Generate Predictions — runs the 11-factor engine over today's + tomorrow's Pending
// matches and persists results (matches, match_factors, weather_data, predictions_log).
app.post('/api/predictions/generate', async (req, res) => {
  try {
    // No explicit ?limit= -> let generateDailyPredictions use its own default (200, enough for
    // a full day's Betika fixtures) rather than silently re-capping it back down to 15 here.
    const options = req.query.limit ? { limit: parseInt(req.query.limit) } : {};
    const result = await generateDailyPredictions(dbQuery, options);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 1e. Manually trigger a live-results check (real data only, for leagues football-data.org covers)
app.post('/api/results/check', async (req, res) => {
  try {
    const result = await checkLiveResults(dbQuery);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Authentication Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username and password required' });
    }

    const user = await dbQuery.get(
      'SELECT * FROM users WHERE username = ? AND password_hash = ?',
      [username.trim(), password.trim()]
    );

    if (user) {
      res.json({
        success: true,
        user: {
          id: user.id,
          username: user.username,
          role: user.role
        },
        token: `caljan_jwt_${Buffer.from(user.username + ':' + Date.now()).toString('base64')}`
      });
    } else {
      res.status(401).json({ success: false, error: 'Invalid username or password' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Get Matches (with filtering)
app.get('/api/matches', async (req, res) => {
  try {
    const { date, status, league } = req.query;
    let sql = 'SELECT * FROM matches WHERE 1=1';
    const params = [];

    if (date) {
      sql += ' AND match_date = ?';
      params.push(date);
    }
    if (status && status !== 'All') {
      sql += ' AND status = ?';
      params.push(status);
    }
    if (league) {
      sql += ' AND competition_name LIKE ?';
      params.push(`%${league}%`);
    }

    sql += ' ORDER BY match_date DESC, match_time ASC';
    const rows = await dbQuery.all(sql, params);

    // Format for frontend consumption
    const formatted = rows.map(r => ({
      id: r.id,
      betikaGameId: r.game_id,
      matchId: r.match_id,
      homeTeam: r.home_team,
      awayTeam: r.away_team,
      league: r.competition_name,
      date: r.match_date,
      time: r.match_time,
      status: r.status,
      result: r.result,
      liveMinute: r.live_minute,
      odds: r.odds_home,
      betikaOdds: {
        home: r.odds_home,
        draw: r.odds_draw,
        away: r.odds_away
      },
      prediction: r.prediction,
      predictionType: r.prediction_type,
      confidence: r.confidence >= 80 ? 'High' : (r.confidence >= 60 ? 'Medium' : 'Low'),
      confidenceScore: r.confidence,
      sources: r.sources_summary || 'CALJAN AI',
      checkedAt: r.checked_at,
      analysis: r.analysis_json ? JSON.parse(r.analysis_json) : null
    }));

    res.json({ success: true, count: formatted.length, data: formatted });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Add New Match Fixture
app.post('/api/matches', async (req, res) => {
  try {
    const b = req.body;
    const gameId = b.betikaGameId || b.game_id || String(Math.floor(10000 + Math.random() * 90000));
    const matchId = b.matchId || b.match_id || String(Math.floor(10000000 + Math.random() * 90000000));
    const date = b.date || toEatParts(new Date()).date;
    const time = b.time || '19:45';
    const startTime = `${date} ${time}:00`;
    const odds = parseFloat(b.odds) || 1.85;

    const result = await dbQuery.run(`
      INSERT INTO matches (
        game_id, match_id, home_team, away_team, competition_name,
        start_time, match_date, match_time, status, result,
        odds_home, odds_draw, odds_away, prediction, confidence,
        sources_summary, tactical_notes, analysis_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      gameId,
      matchId,
      b.homeTeam || 'Home',
      b.awayTeam || 'Away',
      b.league || 'Premier League',
      startTime,
      date,
      time,
      b.status || 'Pending',
      b.result || '—',
      odds,
      b.oddsDraw || 3.40,
      b.oddsAway || 3.10,
      b.prediction || '1X',
      b.confidence === 'High' ? 85 : (b.confidence === 'Low' ? 55 : 70),
      b.sources || 'CALJAN AI',
      b.notes || '',
      b.analysis ? JSON.stringify(b.analysis) : null
    ]);

    res.status(201).json({ success: true, id: result.lastID, message: 'Match fixture created' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Update Match Status / Result
app.put('/api/matches/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const { status, result, liveMinute } = req.body;

    await dbQuery.run(`
      UPDATE matches
      SET status = COALESCE(?, status),
          result = COALESCE(?, result),
          live_minute = COALESCE(?, live_minute),
          checked_at = datetime('now'),
          updated_at = datetime('now')
      WHERE id = ? OR match_id = ? OR game_id = ?
    `, [status, result, liveMinute, id, id, id]);

    res.json({ success: true, message: 'Match updated successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. Delete Match
app.delete('/api/matches/:id', async (req, res) => {
  try {
    const id = req.params.id;
    await dbQuery.run('DELETE FROM matches WHERE id = ? OR match_id = ?', [id, id]);
    res.json({ success: true, message: 'Match deleted successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7. Betika Daily Games Sync (CORS-free server proxy)
app.post('/api/sync', async (req, res) => {
  try {
    const result = await syncBetikaFixtures(dbQuery, BETIKA_API_URL);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7b. Generate Predictions on-demand
app.post('/api/predictions/generate', async (req, res) => {
  try {
    const result = await generateDailyPredictions(dbQuery);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 8. Accumulator Tickets Endpoints
app.get('/api/tickets', async (req, res) => {
  try {
    const rows = await dbQuery.all('SELECT * FROM accumulator_tickets ORDER BY created_at DESC');
    const tickets = rows.map(t => ({
      id: t.id,
      ticketRef: t.ticket_ref,
      name: t.ticket_name,
      stake: t.stake,
      totalOdds: t.total_odds,
      potentialReturn: t.potential_win,
      status: t.status,
      legsCount: t.legs_count,
      legs: JSON.parse(t.legs_json || '[]'),
      createdAt: t.created_at
    }));
    res.json({ success: true, data: tickets });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/tickets', async (req, res) => {
  try {
    const { name, stake, totalOdds, potentialReturn, legs } = req.body;
    const ticketRef = 'CJ-ACC-' + Math.floor(100000 + Math.random() * 900000);

    const result = await dbQuery.run(`
      INSERT INTO accumulator_tickets (
        ticket_ref, ticket_name, stake, total_odds, potential_win, status, legs_json, legs_count
      ) VALUES (?, ?, ?, ?, ?, 'Pending', ?, ?)
    `, [
      ticketRef,
      name || 'CALJAN Accumulator',
      parseFloat(stake) || 100,
      parseFloat(totalOdds) || 1.00,
      parseFloat(potentialReturn) || 0,
      JSON.stringify(legs || []),
      Array.isArray(legs) ? legs.length : 0
    ]);

    res.status(201).json({ success: true, id: result.lastID, ticketRef, message: 'Accumulator ticket created' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 9. Prediction Sources Endpoints
app.get('/api/sources', async (req, res) => {
  try {
    const rows = await dbQuery.all('SELECT * FROM prediction_sources ORDER BY created_at DESC');
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/sources', async (req, res) => {
  try {
    const { sourceName, matchTeams, pick, confidence, notes } = req.body;
    const result = await dbQuery.run(`
      INSERT INTO prediction_sources (source_name, match_teams, pick, confidence, notes)
      VALUES (?, ?, ?, ?, ?)
    `, [
      sourceName || 'Community Analyst',
      matchTeams || 'Match',
      pick || 'Home Win',
      parseInt(confidence) || 75,
      notes || ''
    ]);
    res.status(201).json({ success: true, id: result.lastID, message: 'Source pick recorded' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 10. System Settings Endpoints
app.get('/api/settings', async (req, res) => {
  try {
    const rows = await dbQuery.all('SELECT * FROM system_settings');
    const settings = {};
    for (const r of rows) {
      settings[r.setting_key] = r.setting_value;
    }
    res.json({ success: true, data: settings });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/settings', async (req, res) => {
  try {
    const settings = req.body;
    for (const [key, value] of Object.entries(settings)) {
      await dbQuery.run(`
        INSERT INTO system_settings (setting_key, setting_value)
        VALUES (?, ?)
        ON CONFLICT(setting_key) DO UPDATE SET
          setting_value = excluded.setting_value,
          updated_at = datetime('now')
      `, [key, String(value)]);
    }
    res.json({ success: true, message: 'Settings updated successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 11. Daily Accuracy Reports (computed by the 01:00 EAT scheduler job, or on demand)
app.get('/api/reports/accuracy/:date', async (req, res) => {
  try {
    const row = await dbQuery.get('SELECT setting_value FROM system_settings WHERE setting_key = ?', [`accuracy_report_${req.params.date}`]);
    if (!row) return res.status(404).json({ success: false, error: `No accuracy report for ${req.params.date} yet` });
    res.json({ success: true, data: JSON.parse(row.setting_value) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/reports/accuracy/:date', async (req, res) => {
  try {
    const report = await computeDailyAccuracy(dbQuery, req.params.date);
    res.json({ success: true, data: report });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 12. Phase 5 — Accuracy Optimization
// Historical backtest of the core goal model (Recent Form + H2H only — see services/backtester.js
// for why the other 9 factors can't be reconstructed historically). Takes a few seconds to run.
app.post('/api/backtest/run', async (req, res) => {
  try {
    const report = await runBacktest(dbQuery);
    res.json({ success: true, data: report });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/backtest/latest', async (req, res) => {
  try {
    const row = await dbQuery.get(`SELECT setting_value FROM system_settings WHERE setting_key = 'backtest_report_latest'`);
    if (!row) return res.status(404).json({ success: false, error: 'No backtest has been run yet — POST /api/backtest/run first' });
    res.json({ success: true, data: JSON.parse(row.setting_value) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Real per-factor predictive power from our own accumulated (match_factors + settled matches) data.
// Sparse until the live system has settled enough of its own predictions — see the `reliable` flag.
app.get('/api/analytics/factors', async (req, res) => {
  try {
    const report = await analyzeFactorPredictivePower(dbQuery);
    res.json({ success: true, data: report });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Today's/tomorrow's matches where our model probability implies positive expected value
// against Betika's actual odds (edge > 5%). Computed at generation time, stored in analysis_json.
app.get('/api/value-bets', async (req, res) => {
  try {
    const todayEat = toEatParts(new Date()).date;
    const tomorrowEat = toEatParts(new Date(Date.now() + 24 * 60 * 60 * 1000)).date;
    const rows = await dbQuery.all(
      `SELECT id, match_id, home_team, away_team, competition_name, match_date, match_time, analysis_json FROM matches WHERE match_date IN (?, ?) AND analysis_json IS NOT NULL`,
      [todayEat, tomorrowEat]
    );
    const valueBets = [];
    for (const row of rows) {
      let analysis;
      try { analysis = JSON.parse(row.analysis_json); } catch (e) { continue; }
      if (analysis.valueBets && analysis.valueBets.length > 0) {
        valueBets.push({
          matchId: row.match_id,
          homeTeam: row.home_team,
          awayTeam: row.away_team,
          league: row.competition_name,
          date: row.match_date,
          time: row.match_time,
          bets: analysis.valueBets
        });
      }
    }
    res.json({ success: true, count: valueBets.length, data: valueBets });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Catch-all: serve index.html for SPA client-side routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Start Server with graceful fallback if port is already in use
function startServer(targetPort) {
  const server = app.listen(targetPort, '0.0.0.0', () => {
    console.log(`=======================================================`);
    console.log(` CALJAN - Football Prediction Intelligence System `);
    console.log(` Server running on http://localhost:${targetPort}`);
    console.log(` Real Betika Sync, REST API & Frontend Active `);
    console.log(`=======================================================`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      const nextPort = targetPort === 8000 ? 8080 : targetPort + 1;
      console.warn(`[CALJAN] Port ${targetPort} is already in use. Retrying on port ${nextPort}...`);
      startServer(nextPort);
    } else {
      console.error('[CALJAN] Server error:', err);
    }
  });
}

startServer(PORT);

module.exports = app;
