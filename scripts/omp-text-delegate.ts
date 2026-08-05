import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  acquireOmpReadCapacity,
  loadOmpReadCapacityConfig,
  OmpReadCapacityError,
  type OmpReadCapacityConfig,
  type OmpReadCapacityErrorCode,
  type OmpReadCapacityLease,
} from "./omp-read-capacity.ts";

export type MaterialType = "code" | "markdown" | "log" | "config" | "text";

export interface OmpReadRequest {
  schemaVersion?: 1;
  callerId?: string;
  objective: string;
  searchRoots?: string[];
  materialTypes?: MaterialType[];
  extensions?: string[];
  questions?: string[];
  excludeHints?: string[];
  limits?: {
    maxTimeSeconds?: number;
    maxFindings?: number;
    maxOutputCharacters?: number;
  };
}

export interface NormalizedOmpReadRequest {
  schemaVersion: 1;
  callerId: string;
  objective: string;
  searchRoots: string[];
  materialTypes: MaterialType[];
  extensions: string[];
  questions: string[];
  excludeHints: string[];
  limits: {
    maxTimeSeconds: number;
    maxFindings: number;
    maxOutputCharacters: number;
  };
}

export interface OmpEvidence {
  path: string;
  lineStart?: number;
  lineEnd?: number;
  note?: string;
}

export interface OmpFinding {
  claim: string;
  evidence: OmpEvidence[];
  confidence?: "high" | "medium" | "low";
}

export interface OmpReadReport {
  completion: "complete" | "partial";
  summary: string;
  findings: OmpFinding[];
  uncertainties: string[];
  filesRead: string[];
}

export type OmpReadStatus =
  | "completed"
  | "partial"
  | "failed"
  | "timeout"
  | "invalid_output";

export interface OmpReadResult {
  schemaVersion: 1;
  runId: string;
  status: OmpReadStatus;
  objective: string;
  report?: OmpReadReport;
  rawOutput?: string;
  error?: string;
  errorCode?: OmpReadCapacityErrorCode | "capacity_unavailable";
  diagnostics: {
    durationMs: number;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    softDeadlineMs: number;
    softDeadlineTriggered: boolean;
    callerId: string;
    queueDurationMs: number;
    callerSlot: number | null;
    globalSlot: number | null;
    stderr?: string;
    protocolWarnings?: string[];
  };
}

export interface RunOmpReadOptions {
  projectRoot?: string;
  command?: string;
  baseArgs?: string[];
  environment?: NodeJS.ProcessEnv;
  systemPrompt?: string;
  timeoutMsOverride?: number;
  softDeadlineMsOverride?: number;
  hardTimeoutGraceMsOverride?: number;
  capacityEnabled?: boolean;
  capacityConfig?: OmpReadCapacityConfig;
  capacityConfigPath?: string;
  capacityRuntimeRoot?: string;
  capacityQueueTimeoutMsOverride?: number;
  capacityHeartbeatIntervalMsOverride?: number;
  capacityStaleAfterMsOverride?: number;
  capacityMaxLeaseMsOverride?: number;
  capacityPollIntervalMsOverride?: number;
}

const MATERIAL_TYPE_EXTENSIONS: Record<MaterialType, string[]> = {
  code: [
    ".c",
    ".cc",
    ".cpp",
    ".cs",
    ".css",
    ".go",
    ".h",
    ".hpp",
    ".html",
    ".java",
    ".js",
    ".jsx",
    ".kt",
    ".kts",
    ".php",
    ".py",
    ".rs",
    ".scss",
    ".sh",
    ".sql",
    ".ts",
    ".tsx",
    ".vue",
  ],
  markdown: [".md", ".mdx"],
  log: [".err", ".log", ".out"],
  config: [
    ".conf",
    ".ini",
    ".json",
    ".properties",
    ".toml",
    ".xml",
    ".yaml",
    ".yml",
  ],
  text: [".csv", ".text", ".txt", ".tsv"],
};

