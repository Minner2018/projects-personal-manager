import readline from "node:readline";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const mode = process.env.FAKE_OMP_MODE ?? "success";
const lines = readline.createInterface({ input: process.stdin });
let promptCount = 0;

if (mode === "spawn-child-success") {
  const pidPath = process.env.FAKE_OMP_CHILD_PID_PATH;
  if (!pidPath) {
    throw new Error("FAKE_OMP_CHILD_PID_PATH 未设置");
  }
  const helper = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { stdio: "ignore", windowsHide: true },
  );
  if (!helper.pid) {
    throw new Error("无法启动模拟 MCP 子进程");
  }
  writeFileSync(pidPath, String(helper.pid), "utf8");
}

process.stdout.write(
  `${JSON.stringify({
    type: "ready",
    protocolVersion: 1,
    supportedProtocolVersions: [1],
    maxFrameBytes: 1048576,
  })}\n`,
);

function write(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

lines.on("line", (line) => {
  const frame = JSON.parse(line);

  if (frame.type === "prompt") {
    promptCount += 1;
    if (mode === "prompt-error") {
      write({
        id: frame.id,
        type: "response",
        command: "prompt",
        success: false,
        error: "模拟的提示失败",
      });
      return;
    }

    write({
      id: frame.id,
      type: "response",
      command: "prompt",
      success: true,
      data: { agentInvoked: true },
    });
    const waitsForDeadline =
      mode === "hang" ||
      mode === "ignore-abort" ||
      mode === "soft-deadline" ||
      mode === "soft-deadline-rejected" ||
      mode === "checkpoint-deadline" ||
      (mode === "checkpoint-then-hang" && promptCount >= 2);
    if (!waitsForDeadline) {
      write({ type: "agent_end", isTerminal: true });
    }
    return;
  }

  if (frame.type === "get_last_assistant_text") {
    const reports = {
      success: JSON.stringify({
        completion: "complete",
        summary: "模拟调查完成。",
        findings: [
          {
            claim: "已找到入口。",
            confidence: "high",
            evidence: [{ path: "README.md", lineStart: 1, lineEnd: 5 }],
          },
        ],
        uncertainties: [],
        filesRead: ["README.md"],
      }),
      partial: JSON.stringify({
        completion: "partial",
        summary: "模拟调查部分完成。",
        findings: [],
        uncertainties: ["时间不足"],
        filesRead: [],
      }),
      "soft-deadline": JSON.stringify({
        completion: "partial",
        summary: "收到收尾指令后返回已有结果。",
        findings: [],
        uncertainties: ["软截止前未完成全部调查"],
        filesRead: [],
      }),
      "soft-deadline-rejected": JSON.stringify({
        completion: "partial",
        summary: "备用收尾指令返回已有结果。",
        findings: [],
        uncertainties: ["主收尾指令被拒绝"],
        filesRead: [],
      }),
      checkpoint: JSON.stringify({
        completion: "partial",
        summary: "已完成范围定位检查点。",
        findings: [
          {
            claim: "已定位一个候选入口。",
            confidence: "medium",
            evidence: [{ path: "README.md", lineStart: 1, lineEnd: 5 }],
          },
        ],
        uncertainties: ["尚未验证完整调用链"],
        filesRead: ["README.md"],
      }),
      verified: JSON.stringify({
        completion: "complete",
        summary: "已基于检查点完成深入验证。",
        findings: [
          {
            claim: "已找到并验证入口。",
            confidence: "high",
            evidence: [{ path: "README.md", lineStart: 1, lineEnd: 5 }],
          },
        ],
        uncertainties: [],
        filesRead: ["README.md"],
      }),
      regression: JSON.stringify({
        completion: "partial",
        summary: "后续阶段返回了更少的信息。",
        findings: [],
        uncertainties: ["后续阶段发生信息退化"],
        filesRead: [],
      }),
      "complete-regression": JSON.stringify({
        completion: "complete",
        summary: "后续阶段错误地遗漏了检查点材料。",
        findings: [],
        uncertainties: [],
        filesRead: [],
      }),
      invalid: "这不是 JSON",
    };
    let report = reports[mode] ?? reports.success;
    if (mode === "checkpoint-then-complete") {
      report = promptCount <= 1 ? reports.checkpoint : reports.verified;
    } else if (mode === "checkpoint-then-hang") {
      report = reports.checkpoint;
    } else if (mode === "checkpoint-then-regression") {
      report = promptCount <= 1 ? reports.checkpoint : reports.regression;
    } else if (mode === "checkpoint-then-complete-regression") {
      report = promptCount <= 1 ? reports.checkpoint : reports["complete-regression"];
    } else if (mode === "checkpoint-deadline") {
      report = reports.checkpoint;
    }
    write({
      id: frame.id,
      type: "response",
      command: "get_last_assistant_text",
      success: true,
      data: { text: report },
    });
    if (mode === "slow-exit") {
      setTimeout(() => process.exit(0), 1000);
    }
    return;
  }

  if (frame.type === "abort_and_prompt") {
    if (mode === "soft-deadline-rejected") {
      write({
        id: frame.id,
        type: "response",
        command: "abort_and_prompt",
        success: false,
        error: "模拟的不支持命令",
      });
      return;
    }
    write({
      id: frame.id,
      type: "response",
      command: "abort_and_prompt",
      success: true,
    });
    if (mode === "soft-deadline" || mode === "checkpoint-deadline") {
      write({ type: "agent_end", isTerminal: false });
      write({ type: "agent_end", isTerminal: true });
    }
    return;
  }

  if (frame.type === "steer") {
    write({
      id: frame.id,
      type: "response",
      command: "steer",
      success: true,
    });
    if (mode === "soft-deadline-rejected") {
      write({ type: "agent_end", isTerminal: true });
    }
    return;
  }

  if (frame.type === "abort") {
    if (mode !== "ignore-abort") {
      lines.close();
    }
  }
});
