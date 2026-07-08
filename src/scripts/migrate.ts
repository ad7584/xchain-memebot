/**
 * Migration runner. Applies migrations/*.sql in order, once each, tracked in the
 * `_migrations` table. Each file runs in its own transaction.
 *
 *   npm run db:migrate
 *
 * Migrations live at the project root so they ship in both `tsx` (src) and
 * compiled (dist) layouts — both are two dirs below root.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { pool } from "../db/index.js";

const dir = fileURLToPath(new URL("../../migrations", import.meta.url));

// Fixed key so every instance contends on the same advisory lock.
const MIGRATE_LOCK_KEY = 727274;

async function main() {
  // One dedicated connection holds the advisory lock for the whole run, so
  // concurrent replicas boot-migrate one at a time (no races / crash-loops).
  const client = await pool.connect();
  let ran = 0;
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATE_LOCK_KEY]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS _migrations (
         name TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`
    );
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    const { rows } = await client.query<{ name: string }>("SELECT name FROM _migrations");
    const applied = new Set(rows.map((r) => r.name));

    for (const f of files) {
      if (applied.has(f)) continue;
      const sql = readFileSync(join(dir, f), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO _migrations (name) VALUES ($1)", [f]);
        await client.query("COMMIT");
        console.log(`applied ${f}`);
        ran++;
      } catch (e) {
        await client.query("ROLLBACK");
        console.error(`FAILED ${f}:`, e);
        throw e;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATE_LOCK_KEY]).catch(() => {});
    client.release();
  }
  console.log(ran === 0 ? "No new migrations." : `Applied ${ran} migration(s). ✅`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
