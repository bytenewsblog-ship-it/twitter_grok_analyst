// connect-scrape.js

const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');
const db = require('./db');

const analysisPath = path.join(__dirname, 'analysis.json');
const jsonMirrorPath = path.join(__dirname, 'database.json');

let isProcessing = false;

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// IST time in proper format (same as your scraper)
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
  return `${obj.year}-${obj.month}-${obj.day} ${obj.hour}:${obj.minute}:${obj.second}`;
}

async function syncJsonMirror() {
  const rows = db.prepare(`
    SELECT * FROM tweets ORDER BY fetchedAt ASC
  `).all();

  await fs.writeFile(jsonMirrorPath, JSON.stringify(rows, null, 2));
  console.log("JSON mirror synced");
}

// ================================
// START WORKER
// ================================

(async () => {
  const browser = await puppeteer.connect({
    browserURL: 'http://127.0.0.1:9222',
    defaultViewport: null,
  });

  const page = await browser.newPage();

  console.log("🚀 Worker started. Opening Grok...");

  await page.goto('https://grok.com/project/1e6c39c3-38b8-4038-9b7c-e44a3467f414', {
    waitUntil: 'networkidle2'
  });

  await delay(randomDelay(7000, 12000));

  console.log("✅ Grok ready. Monitoring SQLite...");

  while (true) {
    try {
      if (!isProcessing) {
        await checkAndProcess(page);
      }
    } catch (err) {
      console.error("Loop error:", err.message);
    }
    await delay(5000);
  }
})();

// ================================
// CHECK & PROCESS
// ================================

async function checkAndProcess(page) {
  isProcessing = true;

  const target = db.prepare(`
    SELECT id, link, fetchedAt, is_open, retry_count
    FROM tweets
    WHERE is_open = 0
      AND (retry_count IS NULL OR retry_count < 3)
    ORDER BY fetchedAt ASC
    LIMIT 1
  `).get();

  if (!target) {
    console.log("No pending records at the moment");
    isProcessing = false;
    return;
  }

  console.log("📌 Processing:", target.link, "| fetchedAt:", target.fetchedAt, "| retry:", target.retry_count ?? 0);

  let success = false;

  try {
    await delay(randomDelay(6000, 10000));

    await page.evaluate((link) => {
      const box = document.querySelector('[contenteditable="true"].ProseMirror');
      if (!box) throw new Error("Input box not found");

      box.focus();
      box.innerHTML = `<p>${link}</p>`;
      box.dispatchEvent(new Event('input', { bubbles: true }));
    }, target.link);

    await delay(randomDelay(5000, 8000));
    await page.keyboard.press('Enter');

    console.log("⏳ Waiting for Grok response...");

    await delay(randomDelay(12000, 18000));

    await waitForFullResponse(page, target.link);

    const analysis = await extractStructuredData(page, target.link);

    console.log("✅ Extracted:", analysis);

    if (!analysis?.ID || analysis.ID.length < 10 || !target.link.includes(analysis.ID)) {
      throw new Error(`Invalid extraction - ID issue (got: ${analysis?.ID || 'missing'})`);
    }

    // Ab yaha UTC nahi, IST use kar rahe hain
    const now = getISTTime();

    db.prepare(`
      UPDATE tweets
      SET is_open = 1,
          processedAt = ?,
          retry_count = 0
      WHERE id = ?
    `).run(now, target.id);

    const verify = db.prepare("SELECT is_open, processedAt FROM tweets WHERE id = ?").get(target.id);
    console.log("After update → is_open:", verify?.is_open, "processedAt:", verify?.processedAt);

    if (verify?.is_open !== 1) {
      throw new Error("Update failed - is_open still 0");
    }

    console.log("✅ Marked as open in SQLite");

    await syncJsonMirror();

    let analyses = [];
    try {
      analyses = JSON.parse(await fs.readFile(analysisPath, 'utf8'));
    } catch (e) {}

    analyses.push({
      original_link: target.link,
      fetchedAt: target.fetchedAt,
      processedAt: now,
      ...analysis
    });

    await fs.writeFile(analysisPath, JSON.stringify(analyses, null, 2));

    console.log("💾 Saved & Completed");
    success = true;

    await page.evaluate(() => {
      const box = document.querySelector('[contenteditable="true"].ProseMirror');
      if (box) box.innerHTML = '';
    });

  } catch (err) {
    console.error("❌ Processing error:", err.message);

    const row = db.prepare("SELECT retry_count FROM tweets WHERE id = ?").get(target.id);
    const retry = row?.retry_count ?? 0;

    if (retry >= 2) {
      console.log("⛔ Max retries. Marking open anyway.");
      const now = getISTTime();  // yaha bhi IST
      db.prepare("UPDATE tweets SET is_open = 1, processedAt = ? WHERE id = ?").run(now, target.id);
    } else {
      db.prepare("UPDATE tweets SET retry_count = COALESCE(retry_count, 0) + 1 WHERE id = ?").run(target.id);
      console.log("🔁 Retry increased");
    }

    await page.screenshot({ path: `error-${target.id || 'unknown'}-${Date.now()}.png` });

    await page.reload({ waitUntil: 'networkidle2' });
    await delay(8000);
  }

  isProcessing = false;
}

