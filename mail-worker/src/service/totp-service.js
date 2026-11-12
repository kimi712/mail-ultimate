// Phase 6：TOTP 二次验证（RFC 6238，6 位、30 秒、SHA1）。
// WebCrypto HMAC-SHA1 手写实现 + base32 编解码，零新增依赖；验证窗口 ±1 步。
// secret 存 user_totp.secret_encrypted（字段加密，见 field-crypto.js）；
// 备份码 10 个一次性码，SHA-256 存 hash（backup_codes_hash JSON 列），
// 登录时可用备份码代替 TOTP 码，用一次作废一个。
import orm from '../entity/orm';
import userTotp from '../entity/user-totp';
import { eq } from 'drizzle-orm';
import BizError from '../error/biz-error';
import { t } from '../i18n/i18n';
import fieldCrypto from '../utils/field-crypto';
import userService from './user-service';
import cryptoUtils from '../utils/crypto-utils';
import { encodeQr } from '../utils/qrcode';
import kernelAudit from '../kernel/audit';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const ISSUER = 'aevorynthtech.com';
const BACKUP_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function base32Encode(bytes) {
	let bits = 0;
	let value = 0;
	let out = '';
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			out += BASE32_ALPHABET[(value >>> bits) & 31];
		}
	}
	if (bits > 0) {
		out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
	}
	while (out.length % 8 !== 0) {
		out += '=';
	}
	return out;
}

function base32Decode(str) {
	const clean = String(str || '').toUpperCase().replace(/[\s=]/g, '');
	const bytes = [];
	let bits = 0;
	let value = 0;
	for (const ch of clean) {
		const idx = BASE32_ALPHABET.indexOf(ch);
		if (idx === -1) {
			throw new Error('invalid base32');
		}
		value = (value << 5) | idx;
		bits += 5;
		if (bits >= 8) {
			bits -= 8;
			bytes.push((value >>> bits) & 0xff);
		}
	}
	return new Uint8Array(bytes);
}

