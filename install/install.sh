#!/usr/bin/env bash
#
# quack installer — git-like authenticated circuit launcher for ModelWorks.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/modelworks-ai/quack/main/install/install.sh | bash
#
# Options:
#   -v, --version <version>   Install a specific version
#   --no-modify-path          Don't modify shell config files
#   -h, --help                Display this help message
#
# Environment:
#   NONINTERACTIVE=1          Skip confirmation prompt
#   CI=1                      Implies NONINTERACTIVE
#   QUACK_NODE_VERSION        Override the bundled Node version (default: 22.19.0)
#
set -euo pipefail

APP=quack
PACKAGE_NAME="@modelworks/quack"
INSTALL_DIR="$HOME/.quack"
BIN_DIR="$INSTALL_DIR/bin"
DIST_DIR="$INSTALL_DIR/dist"
NODE_DIR="$INSTALL_DIR/node"

# Bundled Node version — bumped periodically. Only downloaded when system
# Node is missing or too old.
BUNDLED_NODE_VERSION="${QUACK_NODE_VERSION:-22.19.0}"

# Terminal colors (disabled when not a TTY).
if [ -t 1 ]; then
  MUTED='\033[0;2m'
  RED='\033[0;31m'
  ORANGE='\033[38;5;214m'
  GREEN='\033[0;32m'
  BOLD='\033[1m'
  NC='\033[0m'
else
  MUTED='' RED='' ORANGE='' GREEN='' BOLD='' NC=''
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

abort() {
  printf "${RED}Error: %s${NC}\n" "$*" >&2
  exit 1
}

warn() {
  printf "${ORANGE}Warning: %s${NC}\n" "$*" >&2
}

info() {
  printf "${MUTED}%s${NC}\n" "$*" >&2
}

ohai() {
  printf "${BOLD}==> %s${NC}\n" "$*" >&2
}

shell_join() {
  local arg
  printf "%s" "$1"
  shift
  for arg in "$@"; do
    printf " %s" "${arg// /\ }"
  done
}

# Retry a command with exponential backoff (Homebrew pattern).
retry() {
  local tries="$1" n="$1" pause=2
  shift
  if ! "$@"; then
    while [ $((--n)) -gt 0 ]; do
      warn "Retrying in ${pause}s: $(shell_join "$@")"
      sleep "$pause"
      pause=$((pause * 2))
      if "$@"; then
        return 0
      fi
    done
    abort "Failed ${tries} times: $(shell_join "$@")"
  fi
}

# ---------------------------------------------------------------------------
# Option parsing
# ---------------------------------------------------------------------------

usage() {
  cat <<EOF
quack Installer

Usage:
  curl -fsSL https://raw.githubusercontent.com/modelworks-ai/quack/main/install/install.sh | bash

Options:
  -v, --version <version>   Install a specific version (e.g., 0.1.0)
  --no-modify-path          Don't modify shell config files (.zshrc, .bashrc, etc.)
  -h, --help                Display this help message

Environment:
  NONINTERACTIVE=1          Install without prompting
  CI=1                      Implies NONINTERACTIVE
  QUACK_NODE_VERSION        Override bundled Node version (default: ${BUNDLED_NODE_VERSION})
EOF
}

requested_version=""
no_modify_path=false

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    -v|--version)
      [ -n "${2:-}" ] || abort "--version requires a version argument"
      requested_version="$2"
      shift 2
      ;;
    --no-modify-path)
      no_modify_path=true
      shift
      ;;
    *)
      warn "Unknown option: '$1'"
      shift
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Interactivity detection (Homebrew pattern)
# ---------------------------------------------------------------------------

if [ -z "${NONINTERACTIVE-}" ]; then
  if [ -n "${CI-}" ]; then
    NONINTERACTIVE=1
    warn "Running in non-interactive mode because \$CI is set."
  elif [ ! -t 0 ]; then
    NONINTERACTIVE=1
    warn "Running in non-interactive mode because stdin is not a TTY."
  fi
fi

# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------

command -v curl >/dev/null 2>&1 || abort "'curl' is required but not installed."
command -v tar >/dev/null 2>&1 || abort "'tar' is required but not installed."

# ---------------------------------------------------------------------------
# Node detection — system Node or bundled fallback
# ---------------------------------------------------------------------------

# Returns the Node major version, or 0 if node is missing/unparseable.
node_major_version() {
  local node_bin="$1"
  [ -x "$node_bin" ] || return 0
  local ver
  ver="$("$node_bin" --version 2>/dev/null || echo "")"
  # Expected: "v22.19.0" → 22
  ver="${ver#v}"
  echo "${ver%%.*}"
}

REQUIRED_NODE_MAJOR=18
SYSTEM_NODE=""
SYSTEM_NODE_MAJOR=0

