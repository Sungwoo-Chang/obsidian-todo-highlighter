import {
	App,
	ButtonComponent,
	ItemView,
	MarkdownView,
	Plugin,
	PluginSettingTab,
	Setting,
	setIcon,
	WorkspaceLeaf,
} from 'obsidian';
import {
	Decoration,
	DecorationSet,
	EditorView,
	ViewPlugin,
	ViewUpdate,
} from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';

// ─── Types & Constants ────────────────────────────────────────────────────────

type Priority = 'high' | 'normal' | 'low';

const PRIORITY_REGEXES: Record<Priority, RegExp> = {
	high:   /<!--\s*TODO:HIGH(.*?)-->/i,
	normal: /<!--\s*TODO(?!:HIGH|:LOW)(.*?)-->/i,
	low:    /<!--\s*TODO:LOW(.*?)-->/i,
};

const CSS_VARS: Record<Priority, string> = {
	high:   '--todo-color-high',
	normal: '--todo-color-normal',
	low:    '--todo-color-low',
};

const PRIORITY_ENABLED_KEY: Record<Priority, keyof TodoPluginSettings> = {
	high:   'highlightHighEnabled',
	normal: 'highlightNormalEnabled',
	low:    'highlightLowEnabled',
};

const SIDEBAR_VIEW_TYPE = 'todo-highlighter-sidebar';

const DEFAULTS = {
	highColorHex:           '#e53935',
	highOpacity:            0.25,
	colorHex:               '#ff8c00',
	opacity:                0.2,
	lowColorHex:            '#fdd835',
	lowOpacity:             0.25,
	shortcut:               'Ctrl+Shift+T',
	highlightEnabled:       true,
	highlightHighEnabled:   true,
	highlightNormalEnabled: true,
	highlightLowEnabled:    true,
};

// ─── Settings ─────────────────────────────────────────────────────────────────

interface TodoPluginSettings {
	highColorHex: string;
	highOpacity: number;
	colorHex: string;
	opacity: number;
	lowColorHex: string;
	lowOpacity: number;
	shortcut: string;
	highlightEnabled: boolean;
	highlightHighEnabled: boolean;
	highlightNormalEnabled: boolean;
	highlightLowEnabled: boolean;
}

