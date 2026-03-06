// db.js
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'tweets.db'));

// Create table if not exists
db.exec(`
  CREATE TABLE IF NOT EXISTS tweets (
    id TEXT PRIMARY KEY,
    link TEXT NOT NULL,
    is_open INTEGER DEFAULT 0,
    retry_count INTEGER DEFAULT 0,
    fetchedAt TEXT,
    processedAt TEXT
  )
`);

module.exports = db;