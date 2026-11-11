// 新邮件大框提示（微软 Windows 通知风格）：右下角大卡片，3 秒自动关闭，可点开邮件。
// 全局单例：任意页面 push 一条即显示；多封同时到时合并为一条汇总（防刷屏）。
import { reactive } from 'vue';

export const mailNotifies = reactive([]);

let seq = 0;

function stripHtml(s) {
  return String(s || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
}

function textOf(email) {
  const name = stripHtml(email.name || email.fromName || '') || stripHtml(email.fromAddr || '') || 'Unknown';
  const subject = stripHtml(email.subject || '') || '(No subject)';
  const preview = stripHtml(email.text || email.listHtml || email.content || '').slice(0, 90);
  return { name, subject, preview };
}

// 推一条新邮件提示。emails 为本次轮询新到的邮件数组（已去重）。
// 1 封：显示该封的发件人+主题+预览；多封：合并为一条汇总（显示数量+最新一封）。
export function notifyNewMail(emails, onOpen) {
  if (!emails || emails.length === 0) return;
  const items = emails.slice(0, 3).map(textOf);
  const first = items[0];
  const n = {
    id: ++seq,
    count: emails.length,
    name: first.name,
    subject: first.subject,
    preview: first.preview,
    // 多封时汇总标题用数量，单封用发件人
    title: emails.length > 1 ? `收到 ${emails.length} 封新邮件` : first.name,
    emails: emails.slice(),
    onOpen: onOpen || null,
    timer: null,
  };
  mailNotifies.push(n);
  // 3 秒后自动关闭（微软风格：带底部倒计时条）
  n.timer = setTimeout(() => dismissNotify(n.id), 3000);
  // 最多同时显示 3 条，超出的最早一条直接关掉
  while (mailNotifies.length > 3) {
    const old = mailNotifies[0];
    clearTimeout(old.timer);
    mailNotifies.shift();
  }
  return n.id;
}

export function dismissNotify(id) {
  const i = mailNotifies.findIndex((x) => x.id === id);
  if (i >= 0) {
    clearTimeout(mailNotifies[i].timer);
    mailNotifies.splice(i, 1);
  }
}
