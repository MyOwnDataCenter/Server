#!/usr/bin/env bash
# My Own Data Center installer: run as your normal user on Omarchy (or any Arch Linux).
#   curl -fsSL https://raw.githubusercontent.com/MyOwnDataCenter/server/main/install.sh | bash
# Installs to ~/.local/share/omarchy-server and runs as two systemd user services:
#   omarchyd            the backend, on 127.0.0.1:2021 only
#   omarchy-server-web  the web app, on port 7780 (OMARCHY_SERVER_PORT to change)
# Re-run it any time to update. Your account, sessions and files are kept.
#
# Add ZFS (optional) with:  curl -fsSL …/install.sh | bash -s -- --zfs
set -euo pipefail

# Run as `curl … | bash`, bash reads this script from the pipe a piece at a time while it runs, and
# anything that reads input (pacman, `omarchy update`, sudo's helpers) can swallow the rest of the
# script. Bash then carries on from wherever the pipe had got to: steps are skipped and it fails
# somewhere odd (e.g. "touch: cannot touch …/.widget-offered"). So everything is inside main(),
# which bash reads in full before running any of it, and the steps read the terminal, not the pipe.
main() {
if (: </dev/tty) 2>/dev/null; then exec </dev/tty; else exec </dev/null; fi

usage() {
	cat <<'EOF'
My Own Data Center installer

  install.sh [--zfs] [-h|--help]

Options:
  --zfs       Build and install OpenZFS from the AUR (zfs-utils, zfs-dkms)
  -h, --help  Show this help

Environment:
  OMARCHY_SERVER_PORT       Web app port (default 7780)
  OMARCHY_SERVER_REPO       Git repository URL or local clone path
  OMARCHY_SERVER_BRANCH     Branch to install (default main)
  OMARCHY_SERVER_SOURCE     Local omarchy-server git clone (absolute path)
  OMARCHY_SERVER_APP_STORE  Local app-store git clone (absolute path)
  OMARCHY_SERVER_FROM_APP   Set to 1 when started from the in-app updater
EOF
}

ZFS=0
for arg in "$@"; do
	case "$arg" in
		--zfs) ZFS=1 ;;
		-h | --help) usage; exit 0 ;;
		*) printf 'Unknown option: %s\n\n' "$arg" >&2; usage >&2; exit 2 ;;
	esac
done

# Raise this when a change needs the installer run again (packages, the storage helper, services,
# firewall rules). While My Own Data Center is in beta, the app asks the owner to run it at their next sign-in.
INSTALLER_REVISION=6
# Started from the app's "run the installer" prompt, in its own terminal: that terminal runs inside
# omarchyd, so restarting omarchyd here would stop this script partway. Restart once it's done instead.
FROM_APP="${OMARCHY_SERVER_FROM_APP:-0}"

REPO="${OMARCHY_SERVER_REPO:-https://github.com/MyOwnDataCenter/server.git}"
BRANCH="${OMARCHY_SERVER_BRANCH:-main}"
PORT="${OMARCHY_SERVER_PORT:-7780}"
BASE="${XDG_DATA_HOME:-$HOME/.local/share}/omarchy-server"
APP="$BASE/app"
UNITS="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

