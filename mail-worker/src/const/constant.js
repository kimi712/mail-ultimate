const constant = {
	TOKEN_HEADER: 'Authorization',
	JWT_UID: 'user_id:',
	JWT_TOKEN: 'token:',
	TOKEN_EXPIRE: 60 * 60 * 24 * 30,
	ATTACHMENT_PREFIX: 'attachments/',
	BACKGROUND_PREFIX: 'static/background/',
	// 白帽反馈 #4：对象存储只认这三个前缀。KV 与 R2/S3 是同一命名空间——
	// 本站实际跑在 KV 上（S3 未配、R2 未绑定），KV 里还放着会话、设置缓存、
	// 公共 token 等运营键；/oss/<key> 无鉴权读任意 key 会把它们全暴露出来。
	// 合法对象只有附件、静态背景、用户壁纸三类。
	OBJECT_KEY_PREFIXES: ['attachments/', 'static/', 'wallpapers/'],
	ADMIN_ROLE: {
		name: 'admin',
		sendCount: 0,
		sendType: 'count',
		accountCount: 0
	}
}

export default constant
