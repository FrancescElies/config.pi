# reflag

Local copy of [@piotr-oles/pi-reflag](https://github.com/piotr-oles/pi-extensions) (MIT):
rewrites `grep` to `rg` and `find` to `fd` before bash runs. Flags/ignore-mode options removed.

Setup: run `npm i` in this directory (installs `web-tree-sitter`; `node_modules` is gitignored).
Needs `rg` and `fd` on PATH.

`vendor/*.wasm` (bash grammar + parser runtime) is tracked in git, copied from the upstream package.
