# FindForge Storage Worker — Usage Guide

A Cloudflare Worker providing per-user file storage via Backblaze B2.
Each user is isolated by their Clerk user ID — users cannot access each other's files.

---

## Base URL

| Environment | URL |
|---|---|
| Local development | `http://localhost:8787` |
| Production | `https://findforge-storage.<your-account>.workers.dev` |

Replace `<your-account>` with your Cloudflare account subdomain.

---

## Authentication

Every request **must** include a valid Clerk session token in the `Authorization` header:

```
Authorization: Bearer <clerk_session_token>
```

Obtain the token from your Clerk SDK (e.g., `clerk.session.getToken()` or equivalent for your framework).

**Requests without a valid token return `401 Unauthorized`.**

---

## Path Rules

- Paths should be URL-encoded by the client as needed
- The worker rejects `..` (traversal), `.`, and null bytes (`\0`) with `400 Bad Request`
- Leading slash is normalized; trailing slash treated as a path separator
- An empty path (`/`) lists the user's root directory
- There is no server-side path prefix — the worker automatically prepends the authenticated `userId`

**Examples of valid paths:**

| Client sends | Stored in B2 as |
|---|---|
| `/documents/report.pdf` | `{userId}/documents/report.pdf` |
| `/images/` | `{userId}/images/` |
| `/` (list root) | prefix `{userId}/` |

---

## API Reference

All examples use the Fetch API. Replace the base URL and token as needed.

### Upload a file

```javascript
const response = await fetch(`https://findforge-storage.<account>.workers.dev/documents/report.pdf`, {
  method: 'PUT',
  headers: {
    'Authorization': `Bearer ${clerkToken}`,
    'Content-Type': 'application/pdf',
  },
  body: fileBlob,
});

// response.status is 200 on success
// response.headers.get('ETag') has the MD5 hash
```

### Download a file

```javascript
const response = await fetch(`https://findforge-storage.<account>.workers.dev/documents/report.pdf`, {
  headers: { 'Authorization': `Bearer ${clerkToken}` },
});

if (response.ok) {
  const blob = await response.blob();
  // Or: const text = await response.text();
}
```

### Delete a file

```javascript
const response = await fetch(`https://findforge-storage.<account>.workers.dev/documents/report.pdf`, {
  method: 'DELETE',
  headers: { 'Authorization': `Bearer ${clerkToken}` },
});

// response.status is 204 on success
```

### Get file metadata

```javascript
const response = await fetch(`https://findforge-storage.<account>.workers.dev/documents/report.pdf`, {
  method: 'HEAD',
  headers: { 'Authorization': `Bearer ${clerkToken}` },
});

const etag = response.headers.get('ETag');
const contentLength = response.headers.get('Content-Length');
const contentType = response.headers.get('Content-Type');
const lastModified = response.headers.get('Last-Modified');
```

### List files

```javascript
const response = await fetch(`https://findforge-storage.<account>.workers.dev/?list-type=2`, {
  headers: { 'Authorization': `Bearer ${clerkToken}` },
});

const xml = await response.text();
```

The response is S3 ListObjectsV2 XML. The prefix is automatically scoped to the authenticated user. To list a subdirectory:

```javascript
const url = new URL(`https://findforge-storage.<account>.workers.dev/`);
url.searchParams.set('list-type', '2');
url.searchParams.set('prefix', 'documents/');
url.searchParams.set('delimiter', '/');

const response = await fetch(url.toString(), {
  headers: { 'Authorization': `Bearer ${clerkToken}` },
});
```

---

## Multipart Uploads (Large Files)

For files over ~100 MB, use the S3 multipart upload API:

1. **Initiate** — `POST /large-file.zip?uploads`
2. **Upload parts** — `PUT /large-file.zip?partNumber=1&uploadId=<id>` (repeat for each part)
3. **Complete** — `POST /large-file.zip?uploadId=<id>` with XML body listing parts
4. **Abort** (optional) — `DELETE /large-file.zip?uploadId=<id>`

All query parameters pass through to B2 unchanged.

---

## Rate Limits

Limits are enforced **per user** and stored in a Durable Object (SQLite-backed):

| Window | Max Requests | Max Transfer |
|---|---|---|
| Per minute | 100 | 100 MB |
| Per day | 10,000 | 10 GB |

When exceeded, the worker returns `429 Too Many Requests` with a `Retry-After` header indicating seconds until the window resets.

---

## Token Refresh

Clerk session tokens expire. When the worker returns a `401` with `error: "token_expired"`, the client should obtain a fresh token and retry:

```javascript
if (body.error === 'token_expired') {
  const newToken = await clerk.session.getToken({ skipCache: true });
  // Retry the request with the new token
}
```

Tokens with `error: "token_invalid"` or `error: "auth_failed"` indicate a different problem — the client should re-authenticate (e.g., redirect to login).

---

## Error Responses

All non-B2 errors return JSON with this structure:

```json
{
  "error": "error_code",
  "message": "Human-readable description"
}
```

| Status | `error` code | Meaning | Client Action |
|---|---|---|---|
| `400` | `invalid_path` | Path contains traversal, null bytes, or malformed encoding | Fix path construction |
| `401` | `token_expired` | Clerk token has expired | Fetch new token via `clerk.session.getToken({ skipCache: true })` and retry |
| `401` | `token_invalid` | Token is malformed or has invalid signature | Re-authenticate (redirect to login) |
| `401` | `token_not_active` | Token is not yet valid (clock skew) | Retry after a short delay |
| `401` | `auth_failed` | Missing Authorization header or general auth failure | Ensure token is included as `Authorization: Bearer <token>` |
| `429` | `rate_limit_exceeded` | Too many requests — check `Retry-After` header for seconds until reset | Wait and retry |
| `503` | `rate_limiter_unavailable` | Rate limiter temporarily unavailable | Retry with exponential backoff |
| `500` | `internal_error` | Unexpected server error | Retry, if persistent contact support |
| Others | — | Passed through from Backblaze B2 (e.g., `404` for missing file, `403` for bad credentials) | Check B2 documentation for the error code |

B2 error bodies are raw S3 XML and are not transformed — the caller should parse them as needed.

---

## Security Model

1. **Authentication** — Clerk verifies the session token, extracting the `userId`
2. **Path isolation** — Every B2 object key is prefixed with `{userId}/`
3. **Path sanitization** — Directory traversal (`..`, `.`) and null bytes are rejected
4. **No cross-user access** — User A can never construct a path that resolves to User B's files

---

## CORS

The worker handles CORS automatically. Browsers can call it directly without special configuration. Preflight `OPTIONS` requests return `204` with appropriate headers (`Access-Control-Allow-Origin: *`, allowed methods, exposed headers including `ETag`).
