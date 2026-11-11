<template>
  <div class="security-page">
    <el-scrollbar ref="scrollbarRef" height="100%">
      <div class="box">
        <!-- 顶部横排分区导航：点一下平滑滚动到对应分区 -->
        <section-nav :items="sectionNavItems" :container="scrollContainer" />
        <div class="title">{{ $t('securityCenter') }}</div>

        <!-- 安全评分：只展示，不锁功能 -->
        <div class="section" id="sec-score">
          <div class="section-title">{{ $t('securityScore') }}</div>
          <div class="score-row">
            <div class="score-num">{{ score }}<span class="score-total">/100</span></div>
            <el-progress :percentage="score" :show-text="false" class="score-bar" />
          </div>
          <div class="score-tip">{{ $t('securityScoreTip') }}</div>
          <!-- Phase 8 斯诺登元素补齐：分数解读行（按分数分档，给一句人话）。 -->
          <div class="score-level">{{ $t(scoreLevelKey) }}</div>
          <!-- 跨页跳转根治：加载态预留 410px（服务端 10 项分项），数据来了填进去不撑大页面。 -->
          <div class="score-list" :style="{ minHeight: scoreLoading ? '410px' : undefined }">
            <div v-for="item in scoreItems" :key="item.key" class="score-item">
              <span>{{ $t(scoreLabelKeys[item.key] || 'securityScore') }}</span>
              <el-tag :type="item.ok ? 'success' : 'info'">{{ item.score }}/{{ item.max }}</el-tag>
            </div>
          </div>
          <div v-if="scoreData && scoreData.suggestions && scoreData.suggestions.length" class="score-tip">
            <div v-for="s in scoreData.suggestions" :key="s">· {{ $t(s) }}</div>
          </div>
        </div>

        <!-- 捐赠：DOGE 地址（用户公开收款地址，全文显示）+ 二维码 + 一键复制；自愿、不设门槛。
             2026-11-10 移到顶部、紧跟安全评分（此前在页尾，翻到底才看得到），金色高亮卡片；2026-11-11 加上 Telegram 群入口。 -->
        <div class="section donate-highlight" id="sec-donate">
          <div class="section-title">{{ $t('donateSection') }}</div>
          <div class="desc">{{ $t('donateDesc') }}</div>
          <div class="donate-box">
            <img src="/doge-donate-qr.svg" alt="Dogecoin donation QR code" class="donate-qr" />
            <div class="donate-info">
              <div class="donate-label">Dogecoin (DOGE)</div>
              <div class="donate-address">DQHXxoMoPrxkCjV1CejbsVxvvQswydhoCd</div>
              <el-button type="primary" @click="copyText('DQHXxoMoPrxkCjV1CejbsVxvvQswydhoCd')">{{ $t('donateCopy') }}</el-button>
            </div>
          </div>
          <div class="desc">{{ $t('donateNote') }}</div>
          <div class="donate-box">
            <div class="donate-info">
              <div class="donate-label">Telegram</div>
              <div class="donate-address">t.me/nicofreevery</div>
              <el-button type="primary" @click="openTelegramGroup">{{ $t('donateTelegramJoin') }}</el-button>
            </div>
          </div>
        </div>

        <!-- 设备管理（当前登录的全部设备，发现陌生设备请立即踢出并改密码） -->
        <div class="section" id="sec-sessions">
          <div class="section-title">{{ $t('sessionTitle') }}</div>
          <div class="desc">{{ $t('securityDevicesHint') }}</div>
          <div class="row">
            <el-button :loading="sessionLoading" @click="revokeOthers">{{ $t('sessionRevokeOthers') }}</el-button>
          </div>
          <!-- 跨页跳转根治：加载态预留 160px（表头 + 3 行会话），数据来了填进去不撑大页面。 -->
          <div class="tbl-reserve" :style="{ minHeight: sessionLoading ? '160px' : undefined }">
          <el-table :data="sessionList" v-loading="sessionLoading" style="width: 100%" :empty-text="$t('sessionEmpty')">
            <el-table-column :label="$t('loginLogDevice')">
              <template #default="{row}">{{ [row.device, row.browser].filter(Boolean).join(' · ') || row.ua || $t('sessionUnknown') }}</template>
            </el-table-column>
            <el-table-column prop="ip" :label="$t('loginLogIp')" width="160" />
            <el-table-column prop="createdAt" :label="$t('loginLogTime')" width="180" />
            <el-table-column prop="lastActiveAt" :label="$t('sessionLastActive')" width="180" />
            <el-table-column width="150">
              <template #default="{row}">
                <el-tag v-if="row.current" type="success">{{ $t('sessionCurrent') }}</el-tag>
                <el-button v-else type="danger" link @click="revokeOne(row)">{{ $t('sessionRevoke') }}</el-button>
              </template>
            </el-table-column>
          </el-table>
          </div>
        </div>

        <!-- 登录历史（最近 20 条，走 Phase 7 新接口 GET /security/login-history） -->
        <div class="section" id="sec-login-history">
          <div class="section-title">{{ $t('loginLogTitle') }}</div>
          <div class="desc">{{ $t('securityLoginHistoryNoGeo') }}</div>
          <!-- 跨页跳转根治：加载态预留 840px（表头 + 20 行），数据来了填进去不撑大页面。 -->
          <div class="tbl-reserve" :style="{ minHeight: loginLogLoading ? '840px' : undefined }">
          <el-table :data="loginLogList" v-loading="loginLogLoading" style="width: 100%" :empty-text="$t('loginLogEmpty')">
            <el-table-column prop="time" :label="$t('loginLogTime')" width="180" />
            <el-table-column prop="ip" :label="$t('loginLogIp')" width="160" />
            <el-table-column :label="$t('loginLogDevice')">
              <template #default="{row}">{{ [row.device, row.browser].filter(Boolean).join(' · ') || $t('sessionUnknown') }}</template>
            </el-table-column>
            <el-table-column :label="$t('securityLoginHistoryLocation')" width="110">
              <template #default="{row}">{{ row.location || $t('securityLoginHistoryNoLocation') }}</template>
            </el-table-column>
            <el-table-column :label="$t('loginLogNewIp')" width="110">
              <template #default="{row}">
                <el-tag v-if="row.isNewIp === 1" type="warning">{{ $t('loginLogIsNew') }}</el-tag>
                <el-tag v-else type="info">{{ $t('loginLogNotNew') }}</el-tag>
              </template>
            </el-table-column>
          </el-table>
          </div>
        </div>

        <!-- 审计记录（仅本人，Phase 8 B：GET /security/audit-log） -->
        <div class="section" id="sec-audit">
          <div class="section-title">{{ $t('securityAuditTitle') }}</div>
          <div class="desc">{{ $t('securityAuditDesc') }}</div>
          <div class="row">
            <el-select v-model="auditType" style="width: 200px" @change="loadAuditLog">
              <el-option value="" :label="$t('securityAuditAll')" />
              <el-option value="login" label="login" />
              <el-option value="security" label="security" />
              <el-option value="totp" label="totp" />
              <el-option value="passkey" label="passkey" />
              <el-option value="export" label="export" />
              <el-option value="delete" label="delete" />
              <el-option value="session" label="session" />
              <el-option value="setting" label="setting" />
              <el-option value="user" label="user" />
            </el-select>
            <el-button :loading="auditLoading" @click="loadAuditLog">{{ $t('refresh') }}</el-button>
          </div>
          <!-- 跨页跳转根治：加载态预留 840px（表头 + 20 行），数据来了填进去不撑大页面。 -->
          <div class="tbl-reserve" :style="{ minHeight: auditLoading ? '840px' : undefined }">
          <el-table :data="auditLogList" v-loading="auditLoading" style="width: 100%" :empty-text="$t('securityAuditEmpty')">
            <el-table-column prop="time" :label="$t('loginLogTime')" width="180" />
            <el-table-column prop="action" :label="$t('securityAuditAction')" width="200" />
            <el-table-column prop="ip" :label="$t('loginLogIp')" width="160" />
            <el-table-column :label="$t('loginLogDevice')">
              <!-- UA 单行省略（悬停看全文）：120 字符 UA 在 320px 列宽里会换 3 行、行高从 39px 涨到 ~85px，20 行能差出 900px，行高必须确定化。 -->
              <template #default="{row}"><span class="cell-ellipsis" :title="row.ua || '-'">{{ row.ua || '-' }}</span></template>
            </el-table-column>
          </el-table>
          </div>
          <div class="row">
            <el-button :disabled="auditNum <= 1" @click="auditPrev">{{ $t('securityAuditPrev') }}</el-button>
            <el-button :disabled="auditLogList.length < auditSize" @click="auditNext">{{ $t('securityAuditNext') }}</el-button>
          </div>
        </div>

        <!-- TOTP 二次验证 -->
        <div class="section" id="sec-totp">
          <div class="section-title">{{ $t('totpTitle') }}</div>
          <div class="desc">{{ $t('totpDesc') }}</div>
          <div class="row">
            <el-tag :type="totpEnabled ? 'success' : 'info'">{{ totpEnabled ? $t('securityOn') : $t('securityOff') }}</el-tag>
            <el-input v-if="totpEnabled" v-model="rebindOldCode" :placeholder="$t('totpOldCodePlaceholder')" maxlength="6" class="code-input" />
            <el-button type="primary" :loading="totpLoading" @click="startTotpSetup">{{ totpEnabled ? $t('totpRebind') : $t('totpSetup') }}</el-button>
            <el-button v-if="totpEnabled" @click="showDisableTotp = !showDisableTotp">{{ $t('totpDisable') }}</el-button>
          </div>
          <div v-if="setupData" class="totp-setup">
            <div class="desc">{{ $t('totpSetupTip') }}</div>
            <div v-if="setupData.qr" class="totp-qr">
              <canvas ref="totpQrCanvas" />
              <div class="desc">{{ $t('totpQrTip') }}</div>
            </div>
            <div v-else class="desc">{{ $t('totpQrUnavailable') }}</div>
            <div class="kv-row">
              <span class="kv-label">{{ $t('totpSecret') }}</span>
              <el-input :model-value="setupData.secret" readonly class="secret-input" />
              <el-button @click="copyText(setupData.secret)">{{ $t('totpCopy') }}</el-button>
            </div>
            <div class="kv-row">
              <span class="kv-label">{{ $t('totpOtpauthUrl') }}</span>
              <el-input :model-value="setupData.otpauthUrl" readonly class="secret-input" />
              <el-button @click="copyText(setupData.otpauthUrl)">{{ $t('totpCopy') }}</el-button>
            </div>
            <div class="kv-row">
              <span class="kv-label">{{ $t('totpCode') }}</span>
              <el-input v-model="setupCode" :placeholder="$t('totpCodePlaceholder')" maxlength="6" class="code-input" @keyup.enter="confirmTotpEnable" />
              <el-button type="primary" :loading="totpLoading" @click="confirmTotpEnable">{{ $t('totpEnable') }}</el-button>
            </div>
          </div>
          <div v-if="showDisableTotp && totpEnabled" class="totp-setup">
            <div class="desc">{{ $t('totpNeedPassword') }}</div>
            <div class="kv-row">
              <span class="kv-label">{{ $t('totpPassword') }}</span>
              <el-input v-model="disablePassword" type="password" :placeholder="$t('totpPasswordPlaceholder')" autocomplete="off" class="code-input" />
            </div>
            <div class="kv-row">
              <span class="kv-label">{{ $t('totpCode') }}</span>
              <el-input v-model="disableCode" :placeholder="$t('totpCodePlaceholder')" maxlength="6" class="code-input" @keyup.enter="confirmTotpDisable" />
              <el-button type="danger" :loading="totpLoading" @click="confirmTotpDisable">{{ $t('totpDisable') }}</el-button>
            </div>
          </div>
        </div>

        <!-- Passkey 管理 -->
        <div class="section" id="sec-passkey">
          <div class="section-title">{{ $t('passkeyTitle') }}</div>
          <div class="desc">{{ $t('passkeyDesc') }}</div>
          <div class="row">
            <el-button type="primary" :loading="passkeyLoading" @click="registerPasskey">{{ $t('passkeyRegister') }}</el-button>
          </div>
          <!-- 跨页跳转根治：加载态预留 120px（表头 + 2 行），数据来了填进去不撑大页面。 -->
          <div class="tbl-reserve" :style="{ minHeight: passkeyLoading ? '120px' : undefined }">
          <el-table :data="passkeys" v-loading="passkeyLoading" style="width: 100%" :empty-text="$t('passkeyEmpty')">
            <el-table-column label="ID">
              <!-- credentialId 是长 base64url 字符串，单行省略（悬停看全文），避免换行撑高行高。 -->
              <template #default="{row}"><span class="cell-ellipsis" :title="row.credentialId">{{ row.credentialId }}</span></template>
            </el-table-column>
            <el-table-column prop="name" :label="$t('passkeyTitle')" />
            <el-table-column prop="createdTime" :label="$t('passkeyCreated')" width="180" />
            <el-table-column width="110">
              <template #default="{row}">
                <el-button type="danger" link @click="deletePasskey(row)">{{ $t('delete') }}</el-button>
              </template>
            </el-table-column>
          </el-table>
          </div>
        </div>

        <!-- 提醒开关与保留期限 -->
        <div class="section" id="sec-login-alert">
          <div class="section-title">{{ $t('securityLoginAlert') }}</div>
          <div class="desc">{{ $t('securityLoginAlertDesc') }}</div>
          <div class="row">
            <el-switch v-model="loginAlertOn" :loading="saving" @change="onLoginAlertChange" />
            <span>{{ loginAlertOn ? $t('securityOn') : $t('securityOff') }}</span>
          </div>
        </div>
        <div class="section" id="sec-retention">
          <div class="section-title">{{ $t('securityRetention') }}</div>
          <div class="desc">{{ $t('securityRetentionDesc') }}</div>
          <el-select v-model="security.retentionDays" :disabled="saving" @change="onRetentionChange" style="width: 220px">
            <el-option :value="0" :label="$t('securityRetention0')" />
            <el-option :value="30" :label="$t('securityRetention30')" />
            <el-option :value="90" :label="$t('securityRetention90')" />
            <el-option :value="365" :label="$t('securityRetention365')" />
          </el-select>
        </div>

        <!-- 端到端加密（可选，诚实边界见 PHASE2-4.md §3.5） -->
        <div class="section" id="sec-e2ee">
          <div class="section-title">{{ $t('e2eeTitle') }}</div>
          <div class="desc">{{ $t('e2eeDesc') }}</div>
          <el-alert :closable="false" type="warning" show-icon class="e2ee-warn">
            <template #title>
              <div>{{ $t('e2eeWarnForgot') }}</div>
              <div>{{ $t('e2eeWarnSearch') }}</div>
              <div>{{ $t('e2eeWarnExternal') }}</div>
              <div>{{ $t('e2eeWarnAttachment') }}</div>
            </template>
          </el-alert>
          <div class="row">
            <el-tag :type="security.e2eeEnabled ? 'success' : 'info'">{{ security.e2eeEnabled ? $t('securityOn') : $t('securityOff') }}</el-tag>
            <el-tag :type="e2eeUnlocked ? 'success' : 'info'">{{ e2eeUnlocked ? $t('e2eeUnlocked') : $t('e2eeLocked') }}</el-tag>
          </div>
          <div class="kv-row">
            <span class="kv-label">{{ $t('e2eePassword') }}</span>
            <el-input v-model="e2eePassword" type="password" :placeholder="$t('e2eePasswordPlaceholder')" autocomplete="off" class="code-input" @keyup.enter="e2eeEnabled ? unlockE2ee() : enableE2ee()" />
            <el-button v-if="!security.e2eeEnabled" type="primary" :loading="e2eeLoading" @click="enableE2ee">{{ $t('e2eeEnableUnlock') }}</el-button>
            <el-button v-else-if="!e2eeUnlocked" type="primary" :loading="e2eeLoading" @click="unlockE2ee">{{ $t('e2eeUnlock') }}</el-button>
            <el-button v-else @click="lockE2ee">{{ $t('e2eeLock') }}</el-button>
          </div>
          <div class="desc">{{ $t('e2eePasswordHint') }}</div>
          <div v-if="security.e2eeEnabled" class="row">
            <el-button :loading="e2eeLoading" @click="disableE2ee">{{ $t('e2eeDisable') }}</el-button>
          </div>
        </div>

        <!-- 开源接受审查（2026-11-11）：代码公开在 GitHub，E2EE 开启后连管理员也读不了站内邮件。 -->
        <div class="section" id="sec-opensource">
          <div class="section-title">{{ $t('openSourceTitle') }}</div>
          <div class="desc">{{ $t('openSourceDesc') }}</div>
          <div class="desc">{{ $t('openSourceDesc2') }}</div>
          <div class="donate-box">
            <div class="donate-info">
              <div class="donate-label">GitHub</div>
              <div class="donate-address">github.com/kimi712/mail-ultimate</div>
              <el-button type="primary" @click="openGithub">{{ $t('openSourceViewRepo') }}</el-button>
            </div>
          </div>
        </div>

        <!-- 抗量子密钥（斯诺登第二批，v3_15DB）：ML-KEM-768，FIPS 203 -->
        <div class="section" id="sec-mlkem">
          <div class="section-title">{{ $t('mlkemTitle') }}</div>
          <div class="desc">{{ $t('mlkemDesc') }}</div>
          <div class="desc">{{ $t('mlkemDesc2') }}</div>
          <div class="row">
            <el-tag :type="security.mlkemEnabled ? 'success' : 'info'">{{ security.mlkemEnabled ? $t('securityOn') : $t('securityOff') }}</el-tag>
            <el-button v-if="!security.mlkemEnabled" type="primary" :loading="mlkemLoading" :disabled="!security.e2eeEnabled" @click="generateMlkem(false)">{{ $t('mlkemGenerate') }}</el-button>
            <el-button v-else :loading="mlkemLoading" @click="generateMlkem(true)">{{ $t('mlkemRegenerate') }}</el-button>
            <el-button :loading="mlkemVerifying" @click="verifyMlkem">{{ $t('mlkemVerify') }}</el-button>
          </div>
          <div v-if="!security.e2eeEnabled" class="desc">{{ $t('mlkemNeedE2ee') }}</div>
          <div v-if="security.e2eeEnabled && !e2eeUnlocked" class="desc">{{ $t('mlkemNeedUnlock') }}</div>
        </div>

        <!-- 死亡开关（斯诺登第二批，v3_15DB）：失联到期自动执行 -->
        <div class="section" id="sec-deadman">
          <div class="section-title">{{ $t('deadmanTitle') }}</div>
          <div class="desc">{{ $t('deadmanDesc') }}</div>
          <div class="desc">{{ $t('deadmanDesc2') }}</div>
          <div class="row">
            <el-tag :type="deadman.enabled ? 'warning' : 'info'">{{ deadman.enabled ? $t('deadmanArmed') : $t('securityOff') }}</el-tag>
            <span v-if="deadman.lastActiveAt" class="desc">{{ $t('deadmanLastActive', { time: deadman.lastActiveAt, days: deadman.inactiveDays }) }}</span>
          </div>
          <div v-if="deadman.status === 'warned'" class="row">
            <el-alert :closable="false" type="warning" show-icon :title="$t('deadmanWarned', { time: deadman.warnedAt })" />
          </div>
          <div v-if="deadman.status === 'executed'" class="row">
            <el-alert :closable="false" type="info" show-icon :title="$t('deadmanExecuted', { time: deadman.executedAt })" />
          </div>
          <div class="kv-row">
            <span class="kv-label">{{ $t('deadmanDays') }}</span>
            <el-select v-model="deadman.inactivityDays" :disabled="deadmanSaving" style="width: 220px">
              <el-option :value="30" :label="$t('deadmanDays30')" />
              <el-option :value="60" :label="$t('deadmanDays60')" />
              <el-option :value="90" :label="$t('deadmanDays90')" />
            </el-select>
          </div>
          <div class="kv-row">
            <span class="kv-label">{{ $t('deadmanAction') }}</span>
            <el-select v-model="deadman.action" :disabled="deadmanSaving" style="width: 220px">
              <el-option value="delete" :label="$t('deadmanActionDelete')" />
              <el-option value="notify" :label="$t('deadmanActionNotify')" />
            </el-select>
          </div>
          <div v-if="deadman.action === 'notify'">
            <div class="kv-row">
              <span class="kv-label">{{ $t('deadmanContact') }}</span>
              <el-input v-model="deadman.contactEmail" :placeholder="$t('deadmanContactPlaceholder')" autocomplete="off" class="code-input" />
            </div>
            <div class="kv-row">
              <span class="kv-label">{{ $t('deadmanMessage') }}</span>
              <el-input v-model="deadman.message" type="textarea" :rows="3" :placeholder="$t('deadmanMessagePlaceholder')" autocomplete="off" class="code-input" />
            </div>
          </div>
          <div class="row">
            <el-button type="primary" :loading="deadmanSaving" @click="saveDeadman">{{ $t('deadmanSave') }}</el-button>
            <el-button v-if="deadman.enabled" :loading="deadmanSaving" @click="disableDeadmanFn">{{ $t('deadmanDisable') }}</el-button>
          </div>
        </div>

        <!-- 胁迫密码（斯诺登第三批，v3_16DB）：第二密码进诱饵邮箱 -->
        <div class="section" id="sec-duress">
          <div class="section-title">{{ $t('duressTitle') }}</div>
          <div class="desc">{{ $t('duressDesc') }}</div>
          <div class="desc">{{ $t('duressDesc2') }}</div>
          <div class="row">
            <el-tag :type="duressEnabled ? 'warning' : 'info'">{{ duressEnabled ? $t('duressSet') : $t('securityOff') }}</el-tag>
          </div>
          <div class="kv-row">
            <span class="kv-label">{{ $t('totpPassword') }}</span>
            <el-input v-model="duressMainPassword" type="password" :placeholder="$t('duressMainPasswordPlaceholder')" autocomplete="off" class="code-input" />
          </div>
          <div class="kv-row">
            <span class="kv-label">{{ $t('duressPassword') }}</span>
            <el-input v-model="duressPassword" type="password" :placeholder="$t('duressPasswordPlaceholder')" autocomplete="off" class="code-input" />
          </div>
          <div class="row">
            <el-button type="primary" :loading="duressLoading" @click="saveDuress">{{ duressEnabled ? $t('duressChange') : $t('duressSetBtn') }}</el-button>
            <el-button v-if="duressEnabled" :loading="duressLoading" @click="disableDuressFn">{{ $t('duressDisable') }}</el-button>
          </div>
          <div class="desc">{{ $t('duressHint') }}</div>
        </div>

        <!-- 密钥分片（斯诺登第三批，v3_16DB）：Shamir 5 片取 3，恢复 E2EE 密钥 -->
        <div class="section" id="sec-shamir">
          <div class="section-title">{{ $t('shamirTitle') }}</div>
          <div class="desc">{{ $t('shamirDesc') }}</div>
          <div class="desc">{{ $t('shamirDesc2') }}</div>
          <div class="row">
            <el-button type="primary" :loading="shamirLoading" :disabled="!security.e2eeEnabled || !e2eeUnlocked" @click="exportShamir">{{ $t('shamirExport') }}</el-button>
            <el-button :loading="shamirLoading" @click="shamirRecoverVisible = !shamirRecoverVisible">{{ $t('shamirRecover') }}</el-button>
          </div>
          <div v-if="!security.e2eeEnabled" class="desc">{{ $t('mlkemNeedE2ee') }}</div>
          <div v-if="security.e2eeEnabled && !e2eeUnlocked" class="desc">{{ $t('mlkemNeedUnlock') }}</div>
          <div v-if="shamirShares.length" class="totp-setup">
            <div class="desc">{{ $t('shamirExportTip') }}</div>
            <div v-for="(share, i) in shamirShares" :key="i" class="kv-row">
              <span class="kv-label">{{ $t('shamirShare', { n: i + 1 }) }}</span>
              <el-input :model-value="share" readonly class="secret-input" />
              <el-button @click="copyText(share)">{{ $t('totpCopy') }}</el-button>
            </div>
          </div>
          <div v-if="shamirRecoverVisible" class="totp-setup">
            <div class="desc">{{ $t('shamirRecoverTip') }}</div>
            <el-input v-model="shamirInput1" :placeholder="$t('shamirSharePlaceholder', { n: 1 })" autocomplete="off" />
            <el-input v-model="shamirInput2" :placeholder="$t('shamirSharePlaceholder', { n: 2 })" autocomplete="off" />
            <el-input v-model="shamirInput3" :placeholder="$t('shamirSharePlaceholder', { n: 3 })" autocomplete="off" />
            <div class="row">
              <el-button type="primary" :loading="shamirLoading" @click="recoverShamir">{{ $t('shamirRecoverBtn') }}</el-button>
            </div>
          </div>
        </div>

        <!-- 零知识身份（斯诺登第三批，v3_16DB）：挑战-应答，服务端只存验证子 -->
        <div class="section" id="sec-zk">
          <div class="section-title">{{ $t('zkTitle') }}</div>
          <div class="desc">{{ $t('zkDesc') }}</div>
          <div class="desc">{{ $t('zkDesc2') }}</div>
          <div class="row">
            <el-tag :type="zkEnabled ? 'success' : 'info'">{{ zkEnabled ? $t('securityOn') : $t('securityOff') }}</el-tag>
          </div>
          <div class="kv-row">
            <span class="kv-label">{{ $t('totpPassword') }}</span>
            <el-input v-model="zkMainPassword" type="password" :placeholder="$t('duressMainPasswordPlaceholder')" autocomplete="off" class="code-input" />
          </div>
          <div class="row">
            <el-button type="primary" :loading="zkLoading" @click="setupZkFn">{{ zkEnabled ? $t('zkReSetup') : $t('zkSetup') }}</el-button>
            <el-button v-if="zkEnabled" :loading="zkLoading" @click="disableZkFn">{{ $t('zkDisable') }}</el-button>
          </div>
          <div class="desc">{{ $t('zkHint') }}</div>
        </div>

        <!-- 闲置自动锁定 -->
        <div class="section" id="sec-autolock">
          <div class="section-title">{{ $t('securityAutoLock') }}</div>
          <div class="desc">{{ $t('securityAutoLockDesc') }}</div>
          <el-select v-model="security.autoLockMinutes" :disabled="saving" @change="onAutoLockChange" style="width: 220px">
            <el-option :value="0" :label="$t('securityAutoLock0')" />
            <el-option :value="5" :label="$t('securityAutoLock5')" />
            <el-option :value="15" :label="$t('securityAutoLock15')" />
            <el-option :value="30" :label="$t('securityAutoLock30')" />
          </el-select>
        </div>

        <!-- 我的数据：导出与删除 -->
        <div class="section" id="sec-mydata">
          <div class="section-title">{{ $t('securityMyData') }}</div>
          <!-- Phase 8 F：隐私仪表盘入口（数据清单 / 开关 / 第三方 / 恢复状态 / 新 IP 提醒）。 -->
          <div class="desc">{{ $t('privacyDashboardDesc') }}</div>
          <div class="row">
            <el-button @click="router.push({name: 'privacy'})">{{ $t('privacyDashboard') }}</el-button>
          </div>
          <div class="desc">{{ $t('securityExportDesc') }}</div>
          <div class="row">
            <el-button :loading="exportLoading" @click="exportMyData">{{ $t('securityExport') }}</el-button>
          </div>
          <div class="desc">{{ $t('securityDeleteAccountDesc') }}</div>
          <div class="row">
            <el-button type="danger" :loading="deleteLoading" @click="deleteMyAccount">{{ $t('securityDeleteAccount') }}</el-button>
          </div>
          <div class="desc">{{ $t('securityHardDeleteAccountDesc') }}</div>
          <div class="row">
            <el-button type="danger" plain :loading="hardDeleteLoading" @click="hardDeleteDialogVisible = true">{{ $t('securityHardDeleteAccount') }}</el-button>
          </div>
        </div>

        <!-- 透明度与金丝雀：本站承诺 + 截至某日未收到秘密传唤的声明（日期由管理员在系统设置里维护）。 -->
        <div class="section" id="sec-canary">
          <div class="section-title">{{ $t('canarySection') }}</div>
          <div class="desc">{{ $t('canaryTransparency') }}</div>
          <div class="canary-box">
            <div class="canary-icon">🐤</div>
            <div>
              <div class="canary-text">{{ $t('canaryStatement', { date: canaryDate }) }}</div>
              <div class="desc">{{ $t('canaryUpdated', { date: canaryDate }) }}</div>
            </div>
          </div>
          <div class="desc">{{ $t('canaryExplain') }}</div>
        </div>


        <!-- 彻底删除确认框：密码 + 输入 DELETE，双重确认 -->
        <el-dialog v-model="hardDeleteDialogVisible" :title="$t('securityHardDeleteTitle')" width="480px" :close-on-click-modal="false">
          <div class="desc" style="margin-bottom: 12px">{{ $t('securityHardDeleteWarning') }}</div>
          <el-input v-model="hardDeletePassword" type="password" :placeholder="$t('securityHardDeletePassword')" autocomplete="off" show-password />
          <div class="desc" style="margin: 8px 0 12px">{{ $t('securityHardDeletePasswordHint') }}</div>
          <el-input v-model="hardDeleteConfirmText" :placeholder="$t('securityHardDeleteConfirmHint')" autocomplete="off" />
          <template #footer>
            <el-button @click="hardDeleteDialogVisible = false">{{ $t('cancel') }}</el-button>
            <el-button type="danger" :disabled="hardDeleteConfirmText !== 'DELETE'" :loading="hardDeleteLoading" @click="confirmHardDelete">{{ $t('securityHardDeleteButton') }}</el-button>
          </template>
        </el-dialog>

      </div>
    </el-scrollbar>
  </div>
