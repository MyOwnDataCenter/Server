// Pure Files screen rules. The screen calls these; tests call them directly.

export function selectionAfterQuery<T>(selected: Set<T>, previousQuery: string, nextQuery: string): Set<T> {
  if (previousQuery === nextQuery) return selected;
  return new Set();
}

export type BatchKind = "trash" | "delete" | "restore";

// Null means no success toast: every call failed, and the error toast stands alone.
export function batchToast(succeeded: number, failed: number, kind: BatchKind): string | null {
  if (succeeded <= 0) return null;
  const total = succeeded + failed;
  if (failed > 0) {
    if (kind === "trash") return `${succeeded} of ${total} moved to Trash`;
    if (kind === "delete") return `Deleted ${succeeded} of ${total}`;
    return `Restored ${succeeded} of ${total}`;
  }
  if (kind === "delete") return "Deleted";
  if (kind === "trash") return succeeded === 1 ? "Moved to Trash" : `${succeeded} items moved to Trash`;
  return succeeded === 1 ? "Restored" : `${succeeded} items restored`;
}

// Download is one regular file. A folder or several paths would be a zip, which is not served.
export function offersDownload(items: readonly { directory: boolean }[]): boolean {
  return items.length === 1 && items[0].directory === false;
}

export function actionsForItems<T extends { id: string }>(
  actions: readonly T[],
  items: readonly { directory: boolean }[],
): T[] {
  if (offersDownload(items)) return [...actions];
  return actions.filter((a) => a.id !== "download" && a.id !== "download-zip");
}

const NICE: Record<string, string> = {
  "[already-exists]": "Something with that name is already there",
  "[destination-already-exists]": "Something with that name is already there",
  "[does-not-exist]": "That item no longer exists",
  "[subdir-of-self]": "A folder can’t go inside itself",
  "[operation-not-allowed]": "That isn’t allowed here",
  "[permission]": "You don’t have permission to change that folder",
  "[read-only]": "That folder is read-only",
  "[no-space]": "There isn’t enough free space",
  "[invalid-name]": "That name isn’t allowed",
  "[hidden-name]": "Names starting with a dot are hidden",
  "[cannot-trash]": "That can’t be moved to Trash",
  "[cannot-move]": "That can’t be moved",
  "[drive-root]": "A drive itself can’t be moved, renamed or put in Trash. Unmount it in Settings › Storage instead",
  "[cannot-rename]": "That can’t be renamed",
  "[cannot-create-here]": "Make it inside a drive. To add a drive, mount it in Settings › Storage",
  "[not-in-trash]": "That isn’t in Trash",
  "[only-from-trash]": "Only items in Trash can be deleted",
  "[outside-home]": "That isn’t inside Home",
  "[not-a-directory]": "That isn’t a folder",
  "[is-a-directory]": "That’s a folder, not a file",
};

/** Turn an omarchyd files error code into the sentence the Files screen shows. */
export function nice(msg: string): string {
  const notDir = /^\[not-a-directory:(.*)\]$/.exec(msg);
  if (notDir) return `${notDir[1]} is a file, not a folder`;
  if (NICE[msg]) return NICE[msg];
  // Only a bare code like [no-space] is turned into words; a real error text keeps its hyphens.
  const code = /^\[([\w-]+)\]$/.exec(msg);
  return code ? code[1].replace(/-/g, " ") : msg;
}

export const PHONE_FILES_PATH_KEY = "omarchy-server:files-path";
export const FILES_LIST_PAGE = 300;

export function filesPathStorageKey(windowId?: string | null): string {
  return windowId ? `${PHONE_FILES_PATH_KEY}:${windowId}` : PHONE_FILES_PATH_KEY;
}

/** Phone layout uses the shared key. Each desktop window uses its own key, then the folder it was opened on. */
export function readStoredFilesPath(
  windowId: string | undefined,
  initialPath: string | null | undefined,
  read: (key: string) => string | null,
): string | null {
  if (windowId) {
    const saved = read(filesPathStorageKey(windowId));
    if (saved !== null) return saved.length ? saved : null;
    return initialPath || null;
  }
  return initialPath || read(PHONE_FILES_PATH_KEY) || null;
}

/** null removes the key. A window stores "" for the start page so a new window does not inherit it. */
export function filesPathToStore(windowId: string | undefined, path: string | null): { key: string; value: string | null } {
  if (windowId) return { key: filesPathStorageKey(windowId), value: path ?? "" };
  return { key: PHONE_FILES_PATH_KEY, value: path };
}

export function filesListMoreLeft(total: number | undefined, shown: number): number {
  if (typeof total !== "number" || !Number.isFinite(total)) return 0;
  return Math.max(0, total - shown);
}

export type FileSearchPage<T> = { files: T[]; truncated: boolean };

export function asFileSearch<T>(data: T[] | { files?: T[]; truncated?: boolean } | null | undefined): FileSearchPage<T> {
  if (Array.isArray(data)) return { files: data, truncated: false };
  if (data && Array.isArray(data.files)) return { files: data.files, truncated: data.truncated === true };
  return { files: [], truncated: false };
}

export function searchMatchNote(count: number, truncated: boolean): string | null {
  if (!truncated) return null;
  return `Showing the first ${count.toLocaleString()} matches`;
}

export function viewerAfterPathChange<T extends { path: string; name: string }>(
  viewing: { files: T[]; index: number } | null,
  from: string,
  to: string | null,
): { files: T[]; index: number } | null {
  if (!viewing) return viewing;
  const i = viewing.files.findIndex((f) => f.path === from);
  if (i < 0) return viewing;
  if (to == null) {
    const files = viewing.files.filter((f) => f.path !== from);
    if (!files.length) return null;
    let index = viewing.index;
    if (i < viewing.index) index -= 1;
    if (index >= files.length) index = files.length - 1;
    if (index < 0) index = 0;
    return { files, index };
  }
  const name = to.slice(to.lastIndexOf("/") + 1) || viewing.files[i].name;
  const files = viewing.files.map((f, idx) => (idx === i ? { ...f, path: to, name } : f));
  return { files, index: viewing.index };
}

export function copyTextOrToast(
  write: ((text: string) => Promise<unknown>) | null | undefined,
  value: string,
  copied: () => void,
  fallback: (value: string) => void,
): void {
  if (typeof write !== "function") {
    fallback(value);
    return;
  }
  Promise.resolve()
    .then(() => write(value))
    .then(
      () => copied(),
      () => fallback(value),
    );
}
