// Quick transfer: a QR code a phone scans to download one file, or to upload into one folder,
// without signing in. The link lasts 10 minutes and works only while you stay signed in here.
import { useEffect, useState } from "react";

import { useBootstrap } from "../data";
import { Icon } from "../icons";
import { Sheet, SheetHeader, useToast } from "../ui";

export type TransferTarget = { kind: "download" | "upload"; path: string; name: string; size?: number };

const THEME_VARS = ["--bg", "--bg-solid", "--fg", "--fg-2", "--muted", "--glass", "--glass-2", "--line", "--sheet", "--accent", "--accent-text", "--on-accent"];

/** Paths quick transfer can use: this server's own files. */
export const canQuickTransfer = (path: string) => /^\/(Home|External)(\/|$)/.test(path);

// The look of the app right now, for the portal: its colours and the picture behind it.
function themeSnapshot(): { theme: Record<string, string>; background: string | null } {
  const css = getComputedStyle(document.documentElement);
  const theme: Record<string, string> = {};
  for (const k of THEME_VARS) {
    const v = css.getPropertyValue(k).trim();
    if (v) theme[k] = v;
  }
  const urlOf = (el: Element | null) => {
    const m = el ? /url\(["']?([^"')]+)["']?\)/.exec((el as HTMLElement).style.backgroundImage || "") : null;
    return m ? m[1] : null;
  };
  const background =
    urlOf(document.querySelector(".desk-wall .wall-layer.in")) ??
    urlOf(document.querySelector(".desk-wall .wall-layer")) ??
    urlOf(document.querySelector(".backdrop .wall"));
  return { theme, background: background && !background.startsWith("blob:") ? background : null };
}

// The address a phone on your network can open. "localhost" only works on this computer.
function linkBase(serverHost?: string) {
  const loopback = /^(localhost|127\.|\[::1\]|::1)/i.test(location.hostname);
  if (!loopback || !serverHost) return location.origin;
  return `${location.protocol}//${serverHost}${location.port ? `:${location.port}` : ""}`;
}

async function qrSvg(text: string): Promise<string> {
  const { default: qrcode } = await import("qrcode-generator");
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  const size = n + quiet * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

export function QuickTransferSheet({ target, onClose }: { target: TransferTarget; onClose: () => void }) {
  const toast = useToast();
  const boot = useBootstrap();
  const [link, setLink] = useState<{ url: string; token: string; expiresAt: number } | null>(null);
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let gone = false;
    const { theme, background } = themeSnapshot();
    fetch("/api/transfer", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-omarchy-server": "1" },
      body: JSON.stringify({ kind: target.kind, path: target.path, name: target.name, size: target.size, theme, background }),
    })
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        if (!r.ok) throw new Error(body?.error?.message ?? "Couldn’t make a link");
        return body as { path: string; token: string; expiresAt: number };
      })
      .then(async (b) => {
        const url = `${linkBase(boot.server?.host)}${b.path}`;
        const s = await qrSvg(url);
        if (gone) return;
        setLink({ url, token: b.token, expiresAt: Date.now() + (b.expiresAt - Date.now()) });
        setSvg(s);
      })
      .catch((e: Error) => !gone && setError(e.message));
    return () => {
      gone = true;
    };
    // One link per opening of this sheet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const left = link ? Math.max(0, link.expiresAt - now) : 0;
  const ended = !!link && left === 0;
  const stop = async () => {
    if (link)
      await fetch(`/api/transfer/${encodeURIComponent(link.token)}`, { method: "DELETE", credentials: "same-origin", headers: { "x-omarchy-server": "1" } }).catch(() => {});
    onClose();
  };
  const copy = () =>
    link &&
    navigator.clipboard?.writeText(link.url).then(
      () => toast("Link copied"),
      () => toast("Copy the link from the box", true),
    );

  const upload = target.kind === "upload";
  return (
    <Sheet open onClose={onClose} label={upload ? "Upload from a phone" : "Share with a QR code"}>
      <SheetHeader
        icon={<Icon name={upload ? "upload" : "share"} size={28} />}
        title={upload ? `Upload to ${target.name}` : target.name}
        subtitle={upload ? "Scan with a phone to send files into this folder" : "Scan with a phone to download this file"}
        onClose={onClose}
      />
      <div className="qt-body">
        {error ? (
          <p className="qt-note">{error}</p>
        ) : !link ? (
          <p className="qt-note">Making a link…</p>
        ) : ended ? (
          <p className="qt-note">This link has ended. Close and open it again for a new code.</p>
        ) : (
          <>
            <div className="qt-code" role="img" aria-label="QR code" dangerouslySetInnerHTML={{ __html: svg }} />
            <p className="qt-timer">
              Ends in {Math.floor(left / 60000)}:{String(Math.floor(left / 1000) % 60).padStart(2, "0")}
            </p>
            <button className="qt-link" onClick={copy} title="Copy the link">
              {link.url}
            </button>
            <p className="qt-note">
              No sign-in needed: anyone with this code can {upload ? "add files to this folder" : "download this file"} for 10 minutes. The phone must be able to reach this server, usually on the same Wi-Fi.
            </p>
          </>
        )}
        <div className="primary-row">
          <button className="btn" onClick={stop}>
            {link && !ended ? "Stop sharing" : "Close"}
          </button>
        </div>
      </div>
    </Sheet>
  );
}
