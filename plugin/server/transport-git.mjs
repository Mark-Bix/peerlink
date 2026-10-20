// Git transport: a plain git repository is the mailbox.
//
//   peers/<name>.json                      written once when a machine joins
//   inbox/<to>/<ts>-<from>-<rand>.json     one file per message, never edited
//
// Nobody edits another peer's files, so concurrent pushes only need a rebase.
// What this machine has read is kept locally; its own read messages are deleted
// from the repository after RETENTION_MS. The team key, when given, is a token
// for HTTPS (e.g. a GitHub fine-grained token limited to this repository);
// without it git uses the machine's own credentials.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const RETENTION_MS = 14 * 24 * 3600_000;
const PUSH_ATTEMPTS = 6;
const FILE_RE = /^(\d+)-(.+)-[0-9a-f]{6}\.json$/;

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomHex = (bytes) => crypto.randomBytes(bytes).toString('hex');

export class GitTransport {
  constructor({ hub, teamKey, name, nameFromEnv, dataDir }) {
    this.url = hub;
    this.name = name;
    this.trackName = !nameFromEnv;
    this.intervalMs = Number(process.env.PEERLINK_GIT_INTERVAL_MS) || 10_000;
    const hubKey = crypto.createHash('sha256').update(hub).digest('hex').slice(0, 12);
    this.slotFor = (peer) => path.join(dataDir, 'git', `${hubKey}-${peer}`);
    this.lastNameFile = path.join(dataDir, 'git', `${hubKey}.name`);
    const slot = this.slotFor(name);
    this.repo = path.join(slot, 'repo');
    this.readFile = path.join(slot, 'read.json');
    this.machineIdFile = path.join(dataDir, 'machine-id');
    this.read = new Set(readJson(this.readFile, []));
    this.delivered = new Set();
    this.queue = Promise.resolve();
    this.env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      // The token travels as a header via env, never in the remote URL or .git/config.
      ...(teamKey ? {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.extraHeader',
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${teamKey}`).toString('base64')}`,
      } : {}),
    };
  }

  git(args, cwd = this.repo) {
    return new Promise((resolve, reject) => {
      execFile('git', args, { cwd, env: this.env, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new Error(`git ${args[0]}: ${(stderr || err.message).trim().split('\n').pop()}`));
        else resolve(stdout.trim());
      });
    });
  }

  // All git work runs one operation at a time.
  serial(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  async open() {
    await this.serial(async () => {
      if (!fs.existsSync(path.join(this.repo, '.git'))) {
        fs.mkdirSync(path.dirname(this.repo), { recursive: true });
        await this.git(['clone', '--quiet', this.url, this.repo], path.dirname(this.repo));
      }
      await this.git(['config', 'user.name', this.name]);
      await this.git(['config', 'user.email', `${this.name}@peerlink.invalid`]);
      this.branch = await this.git(['ls-remote', '--symref', 'origin', 'HEAD'])
        .then((out) => out.match(/ref: refs\/heads\/(\S+)\s+HEAD/)?.[1] ?? 'main');
      if (!(await this.git(['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => ''))) {
        await this.git(['symbolic-ref', 'HEAD', `refs/heads/${this.branch}`]); // empty repository
      }
      await this.sync();
      await this.join();
      await this.prune();
    });
  }

  machineId() {
    let id = fs.existsSync(this.machineIdFile) ? fs.readFileSync(this.machineIdFile, 'utf8').trim() : '';
    if (!id) {
      id = crypto.randomUUID();
      fs.mkdirSync(path.dirname(this.machineIdFile), { recursive: true });
      fs.writeFileSync(this.machineIdFile, id);
    }
    return `${id}:${this.name}`;
  }

  peerFile(peer) { return path.join(this.repo, 'peers', `${peer}.json`); }

  async join() {
    const file = this.peerFile(this.name);
    const existing = readJson(file, null);
    if (existing && existing.machine !== this.machineId()) {
      throw new Error(`the mailbox already has a peer named "${this.name}" on another machine. Set another peer name in the plugin options, or delete peers/${this.name}.json from the repository.`);
    }
    const changed = [];
    if (!existing) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify({ name: this.name, machine: this.machineId(), joined_at: new Date().toISOString() }, null, 2)}\n`);
      changed.push(file);
    }
    const previous = !this.trackName ? ''
      : fs.existsSync(this.lastNameFile) ? fs.readFileSync(this.lastNameFile, 'utf8').trim()
      : this.legacyName();
    const renamed = previous && previous !== this.name ? this.takeOver(previous) : [];
    changed.push(...renamed);
    if (changed.length) await this.commitAndPush(changed, renamed.length ? `rename: ${previous} → ${this.name}` : `join: ${this.name}`);
    if (renamed.length) fs.rmSync(this.slotFor(previous), { recursive: true, force: true });
    if (this.trackName) fs.writeFileSync(this.lastNameFile, this.name);
  }

  // Versions before 0.6 did not record the name: a rename made with them left
  // the old name behind. The one other name of this machine is that old name.
  legacyName() {
    const uuid = this.machineId().split(':')[0];
    const mine = this.knownPeers().filter((n) => n !== this.name && readJson(this.peerFile(n), null)?.machine?.startsWith(`${uuid}:`));
    return mine.length === 1 ? mine[0] : '';
  }

  // Rename: drops this machine's old peer file and moves its messages to the new
  // inbox, keeping what was already read. Returns the paths that changed.
  takeOver(previous) {
    const oldFile = this.peerFile(previous);
    const uuid = this.machineId().split(':')[0];
    if (!readJson(oldFile, null)?.machine?.startsWith(`${uuid}:`)) return [];
    fs.rmSync(oldFile);
    const changed = [oldFile];
    const target = path.join(this.repo, 'inbox', this.name);
    for (const f of this.listInbox(previous)) {
      const from = path.join(this.repo, 'inbox', previous, f.file);
      fs.mkdirSync(target, { recursive: true });
      fs.renameSync(from, path.join(target, f.file));
      changed.push(from, path.join(target, f.file));
    }
    for (const id of readJson(path.join(this.slotFor(previous), 'read.json'), [])) this.read.add(id);
    fs.writeFileSync(this.readFile, JSON.stringify([...this.read]));
    return changed;
  }

  async sync() {
    await this.git(['fetch', '--quiet', 'origin']);
    if (await this.git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${this.branch}`]).catch(() => '')) {
      if (await this.git(['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => '')) {
        await this.git(['rebase', '--quiet', `origin/${this.branch}`]);
      } else {
        await this.git(['reset', '--quiet', '--hard', `origin/${this.branch}`]);
      }
    }
  }

  async commitAndPush(files, message) {
    await this.git(['add', '--all', '--', ...files.map((f) => path.relative(this.repo, f))]);
    await this.git(['commit', '--quiet', '-m', message]);
    for (let attempt = 1; ; attempt++) {
      try {
        await this.git(['push', '--quiet', 'origin', `HEAD:refs/heads/${this.branch}`]);
        return;
      } catch (err) {
        if (attempt >= PUSH_ATTEMPTS) throw err;
        await sleep(200 * attempt + Math.random() * 300);
        await this.sync();
      }
    }
  }

  // Deletes this peer's own read messages older than the retention period.
  async prune() {
    const dir = path.join(this.repo, 'inbox', this.name);
    const inbox = this.listInbox(this.name);
    const present = new Set(inbox.map((f) => f.id));
    for (const id of this.read) if (!present.has(id)) this.read.delete(id); // keep read.json small
    const old = inbox.filter((f) => this.read.has(f.id) && Date.now() - f.ts > RETENTION_MS);
    if (!old.length) return;
    for (const f of old) fs.rmSync(path.join(dir, f.file));
    await this.commitAndPush(old.map((f) => path.join(dir, f.file)), `prune: ${this.name}`).catch(() => {});
  }

  listInbox(peer) {
    const dir = path.join(this.repo, 'inbox', peer);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).map((file) => {
      const m = file.match(FILE_RE);
      return m && { file, id: file.slice(0, -5), ts: Number(m[1]), from: m[2] };
    }).filter(Boolean).sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
  }

  knownPeers() {
    const dir = path.join(this.repo, 'peers');
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)) : [];
  }

  async peers() {
    await this.serial(() => this.sync());
    const lastActive = new Map();
    const inbox = path.join(this.repo, 'inbox');
    const boxes = fs.existsSync(inbox) ? fs.readdirSync(inbox, { withFileTypes: true }).filter((d) => d.isDirectory()) : [];
    for (const peer of boxes) {
      for (const f of this.listInbox(peer.name)) lastActive.set(f.from, Math.max(lastActive.get(f.from) ?? 0, f.ts));
    }
    return {
      me: this.name,
      peers: this.knownPeers().filter((n) => n !== this.name).map((name) => ({
        name,
        last_seen: lastActive.has(name) ? new Date(lastActive.get(name)).toISOString() : null,
      })),
    };
  }

  send({ to, type, body, thread, subject, in_reply_to: inReplyTo }) {
    return this.serial(async () => {
      await this.sync();
      if (!this.knownPeers().includes(to) || to === this.name) throw new Error(`unknown recipient "${to}"`);
      const now = Date.now();
      const id = `${now}-${this.name}-${randomHex(3)}`;
      const message = {
        id, from: this.name, to,
        thread: thread || `t-${randomHex(4)}`,
        type,
        ...(subject ? { subject } : {}),
        ...(inReplyTo ? { in_reply_to: String(inReplyTo) } : {}),
        body,
        sent_at: new Date(now).toISOString(),
      };
      const file = path.join(this.repo, 'inbox', to, `${id}.json`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(message, null, 2)}\n`);
      await this.commitAndPush([file], `${type}: ${this.name} → ${to} (${message.thread})`);
      return { id, thread: message.thread };
    });
  }

  // Unread messages not handed out yet by this instance; waits up to waitS for one.
  async next(waitS) {
    const end = Date.now() + waitS * 1000;
    for (;;) {
      await this.serial(() => this.sync());
      const fresh = this.listInbox(this.name)
        .filter((f) => !this.read.has(f.id) && !this.delivered.has(f.id))
        .map((f) => readJson(path.join(this.repo, 'inbox', this.name, f.file), null))
        .filter(Boolean);
      for (const m of fresh) this.delivered.add(m.id);
      if (fresh.length || Date.now() + this.intervalMs > end) return fresh;
      await sleep(this.intervalMs);
    }
  }

  // Every message of a thread, both directions, oldest first.
  async thread(id) {
    await this.serial(() => this.sync());
    const inbox = path.join(this.repo, 'inbox');
    if (!fs.existsSync(inbox)) return [];
    const all = [];
    for (const box of fs.readdirSync(inbox, { withFileTypes: true }).filter((d) => d.isDirectory())) {
      for (const f of this.listInbox(box.name)) {
        const m = readJson(path.join(inbox, box.name, f.file), null);
        if (m?.thread === id) all.push(m);
      }
    }
    return all.sort((a, b) => a.sent_at.localeCompare(b.sent_at) || a.id.localeCompare(b.id));
  }

  async ack(ids) {
    for (const id of ids) this.read.add(id);
    fs.writeFileSync(this.readFile, JSON.stringify([...this.read]));
  }
}
