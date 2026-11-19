#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname -s)/$(uname -m)" != Darwin/arm64 ]]; then echo 'Requires Apple Silicon macOS.' >&2; exit 1; fi
runtime="${AIB_NODE_PATH:-$(command -v node)}"
[[ "$("$runtime" -p 'process.versions.node.split(".")[0] + "/" + process.arch')" == 24/arm64 ]]
: "${AIB_NODE_LICENSE:?Point AIB_NODE_LICENSE at the matching Node distribution LICENSE}"
release="${AIB_RELEASE_DIR:-release}"
mkdir -p "$release"
temp="$(mktemp -d "$release/.stage-XXXXXXXX")"
trap 'rm -rf -- "$temp"' EXIT
app="$temp/AIB.app"
res="$app/Contents/Resources"
mkdir -p "$app/Contents/MacOS" "$res"
"$runtime" --import tsx scripts/stage-release.ts stage "$res"
cp apps/launcher/macos/Info.plist "$app/Contents/Info.plist"
cp assets/brand/aib.icns "$res/AIB.icns"
swiftc -target arm64-apple-macos13 -framework AppKit apps/launcher/macos/Launcher.swift -o "$app/Contents/MacOS/AIB"
cp "$runtime" "$res/node"
cp "$AIB_NODE_LICENSE" "$res/NODE-LICENSE.txt"
codesign --force --deep --sign - "$app"
codesign --verify --deep --strict "$app"
version="$("$runtime" -p 'require("./package.json").version')"
archive="aib-$version-macos-arm64.zip"
ditto -c -k --sequesterRsrc --keepParent "$app" "$temp/$archive"
mv -f "$temp/$archive" "$release/$archive"
if [[ ! -e "$release/AIB.app" ]]; then mv "$app" "$release/AIB.app"; fi
shasum -a 256 "$release/$archive"
