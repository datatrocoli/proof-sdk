import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the actual editor methods without importing the UI entry point (which
// mounts the full editor as a side effect). No desktop/native bridge is supplied.
const source = ts.createSourceFile('editor.ts', readFileSync('src/editor/index.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const editorClass = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'ProofEditorImpl') as ts.ClassDeclaration;
const names = ['markAccept', 'markReject', 'markAcceptAll', 'markRejectAll', 'showSuggestionReviewError', 'showSavedReviewRefreshError'];
const methods = editorClass.members.filter(member => ts.isMethodDeclaration(member)
  && names.includes(member.name.getText(source))).map(member => member.getText(source));
assert.equal(methods.length, names.length);
const script = ts.transpileModule(`class ReviewEditor { ${methods.join('\n')} }\nReviewEditor;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function harness(options: { shared?: boolean; failure?: 'network' | 'server' | 'refresh' } = {}) {
  const calls: string[] = [];
  const banners: Array<{ message: string; retryLabel?: string; onRetry?: () => void }> = [];
  const view = { state: { marks: [{ id: 'proposal', status: 'pending' }] } };
  const serverMarks = { author: { kind: 'authored', by: 'ai:reviewer', quote: 'Accepted contribution.' } };
  let applications = 0, reloads = 0;
  const submit = async (action: string) => {
    calls.push(action);
    if (options.failure === 'network') throw new Error('Connection lost');
    if (options.failure === 'server') return { error: { status: 500, code: 'SAVE_FAILED' } };
    return { success: true, marks: serverMarks };
  };
  const ReviewEditor = vm.runInNewContext(script, {
    console: { log() {}, warn() {}, error() {} },
    window: { location: { reload() { reloads++; } } },
    editorViewCtx: 'view', parserCtx: 'parser',
    getCurrentActor: () => 'human:Reviewer',
    getMarks: (state: typeof view.state) => state.marks,
    getPendingSuggestions: (marks: typeof view.state.marks) => marks.filter(m => m.status === 'pending'),
    applyRemoteMarks: () => {
      if (options.failure === 'refresh') throw new Error('View refresh failed');
      applications++;
    },
    shareClient: { acceptSuggestion: () => submit('accept'), rejectSuggestion: () => submit('reject') },
    captureEvent() {}, acceptMark: () => true, rejectMark: () => true, acceptAll: () => 1, rejectAll: () => 1,
  });
  const editor = new ReviewEditor();
  Object.assign(editor, {
    isShareMode: options.shared !== false,
    collabCanEdit: true,
    editor: { action: (fn: (ctx: unknown) => void) => fn({ get: () => view }) },
    clearErrorBanner: () => { banners.length = 0; },
    showErrorBanner: (message: string, retry: object) => banners.push({ message, ...retry }),
  });
  return { editor, calls, banners, serverMarks, applications: () => applications, reloads: () => reloads };
}

const settled = () => new Promise(resolve => setImmediate(resolve));
for (const method of ['markAccept', 'markReject', 'markAcceptAll']) {
  const h = harness();
  assert.ok(h.editor[method]('proposal'));
  await settled();
  assert.equal(h.calls.length, 1);
  assert.equal(h.applications(), 1);
  assert.deepEqual(h.banners, [], `${method} must complete successfully without a native bridge`);
  assert.equal(h.editor.initialMarksSynced, true);
  assert.equal(h.editor.lastReceivedServerMarks.author, h.serverMarks.author);
}
for (const method of ['markAccept', 'markAcceptAll', 'markRejectAll']) {
  const h = harness({ shared: false });
  assert.ok(h.editor[method]('proposal'), `${method} must also work in the standalone web editor`);
  assert.equal(h.calls.length, 0);
}
for (const method of ['markAccept', 'markReject']) {
  for (const failure of ['server', 'network', 'refresh'] as const) {
    const h = harness({ failure });
    h.editor[method]('proposal');
    await settled();
    assert.equal(h.banners.length, 1);
    if (failure === 'refresh') {
      assert.match(h.banners[0].message, /and saved\. Reload/);
      assert.equal(h.banners[0].retryLabel, 'Reload');
      h.banners[0].onRetry!();
      assert.equal(h.reloads(), 1);
      assert.equal(h.calls.length, 1, 'A display failure must not submit the review a second time');
    } else {
      assert.match(h.banners[0].message, /Could not (accept|reject) suggestion/);
      assert.equal(h.banners[0].retryLabel, 'Retry');
      assert.equal(h.applications(), 0);
    }
  }
}
console.log('PASS: browser review callbacks finish without a native bridge and distinguish save failures from display failures');
