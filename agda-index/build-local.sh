#!/bin/sh
# build against local agda
set -e
AGDA_SRC=${1:-$HOME/devel/agda/agda}
GHC=${GHC:-ghc-9.12.2}
STORE=$HOME/.cabal/store/$($GHC --info | sed -n 's/.*"Project version","\([^"]*\)".*/ghc-\1/p')
STORE=$(ls -d "$STORE"* | head -1)
INPLACE="$AGDA_SRC/dist-newstyle/packagedb/$(basename "$STORE" | cut -d- -f1-2)"
DEPS=$(sed -n '/^depends:/,/^[a-z-]*:/p' "$INPLACE"/Agda-*-inplace.conf | grep -oE '(text|bytestring|containers|deepseq|sn|nrdrd-cntnrs)-[0-9.]+-[0-9a-f]+')
mkdir -p build
$GHC -O1 -package-env - -hide-all-packages -package-db "$STORE/package.db" -package-db "$INPLACE" \
  -package base -package-id Agda-2.9.0-inplace $(for d in $DEPS; do printf ' -package-id %s' "$d"; done) \
  -rtsopts "-with-rtsopts=-A64m" -outputdir build -o build/agda-index AgdaIndex.hs