const DEFAULT_SETTINGS: TodoPluginSettings = { ...DEFAULTS };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hexToRgba(hex: string, opacity: number): string {
	const h = hex.replace('#', '');
	const r = parseInt(h.slice(0, 2), 16);
	const g = parseInt(h.slice(2, 4), 16);
	const b = parseInt(h.slice(4, 6), 16);
	return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

function matchesShortcut(e: KeyboardEvent, shortcut: string): boolean {
	const parts = shortcut.split('+');
	const targetKey = parts[parts.length - 1].toUpperCase();
	const modifiersMatch =
		e.ctrlKey === parts.includes('Ctrl') &&
		e.shiftKey === parts.includes('Shift') &&
		e.altKey  === parts.includes('Alt') &&
		e.metaKey === (parts.includes('Meta') || parts.includes('Cmd'));
	if (!modifiersMatch) return false;
	const codeKey = e.code.startsWith('Key') ? e.code.slice(3) : e.code;
	return e.key.toUpperCase() === targetKey || codeKey.toUpperCase() === targetKey;
}

// ─── Todo Extraction ──────────────────────────────────────────────────────────

interface TodoItem {
	lineNum: number;
	message: string;
	priority: Priority;
}

function extractTodos(content: string): TodoItem[] {
	const items: TodoItem[] = [];
	const order: Priority[] = ['high', 'normal', 'low'];
	content.split('\n').forEach((line, index) => {
		for (const priority of order) {
			const match = PRIORITY_REGEXES[priority].exec(line);
			if (match) {
				items.push({ lineNum: index + 1, message: match[1].trim(), priority });
				break;
			}
		}
	});
	return items;
}

// ─── Sidebar View ─────────────────────────────────────────────────────────────

const SECTION_META: { key: Priority; dot: string; label: string }[] = [
	{ key: 'high',   dot: '🔴', label: 'HIGH' },
	{ key: 'normal', dot: '🟠', label: 'TODO' },
	{ key: 'low',    dot: '🟡', label: 'LOW'  },
];

class TodoSidebarView extends ItemView {
	plugin: TodoHighlighterPlugin;
	private refreshTimer: number | null = null;
	private collapsedSections: Set<Priority> = new Set();

	constructor(leaf: WorkspaceLeaf, plugin: TodoHighlighterPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType()    { return SIDEBAR_VIEW_TYPE; }
	getDisplayText() { return 'TODO 목록'; }
	getIcon()        { return 'list-todo'; }

	async onOpen() {
		// Obsidian은 mousemove 기준으로 hoverLeaf를 갱신하므로,
		// mouseenter 후 멈춘 상태에서는 wheel 이벤트가 이전 leaf로 라우팅됨.
		// wheel을 직접 가로채 stopPropagation으로 Obsidian 라우팅을 우회한다.
		const scrollEl = this.containerEl.children[1] as HTMLElement;
		this.registerDomEvent(this.containerEl, 'wheel', (e: WheelEvent) => {
			e.stopPropagation();
			scrollEl.scrollTop += e.deltaY;
		}, { passive: true });

		this.refresh();
	}
	async onClose() {}

	scheduleRefresh() {
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		this.refreshTimer = window.setTimeout(() => {
			this.refresh();
			this.refreshTimer = null;
		}, 400);
	}

	async refresh() {
		const root = this.containerEl.children[1] as HTMLElement;
		root.empty();
		root.addClass('todo-sidebar-root');

		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			root.createEl('p', { text: '열린 파일이 없습니다.', cls: 'todo-sidebar-empty' });
			return;
		}

		let content: string;
		try {
			content = await this.app.vault.read(activeFile);
		} catch {
			root.createEl('p', { text: '파일을 읽을 수 없습니다.', cls: 'todo-sidebar-empty' });
			return;
		}

		const todos = extractTodos(content);

		// ─ Header (파일명 + 전체 개수 + 마스터 토글)
		const header = root.createDiv({ cls: 'todo-sidebar-header' });
		header.createSpan({ text: activeFile.basename, cls: 'todo-sidebar-filename' });
		header.createSpan({
			text: `${todos.length}개`,
			cls: 'todo-sidebar-badge' + (todos.length === 0 ? ' todo-sidebar-badge-zero' : ''),
		});

		const masterBtn = header.createEl('button', { cls: 'todo-toggle-btn clickable-icon' });
		const masterOn = this.plugin.settings.highlightEnabled;
		setIcon(masterBtn, masterOn ? 'eye' : 'eye-off');
		masterBtn.setAttribute('aria-label', masterOn ? '하이라이트 모두 끄기' : '하이라이트 모두 켜기');
		masterBtn.addEventListener('click', async () => { await this.plugin.toggleHighlight(); });

		if (todos.length === 0) {
			root.createEl('p', { text: 'TODO 주석이 없습니다.', cls: 'todo-sidebar-empty' });
			return;
		}

		// ─ 우선순위별 섹션
		SECTION_META.forEach(({ key, dot, label }) => {
			const items = todos.filter(t => t.priority === key);
			if (items.length === 0) return;

			const isCollapsed  = this.collapsedSections.has(key);
			const isPriorityOn = this.plugin.settings[PRIORITY_ENABLED_KEY[key]] as boolean;

			const section       = root.createDiv({ cls: 'todo-section' });
			const sectionHeader = section.createDiv({ cls: 'todo-section-header' });

			// 접기/펼치기 화살표
			const chevron = sectionHeader.createSpan({ cls: 'todo-section-chevron' });
			setIcon(chevron, isCollapsed ? 'chevron-right' : 'chevron-down');

			sectionHeader.createSpan({ text: `${dot} ${label}`, cls: 'todo-section-label' });
			sectionHeader.createSpan({
				text: `${items.length}`,
				cls: `todo-section-count todo-section-count-${key}`,
			});

			// 우선순위별 하이라이트 토글
			const eyeBtn = sectionHeader.createEl('button', { cls: 'todo-toggle-btn clickable-icon' });
			setIcon(eyeBtn, isPriorityOn ? 'eye' : 'eye-off');
			eyeBtn.setAttribute('aria-label', `${label} 하이라이트 ${isPriorityOn ? '끄기' : '켜기'}`);
			eyeBtn.addEventListener('click', async (e) => {
				e.stopPropagation();
				await this.plugin.toggleHighlightForPriority(key);
			});

			// 항목 목록
			const itemsList = section.createDiv({ cls: 'todo-section-items' });
			if (isCollapsed) itemsList.style.display = 'none';

			items.forEach(todo => {
				const item = itemsList.createDiv({ cls: 'todo-sidebar-item' });
				item.createSpan({ text: `L${todo.lineNum}`, cls: 'todo-sidebar-line-badge' });
				item.createSpan({
					text: todo.message || '(내용 없음)',
					cls: 'todo-sidebar-message' + (!todo.message ? ' todo-sidebar-message-empty' : ''),
				});

				item.addEventListener('click', () => {
					const af = this.app.workspace.getActiveFile();
					if (!af) return;
					const targetLeaf = this.app.workspace.getLeavesOfType('markdown').find(
						l => (l.view as MarkdownView).file?.path === af.path
					);
					if (!targetLeaf) return;
					const mdView = targetLeaf.view as MarkdownView;
					this.app.workspace.setActiveLeaf(targetLeaf, { focus: true });
					const pos = { line: todo.lineNum - 1, ch: 0 };
					mdView.editor.setCursor(pos);
					mdView.editor.scrollIntoView({ from: pos, to: pos }, true);
					mdView.editor.focus();
				});
			});

			// 섹션 헤더 클릭으로 접기/펼치기
			sectionHeader.addEventListener('click', (e) => {
				if ((e.target as HTMLElement).closest('.todo-toggle-btn')) return;
				if (isCollapsed) this.collapsedSections.delete(key);
				else             this.collapsedSections.add(key);
				this.refresh();
			});
		});
	}
}

// ─── CM6 ViewPlugin ───────────────────────────────────────────────────────────

function buildDecorations(view: EditorView): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();
	const order: Priority[] = ['high', 'normal', 'low'];
	for (const { from, to } of view.visibleRanges) {
		let pos = from;
		while (pos <= to) {
			const line = view.state.doc.lineAt(pos);
			for (const priority of order) {
				if (PRIORITY_REGEXES[priority].test(line.text)) {
					builder.add(line.from, line.from, Decoration.line({ class: `todo-hl-${priority}` }));
					break;
				}
			}
			pos = line.to + 1;
		}
	}
	return builder.finish();
}

