/** Memory settings presentation. Pi owns selection, scrolling, keyboard/mouse input,
 * and dialog lifetime. This adapter keeps the dialog open and rolls displayed
 * values back after a failed save; settings persistence remains in persistence.ts.
 */
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { getSelectListTheme, getSettingsListTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, Input, SelectList, SettingsList, Text, type SettingItem } from "@earendil-works/pi-tui";
import {
	formatJobModel, JOB_MODEL_SETTINGS, MEMORY_SWITCHES,
	type JobModelKey, type JobModelSelection, type MemoryConfig, type MemoryPaths, type MemorySwitches, type MemorySwitchKey,
} from "./config.js";
import { readDreamState } from "./dream.js";
import { indexPath, listMemories, readIndex } from "./store.js";

export interface MemoryPanelState {
	readonly switches: Readonly<MemorySwitches>;
	readonly paused: boolean;
	readonly paths: MemoryPaths;
	readonly models: Readonly<Pick<MemoryConfig, JobModelKey>>;
}

const ACTIONS = [
	{ id: "extract", label: "Extract memories now" },
	{ id: "dream", label: "Run Dream now" },
	{ id: "personal-folder", label: "Open memory folder" },
	{ id: "team-folder", label: "Open team memory folder" },
] as const;
/** Choosing a model closes the list for the picker; the command reopens the panel afterwards. */
type PanelAction = typeof ACTIONS[number]["id"] | `model:${JobModelKey}`;
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
		...(detail === "full" ? JOB_MODEL_SETTINGS.map((setting) => `${setting.label}: ${formatJobModel(state.models[setting.key])}`) : []),
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
		const models: SettingItem[] = JOB_MODEL_SETTINGS.map((setting) => ({
			id: setting.key, label: setting.label, description: setting.description,
			currentValue: formatJobModel(initial.models[setting.key]), values: ["change"],
		}));
		const items: SettingItem[] = [...switches, ...models, ...ACTIONS.map((action) => ({ ...action, currentValue: "run", values: ["run"] }))];
		const header = new Text("", 1, 1);
		const container = new Container();
		const refresh = () => {
			const state = controls.read();
			for (const setting of MEMORY_SWITCHES) list.updateValue(setting.key, state.switches[setting.key] ? "on" : "off");
			list.updateValue("paused", state.paused ? "on" : "off");
			for (const setting of JOB_MODEL_SETTINGS) list.updateValue(setting.key, formatJobModel(state.models[setting.key]));
			for (const item of items) {
				if (JOB_MODEL_SETTINGS.some((setting) => setting.key === item.id)) { item.values = pending ? undefined : ["change"]; continue; }
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
			const model = JOB_MODEL_SETTINGS.find((candidate) => candidate.key === id);
			if (model) { done(`model:${model.key}`); return; }
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

const SESSION_MODEL_CHOICE = "Use the session model";
const PROVIDER_DEFAULT_THINKING = "Provider default";
const MAX_VISIBLE_MODELS = 10;

function modelLabel(model: Model<Api>): string {
	return `${model.provider}/${model.id} (${model.name})`;
}

/**
 * Pick a job model with pi's search widgets, mirroring pi-codex-compaction's summary-model picker.
 * Null means the session model; undefined means the user cancelled without changing anything.
 */
export async function chooseJobModel(ctx: ExtensionContext, key: JobModelKey): Promise<JobModelSelection | null | undefined> {
	const label = JOB_MODEL_SETTINGS.find((setting) => setting.key === key)?.label ?? key;
	const models = [...ctx.modelRegistry.getAvailable()].sort((left, right) => modelLabel(left).localeCompare(modelLabel(right), "en"));
	const model = await ctx.ui.custom<Model<Api> | null | undefined>((tui, _theme, keys, done) => {
		const input = new Input();
		const container = new Container();
		let list: SelectList;
		const update = () => {
			const matches = fuzzyFilter([...models], input.getValue(), modelLabel);
			list = new SelectList([
				{ value: "session", label: SESSION_MODEL_CHOICE, description: "Follow the chat model and its provider defaults" },
				...matches.map((candidate, index) => ({ value: String(index), label: candidate.id, description: `${candidate.provider} · ${candidate.name}` })),
			], MAX_VISIBLE_MODELS, getSelectListTheme());
			list.onSelect = (item) => done(item.value === "session" ? null : matches[Number(item.value)]);
			list.onCancel = () => done(undefined);
			container.clear();
			container.addChild(new Text(`${label}: type to search authenticated models by provider, ID, or name`, 0, 0));
			container.addChild(input);
			container.addChild(list);
		};
		update();
		return {
			get focused() { return input.focused; },
			set focused(value: boolean) { input.focused = value; },
			render: (width) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput(data) {
				if ((["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"] as const).some((action) => keys.matches(data, action))) list.handleInput(data);
				else { input.handleInput(data); update(); }
				tui.requestRender();
			},
		};
	});
	if (model === null || model === undefined) return model;
	const levels = getSupportedThinkingLevels(model);
	const chosen = await ctx.ui.select(`Thinking level for ${model.provider}/${model.id}`, [PROVIDER_DEFAULT_THINKING, ...levels]);
	if (chosen === undefined) return undefined;
	const thinkingLevel = levels.find((level) => level === chosen);
	return { provider: model.provider, model: model.id, ...(thinkingLevel ? { thinkingLevel } : {}) };
}
