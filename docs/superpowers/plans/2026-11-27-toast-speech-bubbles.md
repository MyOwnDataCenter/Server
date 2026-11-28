# Toast speech bubbles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every toast through the signed-in account toast store and show the full live list as a speech-bubble stack above the floating assistant when it can speak, otherwise in the top toast stack — while Notifications stay on the bell.

**Architecture:** Keep `toasts.list` / `toasts.add` / `toasts.dismiss` and the per-account file. Replace browser-local `useToast` state with `toasts.add` plus optimistic React Query updates. One list drives both `.ac-say` (when `claimBubble`) and `.toast-stack` (when not). Each row is independently dismissible/activatable; timed rows get a thin countdown line.

**Tech Stack:** React 18, TanStack React Query, existing omarchyd `toasts.*` RPC, Node test runner (`node --experimental-strip-types --test`).

**Spec:** `docs/superpowers/specs/2026-11-27-toast-speech-bubbles-design.md`

## Global Constraints

- Tabs, no semicolons, single quotes in new TypeScript and in `omarchyd` JavaScript. Match a file that already uses another style.
- Sentence-case commit subjects. No `feat:` prefix. No trailing period.
- No version bump, no changelog edit, no `INSTALLER_REVISION` bump.
- Work in the current checkout (`/tmp/omarchy-server-ux` or the active worktree); do not invent a second branch unless asked.
- TDD: a failing test before each pure-logic behavior change.
- Product vocabulary: **Notification** = bell / server-wide; **Toast** = account store / bubble or top stack. Do not reintroduce “account toast” or “short Copied stays on this browser” in docs or new comments.
- Do not put toasts on the bell. Do not put Notifications in the toast list.
- Timed note TTL **2600ms**, problem TTL **4500ms** (same as today’s local toast).
- Optimistic add; on failure roll back the optimistic row — no second local toast channel.

---

## File map

| File | Responsibility |
|------|----------------|
| `web/src/toasts/view.ts` | Pure rules: `liveToasts`, `toastSurface`, `toastRemaining`. Remove `spokenToast` / `staysLocal`. |
| `test/toast-view.test.mjs` | Tests for those rules. |
| `web/src/toasts/account.tsx` | Provider: list query, `push`, dismiss, open, `claimBubble`; top stack; live region. Shared row UI. |
| `web/src/character/widgets.tsx` | Floating character: one `.ac-say` containing the full live list. |
| `web/src/ui.tsx` | `useToast` → haptic + `push`; drop local toast state / `AccountToastStack local`. |
| `web/src/styles.css` | Bubble list layout; per-row countdown line (stack + bubble). |
| `docs/style-guide.md` | Notification vs Toast vocabulary. |
| `docs/vision.md` | Short Notifications and toasts note under Accounts. |
| `omarchyd/toasts.mjs` | Unchanged RPC contract; client supplies `expireAt` and `level`. |

## Interfaces

```ts
// web/src/toasts/view.ts
export type ToastLevel = 'note' | 'problem'
export type ToastRecord = {
	id: string
	text: string
	at: number
	href: string | null
	expireAt: number | null
	level: ToastLevel
}
export function liveToasts(rows: readonly ToastRecord[], now: number): ToastRecord[]
export function toastSurface(input: {floating: boolean; covered: boolean}): 'bubble' | 'box'
/** Remaining fraction in [0, 1] for a timed toast; null if untimed or invalid. */
export function toastRemaining(row: {at: number; expireAt: number | null}, now: number): number | null

// web/src/toasts/account.tsx (ToastApi)
type ToastApi = {
	rows: ToastRecord[]
	bubble: boolean
	claimBubble: (on: boolean) => void
	push: (text: string, error?: boolean) => void
	dismiss: (id: string) => void
	open: (row: ToastRecord) => void
}
export function useAccountToasts(): ToastApi
export function AccountToastStack(): JSX.Element | null  // no local prop
```

---

