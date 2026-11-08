import {useUserStore} from "@/store/user.js";

export default {
    mounted(el, binding) {
        const userStore = useUserStore();
        const permKeys = userStore.user.permKeys;
        const value = binding.value;

        if (permKeys.includes('*')) {
            return;
        }

        const hasPermission = Array.isArray(value)
            ? value.some(key => permKeys.includes(key))
            : permKeys.includes(value);

        if (!hasPermission) {
            el.parentNode && el.parentNode.removeChild(el);
        }
    }
}

export function hasPerm(permKey) {
    const {permKeys} = useUserStore().user;
    return permKeys.includes('*') || permKeys.includes(permKey);
}


export function permsToRouter(permKeys) {
    const routerList = []
    Object.keys(routers).forEach(perm => {
        if (permKeys.includes(perm) || permKeys.includes('*')) {
            routerList.push(...routers[perm])
        }
    })
    return routerList;
}

const routers = {
    'email:send': [
        {
            path: '/sent',
            name: 'send',
            component: () => import('@/views/send/index.vue'),
            meta: {
                title: 'sent',
                name: 'send',
                menu: true
            }
        },
        {
            path: '/drafts',
            name: 'draft',
            component: () => import('@/views/draft/index.vue'),
            meta: {
                title: 'drafts',
                name: 'draft',
                menu: true
            }
        }
    ],
    'user:query': [{
        path: '/all-users',
        name: 'user',
        component: () => import('@/views/user/index.vue'),
        meta: {
            title: 'allUsers',
            name: 'user',
            menu: true
        }
    }],
    'role:query': [{
        path: '/role',
        name: 'role',
        component: () => import('@/views/role/index.vue'),
        meta: {
            title: 'permissions',
            name: 'role',
            menu: true
        }
    }],
    'setting:query': [{
        path: '/system-settings',
        name: 'sys-setting',
        component: () => import('@/views/sys-setting/index.vue'),
        meta: {
            title: 'SystemSettings',
            name: 'sys-setting',
            menu: true
        }
    }],
    'reg-key:query': [{
        path: '/invite-code',
        name: 'reg-key',
        component: () => import('@/views/reg-key/index.vue'),
        meta: {
            title: 'inviteCode',
            name: 'reg-key',
            menu: true
        }
    }],
    'all-email:query': [{
        path: '/all-mail',
        name: 'all-email',
        component: () => import('@/views/all-email/index.vue'),
        meta: {
            title: 'allMail',
            name: 'all-email',
            menu: true
        }
    }],
    'analysis:query': [{
        path: '/dashboard',
        name: 'analysis',
        component: () => import('@/views/analysis/index.vue'),
        meta: {
            title: 'analytics',
            name: 'analysis',
            menu: true
        }
    }],
    // Phase 2 C 路：风控后台路由（title 先写英文 key 占位，i18n 由总协调集成时补，见契约 §5）
    'ip-block:query': [{
        path: '/ip-blocklist',
        name: 'ip-blocklist',
        component: () => import('@/views/ip-blocklist/index.vue'),
        meta: {
            title: 'ipBlocklist',
            name: 'ip-blocklist',
            menu: true
        }
    }],
    'alert:query': [{
        path: '/alert-center',
        name: 'alert-center',
        component: () => import('@/views/alert-center/index.vue'),
        meta: {
            title: 'alertCenter',
            name: 'alert-center',
            menu: true
        }
    }],
    'register-log:query': [{
        path: '/register-log',
        name: 'register-log',
        component: () => import('@/views/register-log/index.vue'),
        meta: {
            title: 'registerLog',
            name: 'register-log',
            menu: true
        }
    }],
    'audit-log:query': [{
        path: '/audit-log',
        name: 'audit-log',
        component: () => import('@/views/audit-log/index.vue'),
        meta: {
            title: 'auditLog',
            name: 'audit-log',
            menu: true
        }
    }],
    // 第六阶段 C 路：安全中心（用户页，任意登录用户可见）。
    // 挂在 'my:delete' 下：默认普通用户角色持有该 perm（init.js role_perm 种子 106，
    // 父级为“个人设置”perm 4），管理员为 '*'；后端 /my/* 接口本身只鉴权不鉴 perm，
    // 与 /my/loginLog、/my/locale（第二阶段 A 路）一致。若后续 B 路/总协调新增专用 perm，
    // 只需改此处 key 一处。
    'my:delete': [{
        path: '/security',
        name: 'security',
        component: () => import('@/views/security/index.vue'),
        meta: {
            title: 'securityCenter',
            name: 'security',
            menu: true
        }
    }]
}
