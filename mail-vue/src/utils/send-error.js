// 发信失败人话映射（第二阶段 A 路）。
// 后端原文见 mail-worker/src/i18n/zh.js、en.js 的 daySendLimit：
//   zh '今日发信额度已用完，明日恢复' / en 'Daily send limit reached. It resets tomorrow.'
// 旧文案（'发送次数已到达每日限制' / 'Daily send limit reached'）也保留映射，防旧版后端。
// 未命中映射表时原样返回，不吞未知报错。
export const sendErrorMap = {
  '今日发信额度已用完，明日恢复': 'sendLimitToday',
  'Daily send limit reached. It resets tomorrow.': 'sendLimitToday',
  '发送次数已到达每日限制': 'sendLimitToday',
  'Daily send limit reached': 'sendLimitToday',
}

export function friendlySendError(message, t) {
  const key = sendErrorMap[message]
  if (key && typeof t === 'function') {
    return t(key)
  }
  return message
}
