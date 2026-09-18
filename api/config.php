<?php
/**
 * Betika Analyst Hub - Database & App Configuration
 * 
 * Works out-of-the-box locally with MySQL and on InfinityFree web hosting.
 * To customize on InfinityFree:
 * 1. Update the credentials below, OR
 * 2. Create a config.local.php file in the /api directory with your InfinityFree DB credentials.
 */

// Set Default Timezone to East Africa Time (Betika's operating timezone)
date_default_timezone_set('Africa/Nairobi');

// Error reporting (can be turned off in production if desired)
error_reporting(E_ALL & ~E_NOTICE);
ini_set('display_errors', 0);

// Default Configuration for Local Environment
$default_config = [
    'db_host' => '127.0.0.1',
    'db_port' => '3306',
    'db_name' => 'betika_hub',
    'db_user' => 'root',
    'db_pass' => 'Aaamumo254%',
    'charset' => 'utf8mb4',
    'admin_user' => 'Admin',
    'admin_pass' => 'Admin@123_',
    'betika_api_base' => 'https://api.betika.com/v1/uo/matches',
    'cache_duration' => 300 // 5 minutes cache
];

// Check if a local override configuration exists (useful for InfinityFree)
if (file_exists(__DIR__ . '/config.local.php')) {
    $local_config = include __DIR__ . '/config.local.php';
    if (is_array($local_config)) {
        $default_config = array_merge($default_config, $local_config);
    }
}

// Environment variable overrides
if (getenv('DB_HOST')) $default_config['db_host'] = getenv('DB_HOST');
if (getenv('DB_PORT')) $default_config['db_port'] = getenv('DB_PORT');
if (getenv('DB_NAME')) $default_config['db_name'] = getenv('DB_NAME');
if (getenv('DB_USER')) $default_config['db_user'] = getenv('DB_USER');
if (getenv('DB_PASS')) $default_config['db_pass'] = getenv('DB_PASS');

// Define constants
define('DB_HOST', $default_config['db_host']);
define('DB_PORT', $default_config['db_port']);
define('DB_NAME', $default_config['db_name']);
define('DB_USER', $default_config['db_user']);
define('DB_PASS', $default_config['db_pass']);
define('DB_CHARSET', $default_config['charset']);
define('ADMIN_USER', $default_config['admin_user']);
define('ADMIN_PASS', $default_config['admin_pass']);
define('BETIKA_API_BASE', $default_config['betika_api_base']);
define('CACHE_DURATION', $default_config['cache_duration']);

/**
 * Standard JSON response helper with CORS headers
 */
function sendJsonResponse($data, $statusCode = 200) {
    if (!headers_sent()) {
        header('Content-Type: application/json; charset=utf-8');
        header('Access-Control-Allow-Origin: *');
        header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
        header('Access-Control-Allow-Headers: Content-Type, Authorization, X-Requested-With');
        http_response_code($statusCode);
    }
    echo json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

// Handle preflight OPTIONS request
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    sendJsonResponse(['status' => 'ok']);
}
