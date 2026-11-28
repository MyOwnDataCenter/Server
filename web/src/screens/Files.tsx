// Files: the server as a NAS. Browse, preview, upload, download, organise, share on the network.
import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  mutate,
  query,
  type FileEntry,
  type Listing,
  type SmbShare,
  diskAll,
} from "../api";
import { useBootstrap, useDisk, useMachines, useUser } from "../data";
import { isOwner } from "../isOwner";
import { ComputerFolder } from "../fleet/ComputerFolder";
import { FittingCrumbs } from "../fleet/FittingCrumbs";
import { computerPlacePath, filePlaces, filesParent, parseComputerPlace, parseGuestPlace, scopeRoot, SERVER_FILES, withinScope, type FilesScope } from "../fleet/filePlaces";
import { fileClipInput } from "../clips/view";
import { NuEntries, type NuItem } from "../fleet/NuEntries";
import { queryProblem, useBrowserOnline } from "../connection";
import { Icon, type IconName } from "../icons";
import { Card, CardHead, Sheet, SheetHeader, bytes, haptic, scrollPhoneToTop, useConfirm, usePortalRoot, useToast } from "../ui";
import { SearchField } from "./Apps";
import { useDesktop } from "../desktop/Desktop";
import { canQuickTransfer, QuickTransferSheet, type TransferTarget } from "./QuickTransfer";
import { openTerminalWith } from "../terminalEvent";
import { safeLocal, safeSession } from "../safeStorage";
import { MachineTrees, TreeChildren, type TreeActions, type TreeMachine } from "../fleet/FileTree";
import { actionsForItems, asFileSearch, batchToast, copyTextOrToast, FILES_LIST_PAGE, filesListMoreLeft, filesPathToStore, nice, offersDownload, readStoredFilesPath, searchMatchNote, selectionAfterQuery, viewerAfterPathChange, type BatchKind } from "./filesRules";
import { canSubmitNamePrompt, collectUploadDirs, type DirectoryHandleLike, emptyFolderUploadHint, type FavoriteItem, favoritePath, fileKindLabel, filesSearching, filterUnsyncedPhotos, photosAlreadyThere, folderPickerRoots, handleFileDragEnter, handleFileDragOver, handleFileDrop, isServedFilePlace, pickDirectoryFromWindow, readDirectoryHandle, readDroppedEntries, reduceUploadMkdir, sharePasswordAction, sharePasswordLabel, shouldActivateRowOnKey, showFolderEmpty, UPLOAD_REFRESH_KEYS, uploadRelBlocked, type UploadBatch, type UploadMkdirState } from "../filesHelpers";

const FileViewer = lazy(() =>
  import("./viewer/FileViewer").then((m) => ({ default: m.FileViewer })),
);

// ---- helpers --------------------------------------------------------------------
const isDir = (f: FileEntry) => f.type === "directory";
function folderOf(filePath: string): string {
  const i = filePath.lastIndexOf("/");
  if (i <= 0) return "/Home";
  return filePath.slice(0, i);
}
// A pipe or socket is not a file. serveFile refuses it; the row must not offer Download or View.
const offersFile = (f: FileEntry) =>
  (f.operations as readonly string[]).includes("download");
const enc = encodeURIComponent;
export const viewUrl = (path: string) => `/api/files/view?path=${enc(path)}`;
export const downloadUrl = (paths: string[]) =>
  `/api/files/download?${paths.map((p) => `path=${enc(p)}`).join("&")}`;
const thumbUrl = (f: FileEntry) =>
  f.thumbnail
    ? `/api/files/thumbnail/${enc(f.thumbnail)}?path=${enc(f.path)}`
    : null;
const parentOf = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const ext = (name: string) =>
  name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";

