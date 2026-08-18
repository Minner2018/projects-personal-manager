import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildOmpArguments,
  buildCheckpointTaskMessage,
  buildTaskMessage,
  calculateCheckpointDeadlineMs,
  calculateSoftDeadlineMs,
  normalizeRequest,
  parseCliArguments,
  resolveOmpCommand,
  resolveWindowsSystemExecutable,
  runOmpRead,
} from "./omp-text-delegate.ts";
import {
  estimateOmpReadTime,
  OMP_READ_PROFILE_LIMITS,
  OMP_READ_PROFILE_TIME_RANGES,
  type OmpReadPreflightEstimate,
} from "./omp-read-estimate.ts";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const fakeOmpPath = path.join(projectRoot, "tests", "fixtures", "fake-omp-rpc.mjs");
const testSystemPrompt = "你是只读测试执行器。";
const stubPreflightEstimate: OmpReadPreflightEstimate = {
  stage: "preflight",
  recommendedProfile: "standard",
  firstCheckpointSeconds: { min: 45, max: 120 },
  totalSeconds: { min: 180, max: 600 },
  confidence: "medium",
  basis: {
    candidateFiles: 20,
    candidateTextBytes: 10000,
    searchRoots: 1,
    questions: 1,
    relationshipSignals: [],
    scanDurationMs: 1,
    scanTruncated: false,
    historicalSamples: 0,
  },
};

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
  const checkpointMessage = buildCheckpointTaskMessage(request);
  assert.match(checkpointMessage, /范围定位检查点/);
  assert.match(checkpointMessage, /包装器保存为检查点/);

  const args = buildOmpArguments(request, testSystemPrompt, {
    model: "litellm/deepseek-v4-flash-private",
    thinking: "off",
  });
  assert.ok(args.includes("--model=litellm/deepseek-v4-flash-private"));
  assert.ok(args.includes("--thinking=off"));
  assert.ok(args.includes("--mode=rpc"));
  assert.ok(args.includes("--no-session"));
  assert.ok(args.includes("--no-pty"));
  assert.ok(args.includes("--no-extensions"));
  assert.ok(args.includes("--no-skills"));
  const toolsArgument = args.find((argument) => argument.startsWith("--tools="));
  assert.ok(toolsArgument);
  const enabledTools = toolsArgument.slice("--tools=".length).split(",");
  assert.deepEqual(enabledTools, ["read", "grep", "glob"]);
  assert.ok(!enabledTools.some((toolName) => toolName.startsWith("mcp__")));
  const configArgument = args.find((argument) => argument.startsWith("--config="));
  assert.ok(configArgument);
  assert.match(configArgument, /text-investigator\.yml$/);
  for (const deniedToolName of [
    "mcp__codebase_memory_index_repository",
    "mcp__codebase_memory_delete_project",
    "mcp__codebase_memory_manage_adr",
    "mcp__codebase_memory_ingest_traces",
  ]) {
    assert.ok(!enabledTools.includes(deniedToolName));
  }
  assert.ok(!args.includes("--auto-approve"));
  assert.ok(args.includes("--max-time=35s"));
  assert.ok(
    !enabledTools.some((toolName) =>
      ["write", "edit", "bash"].includes(toolName),
    ),
  );

  assert.equal(calculateSoftDeadlineMs(600_000), 480_000);
  assert.equal(calculateSoftDeadlineMs(60_000), 30_000);
  assert.equal(calculateSoftDeadlineMs(10_000), 5_000);
  assert.equal(
    calculateCheckpointDeadlineMs(192_000, stubPreflightEstimate, "quick"),
    120_000,
  );
  assert.equal(
    calculateCheckpointDeadlineMs(480_000, stubPreflightEstimate, "custom"),
    120_000,
  );
}

