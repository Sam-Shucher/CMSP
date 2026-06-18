-- Run once: mysql -u root -p < backend/src/db/schema.sql

CREATE DATABASE IF NOT EXISTS mini_library
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE mini_library;

-- Invite list — only emails here can register
CREATE TABLE IF NOT EXISTS approved_emails (
  id       INT PRIMARY KEY AUTO_INCREMENT,
  email    VARCHAR(255) UNIQUE NOT NULL,
  added_by INT NULL,
  added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id            INT PRIMARY KEY AUTO_INCREMENT,
  email         VARCHAR(255) UNIQUE NOT NULL,
  username      VARCHAR(50)  UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name  VARCHAR(100) NOT NULL,
  role          ENUM('user', 'admin') DEFAULT 'user',
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS minis (
  id          INT PRIMARY KEY AUTO_INCREMENT,
  name        VARCHAR(255) NOT NULL,
  description TEXT,
  owner_id    INT NOT NULL,
  image_path  VARCHAR(500),
  available   BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tags (
  id   INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(100) UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS mini_tags (
  mini_id INT NOT NULL,
  tag_id  INT NOT NULL,
  PRIMARY KEY (mini_id, tag_id),
  FOREIGN KEY (mini_id) REFERENCES minis(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id)  REFERENCES tags(id)  ON DELETE CASCADE
);

-- Bootstrap: add your own email so you can be the first to register
-- INSERT INTO approved_emails (email) VALUES ('your@email.com');
-- After registering, promote yourself to admin:
-- UPDATE users SET role = 'admin' WHERE email = 'your@email.com';