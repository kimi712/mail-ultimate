// Gmail 范式快捷键（Phase 8 · H 国际化）。
// 挂载点：App.vue 里一行 useMailShortcuts()。
// 行为：
//  - j/k：在当前邮件列表里上下移动焦点（DOM 级，对虚拟列表的已渲染行生效，
//    不改列表组件）；o/Enter 打开焦点邮件；u 从阅读页回列表；
//  - c：写信（uiStore.writerRef.open，与顶栏写信按钮同一入口）；
//  - /：聚焦搜索框；?：打开/关闭快捷键帮助（编程式挂载，不改 App.vue 模板）；
//  - #：勾选焦点邮件并点工具栏删除（走现有删除确认流程，不绕过确认）；
//  - e：归档——产品目前没有 Archive 文件夹/API（§14 项 5 范围外），
//    先派发 mail-shortcut:archive 事件供后续归档功能接管，
//    无人接管时回落为“标为已读”并提示；不要静默无反应。
// 开关：mail-prefs.shortcutsEnabled（默认开），设置页可关；每次按键时重读偏好。
import { createApp, h, nextTick, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import i18n from '@/i18n/index.js';
import { useUiStore } from '@/store/ui.js';
import { loadPrefs } from '@/utils/preferences.js';
import { matchShortcut } from '@/utils/shortcuts.js';
import ShortcutHelp from '@/components/shortcut-help/index.vue';

const FOCUS_STYLE = '2px solid var(--el-color-primary, #409eff)';

export function useMailShortcuts() {
	const router = useRouter();
	const uiStore = useUiStore();
	const t = (key, params) => i18n.global.t(key, params || {});

	let focusedIndex = -1;
	let helpApp = null;
	let helpContainer = null;

	// ---------- 帮助面板（编程式挂载，不动 App.vue 模板） ----------
	function openHelp() {
		if (helpApp) return;
		helpContainer = document.createElement('div');
		document.body.appendChild(helpContainer);
		helpApp = createApp({
			render: () => h(ShortcutHelp, {
				modelValue: true,
				'onUpdate:modelValue': (v) => { if (!v) closeHelp(); }
			})
		});
		helpApp.use(i18n);
		helpApp.mount(helpContainer);
	}

	function closeHelp() {
		if (!helpApp) return;
		helpApp.unmount();
		helpContainer?.remove();
		helpApp = null;
		helpContainer = null;
	}

	// ---------- 列表焦点（DOM 级） ----------
	function listRows() {
		return Array.from(document.querySelectorAll('.email-scroll .email-row, .scroll .email-row'))
			.filter(el => el.offsetParent !== null);
	}

	function clearFocusStyle() {
		document.querySelectorAll('.email-row.shortcut-focused').forEach(el => {
			el.classList.remove('shortcut-focused');
			el.style.outline = '';
			el.style.outlineOffset = '';
		});
	}

	function focusRow(index) {
		const rows = listRows();
		if (!rows.length) return null;
		focusedIndex = Math.max(0, Math.min(index, rows.length - 1));
		const row = rows[focusedIndex];
		clearFocusStyle();
		row.classList.add('shortcut-focused');
		row.style.outline = FOCUS_STYLE;
		row.style.outlineOffset = '-2px';
		row.scrollIntoView({ block: 'nearest' });
		return row;
	}

	function focusedRow() {
		const rows = listRows();
		if (!rows.length) return null;
		if (focusedIndex < 0 || focusedIndex >= rows.length) return focusRow(0);
		return rows[focusedIndex];
	}

	function checkRow(row) {
		const box = row.querySelector('input[type="checkbox"]');
		if (box && !box.checked) box.click();
	}

	function toolbarButton(index) {
		// 工具栏删除/标已读共用 .icon.delete 样式：模板里删除在前、标已读在后。
		const btns = document.querySelectorAll('.header-actions .header-left .icon.delete');
		return btns[index] || null;
	}

	// ---------- 动作 ----------
	const actions = {
		next: () => focusRow(focusedIndex < 0 ? 0 : focusedIndex + 1),
		prev: () => focusRow(focusedIndex < 0 ? 0 : focusedIndex - 1),
		open: () => {
			const row = focusedRow();
			if (row) row.click();
		},
		archive: () => {
			const row = focusedRow();
			const event = new CustomEvent('mail-shortcut:archive', {
				detail: { row, index: focusedIndex }, cancelable: true
			});
			window.dispatchEvent(event);
			if (event.defaultPrevented) return;
			// 无归档功能接管：回落为标为已读（勾选焦点行 + 点工具栏标已读，
			// 走现有流程，不静默、不误删），并明示原因。
			if (row) {
				checkRow(row);
				nextTick(() => {
					if (!toolbarButton(1)) {
						ElMessage({ message: t('shortcutArchiveSoon'), type: 'info', plain: true });
						return;
					}
					toolbarButton(1)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
					ElMessage({ message: t('shortcutArchiveSoon'), type: 'info', plain: true });
				});
			} else {
				ElMessage({ message: t('shortcutArchiveSoon'), type: 'info', plain: true });
			}
		},
		delete: () => {
			const row = focusedRow();
			if (!row) return;
			checkRow(row);
			nextTick(() => {
				// 点工具栏删除，走现有 ElMessageBox 确认 + 删除流程
				toolbarButton(0)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			});
		},
		back: () => {
			if (router.currentRoute.value.name === 'content') {
				router.push({ name: 'email' });
			}
		},
		compose: () => {
			uiStore.writerRef?.open?.();
		},
		search: () => {
			const placeholder = document.querySelector('.search-placeholder');
			if (placeholder) {
				placeholder.dispatchEvent(new MouseEvent('click', { bubbles: true }));
				return;
			}
			document.querySelector('.email-search input')?.focus();
		},
		help: () => {
			if (helpApp) closeHelp();
			else openHelp();
		}
	};

	function onKeydown(event) {
		// 开关：设置里关掉即不监听任何快捷键（'?' 也不触发）
		if (loadPrefs().shortcutsEnabled === false) return;
		const item = matchShortcut(event);
		if (!item) return;
		// 帮助面板打开时只响应 '?'（关闭）与 Escape
		if (helpApp && item.id !== 'help') return;
		event.preventDefault();
		actions[item.action]?.();
	}

	function onEscape(event) {
		if (event.key === 'Escape' && helpApp) closeHelp();
	}

	function handler(event) {
		if (event.key === 'Escape') return onEscape(event);
		return onKeydown(event);
	}

	onMounted(() => {
		window.addEventListener('keydown', handler, true);
	});

	onUnmounted(() => {
		window.removeEventListener('keydown', handler, true);
		closeHelp();
	});
}