function Shelf({title, empty, rows}: {title: string; empty: string; rows: {key: string; name: string; sub: string; favorite: boolean; onOpenLocation: () => void; onOpen?: () => void; onFavorite: () => void}[]}) {
  return (
    <details className="nu-recent">
      <summary>
        <Icon name="chevron" size={16} className="chev" />
        {title}
      </summary>
      <div className="nu-recent-body">
        {rows.length === 0 ? (
          <p className="quiet">{empty}</p>
        ) : (
          <ul>
            {rows.map((row) => (
              <li key={row.key}>
                <div className="nu-recent-row">
                  <div className="nu-recent-meta">
                    <b>{row.name}</b>
                    <span>{row.sub}</span>
                  </div>
                  <div className="nu-recent-actions">
                    <button type="button" aria-pressed={row.favorite} aria-label={row.favorite ? `Unfavorite ${row.name}` : `Favorite ${row.name}`} onClick={row.onFavorite}>
                      <Icon name={row.favorite ? "star-filled" : "star"} size={16} />
                    </button>
                    <button type="button" onClick={row.onOpenLocation}>
                      <Icon name="folder" size={16} />
                      Open Location
                    </button>
                    {row.onOpen && (
                      <button type="button" onClick={row.onOpen}>
                        <Icon name="file" size={16} />
                        Open
                      </button>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}

type Kind =
  | "folder"
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "text"
  | "sheet"
  | "doc"
  | "zip"
  | "disc"
  | "file";
function kindOf(f: FileEntry): Kind {
  if (isDir(f)) return "folder";
  const t = f.type;
  const e = ext(f.name);
  if (t.startsWith("image/")) return "image";
  if (t.startsWith("video/")) return "video";
  if (t.startsWith("audio/")) return "audio";
  if (t === "application/pdf") return "pdf";
  if (
    t.startsWith("text/") ||
    [
      "md",
      "json",
      "yml",
      "yaml",
      "log",
      "conf",
      "sh",
      "js",
      "ts",
      "py",
      "csv",
      "env",
      "toml",
      "ini",
      "xml",
    ].includes(e)
  )
    return "text";
  if (
    /spreadsheet|excel|csv/.test(t) ||
    ["xlsx", "xls", "numbers", "ods"].includes(e)
  )
    return "sheet";
  if (
    /word|document|rtf/.test(t) ||
    ["doc", "docx", "pages", "odt"].includes(e)
  )
    return "doc";
  if (
    /zip|tar|gzip|7z|rar|compressed/.test(t) ||
    ["zip", "gz", "tgz", "tar", "7z", "rar", "xz"].includes(e)
  )
    return "zip";
  if (
    /iso9660|disk-image/.test(t) ||
    ["iso", "img", "qcow2", "dmg"].includes(e)
  )
    return "disc";
  return "file";
}
const KIND_LOOK: Record<Kind, { icon: IconName; color: string }> = {
  folder: { icon: "folder-filled", color: "#60a5fa" },
  image: { icon: "image", color: "#f472b6" },
  video: { icon: "video", color: "#c084fc" },
  audio: { icon: "music", color: "#fb923c" },
  pdf: { icon: "pdf", color: "#f87171" },
  text: { icon: "file-text", color: "#a1a1aa" },
  sheet: { icon: "sheet", color: "#4ade80" },
  doc: { icon: "doc", color: "#60a5fa" },
  zip: { icon: "zip", color: "#facc15" },
  disc: { icon: "disc", color: "#2dd4bf" },
  file: { icon: "file", color: "#a1a1aa" },
};
const ago = (t: number) => {
  const d = (Date.now() - t) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  if (d < 86400 * 7) return `${Math.floor(d / 86400)} d ago`;
  return new Date(t).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year:
      new Date(t).getFullYear() === new Date().getFullYear()
        ? undefined
        : "numeric",
  });
};
const PLACE_NAMES: Record<string, string> = {
  "/Home": "Home",
  "/Apps": "App data",
  "/External": "External drives",
  "/Network": "Network",
  "/Trash": "Trash",
  "/Backups": "Backups",
  "/Machines": "Machines",
};
// Photos synced from your phone or computer live here (a normal folder in Home).
const PHOTOS = "/Home/Photos";
const titleOf = (path: string) => PLACE_NAMES[path] ?? baseName(path);
const pickerTitle = (dir: string, places: {path: string; name: string}[]) => {
  const place = places.find((p) => dir === p.path || dir.startsWith(`${p.path}/`));
  if (place && dir === place.path) return place.name;
  if (dir.startsWith("::")) return baseName(dir) || place?.name || "Folder";
  return titleOf(dir);
};

function FileIcon({ f, size = 44 }: { f: FileEntry; size?: number }) {
  const [failed, setFailed] = useState(false);
  const k = kindOf(f);
  const look = KIND_LOOK[k];
  const thumb = thumbUrl(f);
  if (thumb && !failed)
    return (
      <span className="file-icon thumb" style={{ width: size, height: size }}>
        <img
          src={thumb}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          draggable={false}
        />
      </span>
    );
  return (
    <span
      className="file-icon"
      style={{ width: size, height: size, "--c": look.color } as CSSProperties}
    >
      <Icon name={look.icon} size={size * 0.52} stroke={1.6} />
    </span>
  );
}

// ---- data ---------------------------------------------------------------------------
function useListing(path: string | null, sort: "name" | "modified" | "size", limit?: number) {
  return useQuery({
    queryKey: ["files.list", path, sort, limit ?? 0],
    queryFn: () =>
      query<Listing>("files.list", {
        path,
        sortBy: sort,
        sortOrder: sort === "name" ? "ascending" : "descending",
        ...(limit ? { limit } : {}),
      }),
    enabled: !!path && !path.startsWith("::"),
    refetchInterval: 15_000,
  });
}

function useFileAction() {
  const qc = useQueryClient();
  const toast = useToast();
  return async (path: string, input: unknown, done?: string) => {
    try {
      const result = await mutate(path, input);
      if (done) toast(done);
      return result;
    } catch (e) {
      toast(nice((e as Error).message), true);
      throw e;
    } finally {
      qc.invalidateQueries({ queryKey: ["files.list"] });
      qc.invalidateQueries({ queryKey: ["files.favorites"] });
      qc.invalidateQueries({ queryKey: ["files.recents"] });
      qc.invalidateQueries({ queryKey: ["files.fleetRecents"] });
      qc.invalidateQueries({ queryKey: ["swarm.files.list"] });
      qc.invalidateQueries({ queryKey: ["swarm.files.recents"] });
      qc.invalidateQueries({ queryKey: ["files.shares"] });
      qc.invalidateQueries({ queryKey: ["files.search"] });
    }
  };
}

// ---- uploads ----------------------------------------------------------------------------
type Upload = {
  id: number;
  name: string;
  loaded: number;
  total: number;
  state: "uploading" | "done" | "error";
  error?: string;
};
// An upload item: a file plus, for folder uploads, its path inside the dropped/picked folder.
export type UploadItem = { file: File; rel?: string };

// Big files go up in pieces, so no single request is large: a Cloudflare Tunnel refuses one over
// 100 MB (and other proxies have limits of their own), and a dropped connection costs one piece,
// not the whole file. See uploadChunk in omarchyd/files.mjs.
const UPLOAD_CHUNK = 8 * 1024 * 1024;

type ChunkReply = { status: number; body: { received?: number; path?: string; error?: { code?: string; message?: string } } | null };
function sendChunk(url: string, piece: Blob, onProgress: (loaded: number) => void): Promise<ChunkReply | null> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("x-omarchy-server", "1");
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      let body = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      resolve({ status: xhr.status, body });
    };
    // No answer at all (the connection dropped): tried again.
    xhr.onerror = () => resolve(null);
    xhr.ontimeout = () => resolve(null);
    xhr.timeout = 10 * 60 * 1000;
    xhr.send(piece);
  });
}

async function uploadInPieces(file: File, target: string, onProgress: (loaded: number) => void): Promise<void> {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const id = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const total = file.size;
  let offset = 0;
  let failures = 0;
  let resumes = 0;
  for (;;) {
    const piece = file.slice(offset, Math.min(offset + UPLOAD_CHUNK, total));
    const url = `/api/files/upload-chunk?path=${enc(target)}&collision=keep-both&id=${id}&offset=${offset}&total=${total}`;
    const start = offset;
    const r = await sendChunk(url, piece, (loaded) => onProgress(start + loaded));
    if (r && r.status >= 200 && r.status < 300) {
      offset = r.body?.received ?? offset + piece.size;
      failures = 0;
      onProgress(offset);
      if (r.body?.path || offset >= total) return;
      continue;
    }
    // The server has a different amount than this piece assumed: carry on from what it has.
    if (r?.status === 409 && typeof r.body?.received === "number" && resumes < 20) {
      offset = r.body.received;
      resumes += 1;
      continue;
    }
    // A real answer that isn't worth repeating (no space, not allowed, a name clash).
    if (r && r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) {
      throw new Error(r.body?.error?.message ?? `Upload failed (${r.status})`);
    }
    if (r?.status === 507) throw new Error(r.body?.error?.message ?? "Not enough free space on your server");
    failures += 1;
    if (failures > 5) throw new Error(r ? (r.body?.error?.message ?? `Upload failed (${r.status})`) : "Connection lost");
    await new Promise((res) => setTimeout(res, 1000 * failures));
  }
}

export function uploadOne(
  item: UploadItem,
  dir: string,
  onProgress: (loaded: number) => void,
): Promise<void> {
  const target = `${dir}/${item.rel ?? item.file.name}`;
  if (item.file.size > UPLOAD_CHUNK) return uploadInPieces(item.file, target, onProgress);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/files/upload?path=${enc(target)}&collision=keep-both`);
    xhr.setRequestHeader("x-omarchy-server", "1");
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let message = `Upload failed (${xhr.status})`;
      try {
        message = JSON.parse(xhr.responseText)?.error?.message ?? message;
      } catch {
        /* not JSON */
      }
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error("Connection lost"));
    xhr.send(item.file);
  });
}

function useUploads(onDone: () => void) {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const toast = useToast();
  const start = async (input: FileList | File[] | UploadItem[] | UploadBatch, dir: string) => {
    const raw = "dirs" in input ? input.files : input;
    const extraDirs = "dirs" in input ? input.dirs : [];
    const items: UploadItem[] = Array.from(raw as ArrayLike<File | UploadItem>).map((x) =>
      x instanceof File
        ? { file: x, rel: (x as File & { webkitRelativePath?: string }).webkitRelativePath || undefined }
        : x,
    );
    const dirs = collectUploadDirs(items, extraDirs);
    if (!items.length && !dirs.length) return;
    haptic(8);
    const ids = items.map(() => Math.random());
    if (items.length) {
      setUploads((u) => [
        ...u,
        ...items.map((it, i) => ({
          id: ids[i],
          name: it.rel ?? it.file.name,
          loaded: 0,
          total: it.file.size,
          state: "uploading" as const,
        })),
      ]);
    }
    // Folder uploads: make the folders first (parents before children). One that already
    // exists is fine. Any other mkdir error is shown once; files under that folder are not
    // uploaded, so a permission error is not reported again as "no longer exists".
    let mkdirState: UploadMkdirState = { failed: [], shown: false };
    for (const d of dirs) {
      if (mkdirState.failed.some((f) => d === f || d.startsWith(`${f}/`))) continue;
      let message: string | null = null;
      try {
        await mutate("files.createDirectory", { path: `${dir}/${d}` });
      } catch (e) {
        message = (e as Error).message;
      }
      const step = reduceUploadMkdir(mkdirState, d, message);
      mkdirState = { failed: step.failed, shown: step.shown };
      if (step.toast) toast(`${d}: ${nice(step.toast)}`, true);
    }
    const dirFailed = mkdirState.failed.length > 0;
    if (!items.length) {
      onDone();
      if (!dirFailed) toast(dirs.length === 1 ? "Folder created" : `${dirs.length} folders created`);
      return;
    }
    // Three at a time, so a folder of hundreds of files doesn't swamp the connection.
    let next = 0;
    let failed = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;
        const it = items[i];
        if (uploadRelBlocked(it.rel, mkdirState.failed)) {
          setUploads((u) => u.map((x) => (x.id === ids[i] ? { ...x, state: "error", error: "Skipped" } : x)));
          continue;
        }
        try {
          await uploadOne(it, dir, (loaded) =>
            setUploads((u) => u.map((x) => (x.id === ids[i] ? { ...x, loaded } : x))),
          );
          setUploads((u) => u.map((x) => (x.id === ids[i] ? { ...x, state: "done", loaded: x.total } : x)));
        } catch (e) {
          failed++;
          setUploads((u) => u.map((x) => (x.id === ids[i] ? { ...x, state: "error", error: (e as Error).message } : x)));
          if (failed <= 3) toast(`${it.rel ?? it.file.name}: ${nice((e as Error).message)}`, true);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, items.length) }, worker));
    onDone();
    if (failed > 3) toast(`${failed} files didn’t upload`, true);
    window.setTimeout(() => setUploads((u) => (u.some((x) => x.state !== "done") ? u : [])), 2500);
  };
  const clear = () => setUploads((u) => u.filter((x) => x.state === "uploading"));
  return { uploads, start, clear };
}

// Files and folders dropped from the computer. Folders are walked so their structure is kept.
async function droppedItems(dt: DataTransfer): Promise<UploadBatch> {
  const entries = [...dt.items]
    .map((i) => (i.kind === "file" ? (i as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.() : null))
    .filter(Boolean) as FileSystemEntry[];
  if (!entries.length) return { files: [...dt.files].map((file) => ({ file })), dirs: [] };
  return readDroppedEntries(entries);
}

// ---- screen -----------------------------------------------------------------------------
type Place = {
  path: string;
  label: string;
  icon: IconName;
  color: string;
  sub?: string;
};

export function Files({ initialPath, windowId, scope }: { initialPath?: string; windowId?: string; scope?: FilesScope } = {}) {
  const portalRoot = usePortalRoot();
  const boot = useBootstrap();
  const user = useUser();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const act = useFileAction();
  const disk = useDisk();
  const storageId = windowId ?? (scope ? `machine:${scope.kind === "computer" ? scope.id : "server"}` : undefined);
  const [nav, setNav] = useState(() => {
    const start = withinScope(scope, readStoredFilesPath(storageId, initialPath ?? (scope ? scopeRoot(scope) : undefined), (key) => safeSession.get(key)));
    return {entries: [start] as (string | null)[], index: 0};
  });
  const path = nav.entries[nav.index] ?? null;
  const [listLimit, setListLimit] = useState(FILES_LIST_PAGE);
  const [sort, setSort] = useState<"name" | "modified" | "size">("name");
  const [grid, setGrid] = useState(
    () => safeLocal.get("omarchy-server:files-grid") === "1",
  );
  const [q, setQ] = useState("");
  const searching = filesSearching(q);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<FileEntry | null>(null);
  // The full-window viewer: the files you can step through, and where you started.
  const [viewing, setViewing] = useState<{ files: FileEntry[]; index: number } | null>(null);
  const [picker, setPicker] = useState<{
    mode: "move" | "copy";
    paths: string[];
  } | null>(null);
  const [prompt, setPrompt] = useState<{
    kind: "folder" | "rename";
    entry?: FileEntry;
  } | null>(null);
  // The folder whose network sharing is open (share it, or see and change how it's shared).
  const [shareFor, setShareFor] = useState<{ path: string; name: string } | null>(null);
  // Quick transfer (desktop layout): a QR code for a phone, and the right-click menu on empty space.
  const deskMode = !!useDesktop();
  const [transfer, setTransfer] = useState<TransferTarget | null>(null);
  const [blankMenu, setBlankMenu] = useState<{ x: number; y: number } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);
  const rowApi = useRef({
    activate: (_f: FileEntry) => {},
    download: (_paths: string[]) => {},
    more: (_f: FileEntry) => {},
    menu: (_f: FileEntry) => {},
    long: (_f: FileEntry) => {},
  });
  const onRowActivate = useCallback((f: FileEntry) => rowApi.current.activate(f), []);
  const onRowDownload = useCallback((f: FileEntry) => rowApi.current.download([f.path]), []);
  const onRowMore = useCallback((f: FileEntry) => rowApi.current.more(f), []);
  const onRowMenu = useCallback((f: FileEntry) => rowApi.current.menu(f), []);
  const onRowLong = useCallback((f: FileEntry) => rowApi.current.long(f), []);
  const [openFolders, setOpenFolders] = useState<Set<string>>(() => new Set());
  const toggleFolder = useCallback((f: FileEntry) => {
    haptic(5);
    setOpenFolders((cur) => {
      const next = new Set(cur);
      if (next.has(f.path)) next.delete(f.path);
      else next.add(f.path);
      return next;
    });
  }, []);
  const onRowEnter = useCallback((f: FileEntry) => rowApi.current.activate(f), []);
  const refresh = () => {
    for (const key of UPLOAD_REFRESH_KEYS) qc.invalidateQueries({ queryKey: [...key] });
    qc.invalidateQueries({ queryKey: ["files.search"] });
  };
  const { uploads, start: upload, clear: clearUploads } = useUploads(refresh);

  useEffect(() => {
    const stored = filesPathToStore(storageId, path);
    if (stored.value === null) safeSession.remove(stored.key);
    else safeSession.set(stored.key, stored.value);
    setSelected(new Set());
    setOpenFolders(new Set());
    setListLimit(FILES_LIST_PAGE);
  }, [path, storageId]);
  // A new search hides the previous rows, so a selection from that folder must not stay live.
  // The same query (a folder refresh) keeps the selection.
  const seenQuery = useRef(q);
  useEffect(() => {
    const previous = seenQuery.current;
    seenQuery.current = q;
    setSelected((current) => selectionAfterQuery(current, previous, q));
  }, [q]);

  const listing = useListing(path, sort, listLimit);
  const searchPath =
    path && (path === "/Home" || path === "/Trash" || path.startsWith("/Home/") || path.startsWith("/Trash/"))
      ? path
      : "/Home";
  const owner = isOwner(user.data);
  const recents = useQuery({
    queryKey: ["files.recents"],
    queryFn: () => query<FileEntry[]>("files.recents"),
    enabled: scope?.kind === "server" || (!scope && !owner),
  });
  const fleetRecents = useQuery({
    queryKey: ["files.fleetRecents"],
    queryFn: () => query<FileEntry[]>("files.fleetRecents"),
    enabled: !scope && owner,
  });
  const computerRecents = useQuery({
    queryKey: ["swarm.files.recents", scope?.kind === "computer" ? scope.id : ""],
    queryFn: () => query<{files: {name: string; path: string; size: number; mtime: number; dir: boolean}[]}>("swarm.files.recents", {id: scope?.kind === "computer" ? scope.id : ""}),
    enabled: scope?.kind === "computer" && owner,
  });
  const favorites = useQuery({
    queryKey: ["files.favorites"],
    queryFn: () => query<FavoriteItem[]>("files.favorites"),
  });
  const machines = useMachines();
  const swarm = useQuery({
    queryKey: ["swarm.list"],
    queryFn: () => query<{ id: string; name: string; online: boolean; guestOf?: string; allowed?: { files?: boolean }; on?: { files?: boolean } }[]>("swarm.list"),
    enabled: owner,
    refetchInterval: 3000,
  });
  const computerFiles = filePlaces(
    (swarm.data ?? [])
      .filter((a) => !a.guestOf)
      .map((a) => ({
      id: a.id,
      name: a.name,
      online: a.online,
      filesGranted: !!(a.allowed?.files && a.on?.files),
    })),
    (machines.data ?? []).filter((m) => m.id !== "desktop").map((m) => {
      const agent = (swarm.data ?? []).find((a) => a.guestOf === m.id);
      const granted = !!(agent?.online && agent.allowed?.files && agent.on?.files);
      return {id: m.id, name: m.name, state: m.state, agentId: agent?.id, filesGranted: granted && m.state === "running"};
    }),
  );
  const shares = useQuery({
    queryKey: ["files.shares"],
    queryFn: () => query<SmbShare[]>("files.shares"),
    retry: false,
    enabled: owner,
  });
  const search = useQuery({
    queryKey: ["files.search", q, searchPath],
    queryFn: () =>
      query<FileEntry[] | { files: FileEntry[]; truncated?: boolean }>("files.search", {
        query: q,
        maxResults: 100,
        path: searchPath,
      }),
    enabled: searching,
    staleTime: 10_000,
  });
  const found = asFileSearch(search.data);
  const favSet = useMemo(() => new Set((favorites.data ?? []).map(favoritePath)), [favorites.data]);
  const shareMap = useMemo(
    () => new Map((shares.data ?? []).map((s) => [s.path, s])),
    [shares.data],
  );

  const go = (p: string | null, how: "push" | "replace" = "push") => {
    const next = withinScope(scope, p);
    haptic(5);
    setQ("");
    scrollPhoneToTop();
    setNav((n) => {
      if (how === "replace") {
        const entries = n.entries.slice(0, n.index);
        entries.push(next);
        return {entries, index: entries.length - 1};
      }
      const base = n.entries.slice(0, n.index + 1);
      if (base[base.length - 1] === next) return n;
      return {entries: [...base, next], index: base.length};
    });
  };
  const up = () => {
    if (!path) return;
    const parent = withinScope(scope, filesParent(path));
    if (parent === path) return;
    // No history yet, so Back walks up. Replacing keeps the next Back moving upward.
    go(parent, "replace");
  };
  const back = () => {
    if (nav.index > 0) {
      haptic(5);
      setQ("");
      scrollPhoneToTop();
      setNav((n) => ({...n, index: n.index > 0 ? n.index - 1 : 0}));
      return;
    }
    up();
  };
  const forward = () => {
    if (nav.index >= nav.entries.length - 1) return;
    haptic(5);
    setQ("");
    scrollPhoneToTop();
    setNav((n) => ({...n, index: Math.min(n.entries.length - 1, n.index + 1)}));
  };
  const inTrash = !!path && (path === "/Trash" || path.startsWith("/Trash/"));
  const selecting = selected.size > 0;
  // Where uploads go: the folder you're in (if My Own Data Center says it's writable), or Home from the start page.
  const writableHere =
    !!path && !path.startsWith("::") && !inTrash && listing.data?.operations?.includes("writable") !== false && !listing.error;
  const uploadDir = path === SERVER_FILES ? "/Home" : writableHere ? path : null;
  const canUpload = !!uploadDir;
  const uploadHint = !searching && !inTrash && !!path && !path.startsWith("::") ? emptyFolderUploadHint(canUpload) : null;
  const finePointer = typeof matchMedia !== "undefined" && matchMedia("(pointer: fine)").matches;
  // iPhone/iPad Safari can't pick a whole folder; computers can.
  const canPickFolder = finePointer && ("showDirectoryPicker" in window || "webkitdirectory" in HTMLInputElement.prototype);
  const pickFolder = async () => {
    if (!uploadDir) return;
    const win = window as Window & { showDirectoryPicker?: () => Promise<DirectoryHandleLike> };
    if (!win.showDirectoryPicker) return folderInput.current?.click();
    try {
      const handle = await pickDirectoryFromWindow(win);
      if (!handle) return;
      const batch = await readDirectoryHandle(handle);
      if (batch.files.length || batch.dirs.length) upload(batch, uploadDir);
    } catch (e) {
      if ((e as Error).name !== "AbortError") toast((e as Error).message, true);
    }
  };
  const toggle = (f: FileEntry) => {
    haptic(6);
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(f.path)) n.delete(f.path);
      else n.add(f.path);
      return n;
    });
  };
  const activate = (f: FileEntry) => {
    if (selecting) return toggle(f);
    if (isDir(f)) return go(f.path);
    haptic(6);
    if (inTrash || f.path.startsWith("/Trash/")) return setOpen(f);
    if (!offersFile(f)) return setOpen(f);
    viewFile(f);
  };
  const viewFile = (f: FileEntry) => {
    const files = items.filter((x) => !isDir(x));
    const index = files.findIndex((x) => x.path === f.path);
    setViewing(index < 0 ? { files: [f], index: 0 } : { files, index });
  };

  const places: Place[] = [
    { path: "/Home", label: "Home", icon: "home", color: "#3b82f6" },
    { path: PHOTOS, label: "Photos", icon: "image", color: "#ec4899" },
    { path: "::recents", label: "Recents", icon: "history", color: "#f59e0b" },
    { path: "::favorites", label: "Favorites", icon: "star", color: "#eab308" },
    { path: "/Apps", label: "App data", icon: "apps", color: "#8b5cf6" },
    { path: "/External", label: "Drives", icon: "usb", color: "#14b8a6" },
    { path: "/Network", label: "Network", icon: "server", color: "#0ea5e9" },
    { path: "/Trash", label: "Trash", icon: "trash", color: "#71717a" },
  ];
  const computerHere = path ? parseComputerPlace(path) : null;
  const guestHere = path ? parseGuestPlace(path) : null;
  const computerLabel = (id: string) => {
    const agent = swarm.data?.find((a) => a.id === id);
    if (!agent) return "Computer";
    if (agent.guestOf) return machines.data?.find((m) => m.id === agent.guestOf)?.name ?? agent.name;
    return agent.name;
  };
  const computerName = computerHere ? computerLabel(computerHere.id) : "";
  const guestName = guestHere ? (machines.data?.find((m) => m.id === guestHere.id)?.name ?? "Virtual machine") : "";
  const computerKnown = computerHere ? swarm.data?.find((a) => a.id === computerHere.id) : undefined;
  const computerBrowsable = !computerHere
    ? false
    : computerKnown
      ? !!(computerKnown.online && computerKnown.allowed?.files && computerKnown.on?.files)
      : !swarm.isFetched;

  const recentQuery = scope?.kind === "computer" ? computerRecents : !scope && owner ? fleetRecents : recents;
  const recentSource: FileEntry[] = (
    scope?.kind === "computer"
      ? (computerRecents.data?.files ?? []).flatMap((row) => {
          const next = computerPlacePath(scope.id, row.path);
          if (!next) return [];
          const entry: FileEntry = {
            name: row.name,
            path: next,
            type: row.dir ? "directory" : "application/octet-stream",
            size: row.size,
            modified: row.mtime,
            operations: ["favorite", "copy", "move"],
          };
          return [entry];
        })
      : !scope && owner
        ? (fleetRecents.data ?? [])
        : (recents.data ?? [])
  ).filter((f) => {
    if (scope?.kind === "computer") return f.path.startsWith(`::computer/${scope.id}/`);
    if (scope?.kind === "server") return !f.path.startsWith("::");
    return true;
  });

  // Items shown in the current view.
  const items: FileEntry[] = searching
      ? found.files
      : path === "::recents"
        ? recentSource
        : path === "::favorites"
          ? (favorites.data ?? []).map(
              (p) =>
                (typeof p === "string" ? {
                  name: baseName(p) || p,
                  path: p,
                  type: "directory",
                  modified: 0,
                  operations: ["favorite"],
                } : p) as FileEntry,
            )
          : (listing.data?.files ?? []);
  const folderListing = !!path && !path.startsWith("::") && !searching;
  const activeQ = searching
      ? search
      : path === "::recents"
        ? recentQuery
        : path === "::favorites"
          ? favorites
          : listing;
  const browserOnline = useBrowserOnline();
  const fileProblem = path !== null || searching ? queryProblem(activeQ, browserOnline) : null;
  const showEmpty = showFolderEmpty({
    error: folderListing ? listing.error : activeQ.error,
    count: items.length,
    suppress: fileProblem != null && activeQ.data == null,
  });
  const loading = searching
      ? search.isLoading
      : path === "::recents"
        ? recentQuery.isLoading
        : path && !path.startsWith("::")
          ? listing.isLoading
          : false;

  const finishBatch = async (
    paths: string[],
    kind: BatchKind,
    run: (p: string) => Promise<unknown>,
  ) => {
    let succeeded = 0;
    for (const p of paths) {
      try {
        await run(p);
        succeeded++;
      } catch {
        // useFileAction already showed this call's error.
      }
    }
    const message = batchToast(succeeded, paths.length - succeeded, kind);
    if (message) toast(message);
    setSelected(new Set());
    setOpen(null);
  };
  const trashItems = async (paths: string[]) => {
    const ok = await confirm({
      title:
        paths.length === 1
          ? `Move “${baseName(paths[0])}” to Trash?`
          : `Move ${paths.length} items to Trash?`,
      body: "You can restore them from Trash later.",
      confirm: "Move to Trash",
      danger: true,
      icon: "trash",
    });
    if (!ok) return;
    await finishBatch(paths, "trash", async (p) => {
      await act("files.trash", { path: p });
      setViewing((v) => viewerAfterPathChange(v, p, null));
    });
  };
  const deleteForever = async (paths: string[]) => {
    const ok = await confirm({
      title:
        paths.length === 1
          ? `Delete “${baseName(paths[0])}” forever?`
          : `Delete ${paths.length} items forever?`,
      body: "This can’t be undone.",
      confirm: "Delete forever",
      danger: true,
      icon: "trash",
    });
    if (!ok) return;
    await finishBatch(paths, "delete", async (p) => {
      await act("files.delete", { path: p });
      setViewing((v) => viewerAfterPathChange(v, p, null));
    });
  };
  const restore = async (paths: string[]) => {
    await finishBatch(paths, "restore", (p) =>
      act("files.restore", { path: p, collision: "keep-both" }),
    );
  };
  const emptyTrash = async () => {
    if (
      !(await confirm({
        title: "Empty Trash?",
        body: "Everything in Trash is deleted forever.",
        confirm: "Empty Trash",
        danger: true,
        icon: "trash",
      }))
    )
      return;
    await act("files.emptyTrash", undefined, "Trash emptied").catch(() => {});
  };
  const download = (paths: string[]) => {
    haptic(6);
    const a = document.createElement("a");
    a.href = downloadUrl(paths);
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast(paths.length > 1 ? "Downloading as a zip" : "Downloading");
  };
  const toggleFavorite = (p: string) =>
    act(
      favSet.has(p) ? "files.removeFavorite" : "files.addFavorite",
      { path: p },
      favSet.has(p) ? "Removed from Favorites" : "Added to Favorites",
    );
  const toggleShare = (f: FileEntry) => {
    setOpen(null);
    setShareFor({ path: f.path, name: f.name });
  };
  const used = disk.data ? (diskAll(disk.data).total > 0 ? diskAll(disk.data).used / diskAll(disk.data).total : 0) : 0;

  // The machine Files runs on is called the host server here, next to its computers and VMs.
  const serverName = "Host server";
  const heading =
    path === null
      ? "Files"
      : guestHere
        ? guestName
        : computerHere
          ? computerHere.rel.split("/").filter(Boolean).pop() || computerName
          : path === SERVER_FILES
          ? serverName
          : path === "::recents"
            ? "Recents"
            : path === "::favorites"
              ? "Favorites"
              : titleOf(path);
  const crumbs: {name: string; path: string | null}[] = [];
  const pushComputer = (id: string, label: string, rel: string) => {
    const root = computerPlacePath(id);
    if (root) crumbs.push({name: label, path: root});
    const parts = rel.split("/").filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const next = computerPlacePath(id, parts.slice(0, i + 1).join("/"));
      if (next) crumbs.push({name: parts[i], path: next});
    }
  };
  const pushServer = (from: string | null) => {
    crumbs.push({name: serverName, path: SERVER_FILES});
    if (!from || from === SERVER_FILES || parseComputerPlace(from)) return;
    if (from === "::recents" || from === "::favorites") {
      crumbs.push({name: heading, path: from});
      return;
    }
    if (from.startsWith("::")) return;
    const parts = from.split("/").filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const p = `/${parts.slice(0, i + 1).join("/")}`;
      crumbs.push({name: titleOf(p), path: p});
    }
  };
  if (scope?.kind === "computer") pushComputer(scope.id, scope.name, computerHere?.id === scope.id ? computerHere.rel : "");
  else if (scope?.kind === "server") pushServer(path);
  else {
    crumbs.push({name: "Files", path: null});
    if (path && guestHere) crumbs.push({name: guestName, path});
    else if (path && computerHere) pushComputer(computerHere.id, computerName, computerHere.rel);
    else if (path) pushServer(path);
  }
  const parentPath = path ? withinScope(scope, filesParent(path)) : null;
  const canBack = nav.index > 0 || (!!path && parentPath !== path);
  const canForward = nav.index < nav.entries.length - 1;
  const onServer = !!path && !computerHere && !guestHere;
  const machineRoot = path === null && !searching;
  const serverPlacesView = path === SERVER_FILES && !searching;
  const setFileMode = (next: boolean) => {
    haptic(5);
    safeLocal.set("omarchy-server:files-grid", next ? "1" : "0");
    setGrid(next);
  };
  const rootItems: NuItem[] = [
    {key: "server", name: serverName, modified: boot.server?.device || "Entrypoint", icon: "server", onOpen: () => go(SERVER_FILES)},
    ...(owner ? [] : computerFiles.places.map((p) => ({key: `${p.kind}:${p.id}`, name: p.name, icon: p.kind === "guest" ? ("machine" as const) : ("devices" as const), onOpen: () => go(p.path)}))),
  ];
  // Connected computers and the virtual machines running on this server, each a tree of its files.
  const agentsAll = swarm.data ?? [];
  const treeMachines: TreeMachine[] = [
    ...agentsAll
      .filter((a) => !a.guestOf)
      .map((a) => {
        const filesOn = !!(a.allowed?.files && a.on?.files);
        return {
          key: `computer:${a.id}`,
          name: a.name,
          kind: "computer" as const,
          agentId: a.id,
          ready: a.online && filesOn,
          note: !a.online ? "Offline" : !a.allowed?.files ? "Files isn’t allowed" : !a.on?.files ? "Files is off · Machines" : "Home folder",
        };
      }),
    ...(machines.data ?? [])
      .filter((m) => m.id !== "desktop" && m.state === "running")
      .map((m) => {
        const agent = agentsAll.find((a) => a.guestOf === m.id);
        const filesOn = !!(agent?.allowed?.files && agent?.on?.files);
        return {
          key: `vm:${m.id}`,
          name: m.name,
          kind: "vm" as const,
          agentId: agent?.id,
          ready: !!agent?.online && filesOn,
          note: !agent ? "Install the connector to browse" : !agent.online ? "Connector offline" : !filesOn ? "Files is off · Machines" : "Virtual machine",
        };
      }),
  ];
  const treeActions: TreeActions = {
    onOpenFolder: (source, p) => {
      if (source.kind === "server") return go(p);
      const next = computerPlacePath(source.id, p);
      if (next) go(next);
    },
    onOpenFile: (source, node) => {
      if (source.kind === "server") return node.entry ? openShown(node.entry) : undefined;
      const next = computerPlacePath(source.id, node.path.split("/").slice(0, -1).join("/"));
      if (next) go(next);
    },
  };
  const placeLabel = (filePath: string) => {
    const computer = parseComputerPlace(filePath);
    if (computer) return computerLabel(computer.id);
    const guest = parseGuestPlace(filePath);
    if (guest) return machines.data?.find((m) => m.id === guest.id)?.name ?? "Virtual machine";
    return serverName;
  };
  const openLocation = (filePath: string) => {
    if (parseComputerPlace(filePath) || parseGuestPlace(filePath)) return go(filesParent(filePath));
    go(folderOf(filePath));
  };
  const openShown = (f: FileEntry) => {
    if (f.path.startsWith("::")) return;
    if (isDir(f)) return go(f.path);
    if (offersFile(f) && !f.path.startsWith("/Trash/")) return viewFile(f);
    setOpen(f);
  };
  const shelfRow = (f: FileEntry) => ({
    key: f.path,
    name: f.name,
    sub: `${f.size != null ? bytes(f.size) : "–"} · ${placeLabel(f.path)}`,
    favorite: favSet.has(f.path),
    onOpenLocation: () => openLocation(f.path),
    onOpen: f.path.startsWith("::") ? undefined : () => openShown(f),
    onFavorite: () => toggleFavorite(f.path),
  });
  const recentRows = recentSource.map(shelfRow);
  const favoriteRows = (favorites.data ?? [])
    .map((item) => (typeof item === "string" ? ({name: baseName(item) || item, path: item, type: "directory", modified: 0, operations: ["favorite"]} as FileEntry) : item))
    .filter((f) => {
      if (scope?.kind === "computer") return f.path.startsWith(`::computer/${scope.id}/`);
      if (scope?.kind === "server") return !f.path.startsWith("::");
      return true;
    })
    .map(shelfRow);
  const placeItems: NuItem[] = places
    .filter((p) => isServedFilePlace(p.path))
    .map((p) => ({
      key: p.path,
      name: p.label,
      icon: p.icon,
      onOpen: () =>
        p.path === PHOTOS
          ? mutate("files.createDirectory", {path: PHOTOS})
              .catch(() => {})
              .finally(() => go(PHOTOS))
          : go(p.path),
    }));
  const bar = (
    <div className="nu-bar">
      <h1 className="sr-only">{heading}</h1>
      <button type="button" className="nu-nav" aria-label="Back" onClick={back} disabled={!canBack}>
        <Icon name="back" size={16} />
      </button>
      <button type="button" className="nu-nav" aria-label="Forward" onClick={forward} disabled={!canForward}>
        <Icon name="chevron" size={16} />
      </button>
      <FittingCrumbs crumbs={crumbs} onOpen={(next) => go(next)} />
      {owner && path && path.startsWith("/Home/") && (
        <button
          className="nu-nav"
          aria-label="Share this folder on your home LAN"
          title="Share on your home LAN"
          aria-pressed={shareMap.has(path)}
          onClick={() => (haptic(5), setShareFor({path, name: titleOf(path)}))}
        >
          <Icon name="folder-share" size={16} />
        </button>
      )}
      {path && !path.startsWith("::") && (
        <button
          type="button"
          className="nu-nav"
          aria-label={`Sort by ${sort === "name" ? "date" : sort === "modified" ? "size" : "name"}`}
          onClick={() => {
            haptic(5);
            const next = sort === "name" ? "modified" : sort === "modified" ? "size" : "name";
            setSort(next);
            toast(`Sorted by ${next === "modified" ? "date" : next}`);
          }}
        >
          <Icon name="sort" size={16} />
        </button>
      )}
      <div className="nu-modes" role="group" aria-label="View">
        <button type="button" aria-label="List" aria-pressed={!grid} onClick={() => setFileMode(false)}>
          <Icon name="list" size={16} />
        </button>
        <button type="button" aria-label="Grid" aria-pressed={grid} onClick={() => setFileMode(true)}>
          <Icon name="grid" size={16} />
        </button>
      </div>
    </div>
  );

  rowApi.current.activate = activate;
  rowApi.current.download = download;
  rowApi.current.more = (f) => {
    haptic(6);
    setOpen(f);
  };
  rowApi.current.menu = (f) => setOpen(f);
  rowApi.current.long = (f) => {
    if (!f.operations.length) return;
    haptic(15);
    setSelected((s) => new Set(s).add(f.path));
  };
  const showParent = searching;
  // In the list view a folder opens in place, as a tree; its arrow (or the sidebar) goes into it.
  const treeRows = !grid && !selecting && !searching && !inTrash && !!path && !path.startsWith("::");
  const renderRow = (f: FileEntry) =>
    treeRows && isDir(f) ? (
      <div key={f.path} className={`file-tree-row${openFolders.has(f.path) ? " open" : ""}`}>
        <FileRow
          f={f}
          grid={false}
          selected={false}
          selecting={false}
          favorite={favSet.has(f.path)}
          shared={shareMap.has(f.path)}
          inTrash={false}
          showParent={showParent}
          activate={toggleFolder}
          onMore={onRowMore}
          onDownload={onRowDownload}
          onFavorite={(f) => toggleFavorite(f.path)}
          onLong={onRowLong}
          onMenu={onRowMenu}
          onEnter={onRowEnter}
        />
        {openFolders.has(f.path) && <TreeChildren source={{ kind: "server" }} path={f.path} depth={1} actions={treeActions} />}
      </div>
    ) : (
    <FileRow
      key={f.path}
      f={f}
      grid={grid}
      selected={selected.has(f.path)}
      selecting={selecting}
      favorite={favSet.has(f.path)}
      shared={shareMap.has(f.path)}
      inTrash={inTrash}
      showParent={showParent}
      activate={onRowActivate}
      onMore={onRowMore}
      onDownload={onRowDownload}
      onFavorite={(f) => toggleFavorite(f.path)}
      onLong={onRowLong}
      onMenu={onRowMenu}
    />
  );

  const onDragEnter = (e: React.DragEvent) => {
    if (!handleFileDragEnter(e, canUpload)) return;
    dragDepth.current++;
    setDropping(true);
  };
  const onDragOver = (e: React.DragEvent) => {
    handleFileDragOver(e, canUpload);
  };
  const onDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (!dragDepth.current) setDropping(false);
  };
  const onDrop = async (e: React.DragEvent) => {
    const allowed = handleFileDrop(e, canUpload && !!uploadDir);
    dragDepth.current = 0;
    setDropping(false);
    if (!allowed || !uploadDir) return;
    const batch = await droppedItems(e.dataTransfer).catch((): UploadBatch => ({ files: [], dirs: [] }));
    if (batch.files.length || batch.dirs.length) upload(batch, uploadDir);
  };
  // Ordinary Copy fills the book. The destination picker still opens from the Copy action.
  // A keyboard copy only fills the book. Success stays quiet; a refusal is the toast.
  const rememberClip = (paths: string[], cut = false) => {
    const places = paths.map((item) => parseComputerPlace(item));
    const head = places[0];
    const sameComputer = !!head && places.every((item) => item && item.rel && item.id === head.id);
    const input = sameComputer
      ? fileClipInput("swarm", head.id, places.map((item) => item!.rel), cut)
      : places.some(Boolean)
        ? null
        : fileClipInput("server", undefined, paths, cut);
    if (!input) return false;
    mutate("clips.addFile", input)
      .then(() => qc.invalidateQueries({ queryKey: ["clips.list"] }))
      .catch((err: Error) => toast(err.message, true));
    return true;
  };
  const onClipKey = (e: React.KeyboardEvent) => {
    if (e.altKey || e.repeat || !(e.ctrlKey || e.metaKey)) return;
    const key = e.key.toLowerCase();
    if (key !== "c" && key !== "x") return;
    const target = e.target;
    if (target instanceof HTMLElement && target.closest("input, textarea, [contenteditable=true]")) return;
    const paths = selected.size ? [...selected] : open ? [open.path] : [];
    if (!paths.length || !rememberClip(paths, key === "x")) return;
    e.preventDefault();
  };

  return (
    <div
      className={`stagger files-root nu${scope ? " nu-embedded" : ""}`}
      onKeyDown={onClipKey}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onContextMenu={(e) => {
        // A row's own right-click has already been handled; this is empty space in the folder.
        if (e.defaultPrevented || !deskMode || inTrash || !path || !canQuickTransfer(path)) return;
        if ((e.target as HTMLElement).closest("input, textarea, [contenteditable=true]")) return;
        e.preventDefault();
        setBlankMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => (
          uploadDir && e.target.files && upload(e.target.files, uploadDir),
          (e.target.value = "")
        )}
      />
      <input
        ref={photoInput}
        type="file"
        accept="image/*,video/*"
        multiple
        hidden
        onChange={async (e) => {
          const picked = e.target.files ? [...e.target.files] : [];
          e.target.value = "";
          if (!picked.length) return;
          // Sync: upload only what isn't in Photos yet (same name or keep-both copy, and size).
          // The listing on screen is one page, so a big Photos folder is read in full first.
          let existing: FileEntry[];
          try {
            existing = await photosAlreadyThere(listing.data, () => query<Listing>("files.list", { path: PHOTOS, sortBy: "name", sortOrder: "ascending" }));
          } catch (err) {
            return toast(nice((err as Error).message), true);
          }
          const fresh = filterUnsyncedPhotos(picked, existing);
          const skipped = picked.length - fresh.length;
          if (!fresh.length) return toast(`All ${picked.length} already synced`);
          if (skipped) toast(`${fresh.length} new · ${skipped} already synced`);
          upload(fresh, PHOTOS);
        }}
      />
      <input
        ref={folderInput}
        type="file"
        multiple
        hidden
        {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
        onChange={(e) => (
          uploadDir && e.target.files && upload(e.target.files, uploadDir),
          (e.target.value = "")
        )}
      />
      {bar}
      <SearchField
        value={q}
        onChange={setQ}
        placeholder={path === null ? "Search all files" : `Search files`}
      />
      {canUpload && !searching && !selecting && (
        <div className="files-actions">
          {path === PHOTOS && (
            <button className="btn primary" onClick={() => photoInput.current?.click()} disabled={listing.isLoading}>
              <Icon name="restart" size={18} />
              Sync photos
            </button>
          )}
          <button className={`btn${path === PHOTOS ? "" : " primary"}`} onClick={() => fileInput.current?.click()}>
            <Icon name="upload" size={18} />
            {path === SERVER_FILES ? "Upload to Home" : "Upload"}
          </button>
          {canPickFolder && (
            <button className="btn" onClick={pickFolder}>
              <Icon name="folder-share" size={18} />
              Upload folder
            </button>
          )}
          {path && !path.startsWith("::") && (
            <button className="btn" onClick={() => setPrompt({ kind: "folder" })}>
              <Icon name="folder-plus" size={18} />
              New folder
            </button>
          )}
          {finePointer && <span className="drop-hint">or drop files here</span>}
        </div>
      )}

      <div className="nu-body">
        {!scope && <aside className="nu-side" aria-label="Places">
          <h3>Places</h3>
          <button type="button" className="nu-place" aria-current={path === null ? "page" : undefined} onClick={() => go(null)}>
            <span className="dot" />
            Files
          </button>
          <button type="button" className="nu-place" aria-current={onServer ? "page" : undefined} onClick={() => go(SERVER_FILES)}>
            <span className="dot" />
            {serverName}
          </button>
          {computerFiles.places.map((p) => (
            <button
              key={`${p.kind}:${p.id}`}
              type="button"
              className="nu-place"
              aria-current={p.kind === "guest" ? (guestHere?.id === p.id ? "page" : undefined) : computerHere?.id === p.id ? "page" : undefined}
              onClick={() => go(p.path)}
            >
              <span className="dot" />
              {p.name}
            </button>
          ))}
        </aside>}
        <div className="nu-main">
      <Shelf title="Favorites" empty={favorites.isLoading ? "Loading…" : "No favorites yet."} rows={favoriteRows} />
      <Shelf title="Recent" empty={recentQuery.isLoading ? "Loading…" : "No recent files."} rows={recentRows} />
      {machineRoot && (
        <>
          <NuEntries items={rootItems} grid={grid} />
          <div className="nu-status">
            {rootItems.length} item{rootItems.length === 1 ? "" : "s"}
          </div>
          {owner && <MachineTrees machines={treeMachines} actions={treeActions} />}
        </>
      )}

      {serverPlacesView && (
        <>
          <NuEntries items={placeItems} grid={grid} />
          {disk.data && (
            <Card className="storage-card">
              <CardHead
                title="Storage"
                extra={
                  <>
                    {bytes(diskAll(disk.data).available, 0)} free of{" "}
                    {bytes(diskAll(disk.data).total, 0)}
                  </>
                }
                style={{ marginBottom: 10 }}
              />
              <span className="progress" style={{ height: 8 }}>
                <i
                  style={{
                    width: `${used * 100}%`,
                    background:
                      used > 0.9
                        ? "var(--red)"
                        : used > 0.75
                          ? "var(--yellow)"
                          : "var(--accent-text)",
                  }}
                />
              </span>
              {(disk.data.drives ?? []).map((d) => (
                <button key={d.folder} type="button" className="storage-drive" onClick={() => go(d.folder)}>
                  <Icon name="disk" size={16} />
                  <span className="name">{d.name}</span>
                  <span className="muted">
                    {bytes(d.available, 0)} free of {bytes(d.size, 0)}
                  </span>
                </button>
              ))}
            </Card>
          )}
          {owner && <MachineTrees machines={treeMachines} actions={treeActions} />}
          {(shares.data?.length ?? 0) > 0 && (
            <section>
              <div className="section-head">
                <h2>Shared on your network</h2>
              </div>
              <div
                className="glass group"
                style={{ "--inset": "74px" } as CSSProperties}
              >
                {shares.data!.map((s) => (
                  <button
                    key={s.path}
                    className="row"
                    onClick={() => setShareFor({ path: s.path, name: s.name })}
                  >
                    <span
                      className="file-icon"
                      style={
                        {
                          width: 44,
                          height: 44,
                          "--c": "#0ea5e9",
                        } as CSSProperties
                      }
                    >
                      <Icon name="folder-share" size={23} />
                    </span>
                    <span className="main">
                      <b>{s.name}</b>
                      <span className="mono">
                        {s.available === false
                          ? "Unavailable · this folder is gone"
                          : `smb://${boot.server?.host}/${s.sharename}`}
                      </span>
                    </span>
                    <Icon name="chevron" size={18} className="chev" />
                  </button>
                ))}
              </div>
            </section>
          )}
          <div className="nu-status">
            {placeItems.length} item{placeItems.length === 1 ? "" : "s"}
          </div>
        </>
      )}

      {guestHere && (
        <div className="glass empty">
          <b>Empty folder</b>
        </div>
      )}

      {computerHere && !computerBrowsable && (
        <div className="glass empty">
          <b>Empty folder</b>
        </div>
      )}

      {computerHere && computerBrowsable && (
        <ComputerFolder
          id={computerHere.id}
          rel={computerHere.rel}
          grid={grid}
          favoriteOf={(rel) => {
            const next = computerPlacePath(computerHere.id, rel)
            return !!next && favSet.has(next)
          }}
          onToggleFavorite={(rel) => {
            const next = computerPlacePath(computerHere.id, rel)
            if (next) toggleFavorite(next)
          }}
          onOpen={(rel) => {
            const next = computerPlacePath(computerHere.id, rel)
            if (next) go(next)
          }}
          onMove={(rel) => {
            const next = computerPlacePath(computerHere.id, rel);
            if (next) setPicker({mode: "move", paths: [next]});
          }}
          onCopy={(rel) => {
            const next = computerPlacePath(computerHere.id, rel);
            if (next) setPicker({mode: "copy", paths: [next]});
            const input = fileClipInput("swarm", computerHere.id, [rel]);
            if (!input) return;
            mutate("clips.addFile", input)
              .then(() => qc.invalidateQueries({ queryKey: ["clips.list"] }))
              .catch((err: Error) => toast(err.message, true));
          }}
        />
      )}

      {(path !== null || searching) && !computerHere && !guestHere && !serverPlacesView && (
        <>
          {inTrash && (listing.data?.files.length ?? 0) > 0 && !selecting && (
            <button
              className="btn danger block"
              style={{ marginBottom: 12, minHeight: 46 }}
              onClick={emptyTrash}
            >
              <Icon name="trash" size={18} />
              Empty Trash
            </button>
          )}
          {fileProblem && (
            <div className="error" role="alert">
              <Icon name="alert" size={18} />
              {activeQ.error ? nice((activeQ.error as Error).message) : fileProblem}
            </div>
          )}
          {loading ? (
            <div className="glass group screen-list">
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} className="row static">
                  <div
                    className="skeleton"
                    style={{ width: 44, height: 44, borderRadius: 12 }}
                  />
                  <div style={{ flex: 1 }}>
                    <div
                      className="skeleton"
                      style={{ width: "55%", height: 12, marginBottom: 8 }}
                    />
                    <div
                      className="skeleton"
                      style={{ width: "30%", height: 10 }}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : showEmpty ? (
            <div className="glass empty">
              <span className="big">
                <Icon
                  name={
                    searching
                      ? "search"
                      : inTrash
                        ? "trash"
                        : path === "::recents"
                          ? "history"
                          : path === "::favorites"
                            ? "star"
                            : "folder"
                  }
                  size={30}
                />
              </span>
              <b>
                {searching
                  ? "No matches"
                  : inTrash
                    ? "Trash is empty"
                    : path === "::recents"
                      ? "No recent files yet"
                      : path === "::favorites"
                        ? "No favorites yet"
                        : "This folder is empty"}
              </b>
              {uploadHint && <span>{uploadHint}</span>}
            </div>
          ) : items.length === 0 ? null : grid && !searching ? (
            <div className="file-grid screen-list glass">
              {items.map((f) => renderRow(f))}
            </div>
          ) : (
            <div
              className="glass group screen-list"
              style={
                { "--inset": selecting ? "110px" : "74px" } as CSSProperties
              }
            >
              {items.map((f) => renderRow(f))}
            </div>
          )}
          {showParent && searchMatchNote(found.files.length, found.truncated) ? (
            <p className="footer-note">{searchMatchNote(found.files.length, found.truncated)}</p>
          ) : null}
          {folderListing && listing.data?.hasMore ? (
            <button className="btn" style={{ marginTop: 12 }} onClick={() => setListLimit((n) => n + FILES_LIST_PAGE)}>
              Show more ({filesListMoreLeft(listing.data.totalFiles, listing.data.files.length).toLocaleString()} left)
            </button>
          ) : null}
        </>
      )}
        </div>
      </div>

      {createPortal(
        <>
          {dropping && uploadDir && (
            <div className="drop-zone" aria-hidden="true">
              <span>
                <Icon name="upload" size={34} />
                <b>Drop to upload</b>
                <small>to {titleOf(uploadDir)}</small>
              </span>
            </div>
          )}

          {/* Selection bar */}
          {selecting && (
            <div className="select-bar" onKeyDown={onClipKey}>
              <button
                className="sb-cancel"
                aria-label={`Cancel selection, ${selected.size} selected`}
                onClick={() => setSelected(new Set())}
              >
                <Icon name="close" size={18} stroke={2.2} />
                <span className="num">{selected.size}</span>
              </button>
              {inTrash ? (
                <>
                  <button onClick={() => restore([...selected])}>
                    <Icon name="restore" size={21} />
                    Restore
                  </button>
                  <button
                    className="danger"
                    onClick={() => deleteForever([...selected])}
                  >
                    <Icon name="trash" size={21} />
                    Delete
                  </button>
                </>
              ) : (
                <>
                  {offersDownload(
                    [...selected].map((p) => {
                      const hit = items.find((it) => it.path === p);
                      return { directory: !hit || isDir(hit) || !offersFile(hit) };
                    }),
                  ) && (
                    <button onClick={() => download([...selected])}>
                      <Icon name="download" size={21} />
                      Download
                    </button>
                  )}
                  <button
                    onClick={() =>
                      setPicker({ mode: "move", paths: [...selected] })
                    }
                  >
                    <Icon name="move" size={21} />
                    Move
                  </button>
                  <button
                    onClick={() => {
                      const paths = [...selected];
                      setPicker({ mode: "copy", paths });
                      rememberClip(paths);
                    }}
                  >
                    <Icon name="copy" size={21} />
                    Copy
                  </button>
                  <button
                    className="danger"
                    onClick={() => trashItems([...selected])}
                  >
                    <Icon name="trash" size={21} />
                    Trash
                  </button>
                </>
              )}
            </div>
          )}

          {uploads.length > 0 && (
            <UploadPanel uploads={uploads} onClear={clearUploads} />
          )}
        </>,
        portalRoot,
      )}


      {viewing && (
        <Suspense
          fallback={
            <main className="screen center">
              <span className="spinner" role="status" aria-label="Loading" />
            </main>
          }
        >
          <FileViewer
            files={viewing.files}
            index={viewing.index}
            onClose={() => setViewing(null)}
            onInfo={(f) => setOpen(f)}
            onDownload={(f) => download([f.path])}
            isFavorite={(f) => favSet.has(f.path)}
            onFavorite={(f) => toggleFavorite(f.path)}
            onChanged={() => {
              qc.invalidateQueries({ queryKey: ["files.list"] });
              qc.invalidateQueries({ queryKey: ["files.recents"] });
            }}
          />
        </Suspense>
      )}

      {open && (
        <ItemSheet
          f={open}
          onView={viewing ? undefined : () => (setOpen(null), viewFile(open))}
          inTrash={inTrash || open.path.startsWith("/Trash/")}
          favorite={favSet.has(open.path)}
          shared={shareMap.get(open.path)}
          canShare={owner}
          onClose={() => setOpen(null)}
          onSelect={() => (setOpen(null), rowApi.current.long(open))}
          onOpenFolder={() => (setOpen(null), go(open.path))}
          onDownload={() => download([open.path])}
          onRename={() => setPrompt({ kind: "rename", entry: open })}
          onMove={() => setPicker({ mode: "move", paths: [open.path] })}
          onCopy={() => {
            setPicker({ mode: "copy", paths: [open.path] });
            rememberClip([open.path]);
          }}
          onFavorite={() => toggleFavorite(open.path)}
          onShare={() => toggleShare(open)}
          onShareInfo={(s) => (setOpen(null), setShareFor({ path: s.path, name: s.name }))}
          quickTransfer={deskMode && canQuickTransfer(open.path)}
          onQrShare={() => (setOpen(null), setTransfer({ kind: "download", path: open.path, name: open.name, size: open.size }))}
          onQrUpload={() => (setOpen(null), setTransfer({ kind: "upload", path: open.path, name: open.name }))}
          onTrash={() => trashItems([open.path])}
          onRestore={() => restore([open.path])}
          onDelete={() => deleteForever([open.path])}
        />
      )}

      {prompt && (
        <NamePrompt
          title={prompt.kind === "folder" ? "New folder" : "Rename"}
          initial={prompt.kind === "rename" ? prompt.entry!.name : "New folder"}
          submit={prompt.kind === "folder" ? "Create" : "Rename"}
          selectStem={prompt.kind === "rename" && !isDir(prompt.entry!)}
          requireChange={prompt.kind === "rename"}
          onClose={() => setPrompt(null)}
          onSubmit={async (name) => {
            if (prompt.kind === "folder")
              await act(
                "files.createDirectory",
                { path: `${path}/${name}` },
                "Folder created",
              );
            else {
              const from = prompt.entry!.path;
              const next = await act(
                "files.rename",
                { path: from, newName: name },
                "Renamed",
              );
              setViewing((v) => viewerAfterPathChange(v, from, typeof next === "string" ? next : null));
              setOpen(null);
            }
            setPrompt(null);
          }}
        />
      )}

      {picker && (
        <FolderPicker
          mode={picker.mode}
          count={picker.paths.length}
          start={path && !inTrash && (path.startsWith("::computer/") || !path.startsWith("::")) ? path : "/Home"}
          places={computerFiles.places.map((p) => ({path: p.path, name: p.name}))}
          exclude={picker.paths}
          onClose={() => setPicker(null)}
          onPick={async (dir) => {
            const cross = picker.paths.some((p) => p.startsWith("::computer/")) || dir.startsWith("::computer/");
            const verb = picker.mode === "move" ? "files.move" : "files.copy";
            let ok = 0;
            for (const p of picker.paths) {
              const fromParent = p.startsWith("::") ? filesParent(p) : parentOf(p);
              if (fromParent === dir && picker.mode === "move") continue;
              try {
                const next = cross
                  ? await act("files.transfer", {path: p, toDirectory: dir, mode: picker.mode})
                  : await act(verb, {
                      path: p,
                      toDirectory: dir,
                      collision: "keep-both",
                    });
                if (picker.mode === "move")
                  setViewing((v) => viewerAfterPathChange(v, p, typeof next === "string" ? next : null));
                ok++;
              } catch {
                // useFileAction already showed this call's error.
              }
            }
            if (ok)
              toast(
                `${ok === 1 ? "1 item" : `${ok} items`} ${picker.mode === "move" ? "moved" : "copied"} to ${pickerTitle(dir, computerFiles.places)}`,
              );
            setPicker(null);
            setSelected(new Set());
            setOpen(null);
          }}
        />
      )}

      {transfer && <QuickTransferSheet target={transfer} onClose={() => setTransfer(null)} />}
      {blankMenu && (
        <>
          <div className="qt-menu-scrim" onPointerDown={() => setBlankMenu(null)} onContextMenu={(e) => (e.preventDefault(), setBlankMenu(null))} />
          <div className="qt-menu glass" role="menu" style={{ left: Math.min(blankMenu.x, window.innerWidth - 240), top: Math.min(blankMenu.y, window.innerHeight - 60) }}>
            <button
              role="menuitem"
              onClick={() => {
                setBlankMenu(null);
                if (path) setTransfer({ kind: "upload", path, name: path.split("/").pop() || "Home" });
              }}
            >
              <Icon name="upload" size={18} />
              Upload here from a phone (QR code)
            </button>
          </div>
        </>
      )}
      {shareFor && (
        <ShareSheet
          path={shareFor.path}
          name={shareFor.name}
          host={boot.server?.host ?? ""}
          username={user.data?.sambaUsername}
          onClose={() => setShareFor(null)}
        />
      )}
    </div>
  );
}

