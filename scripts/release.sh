#!/usr/bin/env bash
# Release omp-model-router: test gate → version bump → tag → publish
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

# 4. Publish to npm (using riwut/cakriwut token from Doppler)
echo "▸ Publishing to npm as cakriwut..."
if command -v doppler &>/dev/null; then
  # Try riwut token first (Automation token, no OTP), then cakriwut token
  PUBLISH_TOKEN=$(doppler secrets get NPM_TOKEN_RIWUT --project dev-console-personal --config dev --plain 2>/dev/null || \
                  doppler secrets get NPM_TOKEN_CAKRIWUT --project dev-console-personal --config dev --plain 2>/dev/null || \
                  echo "")
  if [ -n "$PUBLISH_TOKEN" ]; then
    echo "  Using npm token from Doppler"
    if ! NPM_TOKEN="$PUBLISH_TOKEN" npm publish; then
      echo "❌ npm publish failed"
      echo "To retry manually:"
      echo "  NPM_TOKEN=\$(doppler secrets get NPM_TOKEN_RIWUT --project dev-console-personal --config dev --plain) npm publish"
      echo "  git push && git push --tags"
      exit 1
    fi
  else
    echo "⚠️  No npm token found in Doppler, using current NPM_TOKEN"
    if ! npm publish; then
      echo "❌ npm publish failed"
      echo "To retry manually:"
      echo "  git push && git push --tags && npm publish"
      exit 1
    fi
  fi
else
  echo "⚠️  Doppler not found, using current NPM_TOKEN from environment"
  if ! npm publish; then
    echo "❌ npm publish failed"
    echo "To retry manually:"
      echo "  git push && git push --tags && npm publish"
    exit 1
  fi
fi
echo "✓ Published @cakriwut/omp-model-router@$NEW_VERSION to npm"
echo

# 5. Push to git
echo "▸ Pushing to git..."
git push && git push --tags
echo "✓ Pushed to remote"
echo

# 6. Create GitHub release
echo "▸ Creating GitHub release..."
if command -v gh &>/dev/null; then
  gh release create "v$NEW_VERSION" \
    --title "v$NEW_VERSION" \
    --generate-notes
  echo "✓ Created GitHub release v$NEW_VERSION"
else
  echo "⚠️  'gh' not found, skipping GitHub release creation"
  echo "   Create manually at: https://github.com/cakriwut/omp-model-router/releases/new?tag=v$NEW_VERSION"
fi
echo

echo "🎉 Release v$NEW_VERSION complete!"
echo
echo "Users can now install with:"
echo "  ~/.omp/agent/extensions/model-router/package.json:"
echo "    \"@cakriwut/omp-model-router\": \"^$NEW_VERSION\""
echo
echo "Then: cd ~/.omp/agent/extensions/model-router && npm install"