class TodoHighlightView {
	decorations: DecorationSet;
	private backdropContainer: HTMLElement | null = null;

	constructor(view: EditorView) {
		this.decorations = buildDecorations(view);
		this.ensureContainer(view);
		requestAnimationFrame(() => this.updateBackdrops(view));
	}

	update(update: ViewUpdate) {
		if (update.docChanged || update.viewportChanged || update.geometryChanged) {
			this.decorations = buildDecorations(update.view);
			requestAnimationFrame(() => this.updateBackdrops(update.view));
		}
	}

	destroy() {
		this.backdropContainer?.remove();
		this.backdropContainer = null;
	}

	private ensureContainer(view: EditorView) {
		if (this.backdropContainer && view.scrollDOM.contains(this.backdropContainer)) return;
		this.backdropContainer?.remove();
		const el = document.createElement('div');
		el.className = 'todo-backdrop-container';
		view.scrollDOM.insertBefore(el, view.scrollDOM.firstChild);
		this.backdropContainer = el;
	}

	private updateBackdrops(view: EditorView) {
		if (!this.backdropContainer) return;
		this.backdropContainer.innerHTML = '';

		const scrollerRect = view.scrollDOM.getBoundingClientRect();
		const scrollTop    = view.scrollDOM.scrollTop;
		const gutterEls    = view.dom.querySelectorAll<HTMLElement>('.cm-gutterElement');

		gutterEls.forEach(el =>
			el.classList.remove('todo-gutter-high', 'todo-gutter-normal', 'todo-gutter-low')
		);

		for (const priority of ['high', 'normal', 'low'] as Priority[]) {
			const lines = view.contentDOM.querySelectorAll<HTMLElement>(`.cm-line.todo-hl-${priority}`);
			lines.forEach(lineEl => {
				const rect = lineEl.getBoundingClientRect();
				const el   = document.createElement('div');
				el.className = `todo-line-backdrop todo-backdrop-${priority}`;
				el.style.top    = `${rect.top - scrollerRect.top + scrollTop}px`;
				el.style.height = `${rect.height}px`;
				this.backdropContainer!.appendChild(el);

				gutterEls.forEach(gutterEl => {
					const gr = gutterEl.getBoundingClientRect();
					if (gr.top < rect.bottom - 1 && gr.bottom > rect.top + 1) {
						gutterEl.classList.add(`todo-gutter-${priority}`);
					}
				});
			});
		}
	}
}

