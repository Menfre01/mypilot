import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import type { CommandItem } from '../../shared/protocol.js';

// 以下 TUI 命令暂不支持（需要在终端渲染 UI）：
// /rewind, /context, /help, /status, /ide, /cost, /doctor, /terminal-setup

const BUILTIN_COMMANDS: CommandItem[] = [
  { name: '/new', description: 'Start a new conversation', requiresArgs: false },
  { name: '/clear', description: 'Clear the current conversation', requiresArgs: false },
  { name: '/compact', description: 'Compact the context', requiresArgs: false },
  { name: '/resume', description: 'Resume a previous session', requiresArgs: true },
  { name: '/simplify', description: 'Simplify and refactor code', requiresArgs: false },
  { name: '/review', description: 'Review a pull request', requiresArgs: true },
  { name: '/commit', description: 'Commit staged changes', requiresArgs: false },
  { name: '/health', description: 'Run code quality check', requiresArgs: false },
  { name: '/doc', description: 'Generate documentation', requiresArgs: false },
  { name: '/release-notes', description: 'Generate release notes', requiresArgs: false },
];

/** 解析 Markdown frontmatter 中的简单 YAML 字段 */
function parseFrontmatter(content: string): Record<string, string> {
  const fields: Record<string, string> = {};
  // 匹配 --- ... --- 之间的内容
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return fields;

  const fm = match[1];
  // 解析简单的 key: value 和 key: | 多行值
  const lines = fm.split('\n');
  let currentKey = '';
  let currentValue = '';

  for (const line of lines) {
    const kvMatch = line.match(/^(\w[\w-]*):\s*(.*)/);
    if (kvMatch) {
      // 保存上一个 key
      if (currentKey) {
        fields[currentKey] = currentValue.trim();
      }
      currentKey = kvMatch[1];
      currentValue = kvMatch[2];
      // 如果值以 | 开头，继续读取多行
      if (currentValue === '|') {
        currentValue = '';
      }
    } else if (currentKey) {
      // 续行（多行值的后续行）
      currentValue += (currentValue ? '\n' : '') + line.replace(/^\s{2}/, '');
    }
  }
  if (currentKey) {
    fields[currentKey] = currentValue.trim();
  }

  return fields;
}

/** 扫描 ~/.claude/skills/ 目录下的技能 */
function scanSkillsDir(skillsDir: string): CommandItem[] {
  const commands: CommandItem[] = [];
  try {
    if (!existsSync(skillsDir)) return commands;
    const entries = readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = join(skillsDir, entry.name, 'SKILL.md');
      if (!existsSync(skillFile)) continue;
      try {
        const content = readFileSync(skillFile, 'utf8');
        const fm = parseFrontmatter(content);
        const name = fm['name'] ?? entry.name;
        const description = fm['description']?.split('\n')[0] ?? '';
        if (name) {
          commands.push({
            name: `/${name}`,
            description: description || name,
            requiresArgs: false,
          });
        }
      } catch {
        // 跳过无法读取的技能
      }
    }
  } catch {
    // 扫描失败，返回空列表
  }
  return commands;
}

// 扫描 ~/.claude/plugins/cache/ 下的插件技能
function scanPluginSkills(): CommandItem[] {
  const commands: CommandItem[] = [];
  const pluginsBase = join(homedir(), '.claude', 'plugins', 'cache');
  try {
    if (!existsSync(pluginsBase)) return commands;
    const markets = readdirSync(pluginsBase, { withFileTypes: true });
    for (const market of markets) {
      if (!market.isDirectory()) continue;
      const marketDir = join(pluginsBase, market.name);
      const plugins = readdirSync(marketDir, { withFileTypes: true });
      for (const plugin of plugins) {
        if (!plugin.isDirectory()) continue;
        const pluginDir = join(marketDir, plugin.name);
        // 查找版本目录
        const versions = readdirSync(pluginDir, { withFileTypes: true });
        for (const version of versions) {
          if (!version.isDirectory()) continue;
          const skillsDir = join(pluginDir, version.name, 'skills');
          const found = scanSkillsDir(skillsDir);
          commands.push(...found);
        }
      }
    }
  } catch {
    // 扫描失败
  }
  return commands;
}

/** 扫描 ~/.claude/commands/ 下的自定义命令 */
function scanCustomCommands(): CommandItem[] {
  const commands: CommandItem[] = [];
  const commandsDir = join(homedir(), '.claude', 'commands');
  try {
    if (!existsSync(commandsDir)) return commands;
    const files = readdirSync(commandsDir, { withFileTypes: true });
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.md')) continue;
      try {
        const content = readFileSync(join(commandsDir, file.name), 'utf8');
        const fm = parseFrontmatter(content);
        const cmdName = basename(file.name, '.md');
        const description = fm['description']?.split('\n')[0] ?? '';
        commands.push({
          name: `/${cmdName}`,
          description: description || cmdName,
          requiresArgs: false,
        });
      } catch {
        // 跳过无法读取的文件
      }
    }
  } catch {
    // 扫描失败
  }
  return commands;
}

/** 获取所有可用命令（内置 + 扫描到的技能） */
export function getAllCommands(): CommandItem[] {
  const claudeDir = join(homedir(), '.claude');
  const skillsDir = join(claudeDir, 'skills');

  const scanned = [
    ...scanSkillsDir(skillsDir),
    ...scanPluginSkills(),
    ...scanCustomCommands(),
  ];

  // 去重：已存在于内置列表中的命令不重复添加
  const builtinNames = new Set(BUILTIN_COMMANDS.map((c) => c.name));
  const unique: CommandItem[] = [];
  const seen = new Set(builtinNames);

  for (const cmd of scanned) {
    if (!seen.has(cmd.name)) {
      seen.add(cmd.name);
      unique.push(cmd);
    }
  }

  return [...BUILTIN_COMMANDS, ...unique];
}
