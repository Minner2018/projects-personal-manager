import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";

type Mode = "conservative" | "aggressive" | "rollback" | "status";

const mode = (process.argv[2] ?? "conservative") as Mode;

if (!["conservative", "aggressive", "rollback", "status"].includes(mode)) {
  console.error(`
Usage:
  npx tsx patch-codex-logs-sqljs.ts conservative
  npx tsx patch-codex-logs-sqljs.ts aggressive
  npx tsx patch-codex-logs-sqljs.ts rollback
  npx tsx patch-codex-logs-sqljs.ts status
`);
  process.exit(1);
}

const require = createRequire(import.meta.url);

const codexDir = path.join(os.homedir(), ".codex");
const dbPath = path.join(codexDir, "logs_2.sqlite");
const walPath = `${dbPath}-wal`;
const shmPath = `${dbPath}-shm`;

function exists(p: string): boolean {
  return fs.existsSync(p);
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function nowStamp(): string {
  return new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);
}

function backupLogs(): string {
  const backupDir = path.join(os.homedir(), `codex-logs2-backup-${nowStamp()}`);
  fs.mkdirSync(backupDir, { recursive: true });

  for (const file of fs.readdirSync(codexDir)) {
    if (file.startsWith("logs_2.sqlite")) {
      fs.copyFileSync(path.join(codexDir, file), path.join(backupDir, file));
    }
  }

  return backupDir;
}

function removeWalShmAfterBackup() {
  // sql.js 只直接修改主 sqlite 文件，不会正确处理 SQLite WAL。
  // Codex 完全退出且已备份后，删除 WAL/SHM 可以避免旧 WAL 覆盖或干扰新主库。
  // 代价：会丢弃未 checkpoint 的本地日志；这里处理的是 feedback logs，通常可接受。
  for (const p of [walPath, shmPath]) {
    if (exists(p)) {
      fs.rmSync(p, { force: true });
      console.log(`已删除: ${p}`);
    }
  }
}

function getRows(db: any, sql: string): Record<string, any>[] {
  const result = db.exec(sql);
  if (result.length === 0) return [];

  const { columns, values } = result[0];

  return values.map((row: any[]) => {
    const obj: Record<string, any> = {};
    columns.forEach((col: string, i: number) => {
      obj[col] = row[i];
    });
    return obj;
  });
}

function getTables(db: any): string[] {
  return getRows(
    db,
    `
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
    ORDER BY name
    `,
  ).map((r) => String(r.name));
}

function getTriggers(db: any): Array<{ name: string; tbl_name: string }> {
  return getRows(
    db,
    `
    SELECT name, tbl_name
    FROM sqlite_master
    WHERE type = 'trigger'
      AND name LIKE 'codex_local_filter_noisy_logs_%'
    ORDER BY name
    `,
  ).map((r) => ({
    name: String(r.name),
    tbl_name: String(r.tbl_name),
  }));
}

function getColumns(db: any, table: string): string[] {
  return getRows(db, `PRAGMA table_info(${quoteIdent(table)})`).map((r) =>
    String(r.name),
  );
}