</template>
<script setup>
import {ref, reactive, computed, defineOptions, onMounted, nextTick} from 'vue'
import {useI18n} from 'vue-i18n'
import {useRouter, useRoute} from 'vue-router'
import {scrollToQueryAnchor} from '@/utils/anchor-scroll.js'
import {userDelete, hardDeleteMyAccount, getCanary} from '@/request/my.js'
import {
  getSecurity, setSecurity,
  totpSetup, totpEnable, totpDisable,
  passkeyRegisterOptions, passkeyRegister, passkeyList, passkeyDelete,
  sessions, revokeSession, revokeOtherSessions,
  loginHistory, exportData, getSecurityScore, myAuditLog,
  getMlkemPrivate, setMlkemKeys, getDeadman, setDeadman, disableDeadman
} from '@/request/security.js'
import {
  generateSalt, unlockWithPassword, hasMemoryKey, getMemoryKey, clearMemoryKey,
  exportKekRaw, importKekRaw
} from '@/utils/e2ee.js'
import {splitSecret, recoverSecret, isValidShare} from '@/utils/shamir.js'
import {buildZkSetupField} from '@/utils/zklogin.js'
import {
  getDuressStatus, setDuressPassword, changeDuressPassword, disableDuressPassword,
  getZkStatus, setupZk, disableZk
} from '@/request/snowden3.js'
import {
  generateMlKemKeypair, encryptMlkemPrivateKey, decryptMlkemPrivateKey,
  selfTestMlKem, clearMemoryMlkemPrivateKey, setMemoryMlkemPrivateKey
} from '@/utils/pqkem.js'
import {optionsToCreateArgs, credentialToJson} from '@/utils/webauthn.js'
import SectionNav from "@/components/section-nav/index.vue";

