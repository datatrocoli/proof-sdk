import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildAgentInvite } from '../bridge/agent-invite.js';
import { createProofMcp } from '../../scripts/proof-mcp.mjs';

const dir = mkdtempSync(path.join(os.tmpdir(), 'proof-invite-'));
process.env.DATABASE_PATH = path.join(dir, 'test.db');
process.env.PROOF_ENV = 'test';
process.env.AGENT_EDIT_V2_ENABLED = '1';
const { apiRoutes } = await import('../../server/routes.js');
const { agentRoutes } = await import('../../server/agent-routes.js');
const { mountProofSdkRoutes } = await import('../../packages/doc-server/src/index.js');
const app = express();
app.use(express.json());
app.use('/api', apiRoutes);
app.use('/api/agent', agentRoutes);
mountProofSdkRoutes(app);
const http = createServer(app);
await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
const address = http.address() as { port: number };
const baseUrl = `http://127.0.0.1:${address.port}`;
const client = new Client({ name: 'new-agent-test', version: '1.0.0' });
const editingClient = new Client({ name: 'editing-agent-test', version: '1.0.0' });
try {
  async function post(route: string, body: unknown, token?: string) {
    return fetch(baseUrl + route, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'x-share-token': token } : {}) },
      body: JSON.stringify(body),
    });
  }
  const created = await (await post('/documents', { title: 'Invite test', markdown: 'Original sentence.' })).json();
  const { slug, accessToken } = created;
  assert.ok(slug && accessToken);
  const unauthenticated = await fetch(`${baseUrl}/documents/${slug}/state`);
  assert.equal(unauthenticated.status, 401);
  assert.throws(() => buildAgentInvite(`${baseUrl}/d/${slug}`), /access token/);

  // Model the tokenless address bar with a credential supplied by the server's
  // runtime config after cookie authentication. The invite must mint a new token.
  (globalThis as any).window = {
    location: { origin: baseUrl, pathname: `/d/${slug}`, search: '' },
    __PROOF_CONFIG__: { shareToken: accessToken },
  };
  const { ShareClient } = await import('../bridge/share-client.js');
  const share = new ShareClient();
  const link = await share.createAccessLink('commenter');
  assert.ok(link && !('error' in link), 'Create a review invitation from a tokenless document URL');
  assert.notEqual(link.accessToken, accessToken, 'Never forward the browser credential');
  const invitation = buildAgentInvite(link.webShareUrl);
  assert.ok(invitation.includes(`Bearer ${link.accessToken}`));
  assert.ok(!invitation.includes('<token-from-doc-url>'));
  assert.ok(invitation.includes('local MCP connector'));
  assert.ok(invitation.includes('Invitation role: commenter'));
  assert.ok(invitation.includes('Keep suggestions pending'));
  const editingLink = await share.createAccessLink('editor');
  assert.ok(editingLink && !('error' in editingLink));
  assert.notEqual(editingLink.accessToken, accessToken);
  assert.notEqual(editingLink.accessToken, link.accessToken);
  const editingInvitation = buildAgentInvite(editingLink.webShareUrl, 'editor');
  assert.ok(editingInvitation.includes('Invitation role: editor'));
  assert.ok(editingInvitation.includes('baseToken'));
  assert.ok(editingInvitation.includes('proof_edit'));
  assert.ok(!editingInvitation.includes('Keep suggestions pending'));

  // Regression: a plain document URL may have neither a query token nor a
  // cookie. The editable browser page must still be able to invite a reviewer.
  (globalThis as any).window.__PROOF_CONFIG__ = {};
  const tokenlessLink = await new ShareClient().createAccessLink('commenter');
  assert.ok(tokenlessLink && !('error' in tokenlessLink), 'Plain document links can invite a reviewer');
  assert.ok(buildAgentInvite(tokenlessLink.webShareUrl).includes(tokenlessLink.accessToken));
  for (const role of ['editor', 'viewer', 'owner_bot']) {
    assert.equal((await post(`/api/documents/${slug}/access-links`, { role })).status, 403,
      'Tokenless invitation must not mint other credentials');
  }
  for (const token of ['invalid-token', tokenlessLink.accessToken]) {
    assert.equal((await post(`/api/documents/${slug}/access-links`, { role: 'commenter' }, token)).status, 403,
      'Invalid and reviewer credentials must not fall back to anonymous invitation');
  }
  const viewer = await (await post(`/api/documents/${slug}/access-links`, { role: 'viewer' }, accessToken)).json();
  assert.equal((await post(`/api/documents/${slug}/access-links`, { role: 'commenter' }, viewer.accessToken)).status, 403);

  const unavailable = await (await post('/documents', { markdown: 'Unavailable invitation test.' })).json();
  const { pauseDocument, revokeDocument, deleteDocument } = await import('../../server/db.js');
  pauseDocument(unavailable.slug);
  assert.equal((await post(`/api/documents/${unavailable.slug}/access-links`, { role: 'commenter' })).status, 403);
  revokeDocument(unavailable.slug);
  assert.equal((await post(`/api/documents/${unavailable.slug}/access-links`, { role: 'commenter' })).status, 403);
  deleteDocument(unavailable.slug);
  assert.equal((await post(`/api/documents/${unavailable.slug}/access-links`, { role: 'commenter' })).status, 410);

  const config = { baseUrl, slug, token: tokenlessLink.accessToken, agentId: 'claude-test', name: 'Claude test' };
  assert.throws(() => createProofMcp({ ...config, baseUrl: 'https://example.com' }), /local server/);
  const configPath = path.join(dir, 'mcp.json');
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  // Exercise the same spawned stdio server that Claude Desktop launches.
  const clientTransport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve('scripts/proof-mcp.mjs')],
    env: { PROOF_MCP_CONFIG: configPath },
    stderr: 'inherit',
  });
  await client.connect(clientTransport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(),
    ['proof_comment', 'proof_edit', 'proof_events', 'proof_presence', 'proof_read', 'proof_snapshot', 'proof_suggest']);
  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, `${name} should succeed: ${JSON.stringify(result.content)}`);
    const content = result.content as Array<{ type: string; text: string }>;
    const text = content[0].text;
    assert.ok(!text.includes(config.token), 'Tool results must not expose the credential');
    return JSON.parse(text);
  }
  assert.match((await call('proof_read')).markdown, /Original sentence/);
  assert.equal((await call('proof_read')).accessRole, 'commenter');
  await call('proof_presence');
  await call('proof_comment', { quote: 'Original sentence.', text: 'A review comment.' });
  await call('proof_suggest', { quote: 'Original sentence.', content: 'Proposed sentence.' });
  const reviewed = await call('proof_read');
  const marks = Object.values(reviewed.marks) as Array<any>;
  assert.ok(marks.some((mark) => mark.kind === 'comment' && mark.by === 'ai:claude-test'));
  const suggestion = marks.find((mark) => mark.kind === 'replace');
  assert.equal(suggestion?.status, 'pending');
  assert.match(reviewed.markdown, /Original sentence/);
  assert.ok(!reviewed.markdown.includes('Proposed sentence.'));
  const denied = await post(`/documents/${slug}/ops`, {
    type: 'suggestion.accept', id: suggestion.id, by: 'ai:claude-test',
  }, config.token);
  assert.equal(denied.status, 403, 'The review token cannot approve its own suggestion');
  const acceptedPayload = { type: 'suggestion.add', kind: 'replace', status: 'accepted',
    quote: 'Original sentence.', content: 'Bypassed review.', by: 'ai:claude-test' };
  for (const route of [`/documents/${slug}/ops`, `/api/documents/${slug}/ops`,
    `/documents/${slug}/marks/suggest-replace`]) {
    const response = await post(route, acceptedPayload, config.token);
    assert.equal(response.status, 403,
      `Review access must reject immediately accepted suggestions at ${route}`);
  }
  for (const [role, token] of [['commenter', config.token], ['viewer', viewer.accessToken], ['editor', accessToken]]) {
    const state = await (await fetch(`${baseUrl}/documents/${slug}/state`, {
      headers: { 'x-share-token': token },
    })).json();
    const canEdit = role === 'editor';
    assert.equal(state.agent.auth.role, role);
    assert.equal(state.capabilities.canEdit, canEdit);
    assert.equal(state.capabilities.canReview, canEdit);
    assert.equal(state.capabilities.canSuggest, role !== 'viewer');
    assert.equal(state.capabilities.editV2, canEdit, 'State must not advertise direct editing to a review-only token');
    for (const name of ['edit', 'editV2', 'title']) {
      assert.equal(Boolean(state._links[name]), canEdit);
      assert.equal(Boolean(state.agent[name + 'Api']), canEdit);
    }
    assert.equal(Boolean(state._links.ops), role !== 'viewer');
    assert.ok(state._links.snapshot, 'Read-only roles retain snapshot access');
    for (const route of ['edit', 'edit/v2']) {
      // Empty operations are intentionally invalid: this probes authorization
      // without ever changing the test document through a direct-write path.
      const response = await post(`/documents/${slug}/${route}`, {}, token);
      const body = await response.json();
      if (canEdit) {
        assert.ok(response.status !== 401 && response.status !== 403);
      } else {
        assert.equal(response.status, 403);
        assert.equal(body.code, 'FORBIDDEN');
        assert.equal(body.role, role);
        assert.deepEqual(body.requiredRoles, ['editor', 'owner_bot']);
        assert.equal(body.acceptedHeaders, undefined, 'A role denial must not imply that another credential header is required');
      }
    }
  }
  for (const token of [undefined, 'invalid-token']) {
    for (const route of ['edit', 'edit/v2']) {
      const response = await post(`/documents/${slug}/${route}`, {}, token);
      assert.equal(response.status, 401, 'Missing/invalid credentials remain authentication failures');
      assert.equal((await response.json()).code, 'UNAUTHORIZED');
    }
  }
  assert.ok(!(await call('proof_read')).markdown.includes('Bypassed review.'));
  const reviewSnapshot = await call('proof_snapshot');
  const blockedEdit = await client.callTool({ name: 'proof_edit', arguments: {
    baseToken: reviewSnapshot.mutationBase.token,
    operations: [{ op: 'insert_after', ref: reviewSnapshot.blocks[0].ref, blocks: [{ markdown: 'Unauthorized direct edit.' }] }],
  } });
  assert.ok(blockedEdit.isError, 'MCP cannot bypass commenter permissions');
  assert.ok(!JSON.stringify(blockedEdit).includes(config.token));

  const editorConfigPath = path.join(dir, 'editor-mcp.json');
  writeFileSync(editorConfigPath, JSON.stringify({ ...config, token: editingLink.accessToken, agentId: 'editing-agent-test' }), { mode: 0o600 });
  await editingClient.connect(new StdioClientTransport({
    command: process.execPath, args: [path.resolve('scripts/proof-mcp.mjs')],
    env: { PROOF_MCP_CONFIG: editorConfigPath }, stderr: 'inherit',
  }));
  async function editorCall(name: string, args: Record<string, unknown> = {}) {
    const result = await editingClient.callTool({ name, arguments: args });
    assert.ok(!result.isError, `Editor ${name} failed: ${JSON.stringify(result.content)}`);
    const text = (result.content as Array<{ text: string }>)[0].text;
    assert.ok(!text.includes(editingLink.accessToken));
    return JSON.parse(text);
  }
  const editorState = await editorCall('proof_read');
  assert.equal(editorState.accessRole, 'editor');
  assert.equal(editorState.capabilities.canEdit, true);
  const snapshot = await editorCall('proof_snapshot');
  assert.equal(snapshot.revision, editorState.revision);
  assert.deepEqual(snapshot.contract, editorState.contract.editV2);
  assert.deepEqual(snapshot.contract.supportedPreconditions, ['baseToken', 'baseRevision']);
  assert.equal(snapshot.contract.preferredPrecondition, 'baseToken');
  const contribution = 'Direct contribution with agent authorship.';
  const edit = { baseToken: snapshot.mutationBase.token,
    operations: [{ op: 'insert_after', ref: snapshot.blocks[0].ref, blocks: [{ markdown: contribution }] }] };
  const edited = await editorCall('proof_edit', edit);
  assert.equal(edited.success, true);
  const directState = await editorCall('proof_read');
  assert.ok(directState.markdown.includes(contribution));
  assert.ok(!directState.markdown.includes('Unauthorized direct edit.'));
  assert.ok(Object.values(directState.marks).some((mark: any) => mark.kind === 'authored'
    && mark.by === 'ai:editing-agent-test' && mark.quote?.trim() === contribution), `Direct insertion retains exact agent authorship: ${JSON.stringify(directState.marks)}`);
  assert.ok(!Object.values(directState.marks).some((mark: any) => mark.kind === 'authored'
    && mark.by === 'ai:editing-agent-test' && mark.quote?.includes('Original sentence.')), 'Direct insertion must not claim the original text');
  assert.ok(!Object.values(directState.marks).some((mark: any) => mark.content === contribution && mark.status === 'pending'));
  const staleEdit = await editingClient.callTool({ name: 'proof_edit', arguments: edit });
  assert.ok(staleEdit.isError && JSON.stringify(staleEdit.content).includes('STALE_BASE'), 'Old snapshot tokens cannot replay edits');
  assert.equal((await editorCall('proof_read')).markdown.split(contribution).length - 1, 1);
  const apiState = await (await fetch(`${baseUrl}/api/agent/${slug}/state`, { headers: { 'x-share-token': editingLink.accessToken } })).json();
  assert.equal(apiState.revision, directState.revision, 'Both state aliases expose the same current revision');
  const mixed = await (await post('/documents', {
    markdown: '<span data-proof="authored" data-by="human:Alice">Keep old and old intact.</span>\n',
  })).json();
  const mixedSnapshot = await (await fetch(`${baseUrl}/documents/${mixed.slug}/snapshot`, { headers: { 'x-share-token': mixed.accessToken } })).json();
  const mixedEdit = await post(`/documents/${mixed.slug}/edit/v2`, {
    baseToken: mixedSnapshot.mutationBase.token, by: 'ai:precise-edit',
    operations: [{ op: 'find_replace_in_block', ref: 'b1', find: 'old', replace: 'new', occurrence: 'all' }],
  }, mixed.accessToken);
  assert.ok(mixedEdit.ok, await mixedEdit.text());
  const mixedState = await (await fetch(`${baseUrl}/documents/${mixed.slug}/state`, { headers: { 'x-share-token': mixed.accessToken } })).json();
  assert.equal(mixedState.markdown.trim(), 'Keep new and new intact.');
  const aiSegments = Object.values(mixedState.marks).filter((m: any) => m.kind === 'authored' && m.by === 'ai:precise-edit') as any[];
  assert.equal(aiSegments.length, 2);
  assert.ok(aiSegments.every(m => m.quote === 'new'), 'Find/replace attributes only each inserted word');
  const humanSegments = Object.values(mixedState.marks).filter((m: any) => m.kind === 'authored' && m.by === 'human:Alice') as any[];
  assert.ok(humanSegments.some(m => m.quote.includes('Keep')) && humanSegments.some(m => m.quote.includes('intact')), 'Unchanged words retain their original author');
  const events = await call('proof_events');
  assert.ok(events.events.length > 0);
  console.log('PASS: suggestion invitations stay restricted; editing invitations and MCP use snapshot tokens for direct writes with agent authorship');
} finally {
  await client.close();
  await editingClient.close();
  await new Promise<void>((resolve) => http.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
}