### Task 1: Pure toast view rules

**Files:**
- Modify: `web/src/toasts/view.ts`
- Modify: `test/toast-view.test.mjs`

**Interfaces:**
- Consumes: existing `ToastRecord` shape
- Produces: `toastRemaining`; removes `spokenToast` and `staysLocal`

- [ ] **Step 1: Write the failing tests**

Replace `test/toast-view.test.mjs` contents with:

```js
import assert from 'node:assert/strict'
import {test} from 'node:test'

import {liveToasts, toastRemaining, toastSurface} from '../web/src/toasts/view.ts'

const toast = (over) => ({
	id: 'a',
	text: 'Sent',
	at: 1,
	href: '#/clips',
	expireAt: null,
	level: 'note',
	...over,
})

test('a toast whose time has passed is hidden, and one that waits for a person stays', () => {
	const now = 1_000
	const rows = [
		toast({id: 'old', expireAt: 1_000, at: 1}),
		toast({id: 'soon', expireAt: 1_001, at: 2}),
		toast({id: 'stay', expireAt: null, at: 3}),
	]
	assert.deepEqual(liveToasts(rows, now).map((row) => row.id), ['stay', 'soon'])
})

test('problems sort ahead of notes, and each group is newest first', () => {
	const rows = [
		toast({id: 'note-old', at: 1, level: 'note'}),
		toast({id: 'problem-old', at: 2, level: 'problem'}),
		toast({id: 'note-new', at: 4, level: 'note'}),
		toast({id: 'problem-new', at: 3, level: 'problem'}),
	]
	assert.deepEqual(liveToasts(rows, 10).map((row) => row.id), ['problem-new', 'problem-old', 'note-new', 'note-old'])
})

test('the character speaks when it is on screen, and the box is used when it is covered or hidden', () => {
	assert.equal(toastSurface({floating: true, covered: false}), 'bubble')
	assert.equal(toastSurface({floating: true, covered: true}), 'box')
	assert.equal(toastSurface({floating: false, covered: false}), 'box')
})

test('toastRemaining empties from create to expiry and is null when untimed', () => {
	assert.equal(toastRemaining({at: 0, expireAt: null}, 500), null)
	assert.equal(toastRemaining({at: 0, expireAt: 1000}, 0), 1)
	assert.equal(toastRemaining({at: 0, expireAt: 1000}, 500), 0.5)
	assert.equal(toastRemaining({at: 0, expireAt: 1000}, 1000), 0)
	assert.equal(toastRemaining({at: 0, expireAt: 1000}, 1500), 0)
	assert.equal(toastRemaining({at: 100, expireAt: 100}, 100), null)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-strip-types --test test/toast-view.test.mjs`

Expected: FAIL — `toastRemaining` is not exported; imports of removed symbols may also fail depending on edit order.

- [ ] **Step 3: Implement `view.ts`**

Set `web/src/toasts/view.ts` to:

```ts
// Rules for toasts. The screen renders these. It does not decide them.

export type ToastLevel = 'note' | 'problem'

export type ToastRecord = {
	id: string
	text: string
	at: number
	href: string | null
	expireAt: number | null
	level: ToastLevel
}

export function liveToasts(rows: readonly ToastRecord[], now: number): ToastRecord[] {
	return rows
		.filter((row) => row.expireAt == null || row.expireAt > now)
		.slice()
		.sort((a, b) => {
			const level = Number(b.level === 'problem') - Number(a.level === 'problem')
			return level || b.at - a.at
		})
}

export function toastSurface(input: {floating: boolean; covered: boolean}): 'bubble' | 'box' {
	return input.floating && !input.covered ? 'bubble' : 'box'
}

export function toastRemaining(row: {at: number; expireAt: number | null}, now: number): number | null {
	if (row.expireAt == null) return null
	const span = row.expireAt - row.at
	if (!(span > 0)) return null
	const left = row.expireAt - now
	if (left <= 0) return 0
	if (left >= span) return 1
	return left / span
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-strip-types --test test/toast-view.test.mjs`

