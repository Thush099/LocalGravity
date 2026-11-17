---
name: api-designer
description: "Design stable APIs and module contracts: resources, naming, errors, pagination, idempotency, versioning, and the boundaries between frontend and backend."
triggers: ["api", "endpoint", "rest", "graphql", "openapi", "schema", "contract", "pagination", "versioning", "interface design"]
---

# API Designer

An API is a promise. Design the smallest promise you can keep for years.

## 1. Model the domain first
- Name the resources and the operations users actually perform. Prefer nouns for resources, verbs only for actions that are not CRUD.
- Decide the identity of each resource and who owns it. Authorization is part of the contract, not an afterthought.
- Write the data shapes with exact field names and types, optionality, and units. Dates are ISO 8601 UTC; money is an integer minor unit plus a currency code.

## 2. Shape the endpoints
- `GET /things` list, `POST /things` create, `GET /things/:id`, `PATCH /things/:id` partial update, `DELETE /things/:id`.
- Use plural nouns, kebab-case paths, and stable casing for JSON fields (pick one and keep it).
- Return the created or updated resource, not just a status.
- Make retries safe: idempotency keys for creates and payments, `PUT` for full replacement, no side effects on `GET`.
- Support partial failure explicitly; do not return 200 with an error body.

## 3. Errors and limits
- One error envelope: `{ error: { code, message, details? } }` with a machine-readable code and a human message that says how to fix it.
- Map status codes honestly: 400 malformed, 401 unauthenticated, 403 unauthorized, 404 missing or hidden, 409 conflict, 422 validation, 429 rate limited with `Retry-After`, 5xx server.
- Pagination: cursor-based for large or changing collections, with an explicit `nextCursor` and a documented default and maximum page size.
- Validation errors name the field and the rule.

## 4. Evolution
- Additive changes are safe; removing or retyping a field is breaking. Version with a path prefix or a dated header, and keep old versions working for a stated window.
- Deprecate with a response header and a migration note. Never silently change semantics.
- Document the contract (OpenAPI or a schema) next to the code and test it: an integration test per endpoint, including the error paths and an unauthorized request.

## 5. Review the boundary
Check who can call what, what is validated at the edge versus the domain, and that the client never needs a second round trip for the common case. Prefer one well-named endpoint over three chatty ones, but avoid a single endpoint that returns everything.
