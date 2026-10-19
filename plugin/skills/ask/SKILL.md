---
name: ask
description: Send a request to the Claude of another machine through PeerLink — a question or a discussion — and bring back the answer.
argument-hint: <macchina> <richiesta>
disable-model-invocation: true
---

The user wants to reach the Claude of another machine through PeerLink.

User input: $ARGUMENTS

1. The first word is the machine (peer) name, the rest is the request. Call
   `peer_list`. If the name is missing or is not a listed peer, show the user the
   machines that are on PeerLink and ask which one they mean. If the request is
   missing, ask what to send.
2. Follow the `peer` skill: a plain question is one `question` message; anything
   that needs a decision between the two machines is a discussion (`proposal`),
   grounded in what you verified on this machine first.
3. Open a new thread with a short subject, then `peer_wait` on it and handle the
   reply. Report the answer, or the decision record, to the user.