async function main() {
  if (!exists(dbPath)) {
    console.error(`未找到数据库: ${dbPath}`);
    console.error("请先确认 Codex 已经运行过，并且已完全退出 Codex 后再执行。");
    process.exit(1);
  }

  if (mode !== "status") {
    console.log("请确认 Codex 已完全退出；否则可能丢失正在写入的本地日志。");
    const backupDir = backupLogs();
    console.log(`已备份 logs_2.sqlite* 到: ${backupDir}`);
    removeWalShmAfterBackup();
  }

  const SQL = await initSqlJs({
    locateFile: (file: string) => require.resolve(`sql.js/dist/${file}`),
  });

  const fileBuffer = fs.readFileSync(dbPath);
  const db = new SQL.Database(fileBuffer);

  const tables = getTables(db);
  const triggers = getTriggers(db);

  if (mode === "status") {
    console.log("当前本地过滤 triggers:");
    if (triggers.length === 0) {
      console.log("  无");
    } else {
      for (const t of triggers) {
        console.log(`  ${t.name} ON ${t.tbl_name}`);
      }
    }

    console.log("\n候选日志表:");
    for (const table of tables) {
      const cols = getColumns(db, table);
      const hasTarget = cols.some((c) => c.toLowerCase() === "target");
      const hasLevel = cols.some((c) => c.toLowerCase() === "level");

      if (hasTarget) {
        console.log(
          `  ${table} columns=[${cols.join(", ")}] level=${hasLevel}`,
        );
      }
    }

    db.close();
    return;
  }

  if (mode === "rollback") {
    for (const t of triggers) {
      db.run(`DROP TRIGGER IF EXISTS ${quoteIdent(t.name)}`);
      console.log(`已删除 trigger: ${t.name}`);
    }

    if (triggers.length === 0) {
      console.log("没有发现需要删除的本地过滤 trigger。");
    }

    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
    db.close();

    console.log("已回滚并写回数据库。");
    return;
  }

  const patched: string[] = [];

  db.run("BEGIN TRANSACTION");

  try {
    for (const table of tables) {
      const cols = getColumns(db, table);
      const byLower = new Map(cols.map((c) => [c.toLowerCase(), c]));

      const targetCol = byLower.get("target");
      const levelCol = byLower.get("level");

      if (!targetCol) continue;

      const triggerName = `codex_local_filter_noisy_logs_${table}`;

      let condition = `
        NEW.${quoteIdent(targetCol)} = 'log'
        OR NEW.${quoteIdent(targetCol)} = 'codex_otel.log_only'
        OR NEW.${quoteIdent(targetCol)} = 'codex_otel.trace_safe'
      `;

      if (mode === "aggressive") {
        if (levelCol) {
          condition = `
            ${condition}
            OR (
              UPPER(CAST(NEW.${quoteIdent(levelCol)} AS TEXT)) = 'TRACE'
              AND (
                NEW.${quoteIdent(targetCol)} LIKE 'codex_api::endpoint::responses_websocket%'
                OR NEW.${quoteIdent(targetCol)} LIKE 'codex_api::sse::responses%'
                OR NEW.${quoteIdent(targetCol)} LIKE 'codex_client::transport%'
                OR LOWER(CAST(NEW.${quoteIdent(targetCol)} AS TEXT)) LIKE '%websocket%'
                OR LOWER(CAST(NEW.${quoteIdent(targetCol)} AS TEXT)) LIKE '%sse%'
              )
            )
          `;
        } else {
          condition = `
            ${condition}
            OR NEW.${quoteIdent(targetCol)} LIKE 'codex_api::endpoint::responses_websocket%'
            OR NEW.${quoteIdent(targetCol)} LIKE 'codex_api::sse::responses%'
            OR NEW.${quoteIdent(targetCol)} LIKE 'codex_client::transport%'
            OR LOWER(CAST(NEW.${quoteIdent(targetCol)} AS TEXT)) LIKE '%websocket%'
            OR LOWER(CAST(NEW.${quoteIdent(targetCol)} AS TEXT)) LIKE '%sse%'
          `;
        }
      }

      const sql = `
        CREATE TRIGGER IF NOT EXISTS ${quoteIdent(triggerName)}
        BEFORE INSERT ON ${quoteIdent(table)}
        FOR EACH ROW
        WHEN ${condition}
        BEGIN
          SELECT RAISE(IGNORE);
        END;
      `;

      db.run(sql);
      patched.push(table);
    }

    db.run("COMMIT");
  } catch (err) {
    db.run("ROLLBACK");
    db.close();
    throw err;
  }

  if (patched.length === 0) {
    console.log("没有找到包含 target 字段的日志表，未添加 trigger。");
  } else {
    console.log(`已添加/确认 ${patched.length} 个本地过滤 trigger:`);
    for (const table of patched) {
      console.log(`  ${table}`);
    }
  }

  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
  db.close();

  console.log(`
完成。

建议现在启动 Codex，然后用资源监视器或 Procmon 观察:
  ${dbPath}
  ${walPath}
  ${shmPath}
`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});