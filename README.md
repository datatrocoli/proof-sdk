# Proof SDK

Proof SDK is the open-source editor, collaboration server, provenance model, and agent HTTP bridge that power collaborative documents in Proof.

If you want the hosted product, use [Proof](https://proofeditor.ai). Hosted Proof is made by [Every](https://every.to).

## What Is Included

- Collaborative markdown editor with provenance tracking
- Comments, suggestions, and rewrite operations
- Realtime collaboration server
- Agent HTTP bridge for state, marks, edits, presence, and events
- A small example app under `apps/proof-example`

## Workspace Layout

- `packages/doc-core`
- `packages/doc-editor`
- `packages/doc-server`
- `packages/doc-store-sqlite`
- `packages/agent-bridge`
- `apps/proof-example`
- `server`
- `src`

## Local Development

### Docker Compose (local experiment)

With Docker running, start the built editor and server:

```bash
docker compose up --build -d
```

Open http://localhost:3020. The root page is SDK information; documents open
at `/d/<slug>`. Create a document through `POST /documents` with a JSON body
such as `{"title":"Test","markdown":"# Test\n\nA local document."}`.
The response includes an editor link in `tokenUrl`; keep that link and the
returned owner secret private.

This packages the upstream SDK without adding account login or changing its
permissions. It is an experiment, not a hardened hosted deployment. The port
is bound to `127.0.0.1` so it is accessible only on the Docker host. Collaboration
uses the same port. SQLite and snapshots persist in the `proof-local_proof-data`
Docker volume. Collaboration session signing uses the SDK's temporary key;
clients may need to reconnect after a server restart.

```bash
docker compose ps                 # Check health
docker compose logs --tail=50     # Inspect startup
docker compose down              # Stop and remove containers; keep documents
docker compose up -d              # Start again
```

To remove the experiment **and permanently delete its documents**:

```bash
docker compose down --volumes --rmi local
```

The image uses Node 22, installs the committed dependency lockfile, builds the
editor, and runs as the non-root `node` user. No host Node installation is needed.

Agent suggestions are submitted with `suggestion.add` through the document ops
API. Click the marked text in the editor to open **Apply / Reject** controls.
The SDK web interface does not currently expose an Editing/Suggesting mode
selector for human typing.

Known limitation from local browser verification: clicking Apply on a pending
replacement produced duplicated browser content while a subsequent state read
still returned the original text. Reloading that test document then failed to
build its collaboration session. Suggestion creation works, but the full review
flow needs further repair; do not treat acceptance as verified by the existing
API test suite.

The connection heartbeat refreshes both the document lease and the authenticated
connection record. To check this behavior, leave a document open for more than
45 seconds, then submit a pending suggestion while the browser remains connected.
It should succeed without `LIVE_DOC_UNAVAILABLE` and appear in the editor.

Requirements:

- Node.js 18+

Install dependencies:

```bash
npm install
```

Start the editor:

```bash
npm run dev
```

Start the local server:

```bash
npm run serve
```

The default setup serves the editor on `http://localhost:3000` and the API/server on `http://localhost:4000`.

## Core Routes

Canonical Proof SDK routes:

- `POST /documents`
- `GET /documents/:slug/state`
- `GET /documents/:slug/snapshot`
- `POST /documents/:slug/edit`
- `POST /documents/:slug/edit/v2`
- `POST /documents/:slug/ops`
- `POST /documents/:slug/presence`
- `GET /documents/:slug/events/pending`
- `POST /documents/:slug/events/ack`
- `GET /documents/:slug/bridge/state`
- `GET /documents/:slug/bridge/marks`
- `POST /documents/:slug/bridge/comments`
- `POST /documents/:slug/bridge/suggestions`
- `POST /documents/:slug/bridge/rewrite`
- `POST /documents/:slug/bridge/presence`

Compatibility aliases remain mounted for the hosted product, but the routes above are the public SDK surface.

## Build

```bash
npm run build
```

The build outputs the web bundle to `dist/` and writes `dist/web-artifact-manifest.json`.

## Tests

```bash
npm test
```

## Docs

- `AGENT_CONTRACT.md`
- `docs/agent-docs.md`
- `docs/proof.SKILL.md`
- `docs/adr/2026-03-proof-sdk-public-core.md`

## License

- Code: `MIT` in `LICENSE`
- Trademark guidance: `TRADEMARKS.md`
