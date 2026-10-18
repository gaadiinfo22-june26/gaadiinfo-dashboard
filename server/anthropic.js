/**
 * The Anthropic SDK client shared by AI summaries and suggested replies.
 *
 * The SDK reads ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) itself. A key that
 * is not tied to a Claude Console workspace must name one on every request:
 * set ANTHROPIC_WORKSPACE_ID and it is sent as the anthropic-workspace-id header.
 */
function createAnthropicClient(env) {
  const Anthropic = require('@anthropic-ai/sdk').default;
  const workspace = String((env || process.env).ANTHROPIC_WORKSPACE_ID || '').trim();
  return new Anthropic(workspace ? { defaultHeaders: { 'anthropic-workspace-id': workspace } } : {});
}

/** Turn an Anthropic API error into a message an agent or admin can act on (no secrets in it). */
function aiError(e) {
  if (!e || !e.status) return e;
  const detail = (e.error && e.error.error && e.error.error.message) || e.message || 'unknown error';
  let hint = '';
  if (/workspace/i.test(detail)) hint = ' Set ANTHROPIC_WORKSPACE_ID in .env.local, or use an API key created inside a Claude Console workspace.';
  else if (e.status === 401) hint = ' Check ANTHROPIC_API_KEY in .env.local.';
  else if (e.status === 429) hint = ' Rate or spend limit reached; try again shortly or raise the limit in the Claude Console.';
  return Object.assign(new Error(`Claude API error ${e.status}: ${String(detail).slice(0, 240)}${hint}`), { code: 'ai_error' });
}

module.exports = { createAnthropicClient, aiError };
