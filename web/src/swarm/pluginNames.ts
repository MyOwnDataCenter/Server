type NamedPlugin = {id: string; name: string}
type PluginPage = {total: number; plugins: NamedPlugin[]}

// Every verified plugin's name by id, read page by page with no search text, so a computer's
// Installed rows keep one label whatever is typed in the search box.
export async function loadPluginNames(page: (offset: number) => Promise<PluginPage>, pageSize = 60, maxPages = 20): Promise<Map<string, string>> {
	const names = new Map<string, string>()
	for (let i = 0; i < maxPages; i++) {
		const got = await page(i * pageSize)
		for (const p of got.plugins) names.set(p.id, p.name)
		if (!got.plugins.length || (i + 1) * pageSize >= got.total) break
	}
	return names
}
