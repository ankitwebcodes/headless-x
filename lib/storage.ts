import { put, get } from "@vercel/blob";
import { mkdir, writeFile, readFile } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";

// Media library storage:
// - Vercel: BLOB_READ_WRITE_TOKEN set -> upload to Vercel Blob
// - Local:  no token -> save under ./public/uploads (served by next dev)
export async function saveMedia(
  filename: string,
  buffer: Buffer,
  contentType: string
): Promise<{ url: string; sizeBytes: number }> {
  const clean = filename.replace(/[^\w.\-]+/g, "_");
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    const blob = await put(`media/${randomUUID()}-${clean}`, buffer, {
      contentType,
      access: "public",
    });
    return { url: blob.url, sizeBytes: buffer.length };
  }
  const dir = join(process.cwd(), "public", "uploads");
  await mkdir(dir, { recursive: true });
  const name = `${randomUUID()}-${clean}`;
  await writeFile(join(dir, name), buffer);
  return { url: `/uploads/${name}`, sizeBytes: buffer.length };
}

/**
 * Read the raw bytes of a stored media item, regardless of where it lives.
 *
 * This matters because the Vercel Blob store backing the panel is PRIVATE
 * (`*.private.blob.vercel-storage.com`) — a plain fetch() returns 403. The
 * blob SDK signs the request with BLOB_READ_WRITE_TOKEN, so `get()` works.
 *
 * Handles: local `/uploads/...`, private + public Vercel Blob, any http(s) URL.
 */
export async function readMediaBytes(url: string): Promise<Buffer> {
  const u = String(url ?? "").trim();
  if (!u) throw new Error("readMediaBytes: empty url");

  // Local file under ./public (dev / no-blob mode)
  if (u.startsWith("/")) {
    return readFile(join(process.cwd(), "public", u.replace(/^\/+/, "")));
  }

  // Vercel Blob — private store requires the signed SDK path.
  if (/\.blob\.vercel-storage\.com/i.test(u)) {
    const isPrivate = /\.private\.blob\.vercel-storage\.com/i.test(u);
    try {
      const r = await get(u, { access: isPrivate ? "private" : "public" });
      if (r && r.statusCode === 200 && r.stream) {
        return Buffer.from(await new Response(r.stream).arrayBuffer());
      }
    } catch {
      /* fall through to plain fetch */
    }
  }

  const res = await fetch(u);
  if (!res.ok) throw new Error(`media download failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
