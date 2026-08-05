import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import {
  acquireOmpReadCapacity,
  getCapacityDatabasePath,
  loadOmpReadCapacityConfig,
  OmpReadCapacityError,
  type OmpReadCapacityConfig,
  type OmpReadCapacityLease,
} from "./omp-read-capacity.ts";

const currentFile = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(currentFile);
const projectRoot = path.resolve(scriptDirectory, "..");
const runtimeRootsToCleanup: string[] = [];

const baseConfig: OmpReadCapacityConfig = {
  maxGlobalConcurrent: 3,
  maxPerCallerConcurrent: 1,
  maxQueueSeconds: 2,
  heartbeatSeconds: 1,
  staleAfterSeconds: 2,
  maxLeaseSeconds: 10,
};

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withRuntime(
  test: (runtimeRoot: string) => Promise<void>,
): Promise<void> {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "omp-capacity-test-"));
  runtimeRootsToCleanup.push(runtimeRoot);
  await test(runtimeRoot);
}

async function cleanupRuntimeRoots(): Promise<void> {
  // Bun SQLite 在 Windows 上可能直到包装对象 GC 后才释放数据库文件映射。
  (globalThis as { Bun?: { gc(full?: boolean): void } }).Bun?.gc(true);
  for (const runtimeRoot of runtimeRootsToCleanup.splice(0)) {
    try {
      await rm(runtimeRoot, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 50,
      });
    } catch (error) {
      throw new Error(
        `无法清理容量测试目录 ${runtimeRoot}：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

async function acquire(
  runtimeRoot: string,
  callerId: string,
  runId: string,
  config: OmpReadCapacityConfig = baseConfig,
  overrides: {
    queueTimeoutMsOverride?: number;
    staleAfterMsOverride?: number;
    maxLeaseMsOverride?: number;
    pollIntervalMsOverride?: number;
  } = {},
): Promise<OmpReadCapacityLease> {
  return await acquireOmpReadCapacity({
    projectRoot,
    callerId,
    runId,
    config,
    runtimeRoot,
    heartbeatIntervalMsOverride: 20,
    queueTimeoutMsOverride: overrides.queueTimeoutMsOverride,
    staleAfterMsOverride: overrides.staleAfterMsOverride,
    maxLeaseMsOverride: overrides.maxLeaseMsOverride,
    pollIntervalMsOverride: overrides.pollIntervalMsOverride ?? 10,
  });
}

async function testRepositoryConfig(): Promise<void> {
  const config = await loadOmpReadCapacityConfig(projectRoot);
  assert.equal(config.maxGlobalConcurrent, 3);
  assert.equal(config.maxPerCallerConcurrent, 1);
  assert.equal(config.maxQueueSeconds, 600);
  assert.equal(config.maxLeaseSeconds, 7200);
}

async function testCallerLimit(): Promise<void> {
  await withRuntime(async (runtimeRoot) => {
    const first = await acquire(runtimeRoot, "caller-a", "run-a1");
    await assert.rejects(
      acquire(runtimeRoot, "caller-a", "run-a2"),
      (error: unknown) =>
        error instanceof OmpReadCapacityError && error.code === "caller_busy",
    );
    await first.release();
  });
}

async function testGlobalQueue(): Promise<void> {
  await withRuntime(async (runtimeRoot) => {
    const leases = await Promise.all([
      acquire(runtimeRoot, "caller-a", "run-a"),
      acquire(runtimeRoot, "caller-b", "run-b"),
      acquire(runtimeRoot, "caller-c", "run-c"),
    ]);
    let fourthResolved = false;
    const fourthPromise = acquire(runtimeRoot, "caller-d", "run-d").then((lease) => {
      fourthResolved = true;
      return lease;
    });

    await wait(60);
    assert.equal(fourthResolved, false);
    await leases[1].release();
    const fourth = await fourthPromise;
    assert.ok(fourth.queueDurationMs >= 50);

    await fourth.release();
    await leases[0].release();
    await leases[2].release();
  });
}

async function testFuturePerCallerLimit(): Promise<void> {
  await withRuntime(async (runtimeRoot) => {
    const config = { ...baseConfig, maxPerCallerConcurrent: 2 };
    const first = await acquire(runtimeRoot, "caller-a", "run-a1", config);
    const second = await acquire(runtimeRoot, "caller-a", "run-a2", config);
    await assert.rejects(
      acquire(runtimeRoot, "caller-a", "run-a3", config),
      (error: unknown) =>
        error instanceof OmpReadCapacityError && error.code === "caller_busy",
    );
    await second.release();
    await first.release();
  });
}

async function testQueueTimeoutReleasesCaller(): Promise<void> {
  await withRuntime(async (runtimeRoot) => {
    const config = { ...baseConfig, maxGlobalConcurrent: 1 };
    const first = await acquire(runtimeRoot, "caller-a", "run-a", config);
    await assert.rejects(
      acquire(runtimeRoot, "caller-b", "run-b1", config, {
        queueTimeoutMsOverride: 80,
      }),
      (error: unknown) =>
        error instanceof OmpReadCapacityError && error.code === "capacity_timeout",
    );
    await first.release();

    // 如果排队失败正确释放了调用者槽，同一 caller 应能立即再次申请。
    const retried = await acquire(runtimeRoot, "caller-b", "run-b2", config);
    await retried.release();
  });
}

async function testStaleLeaseRecovery(): Promise<void> {
  await withRuntime(async (runtimeRoot) => {
    const config = {
      ...baseConfig,
      maxGlobalConcurrent: 1,
    };
    const bootstrap = await acquire(runtimeRoot, "bootstrap", "bootstrap", config);
    await bootstrap.release();

    const database = new Database(getCapacityDatabasePath(runtimeRoot), {
      create: true,
      strict: true,
    });
    const insert = database.query(`
      INSERT INTO omp_read_leases (
        kind, scope_key, slot, lease_id, caller_id, run_id,
        owner_pid, child_pid, created_at_ms, heartbeat_at_ms
      ) VALUES (?1, ?2, 0, 'stale-lease', 'caller-stale', 'run-old',
        99999999, NULL, ?3, ?3)
    `);
    const oldTime = Date.now() - 10_000;
    insert.run("caller", "caller-stale", oldTime);
    insert.run("global", "repository", oldTime);
    insert.finalize();
    database.close(true);

    const lease = await acquire(runtimeRoot, "caller-stale", "run-stale", config, {
      staleAfterMsOverride: 20,
    });
    assert.equal(lease.callerSlot, 0);
    assert.equal(lease.globalSlot, 0);
    await lease.release();
  });
}

async function testLiveChildProtectsOrphanLease(): Promise<void> {
  await withRuntime(async (runtimeRoot) => {
    const config = { ...baseConfig, maxGlobalConcurrent: 1 };
    const bootstrap = await acquire(runtimeRoot, "bootstrap", "bootstrap", config);
    await bootstrap.release();
    const database = new Database(getCapacityDatabasePath(runtimeRoot), {
      create: true,
      strict: true,
    });
    const oldTime = Date.now() - 10_000;
    const insert = database.query(`
      INSERT INTO omp_read_leases (
        kind, scope_key, slot, lease_id, caller_id, run_id,
        owner_pid, child_pid, created_at_ms, heartbeat_at_ms
      ) VALUES (?1, ?2, 0, 'orphan-lease', 'caller-orphan', 'run-old',
        99999999, ?3, ?4, ?5)
    `);
    const createdAt = Date.now();
    insert.run("caller", "caller-orphan", process.pid, createdAt, oldTime);
    insert.run("global", "repository", process.pid, createdAt, oldTime);
    insert.finalize();
    database.close(true);

    await assert.rejects(
      acquire(runtimeRoot, "caller-new", "run-new", config, {
        queueTimeoutMsOverride: 50,
        staleAfterMsOverride: 20,
      }),
      (error: unknown) =>
        error instanceof OmpReadCapacityError && error.code === "capacity_timeout",
    );
  });
}

async function testMaximumLeaseAgePreventsPidReuseLeak(): Promise<void> {
  await withRuntime(async (runtimeRoot) => {
    const config = { ...baseConfig, maxGlobalConcurrent: 1 };
    const bootstrap = await acquire(runtimeRoot, "bootstrap", "bootstrap", config);
    await bootstrap.release();
    const database = new Database(getCapacityDatabasePath(runtimeRoot), {
      create: true,
      strict: true,
    });
    const oldTime = Date.now() - 10_000;
    const insert = database.query(`
      INSERT INTO omp_read_leases (
        kind, scope_key, slot, lease_id, caller_id, run_id,
        owner_pid, child_pid, created_at_ms, heartbeat_at_ms
      ) VALUES (?1, ?2, 0, 'reused-pid-lease', 'caller-old', 'run-old',
        ?3, NULL, ?4, ?4)
    `);
    insert.run("caller", "caller-old", process.pid, oldTime);
    insert.run("global", "repository", process.pid, oldTime);
    insert.finalize();
    database.close(true);

    const lease = await acquire(runtimeRoot, "caller-new", "run-new", config, {
      staleAfterMsOverride: 20,
      maxLeaseMsOverride: 50,
    });
    assert.equal(lease.globalSlot, 0);
    await lease.release();
  });
}

async function testDeadChildReclaimsDespiteLiveOwner(): Promise<void> {
  await withRuntime(async (runtimeRoot) => {
    const config = { ...baseConfig, maxGlobalConcurrent: 1 };
    const bootstrap = await acquire(runtimeRoot, "bootstrap", "bootstrap", config);
    await bootstrap.release();
    const database = new Database(getCapacityDatabasePath(runtimeRoot), {
      create: true,
      strict: true,
    });
    const oldHeartbeat = Date.now() - 10_000;
    const createdAt = Date.now();
    const insert = database.query(`
      INSERT INTO omp_read_leases (
        kind, scope_key, slot, lease_id, caller_id, run_id,
        owner_pid, child_pid, created_at_ms, heartbeat_at_ms
      ) VALUES (?1, ?2, 0, 'dead-child-lease', 'caller-old', 'run-old',
        ?3, 99999999, ?4, ?5)
    `);
    insert.run("caller", "caller-old", process.pid, createdAt, oldHeartbeat);
    insert.run("global", "repository", process.pid, createdAt, oldHeartbeat);
    insert.finalize();
    database.close(true);

    const lease = await acquire(runtimeRoot, "caller-new", "run-new", config, {
      staleAfterMsOverride: 20,
    });
    assert.equal(lease.globalSlot, 0);
    await lease.release();
  });
}

async function testHeartbeatProtectsActiveLease(): Promise<void> {
  await withRuntime(async (runtimeRoot) => {
    const config = { ...baseConfig, maxGlobalConcurrent: 1 };
    const active = await acquire(runtimeRoot, "caller-active", "run-active", config, {
      staleAfterMsOverride: 40,
    });
    await wait(120);
    await assert.rejects(
      acquire(runtimeRoot, "caller-waiting", "run-waiting", config, {
        queueTimeoutMsOverride: 50,
        staleAfterMsOverride: 40,
      }),
      (error: unknown) =>
        error instanceof OmpReadCapacityError && error.code === "capacity_timeout",
    );
    await active.release();
  });
}

async function testGlobalStressLimit(): Promise<void> {
  await withRuntime(async (runtimeRoot) => {
    let active = 0;
    let maximumActive = 0;
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        (async () => {
          const lease = await acquire(
            runtimeRoot,
            `stress-caller-${index}`,
            `stress-run-${index}`,
          );
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await wait(30);
          active -= 1;
          await lease.release();
        })(),
      ),
    );
    assert.equal(maximumActive, 3);
  });
}

interface CapacityWorkerPayload {
  runtimeRoot: string;
  callerId: string;
  runId: string;
  holdMs: number;
}

async function runCapacityWorker(payload: CapacityWorkerPayload): Promise<void> {
  try {
    const lease = await acquire(
      payload.runtimeRoot,
      payload.callerId,
      payload.runId,
    );
    process.stdout.write(
      `${JSON.stringify({ status: "acquired", globalSlot: lease.globalSlot })}\n`,
    );
    await wait(payload.holdMs);
    await lease.release();
    process.stdout.write(`${JSON.stringify({ status: "released" })}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

async function testCrossProcessGlobalLimit(): Promise<void> {
  await withRuntime(async (runtimeRoot) => {
    const bootstrap = await acquire(runtimeRoot, "bootstrap", "bootstrap");
    await bootstrap.release();
    const observer = new Database(getCapacityDatabasePath(runtimeRoot), {
      create: true,
      strict: true,
    });
    observer.run("PRAGMA busy_timeout = 5000;");
    const countGlobal = observer.query<{ count: number }, []>(`
      SELECT COUNT(*) AS count
      FROM omp_read_leases
      WHERE kind = 'global'
    `);
    let exitedWorkers = 0;
    const workers = Array.from({ length: 6 }, (_, index) => {
      const payload: CapacityWorkerPayload = {
        runtimeRoot,
        callerId: `process-caller-${index}`,
        runId: `process-run-${index}`,
        holdMs: 250,
      };
      const child = spawn(
        process.execPath,
        [currentFile, "--capacity-worker", JSON.stringify(payload)],
        {
          cwd: projectRoot,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      const completion = new Promise<void>((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", (code) => {
          exitedWorkers += 1;
          if (code === 0) {
            resolve();
          } else {
            reject(
              new Error(
                `容量 worker ${index} 失败，退出码 ${code}。\n${stdout}\n${stderr}`,
              ),
            );
          }
        });
      });
      return { completion };
    });

    let maximumLeaseFiles = 0;
    while (exitedWorkers < workers.length) {
      maximumLeaseFiles = Math.max(
        maximumLeaseFiles,
        countGlobal.get()?.count ?? 0,
      );
      await wait(5);
    }
    await Promise.all(workers.map((worker) => worker.completion));
    countGlobal.finalize();
    observer.close(true);
    assert.equal(maximumLeaseFiles, 3);
  });
}

async function main(): Promise<void> {
  const tests: Array<[string, () => Promise<void>]> = [
    ["仓库并发配置", testRepositoryConfig],
    ["单调用者并发上限", testCallerLimit],
    ["全局容量排队", testGlobalQueue],
    ["未来单调用者多槽", testFuturePerCallerLimit],
    ["排队超时释放调用者槽", testQueueTimeoutReleasesCaller],
    ["陈旧租约回收", testStaleLeaseRecovery],
    ["孤儿子进程保留租约", testLiveChildProtectsOrphanLease],
    ["最长租约避免 PID 复用泄漏", testMaximumLeaseAgePreventsPidReuseLeak],
    ["死子进程优先回收", testDeadChildReclaimsDespiteLiveOwner],
    ["心跳保护活跃租约", testHeartbeatProtectsActiveLease],
    ["全局并发压力", testGlobalStressLimit],
    ["跨进程全局并发上限", testCrossProcessGlobalLimit],
  ];

  let testFailed = false;
  try {
    for (const [name, test] of tests) {
      await test();
      console.log(`通过：${name}`);
    }
    console.log(`OMP 并发容量测试完成，共 ${tests.length} 项。`);
  } catch (error) {
    testFailed = true;
    throw error;
  } finally {
    try {
      await cleanupRuntimeRoots();
    } catch (error) {
      if (!testFailed) {
        throw error;
      }
      console.error(error instanceof Error ? error.message : String(error));
    }
  }
}

const workerArgumentIndex = process.argv.indexOf("--capacity-worker");
if (workerArgumentIndex >= 0) {
  const payload = JSON.parse(
    process.argv[workerArgumentIndex + 1] ?? "{}",
  ) as CapacityWorkerPayload;
  await runCapacityWorker(payload);
} else {
  await main();
}
