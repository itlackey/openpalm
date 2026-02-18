import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class JsonStore<T extends object> {
  constructor(private path: string, private defaultValue: T) {
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) writeFileSync(path, JSON.stringify(defaultValue, null, 2));
  }

  get(): T {
    return JSON.parse(readFileSync(this.path, "utf8")) as T;
  }

  set(value: T) {
    writeFileSync(this.path, JSON.stringify(value, null, 2));
  }
}
