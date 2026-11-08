// 单次巡检（全部时间 UTC）。
// 步骤：① 24h 注册超限 IP → 封禁（scope 0）+ TG + alertLog + WAF 同步
//       ② 近 1h 新注册 IP 逐个查 AbuseIPDB，有举报（totalReports >= minReports）即封禁，同①告警链
//       ③ Resend 配额（日/月）：≥80% 每天每档告警 1 次；≥100% 立即告警（每小时最多 1 次防刷屏）
//       ④ WAF 同步：IP 集 = D1 ip_blocklist 全部有效行（scope 0 与 1 都进 WAF，沿用现网做法）；
//          仅集合变化时才推（由 waf.js 比对表达式）；失败只记日志 + TG，不影响 D1 封禁结果
//       ⑤ 失联检测：连续 3 轮失败（步骤①的 D1 读不到）发一次 TG“巡检失联”，恢复后发“巡检恢复”
// 原则：巡检只读 D1 + 调 Worker/CF API + 发告警；任何一步失败都不抛到主流程（本轮汇总里记 errors）。
import { sleep } from './worker-api.js';

export const WAF_HOST = 'aevorynthtech.com';

const OVER_LIMIT_SQL =
  'SELECT create_ip AS ip, COUNT(*) AS n FROM user ' +
  "WHERE is_del = 0 AND create_ip != '' AND datetime(create_time) >= datetime(?) " +
  'GROUP BY create_ip HAVING n >= ? ORDER BY n DESC';

const RECENT_IPS_SQL =
  'SELECT DISTINCT create_ip AS ip FROM user ' +
  "WHERE is_del = 0 AND create_ip != '' AND datetime(create_time) >= datetime(?) " +
  'ORDER BY create_time DESC LIMIT 200';

const BLOCKLIST_SQL = 'SELECT ip, ip_segment, scope, expire_time FROM ip_blocklist';

