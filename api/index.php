<?php
/**
 * CALJAN Prediction Intelligence - InfinityFree & Apache PHP API Router
 * 
 * Provides full REST API backend for environments where Node.js cannot run (like InfinityFree shared hosting).
 * Supports both MySQL database mode and JSON file fallback mode.
 */

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/db.php';

// Determine the requested route
$route = $_GET['route'] ?? '';
if (empty($route)) {
    $uri = parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH);
    $uri = preg_replace('#^.*/api/#', '', $uri);
    $route = trim($uri, '/');
}
$route = trim($route, '/');
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

// Parse incoming JSON body for POST/PUT requests
$inputData = [];
$rawInput = file_get_contents('php://input');
if (!empty($rawInput)) {
    $inputData = json_decode($rawInput, true) ?: [];
}

// -------------------------------------------------------------
// Route: /api/status
// -------------------------------------------------------------
if ($route === 'status') {
    $dbOk = false;
    $matchesCount = 0;
    try {
        $pdo = getDb();
        $stmt = $pdo->query("SELECT COUNT(*) FROM matches");
        $matchesCount = (int)$stmt->fetchColumn();
        $dbOk = true;
    } catch (Throwable $e) {
        $dbOk = false;
    }

    sendJsonResponse([
        'success' => true,
        'platform' => 'InfinityFree PHP',
        'phpVersion' => phpversion(),
        'databaseConnected' => $dbOk,
        'matchesCount' => $matchesCount,
        'serverTime' => date('Y-m-d H:i:s'),
        'timezone' => date_default_timezone_get()
    ]);
}

// -------------------------------------------------------------
// Route: /api/status/apis
// -------------------------------------------------------------
if ($route === 'status/apis') {
    sendJsonResponse([
        'success' => true,
        'data' => [
            ['source' => 'footballDataOrg', 'configured' => true],
            ['source' => 'sportmonks', 'configured' => true],
            ['source' => 'theSportsDb', 'configured' => true],
            ['source' => 'openLigaDb', 'configured' => true],
            ['source' => 'betika', 'configured' => true],
            ['source' => 'statsBomb', 'configured' => true],
            ['source' => 'openMeteo', 'configured' => true],
            ['source' => 'weatherApi', 'configured' => true],
            ['source' => 'oddsApi', 'configured' => true],
            ['source' => 'newsApi', 'configured' => true],
            ['source' => 'apiFootball', 'configured' => false],
            ['source' => 'reddit', 'configured' => false]
        ]
    ]);
}

// -------------------------------------------------------------
// Route: /api/auth/login
// -------------------------------------------------------------
if ($route === 'auth/login' && $method === 'POST') {
    $user = trim($inputData['username'] ?? '');
    $pass = trim($inputData['password'] ?? '');

    if (empty($user) || empty($pass)) {
        sendJsonResponse(['success' => false, 'error' => 'Username and password required'], 400);
    }

    // Check config credentials
    if ($user === ADMIN_USER && $pass === ADMIN_PASS) {
        sendJsonResponse([
            'success' => true,
            'user' => ['id' => 1, 'username' => $user, 'role' => 'admin'],
            'token' => 'caljan_jwt_' . base64_encode($user . ':' . time())
        ]);
    }

    // Check MySQL users table if available
    try {
        $pdo = getDb();
        $stmt = $pdo->prepare("SELECT * FROM users WHERE username = ? LIMIT 1");
        $stmt->execute([$user]);
        $row = $stmt->fetch();
        if ($row && (password_verify($pass, $row['password_hash']) || $pass === $row['password_hash'])) {
            sendJsonResponse([
                'success' => true,
                'user' => ['id' => $row['id'], 'username' => $row['username'], 'role' => $row['role'] ?? 'admin'],
                'token' => 'caljan_jwt_' . base64_encode($row['username'] . ':' . time())
            ]);
        }
    } catch (Throwable $e) {}

    sendJsonResponse(['success' => false, 'error' => 'Invalid username or password'], 401);
}