// ---- long press -----------------------------------------------------------------------
function useLongPress(onLong: (f: FileEntry) => void, onMenu?: (f: FileEntry) => void) {
  const t = useRef<number>();
  const menu = useRef(onMenu);
  menu.current = onMenu;
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const cb = useRef(onLong);
  cb.current = onLong;
  return (f: FileEntry) => ({
    onPointerDown: (e: React.PointerEvent) => {
      fired.current = false;
      start.current = { x: e.clientX, y: e.clientY };
      window.clearTimeout(t.current);
      t.current = window.setTimeout(() => {
        fired.current = true;
        cb.current(f);
      }, 480);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (
        start.current &&
        Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) >
          10
      )
        window.clearTimeout(t.current);
    },
    onPointerUp: () => window.clearTimeout(t.current),
    onPointerCancel: () => window.clearTimeout(t.current),
    onClickCapture: (e: React.MouseEvent) => {
      if (fired.current) {
        e.stopPropagation();
        e.preventDefault();
        fired.current = false;
      }
    },
    // Right-click (or a long press the browser reports as one): this item's actions.
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      window.clearTimeout(t.current);
      if (menu.current && !fired.current) menu.current(f);
    },
  });
}

const FileRow = memo(function FileRow({
  f,
  grid,
  selected,
  selecting,
  favorite,
  shared,
  inTrash,
  showParent,
  activate,
  onMore,
  onDownload,
  onFavorite,
  onLong,
  onMenu,
  onEnter,
}: {
  onEnter?: (f: FileEntry) => void;
  f: FileEntry;
  grid: boolean;
  selected: boolean;
  selecting: boolean;
  favorite: boolean;
  shared: boolean;
  inTrash: boolean;
  showParent: boolean;
  activate: (f: FileEntry) => void;
  onMore: (f: FileEntry) => void;
  onDownload: (f: FileEntry) => void;
  onFavorite: (f: FileEntry) => void;
  onLong: (f: FileEntry) => void;
  onMenu: (f: FileEntry) => void;
}) {
  const press = useLongPress(onLong, onMenu);
  const sub = isDir(f)
    ? f.modified
      ? `Folder · ${ago(f.modified)}`
      : "Folder"
    : `${bytes(f.size)} · ${ago(f.modified)}`;
  const canFavorite = !selecting && !inTrash && !f.path.startsWith("/Trash/") && (f.operations.includes("favorite") || favorite);
  const favoriteBtn = canFavorite ? (
    <button
      type="button"
      className="icon-btn tile-fav"
      aria-pressed={favorite}
      aria-label={favorite ? `Unfavorite ${f.name}` : `Favorite ${f.name}`}
      title={favorite ? "Unfavorite" : "Favorite"}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onFavorite(f);
      }}
    >
      <Icon name={favorite ? "star-filled" : "star"} size={16} />
    </button>
  ) : null;
  if (grid)
    return (
      <div
        className={`file-tile${selected ? " sel" : ""}`}
        role="button"
        tabIndex={0}
        aria-pressed={selecting ? selected : undefined}
        onClick={() => activate(f)}
        onKeyDown={(e) => {
          if (!shouldActivateRowOnKey(e)) return;
          e.preventDefault();
          activate(f);
        }}
        {...press(f)}
      >
        <span className="tile-art">
          <FileIcon f={f} size={isDir(f) ? 64 : 92} />
          {selecting && <Icon name={selected ? "checked" : "unchecked"} size={22} className="tile-check" />}
          {favoriteBtn}
        </span>
        <span className="name">{f.name}</span>
        <span className="sub">{isDir(f) ? "Folder" : bytes(f.size)}</span>
      </div>
    );
  return (
    <div
      className={`row file-row${selected ? " sel" : ""}`}
      role="button"
      tabIndex={0}
      aria-pressed={selecting ? selected : undefined}
      onClick={() => activate(f)}
      onKeyDown={(e) => {
          if (!shouldActivateRowOnKey(e)) return;
          e.preventDefault();
          activate(f);
        }}
      {...press(f)}
    >
      {selecting && <Icon name={selected ? "checked" : "unchecked"} size={24} className={`check${selected ? " on" : ""}`} />}
      <FileIcon f={f} />
      {onEnter && <Icon name="chevron" size={16} className="file-tree-chev" />}
      <span className="main">
        <b>
          {f.name}
          {favorite && <Icon name="star-filled" size={13} className="fav" />}
          {shared && <Icon name="folder-share" size={14} className="shared" />}
        </b>
        <span>{showParent ? parentOf(f.path) : sub}</span>
      </span>
      {!selecting && !inTrash && !f.path.startsWith("/Trash/") && offersDownload([{ directory: isDir(f) }]) && offersFile(f) && (
        <button
          className="icon-btn row-dl"
          style={{ alignSelf: "center" }}
          aria-label={`Download ${f.name}`}
          title="Download"
          onClick={(e) => {
            e.stopPropagation();
            onDownload(f);
          }}
        >
          <Icon name="download" size={18} />
        </button>
      )}
      {!selecting && !inTrash && !f.path.startsWith("/Trash/") && (f.operations.includes("favorite") || favorite) && (
        <button
          className="icon-btn"
          style={{ alignSelf: "center", background: "transparent" }}
          aria-pressed={favorite}
          aria-label={favorite ? `Unfavorite ${f.name}` : `Favorite ${f.name}`}
          title={favorite ? "Unfavorite" : "Favorite"}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onFavorite(f);
          }}
        >
          <Icon name={favorite ? "star-filled" : "star"} size={18} />
        </button>
      )}
      {!selecting && (
        <button
          className="icon-btn"
          style={{ alignSelf: "center", background: "transparent" }}
          aria-label={`More for ${f.name}`}
          onClick={(e) => {
            e.stopPropagation();
            onMore(f);
          }}
        >
          <Icon name="dots" size={18} />
        </button>
      )}
      {onEnter && (
        <button
          className="icon-btn"
          style={{ alignSelf: "center", background: "transparent" }}
          aria-label={`Go into ${f.name}`}
          title="Go into folder"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onEnter(f);
          }}
        >
          <Icon name="back" size={18} style={{ transform: "rotate(180deg)" }} />
        </button>
      )}
    </div>
  );
});

