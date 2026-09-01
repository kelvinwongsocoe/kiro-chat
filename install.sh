#!/usr/bin/env bash
# Installs or upgrades Kiro Chat in VS Code. Run: bash install.sh
set -e
cd "$(dirname "$0")"

EXT_ID="local.kiro-chat"
VSIX="kiro-chat.vsix"

echo ""
echo "  Kiro Chat installer"
echo "  ==================="
echo ""

# Build from source when no packaged file is sitting here.
if [ ! -f "$VSIX" ]; then
  echo "  Building from source..."
  npm install --silent --no-audit --no-fund
  npm run compile
  npx --yes @vscode/vsce package --allow-missing-repository --out "$VSIX"
  echo ""
fi

if ! command -v code >/dev/null 2>&1; then
  echo "  The 'code' command is not available."
  echo ""
  echo "  Install by hand instead:"
  echo "    VS Code -> Extensions -> '...' menu -> Install from VSIX..."
  echo "    Pick: $(pwd)/$VSIX"
  echo ""
  echo "  Installing over an older version is safe. Settings are kept."
  exit 1
fi

OLD=$(code --list-extensions --show-versions 2>/dev/null | grep -i "^${EXT_ID}@" | cut -d@ -f2 || true)
if [ -n "$OLD" ]; then
  echo "  Found version $OLD already installed."
  echo "  Upgrading in place. Your settings are kept."
else
  echo "  No previous version found. Installing fresh."
fi
echo ""

code --install-extension "$VSIX" --force

NEW=$(code --list-extensions --show-versions 2>/dev/null | grep -i "^${EXT_ID}@" | cut -d@ -f2 || true)
echo ""
echo "  Installed version ${NEW:-unknown}."
echo ""
echo "  Close VS Code completely, open it again, then click the Kiro icon"
echo "  in the bar down the left side."
echo ""
echo "  Note: extensions installed this way do not update themselves."
echo "  To upgrade later, run this script again with a newer $VSIX."
echo ""
