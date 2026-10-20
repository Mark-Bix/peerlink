---
name: peers
description: Show the machines on PeerLink — this machine's name and the others, with their last activity.
disable-model-invocation: true
---

Call `peer_list` and show the result to the user as a short list: first this
machine's name, then every other machine with its status (online/offline when
known) and last activity. If this machine created the team key, show it too. Do
not send any message.
