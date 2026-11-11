// 斯诺登第四批 P2-6：发信元数据最小化（纯函数，零依赖）。
// 原则：外发邮件只带投递必需的字段；我方代码不主动附加任何可识别
// 客户端 / 设备的头。已核实 sendByResend（email-service.js）现状：
// 只发 from/to/subject/text/html/attachments，回复时另加 in-reply-to
// 与 references——本来就没有 X-Mailer、客户端信息、发件 IP 等头。
// 本模块把这条现状固化为可测试的白名单 + 构造器：以后任何外发
// 通道（Resend / CF Email Sending）都走 buildMinimalSendForm，
// 误加的头会被 minimizeHeaders() 拦掉并记入 removed 列表。
// 注意：Received、DKIM-Signature、Resend/CF 的基础设施头由服务商
// 在投递链路上追加，我方无法去掉——不在本模块处理范围，见报告。

// 白名单：允许保留的外发头（回复线程必需，缺一不可）。
export const ALLOWED_OUTBOUND_HEADERS = ['in-reply-to', 'references'];

// 明确禁止的头：客户端标识、发件 IP、软件版本类。命中即删。
export const DENIED_OUTBOUND_HEADERS = [
	'x-mailer',
	'x-mailer-version',
	'x-originating-ip',
	'x-forwarded-for',
	'user-agent',
	'x-client',
	'x-client-ip',
	'x-sender-ip',
	'received',
	'x-php-originating-script',
	'x-mimeole',
];

function normKey(k) {
	return String(k || '').trim().toLowerCase();
}

// headers 支持两种形态：{Name: value} 或 [[name, value], ...]。
// 返回 { kept, removed }：kept 只含白名单头（原大小写保留），removed 为被删的头名。
export function minimizeHeaders(headers) {
	const kept = {};
	const removed = [];
	const entries = Array.isArray(headers)
		? headers
		: Object.entries(headers || {});
	for (const [rawKey, value] of entries) {
		const key = normKey(rawKey);
		if (!key) continue;
		if (ALLOWED_OUTBOUND_HEADERS.includes(key)) {
			kept[rawKey] = value;
		} else {
			removed.push(rawKey);
		}
	}
	return { kept, removed };
}

// 构造最小化外发表单（与 sendByResend 的 sendForm 同构，但强制白名单）。
export function buildMinimalSendForm(params = {}) {
	const {
		name = '',
		accountEmail = '',
		receiveEmail = [],
		subject = '',
		text = '',
		html = '',
		attachments = [],
		sendType = '',
		messageId = '',
	} = params;
	const form = {
		from: `${name} <${accountEmail}>`,
		to: [...receiveEmail],
		subject,
		text,
		html,
		attachments,
	};
	if (sendType === 'reply' && messageId) {
		form.headers = {
			'in-reply-to': messageId,
			'references': messageId,
		};
	}
	return form;
}

// 审计用：输入一组待发头，返回会被删掉的键（供日志/测试断言，不含值）。
export function describeRemovedHeaders(headers) {
	return minimizeHeaders(headers).removed;
}

export default { minimizeHeaders, buildMinimalSendForm, describeRemovedHeaders, ALLOWED_OUTBOUND_HEADERS, DENIED_OUTBOUND_HEADERS };