/** UTC 'YYYY-MM-DD HH:mm:ss'（D1 create_time / expire_time 同格式，字符串可直接比较）。 */
export function formatUtc(date) {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

/** IPv6 取 /64 段（与 Worker 端 req-utils.getIpSegment 同口径：展开 ::、小写、去前导 0）；IPv4 原样。 */
export function ipSegment(ip) {
  if (!ip || typeof ip !== 'string') return ip || '';
  if (!ip.includes(':')) return ip;
  let addr = ip.split('%')[0].toLowerCase();
  const [left, right] = addr.split('::');
  let groups;
  if (right === undefined) {
    groups = addr.split(':');
  } else {
    const l = left ? left.split(':') : [];
    const r = right ? right.split(':') : [];
    const missing = 8 - l.length - r.length;
    groups = [...l, ...Array(Math.max(0, missing)).fill('0'), ...r];
  }
  const norm = groups.slice(0, 8).map((g) => {
    const n = parseInt(g || '0', 16);
    return Number.isNaN(n) ? '0' : n.toString(16);
  });
  return norm.slice(0, 4).join(':');
}

/** 有效黑名单行：expire_time 为空 = 永久；否则须晚于 now。 */
export function validBlocklist(rows, nowStr) {
  const now = nowStr.replace('T', ' ');
  return (rows || []).filter((r) => {
    if (!r.expire_time) return true;
    return String(r.expire_time).replace('T', ' ') > now;
  });
}

/** 该 IP 是否已被封：ip 列精确命中，或 ip_segment 列命中原 IP / 其 /64 段。 */
export function isAlreadyBlocked(ip, validRows) {
  const seg = ipSegment(ip);
  return (validRows || []).some((r) => r.ip === ip || r.ip_segment === ip || r.ip_segment === seg);
}

/**
 * WAF 用 IP 集：每行取 ip；ip_segment 若为 IPv6 段则拼 /64（CF ip.src in { } 支持 CIDR），
 * IPv4 段即原 IP；去重排序。
 */
export function buildWafIpSet(validRows) {
  const set = new Set();
  for (const r of validRows || []) {
    if (r.ip) set.add(r.ip);
    if (r.ip_segment) {
      if (r.ip_segment.includes(':')) {
        set.add(r.ip_segment.includes('/') ? r.ip_segment : `${r.ip_segment}/64`);
      } else {
        set.add(r.ip_segment);
      }
    }
  }
  return [...set].sort();
}

function appendKumaStatus(url, status, msg) {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}status=${status}&msg=${encodeURIComponent(msg)}`;
}

/**
 * 单次巡检。deps: { config, d1, worker, waf, abuse|null, telegram, state, logger, now, fetchImpl }
 * 返回汇总 summary（blocked / abuseBlocked / quota / waf / failed / errors）。
 * 约定：step1Failed（D1 读不到）才算本轮失败，用于失联检测；其余步骤失败只记 errors。
 */
export async function runPatrol(deps) {
  const {
    config,
    d1,
    worker,
    waf,
    abuse,
    telegram,
    state,
    logger = console,
    now = new Date(),
    fetchImpl = fetch,
  } = deps;
  const s = state.state;
  const today = now.toISOString().slice(0, 10);
  const nowStr = formatUtc(now);
  const summary = {
    at: now.toISOString(),
    blocked: [],
    abuseBlocked: [],
    quota: null,
    waf: null,
    failed: false,
    errors: [],
  };
  let step1Failed = false;

  // 封禁 + 告警链（TG + alertLog 均为 best-effort；Worker add 本身失败则不发成功告警）。
  const blockIp = async (ip, reason) => {
    try {
      const r = await worker.addIpBlock({ ip, scope: 0, reason });
      if (r && r.dryRun) {
        logger.log(`[dry-run] 将封禁 ${ip}（${reason}）`);
        return { ok: true, dryRun: true };
      }
    } catch (e) {
      const msg = `封禁失败 ${ip}（${reason}）: ${e.message}`;
      logger.error(msg);
      summary.errors.push(msg);
      return { ok: false };
    }
    const text =
      `🚨 巡检自动封禁\nIP：${ip}\n原因：${reason}\n` +
      `时间：${now.toISOString()}（UTC）`;
    await telegram.send(text);
    try {
      await worker.recordAlert({ type: 'patrol', text });
    } catch (e) {
      logger.error(`写 alertLog 失败 ${ip}: ${e.message}`);
    }
    return { ok: true };
  };

  // ---- ① 注册超限 + 读黑名单 ----
  let validRows = [];
  try {
    const rows = await d1.query(BLOCKLIST_SQL);
    validRows = validBlocklist(rows, nowStr);
  } catch (e) {
    step1Failed = true;
    const msg = `步骤①读黑名单失败: ${e.message}`;
    logger.error(msg);
    summary.errors.push(msg);
  }
  if (!step1Failed) {
    try {
      const cutoff = formatUtc(new Date(now.getTime() - config.patrol.regWindowHours * 3600 * 1000));
      const over = await d1.query(OVER_LIMIT_SQL, [cutoff, config.patrol.regLimit]);
      for (const row of over) {
        const ip = row.ip;
        const n = Number(row.n || 0);
        if (!ip) continue;
        if (isAlreadyBlocked(ip, validRows)) {
          logger.log(`已封禁，跳过 ${ip}（${config.patrol.regWindowHours}h 内注册 ${n} 次）`);
          continue;
        }
        const reason = `巡检：${config.patrol.regWindowHours}h 内注册 ${n} 次`;
        const r = await blockIp(ip, reason);
        if (r.ok) {
          summary.blocked.push({ ip, n, reason });
          validRows.push({ ip, ip_segment: ipSegment(ip), scope: 0, expire_time: null });
        }
        await sleep(50); // 批量写分批，避免瞬间打满 Worker
      }
    } catch (e) {
      step1Failed = true;
      const msg = `步骤①查超限注册失败: ${e.message}`;
      logger.error(msg);
      summary.errors.push(msg);
    }
  }

  // ---- ② AbuseIPDB：近 1h 新注册 IP ----
  if (abuse) {
    try {
      const cutoff1h = formatUtc(new Date(now.getTime() - 3600 * 1000));
      const recent = await d1.query(RECENT_IPS_SQL, [cutoff1h]);
      const ips = [...new Set((recent || []).map((r) => r.ip).filter(Boolean))].slice(0, 200);
      for (const ip of ips) {
        if (isAlreadyBlocked(ip, validRows)) continue;
        let rep;
        try {
          rep = await abuse.check(ip);
        } catch (e) {
          const msg = `AbuseIPDB 查询失败 ${ip}: ${e.message}`;
          logger.error(msg);
          summary.errors.push(msg);
          continue;
        }
        if (!rep) continue; // dry-run：跳过
        if (Number(rep.totalReports || 0) >= (config.abuseipdb?.minReports ?? 1)) {
          const cats = rep.categories?.length ? rep.categories.join('、') : '未知';
          const reason =
            `巡检：AbuseIPDB 举报 ${rep.totalReports} 次，最近举报类别：${cats}` +
            (rep.lastReportedAt ? `（最近举报 ${rep.lastReportedAt}）` : '');
          const r = await blockIp(ip, reason);
          if (r.ok) {
            summary.abuseBlocked.push({ ip, totalReports: rep.totalReports, categories: rep.categories });
            validRows.push({ ip, ip_segment: ipSegment(ip), scope: 0, expire_time: null });
          }
        } else {
          logger.log(`AbuseIPDB 无举报: ${ip}`);
        }
        await sleep(50);
      }
    } catch (e) {
      const msg = `步骤②失败: ${e.message}`;
      logger.error(msg);
      summary.errors.push(msg);
    }
  } else {
    logger.log('未配置 AbuseIPDB apiKey，跳过步骤②');
  }

  // ---- ③ Resend 配额 ----
  try {
    const q = await worker.getResendQuota();
    const dayPct = q.dayBudget ? q.day / q.dayBudget : 0;
    const monthPct = q.monthBudget ? q.month / q.monthBudget : 0;
    summary.quota = {
      day: q.day,
      month: q.month,
      dayBudget: q.dayBudget,
      monthBudget: q.monthBudget,
      dayPct: Math.round(dayPct * 1000) / 1000,
      monthPct: Math.round(monthPct * 1000) / 1000,
    };
    for (const [tier, pct, used, budget, label] of [
      ['day', dayPct, q.day, q.dayBudget, '日'],
      ['month', monthPct, q.month, q.monthBudget, '月'],
    ]) {
      if (pct >= 1) {
        // ≥100% 立即告警；每小时最多 1 次（防每 5 分钟刷屏）。
        const key = `${tier}100At`;
        const last = s.quotaAlerts[key] ? new Date(s.quotaAlerts[key]).getTime() : 0;
        if (now.getTime() - last >= 3600 * 1000) {
          const text = `🚨 Resend 配额已用完（${label}）：${used}/${budget}（${Math.round(pct * 100)}%），外发已停，请处理。`;
          await telegram.send(text);
          try {
            await worker.recordAlert({ type: 'quota', text });
          } catch (e) {
            logger.error(`写 alertLog 失败（配额）: ${e.message}`);
          }
          s.quotaAlerts[key] = now.toISOString();
        }
      } else if (pct >= 0.8) {
        // ≥80% 每天每档告警 1 次。
        const key = `${tier}80`;
        if (s.quotaAlerts[key] !== today) {
          const text = `⚠️ Resend 配额告警（${label}）：${used}/${budget}（${Math.round(pct * 100)}%），已达 80%。`;
          await telegram.send(text);
          try {
            await worker.recordAlert({ type: 'quota', text });
          } catch (e) {
            logger.error(`写 alertLog 失败（配额）: ${e.message}`);
          }
          s.quotaAlerts[key] = today;
        }
      }
    }
  } catch (e) {
    const msg = `步骤③配额查询失败: ${e.message}`;
    logger.error(msg);
    summary.errors.push(msg);
  }

  // ---- ④ WAF 同步 ----
  if (config.patrol.wafSyncEnabled) {
    const ips = buildWafIpSet(validRows);
    try {
      const r = await waf.sync(ips, WAF_HOST);
      summary.waf = r;
      if (r.pushed) {
        s.lastWafSync = now.toISOString();
        s.lastWafIpSet = ips;
        logger.log(`WAF 已同步 ${ips.length} 个 IP`);
      } else if (r.error) {
        const text = `⚠️ WAF 同步失败：${r.error}（D1 封禁不受影响）`;
        logger.error(text);
        summary.errors.push(text);
        await telegram.send(text);
        try {
          await worker.recordAlert({ type: 'waf', text });
        } catch (e) {
          logger.error(`写 alertLog 失败（WAF）: ${e.message}`);
        }
      } else if (r.skipped === 'empty') {
        logger.log('WAF：黑名单为空，跳过推送（不删除现有规则）');
      } else if (r.dryRun) {
        logger.log('WAF：dry-run，仅记录拟推送内容，未实际推送');
      } else {
        logger.log('WAF：IP 集未变，跳过推送');
      }
    } catch (e) {
      const msg = `步骤④ WAF 同步异常: ${e.message}`;
      logger.error(msg);
      summary.errors.push(msg);
    }
  } else {
    logger.log('WAF 同步已关闭（patrol.wafSyncEnabled=false）');
  }

  // ---- ⑤ 失联检测 ----
  if (step1Failed) {
    s.consecutiveFailures = (s.consecutiveFailures || 0) + 1;
    summary.failed = true;
    if (s.consecutiveFailures >= 3 && !s.offlineAlertSent) {
      const text = `🚨 巡检失联：已连续 ${s.consecutiveFailures} 轮失败（D1/API 不可达），请检查甲骨文巡检服务。`;
      await telegram.send(text);
      try {
        await worker.recordAlert({ type: 'system', text });
      } catch (e) {
        logger.error(`写 alertLog 失败（失联）: ${e.message}`);
      }
      s.offlineAlertSent = true;
    }
  } else {
    if (s.offlineAlertSent) {
      const text = '✅ 巡检恢复：甲骨文巡检服务已恢复正常。';
      await telegram.send(text);
      try {
        await worker.recordAlert({ type: 'system', text });
      } catch (e) {
        logger.error(`写 alertLog 失败（恢复）: ${e.message}`);
      }
      s.offlineAlertSent = false;
    }
    s.consecutiveFailures = 0;
  }

  // ---- Uptime Kuma push 心跳（best-effort；失败只记日志） ----
  if (config.kumaPushUrl) {
    try {
      const url = summary.failed
        ? appendKumaStatus(config.kumaPushUrl, 'down', 'patrol-failed')
        : config.kumaPushUrl;
      await fetchImpl(url, { method: 'GET' });
    } catch (e) {
      logger.error(`Kuma 心跳失败: ${e.message}`);
    }
  }

  state.pruneAbuse();
  s.lastRun = now.toISOString();
  state.save();
  return summary;
}
