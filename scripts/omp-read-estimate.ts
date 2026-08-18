import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

export type OmpReadProfile = "quick" | "standard" | "deep";
export type OmpReadRequestedProfile = OmpReadProfile | "auto";

export interface OmpReadProfileLimits {
  maxTimeSeconds: number;
  maxFindings: number;
  maxOutputCharacters: number;
}

export interface OmpReadEstimateInput {
  projectRoot: string;
  searchRoots: string[];
  extensions: string[];
  excludeHints: string[];
  objective: string;
  questions: string[];
}

export interface OmpReadPreflightEstimate {
  stage: "preflight";
  recommendedProfile: OmpReadProfile;
  firstCheckpointSeconds: OmpTimeRange;
  totalSeconds: OmpTimeRange;
  confidence: "low" | "medium";
  basis: {
    candidateFiles: number;
    candidateTextBytes: number;
    searchRoots: number;
    questions: number;
    relationshipSignals: string[];
    scanDurationMs: number;
    scanTruncated: boolean;
    historicalSamples: 0;
  };
}

export interface OmpReadCheckpointEstimate {
  stage: "checkpoint";
  remainingSeconds: OmpTimeRange;
  estimatedTotalSeconds: OmpTimeRange;
  confidence: "low" | "medium";
  reason: string;
}

export interface OmpTimeRange {
  min: number;
  max: number;
}

export const OMP_READ_PROFILE_LIMITS: Record<
  OmpReadProfile,
  OmpReadProfileLimits
> = {
  quick: {
    maxTimeSeconds: 360,
    maxFindings: 12,
    maxOutputCharacters: 12000,
  },
  standard: {
    maxTimeSeconds: 600,
    maxFindings: 30,
    maxOutputCharacters: 30000,
  },
  deep: {
    maxTimeSeconds: 1200,
    maxFindings: 50,
    maxOutputCharacters: 50000,
  },
};

export const OMP_READ_PROFILE_TIME_RANGES: Record<
  OmpReadProfile,
  { firstCheckpointSeconds: OmpTimeRange; totalSeconds: OmpTimeRange }
> = {
  quick: {
    firstCheckpointSeconds: { min: 90, max: 180 },
    totalSeconds: { min: 180, max: 360 },
  },
  standard: {
    firstCheckpointSeconds: { min: 150, max: 300 },
    totalSeconds: { min: 180, max: 600 },
  },
  deep: {
    firstCheckpointSeconds: { min: 240, max: 480 },
    totalSeconds: { min: 360, max: 1200 },
  },
};

const RELATIONSHIP_PATTERNS: Array<[string, RegExp]> = [
  ["调用链", /调用链|call chain/i],
  ["跨模块", /跨(?:模块|项目|服务|仓库)|cross[- ]?(?:module|project|service)/i],
  ["差异", /差异|对比|diff|compare/i],
  ["流程", /流程|链路|端到端|workflow|end[- ]to[- ]end/i],
  ["根因", /根因|原因|影响范围|root cause|impact/i],
  ["架构", /架构|依赖关系|architecture|dependency graph/i],
];

const DEFAULT_EXCLUDED_DIRECTORY_NAMES = new Set([
  ".git",
  ".svn",
  ".codex",
  "node_modules",
  "target",
  "dist",
  "build",
  "reading-resources",
]);

const DEFAULT_EXCLUDED_PATHS = [".omp/runtime"];
const MAX_SCAN_ENTRIES = 20_000;
const MAX_SCAN_DURATION_MS = 2_000;

function toPortablePath(value: string): string {
  return value.split(path.sep).join("/");
}

function isExplicitlyIncluded(root: string, excludedPath: string): boolean {
  return root === excludedPath || root.startsWith(`${excludedPath}/`);
}

function collectRelationshipSignals(objective: string): string[] {
  return RELATIONSHIP_PATTERNS.filter(([, pattern]) => pattern.test(objective)).map(
    ([name]) => name,
  );
}

function selectProfile(
  candidateFiles: number,
  candidateTextBytes: number,
  rootCount: number,
  questionCount: number,
  relationshipSignalCount: number,
  scanTruncated: boolean,
): OmpReadProfile {
  const textMiB = candidateTextBytes / 1024 / 1024;
  if (
    !scanTruncated &&
    candidateFiles <= 80 &&
    textMiB <= 2 &&
    rootCount <= 1 &&
    questionCount <= 1 &&
    relationshipSignalCount === 0
  ) {
    return "quick";
  }
  const stronglyRelational =
    relationshipSignalCount >= 2 || rootCount >= 2 || questionCount >= 3;
  if (
    !stronglyRelational ||
    (!scanTruncated && candidateFiles <= 600 && textMiB <= 30)
  ) {
    return "standard";
  }
  return "deep";
}

function shouldExcludeDirectory(
  projectRoot: string,
  directoryPath: string,
  searchRoot: string,
  excludedDirectoryNames: Set<string>,
): boolean {
  const relative = toPortablePath(path.relative(projectRoot, directoryPath));
  const name = path.basename(directoryPath).toLowerCase();
  if (excludedDirectoryNames.has(name)) {
    const searchRootName = path.basename(searchRoot).toLowerCase();
    if (name !== searchRootName) {
      return true;
    }
  }
  return DEFAULT_EXCLUDED_PATHS.some(
    (excludedPath) =>
      !isExplicitlyIncluded(searchRoot, excludedPath) &&
      (relative === excludedPath || relative.startsWith(`${excludedPath}/`)),
  );
}