defineOptions({
  name: 'security'
})

const {t} = useI18n()
const router = useRouter()
const route = useRoute()

// 顶部横排分区导航：点一下平滑滚动到对应分区
const scrollbarRef = ref(null)
const scrollContainer = computed(() => scrollbarRef.value?.wrapRef || null)
const sectionNavItems = computed(() => [
  { id: 'sec-score', label: t('securityScore') },
  { id: 'sec-donate', label: t('donateSection') },
  { id: 'sec-sessions', label: t('sessionTitle') },
  { id: 'sec-login-history', label: t('loginLogTitle') },
  { id: 'sec-audit', label: t('securityAuditTitle') },
  { id: 'sec-totp', label: t('totpTitle') },
  { id: 'sec-passkey', label: t('passkeyTitle') },
  { id: 'sec-login-alert', label: t('securityLoginAlert') },
  { id: 'sec-retention', label: t('securityRetention') },
  { id: 'sec-e2ee', label: t('e2eeTitle') },
  { id: 'sec-opensource', label: t('openSourceTitle') },
  { id: 'sec-mlkem', label: t('mlkemTitle') },
  { id: 'sec-deadman', label: t('deadmanTitle') },
  { id: 'sec-duress', label: t('duressTitle') },
  { id: 'sec-shamir', label: t('shamirTitle') },
  { id: 'sec-zk', label: t('zkTitle') },
  { id: 'sec-autolock', label: t('securityAutoLock') },
  { id: 'sec-mydata', label: t('securityMyData') },
  { id: 'sec-canary', label: t('canarySection') },
])

