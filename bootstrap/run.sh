#!/usr/bin/env bash
# Builds the Prompt City repository in this checkout from the open MCP Market code (MIT) plus our changes:
# the rebrand scripts, a residual patch, and everything that can be regenerated (the Citizens collection,
# its archives, the cover, the $HEIST coin, the fonts). Run from the repo root by .github/workflows/bootstrap.yml.
set -euo pipefail
UPSTREAM=https://github.com/davidsyahshi/mcp-market.git
UPSTREAM_SHA=1bb66c9fc363da3d570a20809e6b690df1ce1d88
W=$(mktemp -d)
base64 -d bootstrap/payload.b64 > "$W/payload.tar.gz"
tar xzf "$W/payload.tar.gz" -C "$W"

git clone -q "$UPSTREAM" "$W/up"
git -C "$W/up" checkout -q "$UPSTREAM_SHA"
git -C "$W/up" archive HEAD | tar x -C .
rm -f collection/*.tar.gz collection/collection.json site/credit.svg
rm -rf site/covers

python3 "$W/rebrand.py" .
python3 "$W/rebrand2.py" .
git apply -p2 --whitespace=nowarn "$W/res.patch"

# the collection: same seed, same 5,555 Citizens
python3 collection/generator/citizens.py "$W/cz"
cp "$W/cz/collection.json" collection/collection.json
python3 collection/generator/pack.py "$W/cz" collection
(cd "$W" && sha256sum -c expected.sha256)   # collection.json must be the one previewed

mkdir -p site/covers
python3 "$W/cover.py" "$W/cz/images" site/covers/citizens.png
node "$W/assets.mjs"

# fonts (SIL Open Font License) from npm
mkdir -p "$W/fonts" site/fonts
( cd "$W/fonts" && for p in anton yellowtail space-grotesk jetbrains-mono; do
    npm pack "@fontsource/$p@5.3.0" --silent >/dev/null; mkdir "$p"; tar xzf fontsource-$p-5.3.0.tgz -C "$p"; done )
cp "$W/fonts/anton/package/files/anton-latin-400-normal.woff2" \
   "$W/fonts/yellowtail/package/files/yellowtail-latin-400-normal.woff2" \
   "$W"/fonts/space-grotesk/package/files/space-grotesk-latin-{400,500,700}-normal.woff2 \
   "$W"/fonts/jetbrains-mono/package/files/jetbrains-mono-latin-{400,700}-normal.woff2 site/fonts/
for p in anton yellowtail space-grotesk jetbrains-mono; do cp "$W/fonts/$p/package/LICENSE" "site/fonts/OFL-$p.txt"; done

rm -rf bootstrap
echo "Prompt City tree ready"
