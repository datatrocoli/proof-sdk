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
const { apiRoutes } = await import('../../server/routes.js');
const { mountProofSdkRoutes } = await import('../../packages/doc-server/src/index.js');
const app = express();
app.use(express.json());
app.use('/api', apiRoutes);
mountProofSdkRoutes(app);
const http = createServer(app);
await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
const address = http.address() as { port: number };
const baseUrl = `http://127.0.0.1:${address.port}`;
const client = new Client({ name: 'new-agent-test', version: '1.0.0' });
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

  const config = { baseUrl, slug, token: link.accessToken, agentId: 'claude-test', name: 'Claude test' };
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
    ['proof_comment', 'proof_events', 'proof_presence', 'proof_read', 'proof_suggest']);
  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, `${name} should succeed: ${JSON.stringify(result.content)}`);
    const content = result.content as Array<{ type: string; text: string }>;
    const text = content[0].text;
    assert.ok(!text.includes(link.accessToken), 'Tool results must not expose the credential');
    return JSON.parse(text);
  }
  assert.match((await call('proof_read')).markdown, /Original sentence/);
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
  }, link.accessToken);
  assert.equal(denied.status, 403, 'The review token cannot approve its own suggestion');
  const acceptedPayload = { type: 'suggestion.add', kind: 'replace', status: 'accepted',
    quote: 'Original sentence.', content: 'Bypassed review.', by: 'ai:claude-test' };
  for (const route of [`/documents/${slug}/ops`, `/api/documents/${slug}/ops`,
    `/documents/${slug}/marks/suggest-replace`]) {
    const response = await post(route, acceptedPayload, link.accessToken);
    // The direct mark endpoint's existing checkAuth uses 401 for a disallowed role.
    assert.equal(response.status, route.includes('/marks/') ? 401 : 403,
      `Review access must reject immediately accepted suggestions at ${route}`);
  }
  assert.ok(!(await call('proof_read')).markdown.includes('Bypassed review.'));
  const events = await call('proof_events');
  assert.ok(events.events.length > 0);
  console.log('PASS: tokenless-page invitation and fresh MCP agent can read, appear, comment and propose; approval stays with the human');
} finally {
  await client.close();
  await new Promise<void>((resolve) => http.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
}
