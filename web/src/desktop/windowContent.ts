type Payload = {tab?: string; page?: string; pageNonce?: number; rail?: {address?: string; title?: string}; store?: {id?: string; kind?: string; name?: string}}
type WinLike = {id: string; kind: string; payload?: Payload}

// Whether a desktop window's content is unchanged. A window that is opened again with a new payload
// (Appearance tab, Settings page, App Store aimed at another machine) must render the new one.
export function sameWindowContent(a: WinLike, b: WinLike): boolean {
	return (
		a.id === b.id &&
		a.kind === b.kind &&
		a.payload?.tab === b.payload?.tab &&
		a.payload?.page === b.payload?.page &&
		a.payload?.pageNonce === b.payload?.pageNonce &&
		a.payload?.rail?.address === b.payload?.rail?.address &&
		a.payload?.rail?.title === b.payload?.rail?.title &&
		a.payload?.store?.id === b.payload?.store?.id &&
		a.payload?.store?.kind === b.payload?.store?.kind &&
		a.payload?.store?.name === b.payload?.store?.name
	)
}
