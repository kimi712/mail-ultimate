import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

// 注意：跑测试必须带 TZ=UTC（见 package.json 的 test:vitest）。
// 线上 Workers 永远是 UTC；但 KV 日期键（ai_day:/resend_day:）是业务代码用
// dayjs() 本地时间算的，测试用例用 toISOString（UTC）算的。机器时区不是 UTC 时
// （如北京时间凌晨 0–8 点），两边日期差一天，17 个配额/AI 测试会全挂。
// 2026-11-10 01:00 实测：不带 TZ=UTC 时 17 挂，带上后全绿。
export default defineWorkersConfig({
	test: {
		// 2026-11-12 uwu 第 1 步后：注册/登录各做一次 PBKDF2-600k 派生（约
		// 200ms/次，负载下更慢），beforeAll（/init + 注册 + 登录）与个别用例
		// 在多文件并行时会超过 vitest 默认的 hook 10 秒 / 用例 5 秒超时，
		// 导致整文件跳过（非代码失败）。放宽到 hook 60 秒、用例 30 秒。
		hookTimeout: 60000,
		testTimeout: 30000,
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.jsonc' },
			},
		},
	},
});
