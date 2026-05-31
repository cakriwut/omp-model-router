# Local Testing Guide — omp-model-router

## Method 1: Install from npm (Production Test)

This tests the published package exactly as users will install it.

### Install

```bash
pi install npm:@cakriwut/omp-model-router
```

### Verify Installation

```bash
pi list | grep omp-model-router
# Should show:
#   npm:@cakriwut/omp-model-router
#     /home/user/.pi/agent/npm/node_modules/@cakriwut/omp-model-router
```

### Test in OMP

```bash
pi
# In the OMP session:
/router
/router help
/router usage
```

**Expected behavior:**
- `/router` shows current status
- `/router help` shows all commands
- Extension loads without errors

### Uninstall

```bash
pi remove npm:@cakriwut/omp-model-router
```

---

## Method 2: Dev Install (Development Test)

This tests local changes before publishing.

### Deploy to Extensions Directory

```bash
cd ~/workspace/omp-model-router
bun run deploy:dev
```

**What it does:**
1. Creates `~/.omp/agent/extensions/model-router/`
2. Creates wrapper `package.json` with `file:` dependency
3. Symlinks workspace to `node_modules/@cakriwut/omp-model-router`
4. Creates wrapper `index.ts` that re-exports the extension

### Verify Dev Install

```bash
ls -la ~/.omp/agent/extensions/model-router/
# Should show:
#   index.ts
#   package.json
#   node_modules/ -> symlink to workspace
```

### Test in OMP

```bash
pi
# In the OMP session:
/reload
/router
/router help
```

**Note:** Dev installs won't support `/router update` — this is expected and documented.

### Clean Up Dev Install

```bash
rm -rf ~/.omp/agent/extensions/model-router/
```

---

## Method 3: Direct Load (Quick Test)

Load extension directly without installation.

### Load via CLI Flag

```bash
pi --extension ~/workspace/omp-model-router
# Then use /router commands
```

### Load via Config

Edit `~/.omp/agent/config.yml`:

```yaml
extensions:
  - /home/user/workspace/omp-model-router
```

Then restart `pi`.

---

## Troubleshooting

### Extension Not Loading

**Check if extensions are enabled:**
```bash
pi --help | grep extension
```

**Check for load errors:**
```bash
pi --log-level debug 2>&1 | grep -i "model-router\|extension"
```

### `/router` Command Not Found

**Verify extension is loaded:**
```bash
pi list | grep model-router
```

**Check extensions directory:**
```bash
ls -la ~/.omp/agent/extensions/
ls -la ~/.pi/agent/npm/node_modules/@cakriwut/
```

### Dev Install Shows Update Error

This is **expected**. Dev installs (using `file:` dependencies) cannot use `/router update`. 

To enable updates, reinstall from npm:
```bash
rm -rf ~/.omp/agent/extensions/model-router/
pi install npm:@cakriwut/omp-model-router
```

---

## Version Verification

### Check Installed Version

**Via npm:**
```bash
npm list @cakriwut/omp-model-router
```

**Via package.json:**
```bash
cat ~/.pi/agent/npm/node_modules/@cakriwut/omp-model-router/package.json | grep version
```

**Via OMP:**
```bash
pi
# In session:
/router
# Status shows version in debug mode
```

### Check Latest Available Version

```bash
npm view @cakriwut/omp-model-router version
```

---

## Testing Checklist

After installation (npm or dev), verify these work:

- [ ] Extension loads without errors
- [ ] `/router` shows status
- [ ] `/router help` shows commands
- [ ] `/router usage` shows empty state
- [ ] `/router profile auto` switches profiles
- [ ] Router provider registered (model list includes `router/`)
- [ ] Config loads from `~/.omp/agent/model-router.json`

### Advanced Testing

- [ ] `/router pin high` forces high tier
- [ ] `/router set compression on` enables TOON
- [ ] `/router set budget 5.0` sets budget
- [ ] Session state persists across `/reload`
- [ ] History compression triggers work
- [ ] RTK integration works (if `rtk` binary installed)

---

## CI/CD Testing

### Pre-Release Checklist

```bash
cd ~/workspace/omp-model-router

# 1. Run tests
bun test

# 2. Deploy to dev
bun run deploy:dev

# 3. Test in OMP session
pi
# Use /router commands

# 4. Clean up dev install
rm -rf ~/.omp/agent/extensions/model-router/

# 5. Release
bun run release:patch  # or minor/major
```

### Post-Release Verification

```bash
# Wait ~30 seconds for npm to propagate

# 1. Install published version
pi install npm:@cakriwut/omp-model-router

# 2. Verify version
npm list @cakriwut/omp-model-router

# 3. Test in OMP
pi
# Use /router commands

# 4. Test update command
/router update
# Should say "already up to date"
```

---

## Common Issues

### "Invalid package name" Error

**Problem:** Typo in install command

**Solution:** Use correct syntax:
```bash
pi install npm:@cakriwut/omp-model-router
# NOT: omp install npm:...
# NOT: pi install @cakriwut/omp-model-router
```

### Extension Doesn't Load After Install

**Problem:** Extension not discovered by OMP

**Solution:**
1. Check installation: `pi list | grep omp-model-router`
2. Restart OMP: `/reload` or close and reopen
3. Check config: `~/.omp/agent/config.yml` for `disabledExtensions`

### `/router update` Fails

**Problem:** Dev install detected

**Solution:** See troubleshooting section in AGENTS.md or reinstall from npm.

---

## Development Workflow

Recommended workflow for active development:

1. **Edit code** in workspace
2. **Run tests**: `bun test`
3. **Deploy dev**: `bun run deploy:dev`
4. **Test in OMP**: `/reload` then `/router` commands
5. **Iterate** (repeat steps 1-4)
6. **Release** when ready: `bun run release:patch`
7. **Verify** published version works

**Tip:** Keep OMP session open and use `/reload` after each `deploy:dev` to pick up changes quickly.
