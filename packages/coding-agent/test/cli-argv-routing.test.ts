/**
 * Leading global option flags must not hide a subcommand from the CLI runner.
 *
 * #2970: `omp --approval-mode=yolo acp` was rewritten to
 * `launch --approval-mode=yolo acp`, swallowing `acp` as a launch prompt so the
 * yolo override never reached the ACP command path. The resolver now skips
 * leading global flags (using the launch parser's value-consumption contract)
 * and hoists the real subcommand to the front so its parser still applies the
 * flags.
 */
import { describe, expect, test } from "bun:test";
import { extractCliConfig, resolveCliArgv } from "@oh-my-pi/pi-coding-agent/cli-commands";

describe("resolveCliArgv routes subcommands hidden behind leading global flags", () => {
	test("`--approval-mode=yolo acp` dispatches the acp subcommand with the flag preserved", () => {
		expect(resolveCliArgv(["--approval-mode=yolo", "acp"])).toEqual({
			argv: ["acp", "--approval-mode=yolo"],
		});
	});

	test("space-form `--approval-mode yolo acp` keeps the flag and its value with acp", () => {
		expect(resolveCliArgv(["--approval-mode", "yolo", "acp"])).toEqual({
			argv: ["acp", "--approval-mode", "yolo"],
		});
	});

	test("multiple leading flags before the subcommand are all preserved", () => {
		expect(resolveCliArgv(["--approval-mode=yolo", "--model", "gpt", "acp"])).toEqual({
			argv: ["acp", "--approval-mode=yolo", "--model", "gpt"],
		});
	});

	test("a value-consuming flag does not mistake its value for a subcommand", () => {
		// `acp` here is the value of `--model`, not the subcommand, so this stays a
		// launch prompt exactly as the launch parser would read it.
		expect(resolveCliArgv(["--model", "acp"])).toEqual({
			argv: ["launch", "--model", "acp"],
		});
	});

	test("`--` ends option scanning so a following subcommand stays a launch prompt", () => {
		expect(resolveCliArgv(["--", "acp"])).toEqual({
			argv: ["launch", "--", "acp"],
		});
	});

	test("a genuine launch prompt is untouched", () => {
		expect(resolveCliArgv(["--approval-mode=yolo", "fix", "the", "bug"])).toEqual({
			argv: ["launch", "--approval-mode=yolo", "fix", "the", "bug"],
		});
	});

	test("a subcommand already in front still passes through unchanged", () => {
		expect(resolveCliArgv(["acp", "--approval-mode=yolo"])).toEqual({
			argv: ["acp", "--approval-mode=yolo"],
		});
	});

	test("`gc` dispatches as a top-level maintenance subcommand", () => {
		expect(resolveCliArgv(["gc", "--apply"])).toEqual({
			argv: ["gc", "--apply"],
		});
	});
});

/**
 * `extractCliConfig` runs on the output of `resolveCliArgv`, never on raw argv.
 * These guard the composed contract for implicit launches (argv[0] is a flag):
 * `resolveCliArgv` prepends `launch`, so `extractCliConfig` always sees a
 * command word at argv[0] and treats the invocation as launch-shaped. Reasoning
 * about `extractCliConfig` on flag-leading argv in isolation is misleading — the
 * pipeline never hands it that shape.
 */
describe("resolveCliArgv + extractCliConfig strip global --config for implicit launches", () => {
	function pipeline(argv: string[]): { argv: string[]; configFiles: string[] } {
		const resolved = resolveCliArgv(argv);
		if ("error" in resolved) throw new Error(resolved.error);
		return extractCliConfig(resolved.argv);
	}

	test("a leading --config is extracted, preserving repeated-overlay order", () => {
		// Later overlay files override earlier ones, so `b.yml` must stay last.
		expect(pipeline(["--config", "a.yml", "--config", "b.yml", "prompt"])).toEqual({
			argv: ["launch", "prompt"],
			configFiles: ["a.yml", "b.yml"],
		});
	});

	test("stripping --config between an optional-value flag and a positional keeps the boundary", () => {
		// Without the sentinel, `--resume` would swallow `msg` as its session id.
		expect(pipeline(["--resume", "--config", "x.yml", "msg"])).toEqual({
			argv: ["launch", "--resume", "--omp-profile-boundary", "msg"],
			configFiles: ["x.yml"],
		});
	});

	test("a lone leading --config extracts without leaving a stray value in argv", () => {
		expect(pipeline(["--config", "only.yml"])).toEqual({
			argv: ["launch"],
			configFiles: ["only.yml"],
		});
	});
});
