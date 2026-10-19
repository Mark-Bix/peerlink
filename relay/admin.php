<?php
// PeerLink relay administration (command line, on the relay host).
//
//   php admin.php join-key            creates or rotates the team key
//   php admin.php add-peer <name>     prints a manual token for <name>
//   php admin.php remove-peer <name>  revokes a machine
//   php admin.php list-peers

declare(strict_types=1);

require __DIR__ . '/lib.php';

if (PHP_SAPI !== 'cli') {
    exit(1);
}

[$command, $name] = [$argv[1] ?? '', $argv[2] ?? ''];

switch ($command) {
    case 'join-key':
        $key = new_secret('plj_');
        config_set('join_key_hash', hash_token($key));
        echo "Chiave della squadra (mostrata una volta sola; quella vecchia non vale più):\n$key\n";
        break;
    case 'add-peer':
        if (!preg_match(NAME_RE, $name)) {
            fwrite(STDERR, "nome: lettere minuscole, cifre e trattini\n");
            exit(1);
        }
        $existed = in_array($name, peer_names(), true);
        $token = add_peer($name);
        echo "Peer \"$name\" " . ($existed ? 'aggiornato (il token vecchio non vale più)' : 'creato') . ". Token (mostrato una volta sola):\n$token\n";
        break;
    case 'remove-peer':
        $stmt = db()->prepare('DELETE FROM peers WHERE name = ?');
        $stmt->execute([$name]);
        echo $stmt->rowCount() ? "Peer \"$name\" rimosso.\n" : "Peer \"$name\" non esiste.\n";
        break;
    case 'list-peers':
        foreach (db()->query('SELECT name, created_at, last_seen FROM peers ORDER BY name') as $row) {
            $seen = $row['last_seen'] ? gmdate('Y-m-d H:i', (int) $row['last_seen']) . ' UTC' : 'mai';
            echo "{$row['name']}\tcreato {$row['created_at']}\tultimo contatto $seen\n";
        }
        break;
    default:
        echo "uso: php admin.php join-key | add-peer <nome> | remove-peer <nome> | list-peers\n";
        exit($command === '' ? 0 : 1);
}
