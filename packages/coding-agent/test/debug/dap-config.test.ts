import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAdapterConfigs, resolveAdapter, selectLaunchAdapter } from "../../src/dap/config";
import { injectPluginDirRoots } from "../../src/discovery/helpers";

const tempDirs: string[] = [];
const ORIGINAL_OMP_PLUGIN_DIR = process.env.OMP_PLUGIN_DIR;
const ORIGINAL_OMP_MARKETPLACE_DIR = process.env.OMP_MARKETPLACE_DIR;
const ORIGINAL_PATH = process.env.PATH;

async function makeTempDir(prefix: string): Promise<string> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(cwd);
	return cwd;
}

async function writeExecutable(filePath: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n");
	await fs.chmod(filePath, 0o755);
}

afterEach(async () => {
	vi.restoreAllMocks();
	if (ORIGINAL_OMP_PLUGIN_DIR === undefined) {
		delete process.env.OMP_PLUGIN_DIR;
	} else {
		process.env.OMP_PLUGIN_DIR = ORIGINAL_OMP_PLUGIN_DIR;
	}
	if (ORIGINAL_OMP_MARKETPLACE_DIR === undefined) {
		delete process.env.OMP_MARKETPLACE_DIR;
	} else {
		process.env.OMP_MARKETPLACE_DIR = ORIGINAL_OMP_MARKETPLACE_DIR;
	}
	if (ORIGINAL_PATH === undefined) {
		delete process.env.PATH;
	} else {
		process.env.PATH = ORIGINAL_PATH;
	}
	await injectPluginDirRoots(os.homedir(), []);
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("DAP adapter configuration", () => {
	it("loads a custom adapter from dap.json and selects it by file extension", async () => {
		const cwd = await makeTempDir("omp-dap-config-json-");
		await fs.writeFile(path.join(cwd, "pom.xml"), "<project />\n");
		await fs.mkdir(path.join(cwd, "src"), { recursive: true });
		await fs.writeFile(path.join(cwd, "src", "Main.java"), "class Main {}\n");
		await fs.writeFile(
			path.join(cwd, "dap.json"),
			JSON.stringify({
				adapters: {
					"custom-jvm": {
						command: "bun",
						args: ["run", "debug-adapter"],
						languages: ["java", "kotlin"],
						fileTypes: [".java", ".kt"],
						rootMarkers: ["pom.xml", "build.gradle.kts"],
						launchDefaults: { request: "launch", mainClass: "" },
						attachDefaults: { request: "attach", host: "127.0.0.1" },
					},
				},
			}),
		);

		const adapter = resolveAdapter("custom-jvm", cwd);
		expect(adapter?.name).toBe("custom-jvm");
		expect(adapter?.command).toBe("bun");
		expect(adapter?.args).toEqual(["run", "debug-adapter"]);
		expect(adapter?.languages).toEqual(["java", "kotlin"]);
		expect(adapter?.fileTypes).toEqual([".java", ".kt"]);
		expect(adapter?.launchDefaults).toEqual({ request: "launch", mainClass: "" });
		expect(adapter?.attachDefaults).toEqual({ request: "attach", host: "127.0.0.1" });

		const selected = selectLaunchAdapter(path.join("src", "Main.java"), cwd);
		expect(selected?.name).toBe("custom-jvm");
	});

	it("merges partial user overrides over built-in adapters", async () => {
		const cwd = await makeTempDir("omp-dap-config-override-");
		await fs.writeFile(path.join(cwd, "script.py"), "print('hi')\n");
		await fs.writeFile(
			path.join(cwd, "dap.json"),
			JSON.stringify({
				adapters: {
					debugpy: {
						args: ["-m", "debugpy.adapter", "--log-dir", ".debugpy-logs"],
						launchDefaults: { justMyCode: false },
					},
				},
			}),
		);

		const config = getAdapterConfigs(cwd).debugpy;
		expect(config.command).toBe("python");
		expect(config.args).toEqual(["-m", "debugpy.adapter", "--log-dir", ".debugpy-logs"]);
		expect(config.fileTypes).toContain(".py");
		expect(config.launchDefaults).toMatchObject({ request: "launch", justMyCode: false });
	});

	it("loads adapter config from project config directories and YAML", async () => {
		const cwd = await makeTempDir("omp-dap-config-yaml-");
		await fs.mkdir(path.join(cwd, ".omp"), { recursive: true });
		await fs.writeFile(path.join(cwd, "build.gradle.kts"), "plugins {}\n");
		await fs.writeFile(path.join(cwd, "Main.kt"), "fun main() {}\n");
		await fs.writeFile(
			path.join(cwd, ".omp", "dap.yaml"),
			[
				"adapters:",
				"  yaml-kotlin:",
				"    command: bun",
				"    args:",
				"      - run",
				"      - kotlin-debug-adapter",
				"    languages:",
				"      - kotlin",
				"    fileTypes:",
				"      - .kt",
				"    rootMarkers:",
				"      - build.gradle.kts",
				"    launchDefaults:",
				"      request: launch",
				"      projectRoot: .",
				"",
			].join("\n"),
		);

		const selected = selectLaunchAdapter("Main.kt", cwd);
		expect(selected?.name).toBe("yaml-kotlin");
		expect(selected?.launchDefaults).toEqual({ request: "launch", projectRoot: "." });
	});

	it("resolves relative adapter commands from the debug cwd", async () => {
		const cwd = await makeTempDir("omp-dap-config-relative-command-");
		const command = path.join(cwd, "tools", process.platform === "win32" ? "debug-adapter.cmd" : "debug-adapter");
		await fs.mkdir(path.dirname(command), { recursive: true });
		await fs.writeFile(command, "");
		await fs.chmod(command, 0o755);
		await fs.writeFile(
			path.join(cwd, "dap.json"),
			JSON.stringify({
				adapters: {
					relative: {
						command: process.platform === "win32" ? ".\\tools\\debug-adapter.cmd" : "./tools/debug-adapter",
						fileTypes: [".rel"],
					},
				},
			}),
		);

		const adapter = resolveAdapter("relative", cwd);
		expect(adapter?.command).toBe(
			process.platform === "win32" ? ".\\tools\\debug-adapter.cmd" : "./tools/debug-adapter",
		);
		expect(adapter?.resolvedCommand).toBe(command);
	});

	it("loads plugin DAP adapters from plugin config files", async () => {
		const cwd = await makeTempDir("omp-dap-config-plugin-");
		const pluginRoot = path.join(cwd, "plugins", "acme-debug");
		await fs.mkdir(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
		await fs.writeFile(path.join(cwd, "app.rb"), "puts 'hi'\n");
		await fs.writeFile(
			path.join(pluginRoot, ".claude-plugin", "plugin.json"),
			JSON.stringify({ name: "acme-debug" }),
		);
		await fs.writeFile(
			path.join(pluginRoot, ".dap.json"),
			JSON.stringify({
				adapters: {
					"acme-ruby": {
						command: "ruby-debug-adapter",
						fileTypes: [".rb"],
					},
				},
			}),
		);
		process.env.OMP_PLUGIN_DIR = path.join(cwd, "plugins");
		process.env.OMP_MARKETPLACE_DIR = path.join(cwd, "marketplaces");
		await injectPluginDirRoots(cwd, [pluginRoot], cwd);

		expect(getAdapterConfigs(cwd)["acme-ruby"]?.command).toBe("ruby-debug-adapter");
	});

	it("ignores invalid custom adapters without discarding valid configs", async () => {
		const cwd = await makeTempDir("omp-dap-config-invalid-");
		await fs.writeFile(
			path.join(cwd, "dap.json"),
			JSON.stringify({
				adapters: {
					"missing-command": {
						fileTypes: [".bad"],
					},
					valid: {
						command: "bun",
						fileTypes: [".ok"],
						rootMarkers: ["."],
					},
				},
			}),
		);

		const config = getAdapterConfigs(cwd);
		expect(config["missing-command"]).toBeUndefined();
		expect(config.valid?.command).toBe("bun");
	});

	it("does not fall back to native adapters when dlv is the matching Go source adapter but unavailable", async () => {
		const cwd = await makeTempDir("omp-dap-go-dlv-missing-");
		const pathDir = path.join(cwd, "empty-path");
		process.env.PATH = pathDir;
		await fs.mkdir(pathDir);
		await fs.writeFile(path.join(cwd, "go.mod"), "module example.com/app\n\ngo 1.22\n");
		await fs.writeFile(path.join(cwd, "main.go"), "package main\n\nfunc main() {}\n");
		await writeExecutable(path.join(cwd, "bin", "gdb"));
		await writeExecutable(path.join(cwd, "bin", "lldb-dap"));
		await fs.writeFile(
			path.join(cwd, "dap.json"),
			JSON.stringify({
				adapters: {
					dlv: { command: "./bin/missing-dlv" },
					gdb: { command: "./bin/gdb" },
					"lldb-dap": { command: "./bin/lldb-dap" },
				},
			}),
		);

		const selected = selectLaunchAdapter(path.join(cwd, "main.go"), cwd);

		expect(selected).toBeNull();
	});

	it("resolves default dlv from a nested Go module bin when launched from the repo root", async () => {
		const cwd = await makeTempDir("omp-dap-go-nested-");
		const moduleRoot = path.join(cwd, "services", "api");
		const program = path.join(moduleRoot, "cmd", "api");
		const pathDir = path.join(cwd, "empty-path");
		process.env.PATH = pathDir;
		await fs.mkdir(pathDir);
		await fs.writeFile(path.join(cwd, "Makefile"), "all:\n\tgo build ./...\n");
		await fs.mkdir(program, { recursive: true });
		await fs.writeFile(path.join(moduleRoot, "go.mod"), "module example.com/api\n\ngo 1.22\n");
		await writeExecutable(path.join(cwd, "bin", "dlv"));
		await writeExecutable(path.join(moduleRoot, "bin", "dlv"));

		const selected = selectLaunchAdapter(program, cwd, undefined, "directory");

		expect(selected?.name).toBe("dlv");
		expect(selected?.command).toBe("dlv");
		expect(selected?.resolvedCommand).toBe(path.join(moduleRoot, "bin", "dlv"));
	});

	it("falls back to the session cwd bin/dlv when a nested Go module has no local dlv", async () => {
		const cwd = await makeTempDir("omp-dap-go-nested-cwd-dlv-");
		const moduleRoot = path.join(cwd, "services", "api");
		const program = path.join(moduleRoot, "main.go");
		process.env.PATH = "";
		await fs.writeFile(path.join(cwd, "go.mod"), "module example.com/repo\n\ngo 1.22\n");
		await fs.mkdir(moduleRoot, { recursive: true });
		await fs.writeFile(path.join(moduleRoot, "go.mod"), "module example.com/api\n\ngo 1.22\n");
		await fs.writeFile(program, "package main\n\nfunc main() {}\n");
		await writeExecutable(path.join(cwd, "bin", "dlv"));

		const selected = selectLaunchAdapter(program, cwd, undefined, "file");

		expect(selected?.name).toBe("dlv");
		expect(selected?.command).toBe("dlv");
		expect(selected?.resolvedCommand).toBe(path.join(cwd, "bin", "dlv"));
	});

	it("selects dlv for Go workspace directories rooted by go.work", async () => {
		const cwd = await makeTempDir("omp-dap-go-work-");
		const program = path.join(cwd, "cmd", "worker");
		const pathDir = path.join(cwd, "empty-path");
		process.env.PATH = pathDir;
		await fs.mkdir(pathDir);
		await fs.writeFile(path.join(cwd, "go.work"), "go 1.22\n\nuse ./cmd/worker\n");
		await fs.mkdir(program, { recursive: true });
		await writeExecutable(path.join(cwd, "bin", "dlv"));

		const selected = selectLaunchAdapter(program, cwd, undefined, "directory");

		expect(selected?.resolvedCommand).toBe(path.join(cwd, "bin", "dlv"));
	});

	it("re-resolves dlv after an earlier PATH lookup missed it", async () => {
		const cwd = await makeTempDir("omp-dap-go-dlv-cache-");
		const pathDir = path.join(cwd, "path-bin");
		const program = path.join(cwd, "main.go");
		await fs.mkdir(pathDir);
		process.env.PATH = pathDir;
		await fs.writeFile(path.join(cwd, "go.mod"), "module example.com/cache\n\ngo 1.22\n");
		await fs.writeFile(program, "package main\n\nfunc main() {}\n");

		expect(selectLaunchAdapter(program, cwd)).toBeNull();

		await writeExecutable(path.join(pathDir, "dlv"));
		const selected = selectLaunchAdapter(program, cwd);

		expect(selected?.name).toBe("dlv");
		expect(selected?.resolvedCommand).toBe(path.join(pathDir, "dlv"));
	});
});
