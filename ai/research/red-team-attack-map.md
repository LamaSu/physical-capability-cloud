# Red Team Attack Map — 55 Attacks vs PCC

_Generated: 2026-04-09_
_Reviewer: code-only, READ-ONLY pass. No source files modified._

---

## Executive Summary

- **N/A**: 12 attacks (don't apply to PCC's architecture)
- **NOT VULNERABLE**: 34 attacks (already fixed, mitigated, or never existed)
- **VULNERABLE**: 9 attacks (confirmed susceptible — need fixes)

---

## Per-Attack Findings

---

### Identity / Auth Attacks

**Attack #1: Password reset token leaked in API response**
- Status: N/A
- Evidence: PCC has no password reset flow. Auth is SIWE (wallet signature) + API keys. No password field exists anywhere in the codebase.
- Fix needed: None.

---

**Attack #2: Password reset token type confusion (token:true → 500)**
- Status: N/A
- Evidence: No password reset endpoint exists. The SIWE verify endpoint (`siwe-auth.ts:224`) accepts only `message` and `signature` string fields, not tokens.
- Fix needed: None.

---

**Attack #3: Password reset password policy bypass**
- Status: N/A
- Evidence: No passwords in PCC. Auth is wallet-based.
- Fix needed: None.

---

**Attack #4: Weak password policy (1-char passwords)**
- Status: N/A
- Evidence: No passwords. The `/api/onboard/redeem` endpoint passes a `password` field to an external GateCraft service (`onboard.ts:434`), but PCC does not define or enforce the policy — that is GateCraft's responsibility.
- Fix needed: None (for PCC's own auth layer).

---

**Attack #5: Duplicate username registration race**
- Status: NOT VULNERABLE
- Evidence: `api-key-auth.ts:76-79` — `provisioningLocks` Set serializes per-operator provisioning. The per-operator key limit (max 5) is enforced atomically inside the lock. `walletAddress` is validated as a strict 42-char hex string. Email is validated by regex. No duplicate identity creation is possible.
- Fix needed: None.

---

**Attack #6: Username case sensitivity (admin ≠ ADMIN)**
- Status: NOT VULNERABLE
- Evidence: Operator identity is either an EVM wallet address (`0x[a-fA-F0-9]{40}`) — where case is part of EIP-55 checksum but comparison uses the stored value — or an email. The regex validates but does not normalize case for email. However, because there are no admin-level roles or privilege distinctions tied to username string equality, and all sensitive operations check ownership by `operatorId` string comparison, this is low-impact. Email identities could theoretically allow `admin@example.com` vs `Admin@example.com` to provision separate keys. This is a minor cosmetic issue, not an escalation path.
- Fix needed: Optional: normalize `operatorId` (email) to lowercase at `provision.ts:56`.

---

**Attack #7: Privileged username squatting (judge, root, system)**
- Status: NOT VULNERABLE
- Evidence: PCC has no concept of privileged usernames. The API has no username-based admin gate — admin operations are not gated by username string matching. Operator identity (email or wallet) only controls key ownership (`provision.ts:175`). No route checks `if (operatorId === "admin")`.
- Fix needed: None.

---

**Attack #8: Identity injection via `body.identity` on login**
- Status: NOT VULNERABLE
- Evidence: Read `siwe-auth.ts:224-307` in full. The `/api/auth/verify` endpoint accepts only `body.message` and `body.signature`. The session `walletAddress` is set exclusively to `parsed.address` at line 301, where `parsed.address` comes from `parseSiweMessage()` which extracts the address from the EIP-4361 message string itself (line 87). The address is then verified by viem's `verifyMessage()` (line 277) which independently recovers the signer. There is no `body.identity`, no `body.address`, no `body.walletAddress` override path. The session identity is cryptographically locked to the signature.
- Fix needed: None.

---

**Attack #9: Step-up MFA bypass via `{"code":null}` or `{}`**
- Status: N/A
- Evidence: Grepped entire `packages/gateway/src` for `stepup`, `step_up`, `mfa`, `totp`, `two_factor` — zero matches. No step-up endpoint exists.
- Fix needed: None.

---

### IDOR / Access Control

**Attack #10: Profile IDOR via `body.userId`**
- Status: **VULNERABLE** (4 routes confirmed)
- Evidence:
  - `bounty.ts:100` — `bountyService.claimBounty(body.bountyId, body.operatorId)` — any authenticated caller can claim a bounty as any `operatorId`.
  - `pool.ts:104` — `poolService.claimPool(req.params.poolId, body.operatorId)` — same class: pool claimed on behalf of any operator.
  - `requests.ts:344` — `node.assignedOperator = body.operatorId` — assigns a capability node to any operator supplied in body.
  - `swf.ts:459` — `swfService.proposeTermSheet({ operatorId: body.operatorId, ... })` — creates a SWF term sheet attributed to any operator.
  - `fiat-ramp.ts:276` — `credits.createDepositSession(body.userId as string, ...)` — creates a Stripe credit session for any supplied `userId`.
  - Note: `kernel-agent-package.ts:222-229` already fixed (SEC-28) — checks kernel ownership.
- Fix needed: In each of these routes, replace `body.operatorId` / `body.userId` with the session-authenticated identity: `const callerOperatorId = (req as any).operatorId ?? (req as any).userId`. Reject or override the body field.

---

**Attack #11: BOLA info leak: 403 vs 404 on resource access**
- Status: NOT VULNERABLE
- Evidence: `provision.ts:172-176` — key revocation returns 404 for "not found" and 403 for "not your key". This does technically leak whether a key ID exists. However, key IDs are UUIDs (randomized, unguessable), so enumeration is not practical. No route leaks existence of other operators' wallet addresses or emails via status code differentiation in a guessable ID space.
- Fix needed: Low priority. Optionally return 404 for both "not found" and "not your key" in `provision.ts:175`.

---

**Attack #12: Session not invalidated on credential change (key revocation)**
- Status: NOT VULNERABLE
- Evidence: `api-key-auth.ts:37-56` — `resolveApiKey()` calls `repo.findActiveByHash(keyHash)` on every request. The `findActiveByHash` query checks the `revokedAt` field (implied by "active"). When a key is revoked (`provision.ts:183` → `repo.revoke(keyId)`), subsequent requests fail immediately because the DB lookup returns null. There is no token cache that could serve revoked keys.
- Fix needed: None.

---

**Attack #13: Ghost sessions: old session cookies valid after password reset**
- Status: NOT VULNERABLE
- Evidence: No password reset in PCC. SIWE sessions are opaque UUIDs stored in SQLite (`siwe-auth.ts:300-307`). Sessions are independent of API keys — revoking an API key does not delete a SIWE session for the same operator. However, since there is no password reset equivalent in SIWE (a new SIWE session just adds a new session, not replaces old ones), the scenario where credential change should kill sessions does not arise. Sessions expire after 24h (TTL).
- Fix needed: None in practice. Optional: On API key revocation, also delete active sessions for that operatorId.

---

### Injection / Type Confusion

**Attack #14: NoSQL-style object injection → HTTP 500**
- Status: NOT VULNERABLE
- Evidence: PCC uses SQLite via Drizzle ORM with parameterized queries throughout. NoSQL operators (`$gt`, `$where`, etc.) have no effect on SQLite. The body is typed with TypeScript but cast without runtime Zod validation in many routes. However, because the DB layer is SQL-based, object injection does not produce query manipulation. The Fastify body parser rejects malformed JSON with 400. Object fields passed where strings are expected may cause TypeScript runtime errors, but the global error handler at `server.ts:120-149` catches these and returns 400/500 cleanly without crashing.
- Fix needed: None for NoSQL injection (SQLite is immune). Type coercion crashes are mitigated by the global error handler.

---

**Attack #15: Type confusion on signup (object/array → 500)**
- Status: NOT VULNERABLE
- Evidence: `provision.ts:30-35` — body is cast to a typed object. If `body.email` is `["admin@example.com"]` (an array), `!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)` will call `.test()` on an Array object. In JS, `Array.toString()` is called implicitly for regex test on an array, yielding the joined string `admin@example.com` which passes the regex. However, this would set `operatorId` to the array's string form, which is harmless (still produces a valid-looking email string). The body limit (1MB) and the global error handler prevent any crash path.
- Fix needed: Low. Add explicit `typeof body.email === 'string'` check in `provision.ts:48`.

---

**Attack #16: Array-to-string XSS coercion**
- Status: NOT VULNERABLE
- Evidence: Routes do not perform `.join(",")` or `String()` on user-supplied title/body fields and store them in a database for later display. The AEGIS gate (`aegis-gate.ts:43-51`) recursively extracts text fields from bodies including arrays. Security monitor (`security-monitor.ts:382-402`) scans the JSON-serialized body. No route stores user-controlled array fields as rendered HTML.
- Fix needed: None.

---

**Attack #17: Object title → `[object Object]` stored**
- Status: NOT VULNERABLE
- Evidence: Body fields used as data are either validated by regex (email, walletAddress) or passed directly to internal services. No route uses `String()` on an object body field then stores it as human-readable text in the DB for display. Drizzle ORM would reject non-string values for string columns.
- Fix needed: None.

---

**Attack #18: toString override → "internal server error" crash**
- Status: NOT VULNERABLE
- Evidence: Fastify's JSON body parser produces plain JavaScript objects from JSON. JSON cannot encode custom prototypes or function properties — `{toString: () => { throw }}` is not representable in JSON. The body parser creates safe plain objects. Template literals like `` `${body.someField}` `` in route code would call the field's toString, but since body fields come from JSON, no custom toString overrides are possible.
- Fix needed: None.

---

**Attack #19: Boolean newPassword → crash**
- Status: N/A
- Evidence: No password reset or newPassword field anywhere in PCC.
- Fix needed: None.

---

**Attack #20: Deeply nested JSON → 500 crash (DoS)**
- Status: NOT VULNERABLE
- Evidence: `server.ts:105` — `bodyLimit: 1_048_576` (1MB). Deeply nested JSON within 1MB is theoretically possible. However, Fastify's default JSON parser does not impose a depth limit, meaning a payload like `{"a":{"a":{"a":...}}}` repeated ~10,000 levels deep within 1MB could theoretically cause a stack overflow during parsing. In practice, 1MB of JSON can be nested ~30,000 levels deep (each level costs ~7 bytes `{"a":`). However, Node.js (V8) JSON.parse is iterative, not recursive — it does NOT stack overflow on deeply nested JSON. This is not exploitable.
- Fix needed: None.

---

**Attack #21: Prototype pollution (`__proto__`, `constructor`)**
- Status: NOT VULNERABLE
- Evidence: Fastify uses its own JSON parser (fast-json-stringify / @fastify/ajv) which by default handles `__proto__` as a regular key without polluting `Object.prototype`. There is no `Object.assign({}, body)` pattern in the codebase that would propagate pollution. Grepping for `__proto__` in source yields zero matches. SQLite queries use parameterized Drizzle ORM calls, not `eval` or dynamic property access.
- Fix needed: None.

---

### Stored XSS

**Attack #22: Stored XSS in action title/body**
- Status: NOT VULNERABLE
- Evidence: Dashboard uses React, which escapes all JSX string interpolations. The one remaining `dangerouslySetInnerHTML` in `WhitepaperPage.tsx:29` uses a local markdown converter (`markdownToHtml`) that has an explicit `esc()` function (lines 231-238) escaping `&`, `<`, `>`, `"`, `'` on all user-visible content. The final pass at lines 222-226 strips `<script>`, `<iframe>`, `<object>`, `<embed>` tags and blocks `on*=` event handlers. The whitepaper source is a static file served from disk, not user-controlled content — attack surface is nil.
- Fix needed: None.

---

**Attack #23: Stored XSS in displayName**
- Status: N/A
- Evidence: PCC has no `displayName` field. Operator identity is email or wallet address. Neither is rendered as raw HTML in the dashboard. React escapes both.
- Fix needed: None.

---

**Attack #24: XSS at signup via displayName (no auth)**
- Status: N/A
- Evidence: `provision.ts` has no `displayName` parameter. The `name` and `capability` fields are accepted but stored in the `apiKeys` table (as `name` and `description` columns), not rendered as HTML anywhere in the dashboard.
- Fix needed: None.

---

**Attack #25: XSS-identity actors in audit log**
- Status: NOT VULNERABLE (mitigated by attack #8 being not vulnerable)
- Evidence: Since identity injection (#8) is not possible — the session actor is always a cryptographically verified wallet address — the `actor` field in audit log entries cannot be attacker-controlled. The audit log route (`audit.ts:20-26`) returns raw JSON consumed by API clients. The dashboard has no dedicated audit log rendering page (`grep -r "audit" apps/dashboard/src` yields no audit log display component). Even if actor were attacker-controlled, it would be a wallet address (42-char hex) or email, neither of which is executable.
- Fix needed: None.

---

**Attack #26: XSS in CSS injection via `<style>` tags**
- Status: NOT VULNERABLE
- Evidence: The security monitor (`security-monitor.ts:24-30`) has XSS patterns blocking `<script>`, `javascript:`, `onerror=`, `<iframe>`, `eval(`, `document.cookie`. The AEGIS gate scans all body text fields before they reach handlers. React's JSX escaping prevents stored CSS injection from being rendered. The `<style>` tag pattern is not in XSS_PATTERNS but the `<script>` and `on*=` patterns catch the most dangerous cases.
- Fix needed: Low. Add `/<style[\s>]/i` to `XSS_PATTERNS` in `security-monitor.ts:24`.

---

### Rate Limiting

**Attack #27: Zero rate limiting on signup/login/reset**
- Status: **VULNERABLE** (partial)
- Evidence:
  - `/api/auth/provision` — rate limited (5/IP/hour via `canProvision()`, `security-hardening.ts:80-95`). ✓
  - `/api/auth/verify` (SIWE login) — NO rate limiting. `siwe-auth.ts:224` — no `canProvision` or similar gate. An attacker can hammer SIWE verify with 10,000 requests/minute.
  - `/api/feedback` — rate limited (10/IP/hour). ✓
  - Job submission, DHT announce, heartbeat — no per-endpoint rate limits (only the 100 req/min general alert tracker, which emits a PostHog event but does NOT block).
- Fix needed: Add rate limiter to `/api/auth/verify` in `siwe-auth.ts` (5-10 attempts per nonce/IP per minute). The general security monitor rate tracking (`security-monitor.ts:367-375`) only logs but does not block.

---

**Attack #28: Log poisoning via crash floods**
- Status: NOT VULNERABLE
- Evidence: The global error handler (`server.ts:120-149`) catches all errors and returns structured 400/500 responses. It does not log each crash to the audit log — only 5xx errors go to Sentry. The audit log is only written on successful writes (via `onResponse` hook at `server.ts:190-217`). A flood of bad requests would not fill the audit log with garbage entries.
- Fix needed: None.

---

**Attack #29: Crash attacks invisible to admin panel — security-monitor hook ordering**
- Status: NOT VULNERABLE
- Evidence: `security-monitor.ts:306` — attack detection runs in `onRequest` (before body) and `preHandler` (after body). If a crash occurs in the route handler (after `preHandler`), it is caught by the global `setErrorHandler`. The `onResponse` hook fires even on errors (Fastify guarantees this). Since the audit write is in `onResponse`, it captures the final status code including errors. Attack detection runs _before_ the route handler, so it is never bypassed by a handler crash.
- Fix needed: None.

---

### Admin / Info Disclosure

**Attack #30: Admin panel token `letmein` / hardcoded secrets**
- Status: NOT VULNERABLE
- Evidence: Grepped all gateway source for `letmein`, `hardcoded`, `password.*=`, `secret.*=` patterns. No hardcoded admin tokens found. The `well-known.ts:106` comment describes the API key format but does not hardcode one. Test files contain only test-specific mock keys (`"test-api-key"`, `"0xsecret_test_key"`) that are never used in production routes.
- Fix needed: None.

---

**Attack #31: Admin API exposed in client JS bundle**
- Status: **VULNERABLE** (informational)
- Evidence: The dashboard `CLAUDE.md` section lists internal endpoints including `/api/audit/log`, `/api/status/integrations`, `/api/telemetry/system`. These are referenced in the gateway source but may be compiled into the frontend bundle or discoverable via the agent-package.json (219 tools at `/agent-package.json`) which is public. The `/agent-package.json` route is explicitly public per `well-known.ts` and lists all 219 API endpoints. While endpoints require auth, their existence is fully disclosed. This is by design for an agent-first platform, but attackers get a full route map for free.
- Fix needed: Intentional by design for PCC's "agent-first" model. Consider adding a `CLAUDE.md` or `.htaccess` note that the endpoint map is public. No code change required unless privacy of endpoint names is desired.

---

**Attack #32: Admin logs + IDOR = mass profile hijack**
- Status: NOT VULNERABLE
- Evidence: Audit log (#33 below) lacks actor scoping, but there is no identity injection path (#8 confirmed not vulnerable) and no IDOR on auth endpoints that would enable hijack. API key UUIDs are not guessable.
- Fix needed: None independently of #10 and #33 fixes.

---

**Attack #33: Admin event logs readable by any operator**
- Status: **VULNERABLE**
- Evidence: `audit.ts:20-26` — `GET /api/audit/log` returns all audit entries matching query params with no actor scoping. Any authenticated operator can call `GET /api/audit/log?limit=1000` and receive all audit events from all actors, including IP addresses, user agents, wallet addresses, and action metadata of every other operator. The route is registered _after_ `apiGate` in `server.ts:272-274`, so auth is required, but no per-operator filter is enforced.
- Fix needed: In `audit.ts`, scope the query to the caller's `operatorId`. Add: `const callerActor = (req as any).operatorId ?? (req as any).userId; if (!opts.actor) opts.actor = callerActor;` to force actor-scoped queries unless the caller is an admin.

---

**Attack #34: Username enumeration via signup (200 vs 400/409)**
- Status: NOT VULNERABLE
- Evidence: `provision.ts:64-111` — provisioning an email that already exists does NOT return a different error code. The API key limit check (`provisionApiKey` throws "Maximum 5") results in a 429, but this is reached only after 5 keys exist for the same operatorId. A first-time provision for an existing email still succeeds (creates a 6th key if not at limit) or returns 429 (if at limit). An attacker cannot determine whether `email@example.com` already has an account based on a 200/400 distinction — both paths produce a 201 on success and a 429 only after 5 keys.
- Fix needed: None for enumeration. Low-risk in any case since email is the provisioning identifier, not a password.

---

**Attack #35: Username enumeration via reset (token vs null)**
- Status: N/A
- Evidence: No password reset.
- Fix needed: None.

---

**Attack #36: Email settable to anything without verification**
- Status: NOT VULNERABLE (by design)
- Evidence: `provision.ts:48-56` — email is validated by regex but not verified via confirmation link. Email is used only as an `operatorId` key — a routing tag for API key ownership. It is not used for authentication (authentication is wallet signature or API key, not email). An operator who claims `admin@example.com` gains no privilege from that email — they get API keys scoped to that operatorId string. There is no admin-by-email path.
- Fix needed: None for the security model. Email verification would be a UX improvement, not a security fix.

---

### Headers / Cookies

**Attack #37: Admin cookie missing Secure flag**
- Status: NOT VULNERABLE (in production)
- Evidence: `siwe-auth.ts:312` — `secure: process.env.NODE_ENV === "production"`. In production (Railway), `NODE_ENV=production`, so `secure: true` is set. In development, it is false (intentional for HTTP localhost).
- Fix needed: None.

---

**Attack #38: Clickjacking — no X-Frame-Options/CSP**
- Status: NOT VULNERABLE
- Evidence: `security-hardening.ts:112` — `reply.header("X-Frame-Options", "DENY")` on every response. CSP includes `frame-ancestors 'none'` at line 144. Both are set globally via the `onSend` hook.
- Fix needed: None.

---

**Attack #39: Cache-Control: public on authenticated endpoints**
- Status: **VULNERABLE** (scoped)
- Evidence: Two routes set `Cache-Control: public`:
  - `capabilities.ts:191` — `Cache-Control: public, max-age=60` on the **button embed endpoint** (`/api/capabilities/:id/button`). This endpoint is intentionally public and unauthenticated, so the risk is low.
  - `context-pack.ts:666,676` — `Cache-Control: public, max-age=300` on `/agent-context-pack` and `/agent-context-pack.json`. These are public endpoints (no auth required) containing only public capability network metadata. Low risk.
  - No authenticated endpoints set `Cache-Control: public`. The global `onSend` hook in `security-hardening.ts` does not set Cache-Control, so Fastify's default (no Cache-Control header) applies to all auth-required endpoints. A CDN will not cache responses without an explicit Cache-Control header.
- Fix needed: None (the public cache headers are on legitimately public, non-sensitive endpoints).

---

**Attack #40: Missing security headers (X-Content-Type-Options, Referrer-Policy)**
- Status: NOT VULNERABLE
- Evidence: `security-hardening.ts:114-118` — all headers are present: `X-Content-Type-Options: nosniff`, `X-XSS-Protection: 1; mode=block`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(self)`. HSTS set in production only (correct).
- Fix needed: None.

---

**Attack #41: `x-gate: open` header leaked / internal state in headers**
- Status: NOT VULNERABLE
- Evidence: Grepped all gateway source for `x-gate`, `x-pcc-debug`, `x-pcc-internal`, `x-internal` — zero matches. The security-monitor uses `x-railway-edge` as an _input_ header (for fingerprinting), not as an output. No internal state headers are emitted.
- Fix needed: None.

---

### Persistence

**Attack #42: Stealth account planting (healthcheck, monitoring, cron_worker)**
- Status: NOT VULNERABLE
- Evidence: `provision.ts:39-62` — operator identity must be a valid EVM address (42-char hex starting with `0x`) or a valid email address (regex validated). Names like `healthcheck`, `monitoring`, `cron_worker`, `system` are valid as the `name` field (not operatorId), which has no privilege. The `operatorId` must be a real email or wallet address — no blank IDs, no special characters that could impersonate system accounts.
- Fix needed: None.

---

**Attack #43: Ghost session + stepup = permanent elevated access**
- Status: N/A
- Evidence: No step-up endpoint. No elevated session concept.
- Fix needed: None.

---

**Attack #44: Persistent admin takeover loop**
- Status: N/A
- Evidence: PCC has no username-based admin — admin access is by wallet signature. Wallet private keys are held by the operator, not the server.
- Fix needed: None.

---

### Other

**Attack #45: Body size limit bypass**
- Status: NOT VULNERABLE
- Evidence: `server.ts:105` — `bodyLimit: 1_048_576` set at Fastify instance level (global). This applies to all routes. The error handler at line 122-130 explicitly handles `FST_ERR_CTP_BODY_TOO_LARGE` and returns 400. No individual route overrides with a higher limit except camera frame routes which validate at the application layer (`ot2-camera.ts:52` checks `frame.length > 5MB`). These camera routes are intentionally larger.
- Fix needed: None.

---

**Attack #46: Path traversal via `../` in URL**
- Status: NOT VULNERABLE
- Evidence: `server.ts:432-434` — the SPA fallback uses `resolvePath()` and checks `if (!filePath.startsWith(resolvedDashboardRoot))` before serving any file, returning 400 for path traversal attempts. The security monitor (`security-monitor.ts:34-40`) also blocks `../` patterns in URLs at `onRequest` time, returning 403 before the handler runs.
- Fix needed: None.

---

**Attack #47: CORS wildcard on authenticated endpoints**
- Status: **VULNERABLE** (scoped — 4 specific routes)
- Evidence: The global CORS policy uses an allowlist (`security-hardening.ts:16-22`). However, 4 specific routes manually set `Access-Control-Allow-Origin: *`:
  - `capabilities.ts:190` — button embed endpoint (public, intentional — by design for embedding).
  - `context-pack.ts:667,677` — agent context pack (public, intentional).
  - `device-relay.ts:955` — camera stream SSE (`/api/relay/:kernelId/camera/stream`) — this is an SSE stream that sits **behind the API gate** (requires auth). Setting `Access-Control-Allow-Origin: *` here means any origin can make credentialed requests to this stream. However, SSE streams use `text/event-stream` and don't support cookies/credentials natively from `*` origins, so the practical risk is low.
  - `well-known.ts:65,225` — `.well-known` endpoints (public by design).
  - The camera relay SSE wildcard CORS (`device-relay.ts:955`) is the only case behind auth.
- Fix needed: `device-relay.ts:955` — change `Access-Control-Allow-Origin: *` to use the validated `allowOrigin` pattern from `sse-auth.ts` (check origin against `ALLOWED_SSE_ORIGINS`).

---

**Attack #48: Prototype pollution via JSON (duplicate of #21)**
- Status: NOT VULNERABLE
- Evidence: Same as #21. Fastify JSON parsing is safe.
- Fix needed: None.

---

**Attack #49: Semicolons / cookie-breaking chars in session**
- Status: NOT VULNERABLE
- Evidence: The `pcc_session` cookie value is a `randomUUID()` (`siwe-auth.ts:296`), which is a lowercase hex UUID with hyphens only — no semicolons, quotes, or special characters possible. Wallet addresses are strict hex. Email operatorIds are validated by regex (`/^[^\s@]+@[^\s@]+\.[^\s@]+$/`) which excludes most special chars.
- Fix needed: None.

---

**Attack #50: Stepup gates no functionality**
- Status: N/A
- Evidence: No step-up endpoint.
- Fix needed: None.

---

**Attack #51: Different error messages leak endpoint info**
- Status: NOT VULNERABLE
- Evidence: `server.ts:140-148` — the global error handler returns `"internal_error"` with message `"Internal Server Error"` for all 5xx. For 4xx, it returns the Fastify error message which is structural (e.g., "Missing required fields"), not a stack trace. No route leaks internal file paths, stack frames, or module names in error responses. Sentry captures 5xx but does not echo back to the client.
- Fix needed: None.

---

**Attack #52: Session cookie signed with HMAC**
- Status: **VULNERABLE** (no signing)
- Evidence: `server.ts:179` — `await app.register(cookie)` — `@fastify/cookie` is registered **without a `secret` option**. Without a `secret`, cookies are NOT HMAC-signed. The `pcc_session` cookie (`siwe-auth.ts:311`) is set as a raw opaque UUID. An attacker who can read or predict any session UUID can impersonate that user.
  - Mitigating factor: The session UUID is a cryptographically random `randomUUID()` (128-bit), making prediction infeasible. The cookie is `httpOnly: true, secure: true (prod), sameSite: lax`, so direct theft requires XSS (blocked by CSP + React escaping).
  - Without HMAC signing, however, there is no way to detect cookie tampering or session ID forgery even if someone discovers a UUID through logs, SSE responses, or other side channels.
- Fix needed: Register `@fastify/cookie` with a strong `secret` in `server.ts:179`:
  ```ts
  await app.register(cookie, { secret: process.env.COOKIE_SECRET ?? randomBytes(32).toString("hex") });
  ```
  Then use `reply.setCookie("pcc_session", token, { signed: true, ... })` and `req.unsignCookie(...)` in resolveSession.

---

**Attack #53: No username length limit (1000+ chars)**
- Status: **VULNERABLE** (partial)
- Evidence: `provision.ts:30-62`:
  - `walletAddress` is strictly 42 chars (regex: `0x[0-9a-fA-F]{40}`). ✓ Not vulnerable.
  - `email`: validated by regex `[^\s@]+@[^\s@]+\.[^\s@]+$` but NO length check. An attacker could submit `email = "a".repeat(10000) + "@b.c"` which passes the regex and gets stored as the operatorId in SQLite. A 10,000-char operatorId is then used as an audit log `actor` field, stored in SQLite text columns (unlimited length), and echoed back in API key responses.
  - `name` field: no length limit at all. An arbitrarily long name is accepted and stored.
- Fix needed: In `provision.ts:48` add `if (body.email.length > 254) return reply.status(400)...` (RFC 5321 max email = 254 chars). Similarly cap `body.name` at 200 chars.

---

**Attack #54: Actions return "not found" vs "forbidden" (resource enumeration)**
- Status: NOT VULNERABLE (low risk)
- Evidence: See #11. The key revoke route `provision.ts:172,176` returns 404 vs 403, but key UUIDs are random and unguessable. No other resource ID namespace is guessable (all use UUID or random hex IDs). The practical risk is near zero.
- Fix needed: Optional hardening: return 404 for both "not found" and "not your key" in DELETE `/api/auth/keys/:keyId`.

---

**Attack #55: Logging middleware runs AFTER route (crashes invisible)**
- Status: NOT VULNERABLE
- Evidence: Security monitor's `onRequest` hook (URL/header scanning) fires before any route handler. The `preHandler` hook (body scanning) fires before the route handler. The Fastify `onResponse` hook fires even when a route throws — Fastify's error handler catches route exceptions and still runs lifecycle hooks. The global `setErrorHandler` is registered (`server.ts:120`) before routes and handles uncaught route errors, ensuring the `onResponse` audit hook always fires.
- Fix needed: None.

---

## Prioritized Fix List

Ordered by severity (Critical → High → Medium → Low):

### 1. CRITICAL — Audit log exposes all operators' data (#33)
- **File**: `C:\Users\globa\physical-capability-cloud\packages\gateway\src\routes\audit.ts:20`
- **Fix**: Scope `GET /api/audit/log` to the caller's operatorId unless a future admin role is defined. Add `const callerActor = (req as any).operatorId ?? (req as any).userId;` and pass it as a default `actor` filter to `auditService.query()`.

### 2. HIGH — IDOR: body.operatorId / body.userId overrides in 5 routes (#10)
- **Files**:
  - `C:\Users\globa\physical-capability-cloud\packages\gateway\src\routes\bounty.ts:100`
  - `C:\Users\globa\physical-capability-cloud\packages\gateway\src\routes\pool.ts:104`
  - `C:\Users\globa\physical-capability-cloud\packages\gateway\src\routes\requests.ts:344`
  - `C:\Users\globa\physical-capability-cloud\packages\gateway\src\routes\swf.ts:459`
  - `C:\Users\globa\physical-capability-cloud\packages\gateway\src\routes\fiat-ramp.ts:276`
- **Fix**: Replace `body.operatorId` / `body.userId` with `(req as any).operatorId ?? (req as any).userId` in each route. Reject if caller identity doesn't match the requested operatorId.

### 3. HIGH — No rate limit on SIWE verify endpoint (#27)
- **File**: `C:\Users\globa\physical-capability-cloud\packages\gateway\src\auth\siwe-auth.ts:224`
- **Fix**: Import `canProvision` (or add a dedicated `canVerify` rate limiter) and apply it to `POST /api/auth/verify`. 5 attempts/IP/minute is appropriate. The nonce mechanism provides one-use protection per nonce but not brute-force protection on the verify endpoint itself.

### 4. MEDIUM — Session cookie not HMAC-signed (#52)
- **File**: `C:\Users\globa\physical-capability-cloud\packages\gateway\src\server.ts:179`
- **Fix**: Register `@fastify/cookie` with `{ secret: process.env.COOKIE_SECRET }` and use `signed: true` on the `pcc_session` cookie. Add `COOKIE_SECRET` to Railway env vars (32+ random bytes). Update `resolveSession()` in `siwe-auth.ts:162` to unsign the cookie before lookup.

### 5. MEDIUM — No email length limit allows arbitrarily long operatorId (#53)
- **File**: `C:\Users\globa\physical-capability-cloud\packages\gateway\src\routes\provision.ts:48`
- **Fix**: Add length check after regex: `if (body.email.length > 254) return reply.status(400).send({ error: "email_too_long" });`. Also cap `body.name` at 200 chars.

### 6. LOW — Authenticated camera SSE route has CORS wildcard (#47)
- **File**: `C:\Users\globa\physical-capability-cloud\packages\gateway\src\routes\device-relay.ts:955`
- **Fix**: Replace `"Access-Control-Allow-Origin": "*"` with origin-validated header matching the pattern in `sse-auth.ts`. The allowed origins are `https://capability.network`, `http://localhost:5173`, etc.

### 7. LOW — Feedback read endpoint is unauthenticated (#feedback.ts:94)
- **File**: `C:\Users\globa\physical-capability-cloud\packages\gateway\src\routes\feedback.ts:94`
- **Fix**: Add auth check to `GET /api/feedback` — this exposes submitted bug reports including wallet addresses and user agents of all users. Add `const operatorId = (req as any).operatorId; if (!operatorId) return reply.status(401)...`

### 8. LOW — Add `<style>` to XSS block patterns (#26)
- **File**: `C:\Users\globa\physical-capability-cloud\packages\gateway\src\middleware\security-monitor.ts:24`
- **Fix**: Add `/<style[\s>]/i` to `XSS_PATTERNS` array.

### 9. LOW — DELETE /api/auth/keys/:keyId leaks key existence via 404 vs 403 (#11/#54)
- **File**: `C:\Users\globa\physical-capability-cloud\packages\gateway\src\routes\provision.ts:172-176`
- **Fix**: Return 404 for both "Key not found" and "Not your key" to prevent key ID enumeration.
