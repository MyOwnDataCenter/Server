# Assistant providers, in order

Status: implemented on `feat/assistant-provider-order`. Not released. Joe reviewed the settings screen on the local instance.

Joe asked for this screen, accepted the analysis, and asked for it to be written down before implementation so the rules are not lost. Vision and style-guide edits in the same branch are at his request.

## Todo

- [x] Record the screen, the routing rules, and the things that must not be guessed later
- [x] Style guide and vision name the choice, the offer, and Hermes-when-first
- [x] Key store: per-person order, server offer, refuse offer, Hermes only when it is first
- [x] Sharing a single key with one account stops granting use
- [x] Chat walks that order before the first token, keeps the provider that starts, and names it
- [x] Hermes is not a silent backup and chat does not fall out of it
- [x] Settings shows my providers, Add, up and down, the owner's offer radio, and a fixed last row
- [x] A member's last row is the offer, or stop when they refuse it or the owner offered nothing
- [x] The offer row hides the owner's private name, address, and key fingerprint
- [x] Add configures one service at a time. On this server and Another address stay distinct
- [x] What's New waits for the version bump. Do not invent a release number here

## What was wrong

Settings asked "who answers" with two choices, Built-in and Hermes, then showed every setup at once. Built-in is not a service. Under it the server used the signed-in person's most recently updated key, then a key shared with them, then the owner's system default. ChatGPT, Grok, OpenAI, Anthropic, a custom address, and Hermes were all on screen together, so the control did not say which one would answer.

## The screen

**My providers**, with **Add** at the top of the page.

Each provider is one row, the same shape as a machine row. The row shows the name, the service, and the model. When the provider can be offered, the offer radio is on the row. Check connection and Delete sit on the row, to the left of the disclosure triangle. The triangle opens that provider as a card. The card holds Up and Down, the last check, edit, and the notes. Touch is the primary input, so the order is buttons, not a drag handle.

Chat tries from the top. The first provider that accepts the request is the one that answers, and the chat names it.

**Add** opens one service, then that service's fields, then returns to the list. The new row is placed at the bottom of the person's own list, above the fixed last row. It does not jump the queue. Move it up to try it sooner.

| Add choice | Who sees it | What the sheet asks for |
|---|---|---|
| ChatGPT | Everyone | Sign in to a Plus or Pro plan. No API key. |
| Grok | Everyone | A SpaceXAI API key and a model. |
| OpenAI | Everyone | An OpenAI API key and a model. Also Chat Completions or Responses, and reasoning. |
| Anthropic | Everyone | An Anthropic API key and a model. |
| On this server | Everyone | Ollama at `http://127.0.0.1:11434/v1` and a model. No key. |
| Another address | Owner | Any OpenAI-compatible base URL, an optional key, a model, and the API style. |
| Hermes | Owner | Connect on this server, or connect by address and key. Then full control or read only. |

Two rows of the same service are allowed. The name tells them apart.

The last row is not a provider and has no up or down control.

- The owner always sees **If none of these answer, stop.** The offer radio can sit on that row.
- Someone else sees **Server default**, the service, and the model, with **Don't use this**.
- If they refuse it, or the owner offered nothing, that row reads **If none of these answer, stop.** When an offer exists and they refused it, the row also offers **Use the server default**.

Appearance stays under the list. It is how the assistant looks.

## Two different jobs

Order and the offer are different controls. The same row can carry both, and the labels have to say which job is which.

- **Order** is the sequence this account tries.
- **Offer to everyone else** is one radio, owner only. It publishes exactly one provider, or stop. Other accounts do not inherit the owner's sequence. They inherit that one choice, and only after their own providers do not answer.

The radio is required because the top of the owner's list may be ChatGPT or Hermes, and neither can be published. The owner can also use one provider personally and offer a different one, or offer nothing.

ChatGPT cannot be offered: the plan belongs to the person who signed in. Hermes cannot be offered: it acts on this server with its owner's rights. Those rows have no radio. The reason is on the card.

The owner's own chat does not fall through to the offer. The offer is one of their rows already, and it is tried in the place they put it.

## Who can see a provider

A person sees the providers they added. They do not see a provider someone else added.

The only exception is the offer. On someone else's screen that row shows the service and the model. It does not show the name the owner gave it, the address, or the last digits of the key. It cannot be edited, reordered, shared, or deleted there.

Per-account sharing goes away. `sharedWith` no longer lets anyone list or use a key. The offer is the only shared path, and it is the whole household, not one account.

A custom address stays owner-only to add or edit. It makes this server call whatever address was typed. **On this server** is the fixed Ollama address and is available to every account. Both are stored as `openai-compatible`. The name and the address are how the owner tells them apart.

