import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';

const dir = mkdtempSync(path.join(os.tmpdir(), 'proof-browser-history-'));
process.env.DATABASE_PATH = path.join(dir, 'test.db');
process.env.PROOF_ENV = 'test';
const db = await import('../../server/db.js');
const collab = await import('../../server/collab.js');
const { yXmlFragmentToProseMirrorRootNode } = await import('y-prosemirror');
const { getHeadlessMilkdownParser } = await import('../../server/milkdown-headless.js');
await collab.startCollabRuntimeEmbedded(0);
try {
  const slug = 'browser-history';
  db.createDocument(slug, 'Original paragraph.\n', {}, 'Browser history test');
  const instance = collab.__unsafeGetHocuspocusInstanceForTests() as any;
  const live = await instance.createDocument(slug, {}, 'test-socket',
    { isAuthenticated: true, readOnly: false, requiresAuthentication: true }, {});
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(live));
  const parser = await getHeadlessMilkdownParser();
  const getText = (doc: Y.Doc) => yXmlFragmentToProseMirrorRootNode(
    doc.getXmlFragment('prosemirror'), parser.schema as any,
  ).textContent;
  let previousClientCount = 0;
  for (let i = 0; i < 3; i++) {
    live.transact(() => {
      const paragraph = live.getXmlFragment('prosemirror').get(0) as Y.XmlElement;
      const text = paragraph.get(0) as Y.XmlText;
      text.insert(text.length, ` Edit ${i}.`);
      // Real editor sessions create these maps even without any agents.
      live.getMap('agentPresence').set('ai:test', { name: 'Test', at: new Date().toISOString() });
      live.getArray('agentActivity').push([{ event: 'test' }]);
    }, 'browser-test');
    await collab.__unsafePersistDocAwaitForTests(slug, live, 'test:browser-history');
    const row = db.getDb().prepare('SELECT y_state_blob FROM documents WHERE slug = ?').get(slug) as any;
    assert.ok(row.y_state_blob, 'browser save writes a durable snapshot');
    const durable = new Y.Doc();
    Y.applyUpdate(durable, new Uint8Array(row.y_state_blob));
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(live));
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(durable));
    assert.equal(getText(peer), getText(live), 'saving/reconnecting must not duplicate existing text');
    assert.equal(getText(durable), getText(live));
    assert.equal(durable.getMap('agentPresence').size, 0);
    assert.equal(durable.getArray('agentActivity').length, 0);
    assert.equal(live.getMap('agentPresence').size, 1, 'saving must not mutate live presence');
    const clientCount = Y.decodeStateVector(Y.encodeStateVector(durable)).size;
    if (i > 0) assert.equal(clientCount, previousClientCount, 'each save must reuse existing collaboration IDs');
    previousClientCount = clientCount;
    durable.destroy();
  }
  peer.destroy();
  console.log('PASS: browser saves preserve shared history without synthetic clients or duplicate text');
} finally {
  await collab.stopCollabRuntime();
  rmSync(dir, { recursive: true, force: true });
}
