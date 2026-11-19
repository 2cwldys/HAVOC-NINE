#!/usr/bin/env bash

GRN='\033[0;32m'
YLW='\033[1;33m'
CYN='\033[0;36m'
RED='\033[0;31m'
WHT='\033[1;37m'
RST='\033[0m'

pause() {
    echo ""
    read -rp " Press Enter to close... " -n1 _ 2>/dev/null || true
    echo ""
}

echo ""
echo -e "${CYN} =================================================${RST}"
echo -e "${CYN}   LM Studio  >>  Purge Downloaded Models${RST}"
echo -e "${CYN} =================================================${RST}"
echo ""

MODELS_DIR="$HOME/.lmstudio/models"

if [ ! -d "$MODELS_DIR" ]; then
    echo -e "${YLW}  --    No models directory found at:${RST}"
    echo "        $MODELS_DIR"
    echo ""
    echo "        Nothing to purge."
    pause
    exit 0
fi

# Check if any subdirectories exist
HAS_MODELS=0
for d in "$MODELS_DIR"/*/; do
    [ -d "$d" ] && HAS_MODELS=1 && break
done

if [ "$HAS_MODELS" -eq 0 ]; then
    echo -e "${YLW}  --    Models directory is empty -- nothing to purge.${RST}"
    pause
    exit 0
fi

# Show what's downloaded
echo -e "${WHT} Downloaded models:${RST}"
echo ""
if command -v lms &>/dev/null; then
    lms ls 2>/dev/null || ls "$MODELS_DIR"
else
    ls "$MODELS_DIR"
fi
echo ""

echo -e "${RED}  WARNING: This permanently removes all downloaded model files.${RST}"
echo -e "${WHT}  Open LM Studio > Discover tab to re-download models afterwards.${RST}"
echo ""

read -rp " Are you sure? (Y/N): " CONFIRM
CONFIRM_LOWER=$(echo "$CONFIRM" | tr '[:upper:]' '[:lower:]')
if [ "$CONFIRM_LOWER" != "y" ]; then
    echo ""
    echo -e "${YLW}  --    Cancelled. Nothing deleted.${RST}"
    pause
    exit 0
fi
echo ""

# Unload all models first so files aren't locked
if command -v lms &>/dev/null; then
    echo -e "${WHT} Unloading all models...${RST}"
    lms unload --all 2>/dev/null || true
    echo -e "${GRN}  OK${RST}     Models unloaded"
    echo ""
fi

# Delete all publisher subdirectories
echo -e "${WHT} Deleting model files from:${RST}"
echo "        $MODELS_DIR"
echo ""

DELETED=0
for d in "$MODELS_DIR"/*/; do
    if [ -d "$d" ]; then
        name=$(basename "$d")
        echo -e "${YLW}  ..${RST}     Deleting $name..."
        if rm -rf "$d"; then
            echo -e "${GRN}  OK${RST}     Deleted"
        else
            echo -e "${RED}  !!${RST}     Could not delete $name -- try: sudo $0"
        fi
        DELETED=1
    fi
done

if [ "$DELETED" -eq 0 ]; then
    echo -e "${YLW}  --    No model directories found.${RST}"
fi

# Also purge publisher subdirs inside the local models dir (keep the folder itself)
LOCAL_MDIR="$(dirname "$0")/models"
if [ -d "$LOCAL_MDIR" ]; then
    echo ""
    echo -e "${WHT} Purging local models dir:${RST}"
    echo "        $LOCAL_MDIR"
    echo ""
    LOCAL_DELETED=0
    for d in "$LOCAL_MDIR"/*/; do
        if [ -d "$d" ]; then
            name=$(basename "$d")
            echo -e "${YLW}  ..${RST}     Deleting $name..."
            if rm -rf "$d"; then
                echo -e "${GRN}  OK${RST}     Deleted"
                LOCAL_DELETED=1
            else
                echo -e "${RED}  !!${RST}     Could not delete $name -- try: sudo $0"
            fi
        fi
    done
    if [ "$LOCAL_DELETED" -eq 0 ]; then
        echo -e "${YLW}  --    Local models folder is already empty.${RST}"
    fi
fi

echo ""
echo -e "${GRN}  OK${RST}     Done. All model files removed."
echo ""
echo -e "${CYN} =================================================${RST}"
echo -e "${WHT}  To get a new model:${RST}"
echo -e "${WHT}    1. Open LM Studio${RST}"
echo -e "${WHT}    2. Click the Discover tab (magnifying glass)${RST}"
echo -e "${WHT}    3. Search and download a model${RST}"
echo -e "${WHT}    4. Run:  npm run setup${RST}"
echo -e "${CYN} =================================================${RST}"
pause
