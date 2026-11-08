# 自助彻底删除（PHASE7-HARDDELETE）

用户自助“彻底删除我的账号与数据”：把 `sync_delete` 的选择权从管理员下放到用户本人。
之前自删默认只是软删（`user.is_del = 1`，数据全留、管理员可恢复），想物理删除得
管理员先开同步删除；现在用户在安全中心自己就能选彻底删除，不用等管理员。

## 入口与流程

- 入口：安全中心 → “我的数据”区 → “彻底删除我的账号与数据”按钮。
- 双重确认（弹窗内两步，缺一不可）：
  1. 输入账号密码（无密码的 OAuth 账号可留空，只靠登录态 + 确认文字）；
  2. 输入确认文字 `DELETE`（固定英文大写，确认按钮未输对时禁用）。
- 接口：`POST /my/hard-delete`（body `{ password, confirmText }`），权限点复用
  `my:delete`（与 `DELETE /my/delete` 同组，任意登录用户可用）。

## 删什么、留什么

- 物理删除（复用 `user-service.physicsDelete()`，不另起炉灶）：账号行、全部
  邮件与附件记录（含 R2/KV/S3 里的附件对象）、OAuth 绑定、收藏、登录历史、
  TOTP / Passkey / 安全设置行、KV 会话（`SESSION_META` + `AUTH_INFO`）。
- 新增：个人文件清理（`removeUserFiles()`，physicsDelete 内调用，管理后台
  删号同样受益）：自定义壁纸 `wallpapers/{userId}/...`——R2/KV 按前缀列出
  全部删除；S3 无 list 接口，只删当前壁纸。最佳努力，失败只记日志、不阻断删号。
- 有意保留：`audit_log`（管理员留痕，删号本身记一条 `user:physics-delete`，
  detail 只有用户 id，不含任何内容）、`register_log`（风控计数）；两者受
  `log_retention_days`（默认 90 天）定期清理。见 PHASE7-PRIVACY-AUDIT.md §3.3。

## 安全护栏

- 只删本人：`userId` 取自登录态，不接受前端传的 userId；`physicsDelete`
  的 userIds 参数只传本人。
- 管理员账号拒绝：邮箱等于 `c.env.admin` 时直接 403（`hardDeleteAdminBlocked`）。
- 删后立即失效：`AUTH_INFO` KV 已删，旧 token 再调任何接口都 401；账号行
  已删，无法再登录。

## 测试

`mail-worker/test/phase7-harddelete.spec.js`（8 个用例）：未登录 401、错密码拒绝、
确认文字错误拒绝、正确密码 + DELETE 全量物理删除 + 旧 token 失效 + 无法再登录、
他人数据不受影响、自定义壁纸文件被删、管理员账号拒绝。

## 部署前

- 无需迁移、无需新配置、无需新绑定；直接随下次部署上线即可。
- 上线后人工验证一次：用测试账号走一遍彻底删除（确认删后登录失败、管理员
  后台能看到 `user:physics-delete` 审计行）。
