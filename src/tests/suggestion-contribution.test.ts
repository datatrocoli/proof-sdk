import assert from 'node:assert/strict';
import { Schema } from '@milkdown/kit/prose/model';
import { EditorState, Plugin } from '@milkdown/kit/prose/state';
import { setCurrentActor } from '../editor/actor.js';
import { wrapTransactionForSuggestions } from '../editor/plugins/suggestions.js';
import { accept, reject, applyRemoteMarks, mergePendingServerMarks, getMarks, getInsertionReviewGroup, marksPluginKey } from '../editor/plugins/marks.js';
import { finalizeSuggestionThroughRehydration } from '../../server/proof-mark-rehydration.js';

const schema = new Schema({
  nodes: { doc: { content: 'paragraph+' }, paragraph: { content: 'text*' }, text: {} },
  marks: {
    proofSuggestion: { inclusive: false, attrs: { id: {}, by: {}, kind: {}, content: { default: null }, status: { default: 'pending' }, createdAt: { default: null } } },
    proofAuthored: { attrs: { id: { default: null }, by: {} } },
    em: {},
  },
});
const paragraph = (text = '') => schema.node('paragraph', null, text ? schema.text(text) : []);
function editor(doc = schema.node('doc', null, [paragraph()]), metadata = {}) {
  let state = EditorState.create({ schema, doc, plugins: [new Plugin({
    key: marksPluginKey,
    state: { init: () => ({ metadata, activeMarkId: null }), apply: (tr, value) => {
      const update = tr.getMeta(marksPluginKey);
      return update?.type === 'SET_METADATA' ? { ...value, metadata: update.metadata } : value;
    } },
  })] });
  return { get state() { return state; }, dispatch(tr: any) { state = state.apply(tr); } } as any;
}
const pending = (view: any) => getMarks(view.state).filter(mark => mark.kind === 'insert');
const originalNow = Date.now;
let clock = originalNow();
Date.now = () => clock;
try {
  setCurrentActor('human:Daniel');
  let view = editor();
  for (const character of 'Uma contribuição completa') {
    clock += 2000; // A human pause must not create a new contribution.
    const pos = view.state.doc.content.size - 1;
    view.dispatch(wrapTransactionForSuggestions(view.state.tr.insertText(character, pos), view.state, true));
  }
  assert.equal(pending(view).length, 1, 'slow typing stays one suggestion');
  assert.equal(pending(view)[0].data.content, 'Uma contribuição completa');
  const id = pending(view)[0].id;
  // Reconnect with serialized inline attributes, without a process-local cache.
  view = editor(schema.nodeFromJSON(view.state.doc.toJSON()));
  clock += 60000;
  let end = view.state.doc.content.size - 1;
  view.dispatch(wrapTransactionForSuggestions(view.state.tr.insertText('.', end), view.state, true));
  assert.equal(pending(view).length, 1);
  assert.equal(pending(view)[0].id, id);
  // Composition/correction inside a pending contribution preserves its identity.
  view.dispatch(wrapTransactionForSuggestions(view.state.tr.insertText('u', 1, 2), view.state, true));
  assert.equal(pending(view).length, 1);
  assert.equal(pending(view)[0].data.content, 'uma contribuição completa.');
  end = view.state.doc.content.size - 1;
  view.dispatch(wrapTransactionForSuggestions(view.state.tr.delete(end - 1, end), view.state, true));
  assert.equal(pending(view)[0].data.content, 'uma contribuição completa');
  assert.ok(accept(view, id));
  assert.equal(view.state.doc.textContent, 'uma contribuição completa');
  assert.equal(pending(view).length, 0);

  const piece = (id: string, text: string, by = 'human:Daniel') => schema.text(text, [
    schema.marks.proofSuggestion.create({ id, kind: 'insert', by, content: text[0] }),
    schema.marks.em.create(),
  ]);
  const fragmented = schema.node('doc', null, [
    schema.node('paragraph', null, [piece('old-1', 'Vamos'), schema.text(' '), piece('old-2', 'testar'), schema.text(' '), piece('old-3', 'a inclusão'), piece('other', ' Other author.', 'human:Other')]),
    schema.node('paragraph', null, [piece('next-paragraph', 'Separate paragraph.')]),
  ]);
  for (const action of [accept, reject]) {
    const legacy = editor(fragmented);
    assert.deepEqual(getInsertionReviewGroup(legacy.state, 'old-2')?.ids, ['old-1', 'old-2', 'old-3']);
    assert.equal(getInsertionReviewGroup(legacy.state, 'old-2')?.content, 'Vamos testar a inclusão');
    assert.ok(action(legacy, 'old-2'));
    assert.deepEqual(pending(legacy).map(mark => mark.id), ['other', 'next-paragraph']);
    assert.equal(legacy.state.doc.textContent, action === accept
      ? 'Vamos testar a inclusão Other author.Separate paragraph.'
      : ' Other author.Separate paragraph.');
    if (action === accept) assert.ok(legacy.state.doc.firstChild!.firstChild!.marks.some((m: any) => m.type.name === 'em'), 'accept preserves formatting');
  }
  const original = schema.node('doc', null, [schema.node('paragraph', null, [piece('left', 'Left'), schema.text(' original '), piece('right', 'Right')])]);
  assert.deepEqual(getInsertionReviewGroup(editor(original).state, 'left')?.ids, ['left'], 'unmarked text separates contributions');

  const remote = editor(schema.node('doc', null, [schema.node('paragraph', null, [piece('remote-finalized', 'Accepted text')])]));
  applyRemoteMarks(remote, { 'remote-finalized': { kind: 'insert', by: 'human:Daniel', status: 'accepted' } });
  assert.equal(pending(remote).length, 0);
  assert.equal(remote.state.doc.textContent, 'Accepted text');
  const stale = { 'remote-finalized': { kind: 'insert' as const, by: 'human:Daniel', status: 'pending' as const, quote: 'Accepted text', content: 'A' } };
  assert.equal(mergePendingServerMarks({}, stale)['remote-finalized'], undefined);
  applyRemoteMarks(remote, stale);
  assert.equal(pending(remote).length, 0, 'late metadata must not resurrect an explicitly finalized suggestion');

  // Shared review uses the same grouping after the server rehydrates metadata.
  const markdown = '<span data-proof="suggestion" data-id="server-1" data-kind="insert" data-by="human:Daniel">Full </span><span data-proof="suggestion" data-id="server-2" data-kind="insert" data-by="human:Daniel">contribution.</span>';
  for (const action of ['accept', 'reject'] as const) {
    const first = `server-${action}-1`, second = `server-${action}-2`;
    const orphanedComment = { kind: 'comment' as const, by: 'human:Reviewer', text: 'Keep this thread.',
      quote: 'A passage removed earlier.', resolved: false, range: { from: 500, to: 530 } };
    const result = await finalizeSuggestionThroughRehydration({ markdown: markdown.replaceAll('server-1', first).replaceAll('server-2', second), marks: {
      orphanedComment,
      [first]: { kind: 'insert', by: 'human:Daniel', status: 'pending', content: 'F', quote: 'Full ', startRel: 'char:0', endRel: 'char:5' },
      [second]: { kind: 'insert', by: 'human:Daniel', status: 'pending', content: 'c', quote: 'contribution.', startRel: 'char:5', endRel: 'char:18' },
    }, markId: second, action });
    assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual(result.resolvedMarkIds, [first, second]);
    assert.ok(!result.marks[first] && !result.marks[second]);
    assert.equal(result.marks.orphanedComment.text, orphanedComment.text, 'Unanchored comment threads survive unrelated review');
    assert.equal(result.marks.orphanedComment.resolved, false);
    assert.equal(result.repairedStrippedMarkdown.trim(), action === 'accept' ? 'Full contribution.' : '');
  }
  const missingTarget = await finalizeSuggestionThroughRehydration({ markdown: 'Existing text.', marks: {
    lost: { kind: 'insert', by: 'human:Test', status: 'pending', quote: 'Missing contribution.', content: 'Missing contribution.' },
  }, markId: 'lost', action: 'accept' });
  assert.equal(missingTarget.ok, false, 'Review still refuses a target that cannot be located');
  console.log('PASS: paused typing, reconnects, accents, grouped review, formatting and shared acceptance/rejection');
} finally { Date.now = originalNow; }
