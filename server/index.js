#!/usr/bin/env node
/**
 * Escalation workspace server.
 *
 *   npm start            (reads settings from the environment or .env.local)
 *
 * Serves the dashboard and keeps Zoho / Anthropic credentials on this machine.
 * Customer conversations are fetched on demand and cached in CACHE_DIR; they
 * are never written to the repository. See docs/workspace-server.md.
 */
const http = require('http');
const path = require('path');
const { ROOT, loadEnvFile, readConfig, isLoopback } = require('./config');
const { createZohoClient } = require('./zoho');
const { createCache } = require('./cache');
const { createConversationService } = require('./conversations');
const { createSnapshotService } = require('./snapshot');
const { createSummarizer } = require('./summarize');
const { createReplyDrafter } = require('./reply');
const { createMetricsService } = require('./ticket-metrics');
const { createActionService } = require('./actions');
const { createStatusProvider } = require('./challan-status');
const { createApp } = require('./app');

loadEnvFile(path.join(ROOT, '.env.local'), process.env);
const config = readConfig(process.env);
const log = msg => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

if (!isLoopback(config.host) && !config.password && !config.users.length) {
  console.error(`Refusing to listen on ${config.host} without WORKSPACE_USERS or WORKSPACE_PASSWORD: the workspace shows customer conversations.`);
  process.exit(1);
}

const cache = createCache(config.cacheDir);
const zoho = createZohoClient(config.zoho);
let snapshots = null;
let actions = null;
const metrics = createMetricsService({
  zoho, cache, log, enabled: zoho.configured && config.ticketMetrics,
  onUpdate: ids => snapshots && snapshots.metricsUpdated(ids)
});
snapshots = createSnapshotService({
  zoho, cache, lookbackDays: config.closedLookbackDays, snapshotFile: config.snapshotFile, log, metrics,
  followUpFor: id => (actions ? actions.followUpFor(id) : null),
  pollMs: config.pollSeconds * 1000, fullRefreshMs: config.fullRefreshMinutes * 60000
});
actions = createActionService({ zoho, cache, config, snapshots, auditDir: path.join(config.cacheDir, 'audit'), log });
snapshots.start();
const conversations = createConversationService({ zoho, cache, ttlMs: config.conversationTtlMs });
const summarizer = createSummarizer({ enabled: config.ai.enabled, model: config.ai.model, cache });
const replies = createReplyDrafter({ enabled: config.ai.replies, model: config.ai.model, playbookFile: config.ai.playbookFile, cache });
const status = createStatusProvider(config.status);
const handler = createApp({ config, zoho, snapshots, conversations, summarizer, replies, actions, status, log });

http.createServer((req, res) => {
  handler(req, res).catch(err => {
    log(`Unhandled error: ${err.message}`);
    if (!res.headersSent) { res.writeHead(500); res.end(); }
  });
}).listen(config.port, config.host, () => {
  log(`Escalation workspace on http://${config.host === '127.0.0.1' ? 'localhost' : config.host}:${config.port}`);
  log(`Zoho Desk: ${zoho.configured ? `connected - checking for changes every ${config.pollSeconds}s${config.webhookSecret ? ', webhook on' : ''}` : 'not connected (using ' + path.relative(ROOT, config.snapshotFile) + ' and cached conversations)'}`);
  log(`AI summaries: ${summarizer.enabled ? 'on (' + config.ai.model + ')' : 'off (no ANTHROPIC_API_KEY)'}`);
  log(`AI suggested replies: ${replies.enabled ? 'on (playbook: ' + path.relative(ROOT, config.ai.playbookFile) + ')' : 'off (no ANTHROPIC_API_KEY)'}`);
  if (zoho.configured) log(`First-response times from Zoho: ${config.ticketMetrics ? 'on' : 'off (ZOHO_TICKET_METRICS=off)'}`);
  log(`Challan status lookup: ${status.configured ? 'connected' : 'not connected'}`);
  log(`Ticket changes from the workspace: ${actions.enabled ? `on (statuses: ${config.write.statusWaiting} / ${config.write.statusClosed})` : config.write.enabled ? 'off until Zoho is connected' : 'off (ZOHO_WRITE)'}`);
  if (config.users.length) log(`Agent logins: ${config.users.length}`);
  else if (config.password) log('Password protection: on (shared password)');
});
