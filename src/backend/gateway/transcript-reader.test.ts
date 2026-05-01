import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeTranscriptLine } from './ws-test-helpers.js';
import { readTranscript, readToolEntry, clearTranscriptCache } from './transcript-reader.js';

describe('transcript-reader', () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    clearTranscriptCache();
  });

  function setupTranscript(lines: string[]): string {
    tempDir = mkdtempSync(join(tmpdir(), 'mypilot-tr-test-'));
    const path = join(tempDir, 'transcript.jsonl');
    writeFileSync(path, lines.join(''), 'utf-8');
    return path;
  }

  // ── readTranscript ──

  describe('readTranscript', () => {
    it('parses assistant entry with thinking, text, and tool_use blocks', async () => {
      const path = setupTranscript([
        makeTranscriptLine({
          type: 'assistant',
          timestamp: '2025-06-15T10:30:00.000Z',
          message: {
            model: 'claude-opus-4-7',
            usage: { input_tokens: 100, output_tokens: 50 },
            content: [
              { type: 'thinking', thinking: 'Let me analyze this.' },
              { type: 'text', text: 'I will read the file.' },
              { type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: '/tmp/a.txt' } },
            ],
          },
        }),
      ]);

      const result = await readTranscript(path);

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];
      expect(entry.index).toBe(0);
      expect(entry.type).toBe('assistant');
      expect(entry.model).toBe('claude-opus-4-7');
      expect(entry.usage).toBeDefined();
      expect(entry.usage!.input_tokens).toBe(100);
      expect(entry.usage!.output_tokens).toBe(50);
      expect(entry.timestamp).toBeGreaterThan(0);

      const types = entry.blocks.map((b) => b.type);
      expect(types).toContain('thinking');
      expect(types).toContain('text');
      expect(types).toContain('tool_use');

      const thinking = entry.blocks.find((b) => b.type === 'thinking')!;
      expect(thinking.thinking).toBe('Let me analyze this.');

      const toolUse = entry.blocks.find((b) => b.type === 'tool_use')!;
      expect(toolUse.id).toBe('call_1');
      expect(toolUse.name).toBe('Read');
      expect(toolUse.input).toEqual({ file_path: '/tmp/a.txt' });
    });

    it('parses user entry with tool_result block', async () => {
      const path = setupTranscript([
        makeTranscriptLine({
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'call_1', content: 'file contents here', isError: false },
            ],
          },
        }),
      ]);

      const result = await readTranscript(path);

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];
      expect(entry.type).toBe('user');
      expect(entry.model).toBeUndefined();
      expect(entry.usage).toBeUndefined();

      const toolResult = entry.blocks.find((b) => b.type === 'tool_result')!;
      expect(toolResult.tool_use_id).toBe('call_1');
      expect(toolResult.content).toBe('file contents here');
      expect(toolResult.isError).toBe(false);
    });

    it('parses user entry with text block', async () => {
      const path = setupTranscript([
        makeTranscriptLine({
          type: 'user',
          message: {
            content: [{ type: 'text', text: 'Please do the thing.' }],
          },
        }),
      ]);

      const result = await readTranscript(path);

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];
      expect(entry.type).toBe('user');
      const text = entry.blocks.find((b) => b.type === 'text')!;
      expect(text.text).toBe('Please do the thing.');
    });

    it('extracts model from message.model when entry.model is absent', async () => {
      const path = setupTranscript([
        makeTranscriptLine({
          type: 'assistant',
          message: {
            model: 'claude-sonnet-4-6',
            usage: { input_tokens: 10, output_tokens: 5 },
            content: [{ type: 'text', text: 'Done.' }],
          },
        }),
      ]);

      const result = await readTranscript(path);
      expect(result.entries[0].model).toBe('claude-sonnet-4-6');
    });

    it('returns empty entries for attachment, system, and other non-assistant/user types', async () => {
      const path = setupTranscript([
        makeTranscriptLine({ type: 'attachment', attachment: {} }),
        makeTranscriptLine({ type: 'system', system: 'init' }),
        makeTranscriptLine({ type: 'file-history-snapshot', files: [] }),
        makeTranscriptLine({ type: 'last-prompt', prompt: 'hello' }),
      ]);

      const result = await readTranscript(path);
      expect(result.entries).toHaveLength(0);
    });

    it('skips entries with empty content blocks', async () => {
      const path = setupTranscript([
        makeTranscriptLine({
          type: 'assistant',
          message: { model: 'claude-opus-4-7', content: [] },
        }),
      ]);

      const result = await readTranscript(path);
      expect(result.entries).toHaveLength(0);
    });

    it('handles empty file', async () => {
      tempDir = mkdtempSync(join(tmpdir(), 'mypilot-tr-test-'));
      const path = join(tempDir, 'empty.jsonl');
      writeFileSync(path, '', 'utf-8');

      const result = await readTranscript(path);
      expect(result.entries).toHaveLength(0);
      expect(result.fileSize).toBe(0);
      expect(result.lineCount).toBe(0);
    });

    it('handles non-existent file', async () => {
      tempDir = mkdtempSync(join(tmpdir(), 'mypilot-tr-test-'));
      const path = join(tempDir, 'does-not-exist.jsonl');

      const result = await readTranscript(path);
      expect(result.entries).toHaveLength(0);
    });

    it('skips malformed JSON lines gracefully', async () => {
      const path = setupTranscript([
        'not valid json\n',
        makeTranscriptLine({
          type: 'assistant',
          message: {
            model: 'robust-model',
            usage: {},
            content: [{ type: 'text', text: 'After bad line.' }],
          },
        }),
      ]);

      const result = await readTranscript(path);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].model).toBe('robust-model');
    });

    it('truncates thinking to 300 chars', async () => {
      const longThinking = 'A'.repeat(500);
      const path = setupTranscript([
        makeTranscriptLine({
          type: 'assistant',
          message: {
            model: 'test-model',
            usage: {},
            content: [
              { type: 'thinking', thinking: longThinking },
              { type: 'text', text: 'OK' },
            ],
          },
        }),
      ]);

      const result = await readTranscript(path);
      const thinking = result.entries[0].blocks.find((b) => b.type === 'thinking')!;
      expect(thinking.thinking!.length).toBeLessThanOrEqual(300);
      expect(thinking.thinking!.length).toBeGreaterThan(0);
    });

    it('truncates text to 500 chars', async () => {
      const longText = 'B'.repeat(600);
      const path = setupTranscript([
        makeTranscriptLine({
          type: 'assistant',
          message: {
            model: 'test-model',
            usage: {},
            content: [{ type: 'text', text: longText }],
          },
        }),
      ]);

      const result = await readTranscript(path);
      const text = result.entries[0].blocks.find((b) => b.type === 'text')!;
      expect(text.text!.length).toBeLessThanOrEqual(500);
      expect(text.text!.length).toBeGreaterThan(0);
    });

    it('truncates tool_result to 1000 chars', async () => {
      const longResult = 'C'.repeat(1500);
      const path = setupTranscript([
        makeTranscriptLine({
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'call_1', content: longResult, isError: false }],
          },
        }),
      ]);

      const result = await readTranscript(path);
      const toolResult = result.entries[0].blocks.find((b) => b.type === 'tool_result')!;
      expect(toolResult.content!.length).toBeLessThanOrEqual(1000);
      expect(toolResult.content!.length).toBeGreaterThan(0);
    });

    it('handles string-type model field', async () => {
      const path = setupTranscript([
        makeTranscriptLine({
          model: 'claude-opus-4-7',
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Hello' }],
          },
        }),
      ]);

      const result = await readTranscript(path);
      expect(result.entries[0].model).toBe('claude-opus-4-7');
    });

    it('lastReadIndex skips already-processed entries', async () => {
      const path = setupTranscript([
        makeTranscriptLine({
          type: 'assistant',
          timestamp: '2025-01-01T00:00:00Z',
          message: { model: 'm1', usage: {}, content: [{ type: 'text', text: 'First' }] },
        }),
        makeTranscriptLine({
          type: 'assistant',
          timestamp: '2025-01-01T00:01:00Z',
          message: { model: 'm2', usage: {}, content: [{ type: 'text', text: 'Second' }] },
        }),
        makeTranscriptLine({
          type: 'assistant',
          timestamp: '2025-01-01T00:02:00Z',
          message: { model: 'm3', usage: {}, content: [{ type: 'text', text: 'Third' }] },
        }),
      ]);

      const result = await readTranscript(path, 1);

      expect(result.entries).toHaveLength(2);
      expect(result.entries[0].model).toBe('m2');
      expect(result.entries[1].model).toBe('m3');
    });

    it('assigns sequential indices starting from 0', async () => {
      const path = setupTranscript([
        makeTranscriptLine({
          type: 'assistant',
          message: { model: 'a', usage: {}, content: [{ type: 'text', text: 'One' }] },
        }),
        makeTranscriptLine({
          type: 'user',
          message: { content: [{ type: 'text', text: 'Two' }] },
        }),
        makeTranscriptLine({
          type: 'assistant',
          message: { model: 'b', usage: {}, content: [{ type: 'text', text: 'Three' }] },
        }),
      ]);

      const result = await readTranscript(path);
      expect(result.entries).toHaveLength(3);
      expect(result.entries[0].index).toBe(0);
      expect(result.entries[1].index).toBe(1);
      expect(result.entries[2].index).toBe(2);
    });

    it('returns lineCount and fileSize', async () => {
      const path = setupTranscript([
        makeTranscriptLine({ type: 'attachment', attachment: {} }),
        makeTranscriptLine({
          type: 'assistant',
          message: { model: 'm', usage: {}, content: [{ type: 'text', text: 'Hi' }] },
        }),
      ]);

      const result = await readTranscript(path);

      expect(result.lineCount).toBe(2);
      expect(result.fileSize).toBeGreaterThan(0);
    });

    it('parses timestamp from string and number formats', async () => {
      const path = setupTranscript([
        makeTranscriptLine({
          type: 'assistant',
          timestamp: '2025-06-15T10:30:00.000Z',
          message: { model: 'm1', usage: {}, content: [{ type: 'text', text: 'String ts' }] },
        }),
        makeTranscriptLine({
          type: 'assistant',
          timestamp: 1718452200000,
          message: { model: 'm2', usage: {}, content: [{ type: 'text', text: 'Number ts' }] },
        }),
      ]);

      const result = await readTranscript(path);
      expect(result.entries).toHaveLength(2);
      // String timestamp parsed
      expect(result.entries[0].timestamp).toBeGreaterThan(0);
      expect(new Date(result.entries[0].timestamp).toISOString()).toBe('2025-06-15T10:30:00.000Z');
      // Number timestamp passed through
      expect(result.entries[1].timestamp).toBe(1718452200000);
    });

    it('uses Date.now() when timestamp field is missing', async () => {
      const before = Date.now();
      const path = setupTranscript([
        makeTranscriptLine({
          type: 'assistant',
          message: { model: 'm', usage: {}, content: [{ type: 'text', text: 'No ts' }] },
        }),
      ]);

      const result = await readTranscript(path);
      expect(result.entries[0].timestamp).toBeGreaterThanOrEqual(before);
    });
  });

  // ── readToolEntry ──

  describe('readToolEntry', () => {
    it('finds assistant entry and user result for matching tool_use_id', async () => {
      const toolUseId = 'call_read_1';
      const path = setupTranscript([
        makeTranscriptLine({
          type: 'assistant',
          timestamp: '2025-06-15T10:30:00.000Z',
          message: {
            model: 'claude-opus-4-7',
            usage: { input_tokens: 1000, output_tokens: 200 },
            content: [
              { type: 'thinking', thinking: 'I should read this file.' },
              { type: 'text', text: 'Reading configuration...' },
              { type: 'tool_use', id: toolUseId, name: 'Read', input: { file_path: '/tmp/config.json' } },
            ],
          },
        }),
        makeTranscriptLine({
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: toolUseId, content: '{"port": 8080}', isError: false },
            ],
          },
        }),
      ]);

      const { assistant, result } = await readToolEntry(path, toolUseId);

      expect(assistant).not.toBeNull();
      expect(assistant!.type).toBe('assistant');
      expect(assistant!.model).toBe('claude-opus-4-7');
      expect(assistant!.blocks.map((b) => b.type)).toContain('thinking');

      expect(result).not.toBeNull();
      expect(result!.type).toBe('user');
      const toolResult = result!.blocks.find((b) => b.type === 'tool_result')!;
      expect(toolResult.content).toBe('{"port": 8080}');
    });

    it('returns null for non-matching tool_use_id', async () => {
      const path = setupTranscript([
        makeTranscriptLine({
          type: 'assistant',
          message: {
            model: 'test-model',
            usage: {},
            content: [{ type: 'tool_use', id: 'some_other_call', name: 'Bash', input: {} }],
          },
        }),
      ]);

      const { assistant, result } = await readToolEntry(path, 'nonexistent_call');

      expect(assistant).toBeNull();
      expect(result).toBeNull();
    });

    it('returns null when only assistant entry exists without matching result', async () => {
      const toolUseId = 'call_no_result';
      const path = setupTranscript([
        makeTranscriptLine({
          type: 'assistant',
          message: {
            model: 'test-model',
            usage: {},
            content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: {} }],
          },
        }),
      ]);

      const { assistant, result } = await readToolEntry(path, toolUseId);

      expect(assistant).not.toBeNull();
      expect(result).toBeNull();
    });

    it('handles isError in tool_result', async () => {
      const toolUseId = 'call_error';
      const path = setupTranscript([
        makeTranscriptLine({
          type: 'assistant',
          message: {
            model: 'test-model',
            usage: {},
            content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: {} }],
          },
        }),
        makeTranscriptLine({
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: toolUseId, content: 'Command failed', isError: true },
            ],
          },
        }),
      ]);

      const { result } = await readToolEntry(path, toolUseId);

      expect(result).not.toBeNull();
      const toolResult = result!.blocks.find((b) => b.type === 'tool_result')!;
      expect(toolResult.isError).toBe(true);
      expect(toolResult.content).toBe('Command failed');
    });

    it('reads from large files by tailing (last 65KB)', async () => {
      const noise: string[] = [];
      for (let i = 0; i < 100; i++) {
        noise.push(
          makeTranscriptLine({
            type: 'user',
            message: {
              content: [{ type: 'tool_result', tool_use_id: `old_${i}`, content: `result ${i}`, isError: false }],
            },
          }),
        );
      }
      const toolUseId = 'target_large_call';
      noise.push(
        makeTranscriptLine({
          type: 'assistant',
          message: {
            model: 'target-model',
            usage: { input_tokens: 100, output_tokens: 10 },
            content: [
              { type: 'text', text: 'Found it.' },
              { type: 'tool_use', id: toolUseId, name: 'Bash', input: {} },
            ],
          },
        }),
        makeTranscriptLine({
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: toolUseId, content: 'final result', isError: false },
            ],
          },
        }),
      );

      const path = setupTranscript(noise);
      const { assistant, result } = await readToolEntry(path, toolUseId);

      expect(assistant).not.toBeNull();
      expect(assistant!.model).toBe('target-model');
      expect(result).not.toBeNull();
    });

    it('matches first entry when tool_use_id appears multiple times (last wins, reverse scan)', async () => {
      const toolUseId = 'duplicate_call';
      const path = setupTranscript([
        makeTranscriptLine({
          type: 'assistant',
          message: {
            model: 'first-model',
            usage: {},
            content: [{ type: 'tool_use', id: toolUseId, name: 'Read', input: {} }],
          },
        }),
        makeTranscriptLine({
          type: 'assistant',
          message: {
            model: 'latest-model',
            usage: { input_tokens: 50, output_tokens: 25 },
            content: [{ type: 'tool_use', id: toolUseId, name: 'Read', input: { retry: true } }],
          },
        }),
      ]);

      const { assistant } = await readToolEntry(path, toolUseId);

      expect(assistant).not.toBeNull();
      // Reverse scan finds the latest entry first
      expect(assistant!.model).toBe('latest-model');
    });

    it('handles empty file for readToolEntry', async () => {
      tempDir = mkdtempSync(join(tmpdir(), 'mypilot-tr-test-'));
      const path = join(tempDir, 'empty.jsonl');
      writeFileSync(path, '', 'utf-8');

      const { assistant, result } = await readToolEntry(path, 'any_call');

      expect(assistant).toBeNull();
      expect(result).toBeNull();
    });

    it('handles non-existent file for readToolEntry', async () => {
      tempDir = mkdtempSync(join(tmpdir(), 'mypilot-tr-test-'));
      const path = join(tempDir, 'no-file.jsonl');

      const { assistant, result } = await readToolEntry(path, 'any_call');

      expect(assistant).toBeNull();
      expect(result).toBeNull();
    });

    it('extracts usage fields including cache tokens', async () => {
      const toolUseId = 'call_cache';
      const path = setupTranscript([
        makeTranscriptLine({
          type: 'assistant',
          message: {
            model: 'claude-opus-4-7',
            usage: {
              input_tokens: 5000,
              output_tokens: 300,
              cache_read_input_tokens: 2560,
              cache_creation_input_tokens: 1280,
            },
            content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: {} }],
          },
        }),
      ]);

      const { assistant } = await readToolEntry(path, toolUseId);

      expect(assistant).not.toBeNull();
      expect(assistant!.usage!.input_tokens).toBe(5000);
      expect(assistant!.usage!.output_tokens).toBe(300);
      expect(assistant!.usage!.cache_read_input_tokens).toBe(2560);
      expect(assistant!.usage!.cache_creation_input_tokens).toBe(1280);
    });

    it('returns undefined for missing usage', async () => {
      const toolUseId = 'call_no_usage';
      const path = setupTranscript([
        makeTranscriptLine({
          type: 'assistant',
          message: {
            model: 'test-model',
            content: [{ type: 'tool_use', id: toolUseId, name: 'Read', input: {} }],
          },
        }),
      ]);

      const { assistant } = await readToolEntry(path, toolUseId);

      expect(assistant).not.toBeNull();
      expect(assistant!.usage).toBeUndefined();
    });
  });
});
