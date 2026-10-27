import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, readdir,stat,unlink } from "node:fs/promises";
import { join } from "node:path";

export type DmSession = {
  id: string; label: string; xUserId: string; handle: string;
  sessionJson: unknown; passcode?: string; createdAt: number; updatedAt: number;
};
type StoredSession = Omit<DmSession, "sessionJson" | "passcode"> & { secret: string };
type Accounts = { sessions: StoredSession[] };
// Local development only. backups/ is already ignored by this repository.
const localDir = process.env.DM_STATE_DIR || join(process.cwd(), "backups", "dm-state");
const hasDb = () => !!(process.env.DATABASE_URL || process.env.POSTGRES_URL);
let init: Promise<void> | undefined;
async function pg() {
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon((process.env.DATABASE_URL ?? process.env.POSTGRES_URL)!);
  if (!init) init = sql`CREATE TABLE IF NOT EXISTS dm_documents (
    owner_id TEXT NOT NULL, doc_key TEXT NOT NULL, payload JSONB NOT NULL,
    version BIGINT NOT NULL DEFAULT 0, updated_at BIGINT NOT NULL,
    PRIMARY KEY(owner_id, doc_key)
  )`.then(() => undefined).catch(e => { init = undefined; throw e; });
  await init;
  return sql;
}
const fileFor = (owner: string, key: string) => join(localDir, createHash("sha256").update(`${owner}\0${key}`).digest("hex") + ".json");
type Envelope<T> = { owner: string; key: string; version: number; payload: T; updatedAt?: number };

/** Serialise every access to one state file *within this process*. A read that
 *  overlaps the write+rename leaves an open handle on the destination, which on
 *  Windows makes rename() fail with EPERM and silently loses the whole write. */
const localQueues = new Map<string, Promise<unknown>>();
function withFileLock<T>(filename: string, fn: () => Promise<T>): Promise<T> {
  const prev = localQueues.get(filename) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const wrapped = run.then(
    v => { if (localQueues.get(filename) === wrapped) localQueues.delete(filename); return v; },
    e => { if (localQueues.get(filename) === wrapped) localQueues.delete(filename); throw e; },
  );
  localQueues.set(filename, wrapped);
  return wrapped;
}
/** Unlocked local read. Only safe from inside withFileLock() for the same file. */
async function readLocalEnvelope<T>(owner: string, key: string): Promise<Envelope<T> | null> {
  try { return JSON.parse(await readFile(fileFor(owner, key), "utf8")); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}
/** Windows also raises EPERM/EACCES/EBUSY when *another process* (the worker and
 *  the panel both write this store) still holds the destination open. Those are
 *  transient, so retry briefly rather than losing the write. */
const RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rename(from, to); return; }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (!RENAME_RETRY_CODES.has(code) || attempt >= 11) throw e;
      await new Promise(r => setTimeout(r, 5 * (attempt + 1)));
    }
  }
}

