import fs from 'node:fs';
import path from 'node:path';
import { durableJson, readJson } from '../data/storage';
/** Corrupt trust state never becomes an implicit approval or a silent reset. */
export class ContentPins {
  private pins: Record<string, string> = {};
  private error?: string;
  private file: string;
  constructor(profile: string, name: string) {
    this.file = path.join(profile, name);
    if (!fs.existsSync(this.file)) return;
    try {
      const value = readJson<{ pins: Record<string, string> }>(
        this.file,
        1024 * 1024,
      );
      if (
        !value.pins ||
        typeof value.pins !== 'object' ||
        Array.isArray(value.pins) ||
        Object.entries(value.pins).some(
          ([name, hash]) =>
            name.length > 200 ||
            typeof hash !== 'string' ||
            !/^[a-f0-9]{64}$/.test(hash),
        )
      )
        throw Error('Invalid trust records.');
      this.pins = value.pins;
    } catch {
      this.error =
        'Trust records could not be verified. Preserve the file and review it before approving integrations.';
    }
  }
  matches(name: string, hash: string) {
    return !this.error && this.pins[name] === hash;
  }
  approve(name: string, hash: string) {
    if (this.error) throw Error(this.error);
    if (!name || name.length > 200 || !/^[a-f0-9]{64}$/.test(hash))
      throw Error('Invalid content approval.');
    const pins = { ...this.pins, [name]: hash };
    durableJson(this.file, { pins });
    this.pins = pins;
  }
  revoke(name: string) {
    if (this.error) throw Error(this.error);
    const pins = { ...this.pins };
    delete pins[name];
    durableJson(this.file, { pins });
    this.pins = pins;
  }
}