Expected: PASS (all four tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/toasts/view.ts test/toast-view.test.mjs
git commit -m "$(cat <<'EOF'
Add toastRemaining and drop single-spoken toast rules

EOF
)"
```

---

### Task 2: Account toast provider — push and list surfaces

**Files:**
- Modify: `web/src/toasts/account.tsx`
- Modify: `web/src/ui.tsx` (`<AccountToastStack />` call site only; leave local toast state until Task 4)
- Test: covered by Task 1 rules + manual in Task 5; no new Node test file required for React provider

**Interfaces:**
- Consumes: `liveToasts`, `toastRemaining`, `ToastRecord`, `mutate`/`query`, `TOASTS_QUERY_KEY`
- Produces: `ToastApi.push`, `rows` (full list), no `spoken`; `AccountToastStack()` without `local`

- [ ] **Step 1: Extend `ToastApi` and implement `push`**

In `web/src/toasts/account.tsx`:

1. Remove `spokenToast` import and `spoken` from the API.
2. Add `push(text: string, error?: boolean): void` that:
   - no-ops when not signed in
   - builds `expireAt = Date.now() + (error ? 4500 : 2600)`, `level = error ? 'problem' : 'note'`, `href: null`
   - creates a provisional id: 16 lowercase hex chars (`crypto.getRandomValues` into `Uint8Array(8)` then hex)
   - optimistically appends `{id, text: one-line trimmed slice 240, at: Date.now(), href: null, expireAt, level}` to `TOASTS_QUERY_KEY`
   - calls `mutate<ToastRecord>('toasts.add', {text, href: null, expireAt, level})`
   - on success, replaces the provisional row by `id` with the server row (match provisional id in cache; if server id differs, remove provisional and upsert server row)
   - on failure, removes the provisional row and invalidates `TOASTS_QUERY_KEY`
3. Keep `dismiss` / `open` / `claimBubble` as today.
4. Live region: announce the newest live row’s text (problem → `role="alert"` assertive; else status polite). Prefer announcing when `rows[0]` id changes rather than only a single spoken helper.

Provisional id helper (inline in the file):

```ts
function newToastId() {
	const bytes = new Uint8Array(8)
	crypto.getRandomValues(bytes)
	return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}
```

Trim text the same way the server does (one line, max 240) before optimistic insert so the UI matches.

- [ ] **Step 2: Shared row component + stack without `local`**

In the same file, add a `ToastRow` used by the top stack (and later the bubble):

```tsx
function ToastRow({
	row,
	now,
	onOpen,
	onDismiss,
	variant,
}: {
	row: ToastRecord
	now: number
	onOpen: (row: ToastRecord) => void
	onDismiss: (id: string) => void
	variant: 'box' | 'bubble'
}) {
	const left = toastRemaining(row, now)
	const problem = row.level === 'problem'
	return (
		<div className={`${variant === 'box' ? 'toast' : 'ac-say-row'}${problem ? ' problem' : ''}${problem && variant === 'box' ? ' error' : ''}`}>
			{variant === 'box' && (
				<span className="ico">
					<Icon name={problem ? 'alert' : 'check'} size={15} stroke={2.6} />
				</span>
			)}
			{row.href ? (
				<button type="button" className={variant === 'box' ? 'toast-open' : 'ac-say-open'} onClick={() => onOpen(row)}>
					{row.text}
				</button>
			) : (
				<span className={variant === 'box' ? 'toast-text' : 'ac-say-text'}>{row.text}</span>
			)}
			<button type="button" className={variant === 'box' ? 'toast-x' : 'ac-say-x'} aria-label="Dismiss" onClick={() => onDismiss(row.id)}>
				<Icon name="close" size={14} />
			</button>
			{left != null && (
				<span className="toast-ttl" aria-hidden="true" style={{'--toast-ttl': String(left)} as CSSProperties} />
			)}
		</div>
	)
}
```

Change `AccountToastStack` to take **no props**. When `bubble` is true, return `null`. Otherwise map `rows` through `ToastRow` with `variant="box"`. Pass a `now` that ticks at least while any row has `expireAt` (reuse the existing expiry timer pattern; optionally `requestAnimationFrame` or a 50ms interval while any timed row is live so the countdown line animates).

Export `ToastRow` from this module (or keep it file-private and duplicate minimal markup in the widget only if export is awkward — prefer one shared `ToastRow`).

- [ ] **Step 3: Update the stack call site and typecheck**

In `web/src/ui.tsx`, change `<AccountToastStack local={toast} />` to `<AccountToastStack />`. Leave the local `toast` / `show` state in place until Task 4 so existing `useToast` callers still compile; that local state simply will not render.

In `web/src/character/widgets.tsx`, stop reading `account.spoken`. Use `rows` for claiming the bubble:

```tsx
const {rows, claimBubble, dismiss, open} = useAccountToasts()
const showBubble = look.floating && rows.length > 0 && toastSurface({floating: true, covered}) === 'bubble'
```

Temporarily still render **only** `rows[0]` inside `.ac-say` (same single-row markup as today) so typecheck stays green; Task 3 replaces that with the full list.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add web/src/toasts/account.tsx web/src/ui.tsx
git commit -m "$(cat <<'EOF'
Push toasts through the account list and drop the local stack slot

EOF
)"
```

