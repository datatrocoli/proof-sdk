import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import express from 'express';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { WebSocket, WebSocketServer } from 'ws';

const dir = mkdtempSync(path.join(os.tmpdir(), 'proof-browser-review-'));
process.env.DATABASE_PATH = path.join(dir, 'test.db');
process.env.PROOF_ENV = 'test';
(globalThis as any).WebSocket = WebSocket;
const { apiRoutes } = await import('../../server/routes.js');
const { agentRoutes } = await import('../../server/agent-routes.js');
const { shareWebRoutes } = await import('../../server/share-web-routes.js');
const { setupWebSocket } = await import('../../server/ws.js');
const collab = await import('../../server/collab.js');
const db = await import('../../server/db.js');
const app = express();
app.use(express.json());
app.use('/api', apiRoutes);
app.use('/api/agent', agentRoutes);
app.use(shareWebRoutes);
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
setupWebSocket(wss);
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const port = (server.address() as any).port;
const base = `http://127.0.0.1:${port}`;
await collab.startCollabRuntimeEmbedded(port);
let provider: HocuspocusProvider | undefined;
const ydoc = new Y.Doc();
async function waitFor(fn: () => boolean | Promise<boolean>, label: string) {
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    if (await fn()) return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`Timed out: ${label}`);
}
const post = (route: string, body: unknown, token?: string) => fetch(base + route, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'x-share-token': token } : {}) },
  body: JSON.stringify(body),
});
const browserHeaders = { 'User-Agent': 'Mozilla/5.0 Firefox/143.0', Accept: 'text/html' };
function configToken(html: string): string | undefined {
  const match = html.match(/window\.__PROOF_CONFIG__\.shareToken = ("[^"\n]+")/);
  return match ? JSON.parse(match[1]) : undefined;
}
try {
  const created = await (await post('/api/documents', { markdown: 'Original sentence.\n', title: 'Browser review regression' })).json();
  const { slug, accessToken } = created;
  const page = await fetch(`${base}/d/${slug}`, { headers: browserHeaders });
  assert.equal(page.status, 200);
  const token = configToken(await page.text());
  assert.ok(token, 'Plain browser URL must provide credentials for its review API');
  assert.equal(db.resolveDocumentAccessRole(slug, token), 'editor');
  const cookie = page.headers.get('set-cookie')!.split(';')[0];
  const reload = await fetch(`${base}/d/${slug}`, { headers: { ...browserHeaders, Cookie: cookie } });
  assert.equal(configToken(await reload.text()), token, 'Cookie reload must retain API credentials');
  assert.match(reload.headers.get('cache-control')!, /no-store/);

  for (const role of ['viewer', 'commenter']) {
    const link = await (await post(`/api/documents/${slug}/access-links`, { role }, accessToken)).json();
    const limited = await fetch(`${base}/d/${slug}?token=${link.accessToken}`, { headers: { ...browserHeaders, Cookie: cookie } });
    assert.equal(configToken(await limited.text()), link.accessToken, 'Explicit restricted link wins over editor cookie');
    assert.equal(db.resolveDocumentAccessRole(slug, link.accessToken), role);
  }
  const invalid = await fetch(`${base}/d/${slug}?token=invalid`, { headers: browserHeaders });
  assert.equal(configToken(await invalid.text()), undefined, 'Invalid credentials must not mint an editor token');

  (globalThis as any).window = {
    location: { origin: base, pathname: `/d/${slug}`, search: '' },
    __PROOF_CONFIG__: { shareToken: token },
  };
  const { ShareClient } = await import('../bridge/share-client.js');
  const share = new ShareClient();
  const session = await share.fetchCollabSession();
  assert.ok(session && 'session' in session);
  let synced = false;
  provider = new HocuspocusProvider({
    url: `ws://127.0.0.1:${port}/ws`, name: slug, document: ydoc,
    token: session.session.token,
    parameters: { token: session.session.token, role: session.session.role },
    preserveConnection: false, broadcast: false,
  });
  provider.on('synced', ({ state }: { state?: boolean }) => { synced = state !== false; });
  await waitFor(() => synced, 'real browser socket sync');
  const paragraph = ydoc.getXmlFragment('prosemirror').get(0) as Y.XmlElement;
  const text = paragraph.get(0) as Y.XmlText;
  text.insert(text.length, ' Saved from browser.');
  await waitFor(() => db.getDocumentBySlug(slug)?.markdown.includes('Saved from browser.') === true,
    'browser edit reaches durable storage');
  console.log('PASS: real browser socket persists typed text');

  for (const action of ['accept', 'reject'] as const) {
    const response = await post(`/api/agent/${slug}/marks/suggest-replace`, {
      quote: 'Original sentence.', content: action === 'accept' ? 'Accepted sentence.' : 'Rejected sentence.', by: 'ai:review-test',
    }, accessToken);
    assert.equal(response.status, 200);
    const { marks } = await response.json();
    const id = Object.entries(marks).find(([, m]: any) => m.kind === 'replace' && m.status === 'pending')?.[0];
    assert.ok(id);
    const result = action === 'accept' ? await share.acceptSuggestion(id, 'human:test') : await share.rejectSuggestion(id, 'human:test');
    assert.ok(result && !('error' in result) && result.success, `Browser ${action} must succeed: ${JSON.stringify(result)}`);
    await waitFor(() => !db.getDocumentBySlug(slug)?.marks.includes(`\"${id}\"`), 'review is saved');
    const saved = db.getDocumentBySlug(slug)!;
    assert.ok(saved.markdown.includes('Saved from browser.'), 'Review preserves newer browser text');
    assert.ok(saved.markdown.includes(action === 'accept' ? 'Accepted sentence.' : 'Original sentence.'));
    assert.ok(!saved.markdown.includes('Rejected sentence.'));
    if (action === 'accept') {
      // Restore the fixture through the peer so the next review tests the same quote.
      await waitFor(() => ydoc.getXmlFragment('prosemirror').toString().includes('Accepted sentence.'), 'accept reaches browser');
      const p = ydoc.getXmlFragment('prosemirror').get(0) as Y.XmlElement;
      const t = p.get(0) as Y.XmlText;
      ydoc.transact(() => { t.delete(0, 'Accepted sentence.'.length); t.insert(0, 'Original sentence.'); });
      await waitFor(() => db.getDocumentBySlug(slug)?.markdown.includes('Original sentence.') === true, 'second browser save');
    }
  }
  console.log('PASS: plain-link and cookie sessions accept/reject complete suggestions through the real server');
} finally {
  provider?.disconnect();
  provider?.destroy();
  ydoc.destroy();
  for (const socket of wss.clients) socket.terminate();
  await collab.stopCollabRuntime();
  await new Promise<void>(r => server.close(() => r()));
  wss.close();
  rmSync(dir, { recursive: true, force: true });
}
// Hocuspocus's provider can retain reconnect timers after disconnect/destroy.
// All assertions and server/database cleanup above must complete first.
process.exit(0);
