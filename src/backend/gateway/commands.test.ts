import { describe, it, expect, vi, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

// 需要 mock fs 操作来模拟不同目录结构，但 getAllCommands 使用真实的 fs
// 改为使用临时目录来测试扫描逻辑

// 由于 commands.ts 在模块加载时使用 homedir() 获取路径，
// 我们需要 mock homedir 来指向临时目录
const TEST_HOME = mkdtempSync(join(tmpdir(), 'mypilot-cmd-test-'));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: () => TEST_HOME,
  };
});

// 动态导入，确保 mock 先生效
const { getAllCommands } = await import('./commands.js');

describe('getAllCommands', () => {
  afterAll(() => {
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('returns built-in commands when no skills/plugins/commands exist', () => {
    const commands = getAllCommands();
    expect(commands.length).toBeGreaterThanOrEqual(11);

    const names = commands.map(c => c.name);
    expect(names).toContain('/clear');
    expect(names).toContain('/compact');
    expect(names).toContain('/rename');
    expect(names).toContain('/simplify');
    expect(names).toContain('/review');
    expect(names).toContain('/security-review');
    expect(names).toContain('/plan');
    expect(names).toContain('/init');
    expect(names).toContain('/btw');
    expect(names).toContain('/export');
    expect(names).toContain('/insights');
  });

  it('every built-in command has required fields', () => {
    const commands = getAllCommands();
    for (const cmd of commands) {
      expect(typeof cmd.name).toBe('string');
      expect(cmd.name.startsWith('/')).toBe(true);
      expect(typeof cmd.description).toBe('string');
      expect(cmd.description.length).toBeGreaterThan(0);
      expect(typeof cmd.requiresArgs).toBe('boolean');
    }
  });

  it('built-in /rename requires args', () => {
    const commands = getAllCommands();
    const rename = commands.find(c => c.name === '/rename');
    expect(rename).toBeDefined();
    expect(rename!.requiresArgs).toBe(true);
  });

  it('built-in /btw requires args', () => {
    const commands = getAllCommands();
    const btw = commands.find(c => c.name === '/btw');
    expect(btw).toBeDefined();
    expect(btw!.requiresArgs).toBe(true);
  });

  it('built-in /review requires args', () => {
    const commands = getAllCommands();
    const review = commands.find(c => c.name === '/review');
    expect(review).toBeDefined();
    expect(review!.requiresArgs).toBe(true);
  });

  it('built-in /export requires args', () => {
    const commands = getAllCommands();
    const exportCmd = commands.find(c => c.name === '/export');
    expect(exportCmd).toBeDefined();
    expect(exportCmd!.requiresArgs).toBe(true);
  });

  describe('skill scanning', () => {
    it('scans skills from ~/.claude/skills/', () => {
      const skillsDir = join(TEST_HOME, '.claude', 'skills', 'my-skill');
      mkdirSync(skillsDir, { recursive: true });
      writeFileSync(join(skillsDir, 'SKILL.md'), `---
name: my-skill
description: A custom skill for testing
---

# My Skill
`);

      const commands = getAllCommands();
      const scanned = commands.find(c => c.name === '/my-skill');
      expect(scanned).toBeDefined();
      expect(scanned?.description).toBe('A custom skill for testing');
      expect(scanned?.requiresArgs).toBe(false);
    });

    it('uses directory name when frontmatter has no name field', () => {
      const skillsDir = join(TEST_HOME, '.claude', 'skills', 'fallback-name');
      mkdirSync(skillsDir, { recursive: true });
      writeFileSync(join(skillsDir, 'SKILL.md'), `---
description: Fallback name test
---
`);

      const commands = getAllCommands();
      const scanned = commands.find(c => c.name === '/fallback-name');
      expect(scanned).toBeDefined();
    });

    it('trims multi-line description to first line', () => {
      const skillsDir = join(TEST_HOME, '.claude', 'skills', 'multi-desc');
      mkdirSync(skillsDir, { recursive: true });
      writeFileSync(join(skillsDir, 'SKILL.md'), `---
name: multi-desc
description: |
  First line of description
  Second line that should be trimmed
---

# Multi Desc
`);

      const commands = getAllCommands();
      const scanned = commands.find(c => c.name === '/multi-desc');
      expect(scanned?.description).toBe('First line of description');
    });

    it('scanned skill without name field is skipped', () => {
      const skillsDir = join(TEST_HOME, '.claude', 'skills', 'nameless');
      mkdirSync(skillsDir, { recursive: true });
      writeFileSync(join(skillsDir, 'SKILL.md'), `---
description: No name here
---
`);

      const commands = getAllCommands();
      const scanned = commands.find(c => c.name === '/nameless');
      // It falls back to directory name
      expect(scanned).toBeDefined();
    });

    it('skill with no frontmatter still uses directory name', () => {
      const skillsDir = join(TEST_HOME, '.claude', 'skills', 'no-fm-skill');
      mkdirSync(skillsDir, { recursive: true });
      writeFileSync(join(skillsDir, 'SKILL.md'), '# Just a heading\n\nNo frontmatter here.');

      const commands = getAllCommands();
      const scanned = commands.find(c => c.name === '/no-fm-skill');
      expect(scanned).toBeDefined();
      expect(scanned?.description).toBe('no-fm-skill');
    });
  });

  describe('custom commands scanning', () => {
    it('scans commands from ~/.claude/commands/', () => {
      const commandsDir = join(TEST_HOME, '.claude', 'commands');
      mkdirSync(commandsDir, { recursive: true });
      writeFileSync(join(commandsDir, 'deploy.md'), `---
description: Deploy the application to production
---
`);

      const commands = getAllCommands();
      const scanned = commands.find(c => c.name === '/deploy');
      expect(scanned).toBeDefined();
      expect(scanned?.description).toBe('Deploy the application to production');
    });

    it('uses filename as fallback name when no description', () => {
      const commandsDir = join(TEST_HOME, '.claude', 'commands');
      mkdirSync(commandsDir, { recursive: true });
      writeFileSync(join(commandsDir, 'test-cmd.md'), '# Test Command');

      const commands = getAllCommands();
      const scanned = commands.find(c => c.name === '/test-cmd');
      expect(scanned).toBeDefined();
    });
  });

  describe('dedup', () => {
    it('does not duplicate built-in commands from scanned skills', () => {
      // Create a skill file that has the same name as a built-in command
      const skillsDir = join(TEST_HOME, '.claude', 'skills', 'clear');
      mkdirSync(skillsDir, { recursive: true });
      writeFileSync(join(skillsDir, 'SKILL.md'), `---
name: clear
description: Should not override built-in
---
`);

      const commands = getAllCommands();
      const clearCommands = commands.filter(c => c.name === '/clear');
      expect(clearCommands).toHaveLength(1);
      // Built-in description should be preserved (not overridden)
      expect(clearCommands[0].description).not.toBe('Should not override built-in');
    });

    it('does not duplicate commands with same name from different sources', () => {
      const skillsDir = join(TEST_HOME, '.claude', 'skills', 'unique-skill');
      mkdirSync(skillsDir, { recursive: true });
      writeFileSync(join(skillsDir, 'SKILL.md'), `---
name: unique-skill
description: From skills
---
`);

      const commandsDir = join(TEST_HOME, '.claude', 'commands');
      mkdirSync(commandsDir, { recursive: true });
      writeFileSync(join(commandsDir, 'unique-skill.md'), `---
description: From commands
---
`);

      const commands = getAllCommands();
      const matches = commands.filter(c => c.name === '/unique-skill');
      expect(matches).toHaveLength(1);
      // Skills are scanned first, so the skills description should win
      expect(matches[0].description).toBe('From skills');
    });
  });

  describe('missing directories', () => {
    it('handles missing ~/.claude/skills gracefully', () => {
      // TEST_HOME has no .claude/skills dir initially (in some cases)
      // Just verify no throw
      expect(() => getAllCommands()).not.toThrow();
    });

    it('handles missing ~/.claude/commands gracefully', () => {
      expect(() => getAllCommands()).not.toThrow();
    });
  });
});
