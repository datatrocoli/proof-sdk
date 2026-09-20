/**
 * Suggestions Plugin for Milkdown
 *
 * Converts edits into proofSuggestion marks + PROOF metadata
 * when suggestions mode is enabled.
 */

import { $ctx, $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state';
import type { MarkType, Node as ProseMirrorNode } from '@milkdown/kit/prose/model';

import { marksPluginKey, getMarkMetadata, buildSuggestionMetadata, getMarks } from './marks';
import { generateMarkId, type MarkRange } from '../../formats/marks';
import { getCurrentActor } from '../actor';

// Suggestion state
export interface SuggestionState {
  enabled: boolean;
}

// Plugin key for accessing state
export const suggestionsPluginKey = new PluginKey<SuggestionState>('suggestions');

// Context to store suggestion state
export const suggestionsCtx = $ctx<SuggestionState, 'suggestions'>({ enabled: false }, 'suggestions');

type SuggestionKind = 'insert' | 'delete' | 'replace';

type SliceNode = {
  type?: string;
  text?: string;
  content?: SliceNode[];
};

function normalizeSuggestionKind(kind: unknown): SuggestionKind {
  if (kind === 'insert' || kind === 'delete' || kind === 'replace') return kind;
  return 'replace';
}

function getCoalescableInsertCandidate(state: EditorState, pos: number, by: string): { id: string; range: MarkRange } | null {
  // A pending insertion is one contribution, even after a pause or reconnect.
  // Use the actual inline anchor beside the cursor, not a process-global timer.
  const $pos = state.doc.resolve(pos);
  for (const node of [$pos.nodeBefore, $pos.nodeAfter]) {
    const anchor = node?.marks.find(mark => mark.type.name === 'proofSuggestion'
      && mark.attrs.kind === 'insert' && mark.attrs.by === by);
    if (!anchor) continue;
    const match = getMarks(state).find(mark => mark.id === anchor.attrs.id && mark.kind === 'insert');
    if (!match?.range || (match.data as { status?: string })?.status !== 'pending') continue;
    if (match.range.from <= pos && pos <= match.range.to) return { id: match.id, range: match.range };
  }
  return null;
}

function collectSliceText(nodes?: SliceNode[]): { text: string; hasNonText: boolean } {
  let text = '';
  let hasNonText = false;

  if (!nodes) return { text, hasNonText };

  for (const node of nodes) {
    if (node.text) {
      text += node.text;
    }
    if (node.type && node.type !== 'text') {
      hasNonText = true;
    }
    if (node.content) {
      const child = collectSliceText(node.content);
      text += child.text;
      if (child.hasNonText) hasNonText = true;
    }
  }

  return { text, hasNonText };
}

function detectSuggestionKinds(
  doc: ProseMirrorNode,
  from: number,
  to: number,
  suggestionType: MarkType
): { hasInsert: boolean; hasDelete: boolean; hasReplace: boolean } {
  const found = { hasInsert: false, hasDelete: false, hasReplace: false };

  doc.nodesBetween(from, to, (node) => {
    if (!node.isText) return true;
    for (const mark of node.marks) {
      if (mark.type !== suggestionType) continue;
      const kind = normalizeSuggestionKind(mark.attrs.kind);
      if (kind === 'insert') found.hasInsert = true;
      if (kind === 'delete') found.hasDelete = true;
      if (kind === 'replace') found.hasReplace = true;
    }
    return !(found.hasInsert && found.hasDelete && found.hasReplace);
  });

  return found;
}

/**
 * Wrap a transaction to convert edits to suggestions when enabled.
 * This intercepts the transaction and converts direct edits into tracked changes:
 * - Insertions get marked with proofSuggestion kind=insert
 * - Deletions get marked with proofSuggestion kind=delete instead of being removed
 * - Replacements become proofSuggestion kind=replace with content stored in metadata
 */
export function wrapTransactionForSuggestions(
  tr: Transaction,
  state: EditorState,
  enabled: boolean
): Transaction {
  if (!enabled || !tr.docChanged) {
    return tr;
  }
  if (tr.getMeta('y-sync$')) {
    return tr;
  }

  const suggestionType = state.schema.marks.proofSuggestion;

  if (!suggestionType) {
    console.warn('[suggestions] Missing proofSuggestion mark type');
    return tr;
  }

  // Check for structural changes (paragraph splits, etc). Pass through unchanged.
  for (const step of tr.steps) {
    const stepJson = step.toJSON() as { stepType?: string; slice?: { content?: SliceNode[] } };
    if (stepJson.stepType === 'replace' && stepJson.slice?.content) {
      const { hasNonText } = collectSliceText(stepJson.slice.content);
      if (hasNonText) {
        return tr;
      }
    }
  }

  const actor = getCurrentActor();
  let metadata = getMarkMetadata(state);
  let metadataChanged = false;

  // Build a new transaction that converts edits to tracked changes.
  const newTr = state.tr;
  let writeOffset = 0;

  for (const step of tr.steps) {
    const stepJson = step.toJSON() as {
      stepType?: string;
      from?: number;
      to?: number;
      slice?: { content?: SliceNode[] };
    };

    if (stepJson.stepType === 'replace') {
      const origFrom = stepJson.from ?? 0;
      const origTo = stepJson.to ?? 0;
      const from = origFrom + writeOffset;
      const to = origTo + writeOffset;
      const slice = stepJson.slice;

      const { text: insertedText } = collectSliceText(slice?.content);
      const deletedText = state.doc.textBetween(origFrom, origTo, '');

      const docSize = newTr.doc.content.size;
      const safeFrom = Math.max(0, Math.min(from, docSize));
      const safeTo = Math.max(safeFrom, Math.min(to, docSize));

      // CASE 1: Pure deletion (no insertion)
      if (deletedText && !insertedText) {
        const existing = detectSuggestionKinds(newTr.doc, safeFrom, safeTo, suggestionType);

        if (existing.hasDelete || existing.hasInsert) {
          // Already tracked: accept deletion or reject insertion
          newTr.delete(safeFrom, safeTo);
          writeOffset -= deletedText.length;
        } else if (existing.hasReplace) {
          // Remove replace suggestion and keep content
          newTr.removeMark(safeFrom, safeTo, suggestionType);
        } else {
          const suggestionId = generateMarkId();
          const createdAt = new Date().toISOString();

          newTr.addMark(safeFrom, safeTo, suggestionType.create({
            id: suggestionId,
            kind: 'delete',
            by: actor,
          }));

          metadata = {
            ...metadata,
            [suggestionId]: buildSuggestionMetadata('delete', actor, null, createdAt),
          };
          metadataChanged = true;

          // Move cursor to start of deletion (don't leave it inside deleted text)
          newTr.setSelection(TextSelection.create(newTr.doc, safeFrom));
        }
      }
      // CASE 2: Pure insertion (no deletion)
      else if (insertedText && !deletedText) {
        const candidate = getCoalescableInsertCandidate(state, safeFrom, actor);
        const id = candidate?.id ?? generateMarkId();
        const entry = metadata[id] ?? buildSuggestionMetadata('insert', actor, insertedText, new Date().toISOString());
        newTr.insertText(insertedText, safeFrom);
        const range = candidate
          ? { from: candidate.range.from, to: candidate.range.to + insertedText.length }
          : { from: safeFrom, to: safeFrom + insertedText.length };
        const content = newTr.doc.textBetween(range.from, range.to, '\n');
        metadata = { ...metadata, [id]: { ...entry, content, status: 'pending' } };
        newTr.addMark(range.from, range.to, suggestionType.create({
          ...entry, id, kind: 'insert', by: actor, content, status: 'pending',
        }));
        metadataChanged = true;
        writeOffset += insertedText.length;
      }
      // CASE 3: Replacement (deletion + insertion)
      else if (deletedText && insertedText) {
        const existing = detectSuggestionKinds(newTr.doc, safeFrom, safeTo, suggestionType);

        if (existing.hasDelete) {
          // Accept deletion and re-insert as an insertion suggestion.
          newTr.delete(safeFrom, safeTo);
          writeOffset -= deletedText.length;

          const suggestionId = generateMarkId();
          const createdAt = new Date().toISOString();
          newTr.insertText(insertedText, safeFrom);
          newTr.addMark(
            safeFrom,
            safeFrom + insertedText.length,
            suggestionType.create({ id: suggestionId, kind: 'insert', by: actor })
          );
          writeOffset += insertedText.length;

          metadata = {
            ...metadata,
            [suggestionId]: buildSuggestionMetadata('insert', actor, insertedText, createdAt),
          };
          metadataChanged = true;
        } else if (existing.hasInsert) {
          // Replace inside a pending insertion - keep it as an insertion suggestion.
          const candidate = getCoalescableInsertCandidate(state, safeFrom, actor);
          const suggestionId = candidate && safeTo <= candidate.range.to ? candidate.id : generateMarkId();
          const entry = metadata[suggestionId] ?? buildSuggestionMetadata('insert', actor, insertedText, new Date().toISOString());
          newTr.replaceWith(safeFrom, safeTo, state.schema.text(insertedText));
          const range = candidate && suggestionId === candidate.id
            ? { from: candidate.range.from, to: candidate.range.to + insertedText.length - deletedText.length }
            : { from: safeFrom, to: safeFrom + insertedText.length };
          const content = newTr.doc.textBetween(range.from, range.to, '\n');
          newTr.addMark(range.from, range.to, suggestionType.create({
            ...entry, id: suggestionId, kind: 'insert', by: actor, content, status: 'pending',
          }));
          writeOffset += insertedText.length - deletedText.length;
          metadata = { ...metadata, [suggestionId]: { ...entry, content, status: 'pending' } };
          metadataChanged = true;
        } else {
          // Replace: keep original text, store replacement content in metadata.
          const suggestionId = generateMarkId();
          const createdAt = new Date().toISOString();

          newTr.removeMark(safeFrom, safeTo, suggestionType);
          newTr.addMark(safeFrom, safeTo, suggestionType.create({
            id: suggestionId,
            kind: 'replace',
            by: actor,
          }));

          metadata = {
            ...metadata,
            [suggestionId]: buildSuggestionMetadata('replace', actor, insertedText, createdAt),
          };
          metadataChanged = true;

          newTr.setSelection(TextSelection.create(newTr.doc, safeTo));
        }
      }
      // CASE 4: Structural-only change (e.g., paragraph join/split with no text content).
      // Both deletedText and insertedText are empty — this isn't a text edit.
      // Pass through directly and adjust writeOffset for any doc size change.
      else {
        try {
          const sizeBefore = newTr.doc.content.size;
          newTr.step(step);
          writeOffset += newTr.doc.content.size - sizeBefore;
        } catch (e) {
          console.warn('[suggestions] Could not apply structural step:', e);
        }
      }
    } else if (stepJson.stepType === 'replaceAround' || stepJson.stepType === 'addMark' || stepJson.stepType === 'removeMark') {
      // Pass through structural and mark changes directly
      try {
        newTr.step(step);
      } catch (e) {
        console.warn('[suggestions] Could not apply step:', stepJson.stepType, e);
      }
    } else {
      // For other step types, try to apply them directly
      try {
        const result = step.apply(newTr.doc);
        if (result.doc && result.doc !== newTr.doc) {
          const sizeDiff = result.doc.content.size - newTr.doc.content.size;
          newTr.step(step);
          writeOffset += sizeDiff;
        }
      } catch (e) {
        console.warn('[suggestions] Could not apply step:', stepJson.stepType, e);
      }
    }
  }

  if (metadataChanged) {
    newTr.setMeta(marksPluginKey, { type: 'SET_METADATA', metadata });
  }

  // Mark this transaction so authorship tracking skips it
  newTr.setMeta('suggestions-wrapped', true);

  return newTr;
}

/**
 * Check if suggestions are enabled
 */
export function isSuggestionsEnabled(state: EditorState): boolean {
  const pluginState = suggestionsPluginKey.getState(state);
  return pluginState?.enabled ?? false;
}

/**
 * Enable suggestions
 */
export function enableSuggestions(view: { state: EditorState; dispatch: (tr: Transaction) => void }): void {
  const tr = view.state.tr.setMeta(suggestionsPluginKey, { enabled: true });
  view.dispatch(tr);
}

/**
 * Disable suggestions
 */
export function disableSuggestions(view: { state: EditorState; dispatch: (tr: Transaction) => void }): void {
  const tr = view.state.tr.setMeta(suggestionsPluginKey, { enabled: false });
  view.dispatch(tr);
}

/**
 * Toggle suggestions
 */
export function toggleSuggestions(view: { state: EditorState; dispatch: (tr: Transaction) => void }): boolean {
  const enabled = isSuggestionsEnabled(view.state);
  if (enabled) {
    disableSuggestions(view);
  } else {
    enableSuggestions(view);
  }
  return !enabled;
}

/**
 * Create the suggestions plugin
 */
export const suggestionsPlugin = $prose(() => {
  return new Plugin<SuggestionState>({
    key: suggestionsPluginKey,

    state: {
      init(): SuggestionState {
        return { enabled: false };
      },

      apply(tr, value): SuggestionState {
        const meta = tr.getMeta(suggestionsPluginKey);
        if (meta !== undefined) {
          return { ...value, ...meta };
        }
        return value;
      },
    },

    appendTransaction(_trs, oldState, newState) {
      const wasEnabled = suggestionsPluginKey.getState(oldState)?.enabled ?? false;
      const isEnabled = suggestionsPluginKey.getState(newState)?.enabled ?? false;
      if (wasEnabled !== isEnabled) {
        // Emit bridge message on next microtask to avoid dispatch-in-dispatch
        queueMicrotask(() => {
          (window as any).proof?.bridge?.sendMessage('suggestionsChanged', { enabled: isEnabled });
        });
      }
      return null;
    },
  });
});

/**
 * Export all for use in editor
 */
export const suggestionsPlugins = [suggestionsCtx, suggestionsPlugin];
