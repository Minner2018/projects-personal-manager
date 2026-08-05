import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildOmpArguments,
  buildTaskMessage,
  calculateSoftDeadlineMs,
  normalizeRequest,
  runOmpRead,
} from "./omp-text-delegate.ts";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const fakeOmpPath = path.join(projectRoot, "tests", "fixtures", "fake-omp-rpc.mjs");
const testSystemPrompt = "你是只读测试执行器。";

async function createRequest() {
  return await normalizeRequest(
    {
      callerId: "test:omp-reader",
      objective: "测试阅读入口",
      searchRoots: ["."],
      materialTypes: ["code", "markdown"],
      extensions: ["log"],
      questions: ["入口在哪里？"],
      limits: {
        maxTimeSeconds: 30,
        maxFindings: 10,
        maxOutputCharacters: 5000,
      },
    },
    projectRoot,
  );
}

async function testRequestAndArguments(): Promise<void> {
  const request = await createRequest();
  assert.deepEqual(request.searchRoots, ["."]);
  assert.deepEqual(request.extensions, [".log"]);

  const message = buildTaskMessage(request);
  assert.match(message, /测试阅读入口/);
  assert.match(message, /\.java/);
  assert.match(message, /\.log/);
  assert.match(message, /总时间硬上限：30 秒/);
  assert.match(message, /收到后必须立即停止工具调用/);

  const args = buildOmpArguments(request, testSystemPrompt);
  assert.ok(args.includes("--mode=rpc"));
  assert.ok(args.includes("--no-session"));
  assert.ok(args.includes("--no-pty"));
  assert.ok(args.includes("--no-extensions"));
  assert.ok(args.includes("--no-skills"));
  assert.ok(args.includes("--tools=read,grep,glob"));
  assert.ok(args.includes("--max-time=35s"));
  assert.ok(!args.some((arg) => arg.includes("write") || arg.includes("bash")));

  assert.equal(calculateSoftDeadlineMs(600_000), 480_000);
  assert.equal(calculateSoftDeadlineMs(60_000), 30_000);
  assert.equal(calculateSoftDeadlineMs(10_000), 5_000);
}

async function testPathBoundary(): Promise<void> {
  await assert.rejects(
    normalizeRequest(
      {
        callerId: "test:path-boundary",
        objective: "测试越界",
        searchRoots: [".."],
      },
      projectRoot,
    ),
    /不能超出项目根目录/,
  );
}

async function testCallerId(): Promise<void> {
  await assert.rejects(
    normalizeRequest(
      {
        objective: "测试缺少调用者",
      },
      projectRoot,
      undefined,
    ),
    /callerId/,
  );

  const request = await normalizeRequest(
    {
      objective: "测试环境调用者",
    },
    projectRoot,
    "codex:environment-task",
  );
  assert.equal(request.callerId, "codex:environment-task");
}

async function testCapabilityAndSkillBoundary(): Promise<void> {
  const agents = await readFile(path.join(projectRoot, "AGENTS.md"), "utf8");
  assert.match(agents, /external `omp` CLI process, not a skill/);
  assert.match(agents, /No `\[X\]` route token is required/);
  assert.match(agents, /absence of a route token must never be used as a reason/);
  assert.match(agents, /does not govern internal capabilities, terminal commands, or tool use/);
  assert.match(agents, /grants standing repository-level authorization/);
  assert.match(agents, /remains valid until the owner explicitly revokes it/);
  assert.match(agents, /without requesting authorization again for each task, file, or investigation/);
  assert.match(agents, /does not expand which local paths AI may read/);
  assert.match(agents, /approval required by the host environment remains in effect/);
  assert.match(agents, /request that approval instead of silently falling back/);
}

async function runFake(
  mode: string,
  timeoutMsOverride?: number,
  softDeadlineMsOverride?: number,
  hardTimeoutGraceMsOverride?: number,
) {
  const request = await createRequest();
  return await runOmpRead(request, {
    projectRoot,
    command: process.execPath,
    baseArgs: [fakeOmpPath],
    environment: { FAKE_OMP_MODE: mode },
    systemPrompt: testSystemPrompt,
    timeoutMsOverride,
    softDeadlineMsOverride,
    hardTimeoutGraceMsOverride,
    capacityEnabled: false,
  });
}

async function testSuccessfulRpc(): Promise<void> {
  const result = await runFake("success");
  assert.equal(result.status, "completed");
  assert.equal(result.report?.findings[0]?.evidence[0]?.path, "README.md");
}

async function testPartialRpc(): Promise<void> {
  const result = await runFake("partial");
  assert.equal(result.status, "partial");
  assert.deepEqual(result.report?.uncertainties, ["时间不足"]);
}

async function testInvalidOutput(): Promise<void> {
  const result = await runFake("invalid");
  assert.equal(result.status, "invalid_output");
  assert.match(result.rawOutput ?? "", /这不是 JSON/);
}

async function testTimeout(): Promise<void> {
  const result = await runFake("hang", 100);
  assert.equal(result.status, "timeout");
}

async function testUncooperativeTimeout(): Promise<void> {
  const result = await runFake("ignore-abort", 50, 25, 30);
  assert.equal(result.status, "timeout");
  assert.ok(result.diagnostics.durationMs < 500);
}

async function testResultWinsTimeoutRace(): Promise<void> {
  const result = await runFake("slow-exit", 500, 250, 30);
  assert.equal(result.status, "completed");
  assert.equal(result.report?.summary, "模拟调查完成。");
}

async function testPromptFailure(): Promise<void> {
  const result = await runFake("prompt-error");
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /模拟的提示失败/);
}

