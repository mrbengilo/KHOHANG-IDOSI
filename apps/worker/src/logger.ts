import type { LogLevel } from './config.js';
import type { WorkerLogger } from './types.js';

const RANK: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function createLogger(level: LogLevel): WorkerLogger {
  const write = (
    target: LogLevel,
    fields: Readonly<Record<string, unknown>>,
    message: string,
  ): void => {
    if (RANK[target] < RANK[level]) return;
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      level: target,
      message,
      ...fields,
    });
    if (target === 'error') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  };

  return {
    info: (fields, message) => write('info', fields, message),
    warn: (fields, message) => write('warn', fields, message),
    error: (fields, message) => write('error', fields, message),
  };
}