async function readEnvelope<T>(owner: string, key: string): Promise<Envelope<T> | null> {
  if (hasDb()) {
    const sql = await pg();
    const rows = await sql`SELECT payload, version FROM dm_documents WHERE owner_id=${owner} AND doc_key=${key}`;
    return rows[0] ? { owner, key, payload: rows[0].payload as T, version: Number(rows[0].version) } : null;
  }
  if (process.env.NODE_ENV === "production") throw new Error("DATABASE_URL is required for durable DM automation in production.");
  return readLocalEnvelope<T>(owner, key);
}
export async function readDmDoc<T>(owner: string, key: string): Promise<T | null> {
  return (await readEnvelope<T>(owner, key))?.payload ?? null;
}
export async function listDmDocs<T>(owner: string, prefix: string): Promise<T[]> {
  if (hasDb()) {
    const sql = await pg();
    const rows = await sql`SELECT payload FROM dm_documents WHERE owner_id=${owner} AND left(doc_key,length(${prefix}))=${prefix}`;
    return rows.map(r => r.payload as T);
  }
  if (process.env.NODE_ENV === "production") throw new Error("DATABASE_URL is required for durable DM automation in production.");
  let files: string[];
  try { files = await readdir(localDir); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
  const rows: T[] = [];
  for (const file of files.filter(f => f.endsWith(".json"))) {
    const row: Envelope<T> = JSON.parse(await readFile(join(localDir, file), "utf8"));
    if (row.owner === owner && row.key.startsWith(prefix)) rows.push(row.payload);
  }
  return rows;
}
// The change callback is synchronous and may be retried. Never do HTTP in it.
export async function updateDmDoc<T>(owner: string, key: string, initial: () => T, change: (value: T) => T): Promise<T> {
  if (!hasDb()) {
    const filename = fileFor(owner, key);
    return withFileLock(filename, async () => {
      const prev = await readLocalEnvelope<T>(owner, key);
      const payload = change(prev?.payload ?? initial());
      await mkdir(localDir, { recursive: true });
      const tmp = filename + "." + randomUUID() + ".tmp";
      await writeFile(tmp, JSON.stringify({ owner, key, version: (prev?.version ?? 0) + 1, payload,updatedAt: Date.now() }), { mode: 0o600 });
      await renameWithRetry(tmp, filename);
      return payload;
    });
  }
  const sql = await pg();
  for (let attempt = 0; attempt < 20; attempt++) {
    const prev = await readEnvelope<T>(owner, key);
    const value = change(prev?.payload ?? initial());
    const payload = JSON.stringify(value);
    const rows = prev
      ? await sql`UPDATE dm_documents SET payload=${payload}::jsonb, version=version+1, updated_at=${Date.now()}
          WHERE owner_id=${owner} AND doc_key=${key} AND version=${prev.version} RETURNING version`
      : await sql`INSERT INTO dm_documents(owner_id,doc_key,payload,updated_at) VALUES(${owner},${key},${payload}::jsonb,${Date.now()})
          ON CONFLICT DO NOTHING RETURNING version`;
    if (rows.length) return value;
  }
  throw new Error("DM state is busy. Retry shortly.");
}
function encryptionKey() {
  const secret = process.env.DM_ENCRYPTION_KEY || process.env.AUTH_SECRET;
  if (!secret && process.env.NODE_ENV === "production") throw new Error("Set DM_ENCRYPTION_KEY or AUTH_SECRET before storing DM cookies.");
  return createHash("sha256").update(secret || "dm-local-development-only").digest();
}
function seal(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}
function unseal(value: string): { sessionJson: unknown; passcode?: string } {
  const bytes = Buffer.from(value, "base64");
  const cipher = createDecipheriv("aes-256-gcm", encryptionKey(), bytes.subarray(0, 12));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8"));
}
export async function listSessions(owner: string): Promise<DmSession[]> {
  const data = await readDmDoc<Accounts>(owner, "accounts");
  return (data?.sessions ?? []).map(({ secret, ...row }) => ({ ...row, ...unseal(secret) }));
}
export async function getSession(owner: string, id: string) {
  return (await listSessions(owner)).find(s => s.id === id) ?? null;
}
export async function saveSession(owner: string, input: Omit<DmSession, "createdAt" | "updatedAt">): Promise<DmSession> {
  const data = await updateDmDoc<Accounts>(owner, "accounts", () => ({ sessions: [] }), data => {
    const existing = data.sessions.find(s => s.id === input.id);
    if (existing && existing.xUserId !== input.xUserId) throw new Error("These cookies belong to a different X account. Use Add account.");
    const prev = existing ?? data.sessions.find(s => s.xUserId === input.xUserId);
    if (!prev && data.sessions.length >= 12) throw new Error("Maximum 12 X accounts per login.");
    const passcode = input.passcode === undefined && prev ? unseal(prev.secret).passcode : input.passcode || undefined;
    const { sessionJson, passcode: _pc, ...publicFields } = input;
    const row: StoredSession = { ...publicFields, id: prev?.id ?? input.id,
      createdAt: prev?.createdAt ?? Date.now(), updatedAt: Date.now(), secret: seal({ sessionJson, passcode }) };
    return { sessions: [...data.sessions.filter(s => s.id !== row.id), row] };
  });
  const { secret, ...row } = data.sessions.find(s => s.xUserId === input.xUserId)!;
  return { ...row, ...unseal(secret) };
}
export async function deleteSession(owner: string, id: string) {
  await updateDmDoc<Accounts>(owner, "accounts", () => ({ sessions: [] }), data => ({ sessions: data.sessions.filter(s => s.id !== id) }));
}
export async function updateSessionSettings(owner: string, id: string, label?: string, passcode?: string) {
  await updateDmDoc<Accounts>(owner,"accounts",() => ({ sessions: [] }),data => {
    if (!data.sessions.some(s => s.id === id)) throw new Error("Account not found");
    return { sessions: data.sessions.map(row => {
      if (row.id !== id) return row;
      const secrets = unseal(row.secret);
      if (passcode !== undefined) secrets.passcode = passcode || undefined;
      return { ...row,label: label ?? row.label,secret: seal(secrets),updatedAt: Date.now() };
    }) };
  });
  return getSession(owner,id);
}
// Explicit admin migration; never expose old global cookies to arbitrary logins.
export async function legacySessions(): Promise<Array<{ id: string; label: string; sessionJson: unknown; passcode?: string }>> {
  if (hasDb()) {
    const sql = await pg();
    const exists = await sql`SELECT to_regclass('public.dm_sessions') AS name`;
    if (!exists[0]?.name) return [];
    const rows = await sql`SELECT id,label,session_json,passcode FROM dm_sessions`;
    return rows.map(r => ({ id: r.id, label: r.label, sessionJson: JSON.parse(r.session_json), passcode: r.passcode ?? undefined }));
  }
  try { return JSON.parse(await readFile(join(process.cwd(), ".dm-sessions.json"), "utf8")); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
}
export type DmLease = { token: string; until: number; cooldownUntil: number };
export async function acquireAccount(owner: string, id: string, options:{ignoreCooldown?:boolean}={}) {
  const token = randomUUID();
  return updateDmDoc<DmLease>(owner, `lease:${id}`, () => ({ token: "", until: 0, cooldownUntil: 0 }), old => {
    if (old.until > Date.now()) throw new Error("Account is already scanning or running.");
    if (!options.ignoreCooldown&&old.cooldownUntil > Date.now()) throw new Error(`Account cooling down until ${new Date(old.cooldownUntil).toISOString()}`);
    return { ...old, token, until: Date.now() + 70_000 };
  });
}
export async function releaseAccount(owner: string, id: string, token: string, cooldownUntil = 0) {
  await updateDmDoc<DmLease>(owner, `lease:${id}`, () => ({ token: "", until: 0, cooldownUntil: 0 }), old =>
    old.token === token ? { token: "", until: 0, cooldownUntil: Math.max(old.cooldownUntil, cooldownUntil) } : old);
}
export async function runnableDmRuns(): Promise<Array<{ owner: string; key: string }>> {
  if (hasDb()) {
    const sql = await pg();
    const rows = await sql`SELECT owner_id,doc_key FROM dm_documents WHERE doc_key LIKE 'run:%'
      AND (payload->>'status' IN ('running','waiting')
        OR (payload->>'status'='needs_attention' AND COALESCE((payload->'attention'->>'recoverAt')::bigint,0) BETWEEN 1 AND ${Date.now()})
        -- Runs parked by an older build carry no recoverAt at all, so the deadline clause
        -- above can never match them. Hand those to processDmRun once so it can assign a
        -- deadline (or park them for good). A park with a future deadline still waits.
        OR (payload->>'status'='needs_attention'
          AND COALESCE((payload->'attention'->>'retries')::int,0) < 3
          AND COALESCE((payload->'attention'->>'recoverAt')::bigint,0) = 0))
      AND COALESCE((payload->>'nextAt')::bigint,0) <= ${Date.now()} ORDER BY updated_at ASC LIMIT 12`;
    return rows.map(r => ({ owner: r.owner_id, key: r.doc_key }));
  }
  let files: string[];
  try { files = await readdir(localDir); } catch { return []; }
  const found: Array<{ owner: string; key: string }> = [];
  for (const file of files.filter(f => f.endsWith(".json"))) {
    const row = JSON.parse(await readFile(join(localDir, file), "utf8"));
    const p = row.payload ?? {};
    const live = ["running","waiting"].includes(p.status);
    const attention = p.attention ?? {};
    const deadline = attention.recoverAt ?? 0;
    const healing = p.status === "needs_attention" && (deadline > 0 && deadline <= Date.now()
      || deadline === 0 && (attention.retries ?? 0) < 3);
    if (row.key.startsWith("run:") && (live || healing) && (p.nextAt ?? 0) <= Date.now()) found.push({ owner: row.owner, key: row.key });
  }
  return found.slice(0, 12);
}
export type DmRunHead = { accountId: string; id: string; status: string; nextAt: number;attention?:{kind?:string;code?:number;error:string;at:number} };
export async function dmRunHeads(owner: string): Promise<DmRunHead[]> {
  if (hasDb()) {
    const sql = await pg();
    const rows = await sql`SELECT r.payload->>'accountId' AS account_id,r.payload->>'id' AS id,
      r.payload->>'status' AS status,COALESCE((r.payload->>'nextAt')::bigint,0) AS next_at,r.payload->'attention' AS attention
      FROM dm_documents r JOIN dm_documents latest ON latest.owner_id=r.owner_id
      AND latest.doc_key='latest:'||(r.payload->>'accountId') AND latest.payload->>'id'=r.payload->>'id'
      WHERE r.owner_id=${owner} AND r.doc_key LIKE 'run:%'`;
    return rows.map(r => ({ accountId: r.account_id,id: r.id,status: r.status,nextAt: Number(r.next_at),attention:r.attention??undefined }));
  }
  const latest = await listDmDocs<{ id: string }>(owner,"latest:");
  const runs = await Promise.all(latest.map(p => readDmDoc<DmRunHead>(owner,`run:${p.id}`)));
  return runs.filter((r): r is DmRunHead => !!r).map(({accountId,id,status,nextAt,attention}) => ({accountId,id,status,nextAt,attention}));
}
export type DmRecord = { key: string; payload: any; version: number; updatedAt: number };
export async function listDmRecords(owner: string): Promise<DmRecord[]> {
  if (hasDb()) {
    const sql = await pg();
    const rows = await sql`SELECT doc_key,payload,version,updated_at FROM dm_documents WHERE owner_id=${owner}`;
    return rows.map(r => ({key:r.doc_key,payload:r.payload,version:Number(r.version),updatedAt:Number(r.updated_at)}));
  }
  if (process.env.NODE_ENV === "production") throw new Error("DATABASE_URL is required for durable DM automation in production.");
  const files = await readdir(localDir).catch((e:NodeJS.ErrnoException) => { if(e.code === "ENOENT") return []; throw e; });
  const records:DmRecord[]=[];
  for (const file of files.filter(f => /^[a-f0-9]{64}\.json$/.test(f))) {
    const path=join(localDir,file),row:Envelope<any>=JSON.parse(await readFile(path,"utf8"));
    if(row.owner===owner) records.push({key:row.key,payload:row.payload,version:row.version,updatedAt:row.updatedAt??(await stat(path)).mtimeMs});
  }
  return records;
}
// Call only while holding the affected accounts' leases. Changed rows survive.
export async function deleteDmRecords(owner:string,records:Array<Pick<DmRecord,"key"|"version">>) {
  if(!records.length)return 0;
  if(hasDb()) {
    const sql=await pg();
    const selected=JSON.stringify(records.map(({key,version})=>({key,version})));
    const rows=await sql`DELETE FROM dm_documents d USING jsonb_to_recordset(${selected}::jsonb) AS chosen(key text,version bigint)
      WHERE d.owner_id=${owner} AND d.doc_key=chosen.key AND d.version=chosen.version RETURNING d.doc_key`;
    return rows.length;
  }
  if(process.env.NODE_ENV==="production")throw new Error("DATABASE_URL is required for durable DM automation in production.");
  let removed=0;
  for(const record of records) {
    const filename=fileFor(owner,record.key);
    const task=(localQueues.get(filename)??Promise.resolve()).catch(()=>{}).then(async()=>{
      const current=await readEnvelope(owner,record.key);
      if(current?.version===record.version){await unlink(filename);removed++}
    });
    localQueues.set(filename,task);
    try{await task}finally{if(localQueues.get(filename)===task)localQueues.delete(filename)}
  }
  return removed;
}
