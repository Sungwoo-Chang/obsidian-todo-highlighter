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

// ─── Constants ────────────────────────────────────────────────────────────────

const TODO_REGEX = /<!--\s*TODO(.*?)-->/;
const SIDEBAR_VIEW_TYPE = 'todo-highlighter-sidebar';
const CSS_COLOR_VAR = '--todo-highlight-color';
const DEFAULT_COLOR_HEX = '#ff8c00';
const DEFAULT_OPACITY = 0.2;
const DEFAULT_SHORTCUT = 'Ctrl+Shift+T';

// ─── Settings ─────────────────────────────────────────────────────────────────

interface TodoPluginSettings {
	colorHex: string;
	opacity: number;
	shortcut: string;
	highlightEnabled: boolean;
}

const DEFAULT_SETTINGS: TodoPluginSettings = {
	colorHex: DEFAULT_COLOR_HEX,
	opacity: DEFAULT_OPACITY,
	shortcut: DEFAULT_SHORTCUT,
	highlightEnabled: true,
};

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
		e.altKey === parts.includes('Alt') &&
		e.metaKey === (parts.includes('Meta') || parts.includes('Cmd'));

	if (!modifiersMatch) return false;

	// e.code로도 확인 (한글 IME 등에서 e.key가 'Process'가 되는 경우 대응)
	const codeKey = e.code.startsWith('Key') ? e.code.slice(3) : e.code;
	return e.key.toUpperCase() === targetKey || codeKey.toUpperCase() === targetKey;
}

interface TodoItem {
	lineNum: number;
	message: string;
}

function extractTodos(content: string): TodoItem[] {
	const items: TodoItem[] = [];
	content.split('\n').forEach((line, index) => {
		const match = TODO_REGEX.exec(line);
		if (match) items.push({ lineNum: index + 1, message: match[1].trim() });
	});
	return items;
}

// ─── Sidebar View ─────────────────────────────────────────────────────────────

class TodoSidebarView extends ItemView {
	plugin: TodoHighlighterPlugin;
	private refreshTimer: number | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: TodoHighlighterPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() { return SIDEBAR_VIEW_TYPE; }
	getDisplayText() { return 'TODO 목록'; }
	getIcon() { return 'list-todo'; }

	async onOpen() { this.refresh(); }
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

		// Header
		const header = root.createDiv({ cls: 'todo-sidebar-header' });
		header.createSpan({ text: activeFile.basename, cls: 'todo-sidebar-filename' });
		header.createSpan({
			text: `${todos.length}개`,
			cls: 'todo-sidebar-badge' + (todos.length === 0 ? ' todo-sidebar-badge-zero' : ''),
		});

		// 하이라이트 토글 버튼
		const toggleBtn = header.createEl('button', { cls: 'todo-toggle-btn clickable-icon' });
		const isEnabled = this.plugin.settings.highlightEnabled;
		setIcon(toggleBtn, isEnabled ? 'eye' : 'eye-off');
		toggleBtn.setAttribute('aria-label', isEnabled ? '하이라이트 끄기' : '하이라이트 켜기');
		toggleBtn.addEventListener('click', async () => {
			await this.plugin.toggleHighlight();
		});

		if (todos.length === 0) {
			root.createEl('p', { text: 'TODO 주석이 없습니다.', cls: 'todo-sidebar-empty' });
			return;
		}

