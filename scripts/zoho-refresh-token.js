#!/usr/bin/env node
/**
 * One-time Zoho setup: exchange a Self Client grant code for a refresh token
 * and save it to .env.local (git-ignored). The token is never printed.
 *
 *   ZOHO_CLIENT_ID=... ZOHO_CLIENT_SECRET=... node scripts/zoho-refresh-token.js <grant-code>
 *
 * (Client ID / secret can also already be in .env.local.) See docs/workspace-server.md.
 */
const fs = require('fs');
const path = require('path');
const { loadEnvFile } = require('../server/config');

const ENV_FILE = path.join(__dirname, '..', '.env.local');

function upsert(text, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  return re.test(text) ? text.replace(re, line) : (text && !text.endsWith('\n') ? text + '\n' : text) + line + '\n';
}

async function main() {
  const code = process.argv[2];
  loadEnvFile(ENV_FILE, process.env);
  const clientId = process.env.ZOHO_CLIENT_ID;
  const clientSecret = process.env.ZOHO_CLIENT_SECRET;
  const accounts = process.env.ZOHO_ACCOUNTS_DOMAIN || 'accounts.zoho.in';
  if (!code || !clientId || !clientSecret) {
    console.error('Usage: ZOHO_CLIENT_ID=... ZOHO_CLIENT_SECRET=... node scripts/zoho-refresh-token.js <grant-code>');
    process.exit(1);
  }
  const body = new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code' });
  const res = await fetch(`https://${accounts}/oauth/v2/token`, { method: 'POST', body });
  const json = await res.json().catch(() => ({}));
  if (!json.refresh_token) {
    console.error(`Zoho did not return a refresh token (${json.error || 'HTTP ' + res.status}). Grant codes expire after a few minutes and work once - generate a new one.`);
    process.exit(1);
  }
  let text = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  text = upsert(text, 'ZOHO_CLIENT_ID', clientId);
  text = upsert(text, 'ZOHO_CLIENT_SECRET', clientSecret);
  text = upsert(text, 'ZOHO_REFRESH_TOKEN', json.refresh_token);
  fs.writeFileSync(ENV_FILE, text, { mode: 0o600 });
  console.log(`Saved the Zoho refresh token to ${path.relative(process.cwd(), ENV_FILE)}. Also set ZOHO_ORG_ID there, then run: npm start`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
