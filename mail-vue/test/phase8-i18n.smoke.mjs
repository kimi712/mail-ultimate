// 前端纯函数 smoke 测试（Phase 8 · H 国际化）：node 直接跑，无需浏览器与构建。
// 覆盖 utils/datetime.js（Intl 格式化：zh-CN / en-US / de-DE / ja-JP，
// 月/日顺序、12/24 小时制、相对时间、悬停完整时间与时区、文件大小、周起始日）
// 与 utils/shortcuts.js（Gmail 快捷键映射表与匹配规则）。
// 浏览器相关 API（localStorage/navigator）用桩代替。
// 运行：mail-vue 下 node test/phase8-i18n.smoke.mjs（退出码 0 = 通过）。
import assert from 'node:assert/strict';

// ---------- 桩 ----------
const store = new Map();
globalThis.localStorage = {
	getItem: (k) => (store.has(k) ? store.get(k) : null),
	setItem: (k, v) => store.set(String(k), String(v)),
	removeItem: (k) => store.delete(k)
};
Object.defineProperty(globalThis, 'navigator', {
	value: { language: 'en-US', languages: ['en-US', 'en'] },
	writable: true,
	configurable: true
});

const dt = await import('../src/utils/datetime.js');
const sc = await import('../src/utils/shortcuts.js');

let passed = 0;
function check(name, fn) {
	fn();
	passed++;
	console.log(`ok - ${name}`);
}

// ---------- datetime ----------
const UTC_NOON = '2026-11-08 12:00:00'; // UTC 正午
const now = new Date('2026-11-08T20:00:00Z');

check('zh-CN 日期：2026年11月8日', () => {
	assert.equal(dt.formatDate(UTC_NOON, { locale: 'zh', timeZone: 'Asia/Shanghai' }), '2026年11月8日');
});
check('en-US 日期：Nov 8, 2026（月在前）', () => {
	assert.equal(dt.formatDate(UTC_NOON, { locale: 'en', timeZone: 'America/New_York' }), 'Nov 8, 2026');
});
check('de-DE 日期：日.月顺序（8. Nov. 2026）', () => {
	const out = dt.formatDate(UTC_NOON, { locale: 'de', timeZone: 'Europe/Berlin' });
	assert.match(out, /8\./);
	assert.match(out, /Nov/);
});
check('en-US 时间 12 小时制（含 AM/PM）', () => {
	const out = dt.formatTime(UTC_NOON, { locale: 'en', timeZone: 'America/New_York' });
	assert.match(out, /AM|PM/);
	assert.match(out, /^7:00/); // UTC 12:00 → 纽约 07:00（EST）
});
check('zh-CN 时间 24 小时制（无 AM/PM）', () => {
	const out = dt.formatTime(UTC_NOON, { locale: 'zh', timeZone: 'Asia/Shanghai' });
	assert.equal(out, '20:00');
});
check('de-DE 时间 24 小时制', () => {
	const out = dt.formatTime(UTC_NOON, { locale: 'de', timeZone: 'Europe/Berlin' });
	assert.equal(out, '13:00');
});
check('ja-JP 日期时间含年与 24 小时制', () => {
	const out = dt.formatDateTime(UTC_NOON, { locale: 'ja', timeZone: 'Asia/Tokyo' });
	assert.match(out, /2026/);
	assert.match(out, /21:00/); // UTC 12:00 → 东京 21:00
});
check('相对时间：en 5 分钟前 / zh 5分钟前', () => {
	const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
	assert.equal(dt.formatListTime(fiveMinAgo, { locale: 'en', timeZone: 'UTC', now }), '5 minutes ago');
	assert.equal(dt.formatListTime(fiveMinAgo, { locale: 'zh', timeZone: 'UTC', now }), '5分钟前');
});
check('相对时间：de 5 分钟前（vor 5 Minuten）', () => {
	const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
	assert.equal(dt.formatListTime(fiveMinAgo, { locale: 'de', timeZone: 'UTC', now }), 'vor 5 Minuten');
});
check('昨天带时间：en Yesterday, 8:00 PM / zh 昨天 20:00', () => {
	const yesterday = '2026-11-07 20:00:00';
	assert.equal(
		dt.formatListTime(yesterday, { locale: 'en', timeZone: 'UTC', now }),
		'Yesterday, 8:00 PM'
	);
	assert.equal(
		dt.formatListTime(yesterday, { locale: 'zh', timeZone: 'UTC', now }),
		'昨天 20:00'
	);
});
check('悬停完整时间含时区名与偏移', () => {
	const out = dt.formatFullWithTimeZone(UTC_NOON, { locale: 'en', timeZone: 'Asia/Shanghai' });
	assert.match(out, /Nov 8, 2026/);
	assert.match(out, /Asia\/Shanghai/);
	assert.match(out, /GMT\+0?8/);
});
check('文件大小按 locale：en 1.5 KB / de 1,5 KB', () => {
	assert.equal(dt.formatFileSize(1536, { locale: 'en' }), '1.5 KB');
	assert.equal(dt.formatFileSize(1536, { locale: 'de' }), '1,5 KB');
});
check('数字千分位：en 1,234,567 / de 1.234.567', () => {
	assert.equal(dt.formatNumber(1234567, { locale: 'en' }), '1,234,567');
	assert.equal(dt.formatNumber(1234567, { locale: 'de' }), '1.234.567');
});
check('周起始日：en-US 周日(0) / zh-CN 周一(1) / de-DE 周一(1)', () => {
	assert.equal(dt.getWeekStartDay('en'), 0);
	assert.equal(dt.getWeekStartDay('zh'), 1);
	assert.equal(dt.getWeekStartDay('de'), 1);
});
check('时区解析：auto/非法值回落浏览器时区；合法值原样返回', () => {
	const browser = dt.getBrowserTimeZone();
	assert.equal(dt.resolveTimeZone('auto'), browser);
	assert.equal(dt.resolveTimeZone('Not/AZone'), browser);
	assert.equal(dt.resolveTimeZone('Asia/Tokyo'), 'Asia/Tokyo');
});
check('服务端 UTC 时间字符串按 UTC 解析（不被当成本地时间）', () => {
	const d = dt.parseServerTime('2026-11-08 12:00:00');
	assert.equal(d.toISOString(), '2026-11-08T12:00:00.000Z');
});

