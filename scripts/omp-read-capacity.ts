import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Database, type Statement } from "bun:sqlite";

/**
 * OMP 文本阅读能力的仓库级并发配置。
 */
export interface OmpReadCapacityConfig {
  maxGlobalConcurrent: number;
  maxPerCallerConcurrent: number;
  maxQueueSeconds: number;
  heartbeatSeconds: number;
  staleAfterSeconds: number;
  maxLeaseSeconds: number;
}

/**
 * 容量获取失败时供调用方稳定识别的错误码。
 */
export type OmpReadCapacityErrorCode =
  | "caller_busy"
  | "capacity_timeout"
  | "capacity_config_invalid";

/**
 * OMP 容量调度产生的可分类错误。
 */
export class OmpReadCapacityError extends Error {
  constructor(
    public readonly code: OmpReadCapacityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OmpReadCapacityError";
  }
}

/**
 * 已取得的调用者槽位和全局槽位；调用完成后必须释放。
 */
export interface OmpReadCapacityLease {
  callerId: string;
  callerSlot: number;
  globalSlot: number;
  queueDurationMs: number;
  attachChildProcess(pid: number): Promise<void>;
  release(): Promise<void>;
}

/**
 * 获取容量时允许测试或嵌入方覆盖的运行参数。
 */
export interface AcquireOmpReadCapacityOptions {
  projectRoot: string;
  callerId: string;
  runId: string;
  config: OmpReadCapacityConfig;
  runtimeRoot?: string;
  queueTimeoutMsOverride?: number;
  heartbeatIntervalMsOverride?: number;
  staleAfterMsOverride?: number;
  maxLeaseMsOverride?: number;
  pollIntervalMsOverride?: number;
}

interface LeaseOwnerRow {
  leaseId: string;
  ownerPid: number;
  childPid: number | null;
  createdAtMs: number;
}

interface SlotRow {
  slot: number;
}

const DEFAULT_CONFIG_RELATIVE_PATH = path.join(".omp", "omp-read-config.json");
const DEFAULT_RUNTIME_RELATIVE_PATH = path.join(
  ".omp",
  "runtime",
  "read-capacity",
);
const DATABASE_FILE_NAME = "capacity.sqlite";

function readInteger(
  value: unknown,
  fieldName: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new OmpReadCapacityError(
      "capacity_config_invalid",
      `${fieldName} 必须是 ${minimum} 到 ${maximum} 之间的整数。`,
    );
  }
  return Number(value);
}

/**
 * 读取并校验仓库级 OMP 并发配置。
 *
 * @param projectRoot 当前项目根目录。
 * @param configPath 可选的配置文件路径。
 * @return 经过完整边界校验的并发配置。
 */
