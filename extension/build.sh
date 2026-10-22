#!/usr/bin/env bash
# Build without bun — a plain Node (>=20) alternative to build.ts.
# Produces dist/clearstt@m-a-d.solutions/ with the same layout as build.ts.
set -euo pipefail

cd "$(dirname "$0")"

BUNDLE="dist/clearstt@m-a-d.solutions"
DOMAIN_MO="clearstt.mo"

rm -rf dist

echo "Compiling TypeScript..."
./node_modules/.bin/tsc --project tsconfig.json --outDir "$BUNDLE"

for f in extension.js prefs.js; do
  [[ -f "$BUNDLE/$f" ]] || { echo "ERROR: $f not produced" >&2; exit 1; }
  echo "  ok $f"
done

echo "Copying static files..."
cp metadata.json stylesheet.css "$BUNDLE/"
mkdir -p "$BUNDLE/schemas" "$BUNDLE/resources"
cp schemas/org.gnome.shell.extensions.clearstt.gschema.xml "$BUNDLE/schemas/"
cp resources/start.mp3 resources/stop.mp3 "$BUNDLE/resources/"

if command -v msgfmt >/dev/null; then
  echo "Compiling translations..."
  for po in locale/*/LC_MESSAGES/*.po; do
    [[ -e "$po" ]] || continue
    lang="$(basename "$(dirname "$(dirname "$po")")")"
    mkdir -p "$BUNDLE/locale/$lang/LC_MESSAGES"
    msgfmt "$po" -o "$BUNDLE/locale/$lang/LC_MESSAGES/$DOMAIN_MO"
  done
else
  echo "NOTE: msgfmt missing (apt install gettext) — UI stays in English."
fi

echo "Compiling GSettings schemas..."
glib-compile-schemas "$BUNDLE/schemas"

echo
echo "Done: $BUNDLE"