// ---- item sheet with preview ---------------------------------------------------------------
function ItemSheet(p: {
  f: FileEntry;
  inTrash: boolean;
  favorite: boolean;
  shared?: SmbShare;
  canShare?: boolean;
  onClose: () => void;
  onSelect: () => void;
  onOpenFolder: () => void;
  onView?: () => void;
  onDownload: () => void;
  onRename: () => void;
  onMove: () => void;
  onCopy: () => void;
  onFavorite: () => void;
  onShare: () => void;
  onShareInfo: (s: SmbShare) => void;
  onTrash: () => void;
  onRestore: () => void;
  onDelete: () => void;
  quickTransfer?: boolean;
  onQrShare?: () => void;
  onQrUpload?: () => void;
}) {
  const desk = useDesktop();
  const { f } = p;
  const toast = useToast();
  const k = kindOf(f);
  const can = (op: FileEntry["operations"][number]) =>
    f.operations.includes(op);
  const shareOut = async () => {
    haptic(6);
    try {
      if (!isDir(f) && navigator.canShare && (f.size ?? 0) < 200e6) {
        const blob = await fetch(downloadUrl([f.path]), {
          credentials: "same-origin",
        }).then((r) => {
          if (!r.ok) throw new Error("Couldn’t load the file");
          return r.blob();
        });
        const file = new File([blob], f.name, {
          type: f.type === "directory" ? "application/zip" : f.type,
        });
        if (navigator.canShare({ files: [file] }))
          return void (await navigator.share({ files: [file], title: f.name }));
      }
      p.onDownload();
    } catch (e) {
      if ((e as Error).name !== "AbortError") toast((e as Error).message, true);
    }
  };
  type A = {
    id: string;
    label: string;
    icon: IconName;
    onClick: () => void;
    show: boolean;
    danger?: boolean;
  };
  const actions: A[] = p.inTrash
    ? [
        {
          id: "restore",
          label: "Restore",
          icon: "restore",
          onClick: p.onRestore,
          show: true,
        },
        {
          id: "delete",
          label: "Delete",
          icon: "trash",
          onClick: p.onDelete,
          show: true,
          danger: true,
        },
      ]
    : [
        {
          id: "download-zip",
          label: "Download zip",
          icon: "download",
          onClick: p.onDownload,
          show: isDir(f),
        },
        {
          id: "share-out",
          label: "Share",
          icon: "share",
          onClick: shareOut,
          show: !isDir(f),
        },
        {
          id: "download",
          label: "Download",
          icon: "download",
          onClick: p.onDownload,
          show: offersFile(f),
        },
        {
          id: "qr-share",
          label: "Share via QR code",
          icon: "share",
          onClick: () => p.onQrShare?.(),
          show: !!p.quickTransfer && !isDir(f) && offersFile(f),
        },
        {
          id: "qr-upload",
          label: "Upload from phone",
          icon: "upload",
          onClick: () => p.onQrUpload?.(),
          show: !!p.quickTransfer && isDir(f) && can("writable"),
        },
        {
          id: "select",
          label: "Select",
          icon: "checked",
          onClick: p.onSelect,
          show: f.operations.length > 0,
        },
        {
          id: "rename",
          label: "Rename",
          icon: "pencil",
          onClick: p.onRename,
          show: can("rename"),
        },
        {
          id: "move",
          label: "Move",
          icon: "move",
          onClick: p.onMove,
          show: can("move"),
        },
        {
          id: "copy",
          label: "Copy",
          icon: "copy",
          onClick: p.onCopy,
          show: can("copy"),
        },
        {
          id: "fav",
          label: p.favorite ? "Unfavorite" : "Favorite",
          icon: p.favorite ? "star-filled" : "star",
          onClick: p.onFavorite,
          show: can("favorite") || p.favorite,
        },
        {
          id: "smb",
          label: p.shared ? "Unshare" : "Network share",
          icon: "folder-share",
          onClick: p.onShare,
          show: !!p.canShare && isDir(f) && (can("share") || !!p.shared),
        },
        {
          id: "desk",
          label: "Add to desktop",
          icon: "plus",
          onClick: () => {
            desk?.addIcon(`folder:${f.path}`);
            toast(`${f.name} added to the desktop`);
          },
          show: !!desk && isDir(f),
        },
      ];
  const shown = actionsForItems(
    actions.filter((a) => a.show),
    [{ directory: isDir(f) }],
  );
  return (
    <Sheet open onClose={p.onClose} label={f.name}>
      <SheetHeader
        icon={<FileIcon f={f} size={52} />}
        title={f.name}
        subtitle={isDir(f) ? "Folder" : `${bytes(f.size)} · ${ago(f.modified)}`}
        onClose={p.onClose}
      />
      {!p.inTrash && offersFile(f) && <Preview f={f} kind={k} />}
      {!isDir(f) && !p.inTrash && p.onView && (
        <div className="primary-row">
          <button className="btn primary" onClick={p.onView}>
            <Icon name="eye" size={20} />
            Open
          </button>
        </div>
      )}
      {isDir(f) && !p.inTrash && (
        <div className="primary-row">
          <button className="btn primary" onClick={p.onOpenFolder}>
            <Icon name="folder" size={20} />
            Open folder
          </button>
        </div>
      )}
      {p.canShare && p.shared && (
        <button
          className="glass card press share-chip"
          onClick={() => p.onShareInfo(p.shared!)}
        >
          <Icon name="folder-share" size={20} />
          <span>
            Shared as <b>{p.shared.sharename}</b> on your home LAN
          </span>
          <Icon name="chevron" size={16} className="muted" />
        </button>
      )}
      <div
        className="actions"
        style={{
          gridTemplateColumns: `repeat(${Math.min(4, shown.length)}, minmax(0, 1fr))`,
        }}
      >
        {shown.map((a) => (
          <button
            key={a.id}
            className={`action${a.danger ? " danger-action" : ""}`}
            onClick={a.onClick}
          >
            <Icon name={a.icon} size={22} />
            {a.label}
          </button>
        ))}
      </div>
      <div className="kv glass group" style={{ borderRadius: 18 }}>
        <div className="row static">
          <span className="k">Where</span>
          <span className="v">{parentOf(f.path)}</span>
        </div>
        {!isDir(f) && (
          <div className="row static">
            <span className="k">Kind</span>
            <span className="v">{fileKindLabel(f)}</span>
          </div>
        )}
        {f.modified ? (
          <div className="row static">
            <span className="k">Modified</span>
            <span className="v">
              {new Date(f.modified).toLocaleString(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </span>
          </div>
        ) : null}
      </div>
      {!p.inTrash && can("trash") && (
        <button className="btn danger block" onClick={p.onTrash}>
          <Icon name="trash" size={19} />
          Move to Trash
        </button>
      )}
    </Sheet>
  );
}

function Preview({ f, kind }: { f: FileEntry; kind: Kind }) {
  const [text, setText] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  useEffect(() => {
    if (kind !== "text" || (f.size ?? 0) > 512_000) return;
    fetch(viewUrl(f.path), { credentials: "same-origin" })
      .then((r) => (r.ok ? r.text() : Promise.reject()))
      .then(setText, () => setText(null));
  }, [f.path, f.size, kind]);
  let body: ReactNode = null;
  if (kind === "image")
    body = (
      <button
        className="preview-img"
        onClick={() => setFull(true)}
        aria-label="View full screen"
      >
        <img src={viewUrl(f.path)} alt={f.name} />
      </button>
    );
  else if (kind === "video")
    body = (
      <video
        className="preview-media"
        src={viewUrl(f.path)}
        controls
        playsInline
        preload="metadata"
      />
    );
  else if (kind === "audio")
    body = (
      <audio
        className="preview-audio"
        src={viewUrl(f.path)}
        controls
        preload="metadata"
      />
    );
  else if (kind === "pdf")
    body = (
      <iframe
        className="preview-pdf"
        title={f.name}
        src={viewUrl(f.path)}
        sandbox=""
      />
    );
  else if (kind === "text" && text !== null)
    body = <pre className="preview-text">{text.slice(0, 20_000)}</pre>;
  if (!body) return null;
  return (
    <>
      <div className="preview">{body}</div>
      {full && (
        <Sheet open onClose={() => setFull(false)} label={f.name} tall>
          <SheetHeader title={f.name} onClose={() => setFull(false)} />
          <div className="zoom-view">
            <img src={viewUrl(f.path)} alt={f.name} />
          </div>
        </Sheet>
      )}
    </>
  );
}

// ---- name prompt -----------------------------------------------------------------------------
function NamePrompt({
  title,
  initial,
  submit,
  selectStem,
  requireChange,
  onClose,
  onSubmit,
}: {
  title: string;
  initial: string;
  submit: string;
  selectStem?: boolean;
  requireChange?: boolean;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const dot = initial.lastIndexOf(".");
    el.setSelectionRange(0, selectStem && dot > 0 ? dot : initial.length);
  }, [initial, selectStem]);
  const canSubmit = canSubmitNamePrompt({ name, initial, requireChange, busy });
  return (
    <Sheet open onClose={onClose} label={title}>
      <SheetHeader title={title} onClose={onClose} />
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!canSubmit) return;
          setBusy(true);
          await onSubmit(name.trim()).catch(() => {});
          setBusy(false);
        }}
      >
        <div className="field">
          <label htmlFor="fname" className="sr-only">
            Name
          </label>
          <input
            id="fname"
            ref={ref}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>
        <button
          className="btn primary block"
          disabled={!canSubmit}
        >
          {busy && <span className="spinner" />}
          {submit}
        </button>
      </form>
    </Sheet>
  );
}

