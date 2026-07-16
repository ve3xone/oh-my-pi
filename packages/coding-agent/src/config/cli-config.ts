let cliConfigFiles: readonly string[] = [];

/** Replace overlays extracted from the current CLI invocation. */
export function setCliConfigFiles(files: readonly string[]): void {
	cliConfigFiles = [...files];
}

/** Return overlays extracted from the current CLI invocation. */
export function getCliConfigFiles(): readonly string[] {
	return cliConfigFiles;
}