const security = reactive({
  loginAlert: 1,
  e2eeEnabled: 0,
  retentionDays: 0,
  e2eeSalt: '',
  autoLockMinutes: 0,
  mlkemEnabled: 0
})
const loginAlertOn = ref(true)
const saving = ref(false)

// 斯诺登第二批（v3_15DB）：抗量子密钥 + 死亡开关状态。
const mlkemLoading = ref(false)
const mlkemVerifying = ref(false)
const deadman = reactive({
  enabled: 0, inactivityDays: 90, action: 'delete',
  contactEmail: '', message: '', status: 'off',
  warnedAt: '', executedAt: '', lastActiveAt: '', inactiveDays: 0
})
const deadmanLoading = ref(false)
const deadmanSaving = ref(false)

// 斯诺登第三批（v3_16DB）：胁迫密码 + 密钥分片 + 零知识身份。
const duressEnabled = ref(false)
const duressLoading = ref(false)
const duressMainPassword = ref('')
const duressPassword = ref('')
const shamirLoading = ref(false)
const shamirShares = ref([])
const shamirRecoverVisible = ref(false)
const shamirInput1 = ref('')
const shamirInput2 = ref('')
const shamirInput3 = ref('')
const zkEnabled = ref(false)
const zkLoading = ref(false)
const zkMainPassword = ref('')

