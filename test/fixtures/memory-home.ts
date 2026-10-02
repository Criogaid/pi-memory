import * as fs from "node:fs";
import os from "node:os";
import * as path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";

/** Redirect both ESM and Jiti OS imports; PI_MEMORY_DIR alone does not isolate global config reads. */
export function isolateMemoryHome(root: string) {
	const home = path.join(root, "home");
	const globalConfigFile = path.join(home, ".pi", "agent", "memory", "config.json");
	fs.mkdirSync(path.dirname(globalConfigFile), { recursive: true });
	const homedir = mock.method(os, "homedir", () => home);
	syncBuiltinESMExports();
	return {
		globalConfigFile,
		restore: () => { homedir.mock.restore(); syncBuiltinESMExports(); },
	};
}
