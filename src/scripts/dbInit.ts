/** Apply db/schema.sql. Idempotent (uses CREATE TABLE IF NOT EXISTS). */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pool } from "../db/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const sql = readFileSync(join(__dirname, "../db/schema.sql"), "utf8");
  await pool.query(sql);
  console.log("Schema applied ✅");
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