# Isolation: OMARCHY_SERVER_SOURCE / OMARCHY_SERVER_APP_STORE, if set, must be absolute git
# directories. A bad path is an error (the installer does not fall back to GitHub).
trim_env() { printf '%s' "$1" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'; }
require_local_git() {
	local name="$1" path="$2" hint
	case "$name" in
		OMARCHY_SERVER_APP_STORE) hint='use the GitHub app store' ;;
		*) hint='update from GitHub' ;;
	esac
	case "$path" in
		/*) ;;
		*) die "$name is set to \"$path\" but must be an absolute path. Unset it to $hint, or point it at a local clone." ;;
	esac
	# A checkout has .git (file or directory). A bare repo has a HEAD file and no .git.
	if [ ! -e "$path/.git" ] && [ ! -f "$path/HEAD" ]; then
		die "$name is set to \"$path\" but that path is not a git repository. Unset it to $hint, or point it at a local clone."
	fi
}
# Local clones are absolute paths. file://, git:// and scp-style user@host:path go to git unchanged.
# A relative path is still refused.
require_repo() {
	case "$1" in
		/*) require_local_git OMARCHY_SERVER_REPO "$1" ;;
		*://*|*@*:*) ;;
		*) require_local_git OMARCHY_SERVER_REPO "$1" ;;
	esac
}
SOURCE="$(trim_env "${OMARCHY_SERVER_SOURCE-}")"
APP_STORE="$(trim_env "${OMARCHY_SERVER_APP_STORE-}")"
[ -z "$SOURCE" ] || require_local_git OMARCHY_SERVER_SOURCE "$SOURCE"
[ -z "$APP_STORE" ] || require_local_git OMARCHY_SERVER_APP_STORE "$APP_STORE"
if [ -z "${OMARCHY_SERVER_REPO-}" ] && [ -n "$SOURCE" ]; then
	REPO="$SOURCE"
fi
require_repo "$REPO"
# The port goes into the web service's unit file and the firewall rule. Check it before anything is installed,
# so a typo is an error now and not a half-finished install later (the firewall step would be the one to fail).
check_port() {
	case "$PORT" in
		'' | *[!0-9]*) die "OMARCHY_SERVER_PORT is \"$PORT\" but must be a number from 1 to 65535." ;;
	esac
	if [ "${#PORT}" -gt 5 ] || [ "$((10#$PORT))" -lt 1 ] || [ "$((10#$PORT))" -gt 65535 ]; then
		die "OMARCHY_SERVER_PORT is \"$PORT\" but must be a number from 1 to 65535."
	fi
	PORT=$((10#$PORT))
}
check_port

[ "$(id -u)" -ne 0 ] || die "Run this as your normal user, not with sudo. It asks for sudo only to install packages."
if ! command -v pacman >/dev/null; then
	found=$( (. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-$ID}") || uname -s)
	die "This installer is for Omarchy (Arch Linux), but this machine runs $found. Run it on your Omarchy machine."
fi
command -v systemctl >/dev/null || die "systemd is required."
# x86-64 (Intel, AMD) or ARM 64-bit (Omarchy on Apple Silicon, Snapdragon, …). The only difference
# here is the firmware virtual machines start from: OVMF on x86-64, the ARM build of EDK2 on ARM
# (Arch Linux ARM names it qemu-system-arm-firmware; Arch's own package is edk2-aarch64).
arch=$(uname -m)
case "$arch" in
x86_64) vm_pkgs="qemu-base edk2-ovmf" ;;
aarch64)
	vm_fw=edk2-aarch64
	pacman -Si "$vm_fw" >/dev/null 2>&1 || pacman -Qi "$vm_fw" >/dev/null 2>&1 || vm_fw=qemu-system-arm-firmware
	vm_pkgs="qemu-base qemu-system-aarch64 $vm_fw"
	;;
*) die "My Own Data Center needs a 64-bit Intel, AMD or ARM computer; this one is $arch." ;;
esac

# 1. Packages. Machines: QEMU + libvirt (per-user session), passt for their networking, xorriso
#    (libisoburn) for cloud-init seeds. Apps: rootless Podman driven by docker-compose. NAS: Btrfs,
#    drive health (smartmontools), drive sleep (hdparm), network shares (samba), and tmux so the
#    terminal outlives restarts and updates.
need=()
for pkg in nodejs npm git openssl wayvnc bubblewrap $vm_pkgs libvirt passt libisoburn podman docker-compose btrfs-progs smartmontools hdparm samba rsync openssh tmux; do pacman -Qi "$pkg" >/dev/null 2>&1 || need+=("$pkg"); done
# Arch doesn't support installing packages from a newer package list without updating the rest
# ("partial upgrade"): a new package can need newer libraries than the ones installed. That's how
# Samba ended up half-updated (samba 4.25 with its libraries, smbclient and libwbclient, at 4.24).
# So the system is brought up to date first: on Omarchy with `omarchy update` (Omarchy blocks a direct
# `pacman -Syu`, because its update also runs snapshots, migrations and hooks), elsewhere with
# pacman -Syu. A Samba whose parts don't match is brought back in step the same way.
samba_in_step() { [ "$(pacman -Q samba smbclient libwbclient 2>/dev/null | awk '{print $2}' | sort -u | wc -l)" -le 1 ]; }
if [ ${#need[@]} -gt 0 ] || ! samba_in_step; then
	if [ ${#need[@]} -gt 0 ]; then
		say "Installing ${need[*]}. Updating the system first, so everything stays in step (sudo needed)"
	else
		say "Samba's parts are different versions (a partial update); updating the system to bring them in step (sudo needed)"
	fi
	if command -v omarchy >/dev/null 2>&1; then
		# Over ssh, Omarchy's own scripts miss OMARCHY_PATH (only the desktop session sets it), and the
		# update stops with "OMARCHY_PATH: unbound variable".
		if [ -z "${OMARCHY_PATH:-}" ] && [ -d /usr/share/omarchy ]; then export OMARCHY_PATH=/usr/share/omarchy; fi
		# The update asks you to confirm, so it needs a terminal: without one (ssh host '…', automation)
		# it would wait forever.
		[ -t 0 ] || die "The system update needs a terminal to confirm in. Run this from a terminal (ssh -t), or install ${need[*]:-the missing packages} first."
		omarchy update || die "The system update didn't finish. Run 'omarchy update' (or Omarchy menu → Update), then run this installer again."
		[ ${#need[@]} -eq 0 ] || sudo pacman -S --needed --noconfirm "${need[@]}"
	else
		sudo pacman -Syu --needed --noconfirm "${need[@]}"
	fi
	samba_in_step || die "Samba's parts are still different versions. Check with: pacman -Q samba smbclient libwbclient"
fi
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || die "Node.js 20 or newer is required."

# 2. Code: fresh clone, or update in place.
mkdir -p "$BASE"
local_repo() { [ -e "$1/.git" ]; }
if [ -d "$APP/.git" ]; then
	say "Updating My Own Data Center"
	# Installed from somewhere else before (e.g. omarchy-server, now the dev copy, or back): follow this
	# installer's repository from now on, for this update and the in-app updates after it.
	if [ "$(git -C "$APP" remote get-url origin 2>/dev/null)" != "$REPO" ]; then
		say "Switching to $REPO"
		git -C "$APP" remote set-url origin "$REPO"
	fi
	if local_repo "$REPO"; then
		git -C "$APP" fetch --depth 1 "$REPO" HEAD
		git -C "$APP" reset --hard FETCH_HEAD
	else
		# Name where the branch lands: a shallow clone only tracks the branch it was cloned from, so a plain
		# `fetch origin <other branch>` would leave origin/<other branch> missing and the reset would fail.
		git -C "$APP" fetch --depth 1 origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
		git -C "$APP" reset --hard "origin/$BRANCH"
	fi
else
	say "Downloading My Own Data Center"
	if local_repo "$REPO"; then
		git clone --depth 1 "$REPO" "$APP"
		git -C "$APP" fetch --depth 1 "$REPO" HEAD
		git -C "$APP" reset --hard FETCH_HEAD
	else
		git clone --depth 1 --branch "$BRANCH" "$REPO" "$APP"
	fi
fi

say "Building (a minute or two the first time)"
cd "$APP"
LOG="$BASE/install.log"
# Small machines (and ones running many apps) can run out of memory installing packages. With
# under 1.5 GB free, borrow 2 GB of disk as temporary swap for the build; it's removed afterwards.
BUILD_SWAP=""
remove_build_swap() {
	if [ -n "$BUILD_SWAP" ]; then
		sudo swapoff "$BUILD_SWAP" 2>/dev/null || true
		sudo rm -f "$BUILD_SWAP" || true
		BUILD_SWAP=""
	fi
}
trap remove_build_swap EXIT
avail_mb=$(awk '/MemAvailable/ {print int($2 / 1024)}' /proc/meminfo)
if [ "${avail_mb:-0}" -lt 1536 ]; then
	say "Only ${avail_mb} MB of memory free: adding temporary swap for the build (sudo needed)"
	swap=/var/tmp/omarchy-server-build.swap
	sudo rm -f "$swap"
	if [ "$(stat -f -c %T /var/tmp)" = btrfs ]; then
		made=$(sudo btrfs filesystem mkswapfile --size 2g "$swap" >/dev/null 2>&1 && echo yes || echo no)
	else
		made=$(sudo fallocate -l 2G "$swap" && sudo chmod 600 "$swap" && sudo mkswap "$swap" >/dev/null 2>&1 && echo yes || echo no)
	fi
	if [ "$made" = yes ] && sudo swapon "$swap"; then
		BUILD_SWAP="$swap"
	else
		sudo rm -f "$swap" || true
		say "Couldn't add swap; trying the build anyway"
	fi
fi
# Packages are reinstalled only when they changed (most updates change none).
if ! { node scripts/deps.mjs && NODE_OPTIONS=--max-old-space-size=1024 npm run build; } >"$LOG" 2>&1; then
	tail -n 30 "$LOG" >&2
	if grep -q "ran out of memory\|Killed\|heap out of memory" "$LOG"; then
		die "The build ran out of memory. Stop a few apps (or give this computer more memory), then run the installer again. Full log: $LOG"
	fi
	die "The build failed. Full log: $LOG"
fi
remove_build_swap

# The old installer appended a one-line [archzfs] header and Server lines for archzfs.com.
# Delete that whole section, up to the next header, so a later Server line cannot fall
# into the repository above it. Leave a section that is not only those Server lines alone.
# Copy to .bak first. sudo only when the file is /etc/pacman.conf.
remove_stale_archzfs() {
	local conf="$1"
	[ -f "$conf" ] || return 0
	awk 'BEGIN { found=0; simple=1; ins=0; arch=0 } /^\[archzfs\]$/ { found=1; ins=1; next } ins && /^\[/ { ins=0; next } ins { if ($0 ~ /^[[:space:]]*$/) next; if ($0 ~ /^Server = /) { if ($0 ~ /archzfs/) arch=1; next } simple=0 } END { exit (found && simple && arch) ? 0 : 1 }' "$conf" || return 0
	say "Removing the outdated archzfs.com repository from pacman.conf"
	if [ "$conf" = /etc/pacman.conf ]; then
		sudo cp -a -- "$conf" "$conf.bak"
		sudo sed -i -- '/^\[archzfs\]$/,/^\[/{/^\[archzfs\]$/d;/^\[/!d}' "$conf"
	else
		cp -a -- "$conf" "$conf.bak"
		sed -i -- '/^\[archzfs\]$/,/^\[/{/^\[archzfs\]$/d;/^\[/!d}' "$conf"
	fi
}

# 2a. ZFS (only with --zfs). Built from the AUR (zfs-utils + zfs-dkms, the current OpenZFS release)
#     for your exact kernel with DKMS. Every kernel update rebuilds it; on a kernel newer than
#     OpenZFS supports, that build fails and pools stay offline until OpenZFS catches up.
if [ "$ZFS" = 1 ]; then
	command -v yay >/dev/null 2>&1 || die "ZFS is built from the AUR and needs yay (Omarchy includes it). Install yay, then run this again with --zfs."

	# Undo an earlier attempt that used the stale archzfs.com repository (it serves an old ZFS).
	remove_stale_archzfs /etc/pacman.conf

	# Bring the system up to date the way it expects: Omarchy refuses a direct `pacman -Syu`.
	if command -v omarchy >/dev/null 2>&1; then
		say "Updating the system with 'omarchy update' first (Omarchy's own way)"
		omarchy update || die "'omarchy update' didn't finish. Run it yourself, then run this installer again with --zfs."
	else
		sudo pacman -Syu --noconfirm || die "Updating the system failed (see above)"
	fi

	# Headers must be the same version as the kernel, or DKMS builds for a kernel you don't have.
	kernel=$(pacman -Qqo "/usr/lib/modules/$(uname -r)/vmlinuz" 2>/dev/null || true)
	[ -n "$kernel" ] || die "Your kernel was updated. Restart the computer, then run this installer again with --zfs."
	kver=$(pacman -Q "$kernel" | awk '{print $2}')
	sudo pacman -S --needed --noconfirm "${kernel}-headers" || die "Couldn't install ${kernel}-headers"
	hver=$(pacman -Q "${kernel}-headers" | awk '{print $2}')
	if [ "$kver" != "$hver" ]; then
		repo_kver=$(pacman -Si "$kernel" 2>/dev/null | awk -F': ' '/^Version/{print $2; exit}')
		if [ "$repo_kver" = "$hver" ]; then
			say "Your kernel ($kver) is older than its headers ($hver): installing kernel $hver to match"
			sudo pacman -S --noconfirm "$kernel" || die "Couldn't update $kernel"
			say "Kernel updated. Restart the computer, then run this installer again with --zfs."
			exit 0
		fi
		die "Kernel $kernel is $kver but its headers are $hver, and no matching pair is available yet. Try again after the next 'omarchy update'."
	fi

	say "Building ZFS from the AUR (zfs-utils, zfs-dkms). This takes several minutes."
	yay -S --needed --noconfirm --answerclean None --answerdiff None --pgpfetch zfs-utils zfs-dkms || die "Building ZFS failed (see above)"
	if ! sudo modprobe zfs 2>/dev/null; then
		dkms status zfs 2>/dev/null || true
		die "ZFS was built, but its module didn't load for kernel $(uname -r). Your kernel may be newer than OpenZFS supports yet; the lines above show what DKMS built."
	fi
	sudo systemctl enable zfs-import-cache.service zfs-mount.service zfs-import.target zfs.target >/dev/null 2>&1 || true
	say "ZFS $(zfs version 2>/dev/null | head -1) is ready"
fi

# 2b. Apps run in rootless Podman as you: give your user its container ID range and a socket.
if ! grep -q "^$USER:" /etc/subuid 2>/dev/null || ! grep -q "^$USER:" /etc/subgid 2>/dev/null; then
	say "Giving your user a container ID range (sudo needed)"
	sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 "$USER"
	podman system migrate >/dev/null 2>&1 || true
fi
REG="${XDG_CONFIG_HOME:-$HOME/.config}/containers/registries.conf"
if [ ! -f "$REG" ]; then
	mkdir -p "$(dirname "$REG")"
	printf '# Short image names (e.g. nginx) come from Docker Hub, as app stores expect.\nunqualified-search-registries = ["docker.io"]\n' >"$REG"
fi
systemctl --user enable --now podman.socket >/dev/null
# Rootless Podman has no daemon to restart apps after a reboot ("restart: unless-stopped"): this unit
# starts them at boot (linger is on, so no sign-in is needed).
systemctl --user enable podman-restart.service >/dev/null 2>&1 || true

# 2c. The storage helper: the one part that runs as root, allowed by a single sudoers rule.
#     It's copied root-owned so nothing running as you can change it.
say "Installing the storage helper (sudo needed)"
sudo install -d -o root -g root -m 0755 /usr/local/libexec/omarchy-server
sudo install -o root -g root -m 0755 "$APP/helper/helper.mjs" /usr/local/libexec/omarchy-server/helper.mjs
rule="$USER ALL=(root) NOPASSWD: /usr/local/libexec/omarchy-server/helper.mjs"
tmp=$(mktemp)
printf '# MODC: lets %s run the storage helper (and nothing else) without a password.\n%s\n' "$USER" "$rule" >"$tmp"
if sudo visudo -cf "$tmp" >/dev/null; then
	sudo install -o root -g root -m 0440 "$tmp" /etc/sudoers.d/omarchy-server
else
	say "Skipped the sudoers rule (it didn't validate); storage management will be unavailable."
fi
rm -f "$tmp"
mkdir -p "$HOME/Pools"

# 2d. Everyday controls: the `omarchy-server` command, launcher entries (Super + Space), and the first
#     time only, a status icon in the top bar (`omarchy-server widget off` removes it).
mkdir -p "$HOME/.local/bin" "${XDG_DATA_HOME:-$HOME/.local/share}/applications"
chmod +x "$APP/bin/omarchy-server"
ln -sf "$APP/bin/omarchy-server" "$HOME/.local/bin/omarchy-server"
ln -sf "$APP/bin/machines-add-lxc" "$HOME/.local/bin/machines-add-lxc"
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
cat >"$APPS/omarchy-server.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=My Own Data Center
Comment=Open this server
Exec=$HOME/.local/bin/omarchy-server open
Icon=network-server
Terminal=false
Categories=System;
EOF
cat >"$APPS/omarchy-server-restart.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Restart My Own Data Center
Comment=Restart this server
Exec=$HOME/.local/bin/omarchy-server restart
Icon=view-refresh
Terminal=false
Categories=System;
EOF
# Record the offer only after the icon is added. No top bar yet stays quiet and is tried again next time.
offer_top_bar_widget() {
	local out
	if out=$("$HOME/.local/bin/omarchy-server" widget on 2>&1); then
		[ -z "$out" ] || printf '%s\n' "$out"
		touch "$BASE/.widget-offered"
	fi
}
if [ ! -e "$BASE/.widget-offered" ]; then
	offer_top_bar_widget
fi

# 3. Your account, created here in the terminal so the password never crosses the network.
if ! node "$APP/omarchyd/cli.mjs" has-owner --data "$BASE/omarchyd" >/dev/null 2>&1; then
	say "Create your account"
	if (: </dev/tty) 2>/dev/null; then
		# The same rule create-owner enforces (^[\p{L}\p{N} ._-]{1,40}$). A directory login
		# (an @ or a backslash) is refused only after the password unless it is fixed here.
		owner_name=$(id -un)
		owner_args=()
		account_name_ok() { node -e 'const n=process.argv[1]??""; process.exit(/^[\p{L}\p{N} ._-]{1,40}$/u.test(n)?0:1)' "$1"; }
		if ! account_name_ok "$owner_name"; then
			printf 'The login name "%s" cannot be the account name. Use 1-40 letters, numbers, spaces, dots, dashes or underscores, or pass --name.\n' "$owner_name" >&2
			cleaned=$(node -e 'const n=process.argv[1]??""; process.stdout.write([...n].filter((ch)=>/^[\p{L}\p{N} ._-]$/u.test(ch)).join("").slice(0,40))' "$owner_name")
			if account_name_ok "$cleaned"; then
				printf 'Using "%s" instead.\n' "$cleaned" >&2
				owner_name=$cleaned
			else
				printf 'Account name: ' >/dev/tty
				read -r chosen </dev/tty
				account_name_ok "$chosen" || die "That name is not allowed. Use 1-40 letters, numbers, spaces, dots, dashes or underscores, or pass --name."
				owner_name=$chosen
			fi
			owner_args=(--name "$owner_name")
		fi
		node "$APP/omarchyd/cli.mjs" create-owner "${owner_args[@]}" --data "$BASE/omarchyd" </dev/tty
	else
		die "No terminal to type a password in. Run this installer again from a terminal (ssh -t): the services are created only by a full run."
	fi
fi

# 4. Services, started now and at every boot.
mkdir -p "$UNITS"
NODE="$(command -v node)"
# Persist isolation env only when the installer was given those variables (do not invent paths).
SOURCE_ENV=""
if [ -n "$SOURCE" ]; then SOURCE_ENV="${SOURCE_ENV}Environment=\"OMARCHY_SERVER_SOURCE=$SOURCE\"
"; fi
if [ -n "$APP_STORE" ]; then SOURCE_ENV="${SOURCE_ENV}Environment=\"OMARCHY_SERVER_APP_STORE=$APP_STORE\"
"; fi
cat >"$UNITS/omarchyd.service" <<EOF
[Unit]
Description=MODC backend (localhost only)
After=network-online.target
# Never stop retrying: on a server with no screen nobody is there to start it by hand after a boot.
StartLimitIntervalSec=0

[Service]
$SOURCE_ENV
ExecStart=$NODE $APP/omarchyd/cli.mjs serve --port 2021 --web-port $PORT --data $BASE/omarchyd
Restart=on-failure
RestartSec=3
TimeoutStopSec=10
# virsh/qemu/passt stay in this cgroup; kill only node so guests survive a restart.
KillMode=process

[Install]
WantedBy=default.target
EOF
cat >"$UNITS/omarchy-server-web.service" <<EOF
[Unit]
Description=MODC web app
After=omarchyd.service
Wants=omarchyd.service
StartLimitIntervalSec=0

[Service]
ExecStart=$NODE $APP/server/cli.mjs --port $PORT --data $BASE/web --backend http://127.0.0.1:2021
Restart=on-failure
RestartSec=3
TimeoutStopSec=10
NoNewPrivileges=yes

[Install]
WantedBy=default.target
EOF
# Your Omarchy desktop in the web app: wayvnc shares the running Hyprland session on a private socket
# in your runtime folder (never on the network, and not on a local port either, so other programs and
# containers on this server can't reach it). The web app reaches it through omarchyd, behind your
# sign-in. It runs while you're signed in to Omarchy on this machine, and stops when you sign out.
cat >"$UNITS/omarchy-server-desktop.service" <<'EOF'
[Unit]
Description=MODC: share this Omarchy desktop with the web app (private socket)
PartOf=graphical-session.target
After=graphical-session.target

[Service]
ExecStartPre=/usr/bin/mkdir -p -m 0700 %t/omarchy-server
ExecStartPre=/usr/bin/rm -f %t/omarchy-server/desktop-vnc.sock
ExecStart=/usr/bin/wayvnc --max-fps=30 -S %t/omarchy-server/wayvncctl --unix-socket %t/omarchy-server/desktop-vnc.sock
Restart=on-failure
RestartSec=3

[Install]
WantedBy=graphical-session.target
EOF
systemctl --user daemon-reload
systemctl --user enable omarchyd.service omarchy-server-web.service omarchy-server-desktop.service >/dev/null
[ "$FROM_APP" = 1 ] || systemctl --user restart omarchyd.service omarchy-server-web.service
# Start sharing now if a desktop session is running (otherwise it starts at the next sign-in).
systemctl --user is-active --quiet graphical-session.target && systemctl --user restart omarchy-server-desktop.service >/dev/null 2>&1 || true

# Omarchy turns on a firewall (ufw) that blocks incoming connections: let the web app through.
# Rules are added even while ufw is off, so they apply as soon as it's turned on.
if command -v ufw >/dev/null 2>&1; then
	say "Allowing this server through the firewall (sudo needed)"
	sudo ufw allow "$PORT/tcp" comment 'MODC' >/dev/null

	# Machine port forwards live in 40000-49999. Nothing listens there until you add a forward to a
	# machine, so this only lets forwards you create be reached from your network.
	sudo ufw allow 40000:49999/tcp comment 'MODC machine forwards' >/dev/null
	sudo ufw allow 40000:49999/udp comment 'MODC machine forwards' >/dev/null

	# App windows that can't load straight from the app (rare) go through a relay on 7800-7899.
	sudo ufw allow 7800:7899/tcp comment 'MODC app windows' >/dev/null
fi

# Start at boot and keep running when nobody is signed in ("linger"). A server with no screen depends
# on this to come back after a restart or a power cut. Your own linger usually needs no sudo; ask for
# sudo only if that's refused (and never wait on a password prompt during an in-app update).
if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]; then
	say "Letting this server start at boot and run while you're logged out"
	loginctl enable-linger "$USER" 2>/dev/null ||
		{ if [ "$FROM_APP" = 1 ]; then sudo -n loginctl enable-linger "$USER" 2>/dev/null; else sudo loginctl enable-linger "$USER"; fi; } ||
		true
	if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]; then
		say "Couldn't turn that on: after a restart this server stays off until you sign in. To fix it, run: sudo loginctl enable-linger $USER"
	fi
fi

# --- Unattended boot -------------------------------------------------------------------------------
# Omarchy encrypts the system disk, so after a restart or power cut the computer waits at the disk
# password screen and nothing (this server included) can start. If the owner agrees, add a second
# key to the disk as a file inside the boot image: Omarchy's `encrypt` hook uses /crypto_keyfile.bin
# automatically, so the disk unlocks itself. The original disk password keeps working. Desktop
# auto-login is turned off at the same time, so the screen asks for the Linux password instead.
# Only new zz-modc-* files are written; nothing Omarchy owns is edited, so snapshot booting keeps working.
MODC_KEYFILE=/crypto_keyfile.bin
MODC_INITCPIO_CONF=/etc/mkinitcpio.conf.d/zz-modc-unattended.conf
MODC_SDDM_CONF=/etc/sddm.conf.d/zz-modc-login.conf

# Prints the LUKS partition under / (e.g. /dev/sdb2), or nothing when / isn't encrypted.
modc_root_luks() {
	local src
	src=$(findmnt -no SOURCE / 2>/dev/null | sed 's/\[.*//') || return 0
	case "$src" in /dev/*) ;; *) return 0 ;; esac
	lsblk -s -rno PATH,FSTYPE "$src" 2>/dev/null | awk '$2 == "crypto_LUKS" { print $1; exit }' || true
}

# True when the disk already unlocks without anyone typing (TPM, FIDO key, Clevis, or our key file).
modc_unlocks_itself() {
	grep -qE 'tpm2-device|fido2-device' /proc/cmdline /etc/crypttab /etc/crypttab.initramfs 2>/dev/null && return 0
	[ -e /usr/lib/initcpio/install/clevis ] && return 0
	[ -f "$MODC_INITCPIO_CONF" ] && return 0
	return 1
}

modc_rebuild_boot_image() {
	if command -v limine-mkinitcpio >/dev/null 2>&1; then sudo limine-mkinitcpio; else sudo mkinitcpio -P; fi
}

modc_enable_unattended_boot() {
	local luks="$1"
	if sudo test -e "$MODC_KEYFILE"; then
		say "Skipping: $MODC_KEYFILE already exists but isn't set up by My Own Data Center. Leaving it alone."
		return 0
	fi
	say "Creating a disk key for unattended boot"
	sudo sh -c "umask 077 && dd if=/dev/random of='$MODC_KEYFILE' bs=512 count=4 iflag=fullblock status=none" || {
		say "Couldn't create the key file. Unattended boot was not turned on."
		return 0
	}
	say "Type your disk password (the one you enter at boot) to add the new key"
	if ! sudo cryptsetup luksAddKey "$luks" "$MODC_KEYFILE"; then
		sudo rm -f "$MODC_KEYFILE"
		say "The disk password wasn't accepted. Unattended boot was not turned on; nothing changed."
		return 0
	fi
	echo "FILES+=($MODC_KEYFILE)" | sudo tee "$MODC_INITCPIO_CONF" >/dev/null
	say "Rebuilding the boot image (this can take a minute)"
	if ! modc_rebuild_boot_image; then
		say "Rebuilding the boot image failed. Undoing the change."
		sudo rm -f "$MODC_INITCPIO_CONF"
		sudo cryptsetup luksRemoveKey "$luks" "$MODC_KEYFILE" || true
		sudo rm -f "$MODC_KEYFILE"
		if ! modc_rebuild_boot_image; then
			say "WARNING: the boot image could not be rebuilt. Do not restart this computer. Run 'sudo limine-mkinitcpio' and fix the errors it shows first."
		fi
		return 0
	fi
	if [ -d /etc/sddm.conf.d ]; then
		printf '[Autologin]\nUser=\nSession=\n' | sudo tee "$MODC_SDDM_CONF" >/dev/null
	fi
	say "Unattended boot is on: after a restart or power cut this server starts by itself."
	say "The screen now asks for your Linux password. Your disk password still works if the key is ever missing."
	say "One more step only you can do: in the BIOS, set 'Restore on AC power loss' to 'Power On'."
}

MODC_LUKS="$(modc_root_luks)"
if [ -n "$MODC_LUKS" ] && ! modc_unlocks_itself; then
	if [ "$FROM_APP" = 1 ]; then
		: # No terminal during in-app updates; the owner turns this on by running the installer.
	elif ! grep -q 'cryptdevice=' /proc/cmdline; then
		say "Your disk is encrypted with a boot setup this installer doesn't handle yet, so it will keep asking for the disk password at boot."
	else
		printf '\n'
		say "Your disk is encrypted, so after a restart or power cut this server waits until someone types the disk password at the computer."
		printf '    Turn on unattended boot? The disk unlocks by itself and the server starts on its own.\n'
		printf '    The screen will ask for your Linux password instead of logging in automatically.\n'
		printf '    Trade-off: anyone who takes the computer or its drive could read the data.\n'
		MODC_ANSWER=""
		read -r -p "    Turn it on? [y/N] " MODC_ANSWER || MODC_ANSWER=""
		case "$MODC_ANSWER" in
			[yY] | [yY][eE][sS]) modc_enable_unattended_boot "$MODC_LUKS" ;;
			*) say "Left as is. Run the installer again any time to turn this on." ;;
		esac
	fi
fi
# --- end unattended boot ---------------------------------------------------------------------------

# Everything above succeeded (the script stops at the first error): note which installer ran, so the
# app knows it's up to date.
mkdir -p "$BASE/omarchyd"
printf '%s\n' "$INSTALLER_REVISION" >"$BASE/omarchyd/installer-revision"

if [ "$FROM_APP" = 1 ]; then
	# A separate, short-lived unit restarts both services after this script has finished.
	systemd-run --user --collect --on-active=5s --unit="omarchy-server-installer-restart-$(date +%s)" \
		systemctl --user restart omarchyd.service omarchy-server-web.service >/dev/null
	say "Done. This server restarts in a few seconds; the page reconnects by itself."
	exit 0
fi

sleep 2
# Skip container bridges by name, not by address. The NAT note is only QEMU's 10.0.2.0/24.
lan_urls() {
	local port="$1" ip private_only=yes ips
	ips=$(ip -4 -o addr show scope global 2>/dev/null | awk '$2 ~ /^(docker0|podman.*|cni.*|virbr.*|br-.*)$/ { next } { split($4, a, "/"); if (a[1] != "") print a[1] }' || true)
	say "My Own Data Center is running."
	for ip in $ips; do
		printf '    http://%s:%s\n' "$ip" "$port"
		if [[ "$ip" =~ ^10\.0\.2\.([0-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-5])$ ]]; then
			:
		else
			private_only=no
		fi
	done
	if [ "$private_only" = yes ] && [ -n "$ips" ]; then
		printf '\n    Note: this machine only has a private address (a VM behind NAT), so other devices reach it\n'
		printf '    through a port forward on the VM host to port %s. If you already set one up, it still\n' "$port"
		printf '    works after updates and restarts: keep using http://<host-ip>:<forwarded port>.\n\n'
	fi
}
if systemctl --user is-active --quiet omarchy-server-web.service && systemctl --user is-active --quiet omarchyd.service; then
	lan_urls "$PORT"
	printf '    Logs: journalctl --user -u omarchyd -u omarchy-server-web -f\n'
else
	die "A service didn't start. See: journalctl --user -u omarchyd -u omarchy-server-web -n 50"
fi
}

# On one line, so bash has read it all before main starts, and stops when main ends.
main "$@"; exit
