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

## Ogni macchina: setup automatico (Windows)

Scarica [`install/PeerLink-Setup.cmd`](install/PeerLink-Setup.cmd) e fai doppio
clic. Oppure da PowerShell:

```powershell
[Net.ServicePointManager]::SecurityProtocol = 'Tls12'; & ([scriptblock]::Create([Text.Encoding]::UTF8.GetString((New-Object Net.WebClient).DownloadData('https://raw.githubusercontent.com/Mark-Bix/peerlink/main/install/peerlink.ps1')).TrimStart([char]0xFEFF)))
```

Il setup installa ciò che manca (git, Node.js, Claude Code), aggiunge o aggiorna
il plugin, chiede solo la chiave della squadra e il nome della macchina, verifica
il collegamento, crea il comando `peerlink` e l'icona **PeerLink** sul desktop,
poi avvia Claude in ascolto. Rilanciato più tardi aggiorna e basta
(`-Reconfigure` per cambiare chiave o nome). Senza domande:
`$env:PEERLINK_TEAM_KEY='...'; .\peerlink.ps1 -Name pc-ufficio`.

Da quel momento: icona **PeerLink**, oppure `peerlink` nella cartella del progetto.

## Ogni macchina: installazione a mano

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

I messaggi PeerLink partono senza chiedere conferma, anche in modalità auto: il
plugin approva da solo i propri strumenti (opzione **Invio senza conferma**,
attiva di default). Comandi e modifiche sulla macchina seguono i permessi normali
di Claude Code: in modalità *auto* quelli di sola lettura passano da soli.

## Cambiare il nome di una macchina

`/plugin configure peerlink@peerlink` → **Nome di questa macchina**, poi riavvia
Claude. Al primo avvio la macchina prende il nome nuovo, toglie quello vecchio
dall'elenco e si porta dietro i messaggi non ancora letti; chi le scrive usa il
nome nuovo.

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

```
/peerlink:peers                                  le macchine collegate
/peerlink:ask p8-wks-01 quali server DNS usi?    una richiesta a un'altra macchina
```

oppure a parole, nella sessione:

> Chiedi a server-b come preferisce ricevere gli ordini da noi: webhook o polling.

Claude apre un thread, aspetta la risposta e porta avanti la discussione
secondo la skill `peer`; alla fine ti presenta il verbale. Le azioni sulla tua
macchina (modifiche, deploy) restano soggette alla tua approvazione: un
messaggio del peer non è mai un ordine.

## Cosa fa da solo e cosa chiede

- **Senza chiedere**: leggere file e codice, comandi che solo guardano la macchina
  (`ipconfig`, `hostname`, versioni, servizi, porte, …) e rispondere con quello che
  ha trovato (nomi, IP, DNS, versioni, percorsi, struttura della configurazione).
  Ti dice in una riga cosa gli hanno chiesto e cosa ha risposto.
- **Chiede prima**: tutto ciò che modifica la macchina (file, installazioni,
  servizi, configurazione, porte, deploy).
- **Mai**: segreti, password, token, chiavi, `.env`, dati personali o dei clienti.

Una discussione va avanti da sola fino al verbale: i due Claude raccolgono
progetto, struttura, IP, servizi e porte, si scambiano i fatti e ti presentano alla
fine la soluzione con le modifiche da approvare. Ti coinvolgono prima solo se
sono bloccati o se serve qualcosa che solo una persona può dare.

Per i comandi valgono le regole di Claude Code: in modalità *auto* quelli di sola
lettura passano da soli; in modalità normale ognuno chiede conferma, a meno di
aggiungere regole in `/permissions` (per esempio `Bash(ipconfig:*)`).

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
