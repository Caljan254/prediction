<?php
/**
 * Betika Analyst Hub - Database Connection & Schema Auto-migrator
 */

require_once __DIR__ . '/config.php';

class Database {
    private static ?PDO $instance = null;

    public static function getConnection(): PDO {
        if (self::$instance === null) {
            try {
                // First attempt connection to specified database
                $dsn = sprintf('mysql:host=%s;port=%s;dbname=%s;charset=%s', DB_HOST, DB_PORT, DB_NAME, DB_CHARSET);
                $options = [
                    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                    PDO::ATTR_EMULATE_PREPARES => false,
                ];
                
                try {
                    self::$instance = new PDO($dsn, DB_USER, DB_PASS, $options);
                } catch (PDOException $e) {
                    // If database doesn't exist (e.g. fresh local install), try creating it
                    if ($e->getCode() == 1049) {
                        self::createDatabaseIfNotExists();
                        self::$instance = new PDO($dsn, DB_USER, DB_PASS, $options);
                    } else {
                        throw $e;
                    }
                }

                // Ensure schema tables exist
                self::ensureTablesExist(self::$instance);

            } catch (PDOException $e) {
                sendJsonResponse([
                    'success' => false,
                    'error' => 'Database connection failed: ' . $e->getMessage(),
                    'hint' => 'Check MySQL host, user, password and ensure MySQL server is running.'
                ], 500);
            }
        }
        return self::$instance;
    }

    private static function createDatabaseIfNotExists(): void {
        try {
            $rootDsn = sprintf('mysql:host=%s;port=%s;charset=%s', DB_HOST, DB_PORT, DB_CHARSET);
            $rootPdo = new PDO($rootDsn, DB_USER, DB_PASS, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
            $rootPdo->exec("CREATE DATABASE IF NOT EXISTS `" . DB_NAME . "` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
        } catch (PDOException $e) {
            // Some shared hosts (like InfinityFree) don't allow CREATE DATABASE from scripts; database must be created via cPanel
        }
    }

    public static function ensureTablesExist(PDO $pdo): void {
        static $checked = false;
        if ($checked) return;
        $checked = true;

        $check = $pdo->query("SHOW TABLES LIKE 'matches'")->fetchAll();
        if (empty($check)) {
            $schemaFile = __DIR__ . '/../database/schema.sql';
            if (file_exists($schemaFile)) {
                $sql = file_get_contents($schemaFile);
                // Remove CREATE DATABASE and USE statements for shared host compatibility
                $sql = preg_replace('/CREATE DATABASE[^;]+;/i', '', $sql);
                $sql = preg_replace('/USE[^;]+;/i', '', $sql);
                $pdo->exec($sql);
            }
        }
    }
}

function getDb(): PDO {
    return Database::getConnection();
}
