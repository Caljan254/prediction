-- Betika Analyst Hub MySQL Schema
-- Compatible with MySQL 5.7+, MySQL 8.0+, MariaDB (InfinityFree & Local)

CREATE DATABASE IF NOT EXISTS `betika_hub` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `betika_hub`;

-- 1. Matches & Predictions Table
CREATE TABLE IF NOT EXISTS `matches` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `game_id` VARCHAR(64) NOT NULL,
    `match_id` VARCHAR(64) NOT NULL,
    `parent_match_id` VARCHAR(64) DEFAULT NULL,
    `home_team` VARCHAR(128) NOT NULL,
    `away_team` VARCHAR(128) NOT NULL,
    `competition_name` VARCHAR(128) NOT NULL,
    `category` VARCHAR(64) DEFAULT 'Soccer',
    `start_time` DATETIME NOT NULL,
    `match_date` DATE NOT NULL,
    `match_time` VARCHAR(16) NOT NULL,
    `status` ENUM('Pending', 'Live', 'Won', 'Lost') NOT NULL DEFAULT 'Pending',
    `result` VARCHAR(32) NOT NULL DEFAULT '—',
    `live_minute` VARCHAR(32) DEFAULT NULL,
    `home_score` INT DEFAULT NULL,
    `away_score` INT DEFAULT NULL,
    `odds_home` DECIMAL(6,2) NOT NULL DEFAULT 1.00,
    `odds_draw` DECIMAL(6,2) NOT NULL DEFAULT 1.00,
    `odds_away` DECIMAL(6,2) NOT NULL DEFAULT 1.00,
    `odds_over25` DECIMAL(6,2) DEFAULT NULL,
    `odds_under25` DECIMAL(6,2) DEFAULT NULL,
    `odds_btts` DECIMAL(6,2) DEFAULT NULL,
    `prediction` VARCHAR(64) NOT NULL,
    `prediction_type` VARCHAR(32) NOT NULL DEFAULT '1X2',
    `confidence` INT NOT NULL DEFAULT 70,
    `sources_count` INT NOT NULL DEFAULT 3,
    `sources_summary` VARCHAR(255) DEFAULT NULL,
    `tactical_notes` TEXT DEFAULT NULL,
    `analysis_json` LONGTEXT DEFAULT NULL,
    `checked_at` DATETIME DEFAULT NULL,
    `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uniq_match` (`game_id`, `match_id`),
    INDEX `idx_start_time` (`start_time`),
    INDEX `idx_status` (`status`),
    INDEX `idx_league` (`competition_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Accumulator Tickets Table
CREATE TABLE IF NOT EXISTS `accumulator_tickets` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `ticket_ref` VARCHAR(64) NOT NULL UNIQUE,
    `ticket_name` VARCHAR(128) NOT NULL,
    `stake` DECIMAL(10,2) NOT NULL DEFAULT 100.00,
    `total_odds` DECIMAL(10,2) NOT NULL DEFAULT 1.00,
    `potential_win` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    `status` ENUM('Pending', 'Won', 'Lost') NOT NULL DEFAULT 'Pending',
    `legs_json` LONGTEXT NOT NULL,
    `legs_count` INT NOT NULL DEFAULT 0,
    `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX `idx_ticket_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Prediction Sources & Community Picks Table
CREATE TABLE IF NOT EXISTS `prediction_sources` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `source_name` VARCHAR(64) NOT NULL,
    `match_id` VARCHAR(64) DEFAULT NULL,
    `match_teams` VARCHAR(255) NOT NULL,
    `pick` VARCHAR(64) NOT NULL,
    `confidence` INT NOT NULL DEFAULT 75,
    `notes` TEXT DEFAULT NULL,
    `status` ENUM('Pending', 'Won', 'Lost') NOT NULL DEFAULT 'Pending',
    `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. App Settings Table
CREATE TABLE IF NOT EXISTS `system_settings` (
    `setting_key` VARCHAR(64) PRIMARY KEY,
    `setting_value` TEXT NOT NULL,
    `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. Admin Users Table
CREATE TABLE IF NOT EXISTS `users` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `username` VARCHAR(64) NOT NULL UNIQUE,
    `password_hash` VARCHAR(255) NOT NULL,
    `role` VARCHAR(32) NOT NULL DEFAULT 'admin',
    `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
