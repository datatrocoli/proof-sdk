import * as Y from 'yjs';
import { listMarkTombstonesForDocument } from './db.js';

const cleanupOrigin = 'resolved-suggestion-cleanup';
const attached = new WeakSet<Y.Doc>();

// A disconnected client can replay both metadata and inline anchors long after
// a review. Its local cache cannot override the durable accepted/rejected event.
export function removeResolvedSuggestionReplay(slug: string, doc: Y.Doc): boolean {
  const retired = new Set(listMarkTombstonesForDocument(slug)
    .filter(row => row.status === 'accepted' || row.status === 'rejected')
    .map(row => row.mark_id));
  if (!retired.size) return false;
  const marks = doc.getMap('marks');
  const metadata = [...marks.keys()].filter(id => retired.has(id));
  const formats: Array<{ text: Y.XmlText; from: number; length: number; key: string }> = [];
  const visit = (node: Y.XmlFragment | Y.XmlElement | Y.XmlText): void => {
    if (node instanceof Y.XmlText) {
      let from = 0;
      for (const delta of node.toDelta()) {
        const length = typeof delta.insert === 'string' ? delta.insert.length : 1;
        for (const [key, value] of Object.entries(delta.attributes ?? {})) {
          if ((key === 'proofSuggestion' || key.startsWith('proofSuggestion--'))
            && value && typeof value === 'object' && 'id' in value
            && retired.has(String(value.id))) {
            formats.push({ text: node, from, length, key });
          }
        }
        from += length;
      }
    } else {
      for (const child of node.toArray()) visit(child);
    }
  };
  visit(doc.getXmlFragment('prosemirror'));
  if (!metadata.length && !formats.length) return false;
  doc.transact(() => {
    for (const id of metadata) marks.delete(id);
    for (const { text, from, length, key } of formats) text.format(from, length, { [key]: null });
  }, cleanupOrigin);
  return true;
}

export function trackResolvedSuggestionReplay(slug: string, doc: Y.Doc): void {
  if (!attached.has(doc)) {
    attached.add(doc);
    doc.on('afterTransaction', transaction => {
      if (transaction.origin === cleanupOrigin) return;
      if (!transaction.changedParentTypes.has(doc.getMap('marks'))
        && !transaction.changedParentTypes.has(doc.getXmlFragment('prosemirror'))) return;
      removeResolvedSuggestionReplay(slug, doc);
    });
  }
  // Also repair persisted stale anchors when a room is first loaded.
  removeResolvedSuggestionReplay(slug, doc);
}