async function testSoftDeadline(): Promise<void> {
  const result = await runFake("soft-deadline", 500, 20);
  assert.equal(result.status, "partial");
  assert.deepEqual(result.report?.uncertainties, ["软截止前未完成全部调查"]);
  assert.equal(result.diagnostics.softDeadlineTriggered, true);
}

async function testSoftDeadlineFallback(): Promise<void> {
  const result = await runFake("soft-deadline-rejected", 500, 20);
  assert.equal(result.status, "partial");
  assert.deepEqual(result.report?.uncertainties, ["主收尾指令被拒绝"]);
  assert.match(
    result.diagnostics.protocolWarnings?.join("\n") ?? "",
    /拒绝收尾指令/,
  );
}

async function testCapacityIntegrationAndRelease(): Promise<void> {
  const capacityRuntimeRoot = await mkdtemp(
    path.join(os.tmpdir(), "omp-delegate-capacity-test-"),
  );
  const request = await createRequest();
  const capacityConfig = {
    maxGlobalConcurrent: 3,
    maxPerCallerConcurrent: 1,
    maxQueueSeconds: 1,
    heartbeatSeconds: 1,
    staleAfterSeconds: 2,
    maxLeaseSeconds: 10,
  };
  const options = {
    projectRoot,
    command: process.execPath,
    baseArgs: [fakeOmpPath],
    systemPrompt: testSystemPrompt,
    timeoutMsOverride: 250,
    softDeadlineMsOverride: 125,
    hardTimeoutGraceMsOverride: 30,
    capacityConfig,
    capacityRuntimeRoot,
    capacityHeartbeatIntervalMsOverride: 20,
    capacityStaleAfterMsOverride: 100,
    capacityPollIntervalMsOverride: 10,
  };

  try {
    const firstPromise = runOmpRead(request, {
      ...options,
      environment: { FAKE_OMP_MODE: "hang" },
    });
    await new Promise((resolve) => setTimeout(resolve, 60));

    const duplicate = await runOmpRead(request, {
      ...options,
      environment: { FAKE_OMP_MODE: "success" },
    });
    assert.equal(duplicate.status, "failed");
    assert.equal(duplicate.errorCode, "caller_busy");

    const first = await firstPromise;
    assert.equal(first.status, "timeout");

    // 首次调用超时后必须释放调用者槽和全局槽，同一 caller 才能再次成功调用。
    const retried = await runOmpRead(request, {
      ...options,
      environment: { FAKE_OMP_MODE: "success" },
    });
    assert.equal(retried.status, "completed");
    assert.equal(retried.diagnostics.callerSlot, 0);
    assert.notEqual(retried.diagnostics.globalSlot, null);
  } finally {
    await rm(capacityRuntimeRoot, { recursive: true, force: true });
  }
}

async function testQueueTimeExcludedFromExecution(): Promise<void> {
  const capacityRuntimeRoot = await mkdtemp(
    path.join(os.tmpdir(), "omp-delegate-queue-test-"),
  );
  const firstRequest = await createRequest();
  const secondRequest = { ...firstRequest, callerId: "test:queued-reader" };
  const capacityConfig = {
    maxGlobalConcurrent: 1,
    maxPerCallerConcurrent: 1,
    maxQueueSeconds: 1,
    heartbeatSeconds: 1,
    staleAfterSeconds: 2,
    maxLeaseSeconds: 10,
  };
  const commonOptions = {
    projectRoot,
    command: process.execPath,
    baseArgs: [fakeOmpPath],
    systemPrompt: testSystemPrompt,
    timeoutMsOverride: 250,
    softDeadlineMsOverride: 125,
    hardTimeoutGraceMsOverride: 30,
    capacityConfig,
    capacityRuntimeRoot,
    capacityHeartbeatIntervalMsOverride: 20,
    capacityStaleAfterMsOverride: 100,
    capacityPollIntervalMsOverride: 10,
  };

  try {
    const occupying = runOmpRead(firstRequest, {
      ...commonOptions,
      environment: { FAKE_OMP_MODE: "hang" },
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const queued = runOmpRead(secondRequest, {
      ...commonOptions,
      environment: { FAKE_OMP_MODE: "success" },
    });

    const occupyingResult = await occupying;
    const queuedResult = await queued;
    assert.equal(occupyingResult.status, "timeout");
    assert.equal(queuedResult.status, "completed");
    assert.ok(queuedResult.diagnostics.queueDurationMs >= 100);
    assert.ok(
      queuedResult.diagnostics.durationMs < queuedResult.diagnostics.queueDurationMs,
    );
  } finally {
    (globalThis as { Bun?: { gc(full?: boolean): void } }).Bun?.gc(true);
    await rm(capacityRuntimeRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  }
}

async function main(): Promise<void> {
  const tests: Array<[string, () => Promise<void>]> = [
    ["请求与参数", testRequestAndArguments],
    ["路径边界", testPathBoundary],
    ["调用者标识", testCallerId],
    ["能力与技能边界", testCapabilityAndSkillBoundary],
    ["RPC 成功", testSuccessfulRpc],
    ["RPC 部分完成", testPartialRpc],
    ["无效输出", testInvalidOutput],
    ["软截止收尾", testSoftDeadline],
    ["软截止备用收尾", testSoftDeadlineFallback],
    ["容量接入与异常释放", testCapacityIntegrationAndRelease],
    ["排队时间不计入调查时间", testQueueTimeExcludedFromExecution],
    ["提示失败", testPromptFailure],
    ["有效结果优先于退出超时", testResultWinsTimeoutRace],
    ["执行超时", testTimeout],
    ["不响应终止的执行超时", testUncooperativeTimeout],
  ];

  for (const [name, test] of tests) {
    await test();
    console.log(`通过：${name}`);
  }

  console.log(`OMP 阅读能力测试完成，共 ${tests.length} 项。`);
}

await main();
