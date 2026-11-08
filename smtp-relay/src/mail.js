// MIME → Worker POST /email/send 参数映射。
// 格式依据（只读，未改）：mail-worker/src/service/email-service.js 的 send() 入参
// （:336-353）与附件处理约定：
// - send() 解构 {accountId, name, sendType, emailId, receiveEmail, text, content,
//   subject, attachments = []}；content 是 HTML（:352 经 attService.toImageUrlHtml
//   转内嵌图），text 是纯文本；attachments 上限 10（:458-460 超了抛 attLimit）。
// - saveSendAtt（att-service.js:149）：取 att.content（base64 字符串，可带 data: 前缀，
//   toAttachmentBase64 会剥离）+ att.filename + att.type 作 mimeType。
// - toCloudflareAttachments（email-service.js:740）：contentId 有值 → disposition inline。
// 所以本模块发出的附件对象为 {filename, content: <base64>, type, contentType, contentId?}。
// 收件人取 To + Cc + Bcc（Bcc 由客户端在 DATA 里带上，服务器端不再拆分投递）。
import { simpleParser } from 'mailparser';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isEmail(value) {
  return EMAIL_RE.test(String(value || '').trim());
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** mailparser 的地址对象 {value:[{address,name}]} → 地址字符串数组（去重、小写）。 */
export function extractAddresses(headerValue) {
  const out = [];
  const seen = new Set();
  for (const item of headerValue?.value ?? []) {
    const addr = String(item.address || '').trim().toLowerCase();
    if (addr && !seen.has(addr)) {
      seen.add(addr);
      out.push(addr);
    }
  }
  return out;
}

/**
 * 把 mailparser 解析结果映射成 POST /email/send 的 body。
 * @param {object} parsed simpleParser 的结果
 * @param {object} opts { accountId, authEmail } authEmail 为 SMTP AUTH 的邮箱
 * @throws {Error} message 为 SMTP 回复里要带的人话原因（调用方再映射成 SMTP 码）
 */
export function mapParsedToSendPayload(parsed, { accountId, authEmail }) {
  const fromAddrs = extractAddresses(parsed.from);
  const from = fromAddrs[0] || '';
  // 发件人 FROM 必须是用户自己的 @aevorynthtech.com 邮箱（Worker 的
  // sendEmailNotCurUser 校验会兜底，这里先拦一道，给客户端明确报错）。
  if (!from) throw new Error('邮件缺少 From 头');
  if (from.toLowerCase() !== String(authEmail).toLowerCase()) {
    throw new Error(`发件人 ${from} 与登录账号 ${authEmail} 不一致`);
  }

  const receiveEmail = [
    ...extractAddresses(parsed.to),
    ...extractAddresses(parsed.cc),
    ...extractAddresses(parsed.bcc),
  ];
  if (receiveEmail.length === 0) throw new Error('邮件缺少收件人');
  for (const addr of receiveEmail) {
    if (!isEmail(addr)) throw new Error(`收件人地址不合法: ${addr}`);
  }

  const text = parsed.text ?? '';
  // 无 HTML 正文时由纯文本转一段简单 HTML（换行 → <br>），保证 content 有值。
  const content = parsed.html || (text ? `<div>${escapeHtml(text).replace(/\r?\n/g, '<br>')}</div>` : '');
  const fromName = parsed.from?.value?.[0]?.name || from.split('@')[0];

  const attachments = (parsed.attachments ?? []).map((att) => {
    const item = {
      filename: att.filename || 'attachment',
      content: Buffer.isBuffer(att.content) ? att.content.toString('base64') : String(att.content ?? ''),
      type: att.contentType || 'application/octet-stream',
      contentType: att.contentType || 'application/octet-stream',
    };
    if (att.contentId) item.contentId = att.contentId;
    return item;
  });
  if (attachments.length > 10) throw new Error('附件数量超过上限（10 个）');

  return {
    accountId,
    name: fromName,
    receiveEmail,
    subject: parsed.subject ?? '',
    text,
    content,
    attachments,
  };
}

/** 解析一封原始 MIME 邮件（Buffer/string）并映射成 send payload。 */
export async function parseMailToSendPayload(raw, opts) {
  const parsed = await simpleParser(raw);
  return mapParsedToSendPayload(parsed, opts);
}
