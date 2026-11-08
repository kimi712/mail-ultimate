// oracle-patrol 测试：node:test + 内置 http 起 mock 服务器，模拟 CF D1 / WAF / TG / Worker / AbuseIPDB 五方。
// 全程只调 mock，不连真实 API。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { loadConfig, redactConfig } from '../src/config.js';
import { D1Client } from '../src/d1.js';
import { WorkerApi } from '../src/worker-api.js';
import { WafClient, buildExpression } from '../src/waf.js';
import { AbuseIpDb } from '../src/abuseipdb.js';
import { Telegram } from '../src/telegram.js';
import { StateStore } from '../src/state.js';
import { runPatrol, ipSegment, validBlocklist, isAlreadyBlocked, buildWafIpSet } from '../src/patrol.js';

const execFileAsync = promisify(execFile);
const ROOT = dirname(fileURLToPath(import.meta.url));
const NOW = new Date('2026-11-08T12:00:00Z');
const silent = { log() {}, error() {} };

// ---------- mock 服务器 ----------
function startMock(opts = {}) {
  const calls = {
    d1: [], login: 0, workerAdd: [], alertLog: [], quota: 0,
    tg: [], wafGet: 0, wafPut: [], abuse: [], kuma: [],
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const parsed = body ? JSON.parse(body) : {};
      const url = req.url || '';
      if (url.startsWith('/client/v4/accounts/') && url.includes('/d1/database/')) {
        calls.d1.push(parsed);
        if (opts.d1Fail) return json(500, { success: false, errors: [{ message: 'mock d1 down' }] });
        const sql = parsed.sql || '';
        let rows = [];
        if (sql.includes('GROUP BY create_ip')) rows = opts.overLimit || [];
        else if (sql.includes('DISTINCT create_ip')) rows = opts.recent || [];
        else if (sql.includes('FROM ip_blocklist')) rows = opts.blocklist || [];
        return json(200, { success: true, result: [{ results: rows, meta: {} }] });
      }
      if (url === '/api/login') {
        calls.login += 1;
        return json(200, { code: 200, message: 'success', data: { token: 'mock-jwt' } });
      }
      if (url === '/api/ipBlocklist/add') {
        calls.workerAdd.push(parsed);
        return json(200, { code: 200, message: 'success', data: { blockId: 99 } });
      }
      if (url === '/api/alertLog/record') {
        calls.alertLog.push(parsed);
        return json(200, { code: 200, message: 'success', data: {} });
      }
      if (url === '/api/quota/resend') {
        calls.quota += 1;
        return json(200, { code: 200, message: 'success', data: opts.quota || { day: 0, month: 0, dayBudget: 100, monthBudget: 3000 } });
      }
      if (url.includes('/rulesets/phases/http_request_firewall_custom/entrypoint')) {
        if (req.method === 'GET') {
          calls.wafGet += 1;
          return json(200, { success: true, result: { rules: opts.wafRules ?? [] } });
        }
        calls.wafPut.push(parsed);
        if (opts.wafPutFail) return json(200, { success: false, errors: [{ message: 'mock waf fail' }] });
        return json(200, { success: true, result: {} });
      }
      if (url.startsWith('/bot')) {
        calls.tg.push(parsed);
        return json(200, { ok: true, result: {} });
      }
      if (url.startsWith('/api/v2/check')) {
        const ip = new URL(url, 'http://x').searchParams.get('ipAddress');
        calls.abuse.push(ip);
        const data = (opts.abuse || {})[ip] || {
          ipAddress: ip, totalReports: 0, abuseConfidenceScore: 0, lastReportedAt: null, countryCode: null,
        };
        return json(200, { data });
      }
      if (url.startsWith('/kuma')) {
        calls.kuma.push(url);
        return json(200, {});
      }
      return json(404, { error: 'mock: unknown route ' + url });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, calls, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

function makeConfig(port, overrides = {}) {
  const base = {
    cloudflare: {
      apiToken: 'mock-cf-token', accountId: 'mock-account', zoneId: 'mock-zone',
      d1DatabaseId: 'mock-d1', wafRuleName: 'mail-ultimate-ip-blocklist', baseUrl: `http://127.0.0.1:${port}`,
    },
    worker: { baseUrl: `http://127.0.0.1:${port}/api` },
    admin: { email: 'admin@example.com', password: 'mock-admin-pass' },
    abuseipdb: { apiKey: 'mock-abuse-key', maxAgeInDays: 90, minReports: 1, baseUrl: `http://127.0.0.1:${port}` },
    telegram: { botToken: 'mock-tg-token', chatId: 'mock-chat', baseUrl: `http://127.0.0.1:${port}` },
    patrol: { intervalMinutes: 5, regWindowHours: 24, regLimit: 3, wafSyncEnabled: true, dryRun: false },
    kumaPushUrl: '',
  };
  return { ...base, ...overrides };
}

function makeDeps(mock, configOverrides = {}, stateDir = null) {
  const dir = stateDir || mkdtempSync(join(tmpdir(), 'patrol-test-'));
  const config = makeConfig(mock.port, configOverrides);
  const state = new StateStore(join(dir, 'state.json'));
  state.load();
  const baseUrl = `http://127.0.0.1:${mock.port}`;
  const d1 = new D1Client({ apiToken: 'mock-cf-token', accountId: 'a', databaseId: 'd', baseUrl, fetchImpl: fetch, logger: silent });
  const worker = new WorkerApi({ baseUrl: `${baseUrl}/api`, email: 'admin@example.com', password: 'x', fetchImpl: fetch, dryRun: !!config.patrol.dryRun, logger: silent });
  const waf = new WafClient({ apiToken: 't', zoneId: 'z', ruleName: config.cloudflare.wafRuleName, baseUrl, fetchImpl: fetch, dryRun: !!config.patrol.dryRun, logger: silent });
  const abuse = new AbuseIpDb({
    apiKey: 'k', baseUrl, fetchImpl: fetch, dryRun: !!config.patrol.dryRun, logger: silent,
    cache: { get: (ip) => state.getAbuse(ip), set: (ip, data) => state.setAbuse(ip, data) },
  });
  const telegram = new Telegram({ botToken: 't', chatId: 'c', baseUrl, fetchImpl: fetch, dryRun: !!config.patrol.dryRun, logger: silent });
  return { config, d1, worker, waf, abuse, telegram, state, logger: silent, now: NOW, fetchImpl: fetch };
}

// ---------- config ----------
test('config：缺文件报错、缺必填报错、环境变量覆盖密码、脱敏打印不含密钥', () => {
  assert.throws(() => loadConfig({ configPath: '/nonexistent/patrol-config.json' }), /配置文件不存在/);
  const dir = mkdtempSync(join(tmpdir(), 'patrol-cfg-'));
  const bad = join(dir, 'config.json');
  writeFileSync(bad, JSON.stringify({ worker: { baseUrl: 'https://aevorynthtech.com/api' } }));
  assert.throws(() => loadConfig({ configPath: bad }), /缺失必填项/);
  const good = join(dir, 'good.json');
  writeFileSync(good, JSON.stringify(makeConfig(1)));
  const cfg = loadConfig({
    configPath: good,
    env: { ...process.env, MAIL_PATROL_ADMIN_PASSWORD: 'env-pass-123' },
  });
  assert.equal(cfg.admin.password, 'env-pass-123');
  const redacted = redactConfig(cfg);
  assert.equal(redacted.admin.password, '********');
  assert.equal(redacted.cloudflare.apiToken, '********');
  assert.equal(redacted.telegram.botToken, '********');
  assert.equal(cfg.admin.password, 'env-pass-123'); // 原对象不动
});

// ---------- 纯函数 ----------
test('纯函数：WAF 表达式去重排序、IPv6 /64、过期行、已封判定、WAF IP 集', () => {
  assert.equal(
    buildExpression(['5.6.7.8', '1.2.3.4', '1.2.3.4'], 'aevorynthtech.com'),
    'http.host eq "aevorynthtech.com" and ip.src in { 1.2.3.4 5.6.7.8 }',
  );
  assert.equal(ipSegment('2001:0DB8:85a3:0000:0000:8a2e:0370:7334'), '2001:db8:85a3:0');
  assert.equal(ipSegment('2001:db8::1'), '2001:db8:0:0');
  assert.equal(ipSegment('1.2.3.4'), '1.2.3.4');
  const rows = [
    { ip: '1.1.1.1', ip_segment: '1.1.1.1', scope: 0, expire_time: null },
    { ip: '2.2.2.2', ip_segment: '2.2.2.2', scope: 1, expire_time: '2026-11-01 00:00:00' }, // 已过期
  ];
  const valid = validBlocklist(rows, '2026-11-08 12:00:00');
  assert.equal(valid.length, 1);
  assert.equal(isAlreadyBlocked('1.1.1.1', valid), true);
  assert.equal(isAlreadyBlocked('2.2.2.2', valid), false);
  assert.equal(isAlreadyBlocked('2001:db8:85a3:0:0:0:0:9', [{ ip: '', ip_segment: '2001:db8:85a3:0', scope: 0, expire_time: null }]), true);
  assert.deepEqual(
    buildWafIpSet([
      { ip: '1.1.1.1', ip_segment: '1.1.1.1', scope: 0, expire_time: null },
      { ip: '2001:db8::5', ip_segment: '2001:db8:85a3:0', scope: 0, expire_time: null },
    ]),
    ['1.1.1.1', '2001:db8:85a3:0/64', '2001:db8::5'],
  );
});

// ---------- WAF ----------
test('WAF：更新目标规则、保留其他规则（含 id）、未变不 PUT、缺失则追加、空集不推、PUT 失败不抛错', async () => {
  const mock = await startMock({
    wafRules: [
      { id: 'rule-other', description: '其他规则', expression: 'http.request.uri.path contains "/x"', action: 'block', enabled: true },
      { id: 'rule-target', description: 'mail-ultimate-ip-blocklist', expression: 'http.host eq "aevorynthtech.com" and ip.src in { 9.9.9.9 }', action: 'block', enabled: true },
    ],
  });
  try {
    const waf = new WafClient({ apiToken: 't', zoneId: 'z', ruleName: 'mail-ultimate-ip-blocklist', baseUrl: `http://127.0.0.1:${mock.port}`, fetchImpl: fetch, logger: silent });
    const r1 = await waf.sync(['1.2.3.4'], 'aevorynthtech.com');
    assert.equal(r1.pushed, true);
    assert.equal(mock.calls.wafPut.length, 1);
    const put = mock.calls.wafPut[0];
    assert.equal(put.rules.length, 2);
    assert.equal(put.rules.find((r) => r.description === '其他规则').id, 'rule-other');
    assert.equal(put.rules.find((r) => r.description === 'mail-ultimate-ip-blocklist').id, 'rule-target');
    assert.equal(
      put.rules.find((r) => r.description === 'mail-ultimate-ip-blocklist').expression,
      'http.host eq "aevorynthtech.com" and ip.src in { 1.2.3.4 }',
    );
    // 表达式未变 → 不 PUT
    const mock2 = await startMock({
      wafRules: [{ id: 't', description: 'mail-ultimate-ip-blocklist', expression: 'http.host eq "aevorynthtech.com" and ip.src in { 1.2.3.4 }', action: 'block', enabled: true }],
    });
    try {
      const waf2 = new WafClient({ apiToken: 't', zoneId: 'z', ruleName: 'mail-ultimate-ip-blocklist', baseUrl: `http://127.0.0.1:${mock2.port}`, fetchImpl: fetch, logger: silent });
      const r2 = await waf2.sync(['1.2.3.4'], 'aevorynthtech.com');
      assert.equal(r2.pushed, false);
      assert.equal(r2.changed, false);
      assert.equal(mock2.calls.wafPut.length, 0);
    } finally { await mock2.close(); }
    // 空集 → 不推
    const r3 = await waf.sync([], 'aevorynthtech.com');
    assert.equal(r3.skipped, 'empty');
    assert.equal(mock.calls.wafPut.length, 1);
  } finally { await mock.close(); }

  const mock3 = await startMock({ wafRules: [], wafPutFail: true });
  try {
    const waf3 = new WafClient({ apiToken: 't', zoneId: 'z', ruleName: 'mail-ultimate-ip-blocklist', baseUrl: `http://127.0.0.1:${mock3.port}`, fetchImpl: fetch, logger: silent });
    const r = await waf3.sync(['1.2.3.4'], 'aevorynthtech.com');
    assert.equal(r.pushed, false);
    assert.match(r.error, /WAF 推送失败/);
  } finally { await mock3.close(); }
});

// ---------- AbuseIPDB 缓存 ----------
test('AbuseIPDB：结果缓存 24h，命中不调接口', async () => {
  let fetchCount = 0;
  const fetchStub = async () => {
    fetchCount += 1;
    return { ok: true, status: 200, json: async () => ({ data: { ipAddress: '9.9.9.9', totalReports: 3, abuseConfidenceScore: 80, lastReportedAt: '2026-11-07T00:00:00+00:00', reports: [{ categories: [18, 22] }] } }) };
  };
  const cache = new Map();
  const api = new AbuseIpDb({
    apiKey: 'k', fetchImpl: fetchStub, logger: silent,
    cache: { get: (ip) => cache.get(ip) || null, set: (ip, data) => cache.set(ip, data) },
  });
  const first = await api.check('9.9.9.9');
  assert.equal(first.totalReports, 3);
  assert.deepEqual(first.categories, ['暴力破解', 'SSH 攻击']);
  const second = await api.check('9.9.9.9');
  assert.equal(fetchCount, 1);
  assert.deepEqual(second, first);
});

// ---------- 巡检 ① ----------
test('巡检①：24h 超限 IP 被封（scope 0 + 原因写明次数），已封的跳过，WAF 同步含该 IP', async () => {
  const mock = await startMock({
    overLimit: [{ ip: '1.2.3.4', n: 4 }, { ip: '5.6.7.8', n: 3 }],
    blocklist: [{ ip: '5.6.7.8', ip_segment: '5.6.7.8', scope: 0, expire_time: null }],
    recent: [],
    wafRules: [],
  });
  try {
    const deps = makeDeps(mock);
    const summary = await runPatrol(deps);
    assert.equal(summary.blocked.length, 1);
    assert.equal(summary.blocked[0].ip, '1.2.3.4');
    assert.equal(mock.calls.workerAdd.length, 1);
    assert.equal(mock.calls.workerAdd[0].ip, '1.2.3.4');
    assert.equal(mock.calls.workerAdd[0].scope, 0);
    assert.match(mock.calls.workerAdd[0].reason, /24h 内注册 4 次/);
    assert.equal(mock.calls.tg.length, 1); // 封禁告警
    assert.equal(mock.calls.alertLog.length, 1);
    assert.equal(mock.calls.alertLog[0].type, 'patrol');
    assert.equal(mock.calls.wafPut.length, 1);
    const expr = mock.calls.wafPut[0].rules[0].expression;
    assert.match(expr, /1\.2\.3\.4/);
    assert.match(expr, /5\.6\.7\.8/); // 已封的 scope 0 行也在 WAF 集里
    assert.match(expr, /http\.host eq "aevorynthtech\.com"/);
    assert.equal(summary.failed, false);
  } finally { await mock.close(); }
});

// ---------- 巡检 ② ----------
test('巡检②：AbuseIPDB 有举报即封（原因含举报数与类别），无举报不封', async () => {
  const mock = await startMock({
    overLimit: [],
    blocklist: [],
    recent: [{ ip: '9.9.9.9' }, { ip: '8.8.8.8' }],
    abuse: {
      '9.9.9.9': { ipAddress: '9.9.9.9', totalReports: 5, abuseConfidenceScore: 90, lastReportedAt: '2026-11-07T10:00:00+00:00', reports: [{ categories: [18] }] },
      '8.8.8.8': { ipAddress: '8.8.8.8', totalReports: 0, abuseConfidenceScore: 0, lastReportedAt: null },
    },
    wafRules: [],
  });
  try {
    const deps = makeDeps(mock);
    const summary = await runPatrol(deps);
    assert.equal(summary.abuseBlocked.length, 1);
    assert.equal(summary.abuseBlocked[0].ip, '9.9.9.9');
    assert.equal(mock.calls.workerAdd.length, 1);
    assert.match(mock.calls.workerAdd[0].reason, /AbuseIPDB 举报 5 次/);
    assert.match(mock.calls.workerAdd[0].reason, /暴力破解/);
    assert.equal(mock.calls.abuse.length, 2);
  } finally { await mock.close(); }
});

// ---------- 巡检 ③ ----------
test('巡检③：Resend 日配额 80% 告警每天 1 次；月配额 100% 立即告警', async () => {
  const mock = await startMock({
    overLimit: [], blocklist: [], recent: [],
    quota: { day: 85, month: 10, dayBudget: 100, monthBudget: 3000 },
    wafRules: [],
  });
  try {
    const dir = mkdtempSync(join(tmpdir(), 'patrol-quota-'));
    const deps = makeDeps(mock, {}, dir);
    await runPatrol(deps);
    assert.equal(mock.calls.tg.length, 1);
    assert.match(mock.calls.tg[0].text, /80%/);
    await runPatrol(makeDeps(mock, {}, dir)); // 同一天第二轮：不再告警
    assert.equal(mock.calls.tg.length, 1);

    const mock2 = await startMock({
      overLimit: [], blocklist: [], recent: [],
      quota: { day: 100, month: 3000, dayBudget: 100, monthBudget: 3000 },
      wafRules: [],
    });
    try {
      const dir2 = mkdtempSync(join(tmpdir(), 'patrol-quota100-'));
      await runPatrol(makeDeps(mock2, {}, dir2));
      assert.equal(mock2.calls.tg.length, 2); // 日 100% + 月 100% 各 1 条
      assert.ok(mock2.calls.tg.every((t) => /已用完/.test(t.text)));
    } finally { await mock2.close(); }
  } finally { await mock.close(); }
});

// ---------- dry-run ----------
test('dry-run：不发任何写请求（Worker 封禁 / WAF PUT / TG / AbuseIPDB 均为零）', async () => {
  const mock = await startMock({
    overLimit: [{ ip: '1.2.3.4', n: 4 }],
    blocklist: [],
    recent: [{ ip: '9.9.9.9' }],
    abuse: { '9.9.9.9': { ipAddress: '9.9.9.9', totalReports: 5, reports: [{ categories: [18] }] } },
    wafRules: [],
  });
  try {
    const deps = makeDeps(mock, { patrol: { intervalMinutes: 5, regWindowHours: 24, regLimit: 3, wafSyncEnabled: true, dryRun: true } });
    const summary = await runPatrol(deps);
    assert.equal(summary.blocked.length, 1); // 判定照常，只是没真封
    assert.equal(mock.calls.workerAdd.length, 0);
    assert.equal(mock.calls.wafPut.length, 0);
    assert.equal(mock.calls.tg.length, 0);
    assert.equal(mock.calls.abuse.length, 0);
    assert.equal(mock.calls.alertLog.length, 0);
    assert.ok(deps.worker.dryRunCalls.some((c) => c.path === '/ipBlocklist/add'));
  } finally { await mock.close(); }
});

// ---------- 失联检测 ----------
test('巡检⑤：连续 3 轮 D1 失败发一次“巡检失联”，恢复后发“巡检恢复”', async () => {
  const mock = await startMock({ d1Fail: true, wafRules: [] });
  try {
    const dir = mkdtempSync(join(tmpdir(), 'patrol-offline-'));
    const deps = () => makeDeps(mock, {}, dir);
    await runPatrol(deps());
    await runPatrol(deps());
    assert.equal(mock.calls.tg.filter((t) => /巡检失联/.test(t.text)).length, 0); // 2 轮还不够
    const s3 = await runPatrol(deps());
    assert.equal(s3.failed, true);
    assert.equal(mock.calls.tg.filter((t) => /巡检失联/.test(t.text)).length, 1);
    await runPatrol(deps()); // 第 4 轮仍失败：不再重复告警
    assert.equal(mock.calls.tg.filter((t) => /巡检失联/.test(t.text)).length, 1);
  } finally { await mock.close(); }

  // 恢复分支用新 mock + 同一个 state 目录
  const dir = mkdtempSync(join(tmpdir(), 'patrol-offline2-'));
  const failMock = await startMock({ d1Fail: true, wafRules: [] });
  try {
    const deps = () => makeDeps(failMock, {}, dir);
    await runPatrol(deps());
    await runPatrol(deps());
    await runPatrol(deps());
    assert.equal(failMock.calls.tg.filter((t) => /巡检失联/.test(t.text)).length, 1);
  } finally { await failMock.close(); }
  const okMock = await startMock({ overLimit: [], blocklist: [], recent: [], wafRules: [] });
  try {
    const summary = await runPatrol(makeDeps(okMock, {}, dir));
    assert.equal(summary.failed, false);
    assert.equal(okMock.calls.tg.filter((t) => /巡检恢复/.test(t.text)).length, 1);
  } finally { await okMock.close(); }
});

// ---------- index 子进程 ----------
test('index：--once --dry-run 对 mock 配置跑完 exit 0；缺配置明确报错 exit 1', async () => {
  const mock = await startMock({
    overLimit: [{ ip: '1.2.3.4', n: 4 }],
    blocklist: [], recent: [], wafRules: [],
  });
  try {
    const dir = mkdtempSync(join(tmpdir(), 'patrol-index-'));
    const cfgPath = join(dir, 'config.json');
    writeFileSync(cfgPath, JSON.stringify(makeConfig(mock.port)));
    const out = await execFileAsync('node', [join(ROOT, '..', 'src', 'index.js'), '--once', '--dry-run', '--config', cfgPath], { timeout: 15000 });
    assert.match(out.stdout, /本轮完成/);
    assert.match(out.stdout, /1\.2\.3\.4/);
    assert.doesNotMatch(out.stdout, /mock-cf-token|mock-admin-pass/); // 脱敏：日志无密钥
    assert.equal(mock.calls.workerAdd.length, 0);
    assert.equal(mock.calls.wafPut.length, 0);
    assert.equal(mock.calls.tg.length, 0);
  } finally { await mock.close(); }

  await assert.rejects(
    execFileAsync('node', [join(ROOT, '..', 'src', 'index.js'), '--once', '--config', '/nonexistent/patrol-x.json'], { timeout: 15000 }),
    (e) => {
      assert.equal(e.code, 1);
      assert.match(e.stderr || e.stdout || '', /配置文件不存在/);
      return true;
    },
  );
});