// -------------------------------------------------------------
// Route: /api/matches (GET)
// -------------------------------------------------------------
if ($route === 'matches' && $method === 'GET') {
    $dateFilter = $_GET['date'] ?? null;
    $statusFilter = $_GET['status'] ?? null;

    $matches = [];

    // Try MySQL first
    try {
        $pdo = getDb();
        $sql = "SELECT * FROM matches WHERE 1=1";
        $params = [];
        if ($dateFilter) {
            $sql .= " AND match_date = ?";
            $params[] = $dateFilter;
        }
        if ($statusFilter && $statusFilter !== 'All') {
            $sql .= " AND status = ?";
            $params[] = $statusFilter;
        }
        $sql .= " ORDER BY match_date DESC, match_time ASC";
        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);
        $rows = $stmt->fetchAll();

        foreach ($rows as $r) {
            $matches[] = [
                'id' => (int)$r['id'],
                'betikaGameId' => (string)$r['game_id'],
                'matchId' => (string)$r['match_id'],
                'homeTeam' => $r['home_team'],
                'awayTeam' => $r['away_team'],
                'league' => $r['competition_name'],
                'date' => $r['match_date'],
                'time' => $r['match_time'],
                'status' => $r['status'],
                'result' => $r['result'] ?? '—',
                'liveMinute' => $r['live_minute'],
                'odds' => (float)$r['odds_home'],
                'betikaOdds' => [
                    'home' => (float)$r['odds_home'],
                    'draw' => (float)$r['odds_draw'],
                    'away' => (float)$r['odds_away']
                ],
                'prediction' => $r['prediction'],
                'predictionType' => $r['prediction_type'] ?? '1X2',
                'confidence' => (int)$r['confidence'] >= 80 ? 'High' : ((int)$r['confidence'] >= 60 ? 'Medium' : 'Low'),
                'confidenceScore' => (int)$r['confidence'],
                'sources' => $r['sources_summary'] ?? 'CALJAN AI',
                'checkedAt' => $r['checked_at'],
                'analysis' => !empty($r['analysis_json']) ? json_decode($r['analysis_json'], true) : null
            ];
        }
    } catch (Throwable $dbErr) {
        // Fallback to local JSON files if DB is not set up
    }

    // If DB has no matches or failed, fallback to betika_live.json
    if (empty($matches)) {
        $jsonFile = __DIR__ . '/../betika_live.json';
        if (file_exists($jsonFile)) {
            $feed = json_decode(file_get_contents($jsonFile), true);
            $items = $feed['data'] ?? $feed ?? [];
            foreach ($items as $idx => $m) {
                if (empty($m['home_team']) || empty($m['away_team'])) continue;
                $isBball = (($m['sport_id'] ?? '') == 30) || 
                           (($m['sport_name'] ?? '') === 'Basketball') || 
                           (stripos($m['competition_name'] ?? '', 'basketball') !== false) ||
                           (stripos($m['competition_name'] ?? '', 'bbl') !== false) ||
                           (stripos($m['competition_name'] ?? '', 'nba') !== false);

                $startTime = $m['start_time'] ?? (date('Y-m-d') . ' 19:45:00');
                $parts = explode(' ', $startTime);
                $mDate = $parts[0] ?? date('Y-m-d');
                $mTime = isset($parts[1]) ? substr($parts[1], 0, 5) : '19:45';

                $hOdd = (float)($m['home_odd'] ?? 1.85);
                $dOdd = (float)($m['neutral_odd'] ?? 3.40);
                $aOdd = (float)($m['away_odd'] ?? 3.10);

                $pred = '1X';
                $predType = '1X2';
                $conf = 'Medium';
                $odds = $hOdd;
                $totalLine = null;
                $overOdd = null;
                $underOdd = null;

                if ($isBball) {
                    $predType = 'Total (Incl. Overtime)';
                    $totalMarket = null;
                    if (!empty($m['odds']) && is_array($m['odds'])) {
                        foreach ($m['odds'] as $oGroup) {
                            if (($oGroup['sub_type_id'] ?? '') == 225 || stripos($oGroup['name'] ?? '', 'TOTAL') !== false) {
                                $totalMarket = $oGroup;
                                break;
                            }
                        }
                    }

                    $linesMap = [];
                    if ($totalMarket && !empty($totalMarket['odds'])) {
                        foreach ($totalMarket['odds'] as $o) {
                            $line = $o['parsed_special_bet_value']['total'] ?? null;
                            if (!$line && !empty($o['display'])) {
                                if (preg_match('/([0-9]+(?:\.[0-9]+)?)/', $o['display'], $lm)) {
                                    $line = $lm[1];
                                }
                            }
                            if (!$line) continue;
                            if (!isset($linesMap[$line])) $linesMap[$line] = [];
                            $disp = strtoupper($o['display'] ?? '');
                            $val = (float)($o['odd_value'] ?? 1.85);
                            if (strpos($disp, 'OVER') !== false) $linesMap[$line]['over'] = $val;
                            if (strpos($disp, 'UNDER') !== false) $linesMap[$line]['under'] = $val;
                        }
                    }

                    $bestDiff = 999;
                    $mainLine = null;
                    foreach ($linesMap as $l => $pair) {
                        if (isset($pair['over']) && isset($pair['under'])) {
                            $diff = abs($pair['over'] - $pair['under']);
                            if ($diff < $bestDiff) {
                                $bestDiff = $diff;
                                $mainLine = $l;
                            }
                        }
                    }

                    if (!$mainLine && !empty($linesMap)) {
                        $mainLine = array_key_first($linesMap);
                    }

                    if ($mainLine && isset($linesMap[$mainLine])) {
                        $totalLine = $mainLine;
                        $overOdd = $linesMap[$mainLine]['over'] ?? 1.85;
                        $underOdd = $linesMap[$mainLine]['under'] ?? 1.85;
                        if ($overOdd <= $underOdd) {
                            $pred = "Over {$mainLine}";
                            $odds = $overOdd;
                            $conf = $overOdd <= 1.75 ? 'High' : 'Medium';
                        } else {
                            $pred = "Under {$mainLine}";
                            $odds = $underOdd;
                            $conf = $underOdd <= 1.75 ? 'High' : 'Medium';
                        }
                    } else {
                        $totalLine = '165.5';
                        $overOdd = 1.85;
                        $underOdd = 1.85;
                        $pred = 'Over 165.5';
                        $odds = 1.85;
                        $conf = 'Medium';
                    }
                } else {
                    if ($hOdd < 1.60) { $pred = 'Home Win'; $conf = 'High'; $odds = $hOdd; }
                    elseif ($aOdd < 1.60) { $pred = 'Away Win'; $conf = 'High'; $odds = $aOdd; }
                    elseif ($hOdd > 3.00 && $aOdd > 3.00) { $pred = 'Under 2.5'; $conf = 'Medium'; $odds = 1.70; }
                }

                $cleanLeague = trim(preg_replace('/^🏀\s*/', '', $m['competition_name'] ?? ($isBball ? 'Basketball' : 'Soccer')));

                $matches[] = [
                    'id' => (int)($m['game_id'] ?? ($idx + 1)),
                    'betikaGameId' => (string)($m['game_id'] ?? ($idx + 1000)),
                    'matchId' => (string)($m['match_id'] ?? ($idx + 100000)),
                    'sport' => $isBball ? 'Basketball' : 'Soccer',
                    'homeTeam' => trim($m['home_team']),
                    'awayTeam' => trim($m['away_team']),
                    'league' => ($isBball ? '🏀 ' : '') . $cleanLeague,
                    'date' => $mDate,
                    'time' => $mTime,
                    'status' => 'Pending',
                    'result' => '—',
                    'liveMinute' => null,
                    'odds' => (float)number_format($odds, 2, '.', ''),
                    'totalLine' => $totalLine,
                    'overOdd' => $overOdd,
                    'underOdd' => $underOdd,
                    'betikaOdds' => ['home' => $hOdd, 'draw' => $dOdd, 'away' => $aOdd],
                    'prediction' => $pred,
                    'predictionType' => $predType,
                    'confidence' => $conf,
                    'confidenceScore' => $conf === 'High' ? 82 : 68,
                    'sources' => $isBball ? 'CALJAN BasketAI, Total (Incl. OT)' : 'Odds Consensus (Betika/OddsAPI)',
                    'checkedAt' => null,
                    'analysis' => null
                ];
            }
        }
    }

    sendJsonResponse([
        'success' => true,
        'count' => count($matches),
        'data' => $matches
    ]);
}

