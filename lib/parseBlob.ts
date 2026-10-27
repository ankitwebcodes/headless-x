// Shared blob/cookie/OAuth1 parsers — used by both the accounts connect route
// and the per-account update route so the admin can paste the same blob anywhere.

export function tolerantParse(raw: unknown): { value?: unknown; error?: string } {
  if (raw == null) return { error: "field is empty" } as const;
  if (typeof raw !== "string") return { value: raw };
  let s = raw.trim();
  if (!s) return { error: "field is empty" } as const;
  for (let i = 0; i < 4; i++) {
    try {
      const v = JSON.parse(s);
      if (typeof v === "string" && (v.trim().startsWith("{") || v.trim().startsWith("["))) { s = v.trim(); continue; }
      return { value: v };
    } catch { break; }
  }
  const cleaned = s
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, `$1"$2"$3`)
    .replace(/'/g, '"');
  try { return { value: JSON.parse(cleaned) }; } catch (e: any) { return { error: e?.message ?? String(e) }; }
}

export function parseCookiesField(raw: unknown): { value?: unknown; error?: string } {
  if (typeof raw === "string") {
    const s = raw.trim();
    if (s && !s.startsWith("{") && !s.startsWith("[")) {
      if (s.includes("=") && s.includes(";")) {
        const arr = s.split(";").map((p) => {
          const eq = p.indexOf("=");
          if (eq <= 0) return null;
          return { name: p.slice(0, eq).trim(), value: p.slice(eq + 1).trim(), domain: ".x.com", path: "/", secure: true, httpOnly: false };
        }).filter(Boolean);
        if (arr.length) return { value: arr };
      }
      const lines = s.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
      if (lines.length && lines.every((l) => l.split("\t").length >= 7)) {
        return {
          value: lines.map((l) => {
            const [domain, , path, secure, expiration, name, ...v] = l.split("\t") as string[];
            return { domain, path, secure: secure === "TRUE", httpOnly: false, name, value: v.join("\t"), expirationDate: Number(expiration) || undefined };
          }),
        };
      }
    }
  }
  return tolerantParse(raw);
}

export function normalizeOauth(raw: unknown): { value?: unknown; error?: string } {
  if (typeof raw === "string") {
    const s = raw.trim();
    if (s && !s.startsWith("{") && !s.startsWith("[")) {
      const out: Record<string, string> = {};
      for (const pair of s.split(/[;&,*\n]/)) {
        const eq = pair.indexOf("=");
        if (eq <= 0) continue;
        out[pair.slice(0, eq).trim().toLowerCase()] = pair.slice(eq + 1).trim();
      }
      if (Object.keys(out).length) {
        return {
          value: {
            consumer_key: out.consumer_key || out.apikey || out["api-key"] || "",
            consumer_secret: out.consumer_secret || out.apikeysecret || out["api-key-secret"] || "",
            access_token: out.access_token || out.accesstoken || "",
            access_token_secret: out.access_token_secret || out.accesstokensecret || "",
          },
        };
      }
    }
  }
  const t = tolerantParse(raw);
  if (t.error) return t;
  let v = t.value as unknown;
  if (typeof v === "object" && v !== null && !Array.isArray(v)) {
    const o = v as Record<string, any>;
    const pick = (...ks: string[]) => {
      for (const k of ks) if (o[k] !== undefined && o[k] !== null && o[k] !== "") return String(o[k]);
      return "";
    };
    v = {
      consumer_key: pick("consumer_key", "consumerKey", "api_key", "apiKey"),
      consumer_secret: pick("consumer_secret", "consumerSecret", "api_key_secret", "apiKeySecret"),
      access_token: pick("access_token", "accessToken"),
      access_token_secret: pick("access_token_secret", "accessTokenSecret"),
    };
  }
  return { value: v };
}

export function parseXGrabBlob(raw: unknown): {
  handle?: string;
  cookies?: unknown;
  oauth1?: unknown;
  error?: string;
} {
  const t = typeof raw === "string" ? tolerantParse(raw) : { value: raw };
  if (t.error) return { error: `blob ❌ ${t.error}` };
  const v = t.value;
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    return { error: "blob ❌ paste the full X Grabber JSON (the text the extension copied)" };
  }
  const o = v as Record<string, any>;

  const inner = o.blob || o.data || o.account;
  const src = inner && typeof inner === "object" ? (inner as Record<string, any>) : o;

  let handle = typeof src.handle === "string" ? src.handle : typeof src.username === "string" ? src.username : "";
  handle = handle.replace(/^@/, "").trim();

  let cookies: unknown = null;
  if (src.cookies && typeof src.cookies === "object") cookies = src.cookies;
  else if (src.sessionJson) cookies = src.sessionJson;
  else if (src.session) cookies = src.session;

  if (!cookies) return { error: "blob ❌ no cookies found in the pasted JSON" };

  if (!Array.isArray(cookies)) {
    const cm = cookies as Record<string, unknown>;
    cookies = Object.entries(cm).map(([name, value]) => ({
      name,
      value: String(value),
      domain: ".x.com",
      path: "/",
      secure: true,
      httpOnly: name === "auth_token" || name === "ct0" || name === "kdt",
    }));
  }

  const oauth1 = src.oauth1 ?? src.oauth1Json ?? null;
  return { handle, cookies, oauth1: oauth1 ?? undefined };
}