// Browser-side Direct-to-Blob upload (no SDK imports — raw wire protocol against
// https://blob.vercel-storage.com, API version 9).
//
// Flow (matches @vercel/blob/client's upload(), reimplemented so the app bundle
// stays free of Node polyfills):
//   1. POST /api/media/upload { type: "blob.generate-client-token", payload }
//      -> { clientToken } (server HMACs its BLOB_READ_WRITE_TOKEN)
//   2. Simple PUT (<= SIMPLE_PUT_MAX) or multipart upload straight to Blob.
//   3. Caller registers the result via POST /api/media/register.

const BLOB_API = "https://blob.vercel-storage.com";
const API_VERSION = "9";
// Vercel's simple-put path is documented to accept up to 32MB; anything larger
// must go through multipart. Matches the SDK's client threshold.
const SIMPLE_PUT_MAX = 32 * 1024 * 1024;
const PART_SIZE = 32 * 1024 * 1024;

const enc = encodeURIComponent;

export type BlobUploadResult = {
  url: string;
  downloadUrl?: string;
  pathname: string;
  contentType: string;
};

async function handleUrl(): Promise<string> {
  return `${location.origin}/api/media/upload`;
}

async function getClientToken(
  pathname: string,
  multipart: boolean,
): Promise<string> {
  const res = await fetch(await handleUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "blob.generate-client-token",
      payload: {
        pathname,
        callbackUrl: await handleUrl(),
        clientPayload: null,
        multipart,
      },
    }),
  });
  const json = (await res.json().catch(() => null)) as {
    clientToken?: string;
    error?: string;
  } | null;
  if (!res.ok || !json?.clientToken) {
    throw new Error(json?.error || `token request failed (${res.status})`);
  }
  return json.clientToken;
}

async function simplePut(
  token: string,
  pathname: string,
  contentType: string,
  file: File,
): Promise<BlobUploadResult> {
  const res = await fetch(`${BLOB_API}/?pathname=${enc(pathname)}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "x-api-version": API_VERSION,
      "x-vercel-blob-access": "private",
      "x-content-type": contentType,
    },
    body: file,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.url) {
    throw new Error(json?.error?.message || `blob PUT failed (${res.status})`);
  }
  return json as BlobUploadResult;
}

async function multipartPut(
  token: string,
  pathname: string,
  contentType: string,
  file: File,
): Promise<BlobUploadResult> {
  const headers = (extra: Record<string, string>) => ({
    Authorization: `Bearer ${token}`,
    "x-api-version": API_VERSION,
    "x-vercel-blob-access": "private",
    "x-content-type": contentType,
    ...extra,
  });

  const createRes = await fetch(
    `${BLOB_API}/mpu?pathname=${enc(pathname)}`,
    { method: "POST", headers: headers({ "x-mpu-action": "create" }) },
  );
  const created = await createRes.json().catch(() => null);
  if (!createRes.ok || !created?.uploadId || !created?.key) {
    throw new Error(
      created?.error?.message || `multipart create failed (${createRes.status})`,
    );
  }

  const parts: { etag: string; partNumber: number }[] = [];
  const totalParts = Math.ceil(file.size / PART_SIZE);
  for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
    const start = (partNumber - 1) * PART_SIZE;
    const blobPart = file.slice(start, Math.min(start + PART_SIZE, file.size));
    const partRes = await fetch(`${BLOB_API}/mpu?pathname=${enc(pathname)}`, {
      method: "POST",
      headers: headers({
        "x-mpu-action": "upload",
        "x-mpu-key": enc(created.key),
        "x-mpu-upload-id": created.uploadId,
        "x-mpu-part-number": String(partNumber),
        "x-mpu-part-size": String(blobPart.size),
      }),
      body: blobPart,
    });
    const part = await partRes.json().catch(() => null);
    if (!partRes.ok || !part?.etag) {
      throw new Error(
        part?.error?.message || `part ${partNumber} failed (${partRes.status})`,
      );
    }
    parts.push({ etag: part.etag, partNumber });
  }

  const completeRes = await fetch(
    `${BLOB_API}/mpu?pathname=${enc(pathname)}`,
    {
      method: "POST",
      headers: headers({
        "x-mpu-action": "complete",
        "x-mpu-key": enc(created.key),
        "x-mpu-upload-id": created.uploadId,
      }),
      body: JSON.stringify({ parts }),
    },
  );
  const done = await completeRes.json().catch(() => null);
  if (!completeRes.ok || !done?.url) {
    throw new Error(
      done?.error?.message || `multipart complete failed (${completeRes.status})`,
    );
  }
  return done as BlobUploadResult;
}

/** Upload a File straight into Vercel Blob. Returns the blob URL. */
export async function uploadToBlob(file: File): Promise<BlobUploadResult> {
  // Same pathname scheme as the server route used to build: uploads/<ts>-<name>
  // Server adds the random suffix itself (addRandomSuffix: true in the token).
  const clean = file.name.replace(/[^\w.\- ]+/g, "_");
  const pathname = `uploads/${Date.now()}-${clean}`;
  const contentType = file.type || "application/octet-stream";
  const token = await getClientToken(pathname, file.size > SIMPLE_PUT_MAX);
  return file.size > SIMPLE_PUT_MAX
    ? multipartPut(token, pathname, contentType, file)
    : simplePut(token, pathname, contentType, file);
}
