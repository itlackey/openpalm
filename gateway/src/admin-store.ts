import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionRequest } from "./types.ts";

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

export class ExtensionQueue {
  private store: JsonStore<ExtensionRequest[]>;

  constructor(path: string) {
    this.store = new JsonStore(path, []);
  }

  list() {
    return this.store.get();
  }

  upsert(req: ExtensionRequest) {
    const items = this.store.get();
    const idx = items.findIndex((x) => x.id === req.id);
    if (idx >= 0) items[idx] = req;
    else items.push(req);
    this.store.set(items);
    return req;
  }

  get(id: string) {
    return this.store.get().find((x) => x.id === id) ?? null;
  }
}
