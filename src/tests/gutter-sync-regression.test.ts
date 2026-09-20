import assert from 'node:assert/strict';
import { Schema } from '@milkdown/kit/prose/model';
import { EditorState, Plugin } from '@milkdown/kit/prose/state';
import * as Y from 'yjs';
import { applyRemoteMarks, getMarks, marksPluginKey } from '../editor/plugins/marks';
import { getAuthoredBlockColor } from '../editor/plugins/heatmap-decorations';
import { getMarkColor, type StoredMark } from '../formats/marks';

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'text*' },
    text: {},
  },
  marks: {
    proofAuthored: { attrs: { id: { default: null }, by: { default: 'unknown' } } },
  },
});
const authored = (id: string, by: string) => schema.marks.proofAuthored.create({ id, by });
let state = EditorState.create({
  schema,
  doc: schema.node('doc', null, [schema.node('paragraph', null, [
    schema.text('Human text. ', [authored('live-human', 'human:Daniel')]),
    schema.text('AI text.', [authored('live-ai', 'ai:Research')]),
    schema.text(' Unknown text.'),
  ])]),
  plugins: [new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({ metadata: {}, activeMarkId: null }),
      apply: (tr, previous) => {
        const meta = tr.getMeta(marksPluginKey);
        return meta?.type === 'SET_METADATA' ? { ...previous, metadata: meta.metadata } : previous;
      },
    },
  })],
});
let dispatches = 0;
const view = {
  get state() { return state; },
  dispatch(tr: any) { dispatches++; state = state.apply(tr); },
} as any;

// Legacy quotes overlap each other and text already carrying live provenance.
// Replaying them used to replace IDs/authors on every pass.
const stale: Record<string, StoredMark> = {
  staleAI: { kind: 'authored', by: 'ai:Old', quote: 'Human text.' },
  staleHuman: { kind: 'authored', by: 'human:Old', quote: 'AI text.' },
  backfill: { kind: 'authored', by: 'human:Daniel', quote: 'Unknown text.' },
  overlap: { kind: 'authored', by: 'ai:Old', quote: 'Unknown text.' },
};
applyRemoteMarks(view, stale);
const afterHydration = state.doc;
assert.equal(getMarks(state).find(m => m.id === 'live-human')?.by, 'human:Daniel');
assert.equal(getMarks(state).find(m => m.id === 'live-ai')?.by, 'ai:Research');
assert.equal(getMarks(state).find(m => m.id === 'backfill')?.by, 'human:Daniel');
const dispatchesAfterHydration = dispatches;
for (let i = 0; i < 50; i++) applyRemoteMarks(view, stale);
assert.ok(state.doc.eq(afterHydration), 'repeated hydration must not change existing provenance');
assert.equal(dispatches, dispatchesAfterHydration, 'identical remote metadata must not dispatch again');

const color = (from: number, to: number) => getAuthoredBlockColor(from, to, new Map([
  ['authored', getMarks(state).filter(m => m.kind === 'authored').map(mark => ({
    mark, from: mark.range!.from, to: mark.range!.to,
  }))],
]));
assert.equal(color(1, 12), getMarkColor('human'));
assert.equal(color(13, 21), getMarkColor('ai'));
assert.equal(color(1, 21), getMarkColor('human'), 'mixed blocks keep the majority recorded author');
assert.equal(color(80, 100), null, 'unrecorded authorship must not be labelled AI');
assert.equal(color(1, 100), getMarkColor('human'), 'unmarked text must not outweigh recorded authors');

// Exercise the same callback path as a real Yjs update. Observers must run
// after Yjs finishes its update, not reenter it through editor hydration.
// ShareClient detects the page at module load. Supply a non-share page for
// this headless test, then restore the Node environment.
(globalThis as any).window = { location: { pathname: '/', search: '' } };
const { CollabClient } = await import('../bridge/collab-client');
delete (globalThis as any).window;
const client = new CollabClient();
const internals = client as any;
internals.durableUpdatesEnabled = true;
internals.durableBufferKey = 'test-only';
const ydoc = new Y.Doc();
let inYjsUpdate = false;
let statuses = 0;
client.onSyncStatus(() => {
  assert.equal(inYjsUpdate, false, 'status callbacks must not reenter Yjs cleanup');
  statuses++;
  applyRemoteMarks(view, stale);
});
ydoc.on('update', update => {
  inYjsUpdate = true;
  try { internals.appendDurableUpdate(update); } finally { inYjsUpdate = false; }
});
ydoc.getText('test').insert(0, 'one');
ydoc.getText('test').insert(3, ' two');
assert.equal(statuses, 0);
await new Promise<void>(resolve => queueMicrotask(resolve));
assert.equal(statuses, 1, 'status updates in a transaction burst are coalesced');
assert.equal(dispatches, dispatchesAfterHydration);
client.disconnect();
ydoc.destroy();
console.log('PASS: gutter colors, provenance hydration and deferred Yjs status updates');
