/**
 * Detects whether the extension is running under 'omp' or 'pi' CLI.
 * Returns the binary name to use for plugin management commands.
 */
export function detectCLI(): 'omp' | 'pi' {
	// Check process.argv[0] or Bun.argv[0] for the invoking binary
	const argv0 = process.argv[0] || Bun.argv[0] || '';
	
	// Check if 'omp' appears in the binary path
	if (argv0.includes('omp')) {
		return 'omp';
	}
	
	// Check if 'pi' appears (but not 'omp' which contains 'p' and 'i')
	if (argv0.includes('/pi') || argv0.includes('\pi') || argv0.endsWith('pi')) {
		return 'pi';
	}
	
	// Fallback: try to detect from process.execPath
	const execPath = process.execPath || '';
	if (execPath.includes('omp')) {
		return 'omp';
	}
	
	// Default to 'omp' as it's the newer/maintained fork
	return 'omp';
}
