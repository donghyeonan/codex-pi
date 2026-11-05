/**
 * codex-canvas: install pi-canvas into the Codex CLI and manage its host.
 *
 *   codex-canvas install [--port 3000] [--no-skills|--no-design-skills]   add the MCP server + $canvas skill to Codex
 *   codex-canvas uninstall
 *   codex-canvas open [docId]       start the workspace (if needed) and open it in the browser
 *   codex-canvas status             host, daemon and install status
 *   codex-canvas stop               stop the workspace host
 *   codex-canvas host | mcp         run the host / MCP server in the foreground (used by Codex)
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canvasDir, codexHome, daemonSocket, DEFAULT_PORT, serverFile } from "./paths.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MCP = join(ROOT, "src", "codex", "mcp.ts");
const BEGIN = "# >>> pi-canvas (managed by `codex-canvas install`) >>>";
const END = "# <<< pi-canvas <<<";
const CANVAS_SKILL = join(ROOT, "codex", "skills", "canvas");
const DESIGN_SKILLS = join(ROOT, "skills");
const STAGESHOW_SKILL = join(ROOT, "vendor", "stageshow");
const MARK = ".pi-canvas-managed";

const configPath = () => join(codexHome(), "config.toml");
const skillsDir = () => join(codexHome(), "skills");
const q = (s: string) => JSON.stringify(s); // JSON strings are valid TOML basic strings

function stripBlock(toml: string) {
	const i = toml.indexOf(BEGIN);
	if (i < 0) return toml;
	const j = toml.indexOf(END, i);
	return (toml.slice(0, i) + (j < 0 ? "" : toml.slice(j + END.length))).replace(/\n{3,}/g, "\n\n");
}

function linkSkill(src: string, name: string) {
	const dest = join(skillsDir(), name);
	if (existsSync(dest) || isLink(dest)) {
		if (!existsSync(join(dest, MARK)) && !linksTo(dest, src)) return `skipped ${name} (a skill with that name already exists)`;
		rmSync(dest, { recursive: true, force: true });
	}
	mkdirSync(skillsDir(), { recursive: true });
	try {
		symlinkSync(src, dest, process.platform === "win32" ? "junction" : "dir");
	} catch {
		cpSync(src, dest, { recursive: true });
		writeFileSync(join(dest, MARK), "");
	}
	return `skill ${name}`;
}

function isLink(p: string) {
	try {
		return lstatSync(p).isSymbolicLink();
	} catch {
		return false;
	}
}

function linksTo(dest: string, src: string) {
	return isLink(dest) && resolve(dirname(dest), readlinkSync(dest)) === resolve(src);
}

function install(args: string[]) {
	const portArg = args.indexOf("--port");
	const port = portArg >= 0 ? Number(args[portArg + 1]) : undefined;
	if (portArg >= 0 && !(port && port > 0 && port < 65536)) throw new Error("--port needs a port number");
	mkdirSync(codexHome(), { recursive: true });
	const path = configPath();
	const before = existsSync(path) ? readFileSync(path, "utf8") : "";
	const rest = stripBlock(before);
	if (/^\s*\[mcp_servers\.canvas\]/m.test(rest)) throw new Error(`${path} already has an [mcp_servers.canvas] entry that codex-canvas does not manage; remove it first`);
	const env: Record<string, string> = {};
	if (process.env.CODEX_HOME) env.CODEX_HOME = codexHome();
	if (port) env.PI_CANVAS_PORT = String(port);
	const passThrough = ["PI_CANVAS_HOST", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "BROWSER", "PI_CANVAS_PORT", "PI_CANVAS_CHROME", "PI_CANVAS_NO_OPEN", "PI_CANVAS_CODEX_BIN", "SystemRoot", "LOCALAPPDATA", "APPDATA", "USERPROFILE"];
	const block = [
		BEGIN,
		"[mcp_servers.canvas]",
		`command = ${q(process.execPath)}`,
		`args = [${q(MCP)}]`,
		`env_vars = [${passThrough.filter((v) => !(v in env)).map(q).join(", ")}]`,
		...(Object.keys(env).length ? [`env = { ${Object.entries(env).map(([k, v]) => `${k} = ${q(v)}`).join(", ")} }`] : []),
		"startup_timeout_sec = 20",
		"tool_timeout_sec = 300",
		'default_tools_approval_mode = "approve"',
		END,
	].join("\n");
	writeFileSync(path, `${rest.replace(/\s*$/, "")}${rest.trim() ? "\n\n" : ""}${block}\n`);
	// inside the codex-pi kit the skills are copied into the project's .agents/skills instead
	const kitSkills = existsSync(join(ROOT, "..", ".agents", "skills", "canvas", "SKILL.md"));
	const done = [`MCP server "canvas" in ${path}`];
	if (kitSkills || args.includes("--no-skills")) done.push(kitSkills ? "skills: use the kit's .agents/skills (cp -R .agents into your project)" : "skills: skipped");
	else done.push(linkSkill(CANVAS_SKILL, "canvas"));
	if (!kitSkills && !args.includes("--no-skills") && !args.includes("--no-design-skills")) {
		if (existsSync(DESIGN_SKILLS)) for (const n of readdirSync(DESIGN_SKILLS)) if (existsSync(join(DESIGN_SKILLS, n, "SKILL.md"))) done.push(linkSkill(join(DESIGN_SKILLS, n), n));
		if (existsSync(join(STAGESHOW_SKILL, "SKILL.md"))) done.push(linkSkill(STAGESHOW_SKILL, "stageshow"));
	}
	console.log(`pi-canvas installed for Codex:\n  ${done.join("\n  ")}\n\nIn Codex, type $canvas (or ask for a report) — the workspace opens on http://127.0.0.1:${port ?? DEFAULT_PORT}.`);
}

function uninstall() {
	const path = configPath();
	if (existsSync(path)) writeFileSync(path, stripBlock(readFileSync(path, "utf8")).replace(/\s*$/, "\n"));
	const removed: string[] = [];
	const owned = [CANVAS_SKILL, STAGESHOW_SKILL, ...(existsSync(DESIGN_SKILLS) ? readdirSync(DESIGN_SKILLS).map((n) => join(DESIGN_SKILLS, n)) : [])];
	for (const src of owned) {
		const name = src.split(/[\\/]/).pop()!;
		const dest = join(skillsDir(), name);
		if (linksTo(dest, src) || existsSync(join(dest, MARK))) {
			rmSync(dest, { recursive: true, force: true });
			removed.push(name);
		}
	}
	console.log(`pi-canvas removed from Codex config${removed.length ? ` and skills (${removed.join(", ")})` : ""}. Documents stay in ${canvasDir()}.`);
}

async function hostCall(path: string, body: unknown) {
	const h = JSON.parse(readFileSync(serverFile(), "utf8"));
	const res = await fetch(`http://127.0.0.1:${h.port}/api/agent/${path}`, { method: "POST", headers: { "content-type": "application/json", "x-pi-canvas-token": h.token }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
	return res.json();
}

async function main() {
	const [cmd, ...args] = process.argv.slice(2);
	switch (cmd) {
		case "install":
			return install(args);
		case "uninstall":
			return uninstall();
		case "open": {
			const { ensureHost } = await import("./mcp.ts");
			await ensureHost();
			const r = await hostCall("tool", { name: "canvas_open", args: args[0] ? { docId: args[0] } : {}, cwd: process.cwd() });
			console.log(r.content?.[0]?.text ?? JSON.stringify(r));
			return;
		}
		case "stop":
			if (!existsSync(serverFile())) return console.log("pi-canvas host is not running");
			await hostCall("stop", {}).catch(() => {});
			return console.log("pi-canvas host stopped");
		case "status": {
			const installed = existsSync(configPath()) && readFileSync(configPath(), "utf8").includes(BEGIN);
			let host = "not running";
			if (existsSync(serverFile())) {
				try {
					const r = await hostCall("ping", {});
					const h = JSON.parse(readFileSync(serverFile(), "utf8"));
					host = `running (pid ${r.pid}) at ${h.url}${r.thread ? `, attached to thread ${r.thread}${r.live ? "" : " (offline)"}` : ""}`;
				} catch {
					host = "not running (stale server.json)";
				}
			}
			console.log(`CODEX_HOME   ${codexHome()}\ninstalled    ${installed ? "yes" : "no (run: codex-canvas install)"}\nhost         ${host}\ncodex daemon ${existsSync(daemonSocket()) ? daemonSocket() : "not running (the Codex TUI starts it)"}\ndocuments    ${canvasDir()}`);
			return;
		}
		case "host":
			await import("./host.ts");
			return;
		case "mcp": {
			const { main: mcp } = await import("./mcp.ts");
			return mcp();
		}
		default:
			console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0].replace(/^\/\*\*\n?/, "").replace(/^ \* ?/gm, ""));
			process.exitCode = cmd && cmd !== "help" && cmd !== "--help" ? 1 : 0;
	}
}

main().catch((err) => {
	console.error(`codex-canvas: ${(err as Error).message}`);
	process.exit(1);
});