const todoHighlightExtension = ViewPlugin.fromClass(TodoHighlightView, {
	decorations: (v) => v.decorations,
});

// ─── Settings Tab ─────────────────────────────────────────────────────────────

class TodoSettingTab extends PluginSettingTab {
	plugin: TodoHighlighterPlugin;
	private isRecording = false;
	private recordHandler: ((e: KeyboardEvent) => void) | null = null;

	constructor(app: App, plugin: TodoHighlighterPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const addColorBlock = (
			title: string,
			hexKey: keyof TodoPluginSettings,
			opacityKey: keyof TodoPluginSettings,
			defaultHex: string,
			defaultOpacity: number,
		) => {
			containerEl.createEl('h3', { text: title });
			new Setting(containerEl)
				.setName('색상')
				.addColorPicker(cp => {
					cp.setValue(this.plugin.settings[hexKey] as string);
					cp.onChange(async value => {
						(this.plugin.settings as any)[hexKey] = value;
						await this.plugin.saveSettings();
						this.plugin.applyColor();
					});
				})
				.addButton(btn => {
					btn.setButtonText('기본값으로');
					btn.onClick(async () => {
						(this.plugin.settings as any)[hexKey]     = defaultHex;
						(this.plugin.settings as any)[opacityKey] = defaultOpacity;
						await this.plugin.saveSettings();
						this.plugin.applyColor();
						this.display();
					});
				});
			new Setting(containerEl)
				.setName('투명도')
				.setDesc('0 (완전 투명) ~ 1 (불투명)')
				.addSlider(slider => {
					slider.setLimits(0, 1, 0.05);
					slider.setValue(this.plugin.settings[opacityKey] as number);
					slider.setDynamicTooltip();
					slider.onChange(async value => {
						(this.plugin.settings as any)[opacityKey] = value;
						await this.plugin.saveSettings();
						this.plugin.applyColor();
					});
				});
		};

		addColorBlock('🔴 HIGH 색상', 'highColorHex', 'highOpacity', DEFAULTS.highColorHex, DEFAULTS.highOpacity);
		addColorBlock('🟠 TODO 색상', 'colorHex',     'opacity',     DEFAULTS.colorHex,     DEFAULTS.opacity);
		addColorBlock('🟡 LOW 색상',  'lowColorHex',  'lowOpacity',  DEFAULTS.lowColorHex,  DEFAULTS.lowOpacity);

		// ── 단축키
		containerEl.createEl('h3', { text: '단축키' });

		let recordBtnRef!: ButtonComponent;
		const shortcutSetting = new Setting(containerEl)
			.setName('TODO 주석 삽입')
			.setDesc('현재 커서 위치에 <!-- TODO  --> 를 삽입합니다.');

		const shortcutDisplay = shortcutSetting.controlEl.createSpan({
			text: this.plugin.settings.shortcut,
			cls: 'todo-shortcut-display',
		});

		shortcutSetting
			.addButton(btn => {
				recordBtnRef = btn;
				btn.setButtonText('변경');
				btn.onClick(() => {
					if (this.isRecording) this.stopRecording(shortcutDisplay, btn);
					else                  this.startRecording(shortcutDisplay, btn);
				});
			})
			.addButton(btn => {
				btn.setButtonText('기본값으로');
				btn.onClick(async () => {
					this.stopRecording(shortcutDisplay, recordBtnRef);
					this.plugin.settings.shortcut = DEFAULTS.shortcut;
					await this.plugin.saveSettings();
					shortcutDisplay.setText(DEFAULTS.shortcut);
				});
			});
	}

