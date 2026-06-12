// Two prompts to the SAME session (guardian dedupes by sessionKey) to reproduce
// the "empty follow-up turn" — does a short reply after a question get an answer?
import { OcClient, asRaw, partSnapshotType, extractTextDelta, isTurnEnd, isSessionError } from '/app/portals/discord/src/runtime.ts';

const secret = Bun.env.OC_SECRET ?? "";
const userId = "discord:2turn-probe";
const sessionKey = `discord:thread:2turn-${Bun.env.OC_RUN ?? "x"}`;
const client = new OcClient({ channel: "discord", secret });

async function turn(label: string, prompt: string): Promise<void> {
  const ac = new AbortController();
  const events: unknown[] = [];
  const evp = (async () => { try { for await (const ev of client.events(userId, ac.signal)) events.push(ev); } catch {} })();
  await Bun.sleep(700);
  const session = await client.createSession(userId, sessionKey);
  await client.prompt(userId, session.id, prompt);
  let text = ""; let ended = false; const reasoning = new Set<string>();
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    while (events.length) {
      const e = asRaw(events.shift());
      const snap = partSnapshotType(e); if (snap && snap.type === "reasoning") reasoning.add(snap.partID);
      const d = extractTextDelta(e, session.id, reasoning); if (d) { text += d; continue; }
      if (isSessionError(e, session.id)) console.log(`[${label}] session.error`);
      if (isTurnEnd(e, session.id)) ended = true;
    }
    if (ended) break;
    await Bun.sleep(300);
  }
  ac.abort(); await Promise.race([evp, Bun.sleep(300)]);
  console.log(`[${label}] session=${session.id} textLen=${text.length} ended=${ended} sample="${text.slice(0,80)}"`);
}

await turn("TURN1", "What is 2+2? Answer in one short sentence.");
await Bun.sleep(2000);
await turn("TURN2-followup", "And what is 3+3?");
console.log("done");
