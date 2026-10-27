// Background fan-out runner for /api/posts/bulk.
//
// Runs OUTSIDE the HTTP request so a dropped browser connection can no longer
// lose the work: the route returns a runId immediately and this keeps going on
// the server event loop, recording every result on the run (polled by the UI)
// and writing the usual job rows for history.
//
// Also fixes a real cross-talk bug: every account used to share ONE media row
// object and attemptPost mutates mediaKey on it, so parallel targets could
// stomp each other's media key (wrong video / Invalid Media). Each account now
// gets its own shallow copy.

import { attemptPost, type PostAttempt } from "./postOne";
import { addResult, finishRun, type RunState } from "./runs";

export type FanoutTarget = {
  id: string;
  handle: string;
  sessionJson: string;
  oauth1Json: string;
  adsAccountId: string;
  defaultUrl: string;
  defaultTitle: string;
  defaultCaption: string | null;
};

export type FanoutMedia = {
  id: string;
  mediaKey: string | null;
  url: string;
  name: string;
  accountId: string | null;
};

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export async function runFanout(
  run: RunState,
  targets: FanoutTarget[],
  media: FanoutMedia,
  caption: string,
  url: string,
  title: string,
  userId: string
): Promise<void> {
  try {
    for (const batch of chunk(targets, 3)) {
      const settled = await Promise.allSettled(
        batch.map((acct) =>
          attemptPost({ ...acct }, { ...media }, caption, url, title, userId, run.dry).catch(
            (e) =>
              ({
                accountId: acct.id,
                handle: acct.handle,
                status: "failed" as const,
                tweetUrl: null,
                error: String((e as Error)?.message ?? e).slice(0, 300),
              }) as PostAttempt
          )
        )
      );
      for (const s of settled) {
        if (s.status === "fulfilled") addResult(run, s.value);
        else
          addResult(run, {
            accountId: "",
            handle: "?",
            status: "failed",
            tweetUrl: null,
            error: String(s.reason).slice(0, 300),
          });
      }
    }
  } catch (e) {
    addResult(run, {
      accountId: "",
      handle: "?",
      status: "failed",
      tweetUrl: null,
      error: `fan-out crashed: ${String((e as Error)?.message ?? e).slice(0, 240)}`,
    });
  } finally {
    finishRun(run);
  }
}
