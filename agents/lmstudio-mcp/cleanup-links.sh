#!/usr/bin/env bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LMS_MODELS="$HOME/.lmstudio/models"
LOCAL_MODELS="$SCRIPT_DIR/models"

echo "Removing LM Studio symlinks for local models..."

for pub in "$LOCAL_MODELS"/*/; do
    [ -d "$pub" ] || continue
    pub_name=$(basename "$pub")
    for mod in "$pub"*/; do
        [ -d "$mod" ] || continue
        mod_name=$(basename "$mod")
        dest="$LMS_MODELS/$pub_name/$mod_name"
        if [ -L "$dest" ]; then
            echo "Removing: $dest"
            rm "$dest"
        fi
    done
done

echo "Done."
