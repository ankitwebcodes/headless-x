# Repost fix — Part 1 (2026-10-27)

## The symptom you reported
The `/dm` panel marked posts as reposted, but cross-checking on X showed
none of them were actually reposted.

## What was wrong in the code
The panel's "fresh repost" proof was weaker than it looked:

- `freshRepostProof()` in `lib/dm-core.ts` counted a repost as fresh if X
  said `retweeted: true` and a mutation id existed — it never checked that
  the retweet X was reporting **was the retweet this run just created**.
  An old manual repost, a stale read, or a reused id therefore counted
  as a fresh repost, and the panel linked a "fresh repost" id that did
  not match what X actually showed for that post.
- The resume path in `lib/dm-run.ts` had the same hole: if a saved proof
  existed and X still said `retweeted: true`, it continued straight to
  the DM without checking whether X's current retweet id still matched
  the proof's mutation id.
- The audit path (`Verify saved reposts`) merged a new read into an old
  proof while preserving the old mutation claim, so a stale proof could
  survive an audit and keep counting as fresh.
- Verification after a mutation was only 3 quick checks (300 ms apart)
  of that same boolean, and the retweet object itself was never fetched.

SUPERBOT X's ground truth is different: it works on the main tweet of
the post page, undoes a green (already-reposted) button and waits for
grey, reposts, and only calls it done when the button turns green on
that post. One bug in SUPERBOT was **not** copied: after 60 failed
checks it marked the repost "done" anyway. Here a timeout is
`uncertain`, never done, and the DM is blocked.

## What changed (only these files)
- `lib/dm-core.ts` — `freshRepostProof()` now requires
  `retweetId === mutationId`. Any proof without a matching retweet id
  (including every proof recorded before this fix) is unverified by
  definition, so it will be re-done, not trusted.
- `lib/xdm.ts` — new `verifyCreatedRepost()`: after a mutation it
  checks (1) the original post's viewer state points at **this**
  mutation id, and (2) the retweet object fetched by that mutation id
  exists, belongs to this account (when X exposes an author), points
  back at the original post (when X exposes a target), and is not older
  than this mutation (when X exposes a creation time). Any mismatch
  is `uncertain`, DM blocked, retryable — never a claimed repost.
  The create-verification now polls (500 ms, up to ~3 s) and requires
  **two consecutive** confirmations; the undo-verification polls up to
  ~3 s for the absent state. `repostTweet()` now takes the account's
  own user id (`selfId`) for the author check, passed from `dm-run.ts`.
- `lib/dm-run.ts` — passes `selfId` through, and on resume, if X's
  current retweet id differs from the saved proof's mutation id, the
  stale proof is dropped and the run falls through to a fresh
  undo + create instead of continuing to the DM.
- `tests/dm-automation.test.ts` — the mock X now returns a realistic
  `current_user_retweet` pointer and retweet objects, plus 4 new tests:
  different-retweet-id is not fresh, retweet-object-pointing-elsewhere
  is not fresh, audit downgrades a stale proof, and fresh proof
  requires `retweetId === mutationId`.

## What did NOT change in this part
- No link/post selection change, no DM text change, no cooldown,
  pacing, scan, or deploy change. Those are later parts if you want them.
- A repost X genuinely refuses (deleted / protected / not
  retweetable, empty 404) still follows the existing skip rule when
  "Require repost" is off — it is recorded as `repost skipped`, not
  as reposted. Turn "Require repost" on if you want those chats held
  instead of messaged.

## Tests (mocked X, no real account touched)
```
node --experimental-strip-types --test tests/dm-automation.test.ts
# before this fix: 66 pass
# after this fix:  70 pass, 0 fail (66 old + 4 new)
```

## How to re-test live (one chat first, not the whole fleet)
1. Deploy this copy (it is a full `x_panel` tree, not just the patch).
2. Pick ONE trader chat whose post you can check by hand. Start only
   that chat.
3. If the panel says "Reposted now", check all three on X, not just one:
   - the post page shows the repost button green for that account,
   - the panel's "View fresh repost" link opens a retweet by that
     account of that exact post,
   - that retweet id matches the panel's mutation id.
4. If any of the three does not match, the run must now show
   `uncertain` / "Verify repost", send no DM for that chat, and keep
   the chat retryable — that is the fix working, not a new bug.
   Send me the panel row (post id, mutation id, error text) and I will
   trace that exact case as Part 2.
5. Only after that one chat passes all three checks should you run a
   wider batch. Old "completed" rows from before this fix will not be
   trusted: their proofs have no matching retweet id, so those posts
   will be re-done on the next run for their chats.

## Part 2 (2026-10-29) — live test: 10 chats, DMs sent without reposts

Live test on @DeepRelent7549: the panel marked 10 chats completed, but
6 posts were not actually reposted, and the custom DM was still sent
to those users. Posts reported, 2026-10-29:
geoffrey395/1937422888317125123, maria01mz4/2115123255413796984,
VirtualBF_AI/2114016042444026022, VirtualBF_AI/2114719399412376022,
Ethanspagevip/2115127401424248888, gold_reno/2115233047931171132.

Root cause, found in code, not in Part 1 verification: this was the
panel's intentional skip behaviour, encoded in its own tests
("ten chats drain independently: four rejected reposts still deliver
their replies while six repost and reply"). By default "Require
repost" was off, so if X rejected a retweet (unavailable, deleted,
protected, not retweetable, permanent error), the run skipped that
repost, recorded it as skipped, and still sent the DM, ending in
"sent". That directly breaks the user's rule: not a single post
misses, repost first.

What changed in Part 2:
- lib/dm-policy.ts — repost is now always required (default true,
  normalisation forces true). No saved setting can re-enable skipping.
- lib/dm-run.ts — the skip path is removed. A rejected, unavailable
  or permanent repost failure now fails the item (retry_wait for
  post_rejected, failed for unavailable) and the DM is blocked.
  fail() no longer turns a repost-step "unavailable" outcome into
  "skipped". Run creation always sets repostRequired: true.
- app/dm/page.tsx — the "Require repost" checkbox is now a fixed,
  checked, disabled note: "Repost required - the DM is blocked if
  X won't allow a repost".
- tests/dm-automation.test.ts — the 4 tests that encoded the old
  skip-and-send behaviour are rewritten to the new behaviour:
  rejected repost blocks the reply, unavailable post blocks the
  reply, ten chats: six sent and four blocked, rejected repost never
  sends on a later pass. Suite: 70/70 pass.
