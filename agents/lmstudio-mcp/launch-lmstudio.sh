#!/usr/bin/env bash

echo ""
echo " Starting LM Studio API server..."
echo ""

# -------------------------------------------------------
# Preferred: lms CLI (headless, no GUI required)
# -------------------------------------------------------
if command -v lms &>/dev/null; then
    echo " Using lms CLI to start server on port 1234..."
    echo " (No GUI needed -- server runs in background)"
    echo ""
    lms server start --port 1234
    echo ""
    echo " Server started. Load a model with:"
    echo "   lms load <model-name>"
    echo " Or open LM Studio GUI to load one visually."
    exit 0
fi

# -------------------------------------------------------
# Fallback: launch LM Studio GUI
# -------------------------------------------------------
CANDIDATES=(
    "$HOME/.local/share/applications/lmstudio"
    "$HOME/Applications/LM Studio.AppImage"
    "/Applications/LM Studio.app"
    "/usr/local/bin/lmstudio"
)

FOUND=""
for p in "${CANDIDATES[@]}"; do
    if [ -e "$p" ]; then
        FOUND="$p"
        break
    fi
done

if [ -z "$FOUND" ]; then
    echo " [ERROR] LM Studio not found."
    echo ""
    echo " Run ./install.sh first to download and install it automatically."
    echo ""
    exit 1
fi

echo " Opening LM Studio GUI from: $FOUND"
echo " After it opens:"
echo "   1. Developer tab (left sidebar)"
echo "   2. Click 'Start Server'"
echo "   3. My Models tab -- load a model"
echo ""

if [[ "$FOUND" == *.AppImage ]]; then
    chmod +x "$FOUND"
    "$FOUND" &
elif [[ "$FOUND" == *.app ]]; then
    open "$FOUND"
else
    "$FOUND" &
fi
