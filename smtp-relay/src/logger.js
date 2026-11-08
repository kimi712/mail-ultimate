// 本地日志：写 stdout + 追加写日志文件（*.log 已进 .gitignore）。
// 全部时间 UTC；绝不在日志里写密码、JWT、TG token。
import { createWriteStream } from 'node:fs';

export function createLogger({ file = '', level = 'info' } = {}) {
  const levels = { error: 0, info: 1 };
  const minLevel = levels[level] ?? 1;
  let stream = null;
  if (file) {
    try {
      stream = createWriteStream(file, { flags: 'a' });
      stream.on('error', () => {
        stream = null;
      });
    } catch {
      stream = null;
    }
  }
  const write = (kind, msg) => {
    if ((levels[kind] ?? 1) > minLevel) return;
    const line = `${new Date().toISOString()} [${kind.toUpperCase()}] ${msg}`;
    if (kind === 'error') console.error(line);
    else console.log(line);
    if (stream) stream.write(`${line}\n`);
  };
  return {
    info: (msg) => write('info', msg),
    error: (msg) => write('error', msg),
    /** AUTH 审计行：只记邮箱与结果，绝不记密码。 */
    auth: (ip, email, ok, detail = '') =>
      write('info', `AUTH ip=${ip} email=${email} result=${ok ? 'ok' : 'fail'}${detail ? ` ${detail}` : ''}`),
    close: () => {
      if (stream) stream.end();
    },
  };
}
