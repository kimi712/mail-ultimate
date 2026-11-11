import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

// 注意：跑测试必须带 TZ=UTC（见 package.json 的 test:vitest）。
// 线上 Workers 永远是 UTC；但 KV 日期键（ai_day:/resend_day:）是业务代码用
// dayjs() 本地时间算的，测试用例用 toISOString（UTC）算的。机器时区不是 UTC 时
// （如北京时间凌晨 0–8 点），两边日期差一天，17 个配额/AI 测试会全挂。
// 2026-11-10 01:00 实测：不带 TZ=UTC 时 17 挂，带上后全绿。
export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.jsonc' },
			},
		},
	},
});
