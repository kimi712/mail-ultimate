// E2EE 密钥迁移探针 + 重包（2026-11-12 uwu 第 1+2 步）。
// 新模型：一个口令。登录时浏览器已派生出邮件密钥（HKDF），登录成功后
// 即应解锁 E2EE。老模型（加密密码独立）的存量 sym 包裹由
// PBKDF2-210k(加密密码, e2eeSalt) 包着；登录后后台跑一次探针（口令只在
// 登录时在内存里，判定只做一次，结果以 user.e2ee_exposed 落库）：
//   0 = 正常/已统一：邮件密钥能解开某封 sym 包裹，自动解锁。
//   1 = 已暴露：加密密码 = 登录密码（服务端曾可推出邮件密钥）。旧 KEK 能
//       解开包裹——先用旧 KEK 解锁（旧信可读），同时提示改密码 + 重包密钥；
//       改密流程内自动跑 rewrapAll。
//   2 = 老模型未迁移：两者都解不开，加密密码独立；提示输入旧加密密码迁移。
//   无包裹：无从判定，不提示；新邮件直接用邮件密钥。
// 口令原文不落库、不写 localStorage；探针失败（接口异常）不阻断登录。
import { getSecurity, listE2eeWraps, rewrapE2ee, reportE2eeExposure } from '@/request/security.js';
import { deriveKey, setMemoryKey, unwrapCekSym, wrapCekSym } from './e2ee.js';

// 登录后后台探针。mailKey：HKDF 派生的邮件密钥（CryptoKey，未登录/无口令
// 时传 null）；password：登录口令原文（仅登录时内存里有，用完即丢）。
// 返回 {state}：0/1/2/'no-e2ee'/'no-key'/'no-wraps'/'unknown'。
export async function probeE2eeState({ mailKey, password }) {
	try {
		const sec = await getSecurity();
		if (!sec || !sec.e2eeEnabled) {
			return { state: 'no-e2ee' };
		}
		if (!mailKey) {
			// OAuth 登录用户无口令、无邮件密钥，仍走老加密密码提示（安全中心）。
			return { state: 'no-key' };
		}
		const { items = [] } = await listE2eeWraps(1, 0);
		if (!items.length) {
			setMemoryKey(mailKey);
			return { state: 'no-wraps' };
		}
		const wrapped = items[0].wrapped;
		// 1) 邮件密钥能解开 → 已统一/已迁移，自动解锁。
		if (await tryUnwrap(wrapped, mailKey)) {
			setMemoryKey(mailKey);
			if (sec.e2eeExposed !== 0) {
				await reportE2eeExposure(0).catch(() => {});
			}
			return { state: 0 };
		}
		// 2) 登录口令派生的旧 KEK 能解开 → 已暴露。
		if (password && sec.e2eeSalt) {
			let oldKek = null;
			try {
				oldKek = await deriveKey(password, sec.e2eeSalt);
			} catch (e) {
				oldKek = null;
			}
			if (oldKek && await tryUnwrap(wrapped, oldKek)) {
				// 先用旧 KEK 解锁（旧信可读）；改密码 + 重包后才换新邮件密钥。
				setMemoryKey(oldKek);
				if (sec.e2eeExposed !== 1) {
					await reportE2eeExposure(1).catch(() => {});
				}
				return { state: 1, oldKek };
			}
		}
		// 3) 两者都解不开 → 加密密码独立，未暴露，须输旧加密密码迁移。
		if (sec.e2eeExposed !== 2) {
			await reportE2eeExposure(2).catch(() => {});
		}
		return { state: 2 };
	} catch (e) {
		return { state: 'unknown' };
	}
}

async function tryUnwrap(wrapped, kek) {
	try {
		const cek = await unwrapCekSym(wrapped, kek);
		return cek != null;
	} catch (e) {
		return false;
	}
}

// 用旧 KEK 解出 CEK、再用新邮件密钥包回去，分批提交。
// oldKek：旧 KEK（CryptoKey）；newMailKey：新邮件密钥（CryptoKey）。
// 返回 {total, updated}（total=取到的包裹数，updated=服务端实际更新数）。
export async function rewrapAll(oldKek, newMailKey) {
	let offset = 0;
	const limit = 200;
	let total = 0;
	let updated = 0;
	for (;;) {
		const { items = [] } = await listE2eeWraps(limit, offset);
		if (!items.length) break;
		total += items.length;
		const batch = [];
		for (const item of items) {
			let cekRaw = null;
			try {
				cekRaw = await unwrapCekSym(item.wrapped, oldKek);
			} catch (e) {
				cekRaw = null;
			}
			if (cekRaw == null) continue;
			const newWrapped = await wrapCekSym(cekRaw, newMailKey);
			batch.push({ emailId: item.emailId, source: item.source, wrapped: newWrapped });
			if (batch.length >= 50) {
				const res = await rewrapE2ee(batch);
				updated += res?.updated || 0;
				batch.length = 0;
			}
		}
		if (batch.length) {
			const res = await rewrapE2ee(batch);
			updated += res?.updated || 0;
		}
		if (items.length < limit) break;
		offset += limit;
	}
	return { total, updated };
}
