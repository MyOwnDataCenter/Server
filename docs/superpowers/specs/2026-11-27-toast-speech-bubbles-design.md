# Toast messages as assistant speech bubbles

Date: 2026-11-27
Status: approved
Repo: MyOwnDataCenter/server (worktree / branch where this lands).

## 1. Goal

Toast feedback from actions (VM start, Copied, install, transfer progress, and the rest) appears as a **list inside one speech bubble** above the floating assistant character when that character is shown and not covered. When the character cannot speak, the same toast list sits at the top of the screen. System-wide news stays on the **bell** as **Notifications**, never in the toast surfaces.

## 2. Why

Today almost all action feedback uses a browser-local `useToast` that always paints the top stack, even while the floating character is visible. Only a narrow “account toast” path (clip transfers) can become a single `.ac-say` line. People who keep the assistant on screen still see toasts at the top, and they only see one spoken line at a time. One account-backed toast channel, shown as a list in the bubble or at the top, matches how other signed-in session state already behaves and removes a false third category of message.

## 3. Non-goals

- Live push / websocket for toast sync across sessions (poll + optimistic cache is enough for now)
- Guest / signed-out toast channel
- Putting Notifications into the toast stack or speech bubble
- Putting toasts on the bell
- Pie-chart countdown affordances (use a thin progress line)
- Rewriting every call site by hand when routing `useToast` / action `done:` through the store covers them
- Changing Notification producers beyond keeping them on `notifications.*`

## 4. Vocabulary (product law)

Two channels only:

| Name | What it is | Where it shows | Who sees it |
|------|------------|----------------|-------------|
| **Notification** | Server-wide news (e.g. new version available) | Bell | Anyone signed in on this server |
| **Toast** | Feedback about something a person did or that belongs to their work | Speech-bubble list above the floating assistant when that character is shown and not covered; otherwise the top-of-screen toast stack | That signed-in account, on every session for that account |

Rules:

- Do **not** call toasts “account toasts,” “user-specific notifications,” or put them on the bell.
- Do **not** put Notifications in the toast stack or speech bubble.
- There is no browser-only toast channel. Every toast is written to that person’s toast store.
- When the character is hidden, covered, or floating is off, the same toast list uses the top stack — not a different kind of message.

Update `docs/style-guide.md` (§ Notifications and clips) to this split. Add a brief **Notifications and toasts** note under Accounts / this application in `docs/vision.md` pointing at that vocabulary. Older plans (e.g. clip-book) that describe three channels or “short Copied stays in this browser” are historical, not current product law.

## 5. Architecture

```
Action / useToast(text, error?)
        │ signed in
        ▼
toasts.add  →  dataDir/toasts/<userId>.json
        │
        ▼
toasts.list (poll ~2.5s) + optimistic React Query cache
        │
        ├─ character floating & not covered → claimBubble → one .ac-say list
        └─ otherwise → top .toast-stack list
```

Notifications stay on `notifications.get` / `notifications.clear` and the bell UI only.

## 6. Data model and write path

Keep the existing per-account toast file and RPC:

- `toasts.list` / `toasts.add` / `toasts.dismiss`
- Row: `id`, `text`, `at`, `href | null`, `expireAt | null`, `level: 'note' | 'problem'`

**Write path**

- `useToast(text, error?)` no longer holds one-shot React state. When signed in, it calls `toasts.add` with:
  - `level: error ? 'problem' : 'note'`
  - `expireAt`: now + **4500ms** (problem) or **2600ms** (note) — same timings as today’s local toast
  - `href`: null for ordinary feedback
- Optimistic update: append the new row into the `toasts.list` query cache immediately so this session does not wait on the round trip.
- `useAction` / `useMachineAction` `done:` and error paths keep calling `useToast` and pick up the new behavior.
- Existing server writers (`toasts.add` from transfers, optional `href`, `expireAt: null` until dismiss) stay as they are.
- If the person is not signed in, skip the store (no toast). Do not invent a guest channel.

**Read path**

- One live list from `toasts.list`.
- `liveToasts` still filters expired rows and sorts problem-first, then newest.
- Remove the “spoken = first row only” rule (`spokenToast` as the sole bubble content). Surfaces render the **full** live list.

**Not in this model**

- Parallel local toast slot beside the account list.
- Notifications mixed into toast rows.

## 7. Surfaces

### Which surface

- `toastSurface({ floating, covered })` → `'bubble'` only when the floating character is mounted, floating is on, and it is not covered; otherwise `'box'`.
- Character widget `claimBubble(true)` while it can show the list; the top stack renders **no** toast rows while the bubble claims them.

### Bubble (`.ac-say`)

- One speech-bubble chrome above the character.
- Inside: a vertical **list** of toast rows (same sort as `liveToasts`).
- Each row independently:
  - **Activate** if it has `href` (navigate + dismiss, same as today)
  - **Dismiss** via its own close control
  - Plain text rows remain dismissible; timed rows also drop at `expireAt`
- Problem styling is per row.
- Cap height and scroll inside the bubble if the list grows long.

### Top stack

- Same list and per-row activate / dismiss / countdown when the bubble is not claimed.
- Remove the parallel one-at-a-time local toast slot from `AccountToastStack`.

### Countdown (timed rows only)

- Rows with `expireAt` show a **thin progress line** along the bottom of that row.
- Remaining fraction is `(expireAt - now) / (expireAt - at)`, clamped to `[0, 1]`; the line starts full and empties to zero at expiry.
- Untimed rows (`expireAt: null`) have no line.

### A11y

- Live region announces list changes (problems assertive, notes polite), not only a single spoken string.
- Each dismiss / activate control stays keyboard-reachable with clear labels.

## 8. Edge cases

- Character disappears mid-toast (Assistant open, sheet, Settings, floating off): bubble unclaims; same rows appear in the top stack with no loss.
- Character returns: top stack clears those rows; bubble list shows them again.
- Failed `toasts.add`: roll back the optimistic row; do not fall back to a second toast channel.
- Damaged toast file: keep existing server error behavior; no local fallback stack.
- Many live toasts: bubble scrolls; no hard single-message rule.

## 9. Components to change (implementation map)

| Piece | Role |
|-------|------|
| `web/src/ui.tsx` `useToast` / Providers | Route through account toast add + optimistic cache; drop one-shot local state |
| `web/src/toasts/account.tsx` | Single list API; top stack without local slot; live region for full list |
| `web/src/toasts/view.ts` | Keep `liveToasts` / `toastSurface`; stop treating bubble as one `spokenToast` |
| `web/src/character/widgets.tsx` | Render full toast list inside `.ac-say` with per-row actions |
| `web/src/styles.css` | List layout inside `.ac-say`; per-row countdown line |
| `omarchyd/toasts.mjs` | Keep the existing RPC contract; client supplies `expireAt` and `level` |
| `docs/style-guide.md`, `docs/vision.md` | Vocabulary above |

## 10. Verification

- Unit: `liveToasts` / surface choice; countdown fraction helper if extracted; bubble shows the full live list (not first-only).
- Manual: with floating character on, VM start / Copied appear in the bubble list (several at once if triggered), each dismissible; with character off or covered, same messages at top; update-available stays on the bell only; a second signed-in session for the same account eventually sees the toast via list poll.
