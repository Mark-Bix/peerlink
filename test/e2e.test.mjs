// End-to-end: two MCP servers ("alpha", "beta") driven over stdio, once per hub:
//   git   — a bare repository on disk as the mailbox
//   relay — the PHP relay, served by php:8.3-cli in Docker (skipped without Docker)
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const root = path.resolve(import.meta.dirname, '..');
const serverScript = path.join(root, 'plugin', 'server', 'peer-mcp.mjs');

const hasDocker = (() => {
  try { execFileSync('docker', ['info'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

function startServer(env) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PEERLINK_')));
  const proc = spawn('node', [serverScript], { env: { ...clean, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  const notifications = [];
  let nextId = 1;
  readline.createInterface({ input: proc.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else notifications.push(msg);
  });
  const rpc = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const call = async (name, args = {}) => {
    const res = await rpc('tools/call', { name, arguments: args });
    return { text: res.result.content[0].text, isError: Boolean(res.result.isError) };
  };
  return { proc, rpc, call, notifications };
}

async function connect(env) {
  const s = startServer(env);
  const init = await s.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.deepEqual(init.result.capabilities.experimental, { 'claude/channel': {} });
  s.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  return s;
}

async function waitUntil(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('condition not met in time');
}

// ---- hubs -----------------------------------------------------------------

const hubs = {
  git: {
    async start(tmp) {
      const repo = path.join(tmp, 'mailbox.git');
      execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', repo]);
      return { url: repo, extraEnv: { PEERLINK_GIT_INTERVAL_MS: '200' }, stop() {} };
    },
  },
  relay: {
    skip: !hasDocker && 'Docker not available',
    async start() {
      const port = 20000 + Math.floor(Math.random() * 20000);
      const container = `peerlink-test-${port}`;
      execFileSync('docker', ['run', '-d', '--rm', '--name', container, '-p', `${port}:8080`,
        '-e', 'PHP_CLI_SERVER_WORKERS=8', '-e', 'PEERLINK_DATA=/tmp/peerlink',
        '-v', `${path.join(root, 'relay')}:/app:ro`,
        'php:8.3-cli', 'php', '-d', 'log_errors=1', '-S', '0.0.0.0:8080', '-t', '/app/public', '/app/public/index.php'], { stdio: 'ignore' });
      const url = `http://127.0.0.1:${port}`;
      await waitUntil(() => fetch(`${url}/health`).then((r) => r.ok, () => false), 20000);
      return {
        url,
        extraEnv: {},
        admin: (...args) => execFileSync('docker', ['exec', container, 'php', '/app/admin.php', ...args], { encoding: 'utf8' }),
        stop: () => {
          if (process.env.PEERLINK_TEST_LOGS) console.error(execFileSync('docker', ['logs', container], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
          execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
        },
      };
    },
  },
};

// ---- the same behaviour on every hub ----------------------------------------

for (const [kind, hubDef] of Object.entries(hubs)) {
  describe(kind, { skip: hubDef.skip }, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `peerlink-${kind}-`));
    const servers = {};
    let hub;
    let teamKey = '';

    const envFor = (name, dataName = name) => ({
      ...hub.extraEnv,
      CLAUDE_PLUGIN_DATA: path.join(tmp, `plugin-${dataName}`),
      PEERLINK_CFG_HUB_URL: hub.url,
      PEERLINK_CFG_TEAM_KEY: teamKey || '${user_config.team_key}',
      PEERLINK_CFG_NAME: name,
    });

    before(async () => {
      hub = await hubDef.start(tmp);
      servers.alpha = await connect(envFor('alpha'));
      const { text, isError } = await servers.alpha.call('peer_list');
      assert.equal(isError, false, text);
      if (kind === 'relay') teamKey = text.match(/created the team key.*\n(plj_\S+)/)[1];
      servers.beta = await connect(envFor('beta'));
      assert.equal((await servers.beta.call('peer_list')).isError, false);
    });

    after(async () => {
      await Promise.all(Object.values(servers).map((s) => new Promise((resolve) => {
        if (s.proc.exitCode !== null || s.proc.signalCode) return resolve();
        s.proc.once('exit', resolve);
        s.proc.kill();
      })));
      hub?.stop();
      // Windows releases files of killed processes with a small delay.
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    });

    test('tools are listed', async () => {
      const res = await servers.alpha.rpc('tools/list');
      assert.deepEqual(res.result.tools.map((t) => t.name), ['peer_list', 'peer_send', 'peer_wait', 'peer_inbox']);
    });

    test('peer_list shows identity and the other peer', async () => {
      const { text } = await servers.alpha.call('peer_list');
      assert.match(text, /You are "alpha"/);
      assert.match(text, /- beta: /);
    });

    test('the ask prompt completes peer names and builds the request', async () => {
      const list = await servers.alpha.rpc('prompts/list');
      assert.deepEqual(list.result.prompts.map((p) => p.name), ['ask']);
      const done = await servers.alpha.rpc('completion/complete', { ref: { type: 'ref/prompt', name: 'ask' }, argument: { name: 'peer', value: 'b' } });
      assert.deepEqual(done.result.completion.values, ['beta']);
      const got = await servers.alpha.rpc('prompts/get', { name: 'ask', arguments: { peer: 'beta', request: 'quali DNS usi?' } });
      const text = got.result.messages[0].content.text;
      assert.match(text, /Send this to "beta"/);
      assert.match(text, /quali DNS usi\?/);
      const unknown = await servers.alpha.rpc('prompts/get', { name: 'ask', arguments: { peer: 'gamma', request: 'x' } });
      assert.match(unknown.result.messages[0].content.text, /"gamma" is not on PeerLink/);
    });

    test('a new thread requires a subject', async () => {
      assert.equal((await servers.alpha.call('peer_send', { to: 'beta', type: 'proposal', body: 'x' })).isError, true);
    });

    test('an unknown recipient is refused', async () => {
      const res = await servers.alpha.call('peer_send', { to: 'nobody', type: 'info', subject: 's', body: 'x' });
      assert.equal(res.isError, true);
      assert.match(res.text, /unknown recipient/);
    });

    test('round trip: proposal, channel push, wait, reply in thread', async () => {
      const sent = await servers.alpha.call('peer_send', { to: 'beta', type: 'proposal', subject: 'Sync orders', body: 'Webhook on POST /orders?' });
      const [, id, thread] = sent.text.match(/^Sent message (\S+) to beta in thread (\S+)\./);

      await waitUntil(() => servers.beta.notifications.some((n) => n.method === 'notifications/claude/channel'));
      const event = servers.beta.notifications.find((n) => n.method === 'notifications/claude/channel');
      assert.equal(event.params.content, 'Webhook on POST /orders?');
      assert.deepEqual(event.params.meta, { from: 'alpha', thread, type: 'proposal', msg_id: id, subject: 'Sync orders' });

      const waiting = servers.alpha.call('peer_wait', { thread, timeout_seconds: 20 });
      const got = await servers.beta.call('peer_wait', { thread, timeout_seconds: 5 });
      assert.match(got.text, /from alpha .* proposal/);
      await servers.beta.call('peer_send', { to: 'alpha', type: 'counterproposal', thread, in_reply_to: id, body: 'Our firewall blocks inbound; poll instead.' });
      const reply = await waiting;
      assert.match(reply.text, /counterproposal/);
      assert.match(reply.text, /poll instead/);
      assert.ok(reply.text.includes(`in reply to ${id}`));
    });

    test('peer_wait times out cleanly', async () => {
      assert.equal((await servers.alpha.call('peer_wait', { thread: 'nope', timeout_seconds: 1 })).text, 'No message within 1s.');
    });

    test('unread messages survive a session restart, read ones do not come back', async () => {
      await servers.alpha.call('peer_send', { to: 'beta', type: 'info', subject: 'Heads up', body: 'deploy at 18:00' });
      await waitUntil(() => servers.beta.notifications.some((n) => n.params?.content === 'deploy at 18:00'));
      servers.beta.proc.kill();
      servers.beta = await connect(envFor('beta'));
      assert.match((await servers.beta.call('peer_inbox')).text, /deploy at 18:00/);
      await new Promise((r) => setTimeout(r, 300));
      servers.beta.proc.kill();
      servers.beta = await connect(envFor('beta'));
      assert.equal((await servers.beta.call('peer_inbox')).text, 'No unread messages.');
    });

    test('a second machine cannot take an existing name', async () => {
      const intruder = await connect(envFor('beta', 'intruder'));
      try {
        const res = await intruder.call('peer_list');
        assert.equal(res.isError, true);
        assert.match(res.text, /already has a peer named "beta"/);
      } finally {
        intruder.proc.kill();
      }
    });

    if (kind === 'relay') {
      test('relay: a wrong team key is refused', async () => {
        const res = await fetch(`${hub.url}/v1/register`, { method: 'POST', body: JSON.stringify({ name: 'gamma', join_key: 'plj_wrong-wrong-wrong-wrong' }) });
        assert.equal(res.status, 403);
      });

      test('relay: a bad token is refused, a manual token from admin.php works', async () => {
        assert.equal((await fetch(`${hub.url}/v1/peers`, { headers: { authorization: 'Bearer pl_wrong' } })).status, 401);
        const token = hub.admin('add-peer', 'manual').trim().split('\n').pop();
        const res = await fetch(`${hub.url}/v1/peers`, { headers: { 'x-peerlink-token': token } });
        assert.equal((await res.json()).me, 'manual');
      });

      test('relay: only the first machine keeps the generated team key', () => {
        const read = (n) => JSON.parse(fs.readFileSync(path.join(tmp, `plugin-${n}`, 'identities.json'), 'utf8'));
        assert.equal(read('alpha')[`${hub.url}|team-key`], teamKey);
        assert.equal(read('beta')[`${hub.url}|team-key`], undefined);
      });
    }

    if (kind === 'git') {
      test('git: every message is a commit in the mailbox', () => {
        const log = execFileSync('git', ['--git-dir', hub.url, 'log', '--format=%s', 'main'], { encoding: 'utf8' });
        assert.match(log, /join: alpha/);
        assert.match(log, /proposal: alpha → beta/);
        assert.match(log, /counterproposal: beta → alpha/);
      });
    }
  });
}
