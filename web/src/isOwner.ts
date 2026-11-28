export type RoleLike = {role?: string | null} | null | undefined
/** Strict owner. Use for every UI gate that used to mix role==='owner' and role!=='member'. */
export function isOwner(user: RoleLike): boolean {
	return user?.role === 'owner'
}
