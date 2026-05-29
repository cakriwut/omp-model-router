#!/usr/bin/env bash
# Deploy workspace to ~/.omp/agent/extensions/model-router for local development
set -euo pipefail

WORKSPACE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXTENSION_DIR="$HOME/.omp/agent/extensions/model-router"
TARGET_PKG_DIR="$EXTENSION_DIR/node_modules/@cakriwut/omp-model-router"

echo "=== Deploying omp-model-router for local development ==="
echo "Workspace: $WORKSPACE_DIR"
echo "Extension: $EXTENSION_DIR"
echo

# Create extension directory structure
mkdir -p "$EXTENSION_DIR"

# Create wrapper package.json
cat > "$EXTENSION_DIR/package.json" <<EOF
{
  "name": "model-router-extension",
  "version": "1.0.0",
  "type": "module",
  "dependencies": {
    "@cakriwut/omp-model-router": "file:../../../../workspace/omp-model-router"
  }
}
EOF

# Create wrapper index.ts
cat > "$EXTENSION_DIR/index.ts" <<'EOF'
export { default } from "@cakriwut/omp-model-router";
EOF

# Create symlink to workspace
mkdir -p "$(dirname "$TARGET_PKG_DIR")"
rm -rf "$TARGET_PKG_DIR"
ln -s "$WORKSPACE_DIR" "$TARGET_PKG_DIR"

echo "✓ Symlinked workspace → extension node_modules"
echo "✓ Created wrapper package.json and index.ts"
echo
echo "Installed version:"
grep '"version"' "$TARGET_PKG_DIR/package.json" | head -1
echo
echo "🎯 Development deployment complete!"
echo
echo "Next steps:"
echo "  1. Run '/reload' in omp to pick up the changes"
echo "  2. Run '/router' to verify v$(grep -m1 '"version"' "$WORKSPACE_DIR/package.json" | cut -d'"' -f4) is active"