// ---------- shortcuts ----------
check('快捷键映射表：9 个 Gmail 键齐全', () => {
	const keys = sc.SHORTCUT_MAP.map(item => item.key).sort();
	assert.deepEqual(keys, ['#', '/', '?', 'c', 'e', 'j', 'k', 'o', 'u']);
	assert.equal(sc.SHORTCUT_MAP.length, 9);
});
check('匹配：j/k/o/e/#/u/c/// ? 均命中对应动作', () => {
	const cases = { j: 'next', k: 'prev', o: 'open', e: 'archive', '#': 'delete', u: 'back', c: 'compose', '/': 'search', '?': 'help' };
	for (const [key, action] of Object.entries(cases)) {
		const hit = sc.matchShortcut({ key, target: documentStub(), ctrlKey: false, metaKey: false, altKey: false });
		assert.ok(hit, `key ${key} should match`);
		assert.equal(hit.action, action);
	}
});
check('不匹配：普通字母、带 Ctrl/Cmd/Alt、输入框内打字', () => {
	assert.equal(sc.matchShortcut({ key: 'x', target: documentStub(), ctrlKey: false, metaKey: false, altKey: false }), null);
	assert.equal(sc.matchShortcut({ key: 'j', target: documentStub(), ctrlKey: true, metaKey: false, altKey: false }), null);
	assert.equal(sc.matchShortcut({ key: 'j', target: documentStub(), ctrlKey: false, metaKey: true, altKey: false }), null);
	assert.equal(sc.matchShortcut({ key: 'j', target: inputStub(), ctrlKey: false, metaKey: false, altKey: false }), null);
	assert.equal(sc.matchShortcut({ key: 'c', target: textareaStub(), ctrlKey: false, metaKey: false, altKey: false }), null);
});

function documentStub() {
	return { closest: () => null };
}
function inputStub() {
	return { closest: (sel) => (sel.includes('input') ? {} : null) };
}
function textareaStub() {
	return { closest: (sel) => (sel.includes('textarea') ? {} : null) };
}

console.log(`\nphase8-i18n smoke: ${passed} passed`);
