#!/usr/bin/env bash
# Install ClearSTT GNOME Shell extension
set -e

EXT_DIR="$HOME/.local/share/gnome-shell/extensions/clearstt@m-a-d.solutions"
SRC="$(pwd)/dist/clearstt@m-a-d.solutions"

# Compile schemas
echo "Compiling GSettings schemas..."
glib-compile-schemas "$SRC/schemas/"

# Remove old symlink/directory
if [ -L "$EXT_DIR" ] || [ -d "$EXT_DIR" ]; then
    echo "Removing existing extension..."
    rm -rf "$EXT_DIR"
fi

# Create fresh install
echo "Installing extension to $EXT_DIR"
ln -s "$SRC" "$EXT_DIR"

echo ""
echo "Extension installed!"
echo "Restart GNOME Shell to apply:"
echo "  • Wayland: log out and log back in"
echo "  • X11: Alt+F2 → r → Enter"
echo ""
echo "Then enable via: gnome-extensions enable clearstt@m-a-d.solutions"
echo "Or use: gnome-extensions-app"
