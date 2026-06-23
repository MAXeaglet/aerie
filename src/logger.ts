import pino from 'pino';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.js';

export function createLogger(config: Config): pino.Logger {
  // 确保日志目录存在
  mkdirSync(config.logDir, { recursive: true });

  const transport = pino.transport({
    targets: [
      {
        target: 'pino/file',
        options: { destination: join(config.logDir, 'combined.log') },
        level: config.logLevel,
      },
      {
        target: 'pino/file',
        options: { destination: join(config.logDir, 'error.log') },
        level: 'error',
      },
    ],
  });

  const logger = pino(
    {
      level: config.logLevel,
      formatters: {
        level(label) { return { level: label }; },
        bindings() { return {}; }, // 不输出 pid/hostname 到每个日志
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    transport
  );

  return logger;
}