if command -v node >/dev/null 2>&1; then
  SYSTEM_NODE="$(command -v node)"
  SYSTEM_NODE_MAJOR="$(node_major_version "$SYSTEM_NODE")"
fi

BUNDLED_NODE=""
USE_NODE=""

if [ "$SYSTEM_NODE_MAJOR" -ge "$REQUIRED_NODE_MAJOR" ]; then
  USE_NODE="$SYSTEM_NODE"
  info "Using system Node: $("$SYSTEM_NODE" --version)"
else
  if [ "$SYSTEM_NODE_MAJOR" -gt 0 ]; then
    warn "System Node is v${SYSTEM_NODE_MAJOR} (need >=${REQUIRED_NODE_MAJOR})."
  else
    info "Node not found on system."
  fi

  # Check if a previously-bundled Node exists from a prior install.
  BUNDLED_NODE_BIN="$NODE_DIR/node"
  if [ -x "$BUNDLED_NODE_BIN" ]; then
    BUNDLED_NODE_MAJOR="$(node_major_version "$BUNDLED_NODE_BIN")"
    if [ "$BUNDLED_NODE_MAJOR" -ge "$REQUIRED_NODE_MAJOR" ]; then
      USE_NODE="$BUNDLED_NODE_BIN"
      info "Using previously-bundled Node: $("$BUNDLED_NODE_BIN" --version)"
    fi
  fi

  # If still no usable Node, download the bundled version.
  if [ -z "$USE_NODE" ]; then
    ohai "Downloading bundled Node ${BUNDLED_NODE_VERSION}..."

    # Platform detection (same logic as OpenCode).
    raw_os="$(uname -s)"
    os="$(echo "$raw_os" | tr '[:upper:]' '[:lower:]')"
    case "$raw_os" in
      Darwin*) os="darwin" ;;
      Linux*)  os="linux" ;;
      MINGW*|MSYS*|CYGWIN*) os="windows" ;;
    esac

    arch="$(uname -m)"
    [ "$arch" = "aarch64" ] && arch="arm64"
    [ "$arch" = "x86_64" ] && arch="x64"

    # Rosetta detection on macOS x64.
    if [ "$os" = "darwin" ] && [ "$arch" = "x64" ]; then
      rosetta="$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)"
      [ "$rosetta" = "1" ] && arch="arm64"
    fi

    case "${os}-${arch}" in
      linux-x64|linux-arm64|darwin-x64|darwin-arm64) ;;
      *)
        abort "Unsupported OS/Arch for bundled Node: ${os}/${arch}. Install Node ${REQUIRED_NODE_MAJOR}+ manually from https://nodejs.org"
        ;;
    esac

    node_filename="node-v${BUNDLED_NODE_VERSION}-${os}-${arch}.tar.xz"
    node_url="https://nodejs.org/dist/v${BUNDLED_NODE_VERSION}/${node_filename}"

    tmp_node_dir="${TMPDIR:-/tmp}/quack_node_$$"
    mkdir -p "$tmp_node_dir"

    if ! retry 3 curl -fsL -o "$tmp_node_dir/$node_filename" "$node_url"; then
      rm -rf "$tmp_node_dir"
      abort "Failed to download Node ${BUNDLED_NODE_VERSION}. Install Node ${REQUIRED_NODE_MAJOR}+ manually from https://nodejs.org"
    fi

    tar -xf "$tmp_node_dir/$node_filename" -C "$tmp_node_dir"
    mkdir -p "$NODE_DIR"
    cp "$tmp_node_dir/node-v${BUNDLED_NODE_VERSION}-${os}-${arch}/bin/node" "$NODE_DIR/node"
    chmod 755 "$NODE_DIR/node"
    rm -rf "$tmp_node_dir"

    BUNDLED_NODE="$NODE_DIR/node"
    USE_NODE="$BUNDLED_NODE"
    info "Bundled Node installed: $("$BUNDLED_NODE" --version)"
  fi
fi

# ---------------------------------------------------------------------------
# Version resolution
# ---------------------------------------------------------------------------