// 契约 §1.3 的 GET /my/security 未列出 totpEnabled 字段；若 B 路返回则采用，
// 否则按未开启计分（见汇报“待对齐项”）。本页内成功启用/关闭后立即同步本地状态。
const totpEnabled = ref(false)
const totpLoading = ref(false)
const setupData = ref(null)
const setupCode = ref('')
const showDisableTotp = ref(false)
const disablePassword = ref('')
const disableCode = ref('')

const passkeys = ref([])
const passkeyLoading = ref(true)

const loginLogList = ref([])
const loginLogLoading = ref(true)
const loginLogLoaded = ref(false)

const sessionList = ref([])
const sessionLoading = ref(true)

// Phase 8 B：服务端评分（分项 + 建议）与本人审计记录。
const scoreData = ref(null)
// 跨页跳转根治：评分列表加载态预留高度（服务端 10 项约 410px），数据来了填进去不撑大页面。
const scoreLoading = ref(true)
const scoreLabelKeys = {
  totp: 'securityScoreTotp',
  passkey: 'securityScorePasskey',
  loginAlert: 'securityScoreLoginAlert',
  autoLock: 'securityScoreAutoLock',
  e2ee: 'securityScoreE2ee',
  loginHistory: 'securityScoreLoginHistory',
  passwordStrength: 'securityScorePasswordStrength',
  passwordAge: 'securityScorePasswordAge',
  sessions: 'securityScoreSessions',
  auditAnomaly: 'securityScoreAuditAnomaly'
}
const auditLogList = ref([])
const auditLoading = ref(true)
const auditType = ref('')
const auditNum = ref(1)
const auditSize = 20
const rebindOldCode = ref('')
const totpQrCanvas = ref(null)

const e2eePassword = ref('')
const e2eeUnlocked = ref(false)
const e2eeLoading = ref(false)
const exportLoading = ref(false)
const deleteLoading = ref(false)
const hardDeleteDialogVisible = ref(false)
const hardDeletePassword = ref('')
const hardDeleteConfirmText = ref('')
const hardDeleteLoading = ref(false)

// 安全评分：优先用服务端 GET /security/score 的 9 项分项（总分 100）；
// 接口失败时回退到旧的本地 4 项计算（TOTP 30 + Passkey 30 + 登录提醒 20 + 30 天无新 IP 20）。
const noNewIp30d = computed(() => {
  if (!loginLogLoaded.value) {
    return false
  }
  const now = Date.now()
  return !loginLogList.value.some((row) => {
    if (row.isNewIp !== 1 || !row.time) {
      return false
    }
    const ts = Date.parse(String(row.time).replace(' ', 'T') + 'Z')
    return !isNaN(ts) && (now - ts) <= 30 * 24 * 3600 * 1000
  })
})
const score = computed(() => {
  if (scoreData.value && typeof scoreData.value.total === 'number') {
    return scoreData.value.total
  }
  let s = 0
  if (totpEnabled.value) {
    s += 30
  }
  if (passkeys.value.length) {
    s += 30
  }
  if (security.loginAlert) {
    s += 20
  }
  if (noNewIp30d.value) {
    s += 20
  }
  return s
})
// Phase 8 斯诺登元素补齐：分数解读分档（90+ 优秀 / 70+ 良好 / 50+ 一般 / 其余较弱）。
const scoreLevelKey = computed(() => {
  if (score.value >= 90) return 'securityScoreLevelExcellent'
  if (score.value >= 70) return 'securityScoreLevelGood'
  if (score.value >= 50) return 'securityScoreLevelFair'
  return 'securityScoreLevelWeak'
})
const scoreItems = computed(() => {
  if (scoreData.value && Array.isArray(scoreData.value.items) && scoreData.value.items.length) {
    return scoreData.value.items
  }
  return [
    {key: 'totp', max: 30, score: totpEnabled.value ? 30 : 0, ok: totpEnabled.value, suggestion: null},
    {key: 'passkey', max: 30, score: passkeys.value.length ? 30 : 0, ok: passkeys.value.length > 0, suggestion: null},
    {key: 'loginAlert', max: 20, score: security.loginAlert ? 20 : 0, ok: !!security.loginAlert, suggestion: null},
    {key: 'loginHistory', max: 20, score: noNewIp30d.value ? 20 : 0, ok: noNewIp30d.value, suggestion: null}
  ]
})

function toast(message, type) {
  ElMessage({message, type: type || 'error', plain: true})
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    toast(t('totpCopied'), 'success')
  } catch (e) {
    console.error(e)
    toast(t('copyFailMsg'))
  }
}

function openTelegramGroup() {
  window.open('https://t.me/nicofreevery', '_blank')
}

function openGithub() {
  window.open('https://github.com/kimi712/mail-ultimate', '_blank')
}

function loadSecurity() {
  return getSecurity().then((data) => {
    if (!data) {
      return
    }
    security.loginAlert = data.loginAlert ? 1 : 0
    loginAlertOn.value = !!data.loginAlert
    security.e2eeEnabled = data.e2eeEnabled ? 1 : 0
    security.retentionDays = [0, 30, 90, 365].includes(data.retentionDays) ? data.retentionDays : 0
    security.autoLockMinutes = [0, 5, 15, 30].includes(data.autoLockMinutes) ? data.autoLockMinutes : 0
    security.e2eeSalt = data.e2eeSalt || ''
    security.mlkemEnabled = data.mlkemEnabled ? 1 : 0
    if (data.totpEnabled === true) {
      totpEnabled.value = true
    }
    e2eeUnlocked.value = hasMemoryKey() && !!security.e2eeEnabled
  }).catch((e) => {
    console.error(e)
    toast(t('reqFailErrorMsg'))
  })
}

function loadDeadman() {
  deadmanLoading.value = true
  return getDeadman().then((data) => {
    if (!data) return
    deadman.enabled = data.enabled ? 1 : 0
    deadman.inactivityDays = [30, 60, 90].includes(data.inactivityDays) ? data.inactivityDays : 90
    deadman.action = data.action === 'notify' ? 'notify' : 'delete'
    deadman.contactEmail = data.contactEmail || ''
    deadman.message = data.message || ''
    deadman.status = data.status || 'off'
    deadman.warnedAt = data.warnedAt || ''
    deadman.executedAt = data.executedAt || ''
    deadman.lastActiveAt = data.lastActiveAt || ''
    deadman.inactiveDays = data.inactiveDays || 0
  }).catch((e) => {
    console.error(e)
  }).finally(() => {
    deadmanLoading.value = false
  })
}

function loadPasskeys() {
  passkeyLoading.value = true
  return passkeyList().then((data) => {
    passkeys.value = Array.isArray(data) ? data : (data?.list || [])
    passkeyLoading.value = false
  }).catch(() => {
    passkeyLoading.value = false
  })
}

function loadLoginLog() {
  loginLogLoading.value = true
  return loginHistory({num: 1, size: 20}).then((data) => {
    loginLogList.value = data.list || []
    loginLogLoaded.value = true
    loginLogLoading.value = false
  }).catch(() => {
    loginLogLoading.value = false
  })
}

function loadSessions() {
  sessionLoading.value = true
  return sessions().then((data) => {
    sessionList.value = Array.isArray(data) ? data : (data?.list || [])
    sessionLoading.value = false
  }).catch(() => {
    sessionLoading.value = false
  })
}

