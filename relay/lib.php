<?php
// PeerLink relay, shared code. Plain PHP >= 8.1 with PDO SQLite: copy the relay/
// folder to any host (e.g. a Plesk subdomain) with public/ as the web root; the
// database lives in data/, outside the web root.

declare(strict_types=1);

const MAX_BODY_CHARS = 65536;
const MAX_WAIT_S = 25;
const ONLINE_WINDOW_S = 70;
const ACKED_TTL_S = 86400;
const UNACKED_TTL_S = 14 * 86400;
const NAME_RE = '/^[a-z0-9][a-z0-9-]{0,62}$/';
const TYPES = ['proposal', 'question', 'answer', 'objection', 'counterproposal', 'agreement', 'decision', 'info'];

final class HttpError extends Exception
{
    public function __construct(public readonly int $status, string $message)
    {
        parent::__construct($message);
    }
}

function db(): PDO
{
    static $pdo = null;
    if ($pdo) {
        return $pdo;
    }
    $dir = getenv('PEERLINK_DATA') ?: __DIR__ . '/data';
    if (!is_dir($dir)) {
        mkdir($dir, 0700, true);
    }
    $pdo = new PDO('sqlite:' . $dir . '/relay.sqlite', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $pdo->exec('PRAGMA busy_timeout = 5000');
    $pdo->exec('PRAGMA journal_mode = WAL');
    $pdo->exec(<<<SQL
        CREATE TABLE IF NOT EXISTS peers (
            name TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_seen INTEGER);
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT NOT NULL, recipient TEXT NOT NULL,
            thread TEXT NOT NULL, type TEXT NOT NULL, subject TEXT, in_reply_to TEXT, body TEXT NOT NULL,
            ts INTEGER NOT NULL, acked INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS messages_inbox ON messages (recipient, acked, id);
        CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        SQL);
    return $pdo;
}

function hash_token(string $token): string
{
    return hash('sha256', $token);
}

function new_secret(string $prefix): string
{
    return $prefix . rtrim(strtr(base64_encode(random_bytes(24)), '+/', '-_'), '=');
}

function config_get(string $key): ?string
{
    $stmt = db()->prepare('SELECT value FROM config WHERE key = ?');
    $stmt->execute([$key]);
    $value = $stmt->fetchColumn();
    $stmt->closeCursor();
    return $value === false ? null : $value;
}

function config_set(string $key, string $value): void
{
    db()->prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
        ->execute([$key, $value]);
}

function peer_names(): array
{
    return db()->query('SELECT name FROM peers ORDER BY name')->fetchAll(PDO::FETCH_COLUMN);
}

function add_peer(string $name): string
{
    $token = new_secret('pl_');
    db()->prepare('INSERT INTO peers (name, token_hash, created_at) VALUES (?, ?, ?)
                   ON CONFLICT (name) DO UPDATE SET token_hash = excluded.token_hash')
        ->execute([$name, hash_token($token), gmdate('c')]);
    return $token;
}