if [ -z "$requested_version" ]; then
  metadata="$(curl -fsSL "https://registry.npmjs.org/${PACKAGE_NAME}/latest" || true)"
  specific_version="$(echo "$metadata" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' | head -1)"
  tarball_url="$(echo "$metadata" | sed -n 's/.*"tarball":"\([^"]*\)".*/\1/p' | head -1)"

  [ -z "$specific_version" ] || [ -z "$tarball_url" ] && abort "Failed to fetch latest version from npm registry."
else
  specific_version="${requested_version#v}"
  tarball_url="https://registry.npmjs.org/${PACKAGE_NAME}/-/quack-${specific_version}.tgz"
fi

# ---------------------------------------------------------------------------
# Confirmation prompt (Homebrew pattern)
# ---------------------------------------------------------------------------

if [ -z "${NONINTERACTIVE-}" ]; then
  printf "\n"
  ohai "This script will install:"
  echo "  ${BIN_DIR}/quack"
  echo "  ${DIST_DIR}/"
  [ -n "$BUNDLED_NODE" ] && echo "  ${NODE_DIR}/node (bundled)"
  printf "\n"
  printf "Press ${BOLD}RETURN${NC}/${BOLD}ENTER${NC} to continue or any other key to abort:\n"
  # Read a single character.
  if [ -t 0 ]; then
    save_state="$(stty -g 2>/dev/null || true)"
    stty raw -echo 2>/dev/null || true
    c=""
    read -r -n 1 c || true
    [ -n "$save_state" ] && stty "$save_state" 2>/dev/null || true
    printf "\n"
    [ "$c" = "$(printf '\r')" ] || [ "$c" = "$(printf '\n')" ] || exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Download with progress bar (OpenCode pattern)
# ---------------------------------------------------------------------------

print_progress() {
  local bytes="$1" length="$2"
  [ "$length" -gt 0 ] 2>/dev/null || return 0

  local width=50
  local percent=$(( bytes * 100 / length ))
  [ "$percent" -gt 100 ] && percent=100
  local on=$(( percent * width / 100 ))
  local off=$(( width - on ))

  local filled empty
  filled="$(printf "%*s" "$on" "")"
  filled="${filled// /■}"
  empty="$(printf "%*s" "$off" "")"
  empty="${empty// /･}"

  printf "\r${ORANGE}%s%s %3d%%${NC}" "$filled" "$empty" "$percent" >&4
}

download_with_progress() {
  local url="$1" output="$2"

  if [ -t 2 ]; then
    exec 4>&2
  else
    exec 4>/dev/null
  fi

  local headers="${output}.headers"
  printf "\033[?25l" >&4  # hide cursor
  trap 'trap - RETURN; rm -f "$headers"; printf "\033[?25h" >&4; exec 4>&-' RETURN

  curl -fsL -D "$headers" -o "$output" "$url" &
  local curl_pid=$!

  local length bytes
  while kill -0 "$curl_pid" 2>/dev/null; do
    if [ -f "$output" ]; then
      length="$(grep -i '^content-length:' "$headers" 2>/dev/null | tail -n1 | tr -dc '0-9' || true)"
      bytes="$(ls -ln "$output" | awk '{print $5}')"
      print_progress "$bytes" "${length:-0}"
    fi
    sleep 0.1 2>/dev/null || sleep 1
  done

  local ret=0
  wait "$curl_pid" || ret=$?
  if [ "$ret" -eq 0 ]; then
    bytes="$(ls -ln "$output" | awk '{print $5}')"
    print_progress "$bytes" "$bytes"
  fi
  echo "" >&4
  return $ret
}

# ---------------------------------------------------------------------------
# Download & install quack
# ---------------------------------------------------------------------------

ohai "Installing ${APP} ${specific_version}..."

tmp_dir="${TMPDIR:-/tmp}/quack_install_$$"
mkdir -p "$tmp_dir"
trap 'rm -rf "$tmp_dir"' EXIT

filename="quack-${specific_version}.tgz"

if ! download_with_progress "$tarball_url" "$tmp_dir/$filename"; then
  # Fallback for non-TTY or if custom progress fails.
  curl -f -# -L -o "$tmp_dir/$filename" "$tarball_url"
fi

tar -xzf "$tmp_dir/$filename" -C "$tmp_dir"

# npm tarball structure: package/dist/bin.js, package/dist/*.js, etc.
mkdir -p "$INSTALL_DIR"
rm -rf "$DIST_DIR"
cp -R "$tmp_dir/package/dist" "$DIST_DIR"

# ---------------------------------------------------------------------------
# Create wrapper script
# ---------------------------------------------------------------------------

mkdir -p "$BIN_DIR"

cat > "$BIN_DIR/quack" << 'WRAPPER'
#!/bin/sh
# quack wrapper — resolves Node (system or bundled) and launches quack.
set -e

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
QUACK_HOME="$(cd "$SELF_DIR/.." && pwd)"

# Prefer system Node if it's new enough.
if command -v node >/dev/null 2>&1; then
  NODE_BIN="node"
elif [ -x "$QUACK_HOME/node/node" ]; then
  NODE_BIN="$QUACK_HOME/node/node"
else
  echo "quack: Node 18+ not found. Reinstall:" >&2
  echo "  curl -fsSL https://raw.githubusercontent.com/modelworks-ai/quack/main/install/install.sh | bash" >&2
  exit 1
fi

exec "$NODE_BIN" "$QUACK_HOME/dist/bin.js" "$@"
WRAPPER

chmod 755 "$BIN_DIR/quack"

# ---------------------------------------------------------------------------
# PATH management (OpenCode pattern)
# ---------------------------------------------------------------------------

add_to_path() {
  local config_file="$1" command="$2"

  if grep -Fxq "$command" "$config_file" 2>/dev/null; then
    info "PATH entry already in $config_file, skipping."
  elif [ -w "$config_file" ]; then
    printf "\n# quack\n" >> "$config_file"
    printf "%s\n" "$command" >> "$config_file"
    info "Added quack to PATH in $config_file"
  else
    warn "Could not write to $config_file. Manually add:"
    info "  $command"
  fi
}

if [ "$no_modify_path" != "true" ]; then
  XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
  current_shell="$(basename "$SHELL")"

  case "$current_shell" in
    fish)
      config_files="$HOME/.config/fish/config.fish"
      path_command="fish_add_path $BIN_DIR"
      ;;
    zsh)
      config_files="${ZDOTDIR:-$HOME}/.zshrc ${ZDOTDIR:-$HOME}/.zshenv $XDG_CONFIG_HOME/zsh/.zshrc $XDG_CONFIG_HOME/zsh/.zshenv"
      path_command="export PATH=\"$BIN_DIR:\$PATH\""
      ;;
    bash)
      config_files="$HOME/.bashrc $HOME/.bash_profile $HOME/.profile $XDG_CONFIG_HOME/bash/.bashrc $XDG_CONFIG_HOME/bash/.bash_profile"
      path_command="export PATH=\"$BIN_DIR:\$PATH\""
      ;;
    ash|sh)
      config_files="$HOME/.ashrc $HOME/.profile /etc/profile"
      path_command="export PATH=\"$BIN_DIR:\$PATH\""
      ;;
    *)
      config_files="$HOME/.bashrc $HOME/.bash_profile $XDG_CONFIG_HOME/bash/.bashrc $XDG_CONFIG_HOME/bash/.bash_profile"
      path_command="export PATH=\"$BIN_DIR:\$PATH\""
      ;;
  esac

  config_file=""
  for file in $config_files; do
    [ -f "$file" ] && config_file="$file" && break
  done

  if [ -z "$config_file" ]; then
    warn "No shell config found for $current_shell. Manually add to PATH:"
    info "  $path_command"
  elif [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
    add_to_path "$config_file" "$path_command"
  else
    info "$BIN_DIR is already on PATH."
  fi
fi

# ---------------------------------------------------------------------------
# GitHub Actions support
# ---------------------------------------------------------------------------

if [ -n "${GITHUB_ACTIONS-}" ] && [ "$GITHUB_ACTIONS" = "true" ]; then
  echo "$BIN_DIR" >> "$GITHUB_PATH"
  info "Added $BIN_DIR to \$GITHUB_PATH"
fi

# ---------------------------------------------------------------------------
# Success banner
# ---------------------------------------------------------------------------

printf "\n"
printf "  ${GREEN}${BOLD}╔══════════════════════════════════════╗${NC}\n"
printf "  ${GREEN}${BOLD}║          quack installed! 🦆           ║${NC}\n"
printf "  ${GREEN}${BOLD}╚══════════════════════════════════════╝${NC}\n"
printf "\n"
printf "  ${MUTED}Version:${NC} ${specific_version}\n"
printf "  ${MUTED}Location:${NC} ${BIN_DIR}/quack\n"
[ -n "$BUNDLED_NODE" ] && printf "  ${MUTED}Node:${NC} bundled v${BUNDLED_NODE_VERSION}\n"
printf "\n"
printf "  ${BOLD}Next steps:${NC}\n"
printf "    quack login                              ${MUTED}# Authenticate via OAuth${NC}\n"
printf "    cd <project> && quack init               ${MUTED}# Initialize a project${NC}\n"
printf "    quack add <circuit-url>                  ${MUTED}# Add a circuit${NC}\n"
printf "    quack opencode                           ${MUTED}# Launch OpenCode${NC}\n"
printf "\n"
if [ "$no_modify_path" != "true" ]; then
  printf "  ${MUTED}Open a new terminal or run:${NC}\n"
  printf "  ${MUTED}  source ~/${current_shell:+.${current_shell}rc}  ${MUTED}# or restart your shell${NC}\n"
  printf "  ${MUTED}to use quack.${NC}\n"
else
  printf "  ${MUTED}Add to PATH: export PATH=\"$BIN_DIR:\$PATH\"${NC}\n"
fi
printf "\n"
printf "  ${MUTED}Docs: https://github.com/modelworks-ai/quack${NC}\n"
printf "\n"
