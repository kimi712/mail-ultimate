// 批量薅号硬指纹（纯函数，无 I/O，可单测）。
// 依据：2026-11-10 新站爆发号 2,055 个的实测指纹——750 个 IP、626 个 IP 恰好各建 3 个；
// 背景（2026-11-10 爆发）：2,055 个号里 2,054 个用户名恰好 9 位字母+数字随机串，注册中位间隔 2 秒；
// 注册日志 UA 只有两种——空白和光秃秃的 "Mozilla/5.0"，零完整浏览器 UA；62% 的号登录 IP 与注册 IP 不同。
//
// UA 字段来源：注册请求头 user-agent 原样（register() 读出后记入 register_log.ua，截断 500 字符）。
// 真实浏览器 UA 是完整串（如 Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/... Chrome/...），
// 光秃秃的 "Mozilla/5.0" 没有任何真实浏览器会发，可单独硬拒。空白 UA（脚本/curl/部分客户端
// 不带 UA）在真人流量里也大量出现（2026-11-11 老站注册日志 376 次空白 UA），故空白 UA
// 绝不单独作拒绝条件，只作清理指纹的组合信号之一。

// 机器人 UA：请求头恰好等于 "Mozilla/5.0"（前后空白容忍）。
export const BOT_UA_EXACT = 'Mozilla/5.0';

export function isBotUa(ua) {
	return String(ua || '').trim() === BOT_UA_EXACT;
}

// 清理指纹里的机器人 UA：空白或恰好 "Mozilla/5.0"。
export function isBotRegisterUa(ua) {
	const u = String(ua || '').trim();
	return u === '' || u === BOT_UA_EXACT;
}

// 空白 UA：请求没带 user-agent 头。单独不是机器人信号——真人流量里也大量出现
// （脚本/curl/部分客户端不带 UA），只在“9 位随机名 + 短时集中注册”的组合里才算数。
export function isBlankUa(ua) {
	return String(ua || '').trim() === '';
}

// 9 位随机用户名（无词义）：恰好 9 位字母+数字，至少含 1 个字母，且没有任何一段
// “≥3 个连续字母且含元音”的词块。真人常用格式都有可读词块——burn4user（burn/user）、
// liujun2025、zhangsan1、xiangqian、sihongliu、Henrypaul；机器人 uniform 随机串没有：
// a1b2c3d4e、A01nkhb3s、000r2s46v、srjgrzhjl（零元音辅音串）。
// 注意：纯字母 9 位分两种——xiangqian 这种拼音名有词块，不算；srjgrzhjl 这种算。
// 宁严勿宽：词块判不定的放行（约三成随机串可能含偶然词块而漏过），靠段限流 + 清理再兜。
export function isRandom9Name(name) {
	const n = String(name || '');
	if (!/^[A-Za-z0-9]{9}$/.test(n)) {
		return false;
	}
	if (!/[A-Za-z]/.test(n)) {
		return false; // 9 位纯数字（如 QQ 号风格）不算机器人名
	}
	// 按数字切分字母段；任一段 ≥3 字母且含元音 → 有词义，放行。
	const runs = n.split(/[0-9]+/).filter(Boolean);
	for (const run of runs) {
		if (run.length >= 3 && /[aeiouAEIOU]/.test(run)) {
			return false;
		}
	}
	return true;
}