// waitForFullResponse aur extractStructuredData same rahe (tumhare paas already sahi hai)

async function waitForFullResponse(page, sentLink) {
  try {
    console.log("Waiting for structured response...");

    await page.waitForFunction((link) => {
      const containers = document.querySelectorAll('.response-content-markdown');
      if (containers.length < 2) return false;

      let hasUserMessage = false;
      let hasStructuredResponse = false;

      for (const el of containers) {
        const text = el.innerText.trim();
        if (text.includes(link) || text.includes(link.split('/status/')[1])) {
          hasUserMessage = true;
        }
        if (text.includes('ID') && text.length > 350 &&
            (text.includes('Level') || text.includes('Score') || text.includes('Summary'))) {
          hasStructuredResponse = true;
        }
      }

      return hasUserMessage && hasStructuredResponse;
    }, { timeout: 300000 }, sentLink);

    let prevLength = -1;
    for (let i = 0; i < 16; i++) {
      await delay(5000);

      const currentText = await page.evaluate(() => {
        const els = document.querySelectorAll('.response-content-markdown');
        return els.length > 0 ? els[els.length - 1].innerText.trim() : '';
      });

      if (currentText.length === prevLength && currentText.length > 500) {
        console.log("Response seems stable");
        break;
      }
      prevLength = currentText.length;
    }

    await delay(4000);
  } catch (err) {
    console.error("Wait failed:", err.message);
    console.log("Trying best-effort extraction anyway...");
  }
}

async function extractStructuredData(page, sentLink) {
  return await page.evaluate((sentLink) => {
    const result = {
      ID: "",
      Level: "",
      Score: "",
      Post_Summary: "",
      Key_Highlights: "",
      Sector_Impact: "",
      Stocks_Highly_Affected: "",
      Trade_Logic: "",
      Confirmation_Signal: "",
      Overall_Comment: ""
    };

    const containers = Array.from(document.querySelectorAll('.response-content-markdown'));
    if (containers.length < 2) {
      console.log("[EXTRACTION] Not enough containers");
      return result;
    }

    let responseContainer = null;

    let userIndex = -1;
    for (let i = 0; i < containers.length; i++) {
      const text = containers[i].innerText.trim();
      if (text.includes(sentLink) || text.includes(sentLink.split('/status/')[1])) {
        userIndex = i;
        break;
      }
    }

    if (userIndex !== -1 && userIndex + 1 < containers.length) {
      responseContainer = containers[userIndex + 1];
      console.log("[EXTRACTION] Found response using anchor");
    } else {
      console.log("[EXTRACTION] Anchor failed → fallback");
      responseContainer = containers[containers.length - 1];
      const lastText = responseContainer.innerText.trim();
      if (!lastText.includes('ID') && containers.length >= 2) {
        responseContainer = containers[containers.length - 2];
      }
    }

    if (!responseContainer) return result;

    const text = responseContainer.innerText.trim();
    console.log("[EXTRACTION] Selected text length:", text.length);

    if (text.length < 250 || !text.includes('ID')) {
      console.warn("[EXTRACTION] Invalid block");
      return result;
    }

    const lines = text.split('\n').map(l => l.trim()).filter(l => l);

    let currentKey = null;
    for (const line of lines) {
      const match = line.match(/^(?:\*\*)?([^:*]+?)(?:\*\*)?\s*[:：]\s*(.*)$/i);
      if (match) {
        let label = match[1].trim()
          .replace(/\s+/g, '_')
          .replace(/[^a-zA-Z0-9_]/g, '');

        const value = match[2].trim();

        if (label.match(/post.?summary/i))     label = "Post_Summary";
        if (label.match(/key.?highlights/i))   label = "Key_Highlights";
        if (label.match(/sector.?impact/i))    label = "Sector_Impact";
        if (label.match(/stocks?.*affected/i)) label = "Stocks_Highly_Affected";
        if (label.match(/trade.?logic/i))      label = "Trade_Logic";
        if (label.match(/confirmation/i))      label = "Confirmation_Signal";
        if (label.match(/overall/i))           label = "Overall_Comment";

        if (label in result) {
          result[label] = value;
          currentKey = label;
        } else {
          currentKey = null;
        }
      } else if (currentKey && line) {
        result[currentKey] += " " + line;
      }
    }

    if (!result.Overall_Comment && lines.length > 2) {
      result.Overall_Comment = lines[lines.length - 1];
    }

    result.ID = result.ID.replace(/[^0-9]/g, '').trim();

    return result;
  }, sentLink);
}