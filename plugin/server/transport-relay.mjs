// Relay transport: the PHP relay in relay/ (e.g. a Plesk subdomain).
//
// On first use the machine registers itself with the team key under its peer
// name and stores the personal token it gets back in the plugin's data folder.
// Without a team key the plugin creates one: a fresh relay adopts it, and
// peer_list shows it so it can be given to the other machines.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_WAIT_S = 25; // the relay holds a long-poll at most this long

export class RelayTransport {
  constructor({ hub, teamKey, name, nameFromEnv, token, dataDir }) {
    this.relay = hub;
    this.teamKey = teamKey;
    this.name = name;
    this.trackName = !nameFromEnv;
    this.token = token;
    this.identitiesFile = path.join(dataDir, 'identities.json');
    this.lastId = 0;
  }

  identities() {
    try { return JSON.parse(fs.readFileSync(this.identitiesFile, 'utf8')); } catch { return {}; }
  }

  remember(key, value) {
    const all = { ...this.identities(), [key]: value };
    fs.mkdirSync(path.dirname(this.identitiesFile), { recursive: true });
    fs.writeFileSync(this.identitiesFile, JSON.stringify(all, null, 2), { mode: 0o600 });
  }

  async call(method, route, { body, timeoutMs = 15_000, auth = true } = {}) {
    const res = await fetch(`${this.relay}${route}`, {
      method,
      headers: {
        // X-Peerlink-Token too: some Apache/PHP setups drop the Authorization header.
        ...(auth ? { authorization: `Bearer ${this.token}`, 'x-peerlink-token': this.token } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(`relay ${res.status}: ${data.error ?? res.statusText}`), { status: res.status });
    return data;
  }

  async open() {
    if (this.token) return;
    await this.identify();
    if (this.trackName) this.remember(`${this.relay}|last-name`, this.name);
  }

  async identify() {
    const ids = this.identities();
    const key = `${this.relay}|${this.name}`;
    this.generatedTeamKey = ids[`${this.relay}|team-key`];
    this.token = ids[key];
    if (this.token) return;

    // Rename: the configured name changed, the machine keeps its token and messages.
    const previous = this.trackName ? ids[`${this.relay}|last-name`] : undefined;
    if (previous && previous !== this.name && ids[`${this.relay}|${previous}`]) {
      this.token = ids[`${this.relay}|${previous}`];
      await this.call('POST', '/v1/rename', { body: { name: this.name } }).catch((err) => {
        if (err.status === 409) throw new Error(`the relay already has a peer named "${this.name}": choose another peer name in the plugin options.`);
        throw err;
      });
      this.remember(key, this.token);
      this.remember(`${this.relay}|${previous}`, undefined);
      return;
    }

    const joinKey = this.teamKey || this.generatedTeamKey || `plj_${crypto.randomBytes(24).toString('base64url')}`;
    const { token } = await this.call('POST', '/v1/register', { auth: false, body: { name: this.name, join_key: joinKey } }).catch((err) => {
      if (err.status === 403 && !this.teamKey) {
        throw new Error('this relay already belongs to a team: enter its team key in the plugin options (/plugin → peerlink → configure).');
      }
      if (err.status === 409) {
        throw new Error(`the relay already has a peer named "${this.name}" (another machine, or this one after losing its data). Set another peer name in the plugin options, or run "php admin.php remove-peer ${this.name}" on the relay.`);
      }
      throw err;
    });
    if (!this.teamKey) {
      this.remember(`${this.relay}|team-key`, joinKey);
      this.generatedTeamKey = joinKey;
    }
    this.remember(key, token);
    this.token = token;
  }

  peers() { return this.call('GET', '/v1/peers'); }

  send(message) { return this.call('POST', '/v1/messages', { body: message }); }

  async next(waitS) {
    const wait = Math.min(waitS, MAX_WAIT_S);
    const { messages } = await this.call('GET', `/v1/messages?after=${this.lastId}&wait=${wait}`, { timeoutMs: (wait + 15) * 1000 });
    for (const m of messages) this.lastId = Math.max(this.lastId, Number(m.id));
    return messages.map((m) => ({ ...m, id: String(m.id) }));
  }

  async thread(id) {
    const { messages } = await this.call('GET', `/v1/thread?id=${encodeURIComponent(id)}`);
    return messages.map((m) => ({ ...m, id: String(m.id) }));
  }

  ack(ids) {
    return ids.length ? this.call('POST', '/v1/ack', { body: { ids: ids.map(Number) } }) : Promise.resolve();
  }
}
