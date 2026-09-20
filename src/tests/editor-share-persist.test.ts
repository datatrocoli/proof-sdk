import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import * as persistPolicy from '../editor/share-refresh-persist.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'proof-unload-authorship-'));
process.env.DATABASE_PATH = path.join(dir, 'test.db');
process.env.PROOF_ENV = 'test';
const db = await import('../../server/db.js');
const { mutateCanonicalDocument } = await import('../../server/canonical-document.js');
const { getHeadlessMilkdownParser, serializeMarkdown } = await import('../../server/milkdown-headless.js');
const { extractAuthoredMarksFromDoc } = await import('../../server/proof-authored-mark-sync.js');

try {
  // Exercise the real browser flush method and serializer, then save its exact
  // payload through the canonical REST mutation path used during page reload.
  const source = ts.createSourceFile('editor.ts', readFileSync('src/editor/index.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const editorClass = source.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === 'ProofEditorImpl') as ts.ClassDeclaration;
  const names = ['flushShareMarks', 'normalizeMarkdownForRuntime'];
  const methods = editorClass.members.filter(m => ts.isMethodDeclaration(m) && names.includes(m.name.getText(source))).map(m => m.getText(source));
  assert.equal(methods.length, names.length);
  const strip = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'stripAuthoredSpanTags')!;
  const script = ts.transpileModule(`${strip.getText(source)}\nclass FlushEditor { ${methods.join('\n')} }\nFlushEditor;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const parser = await getHeadlessMilkdownParser();
  const markdown = '<span data-proof="authored" data-by="human:Alice">Human paragraph.</span>\n\n'
    + '<span data-proof="authored" data-by="ai:Claude">Agent contribution.</span>\n';
  const doc = parser.parseMarkdown(markdown);
  assert.ok(doc);
  const serialized = await serializeMarkdown(doc);
  const metadata = extractAuthoredMarksFromDoc(doc as any, parser.schema as any);
  const writes: Array<{ markdown: string; marks: Record<string, unknown> }> = [];
  const FlushEditor = vm.runInNewContext(script, {
    ...persistPolicy, console, editorViewCtx: 'view', serializerCtx: 'serializer', LEGACY_REST_FALLBACK: false,
    getMarkMetadataWithQuotes: () => metadata,
    mergePendingServerMarks: (local: unknown) => local,
    getCurrentActor: () => 'human:Alice',
    collabClient: { setMarksMetadata() {} },
    shareClient: { pushUpdate: (markdown: string, marks: Record<string, unknown>) => writes.push({ markdown, marks }) },
  });
  const editor = new FlushEditor();
  Object.assign(editor, {
    isShareMode: true, initialMarksSynced: true, collabEnabled: true, collabCanEdit: true,
    hasCompletedInitialCollabHydration: true, hasLocalContentEditSinceHydration: true,
    collabConnectionStatus: 'disconnected', collabIsSynced: true,
    collabUnsyncedChanges: 0, collabPendingLocalUpdates: 0,
    lastReceivedServerMarks: metadata, publishProjectionMarkdown() {},
    editor: { action: (fn: (ctx: unknown) => void) => fn({
      get: (key: string) => key === 'view' ? { state: { doc } } : () => serialized,
    }) },
  });
  editor.flushShareMarks({ keepalive: true, persistContent: true });
  assert.equal(writes.length, 1);
  assert.match(writes[0].markdown, /data-by="human:Alice"/);
  assert.match(writes[0].markdown, /data-by="ai:Claude"/);
  db.createDocument('reload-authorship', markdown, metadata, 'Reload authorship test');
  const result = await mutateCanonicalDocument({
    slug: 'reload-authorship', nextMarkdown: writes[0].markdown, nextMarks: writes[0].marks,
    source: 'rest-put', strictLiveDoc: false,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const saved = db.getDocumentBySlug('reload-authorship')!;
  const marks = Object.values(JSON.parse(saved.marks)) as any[];
  assert.ok(marks.some(m => m.by === 'human:Alice' && m.quote === 'Human paragraph.'));
  assert.ok(marks.some(m => m.by === 'ai:Claude' && m.quote === 'Agent contribution.'));
  console.log('PASS: browser reload saves preserve human and agent authorship through canonical persistence');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
