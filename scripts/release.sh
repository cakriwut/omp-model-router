#!/usr/bin/env bash
# Release omp-model-router: test gate → version bump → tag → push
# npm publish + GitHub release happen in CI (release.yml)
set -euo pipefail

WORKSPACE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$WORKSPACE_DIR"

BUMP_TYPE="${1:-}"

if [[ "$BUMP_TYPE" != "patch" && "$BUMP_TYPE" != "minor" && "$BUMP_TYPE" != "major" ]]; then
  echo "Usage: $0 <patch|minor|major>"
  exit 1
fi

echo "=== omp-model-router Release Script ==="
echo "Bump type: $BUMP_TYPE"
echo

# 1. Test gate
echo "▸ Running tests..."
if ! bun test; then
  echo "❌ Tests failed. Fix failures before releasing."
  exit 1
fi
echo "✓ All tests passed"
echo

# 2. Version bump
echo "▸ Bumping version ($BUMP_TYPE)..."
OLD_VERSION=$(grep -m1 '"version"' package.json | cut -d'"' -f4)
npm version "$BUMP_TYPE" --no-git-tag-version
NEW_VERSION=$(grep -m1 '"version"' package.json | cut -d'"' -f4)
echo "✓ Version: $OLD_VERSION → $NEW_VERSION"
echo

# 3. Commit and tag
echo "▸ Committing version bump..."
git add package.json
git commit -m "chore: bump version to $NEW_VERSION"
git tag "v$NEW_VERSION"
echo "✓ Tagged v$NEW_VERSION"
echo

# 4. Push to git (triggers release.yml which handles npm publish + GitHub release)
echo "▸ Pushing to git..."
git push && git push --tags
echo "✓ Pushed to remote"
echo

echo "🎉 Release v$NEW_VERSION initiated!"
echo
echo "CI will:"
echo "  • Run tests"
echo "  • Publish @cakriwut/omp-model-router@$NEW_VERSION to npm"
echo "  • Create GitHub release with auto-generated notes"
echo
echo "Monitor: https://github.com/cakriwut/omp-model-router/actions"
