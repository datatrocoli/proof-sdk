/** Build an invitation only from a complete, shareable access link. */
export function buildAgentInvite(shareUrl: string): string {
  const url = new URL(shareUrl);
  const match = url.pathname.match(/^\/d\/([^/]+)\/?$/);
  const token = url.searchParams.get('token')?.trim();
  if (!match || !token || !['http:', 'https:'].includes(url.protocol)) {
    throw new Error('An agent invitation requires a document link with an access token.');
  }
  const api = `${url.origin}/documents/${match[1]}`;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  return [
    'Collaborate with me on this Proof doc.',
    '',
    `Doc: ${url.toString()}`,
    ...(local ? [
      '',
      'This is a local server on my Mac. Cloud web-fetch tools cannot reach it.',
      'Use a local HTTP tool or the Proof local MCP connector in Claude Desktop.',
      'If the Proof connector is available, call proof_read, then proof_presence,',
      'and use proof_comment or proof_suggest. No browser login is required.',
    ] : []),
    '',
    'For direct HTTP requests, use these headers every time:',
    `Authorization: Bearer ${token}`,
    'X-Agent-Id: <your-stable-agent-id>',
    'Content-Type: application/json (for POST requests)',
    '',
    `1) Read the current document: GET ${api}/state`,
    `2) Announce presence: POST ${api}/presence`,
    '   Body: {"name":"<your-name>","status":"active"}',
    `3) Add a comment or pending suggestion: POST ${api}/ops`,
    '   Comment: {"type":"comment.add","by":"ai:<your-stable-agent-id>","quote":"<exact text from state>","text":"<comment>"}',
    '   Suggestion: {"type":"suggestion.add","by":"ai:<your-stable-agent-id>","kind":"replace","quote":"<exact text from state>","content":"<proposed text>"}',
    '   Keep suggestions pending for my review. This invitation permits comments and suggestions, not accepting changes.',
    `4) While collaborating, check GET ${api}/events/pending?after=<last-seen-id>. Refresh state before responding to new activity.`,
    `API details: ${url.origin}/agent-docs`,
    '',
    'Treat the access token as a secret; do not repeat it in your reply.',
  ].join('\n');
}
