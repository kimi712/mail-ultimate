// Phase 8 F：本地密码强度计（纯函数，零依赖，不联网、不把密码发给任何第三方）。
// 前后端同一份算法：前端 mail-vue/src/utils/password-strength.js 是它的镜像，
// 改一处必须同步另一处（文案 key 见汇报 i18n 清单）。
// 分级：0 very_weak / 1 weak / 2 fair / 3 good / 4 strong。
// 通过线：score >= 2 且长度 >= 8 且不在常见弱密码表里；弱密码当场拦住。
// reasons 为原因码数组（前端按码取 i18n 文案，后端直接拼进错误信息）。

export const PASSWORD_MIN_LENGTH = 8;

// 常见弱密码表（Top 60 左右的公开高频弱密码 + 键盘序/纯数字变体）。
// 命中即 score 0、直接不通过；表里只有密码本身，不含任何用户信息。
export const COMMON_WEAK_PASSWORDS = [
	'123456', '12345678', '123456789', '1234567890', '12345', '1234', '123',
	'password', 'password1', 'password123', 'passw0rd', 'passwd',
	'qwerty', 'qwerty123', 'qwertyuiop', 'asdfgh', 'asdfghjkl', 'zxcvbnm',
	'111111', '11111111', '000000', '00000000', '88888888', '666666',
	'abc123', 'abcd1234', 'a123456', '1qaz2wsx', '1q2w3e4r', 'qazwsx',
	'admin', 'admin123', 'root', 'toor', 'letmein', 'welcome', 'welcome1',
	'monkey', 'dragon', 'master', 'sunshine', 'princess', 'football',
	'charlie', 'aa123456', 'a123456789', 'woaini', 'woaini123', 'nihao123',
	'123qwe', 'qwe123', 'qwe123456', '1qazxsw2', 'iloveyou', '123123',
	'654321', '987654321', '112233', 'a1b2c3', 'abc123456', 'test123'
];

const WEAK_SET = new Set(COMMON_WEAK_PASSWORDS.map(s => s.toLowerCase()));

function hasSequence(pw) {
	const lower = pw.toLowerCase();
	// 连续 4 位递增/递减（数字或字母），如 1234 / abcd / 4321。
	for (let i = 0; i + 3 < lower.length; i++) {
		const a = lower.charCodeAt(i);
		const b = lower.charCodeAt(i + 1);
		const c = lower.charCodeAt(i + 2);
		const d = lower.charCodeAt(i + 3);
		if (b === a + 1 && c === b + 1 && d === c + 1) return true;
		if (b === a - 1 && c === b - 1 && d === c - 1) return true;
	}
	return false;
}

export function evaluatePasswordStrength(password) {
	const pw = String(password || '');
	const reasons = [];
	let score = 0;

	if (pw.length < PASSWORD_MIN_LENGTH) {
		reasons.push('too_short');
		return { score: 0, level: 'very_weak', passed: false, reasons, length: pw.length };
	}

	if (WEAK_SET.has(pw.toLowerCase())) {
		reasons.push('common_password');
		return { score: 0, level: 'very_weak', passed: false, reasons, length: pw.length };
	}

	// 长度分：>=8 得 1，>=12 再得 1。
	score += 1;
	if (pw.length >= 12) {
		score += 1;
	} else {
		reasons.push('need_longer');
	}

	// 字符种类分：大小写/数字/符号，>=3 种得 1，4 种齐全再得 1。
	const classes = [
		/[a-z]/.test(pw),
		/[A-Z]/.test(pw),
		/[0-9]/.test(pw),
		/[^a-zA-Z0-9]/.test(pw)
	].filter(Boolean).length;
	if (classes >= 3) {
		score += 1;
	} else {
		reasons.push(classes === 1 ? 'only_one_type' : 'need_more_types');
	}
	if (classes === 4) {
		score += 1;
	}

	// 可预测模式扣 1 分（最低 0）：连续序列、同一字符连出 3 次以上。
	if (hasSequence(pw) || /(.)\1{2,}/.test(pw)) {
		reasons.push('predictable_pattern');
		score = Math.max(0, score - 1);
	}

	const level = ['very_weak', 'weak', 'fair', 'good', 'strong'][score];
	const passed = score >= 2;
	return { score, level, passed, reasons, length: pw.length };
}

export default { evaluatePasswordStrength, COMMON_WEAK_PASSWORDS, PASSWORD_MIN_LENGTH };
