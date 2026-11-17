#!/bin/sh
# Same entry point from a POSIX shell. py -3 is the interpreter on this
# machine; python is the fallback.
dir=$(dirname "$0")
if command -v py >/dev/null 2>&1; then
  exec py -3 "$dir/h9chain/h9chain.py" "$@"
fi
exec python "$dir/h9chain/h9chain.py" "$@"
