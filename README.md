# IT Support Ticket Agent

A local demo for reading and creating IT support tickets through Element, Synapse, OpenClaw, MCP, GraphQL and two REST APIs. Includes Keycloak SSO and OpenTelemetry/Jaeger tracing.

## Quick start (Windows)

Install **Node.js 24, Git and Docker Desktop with Linux containers**. Start Docker Desktop, open PowerShell in this directory and run:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup-review.ps1 -Check
powershell -ExecutionPolicy Bypass -File .\setup-review.ps1
powershell -ExecutionPolicy Bypass -File .\start-review.ps1
```

Setup asks for your own OpenAI API key using hidden input and uses `gpt-4o-mini`. API access and quota are required. It creates local accounts, a bot, a room, service keys and sample databases; clones a pinned Element commit into sibling directory `element-web`; and applies the included UIA patch. That Element checkout requires pnpm **12.18.0**.

Open Element at http://localhost:8080 and Jaeger at http://localhost:16686. Chat credentials are in `local-credentials.json`; SSO credentials are in `keycloak.local.json`. Keep those files private. Invite `@duong-sso:localhost` into the chat room from the reviewer account, then sign in through Keycloak in another browser to test SSO. Ticket writes are restricted to the configured reviewer account and room.

Initial downloads/builds may take several minutes. Setup refuses an existing environment rather than overwriting it. Rerun setup in the same directory to resume an interrupted installation. Subsequent runs only need `start-review.ps1`. To stop, press Ctrl+C in the Element terminal and run `stop-review.ps1`; data is retained.

Bootstrap syntax, database initialization/retry and Element patch application have been checked. A complete fresh-Windows installation has **not yet been validated**.

## Architecture

```text
Element -> Synapse -> OpenClaw + LLM -> MCP -> GraphQL
                                              |-- Employee REST -> SQLite
                                              |-- Ticket REST   -> SQLite
Keycloak: SSO login                 Jaeger: backend traces
```

Employee names are disambiguated before ticket queries. Creating a ticket requires a preview and explicit confirmation code. The backend verifies the actual Matrix event, draft expiry and idempotency. See [SPEC.md](SPEC.md) for business behavior and `ticket-service/design/` for OpenAPI and GraphQL schemas.

## Try it

Mention the bot in Element and ask for ticket `IT-000001`, or ask about `Nam` to exercise disambiguation. For creation, supply title, description, requester, assignee (or explicitly unassigned), priority and an optional deadline. Confirm using the code in the preview.

To run automated tests, install dependencies with `npm ci` in `telemetry`, `ticket-service` and `mcp-ping`, then run from the project root:

```powershell
node --test ticket-service/*.test.mjs mcp-ping/*.test.mjs telemetry/*.test.mjs
```

`scripts/evidence/` contains optional live demo utilities. They can send real messages, consume API credits, create tickets or temporarily stop services. Some assume the original demo configuration and need adjustment for your environment. Screenshot/SSO scripts also need root `npm ci` and Chrome. Generated evidence belongs in `docs/`, which is ignored by Git.

## Public source and limits

This source copy excludes private reports, screenshots, chat transcripts, captured logs, credentials and runtime databases. Example environment files contain placeholders; setup generates fresh local credentials. Do not commit generated secrets or evidence without reviewing their contents.

MCP has no separate authentication and must not be exposed to the public Internet. This demo uses local HTTP, single-user/room write guards and in-memory Jaeger storage. SSO is not application RBAC. Traces start at MCP, excluding LLM/Matrix latency. This is not a production deployment.
