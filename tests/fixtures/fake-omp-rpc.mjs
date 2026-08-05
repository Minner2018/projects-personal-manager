import readline from "node:readline";

const mode = process.env.FAKE_OMP_MODE ?? "success";
const lines = readline.createInterface({ input: process.stdin });

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
    if (mode !== "hang") {
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
      invalid: "这不是 JSON",
    };
    write({
      id: frame.id,
      type: "response",
      command: "get_last_assistant_text",
      success: true,
      data: { text: reports[mode] ?? reports.success },
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
    if (mode === "soft-deadline") {
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