async function testMinimalCliAndProfiles(): Promise<void> {
  assert.equal(OMP_READ_PROFILE_LIMITS.quick.maxTimeSeconds, 360);
  assert.deepEqual(OMP_READ_PROFILE_TIME_RANGES.quick.firstCheckpointSeconds, {
    min: 90,
    max: 180,
  });
  assert.deepEqual(OMP_READ_PROFILE_TIME_RANGES.standard.firstCheckpointSeconds, {
    min: 150,
    max: 300,
  });
  assert.deepEqual(OMP_READ_PROFILE_TIME_RANGES.deep.firstCheckpointSeconds, {
    min: 240,
    max: 480,
  });
  const cli = parseCliArguments(
    [
      "--objective",
      "调查最小调用入口",
      "--root",
      ".",
      "--profile",
      "quick",
      "--estimate-only",
    ],
    "test:minimal-cli",
  );
  assert.equal(cli.estimateOnly, true);
  const request = await normalizeRequest(cli.inlineRequest, projectRoot);
  assert.equal(request.callerId, "test:minimal-cli");
  assert.equal(request.profile, "quick");
  assert.equal(request.limits.maxTimeSeconds, 360);
  assert.deepEqual(request.searchRoots, ["."]);

  assert.throws(
    () =>
      parseCliArguments([
        "--request",
        "request.json",
        "--objective",
        "不能混用",
      ]),
    /不能与/,
  );
}

