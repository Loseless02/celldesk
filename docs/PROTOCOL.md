# CellDesk protocol

Two transports carry the same thing: the exact bytes of a file from the phone,
plus a SHA-256 the PC checks before keeping it.

## Same Wi-Fi (direct)

The desktop app listens on port `47474`. The pairing QR code is
`http://<pc-lan-ip>:47474/?t=<token>`.

| Request | Purpose |
| --- | --- |
| `GET /api/hello?t=<token>` | `200 {ok, name, version}` or `401` when the token is wrong |
| `POST /api/upload` | Raw file body. Headers: `X-CellDesk-Token`, `X-File-Name` (URI-encoded), `X-File-Modified` (ms since epoch), `X-File-SHA256`, `Content-Type` |

Upload replies `200 {ok, name, size, sha256, verified}`, `401` (unpaired),
`422 hash_mismatch` or `5xx` (phone keeps the file queued and retries).

Dashboard endpoints under `/desk` and `/api/admin/*` only answer requests from
the same computer addressed to `localhost`, and writes require the
`X-CellDesk: 1` header, which blocks DNS-rebinding and cross-site requests.

## Anywhere (relay)

The relay is a Cloudflare Worker with one Durable Object per PC ("room").

```
phone ──HTTPS POST /u/<room>──▶ relay (Durable Object) ──WebSocket──▶ PC
      ◀──────── ack JSON ─────                        ◀──── ack ────
```

* The PC opens `wss://<relay>/pc/<room>?name=<pc-name>` with
  `Authorization: Bearer <pcKey>`. The first key to claim a room is stored as a
  SHA-256 hash; later connections must present the same key.
* The PC sends `ping` every 25 s; the relay auto-replies `pong` without waking.
* The pairing QR code is `https://<relay>/#r=<room>&k=<e2eKey>&n=<pc-name>`.
  The key lives in the URL fragment, which browsers never send to the server.

### Upload body

AES-256-GCM, key = base64url-decoded `e2eKey` (32 bytes).

```
body  = frame*
frame = u32be(L) | flags (1 byte) | iv (12 bytes) | ciphertext+tag (L-13 bytes)
AAD   = "CellDesk1" | u32be(frame index) | flags
```

* Frame 0 is JSON metadata: `{name, size, type, modified, sha256}`.
* Frames 1..n carry the file in 1 MiB pieces. The last frame has `flags & 1`.
  An empty file is a single empty final frame.
* The index and final flag are authenticated, so frames cannot be reordered,
  dropped or truncated without the PC noticing.

### Relay → PC stream

Per upload the relay sends text `{"t":"begin","id"}`, the body as binary
messages of up to 256 KiB, then `{"t":"end","id"}` (or `{"t":"abort","id"}`).
Uploads are serialised per room. The PC answers
`{"t":"ack","id","ok",...}`, which the relay returns to the phone:
`200` on success, `503` for retryable errors (`pc_offline`, `pc_disconnected`,
`timeout`), `422` otherwise.