function loadScore() {
  scoreLoading.value = true
  return getSecurityScore().then((data) => {
    if (data && typeof data.total === 'number') {
      scoreData.value = data
    }
  }).catch(() => {
    // 接口失败时保留本地回退评分，不弹错
  }).finally(() => {
    scoreLoading.value = false
  })
}

function loadAuditLog() {
  auditLoading.value = true
  return myAuditLog({num: auditNum.value, size: auditSize, type: auditType.value}).then((data) => {
    auditLogList.value = data.list || []
    auditLoading.value = false
  }).catch(() => {
    auditLoading.value = false
  })
}

function auditPrev() {
  if (auditNum.value > 1) {
    auditNum.value -= 1
    loadAuditLog()
  }
}

function auditNext() {
  auditNum.value += 1
  loadAuditLog()
}

onMounted(() => {
  // 跨页锚点跳转（功能搜索经路由 query 传 anchor）：本页 onMounted 一次发 10 个请求，
  // 数据分波回来、布局不断变长——顶栏猜"何时稳定"两轮都失败。根治：等这 10 个请求
  // 全落定（成功失败都算，8 秒超时兜底）再滚一次，时机天然正确。滚完清掉 query。
  const jobs = [
    loadSecurity(),
    loadDeadman(),
    loadPasskeys(),
    loadLoginLog(),
    loadSessions(),
    loadScore(),
    loadAuditLog(),
    loadCanary(),
    loadDuress(),
    loadZk(),
  ]
  scrollToQueryAnchor({ route, router, routeName: 'security', jobs, getWrap: () => scrollContainer.value })
})

// 斯诺登第三批（v3_16DB）：胁迫密码状态。
function loadDuress() {
  return getDuressStatus().then((data) => {
    duressEnabled.value = !!data?.enabled
  }).catch(() => {})
}

function loadZk() {
  return getZkStatus().then((data) => {
    zkEnabled.value = !!data?.enabled
  }).catch(() => {})
}

// 金丝雀声明日期（安全中心展示；取 setting.canary_date，管理员在系统设置里改）。
const canaryDate = ref('2026-11-09')
function loadCanary() {
  return getCanary().then(data => {
    if (data?.canaryDate) {
      canaryDate.value = data.canaryDate
    }
  }).catch(() => {})
}

// ---- TOTP ----
function drawTotpQr() {
  const canvas = totpQrCanvas.value
  const qr = setupData.value && setupData.value.qr
  if (!canvas || !qr || !Array.isArray(qr.modules)) {
    return
  }
  const ctx = canvas.getContext('2d')
  const quiet = 4
  const size = qr.size + quiet * 2
  const cell = Math.max(2, Math.floor(220 / size))
  const px = cell * size
  canvas.width = px
  canvas.height = px
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, px, px)
  ctx.fillStyle = '#000000'
  qr.modules.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] === '1') {
        ctx.fillRect((x + quiet) * cell, (y + quiet) * cell, cell, cell)
      }
    }
  })
}

function startTotpSetup() {
  totpLoading.value = true
  totpSetup(rebindOldCode.value).then((data) => {
    setupData.value = data
    setupCode.value = ''
    rebindOldCode.value = ''
    totpLoading.value = false
    nextTick(drawTotpQr)
  }).catch((e) => {
    totpLoading.value = false
    toast(e?.message || t('reqFailErrorMsg'))
  })
}

function confirmTotpEnable() {
  if (!/^\d{6}$/.test(setupCode.value)) {
    toast(t('totpNeedCode'))
    return
  }
  totpLoading.value = true
  totpEnable(setupCode.value).then(() => {
    totpEnabled.value = true
    setupData.value = null
    setupCode.value = ''
    totpLoading.value = false
    loadScore()
    loadAuditLog()
    toast(t('totpEnableSuccess'), 'success')
  }).catch((e) => {
    totpLoading.value = false
    toast(e?.message || t('reqFailErrorMsg'))
  })
}

function confirmTotpDisable() {
  if (!disablePassword.value || !/^\d{6}$/.test(disableCode.value)) {
    toast(t('totpNeedPassword'))
    return
  }
  totpLoading.value = true
  totpDisable(disablePassword.value, disableCode.value).then(() => {
    totpEnabled.value = false
    showDisableTotp.value = false
    disablePassword.value = ''
    disableCode.value = ''
    totpLoading.value = false
    loadScore()
    loadAuditLog()
    toast(t('totpDisableSuccess'), 'success')
  }).catch((e) => {
    totpLoading.value = false
    toast(e?.message || t('reqFailErrorMsg'))
  })
}

// ---- Passkey ----
async function registerPasskey() {
  if (!window.PublicKeyCredential || !navigator.credentials || !navigator.credentials.create) {
    toast(t('passkeyUnsupported'))
    return
  }
  passkeyLoading.value = true
  try {
    const options = await passkeyRegisterOptions()
    const credential = await navigator.credentials.create(optionsToCreateArgs(options))
    await passkeyRegister(credentialToJson(credential))
    toast(t('passkeyRegisterSuccess'), 'success')
    await loadPasskeys()
  } catch (e) {
    console.error(e)
    if (e && e.name !== 'NotAllowedError') {
      toast(e?.message || t('reqFailErrorMsg'))
    }
  } finally {
    passkeyLoading.value = false
  }
}

function deletePasskey(row) {
  ElMessageBox.confirm(t('passkeyDeleteConfirm'), {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    type: 'warning'
  }).then(() => {
    passkeyLoading.value = true
    passkeyDelete(row.credentialId).then(() => {
      toast(t('passkeyDeleteSuccess'), 'success')
      return loadPasskeys()
    }).catch((e) => {
      passkeyLoading.value = false
      toast(e?.message || t('reqFailErrorMsg'))
    })
  }).catch(() => {
  })
}

// ---- 设备管理 ----
function revokeOne(row) {
  ElMessageBox.confirm(t('sessionRevokeConfirm'), {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    type: 'warning'
  }).then(() => {
    sessionLoading.value = true
    revokeSession(row.digest).then(() => loadSessions()).catch((e) => {
      sessionLoading.value = false
      toast(e?.message || t('reqFailErrorMsg'))
    })
  }).catch(() => {
  })
}

function revokeOthers() {
  ElMessageBox.confirm(t('sessionRevokeOthersConfirm'), {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    type: 'warning'
  }).then(() => {
    sessionLoading.value = true
    revokeOtherSessions().then(() => loadSessions()).catch((e) => {
      sessionLoading.value = false
      toast(e?.message || t('reqFailErrorMsg'))
    })
  }).catch(() => {
  })
}

// ---- 提醒开关 / 保留期限（即时保存，失败回滚） ----
function onLoginAlertChange(value) {
  saving.value = true
  const prev = security.loginAlert
  security.loginAlert = value ? 1 : 0
  setSecurity({loginAlert: value ? 1 : 0}).then(() => {
    saving.value = false
  }).catch((e) => {
    security.loginAlert = prev
    loginAlertOn.value = !!prev
    saving.value = false
    toast(e?.message || t('reqFailErrorMsg'))
  })
}

function onRetentionChange(value) {
  saving.value = true
  const prev = security.retentionDays
  setSecurity({retentionDays: value}).then(() => {
    saving.value = false
  }).catch((e) => {
    security.retentionDays = prev
    saving.value = false
    toast(e?.message || t('reqFailErrorMsg'))
  })
}

// ---- 闲置自动锁定 / 我的数据（Phase 7） ----
function onAutoLockChange(value) {
  saving.value = true
  const prev = security.autoLockMinutes
  setSecurity({autoLockMinutes: value}).then(() => {
    saving.value = false
    window.dispatchEvent(new CustomEvent('auto-lock-settings-changed', {detail: {autoLockMinutes: value}}))
  }).catch((e) => {
    security.autoLockMinutes = prev
    saving.value = false
    toast(e?.message || t('reqFailErrorMsg'))
  })
}

function exportMyData() {
  exportLoading.value = true
  exportData().then((data) => {
    const blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'})
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    a.href = url
    a.download = `mail-export-${stamp}.json`
    a.click()
    URL.revokeObjectURL(url)
    exportLoading.value = false
    toast(t('securityExportDone'), 'success')
  }).catch((e) => {
    exportLoading.value = false
    toast(e?.message || t('reqFailErrorMsg'))
  })
}