async function sha256Hex(str) {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
	return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function normalizeBackupCode(code) {
	return String(code || '').toUpperCase().replace(/[\s-]/g, '');
}

const totpService = {

	base32Encode,
	base32Decode,

	generateSecret() {
		return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
	},

	otpauthUrl(secret, email) {
		const label = encodeURIComponent(`${ISSUER}:${email}`);
		return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=6&period=30`;
	},

	async generateCode(secret, timeStep) {
		const keyBytes = base32Decode(secret);
		const step = timeStep === undefined
			? Math.floor(Date.now() / 1000 / 30)
			: timeStep;
		const msg = new Uint8Array(8);
		let s = step;
		for (let i = 7; i >= 0; i--) {
			msg[i] = s & 0xff;
			s = Math.floor(s / 256);
		}
		const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
		const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
		const offset = mac[mac.length - 1] & 0x0f;
		const code = ((mac[offset] & 0x7f) << 24) | ((mac[offset + 1] & 0xff) << 16) | ((mac[offset + 2] & 0xff) << 8) | (mac[offset + 3] & 0xff);
		return String(code % 1000000).padStart(6, '0');
	},

	async verifyCode(secret, code) {
		if (!/^\d{6}$/.test(String(code || ''))) {
			return false;
		}
		const step = Math.floor(Date.now() / 1000 / 30);
		for (const delta of [-1, 0, 1]) {
			try {
				if ((await this.generateCode(secret, step + delta)) === String(code)) {
					return true;
				}
			} catch (e) {
				return false;
			}
		}
		return false;
	},

	generateBackupCodes() {
		const codes = [];
		for (let i = 0; i < 10; i++) {
			const bytes = crypto.getRandomValues(new Uint8Array(8));
			let raw = '';
			for (const b of bytes) {
				raw += BACKUP_CODE_ALPHABET[b % BACKUP_CODE_ALPHABET.length];
			}
			codes.push(raw.slice(0, 4) + '-' + raw.slice(4));
		}
		return codes;
	},

	async getRow(c, userId) {
		return orm(c).select().from(userTotp).where(eq(userTotp.userId, userId)).get();
	},

	async isEnabled(c, userId) {
		try {
			const row = await this.getRow(c, userId);
			return !!row && row.enabled === 1;
		} catch (e) {
			return false;
		}
	},

	// 开通第一步：生成新 secret 并保存（未启用）。已启用用户重开 setup 时
	// 保留 enabled 标志，直到新 secret 经 enable 验证后才正式替换生效；
	// 备份码在 enable 成功时才重新生成。
	// Phase 8 B：
	// - 换绑（已有 TOTP 启用）必须先验旧码：oldCode 为空或验不过时拒绝，避免
	//   别人拿到已登录会话就能换掉你的二次验证。
	// - 返回二维码矩阵 qr（本地编码的 otpauth URL，绝不调用外部二维码 API，
	//   secret 不发给任何第三方）；超长（otpauth URL 超过 v10-M 容量，实测
	//   约 213 字节）时 qr 为 null，前端只显示手动输入 secret。
	// - 密钥只在设置当时返回这一次：enable 成功后前端立即清空 setupData，
	//   后端不再提供任何读 secret 的接口。
	async setup(c, userId, email, oldCode) {
		const row0 = await this.getRow(c, userId);
		const isRebind = !!row0 && row0.enabled === 1;
		if (isRebind) {
			if (!oldCode || !await this.verifyLoginCode(c, userId, oldCode)) {
				throw new BizError(t('totpOldCodeRequired'), 400);
			}
		}
		const secret = this.generateSecret();
		const secretEncrypted = await fieldCrypto.encrypt(c, secret);
		const row = row0;
		if (row) {
			await orm(c).update(userTotp).set({ secretEncrypted, backupCodesHash: '[]' })
				.where(eq(userTotp.userId, userId)).run();
		} else {
			await orm(c).insert(userTotp).values({ userId, secretEncrypted, enabled: 0, backupCodesHash: '[]' }).run();
		}
		const otpauthUrl = this.otpauthUrl(secret, email);
		let qr = null;
		try {
			qr = encodeQr(otpauthUrl);
		} catch (e) {
			// 超长时不阻断设置流程，前端降级为手动输入 secret。
			console.error('TOTP 二维码生成失败（降级为手动输入）:', e.message);
			qr = null;
		}
		await kernelAudit.audit(c, {
			actorUserId: userId, action: 'totp:setup', targetType: 'totp', targetId: String(userId),
			detail: { rebind: isRebind, qr: qr ? 1 : 0 }
		});
		return { secret, otpauthUrl, qr };
	},

	// 开通第二步：用当前 secret 验码，通过后启用并返回 10 个一次性备份码（只显示一次）。
	async enable(c, userId, code) {
		const row = await this.getRow(c, userId);
		if (!row || !row.secretEncrypted) {
			throw new BizError(t('totpNotEnabled'), 400);
		}
		const secret = await fieldCrypto.decrypt(c, row.secretEncrypted);
		if (!await this.verifyCode(secret, code)) {
			throw new BizError(t('totpInvalidCode'), 400);
		}
		const backupCodes = this.generateBackupCodes();
		const hashes = [];
		for (const codeText of backupCodes) {
			hashes.push(await sha256Hex(normalizeBackupCode(codeText)));
		}
		await orm(c).update(userTotp).set({ enabled: 1, backupCodesHash: JSON.stringify(hashes) })
			.where(eq(userTotp.userId, userId)).run();
		await kernelAudit.audit(c, {
			actorUserId: userId, action: 'totp:enable', targetType: 'totp', targetId: String(userId),
			detail: {}
		});
		return { backupCodes };
	},

	// 关闭：需登录密钥（新口径，浏览器已派生）+ 当前 TOTP 码（或备份码）。
	// 旧版缓存页面发明文密码，走迁移桥。成功后整行删除。
	async disable(c, userId, { loginKey, password, code }) {
		const userRow = await userService.selectById(c, userId);
		if (!userRow) {
			throw new BizError(t('IncorrectPwd'), 400);
		}
		const cred = await userService.verifyLoginCredential(c, userRow, { loginKey, password });
		if (!cred.ok) {
			throw new BizError(cred.reason === 'client-outdated' ? t('loginClientOutdated') : t('IncorrectPwd'), 400);
		}
		const row = await this.getRow(c, userId);
		if (!row || row.enabled !== 1) {
			throw new BizError(t('totpNotEnabled'), 400);
		}
		if (!await this.verifyLoginCode(c, userId, code)) {
			throw new BizError(t('totpInvalidCode'), 400);
		}
		await orm(c).delete(userTotp).where(eq(userTotp.userId, userId)).run();
		await kernelAudit.audit(c, {
			actorUserId: userId, action: 'totp:disable', targetType: 'totp', targetId: String(userId),
			detail: {}
		});
	},

	// 登录时验码：6 位数字走 TOTP；否则按备份码匹配，命中即作废该码。
	async verifyLoginCode(c, userId, code) {
		const row = await this.getRow(c, userId);
		if (!row || row.enabled !== 1) {
			return false;
		}
		if (/^\d{6}$/.test(String(code || ''))) {
			const secret = await fieldCrypto.decrypt(c, row.secretEncrypted);
			return this.verifyCode(secret, code);
		}
		let hashes = [];
		try {
			hashes = JSON.parse(row.backupCodesHash || '[]');
		} catch (e) {
			return false;
		}
		const hash = await sha256Hex(normalizeBackupCode(code));
		const idx = hashes.indexOf(hash);
		if (idx === -1) {
			return false;
		}
		hashes.splice(idx, 1);
		await orm(c).update(userTotp).set({ backupCodesHash: JSON.stringify(hashes) })
			.where(eq(userTotp.userId, userId)).run();
		return true;
	}
};

export default totpService;
