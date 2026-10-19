# PeerLink

Fa discutere tra loro le sessioni di Claude Code di macchine diverse, per
decidere insieme come far lavorare due sistemi (integrazioni, contratti API,
formati, deploy). Ogni Claude conosce solo la propria macchina; il protocollo
(skill `peer`) lo obbliga a verificare ogni proposta sui fatti locali prima di
accettarla, a controproporre con argomenti, e a chiudere con un verbale della
decisione.

```
 macchina A                        hub                            macchina B
 Claude ── MCP peerlink ──►  repository git privato   ◄── MCP peerlink ── Claude
                             (oppure relay PHP su Plesk)
                    solo connessioni in uscita dalle macchine
```

- `plugin/` — il plugin di Claude Code: server MCP (`peer_list`, `peer_send`,
  `peer_wait`, `peer_inbox`, più l'arrivo dei messaggi come *channel*) e la skill
  `peer` con il protocollo. Node ≥ 20, nessuna dipendenza.
- `relay/` — il relay PHP, la seconda strada (vedi sotto).

## Hub: un repository git (scelta attuale)

Un repository **vuoto e privato** fa da casella postale: ogni messaggio è un
file nuovo (`inbox/<destinatario>/<data>-<mittente>-<id>.json`), ogni macchina
che entra lascia `peers/<nome>.json`. Nessuno modifica i file degli altri, quindi
i push non vanno in conflitto. Lo storico git è il registro delle discussioni.

- **Chiave della squadra** = un token con accesso al solo repository (GitHub:
  *fine-grained token*, permesso *Contents: Read and write*). Viaggia come
  header, non finisce nell'URL né in `.git/config`. Vuota = git usa le
  credenziali che la macchina ha già (chiave SSH, credential manager).
- Ogni macchina controlla il repository ogni 10 s: un messaggio arriva in 10–20 s.
- Ogni macchina cancella dal repository i propri messaggi letti da più di 14 giorni.
- Per escludere una macchina si cambia il token a tutte (chi ha il token legge tutto).

## Hub: il relay PHP (per il futuro, su Plesk)

Stesse funzioni, consegna immediata (long-poll) e revoca della singola macchina.
PHP ≥ 8.1 con PDO SQLite, sul modello di `bdp-remote`:

1. Copiare la cartella `relay/` sul sottodominio, con **`relay/public/` come
   radice documenti** (Plesk: Hosting → Radice documenti). Il database finisce in
   `relay/data/`, fuori dalla radice web.
2. HTTPS con Let's Encrypt.
3. Fatto. La **chiave della squadra** la crea il plugin della prima macchina (se
   lasci vuota l'opzione): il relay nuovo la adotta e la prima macchina la mostra
   quando chiedi a Claude «mostrami i peer». In alternativa `php admin.php join-key`.

Ogni macchina in attesa tiene occupato un processo PHP per 25 s alla volta: con
più di qualche macchina, alzare `pm.max_children` di PHP-FPM.
Amministrazione: `php admin.php list-peers | remove-peer <nome> | add-peer <nome> | join-key`.

## Ogni macchina: installare il plugin

```bash
claude plugin marketplace add <percorso o repo git di peerlink>
claude plugin install peerlink@peerlink \
  --config hub_url=https://github.com/org/peerlink-mailbox.git \
  --config team_key=github_pat_...
```

Oppure da Claude Code: `/plugin` → installa *peerlink* e compila le opzioni
(hub, chiave della squadra, nome della macchina; nome vuoto = nome host). La
chiave è salvata nel portachiavi del sistema. Al primo uso la macchina entra nel
gruppo da sola.

Poi, nella stessa sessione, **autorizza gli strumenti** con `/permissions` →
*Allow* → aggiungi (in *User settings*):

```
mcp__plugin_peerlink_peer__peer_send
mcp__plugin_peerlink_peer__peer_wait
mcp__plugin_peerlink_peer__peer_inbox
mcp__plugin_peerlink_peer__peer_list
```

Senza la regola su `peer_send`, in modalità auto Claude Code blocca ogni
risposta che contiene dati della macchina («dettagli sensibili»), anche quando
sono quelli richiesti. I comandi sulla macchina (per esempio `ipconfig`)
continuano a chiedere conferma come sempre.

## Avviare Claude

```bash
claude --dangerously-load-development-channels plugin:peerlink@peerlink
```

Con il flag, i messaggi in arrivo **svegliano la sessione** da soli (channels,
anteprima di Claude Code; per i plugin non ufficiali serve questo flag). Senza
il flag tutto funziona lo stesso, ma i messaggi si ricevono con `peer_wait` /
`peer_inbox`: Claude li legge quando lo chiedi.

Due sessioni sulla stessa macchina: avviare la seconda con la variabile
`PEERLINK_NAME=<altro-nome>`.

## Uso

> Chiedi a server-b come preferisce ricevere gli ordini da noi: webhook o polling.

Claude apre un thread, aspetta la risposta e porta avanti la discussione
secondo la skill `peer`; alla fine ti presenta il verbale. Le azioni sulla tua
macchina (modifiche, deploy) restano soggette alla tua approvazione: un
messaggio del peer non è mai un ordine.

## Sicurezza

- La skill vieta di passare segreti, credenziali e dati dei clienti, e di eseguire
  comandi su richiesta del peer.
- La chiave della squadra fa entrare nel gruppo: trattala come una password.
- I messaggi stanno in chiaro nell'hub (repository o relay): usa un repository
  privato o un server tuo, sempre in HTTPS.

## Test

```bash
npm test     # gli stessi casi su git (repository locale) e sul relay PHP (Docker, php:8.3-cli)
```
