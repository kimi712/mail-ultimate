// 斯诺登第四批 i18n（后端 worker 用）。
// 注意：worker 的 t() 从 src/i18n/zh.js / en.js（审计员文件中）读，
// 本文件不直接改那两个文件。接线：在 zh.js / en.js 顶部加一行
//   import { burn4Zh } from './burn4.js'（zh）/ burn4En（en）
// 再在导出对象里展开 ...burn4Zh / ...burn4En（精确补丁见报告）。
// key 命名：burn4 前缀，避免与现有 key 冲突。

export const burn4Zh = {
	burn4ExifStripped: '已剥离位置与设备信息',
	burn4ExifStrippedDetail: '附件图片的 GPS 定位、相机型号与拍摄时间已在上传前剥离',
	burn4ExifKept: '该图片不含位置与设备信息，无需处理',
	burn4BurnRequiresE2ee: '阅后即焚仅支持端到端加密邮件：请先开启 E2EE，或改选定时自毁',
	burn4BurnRule: '对方读过一次后，收件与发件副本将一起销毁；定时自毁到期后同样销毁',
	burn4Burned: '此邮件已自毁',
	burn4AnomalySubject: '异常登录告警：请立即检查你的账号',
	burn4NewDeviceSubject: '新设备登录提醒',
	burn4LockAccount: '一键锁定账号',
	burn4LockAccountDone: '账号已锁定，请联系管理员解锁',
	burn4RequireStepUp: '本次登录异常，请完成二次验证',
	burn4AliasExpiresAt: '别名有效期至',
	burn4AliasExpired: '别名已过期并停止收信',
	burn4AliasNoExpiry: '不限期',
	burn4AdminAuditTitle: '管理员操作审计',
	burn4AdminAuditCoverage: '高危操作接线覆盖',
};

export const burn4En = {
	burn4ExifStripped: 'Location & device info stripped',
	burn4ExifStrippedDetail: 'GPS location, camera model and capture time were removed from the image before upload',
	burn4ExifKept: 'This image contains no location or device info',
	burn4BurnRequiresE2ee: 'Burn-after-reading requires end-to-end encryption: enable E2EE or choose timed expiry instead',
	burn4BurnRule: 'After the recipient reads it once, both inbox and sent copies are destroyed; timed expiry works the same way',
	burn4Burned: 'This message has self-destructed',
	burn4AnomalySubject: 'Suspicious login alert: check your account now',
	burn4NewDeviceSubject: 'New device login reminder',
	burn4LockAccount: 'Lock account now',
	burn4LockAccountDone: 'Account locked. Contact the administrator to unlock it',
	burn4RequireStepUp: 'This login looks unusual, please complete second verification',
	burn4AliasExpiresAt: 'Alias valid until',
	burn4AliasExpired: 'Alias expired and stopped receiving mail',
	burn4AliasNoExpiry: 'No expiry',
	burn4AdminAuditTitle: 'Admin operation audit',
	burn4AdminAuditCoverage: 'High-risk action audit coverage',
};

export default { burn4Zh, burn4En };
