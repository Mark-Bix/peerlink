<?php
// PeerLink relay HTTP API. Peers only make outbound calls: register, send,
// long-poll for their messages, ack what they have read.
//
//   POST /v1/register  {name, join_key}           -> {name, token}   (no auth)
//   GET  /v1/peers                                -> {me, peers}
//   POST /v1/messages  {to, type, body, thread?, subject?, in_reply_to?} -> {id, thread}
//   GET  /v1/messages?after=<id>&wait=<s>         -> {messages}      (long-poll, s <= 25)
//   POST /v1/ack       {ids}                      -> {acked}
//   POST /v1/rename    {name}                     -> {name}    (keeps token and messages)
//   GET  /health

declare(strict_types=1);

require __DIR__ . '/../lib.php';

header('Content-Type: application/json');
header('Cache-Control: no-store');

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
// Works from the domain root or from a subfolder.
$route = preg_match('#(/v1/[a-z]+|/health)/?$#', $path, $m) ? $m[1] : $path;

try {
    $result = match ("$method $route") {
        'GET /health' => ['ok' => true],
        'POST /v1/register' => register(read_body()),
        'GET /v1/peers' => list_peers(authenticate()),
        'POST /v1/messages' => send_message(authenticate(), read_body()),
        'GET /v1/messages' => poll_messages(authenticate()),
        'POST /v1/ack' => ack_messages(authenticate(), read_body()),
        'POST /v1/rename' => rename_peer(authenticate(), read_body()),
        default => throw new HttpError(404, 'not found'),
    };
    echo json_encode($result, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
} catch (HttpError $e) {
    http_response_code($e->status);
    echo json_encode(['error' => $e->getMessage()]);
} catch (Throwable $e) {
    error_log('peerlink relay: ' . $e);
    http_response_code(500);
    echo json_encode(['error' => 'internal error']);
}

function read_body(): array
{
    $raw = file_get_contents('php://input', false, null, 0, 2 * MAX_BODY_CHARS + 4096);
    $data = json_decode($raw ?: '{}', true);
    if (!is_array($data)) {
        throw new HttpError(400, 'invalid JSON');
    }
    return $data;
}

function authenticate(): string
{
    // Apache in CGI/FPM mode may drop Authorization: X-Peerlink-Token is the fallback.
    $header = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
    $token = preg_replace('/^Bearer\s+/i', '', $header) ?: ($_SERVER['HTTP_X_PEERLINK_TOKEN'] ?? '');
    if ($token === '') {
        throw new HttpError(401, 'invalid or missing token');
    }
    $stmt = db()->prepare('SELECT name FROM peers WHERE token_hash = ?');
    $stmt->execute([hash_token($token)]);
    $name = $stmt->fetchColumn();
    $stmt->closeCursor(); // end the read before touch_peer writes
    if ($name === false) {
        throw new HttpError(401, 'invalid or missing token');
    }
    touch_peer($name);
    return $name;
}

function touch_peer(string $name): void
{
    db()->prepare('UPDATE peers SET last_seen = ? WHERE name = ?')->execute([time(), $name]);
}

function register(array $body): array
{
    $name = (string) ($body['name'] ?? '');
    $joinKey = (string) ($body['join_key'] ?? '');
    $known = config_get('join_key_hash');
    if ($known === null) {
        // A fresh relay adopts the team key of the first machine (trust on first use).
        if (strlen($joinKey) < 24) {
            throw new HttpError(400, 'team key too short');
        }
        config_set('join_key_hash', hash_token($joinKey));
    } elseif (!hash_equals($known, hash_token($joinKey))) {
        sleep(1); // slow down guessing
        throw new HttpError(403, 'invalid team key');
    }
    if (!preg_match(NAME_RE, $name)) {
        throw new HttpError(400, 'name: lowercase letters, digits and dashes');
    }
    if (in_array($name, peer_names(), true)) {
        throw new HttpError(409, "peer \"$name\" already exists (remove it on the relay with remove-peer to re-register)");
    }
    return ['name' => $name, 'token' => add_peer($name)];
}

function list_peers(string $me): array
{
    $rows = db()->query('SELECT name, last_seen FROM peers ORDER BY name')->fetchAll(PDO::FETCH_ASSOC);
    $peers = [];
    foreach ($rows as $row) {
        if ($row['name'] === $me) {
            continue;
        }
        $seen = $row['last_seen'] === null ? null : (int) $row['last_seen'];
        $peers[] = [
            'name' => $row['name'],
            'online' => $seen !== null && time() - $seen < ONLINE_WINDOW_S,
            'last_seen' => $seen === null ? null : gmdate('Y-m-d\TH:i:s\Z', $seen),
        ];
    }
    return ['me' => $me, 'peers' => $peers];
}

function send_message(string $me, array $b): array
{
    $to = (string) ($b['to'] ?? '');
    if ($to === $me || !in_array($to, peer_names(), true)) {
        throw new HttpError(400, "unknown recipient \"$to\"");
    }
    if (!in_array($b['type'] ?? null, TYPES, true)) {
        throw new HttpError(400, 'type must be one of: ' . implode(', ', TYPES));
    }
    $body = $b['body'] ?? null;
    if (!is_string($body) || trim($body) === '') {
        throw new HttpError(400, 'body is required');
    }
    if (mb_strlen($body) > MAX_BODY_CHARS) {
        throw new HttpError(400, 'body longer than ' . MAX_BODY_CHARS . ' chars');
    }
    $thread = is_string($b['thread'] ?? null) && $b['thread'] !== '' ? mb_substr($b['thread'], 0, 64) : 't-' . bin2hex(random_bytes(4));
    db()->prepare('INSERT INTO messages (sender, recipient, thread, type, subject, in_reply_to, body, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        ->execute([
            $me, $to, $thread, $b['type'],
            is_string($b['subject'] ?? null) ? mb_substr($b['subject'], 0, 200) : null,
            isset($b['in_reply_to']) ? mb_substr((string) $b['in_reply_to'], 0, 100) : null,
            $body, time(),
        ]);
    $id = (int) db()->lastInsertId();
    if (random_int(1, 50) === 1) {
        prune();
    }
    return ['id' => $id, 'thread' => $thread];
}

