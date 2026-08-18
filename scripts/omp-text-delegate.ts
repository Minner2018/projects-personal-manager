import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
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
  type OmpReadThinkingLevel,
} from "./omp-read-capacity.ts";
import {
  estimateOmpReadTime,
  OMP_READ_PROFILE_LIMITS,
  OMP_READ_PROFILE_TIME_RANGES,
  reviseOmpReadTimeEstimate,
  type OmpReadCheckpointEstimate,
  type OmpReadPreflightEstimate,
  type OmpReadProfile,
  type OmpReadRequestedProfile,
} from "./omp-read-estimate.ts";

export type MaterialType = "code" | "markdown" | "log" | "config" | "text";

export interface OmpReadRequest {
  schemaVersion?: 1;
  callerId?: string;
  objective: string;
  profile?: OmpReadRequestedProfile;
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
  profile: OmpReadRequestedProfile;
  limitsCustomized: boolean;
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
    callerSlot: number | null;
    globalSlot: number | null;
    effectiveProfile?: OmpReadProfile | "custom";
    preflightEstimate?: OmpReadPreflightEstimate;
    revisedEstimate?: OmpReadCheckpointEstimate;
    checkpointCount?: number;
    checkpointDurationsMs?: number[];
    checkpointDeadlineMs?: number;
    checkpointDeadlineTriggered?: boolean;
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
  capacityHeartbeatIntervalMsOverride?: number;
  capacityStaleAfterMsOverride?: number;
  capacityMaxLeaseMsOverride?: number;
  preflightEstimate?: OmpReadPreflightEstimate;
}

export interface OmpReadModelSelection {
  model: string;
  thinking: OmpReadThinkingLevel;
}

// OMP 17.2.12 的 CLI 只接受内建工具名；MCP 工具由启动后的发现流程挂载，
// 再由专用覆盖配置逐工具批准。不要把 MCP 名称直接塞进 --tools。
const OMP_READ_TOOL_NAMES = ["read", "grep", "glob"] as const;

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
const DEFAULT_OMP_READ_CONFIG_PATH = fileURLToPath(
  new URL("../.omp/configs/text-investigator.yml", import.meta.url),
);

class RequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestValidationError";
  }
}

function readEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const expectedName = process.platform === "win32" ? name.toLowerCase() : name;
  let matched = false;
  let resolvedValue: string | undefined;
  for (const [entryName, value] of Object.entries(environment)) {
    const normalizedName =
      process.platform === "win32" ? entryName.toLowerCase() : entryName;
    if (normalizedName === expectedName) {
      matched = true;
      resolvedValue = value?.trim() || undefined;
    }
  }
  return matched ? resolvedValue : undefined;
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const candidateStat = await stat(candidate);
    if (!candidateStat.isFile()) {
      return false;
    }
    await access(
      candidate,
      process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * 从可信 PATH 目录解析可执行文件，显式排除工作区、包管理器本地 bin 和相对目录。
 *
 * Windows/libuv 默认会先搜索当前目录，Bun 的 package script 还会把项目内
 * node_modules/.bin 注入 PATH；这里自行解析绝对路径，避免工作区内同名程序抢先执行。
 */
async function resolveExecutableFromTrustedPath(
  executableName: string,
  environment: NodeJS.ProcessEnv,
  currentWorkingDirectory: string,
): Promise<string> {
  const pathValue = readEnvironmentValue(environment, "PATH");
  if (!pathValue) {
    throw new Error(`无法解析 ${executableName}：PATH 为空。`);
  }

  const hasExtension = path.extname(executableName) !== "";
  const candidateNames =
    process.platform === "win32" && !hasExtension
      ? [`${executableName}.com`, `${executableName}.exe`]
      : [executableName];

  for (const rawDirectory of pathValue.split(path.delimiter)) {
    const directory = rawDirectory.trim().replace(/^(["'])(.*)\1$/, "$2");
    const normalizedSegments = path
      .resolve(directory || currentWorkingDirectory)
      .split(/[\\/]+/)
      .map((segment) => segment.toLowerCase());
    const isPackageManagerBin = normalizedSegments.some(
      (segment, index) =>
        segment === "node_modules" && normalizedSegments[index + 1] === ".bin",
    );
    if (
      !directory ||
      !path.isAbsolute(directory) ||
      isPathInside(currentWorkingDirectory, directory) ||
      isPackageManagerBin
    ) {
      continue;
    }
    for (const candidateName of candidateNames) {
      const candidate = path.join(directory, candidateName);
      if (await isExecutableFile(candidate)) {
        return path.resolve(candidate);
      }
    }
  }

  throw new Error(
    `无法在可信 PATH 目录中找到 ${executableName}；工作区、node_modules/.bin、空目录和相对目录不会参与搜索。`,
  );
}

/** 解析 OMP 的绝对可执行文件路径。 */
export async function resolveOmpCommand(
  configuredCommand: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
  currentWorkingDirectory = process.cwd(),
): Promise<string> {
  const explicitCommand =
    configuredCommand?.trim() || readEnvironmentValue(environment, "PPM_OMP_COMMAND");
  if (explicitCommand) {
    if (!path.isAbsolute(explicitCommand)) {
      throw new Error(
        `OMP 命令必须使用绝对路径；当前配置为：${explicitCommand}`,
      );
    }
    if (!(await isExecutableFile(explicitCommand))) {
      throw new Error(`OMP 可执行文件不存在或不可执行：${explicitCommand}`);
    }
    return path.resolve(explicitCommand);
  }
  return await resolveExecutableFromTrustedPath(
    "omp",
    environment,
    currentWorkingDirectory,
  );
}

/** 解析 Windows 系统目录中的可信系统程序。 */
export async function resolveWindowsSystemExecutable(
  executableName: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (process.platform !== "win32") {
    throw new Error("Windows 系统程序只能在 Windows 上解析。");
  }
  if (path.basename(executableName) !== executableName) {
    throw new Error(`Windows 系统程序名称不能包含路径：${executableName}`);
  }
  const systemRoot =
    readEnvironmentValue(environment, "SystemRoot") ??
    readEnvironmentValue(environment, "WINDIR");
  if (!systemRoot || !path.isAbsolute(systemRoot)) {
    throw new Error("无法从 SystemRoot/WINDIR 取得可信 Windows 系统目录。");
  }
  const candidate = path.join(systemRoot, "System32", executableName);
  if (!(await isExecutableFile(candidate))) {
    throw new Error(`Windows 系统程序不存在或不可执行：${candidate}`);
  }
  return path.resolve(candidate);
}

/**
 * 终止 OMP 及其启动的 stdio MCP 子进程。
 *
 * Windows 的 ChildProcess.kill() 只结束直接子进程；Repowise/CMM 会被重新托管并继续
 * 运行。因此在 OMP 父进程仍存活时使用 taskkill 的 /T 精确回收该 PID 的整棵进程树。
 * 其他平台保留 Node 原生终止行为。
 *
 * @param onWarning Windows 树终止失败并退回直接终止时的诊断回调。
 */
function terminateProcessTree(
  child: ChildProcess,
  windowsTaskkillCommand: string | undefined,
  onWarning: (message: string) => void = () => {},
): void {
  if (process.platform === "win32" && child.pid) {
    let fallbackStarted = false;
    const fallbackToParentKill = (detail: string) => {
      if (fallbackStarted) {
        return;
      }
      fallbackStarted = true;
      child.kill();
      onWarning(
        `无法按 OMP PID 终止 Windows 进程树，已退回直接终止父进程：${detail}`,
      );
    };
    if (!windowsTaskkillCommand || !path.isAbsolute(windowsTaskkillCommand)) {
      fallbackToParentKill("未取得可信 taskkill.exe 绝对路径");
      return;
    }
    const killer = spawn(
      windowsTaskkillCommand,
      ["/PID", String(child.pid), "/T", "/F"],
      {
        windowsHide: true,
        stdio: "ignore",
      },
    );
    killer.once("error", (error) => fallbackToParentKill(error.message));
    killer.once("exit", (exitCode) => {
      if (
        exitCode !== 0 &&
        child.exitCode === null &&
        child.signalCode === null
      ) {
        fallbackToParentKill(`taskkill 退出码 ${exitCode ?? "未知"}`);
      }
    });
    return;
  }
  child.kill();
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

  const profileSource = input.profile ?? "auto";
  if (
    profileSource !== "auto" &&
    profileSource !== "quick" &&
    profileSource !== "standard" &&
    profileSource !== "deep"
  ) {
    throw new RequestValidationError(
      "profile 只能是 auto、quick、standard 或 deep。",
    );
  }
  const profile = profileSource as OmpReadRequestedProfile;

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
  const limitsCustomized = Object.keys(rawLimits).length > 0;
  const defaultProfile = profile === "auto" ? "standard" : profile;
  const defaultLimits = OMP_READ_PROFILE_LIMITS[defaultProfile];

  return {
    schemaVersion: 1,
    callerId,
    objective,
    profile,
    limitsCustomized,
    searchRoots,
    materialTypes,
    extensions,
    questions,
    excludeHints,
    limits: {
      maxTimeSeconds: readBoundedInteger(
        rawLimits.maxTimeSeconds,
        "limits.maxTimeSeconds",
        defaultLimits.maxTimeSeconds,
        10,
        3600,
      ),
      maxFindings: readBoundedInteger(
        rawLimits.maxFindings,
        "limits.maxFindings",
        defaultLimits.maxFindings,
        1,
        100,
      ),
      maxOutputCharacters: readBoundedInteger(
        rawLimits.maxOutputCharacters,
        "limits.maxOutputCharacters",
        defaultLimits.maxOutputCharacters,
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
 * 构造第一阶段的范围检查点任务，要求先交付可复用结果再继续深入调查。
 *
 * @param request 已规范化的 OMP 阅读请求。
 * @return 第一阶段发送给 OMP 的完整提示消息。
 */
export function buildCheckpointTaskMessage(
  request: NormalizedOmpReadRequest,
): string {
  return `${buildTaskMessage(request)}
当前是第一阶段“范围定位检查点”：
- 优先定位入口、关键候选文件和最可能的调查路径，不做无边界遍历。
- 最多选择 8 个高价值文件进行必要验证。
- 本轮必须返回符合协议的累计 JSON 报告；尚未完成时使用 partial。
- 这份报告会被包装器保存为检查点，后续超时也必须能供主 AI 继续工作。
`;
}

/**
 * 构造第二阶段的深入验证任务，要求返回覆盖上一检查点的累计报告。
 *
 * @param request 已规范化的 OMP 阅读请求。
 * @param remainingSeconds 当前硬截止前剩余的秒数。
 * @return 第二阶段发送给 OMP 的提示消息。
 */
export function buildContinuationTaskMessage(
  request: NormalizedOmpReadRequest,
  remainingSeconds: number,
): string {
  return `继续完成上一轮只读文本调查，目标仍然是：${request.objective}

当前是第二阶段“关键证据验证”：
- 基于上一轮已经定位的范围，只验证最影响结论的调用关系、分支和证据。
- 不重新进行全项目扫描，不重复读取已经足够支持结论的材料。
- 距离包装器硬截止约剩余 ${Math.max(1, remainingSeconds)} 秒，应主动预留最终输出时间。
- 返回一份完整的累计 JSON 报告，必须包含并更新上一轮仍然有效的结论；不能只返回增量。
- 无法完成的部分放入 uncertainties，并将 completion 标记为 partial。
`;
}

function resolveEffectiveRequest(
  request: NormalizedOmpReadRequest,
  estimate: OmpReadPreflightEstimate,
): {
  request: NormalizedOmpReadRequest;
  effectiveProfile: OmpReadProfile | "custom";
} {
  if (request.limitsCustomized) {
    return { request, effectiveProfile: "custom" };
  }
  const effectiveProfile =
    request.profile === "auto" ? estimate.recommendedProfile : request.profile;
  return {
    request: {
      ...request,
      limits: { ...OMP_READ_PROFILE_LIMITS[effectiveProfile] },
    },
    effectiveProfile,
  };
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

/**
 * 计算首个范围检查点的独立截止，兼顾任务预估、实际档位和总软截止。
 *
 * @param softDeadlineMs 整个调查进入最终收尾的毫秒时刻。
 * @param estimate 调用前对首检查点耗时的静态预估。
 * @param effectiveProfile 实际生效的时间档位；自定义限制使用静态预估。
 * @return 从调查开始到请求首检查点收尾的毫秒数。
 */
export function calculateCheckpointDeadlineMs(
  softDeadlineMs: number,
  estimate: OmpReadPreflightEstimate,
  effectiveProfile: OmpReadProfile | "custom",
): number {
  const profileMaximumSeconds =
    effectiveProfile === "custom"
      ? estimate.firstCheckpointSeconds.max
      : OMP_READ_PROFILE_TIME_RANGES[effectiveProfile].firstCheckpointSeconds.max;
  return Math.min(
    Math.max(
      1,
      Math.min(estimate.firstCheckpointSeconds.max, profileMaximumSeconds) * 1000,
    ),
    Math.max(1, Math.floor(softDeadlineMs * 0.8)),
  );
}

export function buildOmpArguments(
  request: NormalizedOmpReadRequest,
  systemPrompt: string,
  modelSelection?: OmpReadModelSelection,
): string[] {
  // OMP 自身的截止只作为进程级保险，略晚于包装器硬截止，避免抢先退出造成状态误判。
  const ompSafetyTimeoutSeconds = request.limits.maxTimeSeconds + 5;
  return [
    ...(modelSelection
      ? [
          `--model=${modelSelection.model}`,
          `--thinking=${modelSelection.thinking}`,
        ]
      : []),
    "--mode=rpc",
    "--no-session",
    "--no-pty",
    "--no-extensions",
    "--no-skills",
    "--no-lsp",
    `--tools=${OMP_READ_TOOL_NAMES.join(",")}`,
    `--config=${DEFAULT_OMP_READ_CONFIG_PATH}`,
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

/**
 * 阻止信息退化的后续 partial 报告覆盖更完整的既有检查点。
 *
 * @param previous 最近一次有效累计报告；首轮调用时为空。
 * @param current 当前阶段返回并通过协议校验的报告。
 * @return 可安全保存的累计报告，以及需要写入诊断的退化警告。
 */
function preserveCumulativeCheckpoint(
  previous: OmpReadReport | undefined,
  current: OmpReadReport,
): { report: OmpReadReport; warning?: string } {
  if (!previous) {
    return { report: current };
  }
  const currentFiles = new Set(current.filesRead);
  const missingPreviousFiles = previous.filesRead.filter(
    (file) => !currentFiles.has(file),
  );
  if (
    missingPreviousFiles.length === 0 &&
    (current.completion === "complete" ||
      current.findings.length >= previous.findings.length)
  ) {
    return { report: current };
  }
  const warning =
    "OMP 后续 partial 报告未完整覆盖上一检查点，已保留信息更完整的旧检查点。";
  return {
    report: {
      ...previous,
      completion: "partial",
      uncertainties: [...new Set([...previous.uncertainties, warning])],
    },
    warning,
  };
}

function appendBounded(current: string, addition: string, maximum: number): string {
  return truncate(`${current}${addition}`, maximum);
}

export async function runOmpRead(
  inputRequest: NormalizedOmpReadRequest,
  options: RunOmpReadOptions = {},
): Promise<OmpReadResult> {
  const runId = randomUUID();
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  let request = inputRequest;
  let effectiveProfile: OmpReadProfile | "custom" | undefined;
  let preflightEstimate: OmpReadPreflightEstimate | undefined;
  let startedAt = Date.now();
  let capacityLease: OmpReadCapacityLease | undefined;
  let modelSelection: OmpReadModelSelection | undefined;

  if (options.capacityEnabled !== false) {
    try {
      const capacityConfig =
        options.capacityConfig ??
        (await loadOmpReadCapacityConfig(projectRoot, options.capacityConfigPath));
      modelSelection = {
        model: capacityConfig.model,
        thinking: capacityConfig.thinking,
      };
      capacityLease = await acquireOmpReadCapacity({
        projectRoot,
        callerId: inputRequest.callerId,
        runId,
        config: capacityConfig,
        runtimeRoot: options.capacityRuntimeRoot,
        heartbeatIntervalMsOverride: options.capacityHeartbeatIntervalMsOverride,
        staleAfterMsOverride: options.capacityStaleAfterMsOverride,
        maxLeaseMsOverride: options.capacityMaxLeaseMsOverride,
      });
    } catch (error) {
      const capacityError =
        error instanceof OmpReadCapacityError ? error : undefined;
      return {
        schemaVersion: 1,
        runId,
        status: "failed",
        objective: inputRequest.objective,
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
          callerId: inputRequest.callerId,
          callerSlot: null,
          globalSlot: null,
          checkpointCount: 0,
          checkpointDurationsMs: [],
        },
      };
    }
  }

  try {
    const activePreflightEstimate =
      options.preflightEstimate ??
      (await estimateOmpReadTime({
        projectRoot,
        searchRoots: inputRequest.searchRoots,
        extensions: resolveExtensions(inputRequest),
        excludeHints: inputRequest.excludeHints,
        objective: inputRequest.objective,
        questions: inputRequest.questions,
      }));
    preflightEstimate = activePreflightEstimate;
    const prepared = resolveEffectiveRequest(inputRequest, activePreflightEstimate);
    request = prepared.request;
    const activeEffectiveProfile = prepared.effectiveProfile;
    effectiveProfile = activeEffectiveProfile;
    startedAt = Date.now();

    const systemPrompt =
      options.systemPrompt ?? (await readFile(DEFAULT_SYSTEM_PROMPT_PATH, "utf8"));
    const childEnvironment = { ...process.env, ...options.environment };
    const command = await resolveOmpCommand(
      options.command,
      childEnvironment,
      projectRoot,
    );
    const windowsTaskkillCommand =
      process.platform === "win32"
        ? await resolveWindowsSystemExecutable("taskkill.exe", process.env)
        : undefined;
    const args = [
      ...(options.baseArgs ?? []),
      ...buildOmpArguments(request, systemPrompt, modelSelection),
    ];
    const protocolWarnings: string[] = [];
    const recordStdinError = (error: Error) => {
      protocolWarnings.push(`OMP 标准输入写入失败：${error.message}`);
    };
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: childEnvironment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdin.on("error", recordStdinError);
    if (child.pid) {
      try {
        await capacityLease?.attachChildProcess(child.pid);
      } catch (error) {
        terminateProcessTree(child, windowsTaskkillCommand);
        throw error;
      }
    }

    return await new Promise<OmpReadResult>((resolve) => {
      let settled = false;
      let timedOut = false;
      let promptSent = false;
      let activeStage = 0;
      let activePromptId: string | undefined;
      let activeResultId: string | undefined;
      let currentStageStartedAt = startedAt;
      let pendingStatus: OmpReadStatus | null = null;
      let pendingReport: OmpReadReport | undefined;
      let pendingRawOutput: string | undefined;
      let pendingError: string | undefined;
      let latestReport: OmpReadReport | undefined;
      let revisedEstimate: OmpReadCheckpointEstimate | undefined;
      let checkpointCount = 0;
      const checkpointDurationsMs: number[] = [];
      let checkpointDeadlineTriggered = false;
      let stderr = "";
      let hardTimeoutFinalizeTimer: NodeJS.Timeout | undefined;
      let processShutdownStarted = false;

      const stdoutLines = readline.createInterface({ input: child.stdout });
      const timeoutMs =
        options.timeoutMsOverride ?? request.limits.maxTimeSeconds * 1000;
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
      let checkpointDeadlineTimer: NodeJS.Timeout | undefined;
      const checkpointDeadlineMs = calculateCheckpointDeadlineMs(
        softDeadlineMs,
        activePreflightEstimate,
        activeEffectiveProfile,
      );

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
        if (checkpointDeadlineTimer) {
          clearTimeout(checkpointDeadlineTimer);
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
            callerSlot: capacityLease?.callerSlot ?? null,
            globalSlot: capacityLease?.globalSlot ?? null,
            effectiveProfile,
            preflightEstimate,
            revisedEstimate,
            checkpointCount,
            checkpointDurationsMs,
            checkpointDeadlineMs,
            checkpointDeadlineTriggered,
            stderr: stderr || undefined,
            protocolWarnings: protocolWarnings.length ? protocolWarnings : undefined,
          },
        });
      };

      const sendFrame = (frame: Record<string, unknown>) => {
        if (!child.stdin.destroyed && child.stdin.writable) {
          try {
            child.stdin.write(`${JSON.stringify(frame)}\n`);
          } catch (error) {
            recordStdinError(error instanceof Error ? error : new Error(String(error)));
          }
        }
      };

      const toPartialReport = (
        report: OmpReadReport,
        uncertainty: string,
      ): OmpReadReport => ({
        ...report,
        completion: "partial",
        uncertainties: [...new Set([...report.uncertainties, uncertainty])],
      });

      const beginProcessShutdown = () => {
        if (processShutdownStarted) {
          return;
        }
        processShutdownStarted = true;
        terminateProcessTree(child, windowsTaskkillCommand, (warning) =>
          protocolWarnings.push(warning),
        );
      };

      const finishWithReport = (report: OmpReadReport) => {
        pendingStatus = report.completion === "partial" ? "partial" : "completed";
        pendingReport = report;
        beginProcessShutdown();
      };

      const finishWithLatestReport = (uncertainty: string): boolean => {
        if (!latestReport) {
          return false;
        }
        pendingError = uncertainty;
        finishWithReport(toPartialReport(latestReport, uncertainty));
        return true;
      };

      /**
       * 使用当前已经解析出的结果结束任务，避免子进程退出竞态覆盖有效报告。
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

      const finalizeTimeoutResult = (
        exitCode: number | null,
        signal: NodeJS.Signals | null,
      ) => {
        if (latestReport) {
          finalize("partial", exitCode, signal, {
            report: toPartialReport(
              latestReport,
              "后续调查达到硬时间上限，已返回最近一次有效检查点。",
            ),
            error: "OMP 后续调查超时，已保留最近有效检查点。",
          });
          return;
        }
        finalize("timeout", exitCode, signal, { error: "OMP 阅读任务执行超时。" });
      };

      const startStage = (stage: 1 | 2) => {
        activeStage = stage;
        activePromptId = `omp-read-prompt-${stage}`;
        activeResultId = undefined;
        currentStageStartedAt = Date.now();
        promptSent = true;
        const elapsedMs = Date.now() - startedAt;
        const remainingSeconds = Math.max(1, Math.floor((timeoutMs - elapsedMs) / 1000));
        sendFrame({
          id: activePromptId,
          type: "prompt",
          message:
            stage === 1
              ? buildCheckpointTaskMessage(request)
              : buildContinuationTaskMessage(request, remainingSeconds),
        });
        if (stage === 1 && !checkpointDeadlineTriggered) {
          const checkpointDelayMs = Math.max(
            1,
            checkpointDeadlineMs - (Date.now() - startedAt),
          );
          checkpointDeadlineTimer = setTimeout(
            requestCheckpointFinish,
            checkpointDelayMs,
          );
        }
      };

      const requestCurrentStageText = () => {
        if (activeResultId || timedOut || activeStage === 0) {
          return;
        }
        activeResultId = `omp-read-result-${activeStage}`;
        sendFrame({ id: activeResultId, type: "get_last_assistant_text" });
      };

      /**
       * 限制范围定位阶段的最长耗时，优先取得首个可复用检查点。
       */
      const requestCheckpointFinish = () => {
        if (
          checkpointDeadlineTriggered ||
          timedOut ||
          activeResultId ||
          activeStage !== 1
        ) {
          return;
        }
        checkpointDeadlineTriggered = true;
        sendFrame({
          id: "omp-read-checkpoint-deadline",
          type: "abort_and_prompt",
          message:
            "范围定位阶段时间已到。立即停止新的工具调用，基于当前证据返回合法的累计 JSON 检查点；未完成内容写入 uncertainties，并将 completion 标记为 partial。",
        });
      };

      /**
       * 在硬超时前终止正在扩张的阶段，并要求基于当前证据返回累计报告。
       */
      const requestSoftFinish = () => {
        softDeadlineReached = true;
        if (
          softDeadlineTriggered ||
          timedOut ||
          activeResultId ||
          !promptSent ||
          activeStage === 0
        ) {
          return;
        }
        softDeadlineTriggered = true;
        sendFrame({
          id: "omp-read-soft-deadline",
          type: "abort_and_prompt",
          message:
            "本次调查已进入收尾阶段。立即停止新的 glob、grep 或 read 调用，只基于已经取得的证据输出完整的累计 JSON。未完成内容写入 uncertainties，并将 completion 标记为 partial。",
        });
      };

      // 在硬截止前主动触发收尾，避免模型用完全部时间后无法生成累计报告。
      softDeadlineTimer = setTimeout(requestSoftFinish, softDeadlineMs);

      const timeoutTimer = setTimeout(() => {
        // 最终报告已经到达时以报告为准，并终止仍未自行退出的 RPC 进程。
        if (pendingStatus) {
          beginProcessShutdown();
          finalizePendingResult(null, null);
          return;
        }
        timedOut = true;
        sendFrame({ id: "omp-read-abort", type: "abort" });
        beginProcessShutdown();

        // 即使外部进程忽略终止，也必须在有限宽限期后释放调用方。
        hardTimeoutFinalizeTimer = setTimeout(() => {
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          terminateProcessTree(child, windowsTaskkillCommand, (warning) =>
            protocolWarnings.push(warning),
          );
          child.unref();
          finalizeTimeoutResult(null, null);
        }, hardTimeoutGraceMs);
        hardTimeoutFinalizeTimer.unref();
      }, timeoutMs);

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr = appendBounded(stderr, chunk, 20000);
      });

      child.on("error", (error) => {
        const message = `OMP 进程错误：${error.message}`;
        if (finishWithLatestReport(message)) {
          return;
        }
        finalize("failed", null, null, { error: message });
      });

      child.on("exit", (exitCode, signal) => {
        if (timedOut) {
          finalizeTimeoutResult(exitCode, signal);
          return;
        }
        if (finalizePendingResult(exitCode, signal)) {
          return;
        }
        if (
          finishWithLatestReport(
            exitCode === 0
              ? "OMP 在后续阶段返回前结束，已保留最近一次有效检查点。"
              : `OMP 后续阶段异常退出，退出码：${exitCode ?? "未知"}。`,
          )
        ) {
          finalizePendingResult(exitCode, signal);
          return;
        }
        const error =
          exitCode === 0
            ? "OMP 在返回首个检查点前结束。"
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
          startStage(1);
          if (softDeadlineReached) {
            requestSoftFinish();
          }
          return;
        }

        if (
          frame.type === "response" &&
          frame.id === activePromptId &&
          frame.success === false
        ) {
          const message =
            typeof frame.error === "string" ? frame.error : "OMP 拒绝了阅读任务。";
          if (!finishWithLatestReport(`OMP 后续阶段被拒绝：${message}`)) {
            pendingStatus = "failed";
            pendingError = message;
            beginProcessShutdown();
          }
          return;
        }

        if (
          frame.type === "response" &&
          frame.id === "omp-read-checkpoint-deadline" &&
          frame.success === false
        ) {
          protocolWarnings.push(
            `OMP 拒绝检查点收尾指令：${typeof frame.error === "string" ? frame.error : "未知原因"}`,
          );
          sendFrame({
            id: "omp-read-checkpoint-deadline-fallback",
            type: "steer",
            message:
              "立即停止新的工具调用并返回合法的累计 JSON 检查点；未完成内容使用 partial。",
          });
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
              "立即停止新的工具调用，只基于已有证据输出完整的累计 JSON；未完成内容写入 uncertainties，并将 completion 标记为 partial。",
          });
          return;
        }

        if (
          frame.type === "response" &&
          (frame.id === "omp-read-soft-deadline-fallback" ||
            frame.id === "omp-read-checkpoint-deadline-fallback") &&
          frame.success === false
        ) {
          protocolWarnings.push(
            `OMP 拒绝备用收尾指令：${typeof frame.error === "string" ? frame.error : "未知原因"}`,
          );
          return;
        }

        if (frame.type === "agent_end" && frame.isTerminal !== false) {
          requestCurrentStageText();
          return;
        }

        if (frame.type === "response" && frame.id === activeResultId) {
          const completedStage = activeStage;
          activeResultId = undefined;
          activePromptId = undefined;
          if (frame.success === false) {
            const message =
              typeof frame.error === "string"
                ? frame.error
                : "无法取得 OMP 当前阶段输出。";
            if (!finishWithLatestReport(`无法取得后续阶段输出：${message}`)) {
              pendingStatus = "failed";
              pendingError = message;
              beginProcessShutdown();
            }
            return;
          }

          const rawOutput = extractAssistantText(frame.data);
          if (rawOutput === null) {
            if (!finishWithLatestReport("OMP 后续阶段输出格式无法识别。")) {
              pendingStatus = "invalid_output";
              pendingError = "OMP 返回的当前阶段文本格式无法识别。";
              beginProcessShutdown();
            }
            return;
          }

          let report: OmpReadReport;
          try {
            report = parseReport(rawOutput);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!finishWithLatestReport(`OMP 后续阶段输出无效：${message}`)) {
              pendingStatus = "invalid_output";
              pendingRawOutput = truncate(
                rawOutput,
                request.limits.maxOutputCharacters,
              );
              pendingError = message;
              beginProcessShutdown();
            }
            return;
          }

          const cumulative = preserveCumulativeCheckpoint(latestReport, report);
          report = cumulative.report;
          if (cumulative.warning) {
            protocolWarnings.push(cumulative.warning);
          }
          checkpointCount += 1;
          checkpointDurationsMs.push(Date.now() - currentStageStartedAt);
          latestReport = report;
          if (checkpointCount === 1) {
            if (checkpointDeadlineTimer) {
              clearTimeout(checkpointDeadlineTimer);
              checkpointDeadlineTimer = undefined;
            }
          }
          if (checkpointCount === 1 && report.completion === "partial") {
            revisedEstimate = reviseOmpReadTimeEstimate(
              activePreflightEstimate,
              Date.now() - startedAt,
              Math.max(1, Math.ceil(timeoutMs / 1000)),
              report.filesRead.length,
              report.findings.length,
            );
          }

          const elapsedMs = Date.now() - startedAt;
          const remainingMs = timeoutMs - elapsedMs;
          const minimumContinuationMs = Math.min(
            30_000,
            Math.max(50, Math.floor(timeoutMs * 0.1)),
          );
          if (
            report.completion === "complete" ||
            completedStage >= 2 ||
            softDeadlineReached ||
            remainingMs <= minimumContinuationMs
          ) {
            finishWithReport(report);
            return;
          }

          startStage(2);
        }
      });
    });
  } catch (error) {
    return {
      schemaVersion: 1,
      runId,
      status: "failed",
      objective: request.objective,
      error: error instanceof Error ? error.message : String(error),
      diagnostics: {
        durationMs: Date.now() - startedAt,
        exitCode: null,
        signal: null,
        softDeadlineMs: 0,
        softDeadlineTriggered: false,
        callerId: request.callerId,
        callerSlot: capacityLease?.callerSlot ?? null,
        globalSlot: capacityLease?.globalSlot ?? null,
        effectiveProfile,
        preflightEstimate,
        checkpointCount: 0,
        checkpointDurationsMs: [],
      },
    };
  } finally {
    await capacityLease?.release();
  }
}

function printUsage(): void {
  process.stdout.write(`用法：
  bun run omp:read -- --request <请求文件.json>
  bun run omp:read -- --objective "<调查目标>" [--root <目录>] [--profile auto|quick|standard|deep]
  bun run omp:read -- --objective "<调查目标>" --estimate-only

最小调用示例：
  bun run omp:read -- --objective "梳理登录鉴权调用链"

高级 JSON 请求示例：
  {
    "callerId": "codex:stable-task-id",
    "objective": "梳理登录鉴权调用链",
    "profile": "auto",
    "searchRoots": ["projects/example/src"],
    "materialTypes": ["code", "markdown", "log"],
    "questions": ["入口在哪里？", "Token 在哪里生成和验证？"]
  }
`);
}

export interface OmpReadCliArguments {
  requestPath?: string;
  inlineRequest?: OmpReadRequest;
  estimateOnly: boolean;
}

/**
 * 解析低编排成本 CLI 参数，同时保留高级 JSON 请求模式。
 *
 * @param args 传给委派器的命令行参数。
 * @param fallbackCallerId 当前 AI 任务通过环境变量提供的稳定调用者标识。
 * @return 请求来源以及是否只执行本地用时预估。
 */
export function parseCliArguments(
  args: string[],
  fallbackCallerId = process.env.PPM_AI_CALLER_ID,
): OmpReadCliArguments {
  let requestPath: string | undefined;
  let objective: string | undefined;
  let callerId: string | undefined;
  let profile: string | undefined;
  const searchRoots: string[] = [];
  let estimateOnly = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--estimate-only") {
      estimateOnly = true;
      continue;
    }
    if (
      argument === "--request" ||
      argument === "--objective" ||
      argument === "--caller-id" ||
      argument === "--profile" ||
      argument === "--root"
    ) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new RequestValidationError(`${argument} 缺少参数值。`);
      }
      index += 1;
      if (argument === "--request") {
        requestPath = value;
      } else if (argument === "--objective") {
        objective = value;
      } else if (argument === "--caller-id") {
        callerId = value;
      } else if (argument === "--profile") {
        profile = value;
      } else {
        searchRoots.push(value);
      }
      continue;
    }
    throw new RequestValidationError(`无法识别的参数：${argument}`);
  }

  if (requestPath && (objective || callerId || profile || searchRoots.length > 0)) {
    throw new RequestValidationError(
      "--request 不能与 --objective、--caller-id、--profile 或 --root 混用。",
    );
  }
  if (requestPath) {
    return { requestPath, estimateOnly };
  }
  if (!objective) {
    throw new RequestValidationError("必须提供 --request 或 --objective。");
  }
  return {
    inlineRequest: {
      callerId: callerId ?? fallbackCallerId,
      objective,
      profile: profile as OmpReadRequestedProfile | undefined,
      searchRoots: searchRoots.length ? searchRoots : undefined,
    },
    estimateOnly,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  let normalizedRequest: NormalizedOmpReadRequest | undefined;
  try {
    const cli = parseCliArguments(args);
    const rawRequest = cli.requestPath
      ? JSON.parse(await readFile(path.resolve(cli.requestPath), "utf8"))
      : cli.inlineRequest;
    const request = await normalizeRequest(
      rawRequest,
      process.cwd(),
      process.env.PPM_AI_CALLER_ID ?? (cli.estimateOnly ? "estimate-only" : undefined),
    );
    normalizedRequest = request;
    const preflightEstimate = await estimateOmpReadTime({
      projectRoot: process.cwd(),
      searchRoots: request.searchRoots,
      extensions: resolveExtensions(request),
      excludeHints: request.excludeHints,
      objective: request.objective,
      questions: request.questions,
    });
    const prepared = resolveEffectiveRequest(request, preflightEstimate);
    if (cli.estimateOnly) {
      process.stdout.write(
        `${JSON.stringify(
          {
            schemaVersion: 1,
            status: "estimated",
            objective: request.objective,
            effectiveProfile: prepared.effectiveProfile,
            estimate: preflightEstimate,
          },
          null,
          2,
        )}\n`,
      );
      return;
    }
    console.error(
      `OMP 预估：推荐 ${preflightEstimate.recommendedProfile}，首次检查点约 ${preflightEstimate.firstCheckpointSeconds.min}～${preflightEstimate.firstCheckpointSeconds.max} 秒，总计约 ${preflightEstimate.totalSeconds.min}～${preflightEstimate.totalSeconds.max} 秒。`,
    );
    console.error("正在申请 OMP 阅读容量并准备只读文本调查……");
    const result = await runOmpRead(request, {
      projectRoot: process.cwd(),
      preflightEstimate,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status !== "completed" && result.status !== "partial") {
      process.exitCode = 1;
    }
  } catch (error) {
    const result: OmpReadResult = {
      schemaVersion: 1,
      runId: randomUUID(),
      status: "failed",
      objective: normalizedRequest?.objective ?? "",
      error: error instanceof Error ? error.message : String(error),
      diagnostics: {
        durationMs: 0,
        exitCode: null,
        signal: null,
        softDeadlineMs: 0,
        softDeadlineTriggered: false,
        callerId: normalizedRequest?.callerId ?? "",
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
