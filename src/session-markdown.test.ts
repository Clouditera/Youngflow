import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { exportSessionMarkdown, renderSessionMarkdown } from "./session-markdown.js";

function jsonl(events: Record<string, any>[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

describe("session markdown", () => {
  it("renders session header and normal message text", () => {
    const md = renderSessionMarkdown(jsonl([
      { type: "session", version: 3, id: "s-1", timestamp: "2026-06-05T12:00:00Z", cwd: "/repo" },
      { type: "model_change", provider: "zai", modelId: "glm-5.1" },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "Please analyze this." }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Analysis complete." }] } },
    ]), { stageId: "scan/SCAN-001" });

    expect(md).toContain("# Session: scan/SCAN-001");
    expect(md).toContain("- Session ID: s-1");
    expect(md).toContain("- Model: zai/glm-5.1");
    expect(md).toContain("## Turn 1 · User");
    expect(md).toContain("Please analyze this.");
    expect(md).toContain("## Turn 2 · Assistant");
    expect(md).toContain("Analysis complete.");
  });

  it("renders thinking and tool calls without truncation", () => {
    const md = renderSessionMarkdown(jsonl([
      { type: "session", version: 3, id: "s-2" },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "I should inspect the source before answering." },
            { type: "toolCall", name: "read", arguments: { path: "src/app.ts", offset: 1 } },
            { type: "text", text: "I found the issue." },
          ],
        },
      },
    ]));

    expect(md).toContain("### 🤔 Thinking");
    expect(md).toContain("I should inspect the source before answering.");
    expect(md).toContain("### 🔧 Tool Call: read");
    expect(md).toContain('"path": "src/app.ts"');
    expect(md).toContain("I found the issue.");
  });

  it("truncates tool results by first reached char or line limit", () => {
    const longResult = Array.from({ length: 40 }, (_, i) => `line-${i + 1} ${"x".repeat(20)}`).join("\n");
    const md = renderSessionMarkdown(jsonl([
      { type: "session", version: 3, id: "s-3" },
      {
        type: "message",
        message: {
          role: "toolResult",
          content: [
            { type: "toolResult", content: [{ text: longResult }] },
          ],
        },
      },
    ]), { toolResultMaxChars: 1200, toolResultMaxLines: 30 });

    expect(md).toContain("### 📎 Tool Result (truncated)");
    expect(md).toContain("line-30");
    expect(md).not.toContain("line-31");
    expect(md).toMatch(/\.\.\. \[truncated \d+ more chars\]/);
  });

  it("skips malformed lines and unsupported versions without crashing", () => {
    const md = renderSessionMarkdown([
      "not-json",
      JSON.stringify({ type: "session", version: 99, id: "future" }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "hidden" }] } }),
    ].join("\n"));

    expect(md).toContain("## Warnings");
    expect(md).toContain("invalid JSON skipped");
    expect(md).toContain("Unsupported session JSONL version 99");
    expect(md).toContain("_No supported session messages found._");
    expect(md).not.toContain("hidden");
  });

  it("exports .md next to .jsonl and handles empty files", () => {
    const dir = path.join(os.tmpdir(), `youngflow-session-md-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    try {
      const sessionPath = path.join(dir, "session.jsonl");
      writeFileSync(sessionPath, "");
      const mdPath = exportSessionMarkdown(sessionPath, { stageId: "empty" });
      expect(mdPath).toBe(path.join(dir, "session.md"));
      const md = readFileSync(mdPath!, "utf-8");
      expect(md).toContain("# Session: empty");
      expect(md).toContain("_No supported session messages found._");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