async function testPreflightEstimate(): Promise<void> {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "omp-estimate-test-"));
  try {
    await mkdir(path.join(temporaryRoot, "src"));
    await writeFile(path.join(temporaryRoot, "src", "entry.ts"), "export const x = 1;\n");
    await writeFile(path.join(temporaryRoot, "README.md"), "# test\n");
    await mkdir(path.join(temporaryRoot, "node_modules"));
    await writeFile(
      path.join(temporaryRoot, "node_modules", "ignored.ts"),
      "export const ignored = true;\n",
    );

    const estimate = await estimateOmpReadTime({
      projectRoot: temporaryRoot,
      searchRoots: ["."],
      extensions: [".ts", ".md"],
      excludeHints: ["node_modules"],
      objective: "定位入口",
      questions: [],
    });
    assert.equal(estimate.recommendedProfile, "quick");
    assert.equal(estimate.basis.candidateFiles, 2);
    assert.equal(estimate.basis.scanTruncated, false);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
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
  assert.match(agents, /外部 `omp` CLI 进程，不是/);
  assert.match(agents, /不需要 `\[X\]` 路由标记/);
  assert.match(agents, /不得以缺少路由标记为由拒绝调用该能力/);
  assert.match(agents, /不管理内部能力、终端命令或工具使用/);
  assert.match(agents, /普通调用应使用最小形式/);
  assert.match(agents, /包装器会在本地进行调用前耗时预估/);
  assert.match(agents, /最近一次有效的累积检查点作为 `partial`/);
  assert.match(agents, /仓库所有者已授予持续有效的仓库级授权/);
  assert.match(agents, /直到所有者明确撤销前持续有效/);
  assert.match(agents, /无需再为每个任务、文件或调查重复申请授权/);
  assert.match(agents, /不会扩大 AI 可读取的本地路径范围/);
  assert.match(agents, /满足将可读仓库文本发送给当前 OMP 提供商/);
  assert.match(agents, /AI 仍自主决定 OMP 是否适合当前任务/);
  assert.match(agents, /必须发起 OMP 调用或宿主审批流程/);
  assert.match(agents, /不得仅凭推断声称安全策略阻止了 OMP/);
  assert.match(agents, /仅在宿主工具或执行环境返回具体的权限要求或拒绝时/);
  assert.match(agents, /通过宿主审批机制申请，而不是静默退回直接阅读/);
  assert.match(agents, /直接使用 CMM CLI 调查当前代码结构/);
  assert.match(agents, /使用 Repowise 调查 Git 历史相关问题/);
  assert.match(agents, /无需路由标记，使用它们也不会激活或切换技能/);
  assert.match(agents, /重新加载与 X 匹配的技能，丢弃偏离的工作流状态/);
  assert.match(agents, /退出当前技能，随后按普通方式继续/);

  const prompt = await readFile(
    path.join(projectRoot, ".omp", "prompts", "text-investigator.md"),
    "utf8",
  );
  assert.match(prompt, /Repowise 与 CMM 的只读 MCP 查询工具/);
  assert.match(prompt, /关键结论必须再用 `read`、`grep` 或 `glob`/);
  assert.match(prompt, /不要调用任何 MCP 写入或维护工具/);

  const ompReadConfig = await readFile(
    path.join(projectRoot, ".omp", "configs", "text-investigator.yml"),
    "utf8",
  );
  assert.match(ompReadConfig, /approvalMode: always-ask/);
  assert.match(ompReadConfig, /disabledProviders:/);
  assert.match(ompReadConfig, /\s- codex/);
  const approvalEntries = [
    ...ompReadConfig.matchAll(/^\s+(mcp__[^:\s]+):\s+(allow|deny)\s*$/gm),
  ].map((match) => ({ name: match[1], decision: match[2] }));
  const allowedToolNames = approvalEntries
    .filter((entry) => entry.decision === "allow")
    .map((entry) => entry.name);
  const deniedToolNames = approvalEntries
    .filter((entry) => entry.decision === "deny")
    .map((entry) => entry.name)
    .sort();
  assert.equal(allowedToolNames.length, 24);
  assert.equal(new Set(allowedToolNames).size, allowedToolNames.length);
  assert.equal(
    allowedToolNames.filter((name) => name.startsWith("mcp__repowise_")).length,
    13,
  );
  assert.equal(
    allowedToolNames.filter((name) => name.startsWith("mcp__codebase_memory_")).length,
    11,
  );
  assert.ok(
    allowedToolNames.every((name) =>
      /^mcp__(?:repowise|codebase_memory)_[a-z0-9_]+$/.test(name),
    ),
  );
  assert.ok(
    allowedToolNames.every(
      (name) =>
        !/(?:index_repository|delete_project|manage_adr|ingest_traces)$/.test(name),
    ),
  );
  assert.deepEqual(deniedToolNames, [
    "mcp__codebase_memory_delete_project",
    "mcp__codebase_memory_index_repository",
    "mcp__codebase_memory_ingest_traces",
    "mcp__codebase_memory_manage_adr",
  ]);
  for (const deniedToolName of [
    "mcp__codebase_memory_index_repository",
    "mcp__codebase_memory_delete_project",
    "mcp__codebase_memory_manage_adr",
    "mcp__codebase_memory_ingest_traces",
  ]) {
    assert.match(ompReadConfig, new RegExp(`${deniedToolName}: deny`));
  }

  const mcpConfig = JSON.parse(
    await readFile(path.join(projectRoot, ".omp", "mcp.json"), "utf8"),
  ) as {
    mcpServers?: Record<string, { args?: string[]; cwd?: string }>;
  };
  assert.deepEqual(mcpConfig.mcpServers?.repowise?.args, ["mcp"]);
  assert.deepEqual(mcpConfig.mcpServers?.codebase_memory?.args, [
    "--tool-profile=analysis",
  ]);
  assert.equal(
    path.resolve(mcpConfig.mcpServers?.codebase_memory?.cwd ?? ""),
    projectRoot,
  );
}

/**
 * 验证全部 OMP 技能仍声明稳定的名称和路由标记，并已提供中文正文。
 */