---

### Task 3: Speech-bubble list and countdown styles

**Files:**
- Modify: `web/src/character/widgets.tsx`
- Modify: `web/src/styles.css`
- Modify: `web/src/toasts/account.tsx` (if `ToastRow` needs a small export tweak)

**Interfaces:**
- Consumes: `useAccountToasts().rows`, `claimBubble`, `toastSurface`, `ToastRow`
- Produces: `.ac-say` list UI with per-row dismiss/open/countdown

- [ ] **Step 1: Update `AssistantCharacterWidget` bubble**

Replace the single-spoken bubble block with the full list:

```tsx
const {rows, claimBubble, dismiss, open} = useAccountToasts()
const covered = useCharacterCovered()
const showBubble = look.floating && rows.length > 0 && toastSurface({floating: true, covered}) === 'bubble'
useLayoutEffect(() => {
	claimBubble(showBubble)
	return () => claimBubble(false)
}, [showBubble, claimBubble])
// ...
{showBubble && (
	<div className={`ac-say${sayLeft ? '' : ' on-right'}`}>
		<div className="ac-say-list">
			{rows.map((row) => (
				<ToastRow key={row.id} row={row} now={now} onOpen={open} onDismiss={dismiss} variant="bubble" />
			))}
		</div>
	</div>
)}
```

Use the same `now` ticking strategy as the stack (lift a small `useToastClock(rows)` helper in `account.tsx` and export it, or duplicate the short effect). Prefer one shared hook in `account.tsx`:

```ts
export function useToastClock(rows: readonly ToastRecord[]) {
	const [now, setNow] = useState(() => Date.now())
	useEffect(() => {
		if (!rows.some((row) => row.expireAt != null)) return
		let id = 0
		const tick = () => {
			setNow(Date.now())
			id = window.setTimeout(tick, 50)
		}
		id = window.setTimeout(tick, 50)
		return () => window.clearTimeout(id)
	}, [rows])
	return now
}
```

Remove any leftover `spoken` / single `<p>` bubble markup.

- [ ] **Step 2: CSS for list + countdown**

In `web/src/styles.css`:

1. Make `.ac-say` a column container (padding adjusted) holding `.ac-say-list` with `display: flex; flex-direction: column; gap: 6px; max-height: min(40vh, 280px); overflow-y: auto;`.
2. Style `.ac-say-row` like the old single message row (flex, gap, problem color on text). Reuse `.ac-say-open` / `.ac-say-x`; add `.ac-say-text` mirroring `.ac-say p`.
3. Add countdown:

