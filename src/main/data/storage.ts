import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
export const validId = (id: string) => {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw Error('Invalid record id.');
  return id;
};
export function durableJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(temp, file);
        break;
      } catch (error) {
        if (
          attempt >= 3 ||
          !['EPERM', 'EACCES', 'EBUSY'].includes(
            (error as NodeJS.ErrnoException).code ?? '',
          )
        )
          throw error;
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          10 * (attempt + 1),
        );
      }
    }
    if (process.platform !== 'win32') {
      const directory = fs.openSync(path.dirname(file), 'r');
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    }
  } catch (error) {
    try {
      fs.unlinkSync(temp);
    } catch {
      /* Keep original error. */
    }
    throw error;
  }
}
export function readJson<T>(file: string, maxBytes = 10 * 1024 * 1024): T {
  if (fs.statSync(file).size > maxBytes)
    throw Error('Record exceeds its size limit.');
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}