async function testSkillRoutingMetadata(): Promise<void> {
  const expectedSkills: Array<{ name: string; routeDescription: string }> = [
    { name: "talk", routeDescription: "route tokens: [T]" },
    { name: "discuss", routeDescription: "route tokens: [D]" },
    { name: "plan", routeDescription: "route tokens: [P]" },
    { name: "review", routeDescription: "route tokens: [R]" },
    { name: "implement", routeDescription: "route tokens: [I]" },
    { name: "fix", routeDescription: "route tokens: [F]" },
    { name: "multi-agent", routeDescription: "route tokens: [M]" },
    { name: "work", routeDescription: "route tokens: [W], [W-C]" },
  ];

  // 逐个读取技能文件，同时验证发现元数据和正文语言。
  for (const expectedSkill of expectedSkills) {
    const skillSource = await readFile(
      path.join(projectRoot, ".omp", "skills", expectedSkill.name, "SKILL.md"),
      "utf8",
    );
    const metadata = skillSource.match(
      /^---\r?\nname: ([^\r\n]+)\r?\ndescription: "([^"]+)"\r?\n---\r?\n([\s\S]*)$/,
    );
    assert.ok(metadata, `${expectedSkill.name} 缺少有效的 frontmatter`);
    assert.equal(metadata[1], expectedSkill.name);
    assert.equal(metadata[2], expectedSkill.routeDescription);
    assert.match(metadata[3], /[\u3400-\u9fff]/, `${expectedSkill.name} 缺少中文正文`);
  }
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
    preflightEstimate: stubPreflightEstimate,
  });
}

async function testSuccessfulRpc(): Promise<void> {
  const result = await runFake("success");
  assert.equal(result.status, "completed");
  assert.equal(result.report?.findings[0]?.evidence[0]?.path, "README.md");
}

async function testTrustedExecutableResolution(): Promise<void> {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "omp-command-test-"));
  const currentDirectory = path.join(temporaryRoot, "manager");
  const workspaceBinDirectory = path.join(currentDirectory, "tools", "bin");
  const packageManagerBinDirectory = path.join(
    temporaryRoot,
    "node_modules",
    ".bin",
  );
  const trustedDirectory = path.join(temporaryRoot, "trusted-bin");
  await mkdir(currentDirectory, { recursive: true });
  await mkdir(workspaceBinDirectory, { recursive: true });
  await mkdir(packageManagerBinDirectory, { recursive: true });
  await mkdir(trustedDirectory, { recursive: true });
  const executableName = process.platform === "win32" ? "omp.exe" : "omp";
  const currentDirectoryExecutable = path.join(currentDirectory, executableName);
  const workspaceBinExecutable = path.join(workspaceBinDirectory, executableName);
  const packageManagerBinExecutable = path.join(
    packageManagerBinDirectory,
    executableName,
  );
  const trustedExecutable = path.join(trustedDirectory, executableName);
  await writeFile(currentDirectoryExecutable, "当前目录中的同名程序", "utf8");
  await writeFile(workspaceBinExecutable, "工作区子目录中的同名程序", "utf8");
  await writeFile(packageManagerBinExecutable, "包管理器本地同名程序", "utf8");
  await writeFile(trustedExecutable, "可信 PATH 中的程序", "utf8");

  try {
    if (process.platform !== "win32") {
      return;
    }
    const resolved = await resolveOmpCommand(
      undefined,
      {
        ...process.env,
        PATH: [
          currentDirectory,
          workspaceBinDirectory,
          packageManagerBinDirectory,
          ".",
          "",
          trustedDirectory,
        ].join(path.delimiter),
        PPM_OMP_COMMAND: undefined,
      },
      currentDirectory,
    );
    assert.equal(path.resolve(resolved), path.resolve(trustedExecutable));

    await assert.rejects(
      resolveOmpCommand(
        undefined,
        { ...process.env, PPM_OMP_COMMAND: "omp.exe" },
        currentDirectory,
      ),
      /必须使用绝对路径/,
    );
    assert.equal(
      await resolveOmpCommand(trustedExecutable, process.env, currentDirectory),
      path.resolve(trustedExecutable),
    );

    const taskkillCommand = await resolveWindowsSystemExecutable("taskkill.exe");
    assert.ok(path.isAbsolute(taskkillCommand));
    assert.equal(path.basename(taskkillCommand).toLowerCase(), "taskkill.exe");
    assert.ok(
      path.dirname(taskkillCommand).toLowerCase().endsWith(`${path.sep}system32`),
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function testStructuredStartupFailure(): Promise<void> {
  const request = await createRequest();
  const capacityRuntimeRoot = await mkdtemp(
    path.join(os.tmpdir(), "omp-startup-failure-capacity-test-"),
  );
  const options = {
    projectRoot,
    command: "omp.exe",
    systemPrompt: testSystemPrompt,
    capacityConfig: {
      model: "test/read-model",
      thinking: "medium" as const,
      maxGlobalConcurrent: 1,
      maxPerCallerConcurrent: 1,
      heartbeatSeconds: 1,
      staleAfterSeconds: 2,
      maxLeaseSeconds: 10,
    },
    capacityRuntimeRoot,
    preflightEstimate: stubPreflightEstimate,
  };
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await runOmpRead(request, options);
      assert.equal(result.status, "failed");
      assert.equal(result.objective, request.objective);
      assert.equal(result.diagnostics.callerId, request.callerId);
      assert.match(result.error ?? "", /必须使用绝对路径/);
      assert.equal(result.diagnostics.callerSlot, 0);
      assert.equal(result.diagnostics.globalSlot, 0);
    }
  } finally {
    await rm(capacityRuntimeRoot, { recursive: true, force: true });
  }
}

