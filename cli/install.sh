#!/usr/bin/env bash
set -e

echo "Installing shrc companion CLI..."

# Check if node is available
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is required to run the shrc companion CLI."
    exit 1
fi

INSTALL_DIR="$HOME/.local/bin"
mkdir -p "$INSTALL_DIR"

chmod +x "$(dirname "$0")/shrc.js" || true
cp "$(dirname "$0")/shrc.js" "$INSTALL_DIR/shrc"
chmod +x "$INSTALL_DIR/shrc"

echo "shrc CLI installed successfully to $INSTALL_DIR/shrc!"
echo "Make sure $INSTALL_DIR is in your PATH."
