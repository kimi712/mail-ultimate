import settingService from '../service/setting-service';
import emailUtils from '../utils/email-utils';
import {emailConst} from "../const/entity-const";

const dbInit = {
	async init(c) {

		// 白帽反馈小项：secret 从 Authorization 请求头取，不再从 URL 取
		// （/init/:secret 的形式会把 JWT secret 写进访问日志与 Referer）。
		const authHeader = c.req.header('Authorization') || '';
		const secret = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim() : '';

		if (secret !== c.env.jwt_secret) {
			return c.text('❌ JWT secret mismatch');
		}

		await this.intDB(c);
		await this.v1_1DB(c);
		await this.v1_2DB(c);
		await this.v1_3DB(c);
		await this.v1_3_1DB(c);
		await this.v1_4DB(c);
		await this.v1_5DB(c);
		await this.v1_6DB(c);
		await this.v1_7DB(c);
		await this.v2DB(c);
		await this.v2_3DB(c);
		await this.v2_4DB(c);
		await this.v2_5DB(c);
		await this.v2_6DB(c);
		await this.v2_7DB(c);
		await this.v2_8DB(c);
		await this.v2_9DB(c);
		await this.v3_0DB(c);
		await this.v3_1DB(c);
		await this.v3_2DB(c);
		await this.v3_3DB(c);
		await this.v3_4DB(c);
		await this.v3_5DB(c);
		await this.v3_6DB(c);
		await this.v3_7DB(c);
		await this.v3_8DB(c);
		await this.v3_9DB(c);
		await this.v3_10DB(c);
		await this.v3_11DB(c);
		await this.v3_12DB(c);
		await this.v3_13DB(c);
		await this.v3_14DB(c);
		await this.v3_15DB(c);
		await this.v3_16DB(c);
		await this.v3_17DB(c);
		await this.v3_18DB(c);
		await this.v3_19DB(c);
		await settingService.refresh(c);
		return c.text('success');
	},

	async v3_5DB(c) {
		// Phase 1 C 路：新表 register_log / audit_log / ip_blocklist + 索引
		// + setting 新列（契约 §1）+ perm 种子行 37–42（契约 §4）。
		// 每组语句独立 try/catch + console.warn，沿用现有迁移风格。
		// 注意：部署后必须核对 pragma_table_info，不要静默以为成功。
		try {
			await c.env.db.batch([
				c.env.db.prepare(`CREATE TABLE IF NOT EXISTS register_log (
					log_id INTEGER PRIMARY KEY AUTOINCREMENT,
					ip TEXT NOT NULL DEFAULT '',
					ip_segment TEXT NOT NULL DEFAULT '',
					email TEXT NOT NULL DEFAULT '',
					reg_key_code TEXT NOT NULL DEFAULT '',
					result INTEGER NOT NULL DEFAULT 0,
					fail_reason TEXT NOT NULL DEFAULT '',
					verify_mode INTEGER NOT NULL DEFAULT 0,
					ua TEXT NOT NULL DEFAULT '',
					create_time DATETIME DEFAULT CURRENT_TIMESTAMP
				)`),
				c.env.db.prepare(`CREATE TABLE IF NOT EXISTS audit_log (
					log_id INTEGER PRIMARY KEY AUTOINCREMENT,
					actor_user_id INTEGER NOT NULL DEFAULT 0,
					action TEXT NOT NULL DEFAULT '',
					target_type TEXT NOT NULL DEFAULT '',
					target_id TEXT NOT NULL DEFAULT '',
					ip TEXT NOT NULL DEFAULT '',
					ua TEXT NOT NULL DEFAULT '',
					detail TEXT NOT NULL DEFAULT '',
					create_time DATETIME DEFAULT CURRENT_TIMESTAMP
				)`),
				c.env.db.prepare(`CREATE TABLE IF NOT EXISTS ip_blocklist (
					block_id INTEGER PRIMARY KEY AUTOINCREMENT,
					ip TEXT NOT NULL DEFAULT '',
					ip_segment TEXT NOT NULL DEFAULT '',
					scope INTEGER NOT NULL DEFAULT 0,
					reason TEXT NOT NULL DEFAULT '',
					expire_time DATETIME,
					created_by TEXT NOT NULL DEFAULT '',
					create_time DATETIME DEFAULT CURRENT_TIMESTAMP
				)`)
			]);
		} catch (e) {
			console.warn(`跳过建表：${e.message}`);
		}

		try {
			await c.env.db.batch([
				c.env.db.prepare(`CREATE INDEX IF NOT EXISTS idx_register_log_segment_time ON register_log(ip_segment, create_time)`),
				c.env.db.prepare(`CREATE INDEX IF NOT EXISTS idx_register_log_create_time ON register_log(create_time)`),
				c.env.db.prepare(`CREATE INDEX IF NOT EXISTS idx_register_log_ip_time ON register_log(ip, create_time)`),
				c.env.db.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_log_create_time ON audit_log(create_time)`),
				c.env.db.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_log_actor_time ON audit_log(actor_user_id, create_time)`),
				c.env.db.prepare(`CREATE INDEX IF NOT EXISTS idx_ip_blocklist_ip ON ip_blocklist(ip)`),
				c.env.db.prepare(`CREATE INDEX IF NOT EXISTS idx_ip_blocklist_segment ON ip_blocklist(ip_segment)`),
				c.env.db.prepare(`CREATE INDEX IF NOT EXISTS idx_user_create_ip ON user(create_ip)`),
				c.env.db.prepare(`CREATE INDEX IF NOT EXISTS idx_verify_record_ip_type ON verify_record(ip, type)`)
			]);
		} catch (e) {
			console.warn(`跳过索引：${e.message}`);
		}

		// setting 新列（契约 §1）：D1 侧；entity/setting.js 的 ORM 列由 B 路文件归属，见汇报。
		const SETTING_COLUMN_SQL_LIST = [
			`ALTER TABLE setting ADD COLUMN ip_reg_limit INTEGER NOT NULL DEFAULT 3;`,
			`ALTER TABLE setting ADD COLUMN ip_reg_window_hours INTEGER NOT NULL DEFAULT 24;`,
			`ALTER TABLE setting ADD COLUMN reg_rate_limit_per_min INTEGER NOT NULL DEFAULT 5;`,
			`ALTER TABLE setting ADD COLUMN reg_circuit_threshold INTEGER NOT NULL DEFAULT 20;`,
			`ALTER TABLE setting ADD COLUMN reg_circuit_open INTEGER NOT NULL DEFAULT 0;`,
			`ALTER TABLE setting ADD COLUMN resend_day_budget INTEGER NOT NULL DEFAULT 100;`,
			`ALTER TABLE setting ADD COLUMN resend_month_budget INTEGER NOT NULL DEFAULT 3000;`
		];
		for (const sql of SETTING_COLUMN_SQL_LIST) {
			try {
				await c.env.db.prepare(sql).run();
			} catch (e) {
				console.warn(`跳过字段：${e.message}`);
			}
		}

		// perm 种子行 37–42（契约 §4）：逐行 INSERT...SELECT...WHERE NOT EXISTS，幂等。
		const PERM_SEED_SQL_LIST = [
			`INSERT INTO perm (perm_id, name, perm_key, pid, type, sort) SELECT 37, 'IP黑名单', NULL, 0, 1, 5.2 WHERE NOT EXISTS (SELECT 1 FROM perm WHERE perm_id = 37)`,
			`INSERT INTO perm (perm_id, name, perm_key, pid, type, sort) SELECT 38, '黑名单查看', 'ip-block:query', 37, 2, 0 WHERE NOT EXISTS (SELECT 1 FROM perm WHERE perm_id = 38)`,
			`INSERT INTO perm (perm_id, name, perm_key, pid, type, sort) SELECT 39, '黑名单管理', 'ip-block:set', 37, 2, 1 WHERE NOT EXISTS (SELECT 1 FROM perm WHERE perm_id = 39)`,
			`INSERT INTO perm (perm_id, name, perm_key, pid, type, sort) SELECT 40, '风控日志', NULL, 0, 1, 5.3 WHERE NOT EXISTS (SELECT 1 FROM perm WHERE perm_id = 40)`,
			`INSERT INTO perm (perm_id, name, perm_key, pid, type, sort) SELECT 41, '注册日志查看', 'register-log:query', 40, 2, 0 WHERE NOT EXISTS (SELECT 1 FROM perm WHERE perm_id = 41)`,
			`INSERT INTO perm (perm_id, name, perm_key, pid, type, sort) SELECT 42, '审计日志查看', 'audit-log:query', 40, 2, 1 WHERE NOT EXISTS (SELECT 1 FROM perm WHERE perm_id = 42)`
		];
		for (const sql of PERM_SEED_SQL_LIST) {
			try {
				await c.env.db.prepare(sql).run();
			} catch (e) {
				console.warn(`跳过数据：${e.message}`);
			}
		}
	},

	async v3_6DB(c) {
		// Phase 2–4 总协调：新表 login_log / alert_log + 索引
		// + setting 新列 reg_key_alert_threshold + perm 种子行 43–45（契约 §1）。
		// 每组语句独立 try/catch + console.warn，沿用现有迁移风格。
		// 注意：部署后必须核对 pragma_table_info，不要静默以为成功。
		try {
			await c.env.db.batch([
				c.env.db.prepare(`CREATE TABLE IF NOT EXISTS login_log (
					log_id INTEGER PRIMARY KEY AUTOINCREMENT,
					user_id INTEGER NOT NULL DEFAULT 0,
					email TEXT NOT NULL DEFAULT '',
					ip TEXT NOT NULL DEFAULT '',
					ua TEXT NOT NULL DEFAULT '',
					is_new_ip INTEGER NOT NULL DEFAULT 0,
					create_time DATETIME DEFAULT CURRENT_TIMESTAMP
				)`),
				c.env.db.prepare(`CREATE TABLE IF NOT EXISTS alert_log (
					log_id INTEGER PRIMARY KEY AUTOINCREMENT,
					type TEXT NOT NULL DEFAULT 'system',
					text TEXT NOT NULL DEFAULT '',
					source TEXT NOT NULL DEFAULT 'worker',
					create_time DATETIME DEFAULT CURRENT_TIMESTAMP
				)`)
			]);
		} catch (e) {
			console.warn(`跳过建表：${e.message}`);
		}

		try {
			await c.env.db.batch([
				c.env.db.prepare(`CREATE INDEX IF NOT EXISTS idx_login_log_user_time ON login_log(user_id, create_time)`),
				c.env.db.prepare(`CREATE INDEX IF NOT EXISTS idx_login_log_create_time ON login_log(create_time)`),
				c.env.db.prepare(`CREATE INDEX IF NOT EXISTS idx_alert_log_create_time ON alert_log(create_time)`),
				c.env.db.prepare(`CREATE INDEX IF NOT EXISTS idx_alert_log_type_time ON alert_log(type, create_time)`)
			]);
		} catch (e) {
			console.warn(`跳过索引：${e.message}`);
		}

		// setting 新列：注册密钥库存告警阈值（总量低于此值告警，默认 500）。
		try {
			await c.env.db.prepare(`ALTER TABLE setting ADD COLUMN reg_key_alert_threshold INTEGER NOT NULL DEFAULT 500;`).run();
		} catch (e) {
			console.warn(`跳过字段：${e.message}`);
		}

		// user 新列：用户语言偏好（Phase 2–4 第四阶段；空 = 跟随浏览器/默认中文）。
		try {
			await c.env.db.prepare(`ALTER TABLE user ADD COLUMN locale TEXT NOT NULL DEFAULT '';`).run();
		} catch (e) {
			console.warn(`跳过字段：${e.message}`);
		}

		// perm 种子行 43–45（契约 §1）：逐行 INSERT...SELECT...WHERE NOT EXISTS，幂等。
		const PERM_SEED_SQL_LIST_36 = [
			`INSERT INTO perm (perm_id, name, perm_key, pid, type, sort) SELECT 43, '告警中心', NULL, 0, 1, 5.4 WHERE NOT EXISTS (SELECT 1 FROM perm WHERE perm_id = 43)`,
			`INSERT INTO perm (perm_id, name, perm_key, pid, type, sort) SELECT 44, '告警查看', 'alert:query', 43, 2, 0 WHERE NOT EXISTS (SELECT 1 FROM perm WHERE perm_id = 44)`,
			`INSERT INTO perm (perm_id, name, perm_key, pid, type, sort) SELECT 45, '用户导出', 'user:export', 6, 2, 8 WHERE NOT EXISTS (SELECT 1 FROM perm WHERE perm_id = 45)`
		];
		for (const sql of PERM_SEED_SQL_LIST_36) {
			try {
				await c.env.db.prepare(sql).run();
			} catch (e) {
				console.warn(`跳过数据：${e.message}`);
			}
		}
	},

	async v3_7DB(c) {
		// Phase 6：新表 user_totp / user_passkey / user_security + 索引
		// + setting 新列 log_retention_days / log_ip_mask + email 新列 e2ee（契约 §1.1）。
		// 每组语句独立 try/catch + console.warn，沿用 v3_5DB/v3_6DB 风格；
		// 不改任何现有列定义；部署后须核对 pragma_table_info。
		try {
			await c.env.db.batch([
				c.env.db.prepare(`CREATE TABLE IF NOT EXISTS user_totp (
					user_id INTEGER PRIMARY KEY,
					secret_encrypted TEXT NOT NULL DEFAULT '',
					enabled INTEGER NOT NULL DEFAULT 0,
					backup_codes_hash TEXT NOT NULL DEFAULT '[]',
					created_time DATETIME DEFAULT CURRENT_TIMESTAMP
				)`),
				c.env.db.prepare(`CREATE TABLE IF NOT EXISTS user_passkey (
					credential_id TEXT PRIMARY KEY,
					user_id INTEGER NOT NULL DEFAULT 0,
					public_key_jwk TEXT NOT NULL DEFAULT '',
					counter INTEGER NOT NULL DEFAULT 0,
					transports TEXT NOT NULL DEFAULT '[]',
					name TEXT NOT NULL DEFAULT '',
					created_time DATETIME DEFAULT CURRENT_TIMESTAMP
				)`),
				c.env.db.prepare(`CREATE TABLE IF NOT EXISTS user_security (
					user_id INTEGER PRIMARY KEY,
					login_alert INTEGER NOT NULL DEFAULT 1,
					e2ee_enabled INTEGER NOT NULL DEFAULT 0,
					retention_days INTEGER NOT NULL DEFAULT 0,
					e2ee_salt TEXT NOT NULL DEFAULT '',
					created_time DATETIME DEFAULT CURRENT_TIMESTAMP
				)`)
			]);
		} catch (e) {
			console.warn(`跳过建表：${e.message}`);
		}

		try {
			await c.env.db.batch([
				c.env.db.prepare(`CREATE INDEX IF NOT EXISTS idx_user_passkey_user ON user_passkey(user_id)`)
			]);
		} catch (e) {
			console.warn(`跳过索引：${e.message}`);
		}

		// setting 新列 + email 新列：逐条 ALTER，列已存在时抛错只记 warn（幂等）。
		const COLUMN_SQL_LIST = [
			`ALTER TABLE setting ADD COLUMN log_retention_days INTEGER NOT NULL DEFAULT 90;`,
			`ALTER TABLE setting ADD COLUMN log_ip_mask INTEGER NOT NULL DEFAULT 0;`,
			`ALTER TABLE email ADD COLUMN e2ee INTEGER NOT NULL DEFAULT 0;`
		];
		for (const sql of COLUMN_SQL_LIST) {
			try {
				await c.env.db.prepare(sql).run();
			} catch (e) {
				console.warn(`跳过字段：${e.message}`);
			}
		}
	},

	async v3_8DB(c) {
		// Phase 7：user_security 新列 auto_lock_minutes（闲置自动锁定，默认 0=从不）；
		// 日志 IP 脱敏默认开启：把现存 setting.log_ip_mask=0 改为 1（该开关无前端入口，
		// 无人能主动设为 0；写入脱敏只影响 ip 列，ip_segment 与限额/封禁不受影响）。
		// 逐条独立 try/catch + console.warn，幂等。
		try {
			await c.env.db.prepare(`ALTER TABLE user_security ADD COLUMN auto_lock_minutes INTEGER NOT NULL DEFAULT 0;`).run();
		} catch (e) {
			console.warn(`跳过字段：${e.message}`);
		}
		try {
			await c.env.db.prepare(`UPDATE setting SET log_ip_mask = 1 WHERE log_ip_mask = 0;`).run();
		} catch (e) {
			console.warn(`跳过脱敏默认开启：${e.message}`);
		}
	},

	async v3_9DB(c) {
		// Phase 7（AI 后端）：setting 新列 ai_enabled（直白布尔语义：1 = 开启
		// （默认），0 = 关闭；注意与站内多数 0=OPEN / 1=CLOSE 的反向开关不同）。
		// 逐条独立 try/catch + console.warn，幂等。
		try {
			await c.env.db.prepare(`ALTER TABLE setting ADD COLUMN ai_enabled INTEGER NOT NULL DEFAULT 1;`).run();
		} catch (e) {
			console.warn(`跳过字段：${e.message}`);
		}
	},

	async v3_10DB(c) {
		// Phase 7（壁纸系统）：user 新列 wallpaper / wallpaper_tags。
		// wallpaper：当前壁纸值——预置为清单 id（如 snowden-vista），
		// 自定义上传为 /oss/wallpapers/{userId}/{时间戳}.{ext}；空 = 默认 snowden-vista。
		// wallpaper_tags：用户点的喜好标签，逗号分隔（如 隐私,电影感），供“为你推荐”匹配。
		// 逐条独立 try/catch + console.warn，幂等。
		const COLUMN_SQL_LIST = [
			`ALTER TABLE user ADD COLUMN wallpaper TEXT NOT NULL DEFAULT '';`,
			`ALTER TABLE user ADD COLUMN wallpaper_tags TEXT NOT NULL DEFAULT '';`
		];
		for (const sql of COLUMN_SQL_LIST) {
			try {
				await c.env.db.prepare(sql).run();
			} catch (e) {
				console.warn(`跳过字段：${e.message}`);
			}
		}
	},

	async v3_11DB(c) {
		// Phase 8：默认角色修正（根因 ② 的正式产品决策落地）+ 全部新表/新列。
		// 普通用户（role_id=1）原来种子是 send_type='ban'、send_count=NULL，
		// 普通用户根本发不了信。正式决策：send_type='day'、send_count=50
		// （每天 50 封站外信；站内信不受此限；管理员不限，现有行为不变）。
		// 只修已知的坏种子值（WHERE role_id=1 AND send_type='ban'）；
		// 管理员已 deliberate 改过的值（day/50 以外、count 等）一律不动。
		// 新鲜安装的种子已同步改为 day/50（见本文件 role 种子行）。
		// 其余语句：B（登录限流阈值 + user.pwd_changed_at + 审计索引）、
		// C（ai_chat 对话历史 + translate_cache 翻译缓存）、E（email 信任列 +
		// trusted_sender / mail_prefs / spam_feedback / pending_send /
		// scheduled_email）、F（contacts / mail_rules / email_label /
		// mail_rule_log / user_recovery_code / user_recovery_email /
		// password_reset_token / known_ip）。
		// 注意：email 表的新列（auth_spf 等）故意不进 entity/email.js——
		// 实体加列会让未合并 DDL 的既有测试直接崩；新列一律经 raw SQL 访问 +
		// hasEmailTrustColumns() 探测降级（见 mail-trust-service）。
		// 逐条独立 try/catch + console.warn，幂等、可重跑。
		const SQL_LIST = [
			`UPDATE role SET send_type = 'day', send_count = 50 WHERE role_id = 1 AND send_type = 'ban';`,
			// B：登录限流阈值（管理员可调；缺失用代码默认值兜底）
			`ALTER TABLE setting ADD COLUMN login_rate_limit_window_min INTEGER NOT NULL DEFAULT 15;`,
			`ALTER TABLE setting ADD COLUMN login_rate_limit_ip_max INTEGER NOT NULL DEFAULT 5;`,
			`ALTER TABLE setting ADD COLUMN login_rate_limit_acct_max INTEGER NOT NULL DEFAULT 5;`,
			`ALTER TABLE setting ADD COLUMN login_rate_limit_lock_base_min INTEGER NOT NULL DEFAULT 5;`,
			// B：密码年龄（改密路径写 pwd_changed_at；迁移前读 create_time 回落）
			`ALTER TABLE user ADD COLUMN pwd_changed_at TEXT;`,
			`CREATE INDEX IF NOT EXISTS idx_audit_log_actor_time ON audit_log(actor_user_id, create_time);`,
			// C：AI 对话历史（30 天保留，由 assistant-service 随调用清理）
			`CREATE TABLE IF NOT EXISTS ai_chat (
				chat_id INTEGER PRIMARY KEY AUTOINCREMENT,
				user_id INTEGER NOT NULL,
				role TEXT NOT NULL,
				content TEXT NOT NULL DEFAULT '',
				created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
			);`,
			`CREATE INDEX IF NOT EXISTS idx_ai_chat_user_time ON ai_chat(user_id, created_at);`,
			// C：翻译缓存（键为内容 SHA-256 + 语种对，不含用户身份）
			`CREATE TABLE IF NOT EXISTS translate_cache (
				source_hash TEXT PRIMARY KEY,
				source_lang TEXT NOT NULL DEFAULT '',
				target_lang TEXT NOT NULL DEFAULT '',
				result TEXT NOT NULL DEFAULT '',
				created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
			);`,
			`CREATE INDEX IF NOT EXISTS idx_translate_cache_time ON translate_cache(created_at);`,
			// E：邮件信任列（SPF/DKIM/DMARC 结论 + 退订 + 垃圾标记）
			`ALTER TABLE email ADD COLUMN auth_spf TEXT NOT NULL DEFAULT '';`,
			`ALTER TABLE email ADD COLUMN auth_dkim TEXT NOT NULL DEFAULT '';`,
			`ALTER TABLE email ADD COLUMN auth_dmarc TEXT NOT NULL DEFAULT '';`,
			`ALTER TABLE email ADD COLUMN unsubscribe_url TEXT NOT NULL DEFAULT '';`,
			`ALTER TABLE email ADD COLUMN unsubscribe_mailto TEXT NOT NULL DEFAULT '';`,
			`ALTER TABLE email ADD COLUMN unsubscribe_one_click INTEGER NOT NULL DEFAULT 0;`,
			`ALTER TABLE email ADD COLUMN is_spam INTEGER NOT NULL DEFAULT 0;`,
			`CREATE INDEX IF NOT EXISTS idx_email_is_spam ON email(user_id, type, is_spam);`,
			`CREATE TABLE IF NOT EXISTS trusted_sender (
				user_id INTEGER NOT NULL,
				sender_email TEXT NOT NULL,
				created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				PRIMARY KEY (user_id, sender_email)
			);`,
			`CREATE TABLE IF NOT EXISTS mail_prefs (
				user_id INTEGER PRIMARY KEY,
				undo_seconds INTEGER NOT NULL DEFAULT 10,
				remote_images INTEGER NOT NULL DEFAULT 0,
				forward_email TEXT NOT NULL DEFAULT ''
			);`,
			`CREATE TABLE IF NOT EXISTS spam_feedback (
				feedback_id INTEGER PRIMARY KEY AUTOINCREMENT,
				user_id INTEGER NOT NULL,
				email_id INTEGER NOT NULL,
				sender_email TEXT NOT NULL DEFAULT '',
				subject TEXT NOT NULL DEFAULT '',
				kind TEXT NOT NULL,
				created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				UNIQUE (user_id, email_id, kind)
			);`,
			`CREATE INDEX IF NOT EXISTS idx_spam_feedback_sender ON spam_feedback(sender_email);`,
			`CREATE TABLE IF NOT EXISTS pending_send (
				pending_id INTEGER PRIMARY KEY AUTOINCREMENT,
				user_id INTEGER NOT NULL,
				payload TEXT NOT NULL DEFAULT '',
				undo_until TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending',
				result TEXT NOT NULL DEFAULT '',
				error TEXT NOT NULL DEFAULT '',
				created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
			);`,
			`CREATE INDEX IF NOT EXISTS idx_pending_send_due ON pending_send(status, undo_until);`,
			`CREATE TABLE IF NOT EXISTS scheduled_email (
				scheduled_id INTEGER PRIMARY KEY AUTOINCREMENT,
				user_id INTEGER NOT NULL,
				account_id INTEGER NOT NULL,
				payload TEXT NOT NULL DEFAULT '',
				scheduled_at TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending',
				attempts INTEGER NOT NULL DEFAULT 0,
				result TEXT NOT NULL DEFAULT '',
				error TEXT NOT NULL DEFAULT '',
				created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				sent_at TEXT
			);`,
			`CREATE INDEX IF NOT EXISTS idx_scheduled_email_due ON scheduled_email(status, scheduled_at);`,
			// F：联系人 / 邮件规则 / 标签 / 规则日志
			`CREATE TABLE IF NOT EXISTS contacts (
				contact_id INTEGER PRIMARY KEY AUTOINCREMENT,
				user_id INTEGER NOT NULL,
				name TEXT NOT NULL DEFAULT '',
				email TEXT NOT NULL DEFAULT '',
				created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				UNIQUE (user_id, email)
			);`,
			`CREATE TABLE IF NOT EXISTS mail_rules (
				rule_id INTEGER PRIMARY KEY AUTOINCREMENT,
				user_id INTEGER NOT NULL,
				name TEXT NOT NULL DEFAULT '',
				condition_json TEXT NOT NULL DEFAULT '{}',
				action_json TEXT NOT NULL DEFAULT '[]',
				enabled INTEGER NOT NULL DEFAULT 1,
				sort INTEGER NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
			);`,
			`CREATE TABLE IF NOT EXISTS email_label (
				label_id INTEGER PRIMARY KEY AUTOINCREMENT,
				user_id INTEGER NOT NULL,
				email_id INTEGER NOT NULL,
				label TEXT NOT NULL DEFAULT '',
				created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				UNIQUE (user_id, email_id, label)
			);`,
			`CREATE TABLE IF NOT EXISTS mail_rule_log (
				log_id INTEGER PRIMARY KEY AUTOINCREMENT,
				user_id INTEGER NOT NULL,
				rule_id INTEGER NOT NULL,
				email_id INTEGER NOT NULL,
				actions_json TEXT NOT NULL DEFAULT '[]',
				created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
			);`,
			// F：账号恢复（恢复码只存 SHA-256；token 只存哈希、1 小时、一次性）
			`CREATE TABLE IF NOT EXISTS user_recovery_code (
				code_id INTEGER PRIMARY KEY AUTOINCREMENT,
				user_id INTEGER NOT NULL,
				code_hash TEXT NOT NULL DEFAULT '',
				used INTEGER NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				used_at TEXT
			);`,
			`CREATE TABLE IF NOT EXISTS user_recovery_email (
				user_id INTEGER PRIMARY KEY,
				backup_email TEXT NOT NULL DEFAULT '',
				verified INTEGER NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
			);`,
			`CREATE TABLE IF NOT EXISTS password_reset_token (
				token_id INTEGER PRIMARY KEY AUTOINCREMENT,
				user_id INTEGER NOT NULL,
				token_hash TEXT NOT NULL DEFAULT '',
				expires_at TEXT NOT NULL DEFAULT '',
				used INTEGER NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				used_at TEXT
			);`,
			`CREATE TABLE IF NOT EXISTS known_ip (
				known_id INTEGER PRIMARY KEY AUTOINCREMENT,
				user_id INTEGER NOT NULL,
				ip TEXT NOT NULL DEFAULT '',
				first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				UNIQUE (user_id, ip)
			);`,
			`CREATE INDEX IF NOT EXISTS idx_contacts_user_email ON contacts(user_id, email);`,
			`CREATE INDEX IF NOT EXISTS idx_mail_rules_user_sort ON mail_rules(user_id, sort);`,
			`CREATE INDEX IF NOT EXISTS idx_recovery_code_user ON user_recovery_code(user_id, used);`,
			`CREATE INDEX IF NOT EXISTS idx_reset_token_user ON password_reset_token(user_id, used);`
		];
		for (const sql of SQL_LIST) {
			try {
				await c.env.db.prepare(sql).run();
			} catch (e) {
				console.warn(`跳过 Phase 8 迁移语句：${e.message}`);
			}
		}
	},

	async v3_12DB(c) {
		// 个人新邮件转发（通知）：mail_prefs 新列 forward_email，收件人配了该地址时，
		// 收信流程把原信转发一份过去，用户在常用邮箱里就能收到新邮件提醒。
		// 空 = 不转发。逐条独立 try/catch + console.warn，幂等、可重跑。
		const COLUMN_SQL_LIST = [
			`ALTER TABLE mail_prefs ADD COLUMN forward_email TEXT NOT NULL DEFAULT '';`
		];
		for (const sql of COLUMN_SQL_LIST) {
			try {
				await c.env.db.prepare(sql).run();
			} catch (e) {
				console.warn(`跳过字段：${e.message}`);
			}
		}
	},

	async v3_13DB(c) {
		// 用户自助绑定 Telegram：user 新列 tg_chat_id / tg_bind_code / tg_bind_expires，
		// setting 新列 tg_user_push（0=开启（默认）/ 1=关闭），user.tg_bind_code 索引。
		// 逐条独立 try/catch + console.warn，幂等、可重跑。
		const COLUMN_SQL_LIST = [
			`ALTER TABLE user ADD COLUMN tg_chat_id TEXT NOT NULL DEFAULT '';`,
			`ALTER TABLE user ADD COLUMN tg_bind_code TEXT NOT NULL DEFAULT '';`,
			`ALTER TABLE user ADD COLUMN tg_bind_expires TEXT NOT NULL DEFAULT '';`,
			`ALTER TABLE setting ADD COLUMN tg_user_push INTEGER NOT NULL DEFAULT 0;`,
			`CREATE INDEX IF NOT EXISTS idx_user_tg_bind_code ON user(tg_bind_code);`
		];
		for (const sql of COLUMN_SQL_LIST) {
			try {
				await c.env.db.prepare(sql).run();
			} catch (e) {
				console.warn(`跳过字段：${e.message}`);
			}
		}
	},

	async v3_14DB(c) {
		// 斯诺登三件套：自毁邮件（email 新列 expire_at / burn_after_read / expire_group）、
		// 一次性别名（email_alias 新表）、金丝雀日期（setting 新列 canary_date，默认部署当天）。
		// 逐条独立 try/catch + console.warn，幂等、可重跑。
		const COLUMN_SQL_LIST = [
			`ALTER TABLE email ADD COLUMN expire_at TEXT NOT NULL DEFAULT '';`,
			`ALTER TABLE email ADD COLUMN burn_after_read INTEGER NOT NULL DEFAULT 0;`,
			`ALTER TABLE email ADD COLUMN expire_group TEXT NOT NULL DEFAULT '';`,
			`CREATE TABLE IF NOT EXISTS email_alias (
				alias_id INTEGER PRIMARY KEY AUTOINCREMENT,
				user_id INTEGER NOT NULL,
				account_id INTEGER NOT NULL,
				local_part TEXT NOT NULL,
				domain TEXT NOT NULL,
				address TEXT NOT NULL,
				status INTEGER NOT NULL DEFAULT 0,
				recv_count INTEGER NOT NULL DEFAULT 0,
				create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
				is_del INTEGER NOT NULL DEFAULT 0
			);`,
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_alias_address ON email_alias(address);`,
			`CREATE INDEX IF NOT EXISTS idx_alias_user ON email_alias(user_id);`,
			`CREATE INDEX IF NOT EXISTS idx_email_expire_at ON email(expire_at);`,
			`ALTER TABLE setting ADD COLUMN canary_date TEXT NOT NULL DEFAULT '2026-11-09';`
		];
		for (const sql of COLUMN_SQL_LIST) {
			try {
				await c.env.db.prepare(sql).run();
			} catch (e) {
				console.warn(`跳过字段：${e.message}`);
			}
		}
	},

	async v3_15DB(c) {
		// 斯诺登第二批（进阶 4 项）：
		// ① 发件人隐身：email.sealed_sender（密封发件人信封，收件行明文发件人置空时用它恢复发件人）；
		// ② 前向保密 + ③ 抗量子：email.cek_wrapped（按收件人包裹的一次性密钥）/ cek_alg
		//    （''=旧版直接密钥加密，'sym'=对称 KEK 包裹，'mlkem768'=ML-KEM-768 包裹）/
		//    e2ee_ver（1=旧版正文直接用 KEK 加密，2=正文用 CEK 加密）；
		// ③ 抗量子密钥：user_security.mlkem_public_key（ML-KEM-768 封装公钥，可公开）/
		//    mlkem_priv_enc（ML-KEM-768 解封私钥，经用户 KEK 加密后存放，服务端无法解密）；
		// ④ 死亡开关：dead_man_switch 新表（每用户一行）。
		// 逐条独立 try/catch + console.warn，幂等、可重跑。
		const COLUMN_SQL_LIST = [
			`ALTER TABLE email ADD COLUMN sealed_sender TEXT NOT NULL DEFAULT '';`,
			`ALTER TABLE email ADD COLUMN cek_wrapped TEXT NOT NULL DEFAULT '';`,
			`ALTER TABLE email ADD COLUMN cek_alg TEXT NOT NULL DEFAULT '';`,
			`ALTER TABLE email ADD COLUMN e2ee_ver INTEGER NOT NULL DEFAULT 1;`,
			`ALTER TABLE user_security ADD COLUMN mlkem_public_key TEXT NOT NULL DEFAULT '';`,
			`ALTER TABLE user_security ADD COLUMN mlkem_priv_enc TEXT NOT NULL DEFAULT '';`,
			`CREATE TABLE IF NOT EXISTS dead_man_switch (
				user_id INTEGER PRIMARY KEY,
				enabled INTEGER NOT NULL DEFAULT 0,
				inactivity_days INTEGER NOT NULL DEFAULT 90,
				action TEXT NOT NULL DEFAULT 'delete',
				contact_email TEXT NOT NULL DEFAULT '',
				message TEXT NOT NULL DEFAULT '',
				warned_at TEXT NOT NULL DEFAULT '',
				executed_at TEXT NOT NULL DEFAULT '',
				status TEXT NOT NULL DEFAULT 'off',
				create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
				update_time DATETIME DEFAULT CURRENT_TIMESTAMP
			);`,
			`CREATE INDEX IF NOT EXISTS idx_email_sealed ON email(sealed_sender);`,
		];
		for (const sql of COLUMN_SQL_LIST) {
			try {
				await c.env.db.prepare(sql).run();
			} catch (e) {
				console.warn(`跳过字段：${e.message}`);
			}
		}
	},

	async v3_16DB(c) {
		// 斯诺登第三批（9 项）：
		// ① 胁迫密码 + ⑦ 隐藏邮箱（同一套第二密码机制）：user_decoy（第二密码 hash +
		//    salt）/ decoy_email（诱饵邮箱的种子邮件，诱饵会话只读这些）；
		// ② 可否认认证：email.deniable（可否认标记）/ deny_tag（CEK 对密文的 HMAC 标签，
		//    收件人同样持有 CEK，第三方无法证明是谁发的）；
		// ③ 邮件混淆：email.mix_deliver_at（站内投递生效时间，列表/最新邮件/未读
		//    计数在此时刻前不可见）/ mix_relay（逻辑中继编号）/ mix_notified
		//    （生效后转发/规则是否已补跑）；
		// ④ 可搜索加密（盲索引）：email_blind_index（email_id + user_id + token，
		//    服务端只匹配 token，不解密正文）；
		// ⑤ 时间锁加密：email.timelock_until（解锁时刻）/ timelock_key（到时才放行的
		//    CEK 包裹，解锁前 email.cek_wrapped 为空，读信解不开）；
		// ⑥ 密钥分片 Shamir 与 ⑧ 隐写术不需新表（分片与隐写纯前端）；
		// ⑨ 零知识身份：user.zk_salt / zk_verifier（服务端只存验证子，
		// zkVerifier = SHA-256(salt + password) base64，不存可逆凭证）。
		// 逐条独立 try/catch + console.warn，幂等、可重跑。
		const COLUMN_SQL_LIST = [
			`ALTER TABLE email ADD COLUMN mix_deliver_at TEXT NOT NULL DEFAULT '';`,
			`ALTER TABLE email ADD COLUMN mix_relay TEXT NOT NULL DEFAULT '';`,
			`ALTER TABLE email ADD COLUMN mix_notified INTEGER NOT NULL DEFAULT 0;`,
			`ALTER TABLE email ADD COLUMN timelock_until TEXT NOT NULL DEFAULT '';`,
			`ALTER TABLE email ADD COLUMN deniable INTEGER NOT NULL DEFAULT 0;`,
			`ALTER TABLE email ADD COLUMN deny_tag TEXT NOT NULL DEFAULT '';`,
			`ALTER TABLE user ADD COLUMN zk_salt TEXT NOT NULL DEFAULT '';`,
			`ALTER TABLE user ADD COLUMN zk_verifier TEXT NOT NULL DEFAULT '';`,
			`CREATE TABLE IF NOT EXISTS timelock_key (
				email_id INTEGER PRIMARY KEY,
				cek_wrapped TEXT NOT NULL DEFAULT '',
				cek_alg TEXT NOT NULL DEFAULT '',
				unlock_at TEXT NOT NULL DEFAULT '',
				released INTEGER NOT NULL DEFAULT 0
			);`,
			`CREATE TABLE IF NOT EXISTS email_blind_index (
				email_id INTEGER NOT NULL,
				user_id INTEGER NOT NULL,
				token TEXT NOT NULL,
				PRIMARY KEY (email_id, user_id, token)
			);`,
			`CREATE INDEX IF NOT EXISTS idx_blind_token ON email_blind_index(user_id, token);`,
			`CREATE TABLE IF NOT EXISTS user_decoy (
				user_id INTEGER PRIMARY KEY,
				password_hash TEXT NOT NULL DEFAULT '',
				salt TEXT NOT NULL DEFAULT '',
				enabled INTEGER NOT NULL DEFAULT 0,
				seeded INTEGER NOT NULL DEFAULT 0,
				create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
				update_time DATETIME DEFAULT CURRENT_TIMESTAMP
			);`,
			`CREATE TABLE IF NOT EXISTS decoy_email (
				decoy_id INTEGER PRIMARY KEY AUTOINCREMENT,
				user_id INTEGER NOT NULL,
				send_email TEXT NOT NULL DEFAULT '',
				name TEXT NOT NULL DEFAULT '',
				subject TEXT NOT NULL DEFAULT '',
				text TEXT NOT NULL DEFAULT '',
				content TEXT NOT NULL DEFAULT '',
				unread INTEGER NOT NULL DEFAULT 1,
				create_time DATETIME DEFAULT CURRENT_TIMESTAMP
			);`,
			`CREATE INDEX IF NOT EXISTS idx_decoy_user ON decoy_email(user_id);`,
			`CREATE INDEX IF NOT EXISTS idx_email_mix ON email(mix_deliver_at);`,
			`CREATE INDEX IF NOT EXISTS idx_email_timelock ON email(timelock_until);`,
		];
		for (const sql of COLUMN_SQL_LIST) {
			try {
				await c.env.db.prepare(sql).run();
			} catch (e) {
				console.warn(`跳过字段：${e.message}`);
			}
		}
	},

	async v3_4DB(c) {
		try {
			await c.env.db.prepare(`ALTER TABLE email ADD COLUMN sender_email TEXT NOT NULL DEFAULT '';`).run();
		} catch (e) {
			console.warn(`跳过字段：${e.message}`);
		}
	},

	async v3_3DB(c) {
		try {
			await c.env.db.batch([
				c.env.db.prepare(`ALTER TABLE setting ADD COLUMN auto_clean_days INTEGER NOT NULL DEFAULT 0;`),
				c.env.db.prepare(`ALTER TABLE setting ADD COLUMN auto_clean_exclude TEXT NOT NULL DEFAULT '';`),
				c.env.db.prepare(`CREATE INDEX IF NOT EXISTS idx_email_create_time ON email(create_time)`)
			]);
		} catch (e) {
			console.warn(`跳过字段：${e.message}`);
		}

		try {
			await c.env.db.batch([
				c.env.db.prepare(`ALTER TABLE setting ADD COLUMN webhook_url TEXT NOT NULL DEFAULT '';`),
				c.env.db.prepare(`ALTER TABLE setting ADD COLUMN webhook_status INTEGER NOT NULL DEFAULT 1;`),
				c.env.db.prepare(`ALTER TABLE setting ADD COLUMN webhook_retry INTEGER NOT NULL DEFAULT 0;`),
				c.env.db.prepare(`ALTER TABLE setting ADD COLUMN webhook_secret TEXT NOT NULL DEFAULT '';`)
			]);
		} catch (e) {
			console.warn(`跳过字段：${e.message}`);
		}
	},

	async v3_2DB(c) {
		try {
			await c.env.db.batch([
				await c.env.db.prepare(`ALTER TABLE setting ADD COLUMN linuxdo_client_id TEXT NOT NULL DEFAULT '';`),
				await c.env.db.prepare(`ALTER TABLE setting ADD COLUMN linuxdo_client_secret TEXT NOT NULL DEFAULT '';`),
				await c.env.db.prepare(`ALTER TABLE setting ADD COLUMN github_client_id TEXT NOT NULL DEFAULT '';`),
				await c.env.db.prepare(`ALTER TABLE setting ADD COLUMN github_client_secret TEXT NOT NULL DEFAULT '';`),
				await c.env.db.prepare(`ALTER TABLE setting ADD COLUMN google_client_id TEXT NOT NULL DEFAULT '';`),
				await c.env.db.prepare(`ALTER TABLE setting ADD COLUMN google_client_secret TEXT NOT NULL DEFAULT '';`),
				await c.env.db.prepare(`ALTER TABLE setting ADD COLUMN linuxdo_switch INTEGER NOT NULL DEFAULT 1;`),
				await c.env.db.prepare(`ALTER TABLE setting ADD COLUMN github_switch INTEGER NOT NULL DEFAULT 1;`),
				await c.env.db.prepare(`ALTER TABLE setting ADD COLUMN google_switch INTEGER NOT NULL DEFAULT 1;`)
			]);
		} catch (e) {
			console.warn(`跳过字段：${e.message}`);
		}

		try {
			await c.env.db.batch([
				c.env.db.prepare(`CREATE INDEX IF NOT EXISTS idx_email_list_user ON email(user_id, type, is_del, email_id)`),
				c.env.db.prepare(`CREATE INDEX IF NOT EXISTS idx_email_list_account ON email(user_id, account_id, type, is_del, email_id)`),
				c.env.db.prepare(`CREATE INDEX IF NOT EXISTS idx_star_user_email ON star(user_id, email_id)`),
				c.env.db.prepare(`CREATE INDEX IF NOT EXISTS idx_star_email_user ON star(email_id, user_id)`),
				c.env.db.prepare(`CREATE INDEX IF NOT EXISTS idx_email_name_nocase ON email(name COLLATE NOCASE)`),
				c.env.db.prepare(`CREATE INDEX IF NOT EXISTS idx_email_subject_nocase ON email(subject COLLATE NOCASE)`),
				c.env.db.prepare(`CREATE INDEX IF NOT EXISTS idx_user_email_nocase ON user(email COLLATE NOCASE)`),
				c.env.db.prepare(`CREATE INDEX IF NOT EXISTS idx_email_to_email_nocase ON email(to_email COLLATE NOCASE)`),
				c.env.db.prepare(`CREATE INDEX IF NOT EXISTS idx_email_send_email_nocase ON email(send_email COLLATE NOCASE)`),
				c.env.db.prepare(`CREATE INDEX IF NOT EXISTS idx_email_noone_id ON email(email_id) WHERE status = 7`),
				c.env.db.prepare(`CREATE INDEX IF NOT EXISTS idx_email_type_id ON email(type, email_id)`),
				c.env.db.prepare(`CREATE INDEX IF NOT EXISTS idx_account_user_del_sort ON account(user_id, is_del, sort, account_id)`),
				c.env.db.prepare(`CREATE INDEX IF NOT EXISTS idx_email_saving_account ON email(account_id) WHERE status = 6`),
				c.env.db.prepare(`CREATE INDEX IF NOT EXISTS idx_email_type_name ON email(type, name)`),
				c.env.db.prepare(`CREATE INDEX IF NOT EXISTS idx_email_type_create_time ON email(type, create_time)`),
				c.env.db.prepare(`CREATE INDEX IF NOT EXISTS idx_user_create_time ON user(create_time)`),
				c.env.db.prepare(`CREATE INDEX IF NOT EXISTS idx_user_type ON user(type)`),
				c.env.db.prepare(`CREATE INDEX IF NOT EXISTS idx_attachments_email_type ON attachments(email_id, type)`),
				c.env.db.prepare(`CREATE INDEX IF NOT EXISTS idx_role_perm_role ON role_perm(role_id)`),
				c.env.db.prepare(`CREATE INDEX IF NOT EXISTS idx_oauth_oauth_user_id ON oauth(oauth_user_id)`),
				c.env.db.prepare(`CREATE INDEX IF NOT EXISTS idx_oauth_user_id ON oauth(user_id)`)
			]);
		} catch (e) {
			console.warn(`跳过索引：${e.message}`);
		}
	},

	async v3_1DB(c) {
		try {
			await c.env.db.prepare(`ALTER TABLE setting ADD COLUMN sync_delete INTEGER NOT NULL DEFAULT 0;`).run();
		} catch (e) {
			console.warn(`跳过字段：${e.message}`);
		}
	},


	async v3_0DB(c) {
		try {
			await c.env.db.batch([
				await c.env.db.prepare(`ALTER TABLE email ADD COLUMN code TEXT NOT NULL DEFAULT '';`),
				await c.env.db.prepare(`ALTER TABLE setting ADD COLUMN ai_code INTEGER NOT NULL DEFAULT 1;`),
				await c.env.db.prepare(`ALTER TABLE setting ADD COLUMN ai_code_filter TEXT NOT NULL DEFAULT '';`)
			]);
		} catch (e) {
			console.warn(`跳过字段：${e.message}`);
		}

		try {
			await c.env.db.batch([
				c.env.db.prepare(`ALTER TABLE setting ADD COLUMN black_subject TEXT NOT NULL DEFAULT '';`),
				c.env.db.prepare(`ALTER TABLE setting ADD COLUMN black_content TEXT NOT NULL DEFAULT '';`),
				c.env.db.prepare(`ALTER TABLE setting ADD COLUMN black_from TEXT NOT NULL DEFAULT '';`)
			]);
		} catch (e) {
			console.warn(`跳过字段：${e.message}`);
		}

	},

	async v2_9DB(c) {
		try {
			await c.env.db.prepare(`UPDATE setting SET auto_refresh = 5 WHERE auto_refresh = 1;`).run();
		} catch (e) {
			console.warn(`跳过字段：${e.message}`);
		}
	},

	async v2_8DB(c) {
		try {
			await c.env.db.batch([
				c.env.db.prepare(`ALTER TABLE account ADD COLUMN sort INTEGER NOT NULL DEFAULT 0;`)
			]);
		} catch (e) {
			console.warn(`跳过字段：${e.message}`);
		}
	},

	async v2_7DB(c) {
		try {
			await c.env.db.batch([
				c.env.db.prepare(`ALTER TABLE setting RENAME COLUMN auto_refresh_time TO auto_refresh;`)
			]);
		} catch (e) {
			console.warn(`跳过字段：${e.message}`);
		}
	},

	async v2_6DB(c) {
		try {
			await c.env.db.prepare(`ALTER TABLE account ADD COLUMN all_receive INTEGER NOT NULL DEFAULT 0;`).run();
		} catch (e) {
			console.warn(`跳过字段：${e.message}`);
		}
	},

	async v2_5DB(c) {

		try {
			await c.env.db.prepare(`ALTER TABLE setting ADD COLUMN email_prefix_filter text NOT NULL DEFAULT '';`).run();
		} catch (e) {
			console.warn(`跳过字段：${e.message}`);
		}

		try {
			await c.env.db.batch([
				c.env.db.prepare(`ALTER TABLE email ADD COLUMN unread INTEGER NOT NULL DEFAULT 0;`),
				c.env.db.prepare(`UPDATE email SET unread = 1;`)
			]);
		} catch (e) {
			console.warn(`跳过字段：${e.message}`);
		}

	},

	async v2_4DB(c) {
		try {
			await c.env.db.prepare(`
				CREATE TABLE IF NOT EXISTS oauth (
					oauth_id INTEGER PRIMARY KEY AUTOINCREMENT,
					oauth_user_id TEXT,
					username TEXT,
					name TEXT,
					avatar TEXT,
					active INTEGER,
					trust_level INTEGER,
					silenced INTEGER,
					create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
					platform INTEGER NOT NULL DEFAULT 0,
					user_id INTEGER NOT NULL DEFAULT 0
				)
			`).run();
		} catch (e) {
			console.warn(`跳过字段：${e.message}`);
		}

		try {
			await c.env.db.prepare(`ALTER TABLE setting ADD COLUMN min_email_prefix INTEGER NOT NULL DEFAULT 1;`).run();
		} catch (e) {
			console.warn(`跳过字段：${e.message}`);
		}

	},

	async v2_3DB(c) {
		try {
			await c.env.db.batch([
				c.env.db.prepare(`ALTER TABLE setting ADD COLUMN force_path_style	INTEGER NOT NULL DEFAULT 1;`),
				c.env.db.prepare(`ALTER TABLE setting ADD COLUMN custom_domain TEXT NOT NULL DEFAULT '';`),
				c.env.db.prepare(`ALTER TABLE setting ADD COLUMN tg_msg_to TEXT NOT NULL DEFAULT 'show';`),
				c.env.db.prepare(`ALTER TABLE setting ADD COLUMN tg_msg_from TEXT NOT NULL DEFAULT 'only-name';`)
			]);
		} catch (e) {
			console.warn(`跳过字段：${e.message}`);
		}

		try {
			await c.env.db.prepare(`ALTER TABLE setting ADD COLUMN tg_msg_text TEXT NOT NULL DEFAULT 'show';`).run();
		} catch (e) {
			console.warn(`跳过字段：${e.message}`);
		}

	},

	async v2DB(c) {
		try {
			await c.env.db.batch([
				c.env.db.prepare(`ALTER TABLE setting ADD COLUMN bucket TEXT NOT NULL DEFAULT '';`),
				c.env.db.prepare(`ALTER TABLE setting ADD COLUMN region TEXT NOT NULL DEFAULT '';`),
				c.env.db.prepare(`ALTER TABLE setting ADD COLUMN endpoint TEXT NOT NULL DEFAULT '';`),
				c.env.db.prepare(`ALTER TABLE setting ADD COLUMN s3_access_key TEXT NOT NULL DEFAULT '';`),
				c.env.db.prepare(`ALTER TABLE setting ADD COLUMN s3_secret_key TEXT NOT NULL DEFAULT '';`),
				c.env.db.prepare(`DELETE FROM perm WHERE perm_key = 'setting:clean'`)
			]);
		} catch (e) {
			console.warn(`跳过字段：${e.message}`);
		}
	},

	async v1_7DB(c) {
		try {
			await c.env.db.prepare(`ALTER TABLE setting ADD COLUMN login_domain INTEGER NOT NULL DEFAULT 0;`).run();
		} catch (e) {
			console.warn(`跳过字段：${e.message}`);
		}
	},

	async v1_6DB(c) {

		const noticeContent = '本项目仅供学习交流，禁止用于违法业务\n' +
			'<br>\n' +
			'请遵守当地法规，作者不承担任何法律责任'

		const ADD_COLUMN_SQL_LIST = [
			`ALTER TABLE setting ADD COLUMN reg_verify_count INTEGER NOT NULL DEFAULT 1;`,
			`ALTER TABLE setting ADD COLUMN add_verify_count INTEGER NOT NULL DEFAULT 1;`,
			`CREATE TABLE IF NOT EXISTS verify_record (
				vr_id INTEGER PRIMARY KEY AUTOINCREMENT,
				ip TEXT NOT NULL DEFAULT '',
				count INTEGER NOT NULL DEFAULT 1,
				type INTEGER NOT NULL DEFAULT 0,
				update_time DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
			`ALTER TABLE setting ADD COLUMN notice_title TEXT NOT NULL DEFAULT 'Cloud Mail';`,
			`ALTER TABLE setting ADD COLUMN notice_content TEXT NOT NULL DEFAULT '';`,
			`ALTER TABLE setting ADD COLUMN notice_type TEXT NOT NULL DEFAULT 'none';`,
			`ALTER TABLE setting ADD COLUMN notice_duration INTEGER NOT NULL DEFAULT 0;`,
			`ALTER TABLE setting ADD COLUMN notice_offset INTEGER NOT NULL DEFAULT 0;`,
			`ALTER TABLE setting ADD COLUMN notice_position TEXT NOT NULL DEFAULT 'top-right';`,
			`ALTER TABLE setting ADD COLUMN notice_width INTEGER NOT NULL DEFAULT 340;`,
			`ALTER TABLE setting ADD COLUMN notice INTEGER NOT NULL DEFAULT 0;`,
			`ALTER TABLE setting ADD COLUMN no_recipient INTEGER NOT NULL DEFAULT 1;`,
			`UPDATE role SET avail_domain = '' WHERE role.avail_domain LIKE '@%';`,
			`CREATE INDEX IF NOT EXISTS idx_email_user_id_account_id ON email(user_id, account_id);`
		];

		const promises = ADD_COLUMN_SQL_LIST.map(async (sql) => {
			try {
				await c.env.db.prepare(sql).run();
			} catch (e) {
				console.warn(`跳过字段：${e.message}`);
			}
		});

		await Promise.all(promises);
		await c.env.db.prepare(`UPDATE setting SET notice_content = ? WHERE notice_content = '';`).bind(noticeContent).run();
		try {
			await c.env.db.batch([
				c.env.db.prepare(`DROP INDEX IF EXISTS idx_account_email`),
				c.env.db.prepare(`DROP INDEX IF EXISTS idx_user_email`),
				c.env.db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_account_email_nocase ON account (email COLLATE NOCASE)`),
				c.env.db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_email_nocase ON user (email COLLATE NOCASE)`)
			]);
		} catch (e) {
			console.warn(e.message)
		}

	},

	async v1_5DB(c) {
		await c.env.db.prepare(`UPDATE perm SET perm_key = 'all-email:query' WHERE perm_key = 'sys-email:query'`).run();
		await c.env.db.prepare(`UPDATE perm SET perm_key = 'all-email:delete' WHERE perm_key = 'sys-email:delete'`).run();
		try {
			await c.env.db.prepare(`ALTER TABLE role ADD COLUMN avail_domain TEXT NOT NULL DEFAULT ''`).run();
		} catch (e) {
			console.warn(`跳过字段添加：${e.message}`);
		}
	},

	async v1_4DB(c) {
		await c.env.db.prepare(`
      CREATE TABLE IF NOT EXISTS reg_key (
				rege_key_id INTEGER PRIMARY KEY AUTOINCREMENT,
				code TEXT NOT NULL COLLATE NOCASE DEFAULT '',
				count INTEGER NOT NULL DEFAULT 0,
				role_id INTEGER NOT NULL DEFAULT 0,
				user_id INTEGER NOT NULL DEFAULT 0,
				expire_time DATETIME,
				create_time DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

		// 添加不区分大小写的唯一索引
		try {
			await c.env.db.prepare(`
				CREATE UNIQUE INDEX IF NOT EXISTS idx_setting_code ON reg_key(code COLLATE NOCASE)
			`).run();
		} catch (e) {
			console.warn(`跳过创建索引：${e.message}`);
		}


		try {
			await c.env.db.prepare(`
        INSERT INTO perm (perm_id, name, perm_key, pid, type, sort) VALUES
        (33,'注册密钥', NULL, 0, 1, 5.1),
        (34,'密钥查看', 'reg-key:query', 33, 2, 0),
        (35,'密钥添加', 'reg-key:add', 33, 2, 1),
        (36,'密钥删除', 'reg-key:delete', 33, 2, 2)`).run();
		} catch (e) {
			console.warn(`跳过数据：${e.message}`);
		}

		const ADD_COLUMN_SQL_LIST = [
			`ALTER TABLE setting ADD COLUMN reg_key INTEGER NOT NULL DEFAULT 1;`,
			`ALTER TABLE role ADD COLUMN ban_email TEXT NOT NULL DEFAULT '';`,
			`ALTER TABLE role ADD COLUMN ban_email_type INTEGER NOT NULL DEFAULT 0;`,
			`ALTER TABLE user ADD COLUMN reg_key_id INTEGER NOT NULL DEFAULT 0;`
		];

		const promises = ADD_COLUMN_SQL_LIST.map(async (sql) => {
			try {
				await c.env.db.prepare(sql).run();
			} catch (e) {
				console.warn(`跳过字段添加：${e.message}`);
			}
		});

		await Promise.all(promises);

	},

	async v1_3_1DB(c) {
		await c.env.db.prepare(`UPDATE email SET name = SUBSTR(send_email, 1, INSTR(send_email, '@') - 1) WHERE (name IS NULL OR name = '') AND type = ${emailConst.type.RECEIVE}`).run();
	},

	async v1_3DB(c) {

		const ADD_COLUMN_SQL_LIST = [
			`ALTER TABLE setting ADD COLUMN tg_bot_token TEXT NOT NULL DEFAULT '';`,
			`ALTER TABLE setting ADD COLUMN tg_chat_id TEXT NOT NULL DEFAULT '';`,
			`ALTER TABLE setting ADD COLUMN tg_bot_status INTEGER NOT NULL DEFAULT 1;`,
			`ALTER TABLE setting ADD COLUMN forward_email TEXT NOT NULL DEFAULT '';`,
			`ALTER TABLE setting ADD COLUMN forward_status INTEGER TIME NOT NULL DEFAULT 1;`,
			`ALTER TABLE setting ADD COLUMN rule_email TEXT NOT NULL DEFAULT '';`,
			`ALTER TABLE setting ADD COLUMN rule_type INTEGER NOT NULL DEFAULT 0;`
		];

		const promises = ADD_COLUMN_SQL_LIST.map(async (sql) => {
			try {
				await c.env.db.prepare(sql).run();
			} catch (e) {
				console.warn(`跳过字段添加：${e.message}`);
			}
		});

		await Promise.all(promises);

		const nameColumn = await c.env.db.prepare(`SELECT * FROM pragma_table_info('email') WHERE name = 'to_email' limit 1`).first();

		if (nameColumn) {
			return
		}

		const queryList = []

		queryList.push(c.env.db.prepare(`ALTER TABLE email ADD COLUMN to_email TEXT NOT NULL DEFAULT ''`));
		queryList.push(c.env.db.prepare(`ALTER TABLE email ADD COLUMN to_name TEXT NOT NULL DEFAULT ''`));
		queryList.push(c.env.db.prepare(`UPDATE email SET to_email = json_extract(recipient, '$[0].address'), to_name = json_extract(recipient, '$[0].name')`));

		await c.env.db.batch(queryList);

	},

	async v1_2DB(c){

		const ADD_COLUMN_SQL_LIST = [
			`ALTER TABLE email ADD COLUMN recipient TEXT NOT NULL DEFAULT '[]';`,
			`ALTER TABLE email ADD COLUMN cc TEXT NOT NULL DEFAULT '[]';`,
			`ALTER TABLE email ADD COLUMN bcc TEXT NOT NULL DEFAULT '[]';`,
			`ALTER TABLE email ADD COLUMN message_id TEXT NOT NULL DEFAULT '';`,
			`ALTER TABLE email ADD COLUMN in_reply_to TEXT NOT NULL DEFAULT '';`,
			`ALTER TABLE email ADD COLUMN relation TEXT NOT NULL DEFAULT '';`
		];

		const promises = ADD_COLUMN_SQL_LIST.map(async (sql) => {
			try {
				await c.env.db.prepare(sql).run();
			} catch (e) {
				console.warn(`跳过字段添加：${e.message}`);
			}
		});

		await Promise.all(promises);

		await this.receiveEmailToRecipient(c);
		await this.initAccountName(c);

		try {
			await c.env.db.prepare(`
        INSERT INTO perm (perm_id, name, perm_key, pid, type, sort) VALUES
        (31,'分析页', NULL, 0, 1, 2.1),
        (32,'数据查看', 'analysis:query', 31, 2, 1)`).run();
		} catch (e) {
			console.warn(`跳过数据：${e.message}`);
		}

	},

	async v1_1DB(c) {
		// 添加字段
		const ADD_COLUMN_SQL_LIST = [
			`ALTER TABLE email ADD COLUMN type INTEGER NOT NULL DEFAULT 0;`,
			`ALTER TABLE email ADD COLUMN status INTEGER NOT NULL DEFAULT 0;`,
			`ALTER TABLE email ADD COLUMN resend_email_id TEXT;`,
			`ALTER TABLE email ADD COLUMN message TEXT;`,

			`ALTER TABLE setting ADD COLUMN resend_tokens TEXT NOT NULL DEFAULT '{}';`,
			`ALTER TABLE setting ADD COLUMN send INTEGER NOT NULL DEFAULT 0;`,
			`ALTER TABLE setting ADD COLUMN r2_domain TEXT;`,
			`ALTER TABLE setting ADD COLUMN site_key TEXT;`,
			`ALTER TABLE setting ADD COLUMN secret_key TEXT;`,
			`ALTER TABLE setting ADD COLUMN background TEXT;`,
			`ALTER TABLE setting ADD COLUMN login_opacity INTEGER NOT NULL DEFAULT 0.90;`,

			`ALTER TABLE user ADD COLUMN create_ip TEXT;`,
			`ALTER TABLE user ADD COLUMN active_ip TEXT;`,
			`ALTER TABLE user ADD COLUMN os TEXT;`,
			`ALTER TABLE user ADD COLUMN browser TEXT;`,
			`ALTER TABLE user ADD COLUMN device TEXT;`,
			`ALTER TABLE user ADD COLUMN sort INTEGER NOT NULL DEFAULT 0;`,
			`ALTER TABLE user ADD COLUMN send_count INTEGER NOT NULL DEFAULT 0;`,

			`ALTER TABLE attachments ADD COLUMN status INTEGER NOT NULL DEFAULT 0;`,
			`ALTER TABLE attachments ADD COLUMN type INTEGER NOT NULL DEFAULT 0;`
		];

		const promises = ADD_COLUMN_SQL_LIST.map(async (sql) => {
			try {
				await c.env.db.prepare(sql).run();
			} catch (e) {
				console.warn(`跳过字段添加：${e.message}`);
			}
		});

		await Promise.all(promises);

		// 创建 perm 表并初始化
		await c.env.db.prepare(`
      CREATE TABLE IF NOT EXISTS perm (
        perm_id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        perm_key TEXT,
        pid INTEGER NOT NULL DEFAULT 0,
        type INTEGER NOT NULL DEFAULT 2,
        sort INTEGER
      )
    `).run();

		const {permTotal} = await c.env.db.prepare(`SELECT COUNT(*) as permTotal FROM perm`).first();

		if (permTotal === 0) {
			await c.env.db.prepare(`
        INSERT INTO perm (perm_id, name, perm_key, pid, type, sort) VALUES
        (1, '邮件', NULL, 0, 0, 0),
        (2, '邮件删除', 'email:delete', 1, 2, 1),
        (3, '邮件发送', 'email:send', 1, 2, 0),
        (4, '个人设置', '', 0, 1, 2),
        (5, '用户注销', 'my:delete', 4, 2, 0),
        (6, '用户信息', NULL, 0, 1, 3),
        (7, '用户查看', 'user:query', 6, 2, 0),
        (8, '密码修改', 'user:set-pwd', 6, 2, 2),
        (9, '状态修改', 'user:set-status', 6, 2, 3),
        (10, '权限修改', 'user:set-type', 6, 2, 4),
        (11, '用户删除', 'user:delete', 6, 2, 7),
        (12, '用户收藏', 'user:star', 6, 2, 5),
        (13, '权限控制', '', 0, 1, 5),
        (14, '身份查看', 'role:query', 13, 2, 0),
        (15, '身份修改', 'role:set', 13, 2, 1),
        (16, '身份删除', 'role:delete', 13, 2, 2),
        (17, '系统设置', '', 0, 1, 6),
        (18, '设置查看', 'setting:query', 17, 2, 0),
        (19, '设置修改', 'setting:set', 17, 2, 1),
        (21, '邮箱侧栏', '', 0, 0, 1),
        (22, '邮箱查看', 'account:query', 21, 2, 0),
        (23, '邮箱添加', 'account:add', 21, 2, 1),
        (24, '邮箱删除', 'account:delete', 21, 2, 2),
        (25, '用户添加', 'user:add', 6, 2, 1),
        (26, '发件重置', 'user:reset-send', 6, 2, 6),
        (27, '邮件列表', '', 0, 1, 4),
        (28, '邮件查看', 'all-email:query', 27, 2, 0),
        (29, '邮件删除', 'all-email:delete', 27, 2, 0),
				(30, '身份添加', 'role:add', 13, 2, -1)
      `).run();
		}

		await c.env.db.prepare(`UPDATE perm SET perm_key = 'setting:clean' WHERE perm_key = 'seting:clear'`).run();
		await c.env.db.prepare(`DELETE FROM perm WHERE perm_key = 'user:star'`).run();
		// 创建 role 表并插入默认身份
		await c.env.db.prepare(`
      CREATE TABLE IF NOT EXISTS role (
        role_id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        key TEXT,
        create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        sort INTEGER DEFAULT 0,
        description TEXT,
        user_id INTEGER,
        is_default INTEGER DEFAULT 0,
        send_count INTEGER,
        send_type TEXT NOT NULL DEFAULT 'count',
        account_count INTEGER
      )
    `).run();

		const { roleCount } = await c.env.db.prepare(`SELECT COUNT(*) as roleCount FROM role`).first();
		if (roleCount === 0) {
			await c.env.db.prepare(`
        INSERT INTO role (
          role_id, name, key, create_time, sort, description, user_id, is_default, send_count, send_type, account_count
        ) VALUES (
          1, '普通用户', NULL, '0000-00-00 00:00:00', 0, '只有普通使用权限', 0, 1, 50, 'day', 10
        )
      `).run();
		}

		// 创建 role_perm 表并初始化数据
		await c.env.db.prepare(`
      CREATE TABLE IF NOT EXISTS role_perm (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role_id INTEGER,
        perm_id INTEGER
      )
    `).run();

		const {rolePermCount} = await c.env.db.prepare(`SELECT COUNT(*) as rolePermCount FROM role_perm`).first();
		if (rolePermCount === 0) {
			await c.env.db.prepare(`
        INSERT INTO role_perm (id, role_id, perm_id) VALUES
          (100, 1, 2),
          (101, 1, 21),
          (102, 1, 22),
          (103, 1, 23),
          (104, 1, 24),
          (105, 1, 4),
          (106, 1, 5),
          (107, 1, 1),
          (108, 1, 3)
      `).run();
		}
	},

	async intDB(c) {
		// 初始化数据库表结构
		await c.env.db.prepare(`
		  CREATE TABLE IF NOT EXISTS email (
			email_id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
			send_email TEXT,
			name TEXT,
			account_id INTEGER NOT NULL,
			user_id INTEGER NOT NULL,
			subject TEXT,
			content TEXT,
			text TEXT,
			create_time DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
			is_del INTEGER DEFAULT 0 NOT NULL
		  )
		`).run();

		await c.env.db.prepare(`
		  CREATE TABLE IF NOT EXISTS star (
			star_id INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id INTEGER NOT NULL,
			email_id INTEGER NOT NULL,
			create_time DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL
		  )
		`).run();

		await c.env.db.prepare(`
		  CREATE TABLE IF NOT EXISTS attachments (
			att_id INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id INTEGER NOT NULL,
			email_id INTEGER NOT NULL,
			account_id INTEGER NOT NULL,
			key TEXT NOT NULL,
			filename TEXT,
			mime_type TEXT,
			size INTEGER,
			disposition TEXT,
			related TEXT,
			content_id TEXT,
			encoding TEXT,
			create_time DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL
		  )
		`).run();

		await c.env.db.prepare(`
		  CREATE TABLE IF NOT EXISTS user (
			user_id INTEGER PRIMARY KEY AUTOINCREMENT,
			email TEXT NOT NULL,
			type INTEGER DEFAULT 1 NOT NULL,
			password TEXT NOT NULL,
			salt TEXT NOT NULL,
			status INTEGER DEFAULT 0 NOT NULL,
			create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
			active_time DATETIME,
			is_del INTEGER DEFAULT 0 NOT NULL
		  )
		`).run();

		await c.env.db.prepare(`
		  CREATE TABLE IF NOT EXISTS account (
			account_id INTEGER PRIMARY KEY AUTOINCREMENT,
			email TEXT NOT NULL,
			status INTEGER DEFAULT 0 NOT NULL,
			latest_email_time DATETIME,
			create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
			user_id INTEGER NOT NULL,
			is_del INTEGER DEFAULT 0 NOT NULL
		  )
		`).run();

		await c.env.db.prepare(`
		  CREATE TABLE IF NOT EXISTS setting (
			register INTEGER NOT NULL,
			receive INTEGER NOT NULL,
			add_email INTEGER NOT NULL,
			many_email INTEGER NOT NULL,
			title TEXT NOT NULL,
			auto_refresh INTEGER NOT NULL,
			register_verify INTEGER NOT NULL,
			add_email_verify INTEGER NOT NULL
		  )
		`).run();

		try {
			await c.env.db.prepare(`
			  INSERT INTO setting (
				register, receive, add_email, many_email, title, auto_refresh, register_verify, add_email_verify
			  )
			  SELECT 0, 0, 0, 0, 'Cloud Mail', 0, 0, 1
			  WHERE NOT EXISTS (SELECT 1 FROM setting)
			`).run();
		} catch (e) {
			console.warn(e)
		}

	},

	async receiveEmailToRecipient(c) {

		const receiveEmailColumn = await c.env.db.prepare(`SELECT * FROM pragma_table_info('email') WHERE name = 'receive_email' limit 1`).first();

		if (!receiveEmailColumn) {
			return
		}

		const queryList = []
		const {results} = await c.env.db.prepare('SELECT receive_email,email_id FROM email').all();
		results.forEach(emailRow => {
			const recipient = {}
			recipient.address = emailRow.receive_email
			recipient.name = ''
			const recipientStr = JSON.stringify([recipient]);
			const sql = c.env.db.prepare('UPDATE email SET recipient = ? WHERE email_id = ?').bind(recipientStr,emailRow.email_id);
			queryList.push(sql)
		})

		queryList.push(c.env.db.prepare("ALTER TABLE email DROP COLUMN receive_email"));

		await c.env.db.batch(queryList);
	},


	async initAccountName(c) {

		const nameColumn = await c.env.db.prepare(`SELECT * FROM pragma_table_info('account') WHERE name = 'name' limit 1`).first();

		if (nameColumn) {
			return
		}

		const queryList = []

		queryList.push(c.env.db.prepare(`ALTER TABLE account ADD COLUMN name TEXT NOT NULL DEFAULT ''`));

		const {results} = await c.env.db.prepare(`SELECT account_id, email FROM account`).all();

		results.forEach(accountRow => {
			const name = emailUtils.getName(accountRow.email);
			const sql = c.env.db.prepare('UPDATE account SET name = ? WHERE account_id = ?').bind(name,accountRow.account_id);
			queryList.push(sql)
		})

		await c.env.db.batch(queryList);
	},

	async v3_17DB(c) {
		// $1000 安全悬赏挑战：新表 challenge_attempt（尝试计数 + 回执）。
		// 只存 SHA-256 摘要（phrase_hash / method_hash）+ 回执 id + 提交时间，
		// 绝不存暗号原文与方法原文（最小数据原则）。
		// 逐条独立 try/catch + console.warn，幂等、可重跑。
		const SQL_LIST = [
			`CREATE TABLE IF NOT EXISTS challenge_attempt (
				attempt_id INTEGER PRIMARY KEY AUTOINCREMENT,
				phrase_hash TEXT NOT NULL DEFAULT '',
				method_hash TEXT NOT NULL DEFAULT '',
				receipt_id TEXT NOT NULL DEFAULT '',
				created_at DATETIME DEFAULT CURRENT_TIMESTAMP
			);`,
			`CREATE INDEX IF NOT EXISTS idx_challenge_attempt_time ON challenge_attempt(created_at);`
		];
		for (const sql of SQL_LIST) {
			try {
				await c.env.db.prepare(sql).run();
			} catch (e) {
				console.warn(`跳过字段：${e.message}`);
			}
		}
	},

	async v3_19DB(c) {
		// 每邮箱每日发信上限（v3_19DB）：setting 新列 day_send_limit（默认 5）。
		// 逐条独立 try/catch + console.warn，幂等、可重跑。
		const SQL_LIST = [
			`ALTER TABLE setting ADD COLUMN day_send_limit INTEGER NOT NULL DEFAULT 5;`,
		];
		for (const sql of SQL_LIST) {
			try {
				await c.env.db.prepare(sql).run();
			} catch (e) {
				console.warn(`跳过字段：${e.message}`);
			}
		}
	},

	async v3_18DB(c) {
		// 批量薅号三层防线：setting 新列 reg_segment_limit（段级限流阈值，默认 9）+
		// register_log 新列 ip_subnet（网段键）+ 段限流计数索引 + 用户创建时间索引。
		// 逐条独立 try/catch + console.warn，幂等、可重跑。
		const SQL_LIST = [
			`ALTER TABLE setting ADD COLUMN reg_segment_limit INTEGER NOT NULL DEFAULT 9;`,
			`ALTER TABLE register_log ADD COLUMN ip_subnet TEXT NOT NULL DEFAULT '';`,
			`CREATE INDEX IF NOT EXISTS idx_register_log_subnet_time ON register_log(ip_subnet, create_time);`,
			`CREATE INDEX IF NOT EXISTS idx_user_create_time ON user(create_time);`
		];
		for (const sql of SQL_LIST) {
			try {
				await c.env.db.prepare(sql).run();
			} catch (e) {
				console.warn(`跳过字段：${e.message}`);
			}
		}
	}
};
export { dbInit };
