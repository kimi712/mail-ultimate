// 前端纯函数 smoke 测试（Phase 2 A 路补充）：node 直接跑，无需浏览器与构建。
// 覆盖 i18n/locale.js（归一化/存储值/浏览器语言/持久化）与
// utils/preferences.js（偏好读写校验、主题解析、偏好应用）。
// 浏览器相关 API（localStorage/navigator/matchMedia/document）用桩代替。
// 运行：mail-vue 下 node test/preferences-locale.smoke.mjs（退出码 0 = 通过）。
// 注意：applyLocale 的懒加载与 vue-i18n 挂载不在此覆盖，见 PHASE2-A.md 手动验证步骤。
import assert from 'node:assert/strict';

// ---------- 桩 ----------
const store = new Map();
globalThis.localStorage = {
	getItem: (k) => (store.has(k) ? store.get(k) : null),
	setItem: (k, v) => store.set(String(k), String(v)),
	removeItem: (k) => store.delete(k)
};
Object.defineProperty(globalThis, 'navigator', {
	value: { language: 'zh-CN' },
	writable: true,
	configurable: true
});
let systemDark = false;
const listeners = new Set();
globalThis.window = {
	matchMedia: (query) => {
		if (query === '(prefers-color-scheme: dark)') {
			return {
				matches: systemDark,
				addEventListener: (_t, fn) => listeners.add(fn),
				removeEventListener: (_t, fn) => listeners.delete(fn),
				addListener: (fn) => listeners.add(fn),
				removeListener: (fn) => listeners.delete(fn)
			};
		}
		return {
			matches: false,
			addEventListener: () => {},
			removeEventListener: () => {},
			addListener: () => {},
			removeListener: () => {}
		};
	}
};
const classSet = new Set();
globalThis.document = {
	documentElement: {
		classList: {
			toggle: (name, force) => {
				if (force) classSet.add(name);
				else classSet.delete(name);
			},
			contains: (name) => classSet.has(name)
		},
		dataset: {}
	},
	getElementById: () => null
};

const locale = await import('../src/i18n/locale.js');
const prefs = await import('../src/utils/preferences.js');

let passed = 0;
function check(name, fn) {
	fn();
	passed++;
	console.log('ok -', name);
}

// ---------- locale.js ----------
check('normalizeLocale：存储值/短码/浏览器值归一化', () => {
	assert.equal(locale.normalizeLocale('zh-CN'), 'zh');
	assert.equal(locale.normalizeLocale('zh'), 'zh');
	assert.equal(locale.normalizeLocale('en-US'), 'en');
	assert.equal(locale.normalizeLocale('ja'), 'ja');
	assert.equal(locale.normalizeLocale('xx'), null);
	assert.equal(locale.normalizeLocale(''), null);
	assert.equal(locale.normalizeLocale(null), null);
});

check('toStoredLocale：中文写 zh-CN，其余不变', () => {
	assert.equal(locale.toStoredLocale('zh'), 'zh-CN');
	assert.equal(locale.toStoredLocale('en'), 'en');
	assert.equal(locale.toStoredLocale('ja'), 'ja');
});

check('detectBrowserLocale：zh 开头 → zh-CN，否则 en', () => {
	assert.equal(locale.detectBrowserLocale(), 'zh-CN');
	globalThis.navigator.language = 'en-US';
	assert.equal(locale.detectBrowserLocale(), 'en');
	globalThis.navigator.language = 'zh-TW';
	assert.equal(locale.detectBrowserLocale(), 'zh-CN');
	globalThis.navigator.language = 'zh-CN';
});

check('readStoredLocale/writeStoredLocale：mail-locale 持久化', () => {
	store.clear();
	assert.equal(locale.readStoredLocale(), null);
	locale.writeStoredLocale('ja');
	assert.equal(store.get('mail-locale'), 'ja');
	assert.equal(locale.readStoredLocale(), 'ja');
	locale.writeStoredLocale('zh');
	assert.equal(store.get('mail-locale'), 'zh-CN');
	assert.equal(locale.readStoredLocale(), 'zh');
	store.set('mail-locale', 'xx');
	assert.equal(locale.readStoredLocale(), null);
});

check('SUPPORTED_LOCALES：8 种，语言名用各自母语', () => {
	assert.equal(locale.SUPPORTED_LOCALES.length, 8);
	assert.deepEqual(locale.SUPPORTED_LOCALES.map((l) => l.short), ['zh', 'en', 'ja', 'ko', 'vi', 'ru', 'es', 'fr']);
	assert.equal(locale.SUPPORTED_LOCALES[0].label, '简体中文');
	assert.equal(locale.SUPPORTED_LOCALES[2].label, '日本語');
});

// ---------- preferences.js ----------
check('loadPrefs：默认 light/舒适/通知开；非法值回落默认', () => {
	store.clear();
	assert.deepEqual(prefs.loadPrefs(), { theme: 'light', density: 'comfortable', notice: true });
	store.set('mail-prefs', JSON.stringify({ theme: 'dark', density: 'compact', notice: false }));
	assert.deepEqual(prefs.loadPrefs(), { theme: 'dark', density: 'compact', notice: false });
	store.set('mail-prefs', JSON.stringify({ theme: 'nope', density: 'wide', notice: 'yes' }));
	assert.deepEqual(prefs.loadPrefs(), { theme: 'light', density: 'comfortable', notice: true });
	store.set('mail-prefs', '{broken json');
	assert.deepEqual(prefs.loadPrefs(), { theme: 'light', density: 'comfortable', notice: true });
});

check('savePrefs/loadPrefs：往返一致', () => {
	store.clear();
	prefs.savePrefs({ theme: 'system', density: 'compact', notice: false });
	assert.deepEqual(prefs.loadPrefs(), { theme: 'system', density: 'compact', notice: false });
});

check('resolveDark：light/dark 直接取值，system 跟随系统', () => {
	assert.equal(prefs.resolveDark('light'), false);
	assert.equal(prefs.resolveDark('dark'), true);
	systemDark = false;
	assert.equal(prefs.resolveDark('system'), false);
	systemDark = true;
	assert.equal(prefs.resolveDark('system'), true);
	systemDark = false;
});

check('applyPrefs：写 data-density，dark 类与 uiStore.dark 同步', () => {
	const uiStore = { dark: false };
	prefs.applyPrefs({ theme: 'dark', density: 'compact', notice: true }, uiStore);
	assert.equal(document.documentElement.dataset.density, 'compact');
	assert.equal(classSet.has('dark'), true);
	assert.equal(uiStore.dark, true);
	prefs.applyPrefs({ theme: 'light', density: 'comfortable', notice: true }, uiStore);
	assert.equal(document.documentElement.dataset.density, 'comfortable');
	assert.equal(classSet.has('dark'), false);
	assert.equal(uiStore.dark, false);
});

check('applyPrefs：system 模式注册监听，系统变化实时同步', () => {
	const uiStore = { dark: false };
	systemDark = false;
	prefs.applyPrefs({ theme: 'system', density: 'comfortable', notice: true }, uiStore);
	assert.equal(uiStore.dark, false);
	assert.ok(listeners.size >= 1, '应注册系统主题监听');
	systemDark = true;
	for (const fn of [...listeners]) fn();
	assert.equal(uiStore.dark, true);
	assert.equal(classSet.has('dark'), true);
	// 切回手动档后取消监听
	prefs.applyPrefs({ theme: 'light', density: 'comfortable', notice: true }, uiStore);
	assert.equal(listeners.size, 0);
	systemDark = false;
});

console.log(`\nSMOKE PASS: ${passed} 项全部通过`);