function deleteMyAccount() {
  ElMessageBox.confirm(t('securityDeleteAccountConfirm'), {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    type: 'warning'
  }).then(() => {
    deleteLoading.value = true
    userDelete().then(() => {
      localStorage.removeItem('token')
      router.replace('/login')
    }).catch((e) => {
      deleteLoading.value = false
      toast(e?.message || t('reqFailErrorMsg'))
    })
  }).catch(() => {
  })
}

// 彻底删除：密码 + 输入 DELETE 双重确认；成功后清 token 回登录页。
async function confirmHardDelete() {
  if (hardDeleteConfirmText.value !== 'DELETE') {
    toast(t('securityHardDeleteWrongText'))
    return
  }
  hardDeleteLoading.value = true
  try {
    await hardDeleteMyAccount(hardDeletePassword.value, hardDeleteConfirmText.value)
    localStorage.removeItem('token')
    hardDeleteDialogVisible.value = false
    hardDeletePassword.value = ''
    hardDeleteConfirmText.value = ''
    router.replace('/login')
  } catch (e) {
    hardDeleteLoading.value = false
    toast(e?.message || t('reqFailErrorMsg'))
  }
}

// ---- E2EE ----
async function enableE2ee() {
  if (!e2eePassword.value) {
    toast(t('e2eeNeedPassword'))
    return
  }
  e2eeLoading.value = true
  try {
    const salt = security.e2eeSalt || generateSalt()
    await setSecurity({e2eeEnabled: 1, e2eeSalt: salt})
    security.e2eeSalt = salt
    await unlockWithPassword(e2eePassword.value, salt)
    security.e2eeEnabled = 1
    e2eeUnlocked.value = true
    e2eePassword.value = ''
  } catch (e) {
    console.error(e)
    toast(e?.message || t('reqFailErrorMsg'))
  } finally {
    e2eeLoading.value = false
  }
}

async function unlockE2ee() {
  if (!e2eePassword.value || !security.e2eeSalt) {
    toast(t('e2eeNeedPassword'))
    return
  }
  e2eeLoading.value = true
  try {
    await unlockWithPassword(e2eePassword.value, security.e2eeSalt)
    e2eeUnlocked.value = true
    e2eePassword.value = ''
  } catch (e) {
    console.error(e)
    toast(t('e2eeUnlockFailed'))
  } finally {
    e2eeLoading.value = false
  }
}

function lockE2ee() {
  clearMemoryKey()
  clearMemoryMlkemPrivateKey()
  e2eeUnlocked.value = false
}

function disableE2ee() {
  e2eeLoading.value = true
  setSecurity({e2eeEnabled: 0}).then(() => {
    security.e2eeEnabled = 0
    clearMemoryKey()
    clearMemoryMlkemPrivateKey()
    e2eeUnlocked.value = false
    e2eeLoading.value = false
  }).catch((e) => {
    e2eeLoading.value = false
    toast(e?.message || t('reqFailErrorMsg'))
  })
}

// ---- 抗量子密钥（斯诺登第二批，v3_15DB） ----
// ML-KEM-768（FIPS 203）密钥对：公钥可公开（发件方用它包裹一次性密钥），
// 私钥经加密密码派生的 KEK 加密后存后端，服务端无法解密。生成须先解锁 E2EE
// （内存有 KEK）。重新生成会覆盖旧密钥对：旧抗量子包裹的信将不可读，
// 与“忘口令即丢数据”的语义一致，须先弹确认。
async function generateMlkem(regenerate) {
  if (!security.e2eeEnabled) {
    toast(t('mlkemNeedE2ee'))
    return
  }
  if (!hasMemoryKey()) {
    toast(t('mlkemNeedUnlock'))
    return
  }
  if (regenerate) {
    try {
      await ElMessageBox.confirm(t('mlkemRegenConfirm'), t('mlkemTitle'), {
        confirmButtonText: t('confirm'),
        cancelButtonText: t('cancel'),
        type: 'warning'
      })
    } catch (e) {
      return
    }
  }
  mlkemLoading.value = true
  try {
    const {publicKeyB64, privateKeyBytes} = generateMlKemKeypair()
    const privEnc = await encryptMlkemPrivateKey(privateKeyBytes, getMemoryKey())
    const data = await setMlkemKeys(publicKeyB64, privEnc)
    security.mlkemEnabled = data?.mlkemEnabled ? 1 : 0
    // 新密钥对生成后，内存里的旧私钥失效，清掉（下次读信时按需取回新的）。
    clearMemoryMlkemPrivateKey()
    toast(t('mlkemGenerated'), 'success')
  } catch (e) {
    console.error(e)
    toast(e?.message || t('reqFailErrorMsg'))
  } finally {
    mlkemLoading.value = false
  }
}

// 验证抗量子密钥：用全新抛弃式密钥对做封装/解封往返 + 篡改检测，不动已存密钥。
async function verifyMlkem() {
  mlkemVerifying.value = true
  try {
    await selfTestMlKem()
    toast(t('mlkemVerifyOk'), 'success')
  } catch (e) {
    console.error(e)
    toast(t('mlkemVerifyFail'))
  } finally {
    mlkemVerifying.value = false
  }
}

// ---- 死亡开关（斯诺登第二批，v3_15DB） ----
// 失联满期限前 7 天发提醒邮件给本人，提醒满 7 天且仍失联才执行；
// 任意一次登录都会刷新最后活跃、自动取消待执行；也可随时关闭。
async function saveDeadman() {
  deadmanSaving.value = true
  try {
    const data = await setDeadman({
      enabled: true,
      inactivityDays: deadman.inactivityDays,
      action: deadman.action,
      contactEmail: deadman.contactEmail,
      message: deadman.message
    })
    if (data) {
      deadman.enabled = data.enabled ? 1 : 0
      deadman.status = data.status || 'armed'
      deadman.warnedAt = data.warnedAt || ''
      deadman.executedAt = data.executedAt || ''
    }
    toast(t('deadmanSaved'), 'success')
  } catch (e) {
    console.error(e)
    toast(e?.message || t('reqFailErrorMsg'))
  } finally {
    deadmanSaving.value = false
  }
}

async function disableDeadmanFn() {
  deadmanSaving.value = true
  try {
    const data = await disableDeadman()
    if (data) {
      deadman.enabled = 0
      deadman.status = 'off'
      deadman.warnedAt = ''
      deadman.executedAt = ''
    }
    toast(t('deadmanDisabled'), 'success')
  } catch (e) {
    console.error(e)
    toast(e?.message || t('reqFailErrorMsg'))
  } finally {
    deadmanSaving.value = false
  }
}

// ---- 胁迫密码（斯诺登第三批，v3_16DB） ----
// 主密码进真实邮箱，胁迫密码进诱饵邮箱（只看得到播种的诱饵邮件，不暴露
// 真实数据、不触发任何告警）。设/改/关均须先验主密码。
async function saveDuress() {
  if (!duressMainPassword.value || !duressPassword.value) {
    toast(t('duressNeedBoth'))
    return
  }
  if (duressPassword.value.length < 8) {
    toast(t('duressTooShort'))
    return
  }
  duressLoading.value = true
  try {
    const fn = duressEnabled.value ? changeDuressPassword : setDuressPassword
    await fn(duressMainPassword.value, duressPassword.value)
    duressEnabled.value = true
    duressMainPassword.value = ''
    duressPassword.value = ''
    toast(t('duressSaved'), 'success')
  } catch (e) {
    console.error(e)
    toast(e?.message || t('reqFailErrorMsg'))
  } finally {
    duressLoading.value = false
  }
}

async function disableDuressFn() {
  if (!duressMainPassword.value) {
    toast(t('duressNeedMain'))
    return
  }
  duressLoading.value = true
  try {
    await disableDuressPassword(duressMainPassword.value)
    duressEnabled.value = false
    duressMainPassword.value = ''
    duressPassword.value = ''
    toast(t('duressDisabled'), 'success')
  } catch (e) {
    console.error(e)
    toast(e?.message || t('reqFailErrorMsg'))
  } finally {
    duressLoading.value = false
  }
}

