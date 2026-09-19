import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';

const dir = mkdtempSync(path.join(os.tmpdir(), 'proof-history-'));
process.env.DATABASE_PATH = path.join(dir, 'test.db');
process.env.PROOF_ENV = 'test';
const db = await import('../../server/db.js');
const collab = await import('../../server/collab.js');
const { mutateCanonicalDocument } = await import('../../server/canonical-document.js');
const { yXmlFragmentToProseMirrorRootNode } = await import('y-prosemirror');
const { getHeadlessMilkdownParser } = await import('../../server/milkdown-headless.js');
await collab.startCollabRuntimeEmbedded(0);
try {
  db.createDocument('history-test', 'Original paragraph.\n', {}, 'History test');
  const instance = collab.__unsafeGetHocuspocusInstanceForTests() as any;
  const live = await instance.createDocument('history-test', {}, 'test-socket',
    { isAuthenticated: true, readOnly: false, requiresAuthentication: true }, {});
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(live));
  const parser = await getHeadlessMilkdownParser();
  for (const text of ['Accepted replacement.', 'Second replacement.']) {
    const result = await mutateCanonicalDocument({
      slug: 'history-test', nextMarkdown: text + '\n', nextMarks: {},
      source: 'test:shared-history', strictLiveDoc: false,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(live));
    const row = db.getDocumentBySlug('history-test')!;
    assert.equal(row.markdown.trim(), text);
    // Rejoining merges durable history with the client's existing history.
    // Independent fragment rebuilds duplicate content at this boundary.
    const durable = new Y.Doc();
    const blob = db.getDb().prepare('SELECT y_state_blob FROM documents WHERE slug = ?').get('history-test') as any;
    Y.applyUpdate(durable, new Uint8Array(blob.y_state_blob));
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(durable));
    for (const doc of [live, durable, peer]) {
      const root = yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment('prosemirror'), parser.schema as any);
      assert.equal(root.textContent, text, 'live, durable and reconnected peer must contain exactly one replacement');
    }
    durable.destroy();
  }
  peer.destroy();
  console.log('PASS: canonical updates converge across live, durable and reconnected peer histories');
} finally {
  await collab.stopCollabRuntime();
  rmSync(dir, { recursive: true, force: true });
}
