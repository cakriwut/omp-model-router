# Tier Label Display Fix

## Problem

When running `/router usage`, tier labels for tiers with 0% usage were still displayed, resulting in output like:

```
████████████████████████████████████████████████ 12 decisions
 high 0%medium 0%                    low 100%
```

The labels `high 0%` and `medium 0%` were shown even though those tiers had zero width in the bar.

## Root Cause

In `src/ui.ts` `renderUsageReport()` function (lines 576-600), the label line construction logic:

1. Calculated percentage widths for each tier (high/medium/low)
2. Always rendered all three tier labels regardless of width
3. When a tier had 0% usage, its bar width would be 0, but the label text (e.g., `"high 0%"` = 7 chars) was still added
4. The centering math tried to fit a 7-character string into 0 pixels of space

## Solution

Modified the label line construction to conditionally render only labels for tiers with non-zero width:

**Before:**
```typescript
const highLabel = `high ${highPct}%`;
const medLabel = `medium ${medPct}%`;
const lowLabel = `low ${lowPct}%`;
const hlPad = Math.max(0, Math.floor((highWidth - highLabel.length) / 2));
// ... padding math for all three
labelLine = 
  " ".repeat(hlPad) + tierColor("high", highLabel) +
  " ".repeat(hlEnd) +
  " ".repeat(mlPad) + tierColor("medium", medLabel) +
  // ... (all three always rendered)
```

**After:**
```typescript
let labelParts: string[] = [];
if (highWidth > 0) {
  const highLabel = `high ${highPct}%`;
  const hlPad = Math.max(0, Math.floor((highWidth - highLabel.length) / 2));
  const hlEnd = Math.max(0, highWidth - hlPad - highLabel.length);
  labelParts.push(" ".repeat(hlPad) + tierColor("high", highLabel) + " ".repeat(hlEnd));
}
if (mediumWidth > 0) {
  const medLabel = `medium ${medPct}%`;
  // ... (only rendered if width > 0)
}
if (lowWidth > 0) {
  const lowLabel = `low ${lowPct}%`;
  // ... (only rendered if width > 0)
}
labelLine = labelParts.join("");
```

## Expected Output

After the fix, with 100% low tier usage:

```
████████████████████████████████████████████████ 12 decisions
                    low 100%
```

With mixed distribution (20% high, 30% medium, 50% low):

```
█████████████████████████████████████████████████ 10 decisions
  high 20%  medium 30%           low 50%
```

## Verification

Created comprehensive test coverage in `test/tier-label-display.test.ts`:

1. ✅ 100% low tier → only shows "low 100%"
2. ✅ 100% high tier → only shows "high 100%"
3. ✅ Mixed distribution → shows all three labels correctly positioned

All 326 existing tests continue to pass.

## Files Changed

- `src/ui.ts` (lines 570-600): Fixed label rendering logic
- `test/tier-label-display.test.ts`: New test coverage

## Deployment

```bash
bun run deploy:dev  # Deploy to ~/.omp/agent/extensions/model-router
# Then run /reload in OMP
# Verify with /router usage
```
