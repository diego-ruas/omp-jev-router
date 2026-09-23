#!/usr/bin/env bash
# Gate pré-commit / pré-release: tem que passar antes de subir release ou commit.
# Uso: ./scripts/check-release.sh  (ou: bun run check:release)
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== 1/3 bun test =="
bun test

echo "== 2/3 plugin build (transpile da extensão) =="
bun build --no-bundle extensions/jev-router.ts --outfile /tmp/jev-router-check.js > /dev/null

echo "== 3/3 secret scan (repo é público) =="
# Chaves reais nunca entram no repo: só padrões de valor, não nomes de variável.
if grep -rEn '(sk-(ant|or|proj)-[A-Za-z0-9_-]{8,}|xox[bap]-|ghp_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)' \
  --exclude-dir=node_modules --exclude-dir=.git --exclude='*.lockb' . ; then
  echo "FALHOU: possível segredo no repo. Remova antes do push." >&2
  exit 1
fi

echo "OK: gate passou (testes + build + secret scan)."