// ---- folder picker (move / copy) ---------------------------------------------------------------------
function FolderPicker({
  mode,
  count,
  start,
  places,
  exclude,
  onClose,
  onPick,
}: {
  mode: "move" | "copy";
  count: number;
  start: string;
  places: {path: string; name: string}[];
  exclude: string[];
  onClose: () => void;
  onPick: (dir: string) => Promise<void>;
}) {
  const [dir, setDir] = useState(start);
  const [busy, setBusy] = useState(false);
  const here = parseComputerPlace(dir);
  const listing = useListing(here ? null : dir, "name");
  const computerList = useQuery({
    queryKey: ["swarm.files.list", here?.id ?? "", here?.rel ?? ""],
    queryFn: () => query<{entries: {name: string; dir: boolean}[]}>("swarm.files.list", {id: here?.id, path: here?.rel ?? ""}),
    enabled: !!here,
  });
  const serverFolders = (listing.data?.files ?? [])
    .filter((f) => isDir(f) && !exclude.includes(f.path))
    .map((f) => ({path: f.path, name: f.name}));
  const computerFolders = (computerList.data?.entries ?? []).flatMap((entry) => {
    if (!entry.dir || !here) return [];
    const next = computerPlacePath(here.id, here.rel ? `${here.rel}/${entry.name}` : entry.name);
    if (!next || exclude.includes(next)) return [];
    return [{path: next, name: entry.name}];
  });
  const folders = here ? computerFolders : serverFolders;
  const loading = here ? computerList.isLoading : listing.isLoading;
  const failed = here ? computerList.error : listing.error;
  const blocked = exclude.some((p) => dir === p || dir.startsWith(`${p}/`));
  const upTo = here ? filesParent(dir) : dir.split("/").filter(Boolean).length > 1 ? parentOf(dir) : null;
  const roots = [
    ...folderPickerRoots().map((path) => ({path, name: titleOf(path)})),
    ...places.filter((place) => isServedFilePlace(place.path)),
  ];
  return (
    <Sheet
      open
      onClose={onClose}
      label={mode === "move" ? "Move to" : "Copy to"}
      tall
    >
      <SheetHeader
        title={`${mode === "move" ? "Move" : "Copy"} ${count === 1 ? "1 item" : `${count} items`}`}
        subtitle={`to ${pickerTitle(dir, places)}`}
        onClose={onClose}
      />
      <div className="chips" style={{ marginBottom: 10 }}>
        {roots.map((r) => (
          <button
            key={r.path}
            className={`chip${dir === r.path || dir.startsWith(`${r.path}/`) ? " on" : ""}`}
            aria-pressed={dir === r.path || dir.startsWith(`${r.path}/`)}
            onClick={() => setDir(r.path)}
          >
            {r.name}
          </button>
        ))}
      </div>
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          margin: "0 -20px",
          padding: "0 20px",
        }}
      >
        <div
          className="glass group"
          style={{ borderRadius: 18, "--inset": "62px" } as CSSProperties}
        >
          {upTo && (
            <button
              className="row"
              style={{ minHeight: 54 }}
              onClick={() => setDir(upTo)}
            >
              <span
                className="row-ico"
                style={{ "--c": "#71717a" } as CSSProperties}
              >
                <Icon name="back" size={18} />
              </span>
              <span className="main">
                <b style={{ fontWeight: 550 }}>{pickerTitle(upTo, places)}</b>
              </span>
            </button>
          )}
          {loading && (
            <div className="row static">
              <span className="spinner" />
            </div>
          )}
          {folders.map((f) => (
            <button
              key={f.path}
              className="row"
              style={{ minHeight: 54 }}
              onClick={() => setDir(f.path)}
            >
              <span
                className="row-ico"
                style={{ "--c": "#3b82f6" } as CSSProperties}
              >
                <Icon name="folder-filled" size={18} />
              </span>
              <span className="main">
                <b style={{ fontWeight: 550 }}>{f.name}</b>
              </span>
              <Icon name="chevron" size={18} className="chev" />
            </button>
          ))}
          {!loading && folders.length === 0 && (
            <div className="row static muted">No folders here</div>
          )}
        </div>
      </div>
      <button
        className="btn primary block"
        style={{ marginTop: 14 }}
        disabled={busy || blocked || !!failed}
        onClick={async () => {
          setBusy(true);
          await onPick(dir);
          setBusy(false);
        }}
      >
        {busy && <span className="spinner" />}
        {mode === "move" ? "Move here" : "Copy here"}
      </button>
    </Sheet>
  );
}

