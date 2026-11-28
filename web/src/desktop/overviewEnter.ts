// Enter in the windows overview must not open the first app while the grid is hidden.
// Enter that confirms an input-method composition (Chinese, Japanese, Korean) belongs to the input method.
export function overviewEnterOpensApp(key: string, showApps: boolean, count: number, composing = false): boolean {
	return key === 'Enter' && showApps && count > 0 && !composing
}