## None

None is the end of the chain. It never answers, so it cannot be moved. If it could sit above a working provider, everything under it would be unused.

For the owner, None means stop, and it is also a legal offer. An offer of None means other people are not given a provider.

For someone else, the offer occupies that same fixed slot. Their own rows stay above it and are tried first. A failed personal provider then sends that person's prompt, and its cost, to the owner's account. The offer row says so: other people's questions go to that provider when their own do not answer. **Don't use this** puts None back for that person only, so a private question is not sent on.

## Hermes

Hermes keeps its own memory and, unless it is read only, can change this server without an approval card. The other providers ask first.

- When Hermes is the first row, Hermes is the assistant. If it does not answer, chat stops. The rows under it are not tried, and the offer is not tried.
- When Hermes is anywhere else, it is skipped. It is not a backup. The rows above and below it are tried in order, then the offer. The Hermes card says that providers under a first-place Hermes wait until it is moved down.

Connecting Hermes puts that row first, which is what **Use Hermes** means today. Choosing the built-in assistant moves Hermes off the first place so the rows under it can answer.

A signed-out ChatGPT row can sit above Hermes. Hermes is "first" only when its row is the top row. A skipped row above it does not make Hermes the exclusive assistant.

## What "answers" means

A provider answers when it accepts the request before any of the reply has been shown. A refusal, an "I don't know", or an approval card is an answer. An empty reply is an answer that failed, and chat shows that error. Chat does not try the next provider after text or a tool call has already been shown.

Before the first token, skip a provider that never starts:

- ChatGPT signed out, or the sign-in cannot be refreshed
- the key is rejected (401 or 403)
- the model is missing (404)
- the address is unreachable or times out
- the provider is rate-limiting (429) or returns a server error (5xx)

The same provider's existing short retry for a busy stream still happens first. The walk tries each remaining provider once per send.

The conversation keeps the provider that started it. The next message tries that provider first. If it fails before the first token, the walk continues and the chat says so: "Grok did not answer. This chat is using OpenAI." If it fails after text has started, show the error and stop.

A new chat uses the current order. The bubble names the provider that answered.

## Routing

`candidatesForUser` is the chain chat walks.

1. Take this person's rows in their saved order. A new row is appended. Until an order has been saved, the order is most-recently-updated first, and a stored Hermes engine still means Hermes is first.
2. If the top row is Hermes, the chain is that row only.
3. Otherwise drop Hermes and drop a signed-out ChatGPT. Keep everyone else, in order.
4. If this person has not refused the offer, append the offered key when they do not already have it in the chain. ChatGPT and Hermes are never that key.

`resolveForUser` without an id returns the first candidate, or the existing "Add an API key in Settings → Assistant" error when the chain is empty. With an id, it returns that key when `canUse` allows it.

`canUse` is ownership, or the offer when this person has not refused it. `sharedWith` is not access.

## Stored state

`assistant/keys.json` gains:

- `order`: `{ [userId]: [keyId, ...] }` for the rows that person added
- `declineServerDefault`: `{ [userId]: true }` when they refused the offer

`systemDefault` stays a flag on one key. None means no key has it. `engine.hermes` remains so a server that has not saved an order yet still opens on Hermes. Reorder and the engine switch write both, and they agree: Hermes is the engine only when its row is first.

Removing a row drops it from the order. Reset clears order and refusals.

## Procedures

- `assistant.keys` returns this person's rows in try order. For someone else, the offered row is last, redacted, with `offered: true` and `mine: false`. Refusing it keeps that row and sets `declined: true`, so the screen can offer it again. `candidatesForUser` leaves it out while it is declined.
- `assistant.reorderKeys` takes a permutation of this person's own ids.
- `assistant.clearDefault` clears the offer. Owner only.
- `assistant.useServerDefault` with `{use: false}` refuses the offer. `{use: true}` accepts it again.
- `assistant.updateKey` rejects a non-empty `sharedWith`.

## Chat events

- `speaker`: `{name, provider}` once that provider produces text or a tool call
- `notice`: the sentence when chat moves to the next provider before any text

The live bubble shows that notice. When there was no switch, it shows "Answered by" and the provider's name. Loading an old conversation uses its saved `keyId` and the name from `assistant.keys` when that row is still visible. A redacted offer uses the service name, because the owner's private name stays off the row.

## Guidance

The style guide already said the assistant proposes a change the person approves, and that it does not grow a second set of machine controls. That stays. The guide now also names the list, the fixed last row, the offer, the refusal, and Hermes-when-first.

The vision did not mention the assistant. It now has a Help section with the same rules, and no settings mechanics.

What's New is written when a version is bumped. This plan does not add a release.
