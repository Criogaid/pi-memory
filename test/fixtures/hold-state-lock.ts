/** Exercise state ownership from a separate process; release on IPC or timeout. */
import { withStateLock } from "../../src/persistence.ts";

const file = process.argv[2];
if (!file || !process.send) throw new Error("Expected a state path and IPC channel");
const releaseDeadlineMs = 10_000;
const result = await withStateLock(file, undefined, async () => {
	await new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, releaseDeadlineMs);
		process.once("message", () => { clearTimeout(timer); resolve(); });
		process.send?.({ ready: true });
	});
});
if (result.kind !== "done") throw new Error("Fixture could not acquire the state lock");
process.disconnect();