// ---- 密钥分片（斯诺登第三批，v3_16DB） ----
// Shamir 5 片取 3：导出当前内存 KEK 的 5 个分片（分开保管，任 3 片可恢复）。
// 恢复：贴入任意 3 片 → 还原 KEK → 直接解锁 E2EE（忘加密密码时用）。
async function exportShamir() {
  if (!security.e2eeEnabled || !hasMemoryKey()) {
    toast(t('mlkemNeedUnlock'))
    return
  }
  shamirLoading.value = true
  try {
    const raw = await exportKekRaw()
    shamirShares.value = splitSecret(raw)
    toast(t('shamirExportOk'), 'success')
  } catch (e) {
    console.error(e)
    toast(e?.message || t('reqFailErrorMsg'))
  } finally {
    shamirLoading.value = false
  }
}

async function recoverShamir() {
  const shares = [shamirInput1.value, shamirInput2.value, shamirInput3.value]
    .map(s => String(s || '').trim()).filter(Boolean)
  if (shares.length < 3) {
    toast(t('shamirNeedThree'))
    return
  }
  if (!shares.every(isValidShare)) {
    toast(t('shamirBadShare'))
    return
  }
  shamirLoading.value = true
  try {
    const raw = recoverSecret(shares)
    await importKekRaw(raw)
    e2eeUnlocked.value = true
    shamirInput1.value = ''
    shamirInput2.value = ''
    shamirInput3.value = ''
    shamirRecoverVisible.value = false
    toast(t('shamirRecoverOk'), 'success')
  } catch (e) {
    console.error(e)
    toast(t('shamirRecoverFail'))
  } finally {
    shamirLoading.value = false
  }
}

// ---- 零知识身份（斯诺登第三批，v3_16DB） ----
// 开通：前端随机 salt + verifier = SHA-256(salt + 主密码)，只把 salt 与
// verifier 发给后端；服务端只存验证子，不存可逆凭证。登录时走挑战-应答。
async function setupZkFn() {
  if (!zkMainPassword.value) {
    toast(t('duressNeedMain'))
    return
  }
  zkLoading.value = true
  try {
    const {salt, verifier} = await buildZkSetupField(zkMainPassword.value)
    await setupZk(zkMainPassword.value, salt, verifier)
    zkEnabled.value = true
    zkMainPassword.value = ''
    toast(t('zkSetupOk'), 'success')
  } catch (e) {
    console.error(e)
    toast(e?.message || t('reqFailErrorMsg'))
  } finally {
    zkLoading.value = false
  }
}

async function disableZkFn() {
  if (!zkMainPassword.value) {
    toast(t('duressNeedMain'))
    return
  }
  zkLoading.value = true
  try {
    await disableZk(zkMainPassword.value)
    zkEnabled.value = false
    zkMainPassword.value = ''
    toast(t('zkDisabled'), 'success')
  } catch (e) {
    console.error(e)
    toast(e?.message || t('reqFailErrorMsg'))
  } finally {
    zkLoading.value = false
  }
}
</script>
<style scoped lang="scss">
.security-page {
  height: 100%;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}

.box {
    /* 整页一张卡：导航、横幅、各分区同处一个卡面，不再是散落的浮件。 */
    margin: 16px;
    padding: 28px 32px;
    background: var(--el-bg-color-overlay);
    border: 1px solid var(--el-border-color-lighter);
    border-radius: 16px;

    @media (max-width: 767px) {
      margin: 12px;
      padding: 20px;
    }

    /* 导航栏收进卡片当顶栏：与卡片同底色、左右通栏、底部分隔线，吸顶时仍是一体。 */
    :deep(.section-nav) {
      margin: -28px -32px 8px;
      padding: 12px 32px;
      background: var(--el-bg-color-overlay);
      border-radius: 16px 16px 0 0;
      border-bottom: 1px solid var(--el-border-color-lighter);

      @media (max-width: 767px) {
        margin: -20px -20px 8px;
        padding: 12px 20px;
      }
    }

  .title {
    font-size: 20px;
    font-weight: bold;
    margin-bottom: 30px;
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: 14px;
    margin-bottom: 32px;
    align-items: flex-start;
    max-width: 860px;
    /* 分区锚点滚动时不被吸顶导航遮住标题（实测 56px 会盖住标题顶 10–15px，改 76px） */
    scroll-margin-top: 76px;

    .section-title {
      font-size: 18px;
      font-weight: bold;
    }

    /* 跨页跳转根治：动态表格的预留高度容器（加载态 min-height，数据来了填进去不撑大页面）。 */
    .tbl-reserve {
      width: 100%;
    }

    /* 表格长字段单行省略（悬停 title 看全文），行高确定化、不随内容换行波动。 */
    .cell-ellipsis {
      display: block;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .desc {
      font-size: 14px;
      color: var(--regular-text-color);
      line-height: 1.6;
    }

    .row {
      display: flex;
      align-items: center;
      gap: 12px;
    }
  }

  .score-row {
    display: flex;
    align-items: center;
    gap: 20px;
    width: 100%;

    .score-num {
      font-size: 36px;
      font-weight: bold;
      white-space: nowrap;

      .score-total {
        font-size: 16px;
        color: var(--secondary-text-color);
      }
    }

    .score-bar {
      flex: 1;
    }
  }

  .score-tip {
    font-size: 13px;
    color: var(--secondary-text-color);
  }

  /* Phase 8 斯诺登元素补齐：分数解读行——加粗一句人话，贴着分数走 */
  .score-level {
    margin-top: 8px;
    font-size: 13px;
    font-weight: 600;
    color: var(--el-text-color-primary);
  }

  .score-list {
    width: 100%;
    display: grid;
    gap: 10px;

    .score-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 14px;
      padding: 8px 0;
      border-bottom: 1px solid var(--light-border-color);
    }
  }

  .totp-setup {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 14px;
    border: 1px solid var(--light-border-color);
    border-radius: 6px;
  }

  .totp-qr {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }

  .totp-qr canvas {
    background: #fff;
    border: 1px solid var(--light-border-color);
    border-radius: 6px;
  }

  .kv-row {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;

    .kv-label {
      width: 90px;
      font-size: 14px;
      font-weight: bold;
      flex-shrink: 0;
    }

    .secret-input {
      flex: 1;
      min-width: 200px;
    }

    .code-input {
      width: 260px;
      max-width: 100%;
    }
  }

  .e2ee-warn {
    width: 100%;
  }

  .canary-box {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    margin: 12px 0;
    padding: 14px;
    border: 1px solid var(--light-border-color);
    border-radius: 8px;
    background: var(--el-fill-color-light);

    .canary-icon {
      font-size: 28px;
      line-height: 1;
    }

    .canary-text {
      font-size: 15px;
      font-weight: bold;
      line-height: 1.6;
    }
  }

  /* 捐赠区金色高亮卡片（2026-11-10 移到顶部后一眼就是“支持我们”）：金边 + 淡金底，深色主题下同样醒目。 */
  .section.donate-highlight {
    border: 1.5px solid #c9a227;
    background: rgba(201, 162, 39, 0.09);
    border-radius: 10px;
    padding: 18px;
    box-shadow: 0 2px 12px rgba(201, 162, 39, 0.18);
  }

  .donate-box {
    display: flex;
    gap: 16px;
    align-items: flex-start;
    margin: 12px 0;
    padding: 14px;
    border: 1px solid var(--light-border-color);
    border-radius: 8px;
    background: var(--el-fill-color-light);
    flex-wrap: wrap;

    .donate-qr {
      width: 160px;
      height: 160px;
      flex-shrink: 0;
      border-radius: 8px;
      background: #fff;
    }

    .donate-info {
      display: flex;
      flex-direction: column;
      gap: 10px;
      min-width: 0;
      flex: 1;
      align-items: flex-start;
    }

    .donate-label {
      font-size: 15px;
      font-weight: bold;
    }

    .donate-address {
      font-family: monospace;
      font-size: 14px;
      word-break: break-all;
      line-height: 1.6;
    }
  }
}

/* 壁纸模式：卡片与内容区同款半透明 + 毛玻璃，壁纸仍 faint 可见。 */
html[data-wallpaper="1"] .layout.has-wallpaper .box {
  background: rgba(13, 18, 28, 0.62);
  backdrop-filter: blur(12px) saturate(1.1);
  -webkit-backdrop-filter: blur(12px) saturate(1.1);
}
html.dark[data-wallpaper="1"] .layout.has-wallpaper .box {
  background: rgba(10, 10, 14, 0.62);
}
@media (max-width: 767px) {
  html[data-wallpaper="1"] .layout.has-wallpaper .box {
    background: rgba(13, 18, 28, 0.72);
  }
  html.dark[data-wallpaper="1"] .layout.has-wallpaper .box {
    background: rgba(10, 10, 14, 0.72);
  }
}

</style>