/**
 * 仅扫描候选文件元数据，估算调查规模，不读取文件正文。
 *
 * @param input 已规范化的搜索范围、扩展名和调查目标。
 * @return 调用前的时间区间、推荐档位和可解释判断依据。
 */
export async function estimateOmpReadTime(
  input: OmpReadEstimateInput,
): Promise<OmpReadPreflightEstimate> {
  const startedAt = Date.now();
  const deadline = startedAt + MAX_SCAN_DURATION_MS;
  const extensionSet = new Set(input.extensions.map((extension) => extension.toLowerCase()));
  const excludedDirectoryNames = new Set(DEFAULT_EXCLUDED_DIRECTORY_NAMES);
  for (const hint of input.excludeHints) {
    if (/^[A-Za-z0-9._-]+$/.test(hint)) {
      excludedDirectoryNames.add(hint.toLowerCase());
    }
  }

  let candidateFiles = 0;
  let candidateTextBytes = 0;
  let scannedEntries = 0;
  let scanTruncated = false;

  for (const searchRoot of input.searchRoots) {
    const absoluteRoot = path.resolve(input.projectRoot, searchRoot);
    const pending = [absoluteRoot];
    while (pending.length > 0) {
      if (Date.now() >= deadline || scannedEntries >= MAX_SCAN_ENTRIES) {
        scanTruncated = true;
        break;
      }

      const current = pending.pop()!;
      let currentStat;
      try {
        currentStat = await lstat(current);
      } catch {
        continue;
      }
      scannedEntries += 1;

      if (currentStat.isFile()) {
        if (extensionSet.has(path.extname(current).toLowerCase())) {
          candidateFiles += 1;
          candidateTextBytes += currentStat.size;
        }
        continue;
      }
      if (!currentStat.isDirectory()) {
        continue;
      }

      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) {
          continue;
        }
        const childPath = path.join(current, entry.name);
        if (
          entry.isDirectory() &&
          shouldExcludeDirectory(
            input.projectRoot,
            childPath,
            toPortablePath(searchRoot),
            excludedDirectoryNames,
          )
        ) {
          continue;
        }
        pending.push(childPath);
      }
    }
    if (scanTruncated) {
      break;
    }
  }

  const relationshipSignals = collectRelationshipSignals(input.objective);
  const recommendedProfile = selectProfile(
    candidateFiles,
    candidateTextBytes,
    input.searchRoots.length,
    input.questions.length,
    relationshipSignals.length,
    scanTruncated,
  );
  const ranges = OMP_READ_PROFILE_TIME_RANGES[recommendedProfile];
  return {
    stage: "preflight",
    recommendedProfile,
    firstCheckpointSeconds: { ...ranges.firstCheckpointSeconds },
    totalSeconds: { ...ranges.totalSeconds },
    confidence: scanTruncated ? "low" : "medium",
    basis: {
      candidateFiles,
      candidateTextBytes,
      searchRoots: input.searchRoots.length,
      questions: input.questions.length,
      relationshipSignals,
      scanDurationMs: Date.now() - startedAt,
      scanTruncated,
      historicalSamples: 0,
    },
  };
}

/**
 * 根据首个有效检查点的实际耗时和产出，修正剩余调查时间。
 *
 * @param preflight 调用前的静态时间预估。
 * @param elapsedMs 从 OMP 启动到检查点返回的实际耗时。
 * @param hardLimitSeconds 当前档位允许的硬时间上限。
 * @param filesRead 检查点已确认读取的文件数量。
 * @param findings 检查点已形成的可靠结论数量。
 * @return 检查点后的剩余时间与总时间区间。
 */
export function reviseOmpReadTimeEstimate(
  preflight: OmpReadPreflightEstimate,
  elapsedMs: number,
  hardLimitSeconds: number,
  filesRead: number,
  findings: number,
): OmpReadCheckpointEstimate {
  const elapsedSeconds = Math.max(1, Math.ceil(elapsedMs / 1000));
  const observedProgress = filesRead > 0 || findings > 0;
  const lowerRemaining = Math.max(
    20,
    preflight.totalSeconds.min - elapsedSeconds,
    Math.ceil(elapsedSeconds * (observedProgress ? 0.5 : 1)),
  );
  const upperRemaining = Math.max(
    lowerRemaining,
    preflight.totalSeconds.max - elapsedSeconds,
    Math.ceil(elapsedSeconds * (observedProgress ? 2 : 3)),
  );
  const exceedsBudget = elapsedSeconds + upperRemaining > hardLimitSeconds;
  return {
    stage: "checkpoint",
    remainingSeconds: { min: lowerRemaining, max: upperRemaining },
    estimatedTotalSeconds: {
      min: elapsedSeconds + lowerRemaining,
      max: elapsedSeconds + upperRemaining,
    },
    confidence: observedProgress ? "medium" : "low",
    reason: exceedsBudget
      ? "按首个检查点速度推算，完整调查可能超过当前硬时间上限，应优先收敛关键问题。"
      : "已根据首个检查点的实际耗时、已读文件和结论数量修正。",
  };
}
