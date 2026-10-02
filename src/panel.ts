/** Memory settings presentation. Pi owns selection, scrolling, keyboard/mouse input,
 * and dialog lifetime. This adapter keeps the dialog open and rolls displayed
 * values back after a failed save; settings persistence remains in persistence.ts.
 */
import { getSettingsListTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text, type SettingItem } from "@earendil-works/pi-tui";
import { MEMORY_SWITCHES, type MemoryPaths, type MemorySwitches, type MemorySwitchKey } from "./config.js";
import { readDreamState } from "./dream.js";
import { indexPath, listMemories, readIndex } from "./store.js";

export interface MemoryPanelState {
	readonly switches: Readonly<MemorySwitches>;
	readonly paused: boolean;
	readonly paths: MemoryPaths;
}

const ACTIONS = [
	{ id: "extract", label: "Extract memories now" },
	{ id: "dream", label: "Run Dream now" },
	{ id: "personal-folder", label: "Open memory folder" },
	{ id: "team-folder", label: "Open team memory folder" },
] as const;
type PanelAction = typeof ACTIONS[number]["id"];
const MAX_VISIBLE_SETTINGS = 12;

export function memoryPanelSummary(state: MemoryPanelState, detail: "full" | "compact" = "full"): string {
	const memories = listMemories(state.paths), index = readIndex(state.paths);
	let lastDream: string;
	try {
		const completed = readDreamState(state.paths).lastCompletedAt;
		lastDream = completed === null ? "never" : new Date(completed).toISOString();
	} catch (error) {
		lastDream = `unavailable (${error instanceof Error ? error.message : String(error)})`;
	}
	return [
		!state.switches.enabled ? "Memory is off. Feature preferences below are saved but inactive."
			: state.paused ? "This branch is paused. Memory resumes when you turn Pause off." : "Memory is active for this project.",
		...(detail === "full" ? [`Memory dir: ${state.paths.personalDir}`, ...(state.paths.teamDir ? [`Team dir: ${state.paths.teamDir}`] : []), `Index: ${index.lineCount} line(s) → ${indexPath(state.paths)}`] : []),
		`Memories: ${memories.length} file(s), ${memories.filter((memory) => memory.pinned).length} pinned`,
		`Last successful Dream: ${lastDream}`,
		...(detail === "full" ? MEMORY_SWITCHES.map((setting) => `${setting.label}: ${state.switches[setting.key] ? "on" : "off"}`) : []),
	].join("\n");
}

export async function showMemoryPanel(ctx: ExtensionContext, controls: {
	readonly read: () => MemoryPanelState;
	readonly change: (key: MemorySwitchKey | "paused", value: boolean) => Promise<void>;
}): Promise<PanelAction | undefined> {
	return ctx.ui.custom<PanelAction | undefined>((tui, _theme, _keybindings, done) => {
		let pending = false, closeRequested = false, disposed = false;
		const initial = controls.read();
		const switches: SettingItem[] = MEMORY_SWITCHES.map((setting) => ({
			id: setting.key, label: setting.label, description: setting.description,
			currentValue: initial.switches[setting.key] ? "on" : "off", values: ["on", "off"],
		}));
		switches.splice(1, 0, { id: "paused", label: "Pause this branch", description: "Temporary pause for this conversation branch. It does not change project settings.", currentValue: initial.paused ? "on" : "off", values: ["on", "off"] });
		const items: SettingItem[] = [...switches, ...ACTIONS.map((action) => ({ ...action, currentValue: "run", values: ["run"] }))];
		const header = new Text("", 1, 1);
		const container = new Container();
		const refresh = () => {
			const state = controls.read();
			for (const setting of MEMORY_SWITCHES) list.updateValue(setting.key, state.switches[setting.key] ? "on" : "off");
			list.updateValue("paused", state.paused ? "on" : "off");
			for (const item of items) {
				const action = ACTIONS.find((candidate) => candidate.id === item.id);
				const available = action?.id === "team-folder" ? state.paths.teamDir !== null
					: action?.id === "extract" || action?.id === "dream" ? state.switches.enabled && !state.paused : true;
				item.values = pending || !available ? undefined : action ? ["run"] : ["on", "off"];
				if (action) list.updateValue(item.id, available ? "run" : "unavailable");
			}
			header.setText(`${memoryPanelSummary(state, "compact")}\n\n${pending ? "Saving…" : "Switches save immediately. Esc closes this panel."}`);
		};
		const apply = async (key: MemorySwitchKey | "paused", value: boolean) => {
			pending = true;
			refresh();
			tui.requestRender();
			try { await controls.change(key, value); }
			catch (error) { ctx.ui.notify(`Memory setting was not changed: ${error instanceof Error ? error.message : String(error)}`, "warning"); }
			finally {
				pending = false;
				if (!disposed) {
					refresh();
					if (closeRequested) done(undefined);
					else tui.requestRender();
				}
			}
		};
		const list = new SettingsList(items, MAX_VISIBLE_SETTINGS, getSettingsListTheme(), (id, value) => {
			if (pending) return;
			const setting = MEMORY_SWITCHES.find((candidate) => candidate.key === id);
			if (setting || id === "paused") { void apply(setting?.key ?? "paused", value === "on"); return; }
			const action = ACTIONS.find((candidate) => candidate.id === id);
			if (action) done(action.id);
		}, () => {
			if (pending) closeRequested = true;
			else done(undefined);
		});
		container.addChild(header);
		container.addChild(list);
		refresh();
		return {
			render: (width) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data) => { list.handleInput(data); tui.requestRender(); },
			handleMouse: (event) => container.handleMouse(event),
			dispose: () => { disposed = true; },
		};
	});
}