async function isProcessRunning(processId: number): Promise<boolean> {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

async function testWindowsProcessTreeCleanup(): Promise<void> {
  if (process.platform !== "win32") {
    return;
  }
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "omp-tree-test-"));
  const pidPath = path.join(temporaryRoot, "child.pid");
  let helperProcessId: number | undefined;
  try {
    const request = await createRequest();
    const result = await runOmpRead(request, {
      projectRoot,
      command: process.execPath,
      baseArgs: [fakeOmpPath],
      environment: {
        FAKE_OMP_MODE: "spawn-child-success",
        FAKE_OMP_CHILD_PID_PATH: pidPath,
      },
      systemPrompt: testSystemPrompt,
      capacityEnabled: false,
      preflightEstimate: stubPreflightEstimate,
    });
    assert.equal(result.status, "completed");
    helperProcessId = Number.parseInt(await readFile(pidPath, "utf8"), 10);
    assert.ok(Number.isInteger(helperProcessId) && helperProcessId > 0);
    const deadline = Date.now() + 2_000;
    while ((await isProcessRunning(helperProcessId)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(await isProcessRunning(helperProcessId), false);
  } finally {
    if (helperProcessId && (await isProcessRunning(helperProcessId))) {
      process.kill(helperProcessId);
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function testPartialRpc(): Promise<void> {
  const result = await runFake("partial");
  assert.equal(result.status, "partial");
  assert.deepEqual(result.report?.uncertainties, ["时间不足"]);
  assert.equal(result.diagnostics.checkpointCount, 2);
}

async function testCheckpointThenComplete(): Promise<void> {
  const result = await runFake("checkpoint-then-complete", 2_000, 1_500, 30);
  assert.equal(result.status, "completed");
  assert.equal(result.report?.summary, "已基于检查点完成深入验证。");
  assert.equal(result.diagnostics.checkpointCount, 2);
  assert.equal(result.diagnostics.revisedEstimate?.stage, "checkpoint");
}

async function testCheckpointDeadline(): Promise<void> {
  const result = await runFake("checkpoint-deadline", 1_000, 800, 30);
  assert.equal(result.status, "partial");
  assert.equal(result.diagnostics.checkpointDeadlineTriggered, true);
  assert.ok((result.diagnostics.checkpointCount ?? 0) >= 1);
  assert.equal(result.report?.summary, "已完成范围定位检查点。");
}

async function testRegressiveCheckpointIsRejected(): Promise<void> {
  const result = await runFake("checkpoint-then-regression", 2_000, 1_500, 30);
  assert.equal(result.status, "partial");
  assert.equal(result.report?.summary, "已完成范围定位检查点。");
  assert.match(
    result.report?.uncertainties.join("\n") ?? "",
    /未完整覆盖上一检查点/,
  );
  assert.match(
    result.diagnostics.protocolWarnings?.join("\n") ?? "",
    /未完整覆盖上一检查点/,
  );
}

async function testRegressiveCompleteReportIsRejected(): Promise<void> {
  const result = await runFake(
    "checkpoint-then-complete-regression",
    2_000,
    1_500,
    30,
  );
  assert.equal(result.status, "partial");
  assert.equal(result.report?.summary, "已完成范围定位检查点。");
  assert.match(
    result.diagnostics.protocolWarnings?.join("\n") ?? "",
    /未完整覆盖上一检查点/,
  );
}

async function testCheckpointSurvivesTimeout(): Promise<void> {
  const result = await runFake("checkpoint-then-hang", 1_500, 1_000, 30);
  assert.equal(result.status, "partial");
  assert.equal(result.report?.summary, "已完成范围定位检查点。");
  assert.match(result.error ?? "", /最近有效检查点/);
  assert.match(result.report?.uncertainties.join("\n") ?? "", /硬时间上限/);
  assert.equal(result.diagnostics.checkpointCount, 1);
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
    model: "test/read-model",
    thinking: "medium" as const,
    maxGlobalConcurrent: 3,
    maxPerCallerConcurrent: 1,
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
    preflightEstimate: stubPreflightEstimate,
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

async function testCapacityFullFailsImmediately(): Promise<void> {
  const capacityRuntimeRoot = await mkdtemp(
    path.join(os.tmpdir(), "omp-delegate-capacity-full-test-"),
  );
  const firstRequest = await createRequest();
  const secondRequest = { ...firstRequest, callerId: "test:capacity-full-reader" };
  const capacityConfig = {
    model: "test/read-model",
    thinking: "medium" as const,
    maxGlobalConcurrent: 1,
    maxPerCallerConcurrent: 1,
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
    preflightEstimate: stubPreflightEstimate,
  };

  try {
    const occupying = runOmpRead(firstRequest, {
      ...commonOptions,
      environment: { FAKE_OMP_MODE: "hang" },
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const capacityFullResult = await runOmpRead(secondRequest, {
      ...commonOptions,
      environment: { FAKE_OMP_MODE: "success" },
    });

    const occupyingResult = await occupying;
    assert.equal(occupyingResult.status, "timeout");
    assert.equal(capacityFullResult.status, "failed");
    assert.equal(capacityFullResult.errorCode, "capacity_full");
    assert.match(capacityFullResult.error ?? "", /队列已满/);
    assert.equal(capacityFullResult.diagnostics.callerSlot, null);
    assert.equal(capacityFullResult.diagnostics.globalSlot, null);
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
    ["最小 CLI 与时间档位", testMinimalCliAndProfiles],
    ["调用前用时预估", testPreflightEstimate],
    ["路径边界", testPathBoundary],
    ["调用者标识", testCallerId],
    ["能力与技能边界", testCapabilityAndSkillBoundary],
    ["技能路由元数据", testSkillRoutingMetadata],
    ["可信可执行文件解析", testTrustedExecutableResolution],
    ["启动失败结构化诊断", testStructuredStartupFailure],
    ["RPC 成功", testSuccessfulRpc],
    ["Windows 进程树回收", testWindowsProcessTreeCleanup],
    ["RPC 部分完成", testPartialRpc],
    ["两阶段检查点完成", testCheckpointThenComplete],
    ["首检查点独立截止", testCheckpointDeadline],
    ["拒绝退化的后续检查点", testRegressiveCheckpointIsRejected],
    ["拒绝遗漏材料的完成报告", testRegressiveCompleteReportIsRejected],
    ["超时保留最近检查点", testCheckpointSurvivesTimeout],
    ["无效输出", testInvalidOutput],
    ["软截止收尾", testSoftDeadline],
    ["软截止备用收尾", testSoftDeadlineFallback],
    ["容量接入与异常释放", testCapacityIntegrationAndRelease],
    ["全局容量满时立即失败", testCapacityFullFailsImmediately],
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