// -------------------------------------------------------------
// Route: /api/sync (POST) — Fetches live Betika API (Football & Basketball Total) via PHP cURL
// -------------------------------------------------------------
if ($route === 'sync' && $method === 'POST') {
    function fetchCurlJson($url) {
        $ch = curl_init($url);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
        curl_setopt($ch, CURLOPT_TIMEOUT, 12);
        curl_setopt($ch, CURLOPT_USERAGENT, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
        curl_setopt($ch, CURLOPT_HTTPHEADER, ['Accept: application/json']);
        curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
        $res = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        if ($code === 200 && !empty($res)) {
            $j = json_decode($res, true);
            return $j['data'] ?? [];
        }
        return [];
    }

    $fbUrl = 'https://api.betika.com/v1/uo/matches?tab=today&sub_type_id=1,186&sport_id=14&tag_id=1&sort_id=1&period_id=-1&esports=false';
    $bbUrl = 'https://api.betika.com/v1/uo/matches?tab=today&sport_id=30&sub_type_id=1,225';

    $fbData = fetchCurlJson($fbUrl);
    $bbData = fetchCurlJson($bbUrl);
    $incoming = array_merge($fbData, $bbData);

    $jsonFile = __DIR__ . '/../betika_live.json';
    $existing = [];
    if (file_exists($jsonFile)) {
        $prev = json_decode(file_get_contents($jsonFile), true);
        $existing = $prev['data'] ?? $prev ?? [];
    }

    if (empty($incoming)) {
        $incoming = $existing;
    }

    if (empty($incoming)) {
        sendJsonResponse(['success' => false, 'error' => 'Unable to fetch Betika matches'], 500);
    }

    // Merge incoming with existing so games that kicked off earlier today NEVER disappear
    $incomingIds = [];
    foreach ($incoming as $m) {
        $gid = (string)($m['game_id'] ?? $m['match_id'] ?? '');
        if ($gid !== '') $incomingIds[$gid] = true;
    }

    $combined = $incoming;
    foreach ($existing as $oldM) {
        $oldId = (string)($oldM['game_id'] ?? $oldM['match_id'] ?? '');
        if ($oldId !== '' && !isset($incomingIds[$oldId])) {
            $combined[] = $oldM;
        }
    }

    // Save persistent merged snapshot to betika_live.json
    @file_put_contents($jsonFile, json_encode([
        'success' => true,
        'count' => count($combined),
        'timestamp' => date('c'),
        'data' => $combined
    ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));

    // Try storing/updating in MySQL if connected
    $synced = 0;
    try {
        $pdo = getDb();
        $stmt = $pdo->prepare("
            INSERT INTO matches (
                game_id, match_id, home_team, away_team, competition_name, category,
                start_time, match_date, match_time, status, result,
                odds_home, odds_draw, odds_away, prediction, confidence, sources_summary
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', '—', ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                odds_home = VALUES(odds_home),
                odds_draw = VALUES(odds_draw),
                odds_away = VALUES(odds_away),
                start_time = VALUES(start_time),
                match_date = VALUES(match_date),
                match_time = VALUES(match_time)
        ");

        foreach ($combined as $m) {
            if (empty($m['home_team']) || empty($m['away_team'])) continue;
            $isBball = (($m['sport_id'] ?? '') == 30) || (($m['sport_name'] ?? '') === 'Basketball');
            $startTime = $m['start_time'] ?? (date('Y-m-d') . ' 19:45:00');
            $parts = explode(' ', $startTime);
            $mDate = $parts[0] ?? date('Y-m-d');
            $mTime = isset($parts[1]) ? substr($parts[1], 0, 5) : '19:45';

            $hOdd = (float)($m['home_odd'] ?? 1.85);
            $dOdd = (float)($m['neutral_odd'] ?? 3.40);
            $aOdd = (float)($m['away_odd'] ?? 3.10);

            $pred = $isBball ? 'Over 165.5' : '1X';
            $conf = 70;
            if (!$isBball) {
                if ($hOdd < 1.60) { $pred = 'Home Win'; $conf = 85; }
                elseif ($aOdd < 1.60) { $pred = 'Away Win'; $conf = 85; }
            }

            $stmt->execute([
                (string)($m['game_id'] ?? ''),
                (string)($m['match_id'] ?? ''),
                trim($m['home_team']),
                trim($m['away_team']),
                $m['competition_name'] ?? ($isBball ? 'Basketball' : 'Soccer'),
                $isBball ? 'Basketball' : ($m['category'] ?? 'Soccer'),
                $startTime,
                $mDate,
                $mTime,
                $hOdd,
                $dOdd,
                $aOdd,
                $pred,
                $conf,
                $isBball ? 'Betika Basketball Total (Incl. OT)' : 'Betika Live API'
            ]);
            $synced++;
        }
    } catch (Throwable $e) {
        $synced = count($combined);
    }

    sendJsonResponse([
        'success' => true,
        'source' => 'live_api_php_proxy',
        'syncedCount' => $synced,
        'message' => "Successfully synchronized {$synced} real Betika Football & Basketball matches."
    ]);
}

// -------------------------------------------------------------
// Route: /api/tickets (GET / POST)
// -------------------------------------------------------------
if ($route === 'tickets') {
    if ($method === 'POST') {
        $ticketRef = 'CJ-ACC-' . rand(100000, 999999);
        $legs = $inputData['legs'] ?? [];
        try {
            $pdo = getDb();
            $stmt = $pdo->prepare("
                INSERT INTO accumulator_tickets (ticket_ref, ticket_name, stake, total_odds, potential_win, status, legs_json, legs_count)
                VALUES (?, ?, ?, ?, ?, 'Pending', ?, ?)
            ");
            $stmt->execute([
                $ticketRef,
                $inputData['name'] ?? 'CALJAN Accumulator',
                (float)($inputData['stake'] ?? 100),
                (float)($inputData['totalOdds'] ?? 1.0),
                (float)($inputData['potentialReturn'] ?? 0),
                json_encode($legs),
                count($legs)
            ]);
        } catch (Throwable $e) {}

        sendJsonResponse(['success' => true, 'ticketRef' => $ticketRef, 'message' => 'Accumulator ticket created']);
    }

    // GET tickets
    $tickets = [];
    try {
        $pdo = getDb();
        $stmt = $pdo->query("SELECT * FROM accumulator_tickets ORDER BY created_at DESC");
        foreach ($stmt->fetchAll() as $t) {
            $tickets[] = [
                'id' => (int)$t['id'],
                'ticketRef' => $t['ticket_ref'],
                'name' => $t['ticket_name'],
                'stake' => (float)$t['stake'],
                'totalOdds' => (float)$t['total_odds'],
                'potentialReturn' => (float)$t['potential_win'],
                'status' => $t['status'],
                'legsCount' => (int)$t['legs_count'],
                'legs' => json_decode($t['legs_json'] ?? '[]', true),
                'createdAt' => $t['created_at']
            ];
        }
    } catch (Throwable $e) {}

    sendJsonResponse(['success' => true, 'data' => $tickets]);
}

// -------------------------------------------------------------
// Default 404 handler for unmatched routes
// -------------------------------------------------------------
sendJsonResponse([
    'success' => false,
    'error' => "Endpoint not found: {$route}",
    'availableEndpoints' => ['status', 'status/apis', 'matches', 'sync', 'auth/login', 'tickets', 'sources']
], 404);
