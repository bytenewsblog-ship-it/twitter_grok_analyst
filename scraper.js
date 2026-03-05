// connect-scrape.js
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

(async () => {

  const browser = await puppeteer.connect({
    browserURL: 'http://127.0.0.1:9222',
    defaultViewport: null,
  });

  const rawChannels = process.argv.slice(2);
  const defaults = [
    'https://x.com/CNBCTV18Live',
    'https://x.com/ETNOWlive',
  ];

  const channels = rawChannels.length
    ? rawChannels.map(c => c.startsWith('http') ? c : `https://x.com/${c}`)
    : defaults;

  console.log('monitoring channels:');
  channels.forEach(c => console.log('  ', c));

  const pages = [];
  for (const url of channels) {
    const p = await browser.newPage();
    await p.goto(url, { waitUntil: 'networkidle2' });
    pages.push({ page: p, url });
  }

  const delay = ms => new Promise(r => setTimeout(r, ms));

  async function slowScroll(p, targetY, duration) {
    await p.evaluate((target, duration) => {
      const start = window.scrollY;
      const distance = target - start;
      const steps = Math.max(Math.floor(duration / 100), 1);
      const interval = duration / steps;
      const scrollStep = distance / steps;
      let current = 0;
      let pauseCounter = 0;
      const pauseEveryNSteps = Math.max(Math.floor(20 / (interval / 100)), 1);

      function step() {
        if (current < steps) {
          window.scrollBy(0, scrollStep);
          current++;
          pauseCounter++;

          if (pauseCounter >= pauseEveryNSteps) {
            pauseCounter = 0;
            const pauseDuration = 2000 + Math.random() * 1000;
            setTimeout(step, interval + pauseDuration);
          } else {
            setTimeout(step, interval);
          }
        }
      }
      step();
    }, targetY, duration);
  }

  // ────────────────────────────────────────────────
  //  IST time in ISO-like format (SQLite DATETIME ke liye best)
  // ────────────────────────────────────────────────
  function getISTTime() {
    const now = new Date();
    const options = {
      timeZone: 'Asia/Kolkata',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false
    };
    const parts = new Intl.DateTimeFormat('en-GB', options).formatToParts(now);
    const obj = {};
    parts.forEach(p => { if (p.type !== 'literal') obj[p.type] = p.value; });
    // Returns: '2025-03-03 20:45:12'
    return `${obj.year}-${obj.month}-${obj.day} ${obj.hour}:${obj.minute}:${obj.second}`;
  }

  // ────────────────────────────────────────────────
  //          SQLite setup – fetchedAt & processedAt as TEXT (ISO format)
  // ────────────────────────────────────────────────
  const db = new Database('tweets.db', { verbose: console.log });

  db.exec(`
    CREATE TABLE IF NOT EXISTS tweets (
      id TEXT PRIMARY KEY,
      link TEXT NOT NULL,
      is_open INTEGER DEFAULT 0,
      retry_count INTEGER DEFAULT 0,
      fetchedAt TEXT,          -- ISO format: '2025-03-03 20:45:12'
      processedAt TEXT         -- same format, NULL until processed
    )
  `);

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO tweets (id, link, fetchedAt)
    VALUES (?, ?, ?)
  `);

  const JSON_FILE = path.join(__dirname, 'database.json');

  function syncJson() {
    try {
      const rows = db.prepare('SELECT * FROM tweets ORDER BY fetchedAt DESC').all();
      fs.writeFileSync(JSON_FILE, JSON.stringify(rows, null, 2));
      console.log(`🔄 JSON synced: ${rows.length} records`);
    } catch (err) {
      console.error('JSON sync failed:', err.message);
    }
  }

  // Process results → insert into SQLite
  function processResults(results) {
    let added = 0;

    for (const item of results) {
      if (!item.link) continue;

      const m = item.link.match(/\/status\/(\d+)/);
      if (!m) continue;

      const id = m[1]; // string

      const fetchedTime = getISTTime();

      const info = insertStmt.run(id, item.link, fetchedTime);

      if (info.changes > 0) {
        added++;
        console.debug('new tweet added:', item.link, 'at', fetchedTime);
      }
    }

    if (added > 0) {
      syncJson();
    }

    return added;
  }

  async function scrapePage(p) {
    await p.bringToFront();

    const holdAfterLoad = 30000 + Math.random() * 10000;
    console.log(`holding ${Math.round(holdAfterLoad)}ms for ${p.url()} load`);
    await delay(holdAfterLoad);

    console.log('scrolling top->mid slowly');
    const half = await p.evaluate(() => document.body.scrollHeight / 2);
    await slowScroll(p, half, 5000);

    const pause = 3000 + Math.random() * 1000;
    await delay(pause);

    console.log('scrolling mid->top slowly');
    await slowScroll(p, 0, 5000);

    const batch = await p.evaluate(() => {
      const tweets = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
      return tweets.map(tweet => {
        const linkEl = tweet.querySelector('a[href*="/status/"]:not([href*="/photo/"]):not([href*="/analytics/"])');
        const link = linkEl ? "https://x.com" + linkEl.getAttribute("href") : null;
        return { link };
      });
    });

    return batch;
  }

  // Initial scrape
  let totalNew = 0;
  for (const { page: p, url } of pages) {
    console.log('initial scrape for', url);
    const res = await scrapePage(p);
    totalNew += processResults(res);
  }

  console.log(`initial pass, ${totalNew} new entries`);

  // Infinite monitoring loop
  while (true) {
    for (const { page: p, url } of pages) {

      const waitReload = 16000 + Math.random() * 4000;
      console.log(`waiting ${Math.round(waitReload)}ms before reload on ${url}`);
      await delay(waitReload);

      console.log('reloading', url);
      await p.reload({ waitUntil: 'networkidle2' });

      const hold = 30000 + Math.random() * 10000;
      console.log(`holding ${Math.round(hold)}ms for ${url} load`);
      await delay(hold);

      console.log('scrolling top->mid slowly');
      const half = await p.evaluate(() => document.body.scrollHeight / 2);
      await slowScroll(p, half, 5000);

      const pause = 3000 + Math.random() * 1000;
      await delay(pause);

      console.log('scrolling mid->top slowly');
      await slowScroll(p, 0, 5000);

      const batch = await p.evaluate(() => {
        const tweets = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
        return tweets.map(tweet => {
          const linkEl = tweet.querySelector('a[href*="/status/"]:not([href*="/photo/"]):not([href*="/analytics/"])');
          const link = linkEl ? "https://x.com" + linkEl.getAttribute("href") : null;
          return { link };
        });
      });

      console.log('scraped', batch.length, 'tweets on', url);
      const addedNow = processResults(batch);
      console.log(`added ${addedNow} new tweets for ${url}`);
    }
  }

})();