```css
.toast,
.ac-say-row {
	position: relative;
	overflow: hidden;
}
.toast-ttl {
	position: absolute;
	left: 10px;
	right: 10px;
	bottom: 0;
	height: 2px;
	border-radius: 1px;
	background: color-mix(in oklab, var(--fg) 25%, transparent);
	transform-origin: left center;
	transform: scaleX(var(--toast-ttl, 0));
	pointer-events: none;
}
.ac-say-row .toast-ttl {
	left: 14px;
	right: 48px;
}
.toast.problem .toast-ttl,
.toast.error .toast-ttl,
.ac-say-row.problem .toast-ttl {
	background: color-mix(in oklab, var(--red) 55%, transparent);
}
```

Ensure box `.toast` layout still works with `position: relative` inside `.toast-stack` (already overridden to relative there).

- [ ] **Step 3: Confirm transfer toasts list in the bubble**

With the floating character on, start a clip file transfer (or any existing server `toasts.add` path). Confirm more than one live transfer toast would stack as rows in `.ac-say` (use two sequential transfer messages if available). Full action-toast coverage is verified after Task 4.

- [ ] **Step 4: Commit**

```bash
git add web/src/character/widgets.tsx web/src/styles.css web/src/toasts/account.tsx
git commit -m "$(cat <<'EOF'
Show the toast list in the assistant speech bubble

EOF
)"
```

---

### Task 4: Wire `useToast` to account `push`

**Files:**
- Modify: `web/src/ui.tsx`

**Interfaces:**
- Consumes: `useAccountToasts().push`
- Produces: unchanged `useToast(): (text: string, error?: boolean) => void` call-site API

- [ ] **Step 1: Replace local toast state in `Providers`**

Inside `Providers` (already wrapped by `AccountToastProvider`):

1. Delete `Toast` local state, `announced` / `announcedRef`, toast timer / raf cleanup used only for toasts, and `liveRegionText(announced)` toast live regions **if** `AccountToastProvider` now owns announcement. Keep confirm-sheet UI.
2. Implement `show` as:

```ts
const account = useAccountToasts()
const show = useCallback((text: string, error = false) => {
	haptic(error ? [20, 40, 20] : 10)
	account.push(text, error)
}, [account])
```

3. Keep `ToastContext.Provider value={show}` so existing `useToast` imports from `ui` keep working.
4. Render `<AccountToastStack />` with no props.
5. Remove unused imports (`liveRegionText` if unused, `AccountToastStack` local type, etc.).

Because `useAccountToasts` must run under `AccountToastProvider`, either:

- nest an inner `function ProvidersInner` under the provider, or
- move `AccountToastProvider` to wrap only what needs it and put toast context inside it.

Recommended structure:

```tsx
export function Providers({children}: {children: ReactNode}) {
	return (
		<AccountToastProvider>
			<ProvidersInner>{children}</ProvidersInner>
		</AccountToastProvider>
	)
}

function ProvidersInner({children}: {children: ReactNode}) {
	const account = useAccountToasts()
	const show = useCallback((text: string, error = false) => {
		haptic(error ? [20, 40, 20] : 10)
		account.push(text, error)
	}, [account])
	// confirm state + sheet unchanged
	return (
		<ToastContext.Provider value={show}>
			<ConfirmContext.Provider value={confirm}>
				{children}
				{/* confirm sheet */}
				<AccountToastStack />
			</ConfirmContext.Provider>
		</ToastContext.Provider>
	)
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 3: Run toast unit tests**

Run: `node --experimental-strip-types --test test/toast-view.test.mjs test/toast-open.test.mjs test/toasts.test.mjs`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add web/src/ui.tsx
git commit -m "$(cat <<'EOF'
Route useToast through the signed-in toast store

EOF
)"
```

---

### Task 5: Docs vocabulary + verification