// ---- uploads panel ------------------------------------------------------------------------------
function UploadPanel({
  uploads,
  onClear,
}: {
  uploads: Upload[];
  onClear: () => void;
}) {
  const active = uploads.filter((u) => u.state === "uploading");
  const total = uploads.reduce((t, u) => t + u.total, 0);
  const loaded = uploads.reduce((t, u) => t + u.loaded, 0);
  const failed = uploads.filter((u) => u.state === "error").length;
  return (
    <div className="upload-panel glass" role="status" aria-live="polite">
      <span
        className="file-icon"
        style={
          {
            width: 40,
            height: 40,
            "--c": active.length
              ? "var(--accent)"
              : failed
                ? "var(--red)"
                : "var(--green)",
          } as CSSProperties
        }
      >
        {active.length ? (
          <span className="spinner" />
        ) : (
          <Icon name={failed ? "alert" : "check"} size={20} />
        )}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <b style={{ display: "block", fontSize: 14, fontWeight: 620 }}>
          {active.length
            ? `Uploading ${active.length} of ${uploads.length}`
            : failed
              ? `${failed} upload${failed > 1 ? "s" : ""} failed`
              : "Upload complete"}
        </b>
        <span className="progress" style={{ display: "block", marginTop: 7 }}>
          <i style={{ width: `${total ? (loaded / total) * 100 : 100}%` }} />
        </span>
        <span
          className="muted num"
          style={{ fontSize: 12, marginTop: 4, display: "block" }}
        >
          {bytes(loaded)} of {bytes(total)}
        </span>
      </span>
      {!active.length && (
        <button className="icon-btn" aria-label="Dismiss" onClick={onClear}>
          <Icon name="close" size={16} />
        </button>
      )}
    </div>
  );
}

