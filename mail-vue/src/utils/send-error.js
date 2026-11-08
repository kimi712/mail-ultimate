// 发信失败人话映射（第二阶段 A 路）。
// 后端原文见 mail-worker/src/i18n/zh.js、en.js 的 daySendLimit：
//   zh '发送次数已到达每日限制' / en 'Daily send limit reached'
// 未命中映射表时原样返回，不吞未知报错。
export const sendErrorMap = {
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
