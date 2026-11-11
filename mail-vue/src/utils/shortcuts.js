// Gmail 范式快捷键映射表（Phase 8 · H 国际化）。
// 纯数据 + 纯匹配函数，不 import Vue / store / router，便于 node smoke 测试。
// i18n key 说明：labelKey 是帮助面板里显示的动作名（由总协调合并进 14 语种文件）。
export const SHORTCUT_MAP = [
	{ id: 'next', key: 'j', labelKey: 'shortcutNext', action: 'next' },
	{ id: 'prev', key: 'k', labelKey: 'shortcutPrev', action: 'prev' },
	{ id: 'open', key: 'o', labelKey: 'shortcutOpen', action: 'open' },
	{ id: 'archive', key: 'e', labelKey: 'shortcutArchive', action: 'archive' },
	{ id: 'delete', key: '#', labelKey: 'shortcutDelete', action: 'delete' },
	{ id: 'back', key: 'u', labelKey: 'shortcutBack', action: 'back' },
	{ id: 'compose', key: 'c', labelKey: 'shortcutCompose', action: 'compose' },
	{ id: 'search', key: '/', labelKey: 'shortcutSearch', action: 'search' },
	{ id: 'help', key: '?', labelKey: 'shortcutHelp', action: 'help' }
];

export const SHORTCUT_BY_KEY = Object.fromEntries(
	SHORTCUT_MAP.map(item => [item.key, item])
);

// 是否正在可输入元素里打字（输入框/文本域/下拉/富文本）：
// 此时除 Escape 外不触发任何快捷键，避免 j/k 之类的字母干扰输入。
export function isEditableTarget(target) {
	if (!target || typeof target.closest !== 'function') return false;
	return !!target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]');
}

// 是否有修饰键按下（Ctrl/Cmd/Alt）：有则不触发单键快捷键，
// 避免与浏览器/系统快捷键冲突。Shift 允许（'?' 与 '#' 本身就需要 Shift）。
export function hasModifier(event) {
	return !!(event.ctrlKey || event.metaKey || event.altKey);
}

// 纯匹配：返回命中的快捷键条目，未命中返回 null。
// 规则：可输入元素里不触发；有 Ctrl/Cmd/Alt 不触发；
// 弹窗（ElMessageBox / el-dialog）打开时不触发列表类快捷键（'?' 除外，'?' 用来开关帮助）。
export function matchShortcut(event) {
	if (!event || typeof event.key !== 'string') return null;
	if (hasModifier(event)) return null;
	if (isEditableTarget(event.target)) return null;
	const item = SHORTCUT_BY_KEY[event.key];
	if (!item) return null;
	if (item.id !== 'help' && isDialogOpen()) return null;
	return item;
}

export function isDialogOpen() {
	if (typeof document === 'undefined') return false;
	return !!document.querySelector('.el-message-box, .el-dialog.is-visible, .el-overlay');
}
