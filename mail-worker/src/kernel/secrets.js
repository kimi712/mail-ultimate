// Layer 1 secrets（PHASE8 §8.1）：field_enc_key 启动校验。
// 根因：deploy.sh 从来没设过 field_enc_key，线上跑的是 wrangler.jsonc 里的
// dummy 值，D1 里用真密钥加密的 Resend Token 解密失败、refresh() 静默把 KV
// 写成空，发信报“发信服务未配置”。本模块只做一件事：判断运行时
// field_enc_key 是否真实可用（非空、非 dummy、长度达标），校验失败返回
// 明确的错误码与错误信息，绝不静默、绝不抛错。
// 纯函数，不碰 c.env 以外的全局状态；不打印、不返回密钥值本身。
// 错误码（语言无关，body.code 用；文案 key 由总协调合并进 i18n）：
//   field_enc_key_missing / field_enc_key_too_short / field_enc_key_dummy

export const FIELD_ENC_KEY_MIN_LENGTH = 32;

// 本地测试 dummy 值（wrangler.jsonc vars）。部署时出现此值即视为未配置。
// 注意：与 deploy.sh 里的 DUMMY 值保持一致，改一处必须改另一处。
export const FIELD_ENC_KEY_DUMMY_VALUES = [
	'phase56-local-test-only-not-a-real-secret'
];

export const FIELD_ENC_KEY_ERROR_CODES = {
	MISSING: 'field_enc_key_missing',
	TOO_SHORT: 'field_enc_key_too_short',
	DUMMY: 'field_enc_key_dummy'
};

// 校验一个密钥值。返回 { ok: true } 或 { ok: false, code, message }。
// message 只描述问题类别，永不含密钥值。
export function validateFieldEncKey(value) {
	if (typeof value !== 'string' || value === '') {
		return {
			ok: false,
			code: FIELD_ENC_KEY_ERROR_CODES.MISSING,
			message: 'field_enc_key is not configured: set it as a wrangler secret before deploy (never commit it as a [vars] value)'
		};
	}
	if (FIELD_ENC_KEY_DUMMY_VALUES.includes(value)) {
		return {
			ok: false,
			code: FIELD_ENC_KEY_ERROR_CODES.DUMMY,
			message: 'field_enc_key is still the local-test dummy value: generate a real key and set it as a wrangler secret'
		};
	}
	if (value.length < FIELD_ENC_KEY_MIN_LENGTH) {
		return {
			ok: false,
			code: FIELD_ENC_KEY_ERROR_CODES.TOO_SHORT,
			message: `field_enc_key is too short (got ${value.length} chars, need >= ${FIELD_ENC_KEY_MIN_LENGTH}): regenerate with openssl rand -hex 32`
		};
	}
	return { ok: true };
}

// 从 env 对象或 Hono 上下文 c 里取出 field_enc_key（两种都接受，方便调用方）。
export function getFieldEncKey(envOrCtx) {
	if (!envOrCtx) {
		return '';
	}
	const env = envOrCtx.env ?? envOrCtx;
	if (!env || typeof env.field_enc_key !== 'string') {
		return '';
	}
	return env.field_enc_key;
}

// 启动校验入口：校验当前运行环境的 field_enc_key。
// 返回 validateFieldEncKey 的结果；调用方据此写明确日志/告警，不得静默带病运行。
export function checkFieldEncKey(envOrCtx) {
	return validateFieldEncKey(getFieldEncKey(envOrCtx));
}

export default { validateFieldEncKey, getFieldEncKey, checkFieldEncKey, FIELD_ENC_KEY_MIN_LENGTH, FIELD_ENC_KEY_DUMMY_VALUES, FIELD_ENC_KEY_ERROR_CODES };
