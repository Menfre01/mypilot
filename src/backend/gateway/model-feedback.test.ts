import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeTranscriptLine } from "./ws-test-helpers.js";
import { extractModelFeedback } from "./model-feedback.js";

describe("extractModelFeedback", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  async function setup() {
    tempDir = mkdtempSync(join(tmpdir(), "mypilot-test-"));
  }

  async function writeTranscript(
    lines: string[],
  ): Promise<string> {
    await setup();
    const path = join(tempDir, "transcript.jsonl");
    writeFileSync(path, lines.join(""), "utf-8");
    return path;
  }

  it("extracts model, text, thinking for matching tool_use_id", async () => {
    const toolUseId = "call_abc123";
    const lines = [
      makeTranscriptLine({
        type: "assistant",
        message: {
          model: "claude-opus-4-7",
          usage: { input_tokens: 1000, output_tokens: 200 },
          content: [
            { type: "thinking", thinking: "I should read the file first" },
            {
              type: "text",
              text: "Let me check the configuration file.",
            },
            {
              type: "tool_use",
              id: toolUseId,
              name: "Read",
              input: { file_path: "/tmp/config.json" },
            },
          ],
        },
      }),
      makeTranscriptLine({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUseId,
              content: '{"port": 8080, "host": "localhost"}',
              isError: false,
            },
          ],
        },
      }),
    ];

    const path = await writeTranscript(lines);
    const result = await extractModelFeedback(path, toolUseId);

    expect(result).not.toBeNull();
    expect(result!.model).toBe("claude-opus-4-7");
    expect(result!.text).toBe("Let me check the configuration file.");
    expect(result!.thinking).toBe("I should read the file first");
    expect(result!.tool_result).toBe('{"port": 8080, "host": "localhost"}');
  });

  it("extracts usage fields correctly", async () => {
    const toolUseId = "call_def456";
    const lines = [
      makeTranscriptLine({
        type: "assistant",
        message: {
          model: "deepseek-v4-pro",
          usage: {
            input_tokens: 5000,
            output_tokens: 300,
            cache_read_input_tokens: 2560,
            cache_creation_input_tokens: 0,
          },
          content: [
            { type: "tool_use", id: toolUseId, name: "Bash", input: {} },
          ],
        },
      }),
    ];

    const path = await writeTranscript(lines);
    const result = await extractModelFeedback(path, toolUseId);

    expect(result).not.toBeNull();
    expect(result!.usage.input_tokens).toBe(5000);
    expect(result!.usage.output_tokens).toBe(300);
    expect(result!.usage.cache_read_input_tokens).toBe(2560);
  });

  it("matches latest tool_use when no toolUseId given", async () => {
    const lines = [
      makeTranscriptLine({
        type: "assistant",
        message: {
          model: "old-model",
          usage: {},
          content: [
            { type: "tool_use", id: "old_call", name: "Read", input: {} },
          ],
        },
      }),
      makeTranscriptLine({
        type: "assistant",
        message: {
          model: "latest-model",
          usage: {},
          content: [
            { type: "tool_use", id: "latest_call", name: "Bash", input: {} },
          ],
        },
      }),
    ];

    const path = await writeTranscript(lines);
    const result = await extractModelFeedback(path);

    expect(result).not.toBeNull();
    expect(result!.model).toBe("latest-model");
  });

  it("returns null for empty file", async () => {
    await setup();
    const path = join(tempDir, "empty.jsonl");
    writeFileSync(path, "", "utf-8");

    const result = await extractModelFeedback(path);
    expect(result).toBeNull();
  });

  it("returns null when no assistant entry exists", async () => {
    const lines = [
      makeTranscriptLine({
        type: "attachment",
        attachment: { hookEvent: "SessionStart" },
      }),
    ];

    const path = await writeTranscript(lines);
    const result = await extractModelFeedback(path);
    expect(result).toBeNull();
  });

  it("returns null for non-existent file", async () => {
    await setup();
    const result = await extractModelFeedback(
      join(tempDir, "does-not-exist.jsonl"),
    );
    expect(result).toBeNull();
  });

  it("truncates thinking to 300 chars", async () => {
    const longThinking = "A".repeat(500);
    const lines = [
      makeTranscriptLine({
        type: "assistant",
        message: {
          model: "test-model",
          usage: {},
          content: [
            { type: "thinking", thinking: longThinking },
            { type: "tool_use", id: "call_1", name: "Read", input: {} },
          ],
        },
      }),
    ];

    const path = await writeTranscript(lines);
    const result = await extractModelFeedback(path, "call_1");

    expect(result).not.toBeNull();
    expect(result!.thinking!.length).toBeLessThanOrEqual(300);
    expect(result!.thinking!.length).toBeGreaterThan(0);
  });

  it("truncates text to 500 chars", async () => {
    const longText = "B".repeat(600);
    const lines = [
      makeTranscriptLine({
        type: "assistant",
        message: {
          model: "test-model",
          usage: {},
          content: [
            { type: "text", text: longText },
            { type: "tool_use", id: "call_2", name: "Bash", input: {} },
          ],
        },
      }),
    ];

    const path = await writeTranscript(lines);
    const result = await extractModelFeedback(path, "call_2");

    expect(result).not.toBeNull();
    expect(result!.text!.length).toBeLessThanOrEqual(500);
    expect(result!.text!.length).toBeGreaterThan(0);
  });

  it("truncates tool_result to 1000 chars", async () => {
    const longResult = "C".repeat(1500);
    const toolUseId = "call_3";
    const lines = [
      makeTranscriptLine({
        type: "assistant",
        message: {
          model: "test-model",
          usage: {},
          content: [
            { type: "tool_use", id: toolUseId, name: "Bash", input: {} },
          ],
        },
      }),
      makeTranscriptLine({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUseId,
              content: longResult,
              isError: false,
            },
          ],
        },
      }),
    ];

    const path = await writeTranscript(lines);
    const result = await extractModelFeedback(path, toolUseId);

    expect(result).not.toBeNull();
    expect(result!.tool_result!.length).toBeLessThanOrEqual(1000);
    expect(result!.tool_result!.length).toBeGreaterThan(0);
  });

  it("thinking is undefined when absent", async () => {
    const lines = [
      makeTranscriptLine({
        type: "assistant",
        message: {
          model: "test-model",
          usage: {},
          content: [
            { type: "text", text: "No thinking here" },
            { type: "tool_use", id: "call_4", name: "WebSearch", input: {} },
          ],
        },
      }),
    ];

    const path = await writeTranscript(lines);
    const result = await extractModelFeedback(path, "call_4");

    expect(result).not.toBeNull();
    expect(result!.thinking).toBeUndefined();
  });

  it("text is undefined when absent", async () => {
    const lines = [
      makeTranscriptLine({
        type: "assistant",
        message: {
          model: "test-model",
          usage: {},
          content: [
            {
              type: "thinking",
              thinking: "Pure thinking, no text output",
            },
            { type: "tool_use", id: "call_5", name: "Bash", input: {} },
          ],
        },
      }),
    ];

    const path = await writeTranscript(lines);
    const result = await extractModelFeedback(path, "call_5");

    expect(result).not.toBeNull();
    expect(result!.text).toBeUndefined();
  });

  it("tool_result is undefined for events without toolUseId", async () => {
    const lines = [
      makeTranscriptLine({
        type: "assistant",
        message: {
          model: "test-model",
          usage: {},
          content: [
            { type: "text", text: "Summary" },
            { type: "tool_use", id: "call_6", name: "Bash", input: {} },
          ],
        },
      }),
    ];

    const path = await writeTranscript(lines);
    // No toolUseId passed — should still find the assistant but no tool_result
    const result = await extractModelFeedback(path);

    expect(result).not.toBeNull();
    expect(result!.tool_result).toBeUndefined();
  });

  it("skips malformed JSON lines gracefully", async () => {
    const lines = [
      "not valid json\n",
      makeTranscriptLine({
        type: "assistant",
        message: {
          model: "robust-model",
          usage: {},
          content: [
            { type: "tool_use", id: "call_7", name: "Read", input: {} },
          ],
        },
      }),
    ];

    const path = await writeTranscript(lines);
    const result = await extractModelFeedback(path, "call_7");

    expect(result).not.toBeNull();
    expect(result!.model).toBe("robust-model");
  });

  it("reads from a large file by tailing", async () => {
    // Create 100+ lines of noise before the target
    const noise: string[] = [];
    for (let i = 0; i < 100; i++) {
      noise.push(
        makeTranscriptLine({
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: `old_${i}`, content: `result ${i}` }] },
        }),
      );
    }
    const toolUseId = "target_call";
    noise.push(
      makeTranscriptLine({
        type: "assistant",
        message: {
          model: "target-model",
          usage: { input_tokens: 100, output_tokens: 10 },
          content: [
            { type: "text", text: "Found it!" },
            { type: "tool_use", id: toolUseId, name: "Bash", input: {} },
          ],
        },
      }),
      makeTranscriptLine({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUseId,
              content: "final result",
              isError: false,
            },
          ],
        },
      }),
    );

    const path = await writeTranscript(noise);
    const result = await extractModelFeedback(path, toolUseId);

    expect(result).not.toBeNull();
    expect(result!.model).toBe("target-model");
    expect(result!.text).toBe("Found it!");
    expect(result!.tool_result).toBe("final result");
  });

  it("extracts tool_result from array-format content blocks", async () => {
    const toolUseId = "call_arr";
    const lines = [
      makeTranscriptLine({
        type: "assistant",
        message: {
          model: "test-model",
          usage: {},
          content: [
            { type: "tool_use", id: toolUseId, name: "Bash", input: {} },
          ],
        },
      }),
      makeTranscriptLine({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUseId,
              content: [
                { type: "text", text: "line 1" },
                { type: "text", text: "line 2" },
              ],
              isError: false,
            },
          ],
        },
      }),
    ];

    const path = await writeTranscript(lines);
    const result = await extractModelFeedback(path, toolUseId);

    expect(result).not.toBeNull();
    expect(result!.tool_result).toBe("line 1\nline 2");
  });

  it("matches last assistant entry without tool_use when no toolUseId given", async () => {
    const lines = [
      makeTranscriptLine({
        type: "assistant",
        message: {
          model: "claude-sonnet-4-6",
          usage: { input_tokens: 100, output_tokens: 50 },
          content: [
            { type: "text", text: "Task completed successfully." },
          ],
        },
      }),
    ];

    const path = await writeTranscript(lines);
    const result = await extractModelFeedback(path);

    expect(result).not.toBeNull();
    expect(result!.model).toBe("claude-sonnet-4-6");
    expect(result!.text).toBe("Task completed successfully.");
    expect(result!.thinking).toBeUndefined();
  });

  it("returns undefined tool_result for array content that is all non-text blocks", async () => {
    const toolUseId = "call_notext";
    const lines = [
      makeTranscriptLine({
        type: "assistant",
        message: {
          model: "test-model",
          usage: {},
          content: [
            { type: "tool_use", id: toolUseId, name: "Bash", input: {} },
          ],
        },
      }),
      makeTranscriptLine({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUseId,
              content: [{ type: "image", source: {} }],
              isError: false,
            },
          ],
        },
      }),
    ];

    const path = await writeTranscript(lines);
    const result = await extractModelFeedback(path, toolUseId);

    expect(result).not.toBeNull();
    expect(result!.tool_result).toBeUndefined();
  });
});
