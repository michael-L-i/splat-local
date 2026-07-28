#!/usr/bin/env bash
# Assemble the GitHub Pages artifact into _site/.
#
# The demo site needs two things that live at the repo root because the app
# needs them too — the shared viewer engine and the vendored three/Spark builds.
# Copying them in at build time keeps one copy of each in git instead of two
# that quietly drift apart.
#
#   ./site/build.sh && python3 -m http.server -d _site 8080
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf _site
mkdir -p _site/vendor
cp -R site/. _site/
rm -f _site/build.sh
cp -R viewer _site/viewer
cp -R vendor/spark vendor/three _site/vendor/

echo "built _site/ ($(du -sh _site | cut -f1))"
