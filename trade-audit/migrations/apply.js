/* Idempotent migration runner: node migrations/apply.js */
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const db = new Database(path.join(__dirname, "..", "data", "trade_audit.db"));
const files = fs.readdirSync(__dirname).filter((f) => f.endsWith(".sql")).sort();
for (const f of files) {
  const sql = fs.readFileSync(path.join(__dirname, f), "utf8");
  const cols = db.prepare("PRAGMA table_info(trades)").all().map((c) => c.name);
  if (cols.includes("underlying_spot")) { console.log(`skip ${f} (column exists)`); continue; }
  db.exec(sql);
  console.log(`applied ${f}`);
}
const n = db.prepare("SELECT COUNT(*) AS n FROM trades").get().n;
const nulls = db.prepare("SELECT COUNT(*) AS n FROM trades WHERE underlying_spot IS NULL").get().n;
console.log(`trades=${n} underlying_spot NULL=${nulls} (premium never copied)`);
