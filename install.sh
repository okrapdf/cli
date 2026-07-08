#!/usr/bin/env bash
#
# okra CLI installer — curl-installable, GitHub-release-tarball based.
#
#   curl -fsSL https://raw.githubusercontent.com/okrapdf/cli/main/install.sh | bash
#
# Installs the @okrapdf/cli GitHub *release tarball* globally with npm. This is
# deterministic by design: it NEVER installs from the npm registry, because the
# registry may still serve the legacy okra-cloud 0.16.x line during the npm
# handover (steventsao/okra#615). The release asset is always this BYOK CLI.
#
# Pin a specific tagged release with OKRA_INSTALL_VERSION, e.g.:
#   curl -fsSL https://raw.githubusercontent.com/okrapdf/cli/main/install.sh \
#     | OKRA_INSTALL_VERSION=v0.17.0 bash
#
# Requirements: Node.js >= 22 and npm on your PATH. No sudo, ever. No account,
# no okra API key — okra parse is bring-your-own-model-key.

set -euo pipefail

# ---- presentation ---------------------------------------------------------
# Color only when stdout is a terminal and NO_COLOR is unset. Under
# `curl ... | bash`, bash's stdout is still the terminal, so colors show.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  bold=$(printf '\033[1m');   dim=$(printf '\033[2m')
  green=$(printf '\033[32m'); yellow=$(printf '\033[33m'); red=$(printf '\033[31m')
  reset=$(printf '\033[0m')
else
  bold=''; dim=''; green=''; yellow=''; red=''; reset=''
fi

say()  { printf '%s\n' "$*"; }
step() { printf '%s==>%s %s\n' "$bold" "$reset" "$*"; }
warn() { printf '%s!%s %s\n' "$yellow" "$reset" "$*" >&2; }
die()  { printf '%s x%s %s\n' "$red" "$reset" "$*" >&2; exit 1; }

# ---- resolve the release tarball URL --------------------------------------
REPO='okrapdf/cli'
version="${OKRA_INSTALL_VERSION:-}"
if [ -n "$version" ]; then
  tarball_url="https://github.com/${REPO}/releases/download/${version}/okrapdf-cli.tgz"
  which_release="$version"
else
  tarball_url="https://github.com/${REPO}/releases/latest/download/okrapdf-cli.tgz"
  which_release='latest'
fi

# ---- preflight: Node.js >= 22 ---------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  die "Node.js is required but was not found on your PATH.
    Install Node.js >= 22, then re-run this installer. okra does not install Node for you.
      - Download: https://nodejs.org
      - Or nvm:   https://github.com/nvm-sh/nvm#installing-and-updating"
fi

node_version="$(node -v)"          # e.g. v22.22.0
node_version="${node_version#v}"   # 22.22.0
node_major="${node_version%%.*}"   # 22
case "$node_major" in
  '' | *[!0-9]*)
    die "Could not read your Node.js version from 'node -v' (got '${node_version}').";;
esac
if [ "$node_major" -lt 22 ]; then
  die "Node.js >= 22 is required, but you have ${node_version}.
    Upgrade Node, then re-run this installer.
      - Download: https://nodejs.org
      - Or nvm:   nvm install 22 && nvm use 22"
fi

# ---- preflight: npm -------------------------------------------------------
if ! command -v npm >/dev/null 2>&1; then
  die "npm is required but was not found on your PATH.
    npm ships with Node.js — reinstalling Node from https://nodejs.org restores it."
fi

# ---- install --------------------------------------------------------------
step "Installing okra CLI (${which_release} release) with npm..."
say  "${dim}${tarball_url}${reset}"

npm_log="$(mktemp)"
trap 'rm -f "$npm_log"' EXIT

# npm fetches the tarball URL itself and follows GitHub's redirect — no extra
# curl needed. Kept quiet (--loglevel=error) so success is a couple of lines;
# the full npm output is only surfaced on failure.
if ! npm install -g "$tarball_url" --no-fund --no-audit --loglevel=error >"$npm_log" 2>&1; then
  if grep -qiE 'EACCES|EPERM|permission denied' "$npm_log"; then
    warn "Global install failed with a permissions error — and okra never uses sudo."
    say ''
    say "Point npm's global install location at your home directory, then re-run:"
    say ''
    say "  ${bold}Option A - nvm${reset} (recommended; global installs land in your user dir):"
    say "    ${dim}https://github.com/nvm-sh/nvm#installing-and-updating${reset}"
    say ''
    say "  ${bold}Option B - a user-owned npm prefix${reset}:"
    say "    ${dim}npm config set prefix \"\$HOME/.npm-global\"${reset}"
    say "    ${dim}export PATH=\"\$HOME/.npm-global/bin:\$PATH\"${reset}   # add to ~/.zshrc or ~/.bashrc"
    exit 1
  fi
  warn "npm could not install the okra CLI. Its output:"
  sed 's/^/    /' "$npm_log" >&2 || true
  if [ -n "$version" ]; then
    die "Install failed. Check that OKRA_INSTALL_VERSION='${version}' matches a published release tag (e.g. v0.17.0): https://github.com/${REPO}/releases"
  fi
  die "Install failed (see npm output above)."
fi

# ---- verify ---------------------------------------------------------------
hash -r 2>/dev/null || true   # drop any stale command-location cache

if ! command -v okra >/dev/null 2>&1; then
  bin_dir="$(npm prefix -g 2>/dev/null)/bin"   # 'npm bin -g' was removed in npm 9+
  warn "okra was installed, but its directory is not on your PATH."
  say ''
  say "  npm global bin:  ${bold}${bin_dir}${reset}"
  say "  Add it to your PATH, then restart your shell:"
  say "    ${dim}export PATH=\"${bin_dir}:\$PATH\"${reset}   # add to ~/.zshrc or ~/.bashrc"
  die "okra is not runnable yet — apply the PATH fix above."
fi

installed_version="$(okra --version 2>/dev/null || true)"
if [ -z "$installed_version" ]; then
  die "okra was installed but 'okra --version' did not run cleanly. Open a new shell and try: okra --version"
fi

say ''
printf '%s✓ okra %s installed%s\n' "$green" "$installed_version" "$reset"
say "Next: ${dim}export GEMINI_API_KEY=... && okra parse your.pdf${reset}   (free key: https://aistudio.google.com/apikey)"
