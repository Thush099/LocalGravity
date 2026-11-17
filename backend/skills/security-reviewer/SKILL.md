---
name: security-reviewer
description: "Review code for real security defects: map trust boundaries, trace untrusted input to sinks, prove each finding, grade by exploitability and impact, and give the smallest effective fix."
triggers: ["security", "vulnerability", "auth", "authorization", "injection", "xss", "csrf", "secret", "pen test", "audit", "owasp"]
---

# Security Reviewer

A candidate finding is confirmed only when you can name the affected principal, the resource or trust boundary, and the security outcome.

## 1. Map the surface
List entry points: HTTP routes and server actions, WebSocket handlers, CLI arguments, uploads and parsers, webhooks, scheduled jobs, third-party callbacks, and anything reading env, filesystem or database. Mark which are public and where the trust boundary sits (browser to server, server to database, service to service).

## 2. Trace input to sinks
- **Authorization**: ownership checks derived from the session subject, not a client-supplied id or email; role checks enforced in the API, not only the UI; path resolution confined to an allowed root; tenant scoping on every query.
- **Injection**: bound SQL parameters instead of concatenation; shell commands built from allowlisted arguments; no `eval`; template output escaped at the sink; prototype pollution guarded.
- **Web**: `innerHTML` and unescaped templates, CSRF on state changes, missing same-origin checks, credentialed CORS, open redirects, secrets in client bundles or logs.
- **SSRF and files**: user URLs fetched server-side without an allowlist; uploads trusted by extension; archive extraction without zip-slip protection.
- **Crypto and identity**: home-grown crypto, static IVs, `Math.random` for tokens, non-constant-time comparisons, unverified JWT signatures, session tokens in URLs.
- **Abuse**: missing rate or size limits, unbounded pagination, enumeration via distinct errors or timing.
- **Supply chain**: unpinned dependencies, install scripts from untrusted packages, CI running fork code with secrets.

## 3. Prove it
Write the exact request or input, the sequence, and the `file:line` evidence that nothing stops it. Reproduce locally when safe. If you cannot prove it, label it a hypothesis and say what would confirm it. Test only systems you or the user own.

## 4. Grade
- **Critical**: unauthenticated RCE, auth bypass, cross-tenant access, live secret exposure.
- **High**: authenticated privilege escalation, stored XSS on a shared surface, SSRF to metadata, SQL injection behind a login.
- **Medium**: CSRF with meaningful state change, reflected XSS, weak limits on sensitive actions.
- **Low**: hardening with no demonstrated path.
State preconditions honestly.

## 5. Fix and verify
Give the smallest effective fix: bound parameters, server-side authorization from the session, allowlists, output encoding, same-origin checks, constant-time comparison, limits. Add a regression test that fails without the fix (401/403/404, encoded payload, rejected traversal). Never print the secret you found; report its location and rotate it.

## Report
Per finding: title, severity, location, principal and preconditions, impact, evidence, reproduction, fix. End with what you checked and found clean, and what you could not assess.
