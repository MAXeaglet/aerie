import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { exec as sshExec, execScript } from '../ssh.js';

// 命令黑名单 — 检测危险 commands
interface DangerousPattern {
  pattern: RegExp;
  level: 'blocked' | 'warned';
}

const DANGEROUS_PATTERNS: DangerousPattern[] = [
  { pattern: /rm\s+-rf\s+\//, level: 'blocked' },        // rm -rf /
  { pattern: /dd\s+if=/, level: 'blocked' },              // dd if=
  { pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|:\s*&\s*\}\s*;+\s*:/, level: 'blocked' },  // fork bomb
  { pattern: />\s*\/dev\/sda/, level: 'blocked' },        // 写磁盘设备
  { pattern: /mkfs\./, level: 'blocked' },                // 格式化
  { pattern: /chmod\s+-R\s+777\s+\//, level: 'blocked' }, // 递归改根目录权限
  // New patterns
  { pattern: /sudo\s+/, level: 'blocked' },                         // sudo 提权
  { pattern: /shred\s+/, level: 'blocked' },                        // 安全删除
  { pattern: /wget\s+|curl\s+-[a-z]*o\s+/i, level: 'blocked' },    // 远程下载
  { pattern: /python3?\s+-c\s+['"]/, level: 'blocked' },            // Python 内联执行
  { pattern: /find\s+\/\s+-exec/, level: 'blocked' },               // find exec 批量操作
  { pattern: /chattr\s+/, level: 'blocked' },                       // 修改文件不可变属性
  { pattern: /systemctl\s+(stop|disable|mask)/, level: 'blocked' }, // 停止系统服务
  // 数据泄露 & 网络命令黑名单
  { pattern: /cat\s+\/(etc\/shadow|etc\/passwd|etc\/sudoers|etc\/ssh|etc\/ssl|root\/\.ssh|home\/.*\/\.ssh)/, level: 'blocked' },  // 读取敏感系统文件
  { pattern: /head\s+\/etc\/(shadow|passwd|sudoers)/, level: 'blocked' },  // 头部读取敏感文件
  { pattern: /curl\s+/, level: 'blocked' },                               // 所有 curl 出站
  { pattern: /base64\s+(-d|--decode)/, level: 'blocked' },                // base64 解码
  { pattern: /nc\s+|ncat\s+/, level: 'blocked' },                         // netcat 反向连接
  { pattern: /telnet\s+/, level: 'blocked' },                             // telnet 出站
  { pattern: /ssh\s+/, level: 'blocked' },                                // SSH 跳转
  { pattern: /scp\s+/, level: 'blocked' },                                // SCP 文件传输
  { pattern: /rsync\s+/, level: 'blocked' },                              // rsync 传输
  { pattern: /perl\s+/, level: 'blocked' },                               // perl 执行
  { pattern: /ruby\s+/, level: 'blocked' },                               // ruby 执行
  { pattern: /\|\s*(bash|sh|zsh|dash)\b/, level: 'blocked' },             // 管道到 shell
  { pattern: /;\s*(bash|sh|zsh|dash)\b/, level: 'blocked' },              // 分号后 shell
  { pattern: /`(curl|wget|nc|ncat|bash|sh|zsh)\s+/, level: 'blocked' },  // 反引号命令执行
  { pattern: /openssl\s+(enc|req|s_client)/, level: 'blocked' },          // openssl 加解密/出站连接
];

function isDangerous(command: string): { dangerous: boolean; pattern?: RegExp; level?: 'blocked' | 'warned' } {
  // 先检查精确模式匹配
  for (const entry of DANGEROUS_PATTERNS) {
    if (entry.pattern.test(command)) {
      return { dangerous: true, pattern: entry.pattern, level: entry.level };
    }
  }
  // 再检查风险等级
  const level = riskLevel(command);
  if (level === 'critical' || level === 'high') {
    return { dangerous: true, level: 'blocked' };
  }
  if (level === 'medium') {
    return { dangerous: true, level: 'warned' };
  }
  return { dangerous: false };
}

// 风险分级
function riskLevel(command: string): 'low' | 'medium' | 'high' | 'critical' {
  const cmd = command.toLowerCase();
  if (DANGEROUS_PATTERNS.some(p => p.pattern.test(cmd))) return 'critical';
  if (/reboot|shutdown|systemctl\s+restart|kill\s+-9|apt\s+(install|remove)|yum\s+(install|remove)|chmod\s+-R\s+777/.test(cmd)) return 'high';
  if (/sed\s+-i|systemctl|service\s+|useradd|usermod|passwd/.test(cmd)) return 'medium';
  return 'low';
}

// Tool definition
export const execTool = {
  name: 'warpgate_exec',
  description: '[WRITE] Execute a command or script on a target server',
  inputSchema: {
    type: 'object',
    properties: {
      target: { type: 'string', description: 'Target server name' },
      command: { type: 'string', description: 'Command or script content to execute' },
      isScript: { type: 'boolean', description: 'Whether command is a multi-line script' },
      timeout: { type: 'number', description: 'Timeout in ms (default 30000)' },
    },
    required: ['target', 'command'],
  },
};

export async function handleExec(
  getTarget: (name: string) => any,
  args: { target: string; command: string; isScript?: boolean; timeout?: number },
  auditLog: (entry: any) => void,
): Promise<any> {
  const targetInfo = getTarget(args.target);
  if (!targetInfo) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: `Target "${args.target}" not found` }) }],
      isError: true,
    };
  }

  // 黑名单检查
  const check = isDangerous(args.command);
  if (check.dangerous && check.level === 'blocked') {
    auditLog({
      id: randomUUID(), timestamp: new Date().toISOString(),
      tool: 'warpgate_exec', target: args.target,
      command: args.command.slice(0, 200), exitCode: null,
      durationMs: 0, riskLevel: 'critical', status: 'blocked',
      params: { matchedPattern: check.pattern?.source },
    });
    return {
      content: [{ type: 'text', text: JSON.stringify({
        error: 'Command blocked by security policy',
        matchedPattern: check.pattern?.source,
        riskLevel: 'critical',
      }) }],
      isError: true,
    };
  }

  // 额外风险等级检查（加强防御）
  const rl = riskLevel(args.command);
  if (rl === 'high' || rl === 'critical') {
    auditLog({
      id: randomUUID(), timestamp: new Date().toISOString(),
      tool: 'warpgate_exec', target: args.target,
      command: args.command.slice(0, 200), exitCode: null,
      durationMs: 0, riskLevel: rl, status: 'blocked',
      params: { matchedPattern: check.pattern?.source },
    });
    return {
      content: [{ type: 'text', text: JSON.stringify({
        error: 'Command blocked by security policy',
        matchedPattern: check.pattern?.source,
        riskLevel: rl,
      }) }],
      isError: true,
    };
  }

  // 执行
  const start = Date.now();
  try {
    const fn = args.isScript ? execScript : sshExec;
    const result = await fn(targetInfo, args.command, { timeout: args.timeout ?? 30000 });
    const duration = Date.now() - start;

    // 审计日志
    auditLog({
      id: randomUUID(), timestamp: new Date().toISOString(),
      tool: 'warpgate_exec', target: args.target,
      command: args.command.slice(0, 200),
      exitCode: result.exitCode, durationMs: duration,
      riskLevel: riskLevel(args.command),
      status: result.exitCode === 0 ? 'success' : 'failure',
    });

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    const duration = Date.now() - start;
    auditLog({
      id: randomUUID(), timestamp: new Date().toISOString(),
      tool: 'warpgate_exec', target: args.target,
      command: args.command.slice(0, 200),
      exitCode: null, durationMs: duration,
      riskLevel: riskLevel(args.command),
      status: 'failure',
    });
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: (err as Error).message }) }],
      isError: true,
    };
  }
}

// 导出供测试使用
export { isDangerous, riskLevel };