const DEFAULT_EXCLUDE_HINTS = [
  ".git",
  ".svn",
  "node_modules",
  "target",
  "dist",
  "build",
  "二进制文件",
  "压缩包",
  "图片、音频和视频",
];

const DEFAULT_SYSTEM_PROMPT_PATH = fileURLToPath(
  new URL("../.omp/prompts/text-investigator.md", import.meta.url),
);

class RequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringArray(
  value: unknown,
  fieldName: string,
  defaultValue: string[] = [],
): string[] {
  if (value === undefined) {
    return [...defaultValue];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new RequestValidationError(`${fieldName} 必须是字符串数组。`);
  }
  if (value.length > 100) {
    throw new RequestValidationError(`${fieldName} 最多允许 100 项。`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function readBoundedInteger(
  value: unknown,
  fieldName: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) {
    return defaultValue;
  }
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new RequestValidationError(
      `${fieldName} 必须是 ${minimum} 到 ${maximum} 之间的整数。`,
    );
  }
  return Number(value);
}

function toPortablePath(value: string): string {
  return value.split(path.sep).join("/");
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function normalizeRequest(
  input: unknown,
  projectRoot = process.cwd(),
  fallbackCallerId = process.env.PPM_AI_CALLER_ID,
): Promise<NormalizedOmpReadRequest> {
  if (!isRecord(input)) {
    throw new RequestValidationError("请求内容必须是 JSON 对象。");
  }

  const callerIdSource = input.callerId ?? fallbackCallerId;
  const callerId =
    typeof callerIdSource === "string" ? callerIdSource.trim() : "";
  if (
    !callerId ||
    callerId.length > 200 ||
    /[\u0000-\u001f\u007f]/.test(callerId)
  ) {
    throw new RequestValidationError(
      "callerId 必须是 1 到 200 个字符且不含控制字符的稳定调用者标识；也可通过 PPM_AI_CALLER_ID 提供。",
    );
  }

  const objective = typeof input.objective === "string" ? input.objective.trim() : "";
  if (!objective || objective.length > 8000) {
    throw new RequestValidationError("objective 必须是 1 到 8000 个字符的非空字符串。");
  }

  const rawSearchRoots = readStringArray(input.searchRoots, "searchRoots", ["."]);
  const searchRoots: string[] = [];
  for (const rootHint of rawSearchRoots) {
    const resolved = path.resolve(projectRoot, rootHint);
    if (!isPathInside(projectRoot, resolved)) {
      throw new RequestValidationError(`searchRoots 不能超出项目根目录：${rootHint}`);
    }
    try {
      await stat(resolved);
    } catch {
      throw new RequestValidationError(`searchRoots 指向的路径不存在：${rootHint}`);
    }
    const relative = path.relative(projectRoot, resolved);
    searchRoots.push(relative ? toPortablePath(relative) : ".");
  }

  const rawMaterialTypes = readStringArray(input.materialTypes, "materialTypes", [
    "code",
    "markdown",
    "log",
  ]);
  const materialTypes = rawMaterialTypes.map((type) => {
    if (!(type in MATERIAL_TYPE_EXTENSIONS)) {
      throw new RequestValidationError(`不支持的 materialTypes：${type}`);
    }
    return type as MaterialType;
  });

  const extensions = readStringArray(input.extensions, "extensions").map((extension) => {
    const normalized = extension.startsWith(".") ? extension : `.${extension}`;
    if (!/^\.[A-Za-z0-9][A-Za-z0-9._+-]{0,19}$/.test(normalized)) {
      throw new RequestValidationError(`无效的文件扩展名：${extension}`);
    }
    return normalized.toLowerCase();
  });

  const questions = readStringArray(input.questions, "questions");
  const excludeHints = readStringArray(
    input.excludeHints,
    "excludeHints",
    DEFAULT_EXCLUDE_HINTS,
  );
  const rawLimits = input.limits === undefined ? {} : input.limits;
  if (!isRecord(rawLimits)) {
    throw new RequestValidationError("limits 必须是 JSON 对象。");
  }

  return {
    schemaVersion: 1,
    callerId,
    objective,
    searchRoots,
    materialTypes,
    extensions,
    questions,
    excludeHints,
    limits: {
      maxTimeSeconds: readBoundedInteger(
        rawLimits.maxTimeSeconds,
        "limits.maxTimeSeconds",
        600,
        10,
        3600,
      ),
      maxFindings: readBoundedInteger(
        rawLimits.maxFindings,
        "limits.maxFindings",
        30,
        1,
        100,
      ),
      maxOutputCharacters: readBoundedInteger(
        rawLimits.maxOutputCharacters,
        "limits.maxOutputCharacters",
        30000,
        1000,
        100000,
      ),
    },
  };
}

function resolveExtensions(request: NormalizedOmpReadRequest): string[] {
  return [
    ...new Set([
      ...request.materialTypes.flatMap((type) => MATERIAL_TYPE_EXTENSIONS[type]),
      ...request.extensions,
    ]),
  ].sort();
}

export function buildTaskMessage(request: NormalizedOmpReadRequest): string {
  const questionBlock = request.questions.length
    ? request.questions.map((question, index) => `${index + 1}. ${question}`).join("\n")
    : "无额外问题；围绕目标自行拆解调查问题。";

  return `请在当前项目中完成一次只读文本调查。

调查目标：
${request.objective}

优先搜索范围（不是完整文件清单，可在项目内追踪必要的关联文本）：
${request.searchRoots.map((root) => `- ${root}`).join("\n")}

材料类型：${request.materialTypes.join(", ")}
重点文件扩展名：${resolveExtensions(request).join(", ")}
排除提示：${request.excludeHints.join(", ") || "无"}

需要回答的问题：
${questionBlock}

输出限制：
- 总时间硬上限：${request.limits.maxTimeSeconds} 秒；包装器会在硬上限前发送收尾指令，收到后必须立即停止工具调用并输出已有结果。
- findings 最多 ${request.limits.maxFindings} 项。
- 最终 JSON 不超过约 ${request.limits.maxOutputCharacters} 个字符。
- 重要结论必须提供项目相对路径和尽可能准确的行号。
- 如果范围过大、证据不足或时间不够，将 completion 标记为 partial，并在 uncertainties 中说明。
- 不要把 findings 上限或文件数量当作目标；问题已有充分证据时应提前完成。
`;
}

/**
 * 计算开始强制收尾的时刻，为模型保留约 20% 且最多两分钟的报告时间。
 * 短任务至少保留一半时间，避免一次普通的模型响应就耗尽收尾窗口。
 *
 * @param hardTimeoutMs 整个 OMP 调查允许占用的毫秒数。
 * @return 从调查开始到发送收尾指令的毫秒数。
 */
export function calculateSoftDeadlineMs(hardTimeoutMs: number): number {
  const minimumReserveMs = Math.min(30_000, Math.floor(hardTimeoutMs / 2));
  const reserveMs = Math.min(
    120_000,
    Math.max(minimumReserveMs, Math.floor(hardTimeoutMs * 0.2)),
  );
  return Math.max(1, hardTimeoutMs - reserveMs);
}

export function buildOmpArguments(
  request: NormalizedOmpReadRequest,
  systemPrompt: string,
): string[] {
  // OMP 自身的截止只作为进程级保险，略晚于包装器硬截止，避免抢先退出造成状态误判。
  const ompSafetyTimeoutSeconds = request.limits.maxTimeSeconds + 5;
  return [
    "--mode=rpc",
    "--no-session",
    "--no-pty",
    "--no-extensions",
    "--no-skills",
    "--no-lsp",
    "--tools=read,grep,glob",
    `--max-time=${ompSafetyTimeoutSeconds}s`,
    "--append-system-prompt",
    systemPrompt,
  ];
}

function truncate(value: string, maximum: number): string {
  if (value.length <= maximum) {
    return value;
  }
  return `${value.slice(0, maximum)}\n…（已截断）`;
}

function extractAssistantText(data: unknown): string | null {
  if (typeof data === "string") {
    return data;
  }
  if (!isRecord(data)) {
    return null;
  }
  for (const key of ["text", "lastAssistantText", "content", "message"]) {
    const value = data[key];
    if (typeof value === "string") {
      return value;
    }
    if (isRecord(value) && typeof value.text === "string") {
      return value.text;
    }
  }
  return null;
}

function extractJsonObject(rawOutput: string): unknown {
  let candidate = rawOutput.trim();
  if (candidate.startsWith("```")) {
    candidate = candidate.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error("OMP 最终输出中没有可解析的 JSON 对象。");
  }
}

function parseReport(rawOutput: string): OmpReadReport {
  const parsed = extractJsonObject(rawOutput);
  if (!isRecord(parsed)) {
    throw new Error("OMP 最终输出不是 JSON 对象。");
  }
  if (parsed.completion !== "complete" && parsed.completion !== "partial") {
    throw new Error("OMP 输出缺少有效的 completion。");
  }
  if (typeof parsed.summary !== "string" || !Array.isArray(parsed.findings)) {
    throw new Error("OMP 输出缺少有效的 summary 或 findings。");
  }

  const findings: OmpFinding[] = parsed.findings.map((finding, findingIndex) => {
    if (!isRecord(finding) || typeof finding.claim !== "string") {
      throw new Error(`OMP 输出中的 findings[${findingIndex}] 无效。`);
    }
    if (!Array.isArray(finding.evidence)) {
      throw new Error(`OMP 输出中的 findings[${findingIndex}].evidence 无效。`);
    }
    const evidence: OmpEvidence[] = finding.evidence.map((item, evidenceIndex) => {
      if (!isRecord(item) || typeof item.path !== "string") {
        throw new Error(
          `OMP 输出中的 findings[${findingIndex}].evidence[${evidenceIndex}] 无效。`,
        );
      }
      return {
        path: item.path,
        lineStart: typeof item.lineStart === "number" ? item.lineStart : undefined,
        lineEnd: typeof item.lineEnd === "number" ? item.lineEnd : undefined,
        note: typeof item.note === "string" ? item.note : undefined,
      };
    });
    const confidence =
      finding.confidence === "high" ||
      finding.confidence === "medium" ||
      finding.confidence === "low"
        ? finding.confidence
        : undefined;
    return { claim: finding.claim, evidence, confidence };
  });

  const uncertainties = Array.isArray(parsed.uncertainties)
    ? parsed.uncertainties.filter((item): item is string => typeof item === "string")
    : [];
  const filesRead = Array.isArray(parsed.filesRead)
    ? parsed.filesRead.filter((item): item is string => typeof item === "string")
    : [];

  return {
    completion: parsed.completion,
    summary: parsed.summary,
    findings,
    uncertainties,
    filesRead,
  };
}

function appendBounded(current: string, addition: string, maximum: number): string {
  return truncate(`${current}${addition}`, maximum);
}

export async function runOmpRead(
  request: NormalizedOmpReadRequest,
  options: RunOmpReadOptions = {},
): Promise<OmpReadResult> {
  const capacityRequestedAt = Date.now();
  const runId = randomUUID();
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  let capacityLease: OmpReadCapacityLease | undefined;

  if (options.capacityEnabled !== false) {
    try {
      const capacityConfig =
        options.capacityConfig ??
        (await loadOmpReadCapacityConfig(projectRoot, options.capacityConfigPath));
      capacityLease = await acquireOmpReadCapacity({
        projectRoot,
        callerId: request.callerId,
        runId,
        config: capacityConfig,
        runtimeRoot: options.capacityRuntimeRoot,
        queueTimeoutMsOverride: options.capacityQueueTimeoutMsOverride,
        heartbeatIntervalMsOverride: options.capacityHeartbeatIntervalMsOverride,
        staleAfterMsOverride: options.capacityStaleAfterMsOverride,
        maxLeaseMsOverride: options.capacityMaxLeaseMsOverride,
        pollIntervalMsOverride: options.capacityPollIntervalMsOverride,
      });
    } catch (error) {
      const capacityError =
        error instanceof OmpReadCapacityError ? error : undefined;
      return {
        schemaVersion: 1,
        runId,
        status: "failed",
        objective: request.objective,
        error:
          capacityError?.message ??
          `无法取得 OMP 阅读容量：${error instanceof Error ? error.message : String(error)}`,
        errorCode: capacityError?.code ?? "capacity_unavailable",
        diagnostics: {
          durationMs: 0,
          exitCode: null,
          signal: null,
          softDeadlineMs: 0,
          softDeadlineTriggered: false,
          callerId: request.callerId,
          queueDurationMs: Date.now() - capacityRequestedAt,
          callerSlot: null,
          globalSlot: null,
        },
      };
    }
  }

  const queueDurationMs = capacityLease?.queueDurationMs ?? 0;
  const startedAt = Date.now();
  try {
    const systemPrompt =
      options.systemPrompt ?? (await readFile(DEFAULT_SYSTEM_PROMPT_PATH, "utf8"));
    const command = options.command ?? process.env.PPM_OMP_COMMAND ?? "omp";
    const args = [
      ...(options.baseArgs ?? []),
      ...buildOmpArguments(request, systemPrompt),
    ];
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: { ...process.env, ...options.environment },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    if (child.pid) {
      try {
        await capacityLease?.attachChildProcess(child.pid);
      } catch (error) {
        child.kill();
        throw error;
      }
    }

    return await new Promise<OmpReadResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let promptSent = false;
    let resultRequested = false;
    let pendingStatus: OmpReadStatus | null = null;
    let pendingReport: OmpReadReport | undefined;
    let pendingRawOutput: string | undefined;
    let pendingError: string | undefined;
    let stderr = "";
    const protocolWarnings: string[] = [];
    let completionKillTimer: NodeJS.Timeout | undefined;
    let hardTimeoutFinalizeTimer: NodeJS.Timeout | undefined;

    const stdoutLines = readline.createInterface({ input: child.stdout });
    const timeoutMs = options.timeoutMsOverride ?? request.limits.maxTimeSeconds * 1000;
    const softDeadlineMs = Math.min(
      timeoutMs - 1,
      Math.max(
        1,
        options.softDeadlineMsOverride ?? calculateSoftDeadlineMs(timeoutMs),
      ),
    );
    const hardTimeoutGraceMs = options.hardTimeoutGraceMsOverride ?? 2_000;
    let softDeadlineReached = false;
    let softDeadlineTriggered = false;
    let softDeadlineTimer: NodeJS.Timeout | undefined;

    const finalize = (
      status: OmpReadStatus,
      exitCode: number | null,
      signal: NodeJS.Signals | null,
      details: {
        report?: OmpReadReport;
        rawOutput?: string;
        error?: string;
      } = {},
    ) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      if (softDeadlineTimer) {
        clearTimeout(softDeadlineTimer);
      }
      if (completionKillTimer) {
        clearTimeout(completionKillTimer);
      }
      if (hardTimeoutFinalizeTimer) {
        clearTimeout(hardTimeoutFinalizeTimer);
      }
      stdoutLines.close();
      resolve({
        schemaVersion: 1,
        runId,
        status,
        objective: request.objective,
        report: details.report,
        rawOutput: details.rawOutput,
        error: details.error,
        diagnostics: {
          durationMs: Date.now() - startedAt,
          exitCode,
          signal,
          softDeadlineMs,
          softDeadlineTriggered,
          callerId: request.callerId,
          queueDurationMs,
          callerSlot: capacityLease?.callerSlot ?? null,
          globalSlot: capacityLease?.globalSlot ?? null,
          stderr: stderr || undefined,
          protocolWarnings: protocolWarnings.length ? protocolWarnings : undefined,
        },
      });
    };

    const sendFrame = (frame: Record<string, unknown>) => {
      if (!child.stdin.destroyed && child.stdin.writable) {
        child.stdin.write(`${JSON.stringify(frame)}\n`);
      }
    };

    const requestFinalText = () => {
      if (resultRequested || timedOut) {
        return;
      }
      resultRequested = true;
      sendFrame({ id: "omp-read-result", type: "get_last_assistant_text" });
    };

    /**
     * 使用当前已经解析出的结果结束任务，避免子进程退出竞态把有效报告覆盖成超时。
     *
     * @param exitCode OMP 已退出时的退出码；强制收尾时为 null。
     * @param signal OMP 已退出时的信号；强制收尾时为 null。
     * @return 存在待返回结果并完成最终化时返回 true。
     */
    const finalizePendingResult = (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
    ): boolean => {
      if (!pendingStatus) {
        return false;
      }
      finalize(pendingStatus, exitCode, signal, {
        report: pendingReport,
        rawOutput: pendingRawOutput,
        error: pendingError,
      });
      return true;
    };

    /**
     * 在硬超时前终止正在扩张的调查，并启动一个只负责生成结果的收尾轮次。
     */
    const requestSoftFinish = () => {
      softDeadlineReached = true;
      if (softDeadlineTriggered || timedOut || resultRequested || !promptSent) {
        return;
      }
      softDeadlineTriggered = true;
      sendFrame({
        id: "omp-read-soft-deadline",
        type: "abort_and_prompt",
        message:
          "本次调查已进入收尾阶段。立即停止发起新的 glob、grep 或 read 调用，只基于已经取得的证据输出规定的最终 JSON。未完成的内容写入 uncertainties，并将 completion 标记为 partial；不要继续扩大调查范围。",
      });
    };

    // 在硬截止前主动触发收尾，避免模型用完全部时间后无法生成最终 JSON。
    softDeadlineTimer = setTimeout(requestSoftFinish, softDeadlineMs);

    const timeoutTimer = setTimeout(() => {
      // 最终报告已经到达时以报告为准，并终止仍未自行退出的 RPC 进程。
      if (pendingStatus) {
        child.stdin.end();
        child.kill();
        finalizePendingResult(null, null);
        return;
      }
      timedOut = true;
      sendFrame({ id: "omp-read-abort", type: "abort" });
      setTimeout(() => child.kill(), 250).unref();

      // 即使外部进程忽略 abort/kill，也必须在有限宽限期后释放调用方。
      hardTimeoutFinalizeTimer = setTimeout(() => {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        child.kill();
        child.unref();
        finalize("timeout", null, null, { error: "OMP 阅读任务执行超时。" });
      }, hardTimeoutGraceMs);
      hardTimeoutFinalizeTimer.unref();
    }, timeoutMs);

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk, 20000);
    });

    child.on("error", (error) => {
      finalize("failed", null, null, { error: `无法启动 OMP：${error.message}` });
    });

    child.on("exit", (exitCode, signal) => {
      if (timedOut) {
        finalize("timeout", exitCode, signal, { error: "OMP 阅读任务执行超时。" });
        return;
      }
      if (finalizePendingResult(exitCode, signal)) {
        return;
      }
      const error =
        exitCode === 0
          ? "OMP 在返回最终结果前结束。"
          : `OMP 异常退出，退出码：${exitCode ?? "未知"}。`;
      finalize("failed", exitCode, signal, { error });
    });

    stdoutLines.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      let frame: Record<string, unknown>;
      try {
        const parsed = JSON.parse(trimmed);
        if (!isRecord(parsed)) {
          throw new Error("RPC 帧不是 JSON 对象");
        }
        frame = parsed;
      } catch (error) {
        protocolWarnings.push(
          `无法解析 RPC 输出：${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }

      if (frame.type === "ready" && !promptSent) {
        promptSent = true;
        sendFrame({
          id: "omp-read-prompt",
          type: "prompt",
          message: buildTaskMessage(request),
        });
        if (softDeadlineReached) {
          requestSoftFinish();
        }
        return;
      }

      if (
        frame.type === "response" &&
        frame.id === "omp-read-prompt" &&
        frame.success === false
      ) {
        pendingStatus = "failed";
        pendingError =
          typeof frame.error === "string" ? frame.error : "OMP 拒绝了阅读任务。";
        child.stdin.end();
        return;
      }

      if (
        frame.type === "response" &&
        frame.id === "omp-read-soft-deadline" &&
        frame.success === false
      ) {
        protocolWarnings.push(
          `OMP 拒绝收尾指令：${typeof frame.error === "string" ? frame.error : "未知原因"}`,
        );
        // 兼容不支持 abort_and_prompt 的 RPC 实现，退回到流式 steer 收尾。
        sendFrame({
          id: "omp-read-soft-deadline-fallback",
          type: "steer",
          message:
            "立即停止新的工具调用，只基于已有证据输出最终 JSON；未完成内容写入 uncertainties，并将 completion 标记为 partial。",
        });
        return;
      }

      if (
        frame.type === "response" &&
        frame.id === "omp-read-soft-deadline-fallback" &&
        frame.success === false
      ) {
        protocolWarnings.push(
          `OMP 拒绝备用收尾指令：${typeof frame.error === "string" ? frame.error : "未知原因"}`,
        );
        return;
      }

      if (frame.type === "agent_end" && frame.isTerminal !== false) {
        requestFinalText();
        return;
      }

      if (frame.type === "response" && frame.id === "omp-read-result") {
        if (frame.success === false) {
          pendingStatus = "failed";
          pendingError =
            typeof frame.error === "string" ? frame.error : "无法取得 OMP 最终输出。";
        } else {
          const rawOutput = extractAssistantText(frame.data);
          if (rawOutput === null) {
            pendingStatus = "invalid_output";
            pendingError = "OMP 返回的最终文本格式无法识别。";
          } else {
            try {
              const report = parseReport(rawOutput);
              pendingStatus = report.completion === "partial" ? "partial" : "completed";
              pendingReport = report;
            } catch (error) {
              pendingStatus = "invalid_output";
              pendingRawOutput = truncate(rawOutput, request.limits.maxOutputCharacters);
              pendingError = error instanceof Error ? error.message : String(error);
            }
          }
        }
        child.stdin.end();
        completionKillTimer = setTimeout(() => child.kill(), 3000);
        completionKillTimer.unref();
      }
    });
    });
  } finally {
    await capacityLease?.release();
  }
}

function printUsage(): void {
  process.stdout.write(`用法：
  bun run omp:read -- --request <请求文件.json>

请求示例：
  {
    "callerId": "codex:stable-task-id",
    "objective": "梳理登录鉴权调用链",
    "searchRoots": ["projects/example/src"],
    "materialTypes": ["code", "markdown", "log"],
    "questions": ["入口在哪里？", "Token 在哪里生成和验证？"]
  }
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }
  const requestIndex = args.indexOf("--request");
  if (requestIndex < 0 || !args[requestIndex + 1]) {
    printUsage();
    process.exitCode = 2;
    return;
  }

  try {
    const requestPath = path.resolve(args[requestIndex + 1]);
    const rawRequest = JSON.parse(await readFile(requestPath, "utf8"));
    const request = await normalizeRequest(rawRequest, process.cwd());
    console.error("正在申请 OMP 阅读容量并准备只读文本调查……");
    const result = await runOmpRead(request, { projectRoot: process.cwd() });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status !== "completed" && result.status !== "partial") {
      process.exitCode = 1;
    }
  } catch (error) {
    const result: OmpReadResult = {
      schemaVersion: 1,
      runId: randomUUID(),
      status: "failed",
      objective: "",
      error: error instanceof Error ? error.message : String(error),
      diagnostics: {
        durationMs: 0,
        exitCode: null,
        signal: null,
        softDeadlineMs: 0,
        softDeadlineTriggered: false,
        callerId: "",
        queueDurationMs: 0,
        callerSlot: null,
        globalSlot: null,
      },
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = 1;
  }
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (path.resolve(currentFile) === invokedFile) {
  await main();
}
