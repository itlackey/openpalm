// Non-self-referential drift detector for the §5.1 native contract surface
// (remediation plan 3.2). The `harness contract` describe block in main.test.ts
// asserts HARNESS_CONTRACT against a hardcoded literal — which is self-
// referential in the sense that both the literal and HARNESS_CONTRACT are
// hand-maintained together and can drift from the ACTUAL bridge/handler code
// in lockstep without either test noticing.
//
// This test instead DERIVES the real IPC surface straight from the source text
// of preload.ts (the renderer-facing bridge) and main.ts (the ipcMain
// registrations), and asserts HARNESS_CONTRACT matches what those files
// actually expose/handle — so an engineer who adds a new bridge method or
// ipcMain channel without updating HARNESS_CONTRACT fails CI even if they
// (incorrectly) also updated the hardcoded snapshot in main.test.ts to match.
//
// Run via vitest (Node): bun run --cwd packages/electron test
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARNESS_CONTRACT } from '../src/harness-contract.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const preloadSrc = readFileSync(resolve(__dirname, '../src/preload.ts'), 'utf-8');
const mainSrc = readFileSync(resolve(__dirname, '../src/main.ts'), 'utf-8');

// Only the members ABOVE this marker are part of the §5.1 control-plane
// contract; preload.ts explicitly documents everything below it as
// harness-internal (the Docker-missing splash screen only), matching the
// comment in preload.ts itself.
const [contractSection] = preloadSrc.split('// ── Harness-internal screens');

interface Member {
  name: string;
  body: string;
}

/** Extract each top-level (2-space-indented) method member and its body from
 * the `contextBridge.exposeInMainWorld('openpalm', { ... })` object literal. */
function extractMembers(objSrc: string): Member[] {
  const memberStartRe = /^ {2}(\w+)\(/gm;
  const starts: Array<{ name: string; idx: number }> = [];
  let m = memberStartRe.exec(objSrc);
  while (m) {
    starts.push({ name: m[1], idx: m.index });
    m = memberStartRe.exec(objSrc);
  }
  return starts.map(({ name, idx }) => {
    const endMarker = objSrc.indexOf('\n  },', idx);
    const end = endMarker === -1 ? objSrc.length : endMarker;
    return { name, body: objSrc.slice(idx, end) };
  });
}

const members = extractMembers(contractSection);
expect(members.length).toBeGreaterThan(0); // sanity: the parser actually found members

const derivedSync = members.filter((mb) => !mb.body.includes('ipcRenderer')).map((mb) => mb.name).sort();
const derivedSend = members
  .filter((mb) => mb.body.includes('ipcRenderer.send('))
  .map((mb) => mb.name)
  .sort();
const derivedInvoke = members
  .filter((mb) => mb.body.includes('ipcRenderer.invoke('))
  .map((mb) => mb.name)
  .sort();
const derivedPush = members
  .filter((mb) => mb.body.includes('ipcRenderer.on('))
  .map((mb) => {
    const channelMatch = mb.body.match(/ipcRenderer\.on\(\s*['"]([^'"]+)['"]/);
    return { channel: channelMatch?.[1] ?? '(unparsed)', subscribe: mb.name };
  })
  .sort((a, b) => a.subscribe.localeCompare(b.subscribe));

describe('harness contract surface — derived from preload.ts (not self-referential)', () => {
  it('HARNESS_CONTRACT.ipc.sync matches the bridge methods that never touch ipcRenderer', () => {
    expect([...HARNESS_CONTRACT.ipc.sync].sort()).toEqual(derivedSync);
  });

  it('HARNESS_CONTRACT.ipc.send matches the bridge methods that call ipcRenderer.send', () => {
    expect([...HARNESS_CONTRACT.ipc.send].sort()).toEqual(derivedSend);
  });

  it('HARNESS_CONTRACT.ipc.invoke matches the bridge methods that call ipcRenderer.invoke', () => {
    // This is the drift this test exists to catch: restartUiServer is a real,
    // working bridge method (ipcRenderer.invoke('restart-ui-server')) with a
    // matching ipcMain.handle in main.ts, but HARNESS_CONTRACT.ipc.invoke had
    // never been updated to include it — the hand-maintained contract had
    // silently drifted from the real bridge surface.
    expect([...HARNESS_CONTRACT.ipc.invoke].sort()).toEqual(derivedInvoke);
  });

  it('HARNESS_CONTRACT.ipc.push matches the bridge methods that subscribe via ipcRenderer.on', () => {
    const contractPush = [...HARNESS_CONTRACT.ipc.push]
      .map((p) => ({ channel: p.channel, subscribe: p.subscribe }))
      .sort((a, b) => a.subscribe.localeCompare(b.subscribe));
    expect(contractPush).toEqual(derivedPush);
  });
});

describe('harness contract surface — main.ts registers a handler for every contract channel', () => {
  it('every ipcRenderer.invoke channel used by preload.ts has a matching ipcMain.handle in main.ts', () => {
    const invokeChannels = members
      .filter((mb) => mb.body.includes('ipcRenderer.invoke('))
      .map((mb) => mb.body.match(/ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/)?.[1])
      .filter((c): c is string => !!c);
    for (const channel of invokeChannels) {
      expect(mainSrc).toMatch(new RegExp(`ipcMain\\.handle\\(\\s*['"]${channel}['"]`));
    }
  });

  it('every ipcRenderer.send channel used by preload.ts has a matching ipcMain.on in main.ts', () => {
    const sendChannels = members
      .filter((mb) => mb.body.includes('ipcRenderer.send('))
      .map((mb) => mb.body.match(/ipcRenderer\.send\(\s*['"]([^'"]+)['"]/)?.[1])
      .filter((c): c is string => !!c);
    for (const channel of sendChannels) {
      expect(mainSrc).toMatch(new RegExp(`ipcMain\\.on\\(\\s*['"]${channel}['"]`));
    }
  });

  it('every push channel declared in HARNESS_CONTRACT is actually sent from main.ts', () => {
    for (const push of HARNESS_CONTRACT.ipc.push) {
      expect(mainSrc).toMatch(new RegExp(`send\\(\\s*['"]${push.channel}['"]`));
    }
  });
});
