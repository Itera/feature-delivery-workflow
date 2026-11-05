#!/usr/bin/env bash
# Recreate the smoke-test fixture under <factory>/runs/fixture: a bare "origin", a clone, and a docs repo with the stories.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd -P); F=$(cd "$here/../.." && pwd -P)
R=$F/runs/fixture; rm -rf "${R:?}"; mkdir -p "$R"
git init -q --bare -b main "$R/origin.git"
git init -q -b main "$R/repo"; cp -R "$here/repo/." "$R/repo/"
git -C "$R/repo" -c user.name=fixture -c user.email=fixture@example.test add -A
git -C "$R/repo" -c user.name=fixture -c user.email=fixture@example.test commit -q -m "fixture: initial"
git -C "$R/repo" remote add origin "$R/origin.git"; git -C "$R/repo" push -q -u origin main
git init -q -b main "$R/docs"; mkdir -p "$R/docs/tasks"; cp "$here/stories/"*.md "$R/docs/tasks/"
git -C "$R/docs" -c user.name=fixture -c user.email=fixture@example.test add -A
git -C "$R/docs" -c user.name=fixture -c user.email=fixture@example.test commit -q -m "fixture stories"
echo "fixture ready in $R"