**Files:**
- Modify: `docs/style-guide.md`
- Modify: `docs/vision.md`

**Interfaces:**
- Consumes: vocabulary from the spec
- Produces: updated product docs

- [ ] **Step 1: Update style-guide § Notifications and clips**

Replace the mixed paragraph in `docs/style-guide.md` under `### Notifications and clips` so Notifications and Toasts are distinct. Keep the clip-book sentences. Target wording:

```markdown
### Notifications and clips

A **notification** is news for the whole server, such as a software update. It shows in the bell. It is not a toast.

A **toast** is feedback about something this signed-in person did or that belongs to their work — a VM starting, Copied, an install, a clip transfer, and the like. Every toast is stored for that account and appears on each of their signed-in sessions. When the floating assistant character is visible and not covered, toasts appear as a list in one speech bubble above the character; each row can be dismissed or opened on its own. When the character is hidden or covered, that same list sits at the top of the page. Timed toasts drop when their time ends; others wait until dismiss. Toasts never go on the bell. Notifications never go in the toast list or the speech bubble.

A clip names the machine it was copied from. The book is newest first. One row filters it: All, then text, picture, file, or folder, then missing, offline, or available. Copy puts the clip on this device. Send to this machine is offered only when that machine can take the clip. Both stay small. Several clips can be checked and sent or deleted together. The selection bar sits at the top of the list and stays at the top of the screen while that list scrolls. Text is joined onto one clipboard. Files, pictures, and folders go into one folder. A whole folder from another computer stays where it is. Text and files are not sent together. A row can send or delete without opening the clip. Delete asks in a small confirm. A file transfer is watched on the global Clip book. Clip book can be pinned to the dock or placed on the desktop.
```

Also fix § Pop-up if it only says “a toast” as chrome — leave it as UI chrome language; do not redefine Notifications there.

- [ ] **Step 2: Update vision**

Under `### Accounts and this application` in `docs/vision.md`, append:

```markdown
Notifications are server-wide and show in the bell. Toasts are feedback for the signed-in person and show above the floating assistant when that character is visible, or at the top of the page when it is not. The style guide names those channels.
```

- [ ] **Step 3: Final verification**

Run:

```bash
node --experimental-strip-types --test test/toast-view.test.mjs test/toast-open.test.mjs test/toasts.test.mjs
npm run typecheck
```

Expected: all PASS.

Manual checklist:

1. Floating character on → action toast (Copied / VM start) appears in the speech-bubble list, not only the top of the screen.
2. Two toasts at once → both rows visible; each dismiss works alone.
3. Timed row shows a thinning line; disappears at expiry.
4. Open a covering sheet / turn floating off → same toasts move to the top stack; return → back to the bubble.
5. Bell still shows update-available only; that text does not appear as a toast.
6. Second browser session for the same account eventually shows the toast via `toasts.list` poll.

- [ ] **Step 4: Commit**

```bash
git add docs/style-guide.md docs/vision.md
git commit -m "$(cat <<'EOF'
Document notification versus toast channels

EOF
)"
```

---

## Self-review (plan vs spec)

| Spec requirement | Task |
|------------------|------|
| Notification → bell only | Task 5 docs; no code path moves notifications into toasts |
| Toast → account store | Task 2 `push`, Task 4 `useToast` |
| Bubble list when character can speak | Task 3 |
| Top stack otherwise; no double display | Task 2 `claimBubble` + empty stack when `bubble` |
| Per-row dismiss / activate | Task 2 `ToastRow` |
| Countdown line on timed rows | Task 1 `toastRemaining`, Task 2–3 UI/CSS |
| Optimistic add + rollback | Task 2 |
| Remove spoken-only / local-only channel | Task 1, 2, 4 |
| style-guide + vision vocabulary | Task 5 |
| No live push required | Satisfied by existing poll + optimistic cache |

No TBD placeholders. TTL values match the spec. `ToastApi` names are consistent across tasks (`push`, `rows`, no `spoken`).