	private startRecording(displayEl: HTMLElement, btn: ButtonComponent) {
		this.isRecording = true;
		btn.setButtonText('취소');
		displayEl.setText('키를 누르세요...');
		displayEl.addClass('todo-shortcut-recording');

		this.recordHandler = async (e: KeyboardEvent) => {
			if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
			e.preventDefault();
			e.stopPropagation();
			const parts: string[] = [];
			if (e.ctrlKey)  parts.push('Ctrl');
			if (e.shiftKey) parts.push('Shift');
			if (e.altKey)   parts.push('Alt');
			if (e.metaKey)  parts.push('Cmd');
			parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
			const shortcut = parts.join('+');
			this.plugin.settings.shortcut = shortcut;
			await this.plugin.saveSettings();
			displayEl.setText(shortcut);
			this.stopRecording(displayEl, btn);
		};

		document.addEventListener('keydown', this.recordHandler, { capture: true });
	}

	private stopRecording(displayEl?: HTMLElement, btn?: ButtonComponent) {
		this.isRecording = false;
		btn?.setButtonText('변경');
		displayEl?.removeClass('todo-shortcut-recording');
		if (this.recordHandler) {
			document.removeEventListener('keydown', this.recordHandler, { capture: true });
			this.recordHandler = null;
		}
	}

	hide() { this.stopRecording(); }
}

// ─── Main Plugin ──────────────────────────────────────────────────────────────

export default class TodoHighlighterPlugin extends Plugin {
	settings: TodoPluginSettings = { ...DEFAULT_SETTINGS };

	async onload() {
		await this.loadSettings();

		this.registerEditorExtension(todoHighlightExtension);
		this.registerView(SIDEBAR_VIEW_TYPE, leaf => new TodoSidebarView(leaf, this));

		this.addRibbonIcon('list-todo', 'TODO 목록 열기', () => this.activateSidebar());
		this.addSettingTab(new TodoSettingTab(this.app, this));
		this.applyColor();

		// capture: true → IME보다 먼저 이벤트 수신
		this.registerDomEvent(document, 'keydown', (e: KeyboardEvent) => {
			if (!matchesShortcut(e, this.settings.shortcut)) return;
			const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!mdView) return;
			e.preventDefault();
			const editor = mdView.editor;
			const cursor = editor.getCursor();
			editor.replaceRange('<!-- TODO  -->', cursor);
			editor.setCursor({ line: cursor.line, ch: cursor.ch + 10 });
		}, { capture: true });

		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.refreshSidebar()));
		this.registerEvent(this.app.vault.on('modify', () => this.refreshSidebar()));
	}

	async onunload() {
		this.app.workspace.detachLeavesOfType(SIDEBAR_VIEW_TYPE);
		Object.values(CSS_VARS).forEach(v => document.body.style.removeProperty(v));
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	applyColor() {
		const master = this.settings.highlightEnabled;
		const set = (cssVar: string, hex: string, opacity: number, enabled: boolean) => {
			document.body.style.setProperty(
				cssVar,
				master && enabled ? hexToRgba(hex, opacity) : 'transparent'
			);
		};
		set(CSS_VARS.high,   this.settings.highColorHex, this.settings.highOpacity,  this.settings.highlightHighEnabled);
		set(CSS_VARS.normal, this.settings.colorHex,     this.settings.opacity,       this.settings.highlightNormalEnabled);
		set(CSS_VARS.low,    this.settings.lowColorHex,  this.settings.lowOpacity,    this.settings.highlightLowEnabled);
	}

	async toggleHighlight() {
		this.settings.highlightEnabled = !this.settings.highlightEnabled;
		await this.saveSettings();
		this.applyColor();
		this.refreshSidebar();
	}

	async toggleHighlightForPriority(priority: Priority) {
		const key = PRIORITY_ENABLED_KEY[priority];
		(this.settings as any)[key] = !(this.settings as any)[key];
		await this.saveSettings();
		this.applyColor();
		this.refreshSidebar();
	}

	async activateSidebar() {
		const leaves = this.app.workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE);
		if (leaves.length > 0) { this.app.workspace.revealLeaf(leaves[0]); return; }
		const leaf = this.app.workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({ type: SIDEBAR_VIEW_TYPE, active: true });
			this.app.workspace.revealLeaf(leaf);
		}
	}

	refreshSidebar() {
		this.app.workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE).forEach(leaf => {
			if (leaf.view instanceof TodoSidebarView) leaf.view.scheduleRefresh();
		});
	}
}
