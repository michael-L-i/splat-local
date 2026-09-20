#!/usr/bin/env bash
# Add GoatCounter page-view counting to every page of the assembled _site/.
#
# GoatCounter sets no cookies and stores no personal data; it records the page,
# the referrer and a ?ref= / ?utm_source= campaign tag, which is what tells one
# launch channel from another. Videos and splats are never sent anywhere.
#
# Injected at deploy time rather than committed, so forks and local builds
# don't report into this project's dashboard. No code set, no script tag.
#
#   GOATCOUNTER_CODE=splat-local ./site/analytics.sh    # <code>.goatcounter.com
set -euo pipefail
cd "$(dirname "$0")/.."

code="${GOATCOUNTER_CODE:-}"
if [ -z "$code" ]; then
  echo "GOATCOUNTER_CODE is not set; leaving _site/ without analytics"
  exit 0
fi
if ! [[ "$code" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "GOATCOUNTER_CODE must be a GoatCounter site code, e.g. splat-local" >&2
  exit 1
fi

tag="<script data-goatcounter=\"https://$code.goatcounter.com/count\" async src=\"https://gc.zgo.at/count.js\"></script>"
count=0
while IFS= read -r -d '' page; do
  TAG="$tag" perl -pi -e 's|</head>|$ENV{TAG}\n</head>|' "$page"
  count=$((count + 1))
done < <(find _site -name '*.html' -print0)

echo "added GoatCounter ($code) to $count pages"
