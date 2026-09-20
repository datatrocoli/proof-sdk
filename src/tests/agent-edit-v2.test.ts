import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  const dbName = `proof-agent-edit-v2-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);

  const prevDatabasePath = process.env.DATABASE_PATH;
  const prevProofEnv = process.env.PROOF_ENV;
  const prevNodeEnv = process.env.NODE_ENV;
  const prevDbEnvInit = process.env.PROOF_DB_ENV_INIT;

  process.env.DATABASE_PATH = dbPath;
  process.env.PROOF_ENV = 'development';
  process.env.NODE_ENV = 'development';
  delete process.env.PROOF_DB_ENV_INIT;

  const db = await import('../../server/db.ts');
  const { applyAgentEditV2 } = await import('../../server/agent-edit-v2.ts');
  const { stripAllProofSpanTags } = await import('../../server/proof-span-strip.ts');

  try {
    const slug = `editv2-${Math.random().toString(36).slice(2, 10)}`;
    const markdown = ['# Title', '', 'First paragraph.', '', 'Second paragraph.'].join('\n');

    db.createDocument(slug, markdown, {}, 'Edit v2 test');

    let doc = db.getDocumentBySlug(slug)!;
    assert(doc.revision === 1, 'Expected initial revision 1');

    // replace_block
    let result = await applyAgentEditV2(slug, {
      by: 'ai:test',
      baseRevision: doc.revision,
      operations: [
        { op: 'replace_block', ref: 'b2', block: { markdown: 'Replaced paragraph.' } },
      ],
    });
    assert(result.status === 200, `Expected replace_block 200, got ${result.status}`);

    doc = db.getDocumentBySlug(slug)!;
    assert(doc.revision === 2, 'Expected revision to increment after replace_block');
    assert(doc.markdown.includes('Replaced paragraph.'), 'Expected markdown to include replaced paragraph');

    // insert_after
    result = await applyAgentEditV2(slug, {
      baseRevision: doc.revision,
      operations: [
        { op: 'insert_after', ref: 'b2', blocks: [{ markdown: 'Inserted after.' }] },
      ],
    });
    assert(result.status === 200, `Expected insert_after 200, got ${result.status}`);

    doc = db.getDocumentBySlug(slug)!;
    assert(doc.revision === 3, 'Expected revision to increment after insert_after');
    assert(doc.markdown.includes('Inserted after.'), 'Expected markdown to include inserted block');

    // insert_before
    result = await applyAgentEditV2(slug, {
      baseRevision: doc.revision,
      operations: [
        { op: 'insert_before', ref: 'b1', blocks: [{ markdown: 'Preface paragraph.' }] },
      ],
    });
    assert(result.status === 200, `Expected insert_before 200, got ${result.status}`);

    doc = db.getDocumentBySlug(slug)!;
    assert(doc.revision === 4, 'Expected revision to increment after insert_before');
    assert(stripAllProofSpanTags(doc.markdown).startsWith('Preface paragraph.'), 'Expected preface to be first block, including when wrapped with authorship');

    // delete_block
    result = await applyAgentEditV2(slug, {
      baseRevision: doc.revision,
      operations: [
        { op: 'delete_block', ref: 'b2' },
      ],
    });
    assert(result.status === 200, `Expected delete_block 200, got ${result.status}`);

    doc = db.getDocumentBySlug(slug)!;
    assert(doc.revision === 5, 'Expected revision to increment after delete_block');
    assert(!doc.markdown.includes('Preface paragraph.\n\n# Title'), 'Expected preface block to be removed');

    // replace_range
    result = await applyAgentEditV2(slug, {
      baseRevision: doc.revision,
      operations: [
        { op: 'replace_range', fromRef: 'b2', toRef: 'b3', blocks: [{ markdown: 'Range replacement.' }] },
      ],
    });
    assert(result.status === 200, `Expected replace_range 200, got ${result.status}`);

    doc = db.getDocumentBySlug(slug)!;
    assert(doc.revision === 6, 'Expected revision to increment after replace_range');
    assert(doc.markdown.includes('Range replacement.'), 'Expected range replacement to appear');

    // find_replace_in_block
    result = await applyAgentEditV2(slug, {
      baseRevision: doc.revision,
      operations: [
        { op: 'find_replace_in_block', ref: 'b2', find: 'Range', replace: 'Block', occurrence: 'first' },
      ],
    });
    assert(result.status === 200, `Expected find_replace_in_block 200, got ${result.status}`);

    doc = db.getDocumentBySlug(slug)!;
    assert(doc.revision === 7, 'Expected revision to increment after find_replace_in_block');
    assert(doc.markdown.includes('Block replacement.'), 'Expected find/replace to update block');

    // invalid ref
    result = await applyAgentEditV2(slug, {
      baseRevision: doc.revision,
      operations: [
        { op: 'delete_block', ref: 'b99' },
      ],
    });
    assert(result.status === 400, `Expected invalid ref 400, got ${result.status}`);
    assert(result.body.code === 'INVALID_REF', 'Expected INVALID_REF error code');

    // stale revision
    result = await applyAgentEditV2(slug, {
      baseRevision: 1,
      operations: [
        { op: 'delete_block', ref: 'b1' },
      ],
    });
    assert(result.status === 409, `Expected stale revision 409, got ${result.status}`);
    assert(result.body.code === 'STALE_REVISION', 'Expected STALE_REVISION error code');

    console.log('✓ agent edit v2 applies operations and handles errors');
  } finally {
    if (prevDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = prevDatabasePath;

    if (prevProofEnv === undefined) delete process.env.PROOF_ENV;
    else process.env.PROOF_ENV = prevProofEnv;

    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;

    if (prevDbEnvInit === undefined) delete process.env.PROOF_DB_ENV_INIT;
    else process.env.PROOF_DB_ENV_INIT = prevDbEnvInit;

    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(`${dbPath}${suffix}`);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