export async function loadOmpReadCapacityConfig(
  projectRoot: string,
  configPath = path.join(projectRoot, DEFAULT_CONFIG_RELATIVE_PATH),
): Promise<OmpReadCapacityConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    throw new OmpReadCapacityError(
      "capacity_config_invalid",
      `无法读取 OMP 并发配置：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new OmpReadCapacityError(
      "capacity_config_invalid",
      "OMP 并发配置必须是 JSON 对象。",
    );
  }

  const record = parsed as Record<string, unknown>;
  const config: OmpReadCapacityConfig = {
    maxGlobalConcurrent: readInteger(
      record.maxGlobalConcurrent,
      "maxGlobalConcurrent",
      1,
      32,
    ),
    maxPerCallerConcurrent: readInteger(
      record.maxPerCallerConcurrent,
      "maxPerCallerConcurrent",
      1,
      32,
    ),
    maxQueueSeconds: readInteger(record.maxQueueSeconds, "maxQueueSeconds", 0, 3600),
    heartbeatSeconds: readInteger(
      record.heartbeatSeconds,
      "heartbeatSeconds",
      1,
      300,
    ),
    staleAfterSeconds: readInteger(
      record.staleAfterSeconds,
      "staleAfterSeconds",
      2,
      3600,
    ),
    maxLeaseSeconds: readInteger(
      record.maxLeaseSeconds,
      "maxLeaseSeconds",
      3605,
      86400,
    ),
  };

  if (config.maxPerCallerConcurrent > config.maxGlobalConcurrent) {
    throw new OmpReadCapacityError(
      "capacity_config_invalid",
      "maxPerCallerConcurrent 不能大于 maxGlobalConcurrent。",
    );
  }
  if (config.staleAfterSeconds < config.heartbeatSeconds * 2) {
    throw new OmpReadCapacityError(
      "capacity_config_invalid",
      "staleAfterSeconds 至少应为 heartbeatSeconds 的两倍。",
    );
  }
  if (config.maxLeaseSeconds < config.maxQueueSeconds + 3605) {
    throw new OmpReadCapacityError(
      "capacity_config_invalid",
      "maxLeaseSeconds 必须覆盖最长排队时间和最长 OMP 执行时间。",
    );
  }
  return config;
}

/**
 * 返回指定运行目录中的容量数据库路径。
 *
 * @param runtimeRoot OMP 容量运行目录。
 * @return SQLite 数据库绝对路径。
 */
export function getCapacityDatabasePath(runtimeRoot: string): string {
  return path.join(path.resolve(runtimeRoot), DATABASE_FILE_NAME);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isProcessAlive(pid: number | null): boolean {
  if (pid === null || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && (error.code === "EPERM" || error.code === "EACCES");
  }
}

function initializeDatabase(databasePath: string): Database {
  const database = new Database(databasePath, { create: true, strict: true });
  database.run("PRAGMA busy_timeout = 5000;");
  // 容量分配只有极短写事务；DELETE journal 可避免 Windows WAL 映射延迟释放文件。
  database.run("PRAGMA journal_mode = DELETE;");
  database.run(`
    CREATE TABLE IF NOT EXISTS omp_read_leases (
      kind TEXT NOT NULL CHECK (kind IN ('caller', 'global')),
      scope_key TEXT NOT NULL,
      slot INTEGER NOT NULL,
      lease_id TEXT NOT NULL,
      caller_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      owner_pid INTEGER NOT NULL,
      child_pid INTEGER,
      created_at_ms INTEGER NOT NULL,
      heartbeat_at_ms INTEGER NOT NULL,
      PRIMARY KEY (kind, scope_key, slot)
    );
    CREATE INDEX IF NOT EXISTS idx_omp_read_leases_lease_id
      ON omp_read_leases (lease_id);
    CREATE INDEX IF NOT EXISTS idx_omp_read_leases_heartbeat
      ON omp_read_leases (heartbeat_at_ms);
  `);
  return database;
}

function findFreeSlot(occupiedRows: SlotRow[], slotCount: number): number | null {
  const occupied = new Set(occupiedRows.map((row) => row.slot));
  for (let slot = 0; slot < slotCount; slot += 1) {
    if (!occupied.has(slot)) {
      return slot;
    }
  }
  return null;
}

function deleteExpiredLeases(
  database: Database,
  nowMs: number,
  staleAfterMs: number,
  maxLeaseMs: number,
): void {
  const staleOwners = database
    .query<LeaseOwnerRow, [number]>(`
      SELECT
        lease_id AS leaseId,
        MIN(owner_pid) AS ownerPid,
        MAX(child_pid) AS childPid,
        MIN(created_at_ms) AS createdAtMs
      FROM omp_read_leases
      WHERE heartbeat_at_ms <= ?1
      GROUP BY lease_id
    `);
  const deleteLease = database.query("DELETE FROM omp_read_leases WHERE lease_id = ?1");
  try {
    for (const owner of staleOwners.all(nowMs - staleAfterMs)) {
      const exceededMaximumAge = nowMs - owner.createdAtMs >= maxLeaseMs;
      // 排队阶段尚无子进程，以包装器为准；启动后以真正消耗容量的 OMP 子进程为准。
      const hasLiveProcess =
        owner.childPid === null
          ? isProcessAlive(owner.ownerPid)
          : isProcessAlive(owner.childPid);
      if (exceededMaximumAge || !hasLiveProcess) {
        deleteLease.run(owner.leaseId);
      }
    }
  } finally {
    staleOwners.finalize();
    deleteLease.finalize();
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function runImmediateTransaction<ReturnType>(
  database: Database,
  operation: () => ReturnType,
): ReturnType {
  database.run("BEGIN IMMEDIATE;");
  try {
    const result = operation();
    database.run("COMMIT;");
    return result;
  } catch (error) {
    database.run("ROLLBACK;");
    throw error;
  }
}

/**
 * 使用 SQLite `BEGIN IMMEDIATE` 事务获取调用者槽和仓库全局槽。
 *
 * @param options 调用者身份、运行 ID、配置及可选测试覆盖参数。
 * @return 同时代表调用者配额和全局配额的可释放租约。
 */
export async function acquireOmpReadCapacity(
  options: AcquireOmpReadCapacityOptions,
): Promise<OmpReadCapacityLease> {
  const queueStartedAt = Date.now();
  const runtimeRoot = path.resolve(
    options.runtimeRoot ?? path.join(options.projectRoot, DEFAULT_RUNTIME_RELATIVE_PATH),
  );
  await mkdir(runtimeRoot, { recursive: true });

  const database = initializeDatabase(getCapacityDatabasePath(runtimeRoot));
  const statements: Array<Statement<unknown, unknown[]>> = [];
  const prepare = <ReturnType, Params extends unknown[] = unknown[]>(sql: string) => {
    const statement = database.query<ReturnType, Params>(sql);
    statements.push(statement as Statement<unknown, unknown[]>);
    return statement;
  };
  const closeDatabase = () => {
    for (const statement of statements.splice(0)) {
      statement.finalize();
    }
    database.close(true);
  };
  const queueTimeoutMs =
    options.queueTimeoutMsOverride ?? options.config.maxQueueSeconds * 1000;
  const heartbeatIntervalMs =
    options.heartbeatIntervalMsOverride ?? options.config.heartbeatSeconds * 1000;
  const staleAfterMs =
    options.staleAfterMsOverride ?? options.config.staleAfterSeconds * 1000;
  const maxLeaseMs =
    options.maxLeaseMsOverride ?? options.config.maxLeaseSeconds * 1000;
  const pollIntervalMs = options.pollIntervalMsOverride ?? 250;
  const leaseId = randomUUID();
  const createdAtMs = Date.now();
  const callerScope = options.callerId;

  const insertLease = prepare(`
    INSERT INTO omp_read_leases (
      kind, scope_key, slot, lease_id, caller_id, run_id,
      owner_pid, child_pid, created_at_ms, heartbeat_at_ms
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?8)
  `);
  const selectSlots = prepare<SlotRow, [string, string]>(`
    SELECT slot
    FROM omp_read_leases
    WHERE kind = ?1 AND scope_key = ?2
  `);

  const acquireCallerSlot = (): number | null => runImmediateTransaction(database, () => {
    const nowMs = Date.now();
    deleteExpiredLeases(database, nowMs, staleAfterMs, maxLeaseMs);
    const callerSlot = findFreeSlot(
      selectSlots.all("caller", callerScope),
      options.config.maxPerCallerConcurrent,
    );
    if (callerSlot !== null) {
      insertLease.run(
        "caller",
        callerScope,
        callerSlot,
        leaseId,
        options.callerId,
        options.runId,
        process.pid,
        createdAtMs,
      );
    }
    return callerSlot;
  });
  let callerSlot: number | null;
  try {
    callerSlot = acquireCallerSlot();
  } catch (error) {
    try {
      closeDatabase();
    } catch {
      // 保留容量事务的原始错误，关闭失败由下次进程级清理处理。
    }
    throw error;
  }
  if (callerSlot === null) {
    closeDatabase();
    throw new OmpReadCapacityError(
      "caller_busy",
      `调用者 ${options.callerId} 已达到 OMP 并发上限。`,
    );
  }

  const updateHeartbeat = prepare(`
    UPDATE omp_read_leases
    SET heartbeat_at_ms = ?1
    WHERE lease_id = ?2
  `);
  let heartbeatRunning = false;
  const heartbeatTimer = setInterval(() => {
    if (heartbeatRunning) {
      return;
    }
    heartbeatRunning = true;
    try {
      updateHeartbeat.run(Date.now(), leaseId);
    } catch {
      // 下一次心跳继续尝试；容量操作的 busy_timeout 会处理短暂写锁竞争。
    } finally {
      heartbeatRunning = false;
    }
  }, heartbeatIntervalMs);
  heartbeatTimer.unref();

  try {
    const acquireGlobalSlot = (): number | null => runImmediateTransaction(database, () => {
      const nowMs = Date.now();
      deleteExpiredLeases(database, nowMs, staleAfterMs, maxLeaseMs);
      const globalSlot = findFreeSlot(
        selectSlots.all("global", "repository"),
        options.config.maxGlobalConcurrent,
      );
      if (globalSlot !== null) {
        insertLease.run(
          "global",
          "repository",
          globalSlot,
          leaseId,
          options.callerId,
          options.runId,
          process.pid,
          createdAtMs,
        );
      }
      return globalSlot;
    });

    const queueDeadline = queueStartedAt + queueTimeoutMs;
    let globalSlot: number | null = null;
    while (globalSlot === null) {
      globalSlot = acquireGlobalSlot();
      if (globalSlot !== null) {
        break;
      }
      const remainingMs = queueDeadline - Date.now();
      if (remainingMs <= 0) {
        throw new OmpReadCapacityError(
          "capacity_timeout",
          `等待 OMP 全局容量超过 ${options.config.maxQueueSeconds} 秒。`,
        );
      }
      const jitterMs = Math.floor(Math.random() * Math.max(1, pollIntervalMs / 4));
      await wait(Math.min(remainingMs, pollIntervalMs + jitterMs));
    }

    let released = false;
    const deleteOwnedLease = prepare(
      "DELETE FROM omp_read_leases WHERE lease_id = ?1",
    );
    const attachChild = prepare(`
      UPDATE omp_read_leases
      SET child_pid = ?1, heartbeat_at_ms = ?2
      WHERE lease_id = ?3
    `);
    return {
      callerId: options.callerId,
      callerSlot,
      globalSlot,
      queueDurationMs: Date.now() - queueStartedAt,
      async attachChildProcess(pid: number): Promise<void> {
        if (released || !Number.isInteger(pid) || pid <= 0) {
          return;
        }
        attachChild.run(pid, Date.now(), leaseId);
      },
      async release(): Promise<void> {
        if (released) {
          return;
        }
        released = true;
        clearInterval(heartbeatTimer);
        let releaseError: unknown;
        try {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              runImmediateTransaction(database, () => deleteOwnedLease.run(leaseId));
              releaseError = undefined;
              break;
            } catch (error) {
              releaseError = error;
              if (attempt < 2) {
                await wait(50 * (attempt + 1));
              }
            }
          }
        } finally {
          closeDatabase();
        }
        if (releaseError) {
          throw releaseError;
        }
      },
    };
  } catch (error) {
    clearInterval(heartbeatTimer);
    const cleanupOwnedLease = prepare(
      "DELETE FROM omp_read_leases WHERE lease_id = ?1",
    );
    try {
      runImmediateTransaction(database, () => cleanupOwnedLease.run(leaseId));
    } finally {
      closeDatabase();
    }
    throw error;
  }
}
