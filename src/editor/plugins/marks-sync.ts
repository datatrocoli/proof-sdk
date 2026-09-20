import { $prose } from '@milkdown/kit/utils';
import { Plugin } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';

import { getMarks, marksPluginKey } from './marks';
import type { Mark, StoredMark } from './marks';

export const marksSyncPlugin = (
  onMarksChange?: (marks: Mark[], view: EditorView, actionMetadata: Record<string, StoredMark>) => void
) =>
  $prose(() => {
    return new Plugin({
      view() {
        let lastActionMetadataJSON = '';

        return {
          update(view) {
            const pluginState = marksPluginKey.getState(view.state);
            if (!pluginState) return;

            const rawMetadata = pluginState.metadata ?? {};
            const actionMetadata: Record<string, StoredMark> = {};
            for (const [id, entry] of Object.entries(rawMetadata)) {
              if (!entry || typeof entry !== 'object') continue;
              if (entry.kind === 'authored') continue;
              if (entry.kind === 'comment') {
                const body = typeof entry.text === 'string' ? entry.text.trim() : '';
                if (!body) continue;
              }
              actionMetadata[id] = entry as StoredMark;
            }
            const actionMetadataJSON = JSON.stringify(actionMetadata);

            if (actionMetadataJSON !== lastActionMetadataJSON) {
              lastActionMetadataJSON = actionMetadataJSON;
              const actionMarks = getMarks(view.state).filter(mark => mark.kind !== 'authored');
              onMarksChange?.(actionMarks, view, actionMetadata);
            }
          }
        };
      }
    });
  });