// ---- SMB share info ----------------------------------------------------------------------------------
// Share a folder on your home LAN (Samba), or see and change how it's shared. Other computers open
// it at smb://<server>/<name>; with a password, they sign in with your server account's user name
// and your share password.
/** Module-level radio choice so re-renders keep focus on the active access option. */
function ShareAccessChoice({
  name,
  on,
  title,
  note,
  onPick,
  disabled,
}: {
  name: string;
  on: boolean;
  title: string;
  note: string;
  onPick: () => void;
  disabled?: boolean;
}) {
  return (
    <label style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "8px 2px", fontSize: 14.5, opacity: disabled ? 0.55 : 1 }}>
      <input type="radio" name={name} checked={on} disabled={disabled} onChange={onPick} />
      <span>
        {title}
        <small className="muted" style={{ display: "block" }}>{note}</small>
      </span>
    </label>
  );
}

export function ShareSheet({
  path,
  name,
  host,
  username,
  onClose,
}: {
  path: string;
  name: string;
  host: string;
  username?: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const accessRadioName = useId();
  const shares = useQuery({ queryKey: ["files.shares"], queryFn: () => query<SmbShare[]>("files.shares") });
  const options = useQuery({
    queryKey: ["files.shareOptions"],
    queryFn: () =>
      query<{ noPassword: boolean; samba?: { ok: boolean; problem?: "missing" | "mismatch"; command?: string; versions?: Record<string, string | null> } }>("files.shareOptions"),
    retry: false,
    // Waiting for the one-time Samba fix: notice as soon as it's done.
    refetchInterval: (q) => (q.state.data?.samba && !q.state.data.samba.ok ? 3000 : false),
  });
  const samba = options.data?.samba;
  const share = shares.data?.find((s) => s.path === path) ?? null;
  const [needPassword, setNeedPassword] = useState(true);
  const [readOnly, setReadOnly] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [changing, setChanging] = useState(false);
  const [newPw, setNewPw] = useState("");
  const pw = useQuery({
    queryKey: ["files.sharePassword"],
    queryFn: () => query<string>("files.sharePassword"),
    enabled: reveal,
    retry: false,
  });
  const run = useMutation({
    mutationFn: (a: { path: string; input: unknown; done: string }) => mutate(a.path, a.input).then(() => a.done),
    onSuccess: (done) => {
      toast(done);
      qc.invalidateQueries({ queryKey: ["files.shares"] });
      qc.invalidateQueries({ queryKey: ["files.sharePassword"] });
    },
    onError: (e) => toast((e as Error).message, true),
  });
  const copy = (v: string, what: string) =>
    copyTextOrToast(
      navigator.clipboard?.writeText ? (text) => navigator.clipboard.writeText(text) : undefined,
      v,
      () => toast(`${what} copied`),
      () => toast(v),
    );
  const noPasswordOk = options.data?.noPassword === true;
  const passwordChoices = (current: boolean, pick: (v: boolean) => void) => (
    <div className="glass card" style={{ borderRadius: 18, marginBottom: 12 }}>
      <b style={{ fontSize: 14 }}>Who can open it</b>
      <ShareAccessChoice name={accessRadioName} on={current} title="Password needed" note={`Sign in as ${username ?? "your server user"} with your share password.`} onPick={() => pick(true)} />
      <ShareAccessChoice
        name={accessRadioName}
        on={!current}
        title="No password"
        note={noPasswordOk ? "Anyone on your home LAN can open it. Writes are not saved as you. Only for folders you don’t mind anyone at home seeing." : "Needs the installer to run once more on this server."}
        onPick={() => pick(false)}
        disabled={!noPasswordOk}
      />
    </div>
  );
  const readOnlyToggle = (current: boolean, set: (v: boolean) => void) => (
    <label className="glass card" style={{ display: "flex", gap: 10, alignItems: "center", borderRadius: 18, marginBottom: 12, fontSize: 14.5 }}>
      <input type="checkbox" checked={current} onChange={(e) => set(e.target.checked)} />
      <span>
        Read only
        <small className="muted" style={{ display: "block" }}>Other computers can open and copy files, but not change or delete them.</small>
      </span>
    </label>
  );
  const rows: [string, string, string][] = share
    ? [
        ["Mac / Linux / iPhone", `smb://${host}/${share.sharename}`, "Address"],
        ["Windows", `\\\\${host}\\${share.sharename}`, "Address"],
      ]
    : [];
  return (
    <Sheet open onClose={onClose} label="Network share">
      <SheetHeader
        icon={
          <span className="file-icon" style={{ width: 52, height: 52, "--c": "#0ea5e9" } as CSSProperties}>
            <Icon name="folder-share" size={28} />
          </span>
        }
        title={share?.name ?? name}
        subtitle={
          share
            ? share.available === false
              ? "This folder is no longer there"
              : "Shared on your home LAN"
            : "Share this folder with computers on your home LAN"
        }
        onClose={onClose}
      />
      {samba && !samba.ok && (
        <div className="glass card" style={{ borderRadius: 18, marginBottom: 12 }}>
          <b style={{ fontSize: 14.5, display: "block", marginBottom: 4 }}>
            {samba.problem === "missing" ? "Samba needs installing first" : "Samba needs a system update first"}
          </b>
          <p className="prose" style={{ margin: "0 0 10px", fontSize: 14 }}>
            {samba.problem === "missing"
              ? "Network shares use Samba, which isn’t installed on this server yet."
              : `Samba (${samba.versions?.samba}) and its libraries (${samba.versions?.smbclient}) are different versions, after a partial update. Updating the system once brings them back in step.`}{" "}
            Run this in a terminal on the server; it asks for your password itself.
          </p>
          <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", userSelect: "all", fontSize: 12.5, padding: 10, borderRadius: 10, background: "rgba(0,0,0,.25)", margin: "0 0 10px" }}>{samba.command}</pre>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" onClick={() => (onClose(), openTerminalWith(samba.command!))}>
              <Icon name="terminal" size={17} /> Open Terminal
            </button>
            <button className="btn ghost" onClick={() => copy(samba.command!, "Command")}>
              Copy
            </button>
          </div>
          <p className="muted" style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, margin: "10px 0 0" }}>
            <span className="spinner" /> This updates by itself once it’s done.
          </p>
        </div>
      )}
      {shares.isLoading ? (
        <p className="muted">Loading…</p>
      ) : !share ? (
        <>
          {passwordChoices(needPassword, setNeedPassword)}
          {readOnlyToggle(readOnly, setReadOnly)}
          <button
            className="btn primary"
            style={{ width: "100%" }}
            disabled={run.isPending || (!!samba && !samba.ok)}
            onClick={() => run.mutate({ path: "files.addShare", input: { path, password: needPassword, readOnly }, done: "Shared on your network" })}
          >
            {run.isPending ? <span className="spinner" /> : <Icon name="folder-share" size={18} />} Share on network
          </button>
        </>
      ) : (
        <>
          <div className="kv glass group" style={{ borderRadius: 18, marginTop: 0 }}>
            {rows.map(([k, v, what]) => (
              <button key={k} className="row" style={{ minHeight: 56 }} onClick={() => copy(v, what)}>
                <span className="k">{k}</span>
                <span className="v mono" style={{ fontSize: 12.5 }}>{v}</span>
              </button>
            ))}
            {share.password && username && (
              <button className="row" style={{ minHeight: 56 }} onClick={() => copy(username, "Username")}>
                <span className="k">Username</span>
                <span className="v mono">{username}</span>
              </button>
            )}
            {share.password && (
              <button
                className="row"
                style={{ minHeight: 56 }}
                onClick={() => {
                  const action = sharePasswordAction({ data: pw.data, reveal, isFetching: pw.isFetching });
                  if (action === "copy") copy(pw.data!, "Password");
                  else if (action === "refetch") void pw.refetch();
                  else if (action === "reveal") setReveal(true);
                }}
              >
                <span className="k">Password</span>
                <span
                  className={!pw.data && pw.error && !pw.isFetching ? "v" : "v mono"}
                  style={{ fontSize: 12.5, ...(!pw.data && pw.error && !pw.isFetching ? { color: "var(--red)" } : {}) }}
                >
                  {sharePasswordLabel({ data: pw.data, isFetching: pw.isFetching, error: pw.error })}
                </span>
              </button>
            )}
          </div>
          <p className="footer-note" style={{ textAlign: "left", margin: "0 4px 14px" }}>
            Tap any line to copy it. On iPhone, open Files → ⋯ → Connect to Server.
          </p>
          {passwordChoices(share.password, (v) => v !== share.password && run.mutate({ path: "files.updateShare", input: { path, password: v }, done: v ? "Now needs a password" : "Open to your network without a password" }))}
          {readOnlyToggle(share.readOnly, (v) => run.mutate({ path: "files.updateShare", input: { path, readOnly: v }, done: v ? "Now read only" : "Can be changed from other computers" }))}
          {share.password && (
            <div className="glass card" style={{ borderRadius: 18, marginBottom: 12 }}>
              {!changing ? (
                <button className="btn ghost" onClick={() => setChanging(true)}>
                  <Icon name="key" size={17} /> Choose your own share password
                </button>
              ) : (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    run.mutate({ path: "files.setSharePassword", input: { password: newPw }, done: "Share password changed" }, { onSuccess: () => (setChanging(false), setNewPw(""), setReveal(true)) });
                  }}
                >
                  <div className="field">
                    <input type="password" autoComplete="new-password" placeholder="At least 8 characters" value={newPw} onChange={(e) => setNewPw(e.target.value)} aria-label="New share password" />
                  </div>
                  <small className="muted" style={{ display: "block", margin: "6px 2px 10px" }}>It’s for every folder you share with a password. Computers that saved the old one will ask again.</small>
                  <button className="btn primary" disabled={newPw.length < 8 || run.isPending}>Save password</button>
                </form>
              )}
            </div>
          )}
          <button
            className="btn danger"
            style={{ width: "100%" }}
            disabled={run.isPending}
            onClick={async () => {
              if (await confirm({ title: `Stop sharing “${share.name}”?`, body: "Computers on your network will no longer see this folder. Its files stay where they are.", confirm: "Stop sharing" }))
                run.mutate({ path: "files.removeShare", input: { path }, done: "No longer shared" }, { onSuccess: onClose });
            }}
          >
            Stop sharing
          </button>
        </>
      )}
    </Sheet>
  );
}

