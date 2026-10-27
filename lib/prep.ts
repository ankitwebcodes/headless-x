// Prep registry for the composer's "card ready" chip.
//
// WHY: building a VIDEO_WEBSITE card used to be invisible work. The composer
// fired `prepareCard()` fire-and-forget and then polled a boolean for 180s. If
// the build actually FAILED (bad link, ads token problem, video download
// timeout) the poll just ran out and the chip said "card not ready yet — it
// will be built when you post", which told the user nothing and wasted 3
// minutes. Now the in-flight build is tracked with a real status + error, so
// the UI can show what is happening and stop early when it has failed.
//
// State is in-memory on purpose: it mirrors the in-process card build itself
// (see cardInflight in lib/postOne.ts) and is only ever used to drive a UI
// spinner. The durable truth is the `cards` table.

export type PrepStatus = "warming" | "ready" | "failed";

export type PrepState = {
  status: PrepStatus;
  error?: string;
  startedAt: number;
  updatedAt: number;
};

const PREP = new Map<string, PrepState>();

// A failure is remembered only briefly: long enough that the UI can show the
// reason instead of polling, short enough that "Retry" actually retries.
const FAILED_TTL_MS = 60_000;
// A build that has been "warming" longer than this is wedged; let it restart.
const WARMING_TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 200;

export function prepKey(mediaRef: string, url: string): string {
  return `${mediaRef}|${url}`;
}

export function getPrep(key: string): PrepState | undefined {
  const st = PREP.get(key);
  if (!st) return undefined;
  const age = Date.now() - st.updatedAt;
  if (st.status === "failed" && age > FAILED_TTL_MS) {
    PREP.delete(key);
    return undefined;
  }
  if (st.status === "warming" && age > WARMING_TTL_MS) {
    PREP.delete(key);
    return undefined;
  }
  return st;
}

export function markReady(key: string): PrepState {
  const st: PrepState = { status: "ready", startedAt: PREP.get(key)?.startedAt ?? Date.now(), updatedAt: Date.now() };
  PREP.set(key, st);
  prune();
  return st;
}

/**
 * Start (or join) a card build for `key`. Concurrent callers share one build.
 * Resolves with the card_uri or null; the registry is updated either way.
 */
export function startPrep(key: string, run: () => Promise<string | null>): PrepState {
  const existing = getPrep(key);
  if (existing && (existing.status === "warming" || existing.status === "ready")) return existing;

  const st: PrepState = { status: "warming", startedAt: Date.now(), updatedAt: Date.now() };
  PREP.set(key, st);
  prune();

  run()
    .then((cardUri) => {
      const cur = PREP.get(key);
      if (cur && cur.status === "warming") {
        if (cardUri) {
          cur.status = "ready";
          cur.error = undefined;
        } else {
          cur.status = "failed";
          cur.error = "card build failed — the video could not be turned into a card for that link (check the link, then retry)";
        }
        cur.updatedAt = Date.now();
      }
    })
    .catch((e) => {
      const cur = PREP.get(key);
      if (cur) {
        cur.status = "failed";
        cur.error = String((e as Error)?.message ?? e).slice(0, 240);
        cur.updatedAt = Date.now();
      }
    });

  return st;
}

function prune(): void {
  if (PREP.size <= MAX_ENTRIES) return;
  const entries = Array.from(PREP.entries()).sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  for (let i = 0; i < entries.length - MAX_ENTRIES; i++) PREP.delete(entries[i][0]);
}
