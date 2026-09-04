#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$ROOT/vendor/brush_browser_src"
REV=3b80985709e2ec04fd6c8622a40e36473647a8e0
PATCH="$ROOT/browser/brush-export.patch"

command -v wasm-pack >/dev/null || { echo 'Install Rust and wasm-pack first.' >&2; exit 1; }
if [[ ! -d "$SOURCE" ]]; then
  git clone --filter=blob:none --no-checkout https://github.com/ArthurBrussee/brush.git "$SOURCE"
  git -C "$SOURCE" checkout --detach "$REV"
fi
[[ "$(git -C "$SOURCE" rev-parse HEAD)" == "$REV" ]] || { echo 'Brush source revision differs; refusing to overwrite it.' >&2; exit 1; }
if git -C "$SOURCE" apply --check "$PATCH" 2>/dev/null; then
  git -C "$SOURCE" apply "$PATCH"
else
  git -C "$SOURCE" apply --reverse --check "$PATCH"
fi
cd "$SOURCE"
wasm-pack build apps/brush-js --release --target web --out-dir "$ROOT/browser/public/brush" --no-opt -- --locked
cp LICENSE "$ROOT/browser/public/brush/LICENSE"