function poll_messages(string $me): array
{
    $after = max(0, (int) ($_GET['after'] ?? 0));
    $wait = min(max(0, (int) ($_GET['wait'] ?? 0)), MAX_WAIT_S);
    set_time_limit(MAX_WAIT_S + 15);
    $stmt = db()->prepare('SELECT id, sender, thread, type, subject, in_reply_to, body, ts FROM messages
                           WHERE recipient = ? AND acked = 0 AND id > ? ORDER BY id');
    $deadline = microtime(true) + $wait;
    do {
        $stmt->execute([$me, $after]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        if ($rows || microtime(true) >= $deadline) {
            break;
        }
        usleep(500_000);
        // Leading whitespace is valid JSON: writing it is how PHP notices a client
        // that went away, so a dead machine does not hold a PHP worker for 25 s.
        echo ' ';
        flush();
        if (connection_aborted()) {
            exit;
        }
    } while (true);
    if ($wait > 0) {
        touch_peer($me);
    }
    return ['messages' => array_map(fn ($r) => array_filter([
        'id' => (int) $r['id'],
        'from' => $r['sender'],
        'thread' => $r['thread'],
        'type' => $r['type'],
        'subject' => $r['subject'],
        'in_reply_to' => $r['in_reply_to'],
        'body' => $r['body'],
        'sent_at' => gmdate('Y-m-d\TH:i:s\Z', (int) $r['ts']),
    ], fn ($v) => $v !== null), $rows)];
}

function ack_messages(string $me, array $b): array
{
    $ids = array_values(array_filter($b['ids'] ?? [], 'is_int'));
    if (!$ids) {
        return ['acked' => 0];
    }
    $marks = implode(',', array_fill(0, count($ids), '?'));
    $stmt = db()->prepare("UPDATE messages SET acked = 1 WHERE recipient = ? AND acked = 0 AND id IN ($marks)");
    $stmt->execute([$me, ...$ids]);
    return ['acked' => $stmt->rowCount()];
}

function rename_peer(string $me, array $b): array
{
    $name = (string) ($b['name'] ?? '');
    if (!preg_match(NAME_RE, $name)) {
        throw new HttpError(400, 'name: lowercase letters, digits and dashes');
    }
    if ($name === $me) {
        return ['name' => $me];
    }
    if (in_array($name, peer_names(), true)) {
        throw new HttpError(409, "peer \"$name\" already exists");
    }
    $db = db();
    $db->beginTransaction();
    $db->prepare('UPDATE peers SET name = ? WHERE name = ?')->execute([$name, $me]);
    $db->prepare('UPDATE messages SET recipient = ? WHERE recipient = ?')->execute([$name, $me]);
    $db->prepare('UPDATE messages SET sender = ? WHERE sender = ?')->execute([$name, $me]);
    $db->commit();
    return ['name' => $name];
}

function prune(): void
{
    db()->prepare('DELETE FROM messages WHERE (acked = 1 AND ts < ?) OR ts < ?')
        ->execute([time() - ACKED_TTL_S, time() - UNACKED_TTL_S]);
}