		const list = root.createDiv({ cls: 'todo-sidebar-list' });
		todos.forEach(todo => {
			const item = list.createDiv({ cls: 'todo-sidebar-item' });
			item.createSpan({ text: `L${todo.lineNum}`, cls: 'todo-sidebar-line-badge' });
			item.createSpan({
				text: todo.message || '(내용 없음)',
				cls: 'todo-sidebar-message' + (!todo.message ? ' todo-sidebar-message-empty' : ''),
			});

			item.addEventListener('click', () => {
				const activeFile = this.app.workspace.getActiveFile();
				if (!activeFile) return;

				// 클릭 시 사이드바가 active leaf가 되므로 getActiveViewOfType 대신
				// 모든 leaf를 순회해서 해당 파일을 열고 있는 MarkdownView를 찾음
				const mdLeaves = this.app.workspace.getLeavesOfType('markdown');
				const targetLeaf = mdLeaves.find(
					leaf => (leaf.view as MarkdownView).file?.path === activeFile.path
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
	}
}

// ─── CM6 ViewPlugin ───────────────────────────────────────────────────────────

function buildDecorations(view: EditorView): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();
	for (const { from, to } of view.visibleRanges) {
		let pos = from;
		while (pos <= to) {
			const line = view.state.doc.lineAt(pos);
			if (TODO_REGEX.test(line.text)) {
				builder.add(line.from, line.from, Decoration.line({ class: 'todo-highlight-line' }));
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
		const scrollTop = view.scrollDOM.scrollTop;
		const lines = view.contentDOM.querySelectorAll<HTMLElement>('.cm-line.todo-highlight-line');

		lines.forEach(lineEl => {
			const rect = lineEl.getBoundingClientRect();
			const el = document.createElement('div');
			el.className = 'todo-line-backdrop';
			el.style.top = `${rect.top - scrollerRect.top + scrollTop}px`;
			el.style.height = `${rect.height}px`;
			this.backdropContainer!.appendChild(el);
		});

		const gutterEls = view.dom.querySelectorAll<HTMLElement>('.cm-gutterElement');
		gutterEls.forEach(el => el.classList.remove('todo-gutter-highlight'));
		lines.forEach(lineEl => {
			const lr = lineEl.getBoundingClientRect();
			gutterEls.forEach(gutterEl => {
				const gr = gutterEl.getBoundingClientRect();
				if (gr.top < lr.bottom - 1 && gr.bottom > lr.top + 1) {
					gutterEl.classList.add('todo-gutter-highlight');
				}
			});
		});
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

		// ── 하이라이트 색상
		containerEl.createEl('h3', { text: '하이라이트 색상' });

		new Setting(containerEl)
			.setName('색상')
			.setDesc('TODO 주석 줄의 배경 색상')
			.addColorPicker(cp => {
				cp.setValue(this.plugin.settings.colorHex);
				cp.onChange(async value => {
					this.plugin.settings.colorHex = value;
					await this.plugin.saveSettings();
					this.plugin.applyColor();
				});
			})
			.addButton(btn => {
				btn.setButtonText('기본값으로');
				btn.onClick(async () => {
					this.plugin.settings.colorHex = DEFAULT_COLOR_HEX;
					this.plugin.settings.opacity = DEFAULT_OPACITY;
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
				slider.setValue(this.plugin.settings.opacity);
				slider.setDynamicTooltip();
				slider.onChange(async value => {
					this.plugin.settings.opacity = value;
					await this.plugin.saveSettings();
					this.plugin.applyColor();
				});
			});

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
					if (this.isRecording) {
						this.stopRecording(shortcutDisplay, btn);
					} else {
						this.startRecording(shortcutDisplay, btn);
					}
				});
			})
			.addButton(btn => {
				btn.setButtonText('기본값으로');
				btn.onClick(async () => {
					this.stopRecording(shortcutDisplay, recordBtnRef);
					this.plugin.settings.shortcut = DEFAULT_SHORTCUT;
					await this.plugin.saveSettings();
					shortcutDisplay.setText(DEFAULT_SHORTCUT);
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
			if (e.ctrlKey) parts.push('Ctrl');
			if (e.shiftKey) parts.push('Shift');
			if (e.altKey) parts.push('Alt');
			if (e.metaKey) parts.push('Cmd');
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

	hide() {
		this.stopRecording();
	}
}

// ─── Main Plugin ──────────────────────────────────────────────────────────────

export default class TodoHighlighterPlugin extends Plugin {
	settings: TodoPluginSettings = DEFAULT_SETTINGS;

	async onload() {
		await this.loadSettings();

		this.registerEditorExtension(todoHighlightExtension);
		this.registerView(SIDEBAR_VIEW_TYPE, leaf => new TodoSidebarView(leaf, this));

		this.addRibbonIcon('list-todo', 'TODO 목록 열기', () => this.activateSidebar());
		this.addSettingTab(new TodoSettingTab(this.app, this));
		this.applyColor();

		// 단축키로 <!-- TODO  --> 삽입
		// capture: true → IME보다 먼저 이벤트 수신 (한글 등 입력 중에도 동작)
		this.registerDomEvent(document, 'keydown', (e: KeyboardEvent) => {
			if (!matchesShortcut(e, this.settings.shortcut)) return;
			const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!mdView) return;
			e.preventDefault();
			const editor = mdView.editor;
			const cursor = editor.getCursor();
			editor.replaceRange('<!-- TODO  -->', cursor);
			// 커서를 TODO와 --> 사이에 위치
			editor.setCursor({ line: cursor.line, ch: cursor.ch + 10 });
		}, { capture: true });

		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.refreshSidebar()));
		this.registerEvent(this.app.vault.on('modify', () => this.refreshSidebar()));
	}

	async onunload() {
		this.app.workspace.detachLeavesOfType(SIDEBAR_VIEW_TYPE);
		document.body.style.removeProperty(CSS_COLOR_VAR);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	applyColor() {
		const color = this.settings.highlightEnabled
			? hexToRgba(this.settings.colorHex, this.settings.opacity)
			: 'transparent';
		document.body.style.setProperty(CSS_COLOR_VAR, color);
	}

	async toggleHighlight() {
		this.settings.highlightEnabled = !this.settings.highlightEnabled;
		await this.saveSettings();
		this.applyColor();
		this.refreshSidebar();
	}

	async activateSidebar() {
		const leaves = this.app.workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE);
		if (leaves.length > 0) {
			this.app.workspace.revealLeaf(leaves[0]);
			return;
		}
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
