// Settings and transport selection.
//
// The plugin options (asked by Claude Code at install) reach the server as
// PEERLINK_CFG_* env vars; plain PEERLINK_* env vars override them (useful for a
// second session on the same machine). The hub URL picks the transport:
//   - a git repository (…/x.git, git@…, ssh://…, file://…, or a local path) → GitTransport
//   - anything else (https://peerlink.example.com)                        → RelayTransport
//
// Every transport exposes: open(), name, peers(), send(msg), next(waitS), ack(ids), thread(id).
// open() also handles a rename: when the configured name changed since the last
// run, the machine keeps its identity and its unread messages under the new name.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GitTransport } from './transport-git.mjs';
import { RelayTransport } from './transport-relay.mjs';

const env = (...keys) => {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    // An unset plugin option may arrive as the literal placeholder.
    if (value && !value.startsWith('${')) return value;
  }
  return '';
};

const machineName = () =>
  os.hostname().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'machine';

export function readSettings() {
  return {
    hub: env('PEERLINK_HUB_URL', 'PEERLINK_CFG_HUB_URL').replace(/\/+$/, ''),
    teamKey: env('PEERLINK_TEAM_KEY', 'PEERLINK_CFG_TEAM_KEY'),
    name: env('PEERLINK_NAME', 'PEERLINK_CFG_NAME').toLowerCase() || machineName(),
    // A name forced by env is a side session (two on one machine), never a rename.
    nameFromEnv: Boolean(env('PEERLINK_NAME')),
    token: env('PEERLINK_TOKEN'),
    dataDir: env('CLAUDE_PLUGIN_DATA') || path.join(os.homedir(), '.claude', 'peerlink'),
  };
}

export const isGitUrl = (url) =>
  /\.git$/i.test(url) || /^(git@|ssh:\/\/|file:\/\/)/.test(url) || (!/^https?:\/\//.test(url) && fs.existsSync(url));

export async function openTransport() {
  const settings = readSettings();
  if (!settings.hub) throw new Error('PeerLink is not configured: set the hub URL in the plugin options (/plugin → peerlink → configure).');
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(settings.name)) throw new Error(`invalid peer name "${settings.name}": lowercase letters, digits and dashes`);
  const transport = isGitUrl(settings.hub) ? new GitTransport(settings) : new RelayTransport(settings);
  await transport.open();
  return transport;
}
