import {createRouter, createWebHistory} from 'vue-router'
import NProgress from 'nprogress';
import {useUiStore} from "@/store/ui.js";
import {useSettingStore} from "@/store/setting.js";
import {cvtR2Url} from "@/utils/convert.js";

const routes = [
    {
        path: '/',
        name: 'layout',
        redirect: '/inbox',
        component: () => import('@/layout/index.vue'),
        children: [
            {
                path: '/inbox',
                name: 'email',
                component: () => import('@/views/email/index.vue'),
                meta: {
                    title: 'inbox',
                    name: 'email',
                    menu: true
                }
            },
            {
                path: '/:mailbox(inbox|starred|sent|all-mail)/messages',
                name: 'content',
                component: () => import('@/views/content/index.vue'),
                meta: {
                    title: 'message',
                    name: 'content',
                    menu: false
                }
            },
            {
                path: '/settings',
                name: 'setting',
                component: () => import('@/views/setting/index.vue'),
                meta: {
                    title: 'settings',
                    name: 'setting',
                    menu: true
                }
            },
            {
                path: '/starred',
                name: 'star',
                component: () => import('@/views/star/index.vue'),
                meta: {
                    title: 'starred',
                    name: 'star',
                    menu: true
                }
            },
            // Phase 8 F：隐私仪表盘 / 联系人 / 邮件规则（侧栏菜单入口）。
            {
                path: '/privacy',
                name: 'privacy',
                component: () => import('@/views/privacy/index.vue'),
                meta: {
                    title: 'privacyDashboard',
                    name: 'privacy',
                    menu: true
                }
            },
            {
                path: '/contacts',
                name: 'contacts',
                component: () => import('@/views/contacts/index.vue'),
                meta: {
                    title: 'contactsTitle',
                    name: 'contacts',
                    menu: true
                }
            },
            {
                path: '/mail-rules',
                name: 'mail-rules',
                component: () => import('@/views/rules/index.vue'),
                meta: {
                    title: 'mailRulesTitle',
                    name: 'mail-rules',
                    menu: true
                }
            },
            // Phase 8 E：垃圾邮件文件夹（复用收件箱列表，spam=1 过滤）。
            {
                path: '/spam',
                name: 'spam',
                component: () => import('@/views/spam/index.vue'),
                meta: {
                    title: 'spam',
                    name: 'spam',
                    menu: true
                }
            },
            // 回收站（复用收件箱列表，trash=1 只列已删邮件；删除=彻底删除，可恢复）。
            {
                path: '/trash',
                name: 'trash',
                component: () => import('@/views/trash/index.vue'),
                meta: {
                    title: 'trash',
                    name: 'trash',
                    menu: true
                }
            },
        ]

    },
    {
        path: '/messages',
        redirect: '/inbox/messages'
    },
    {
        path: '/login',
        name: 'login',
        component: () => import('@/views/login/index.vue')
    },
    // Phase 8 F：找回账号（公开页，不走 layout；忘记密码入口跳这里）。
    {
        path: '/recovery',
        name: 'recovery',
        component: () => import('@/views/recovery/index.vue')
    },
    // $1000 安全悬赏挑战：公开状态页（无需登录，不走 layout）。
    {
        path: '/challenge',
        name: 'challenge',
        component: () => import('@/views/challenge/index.vue')
    },
    {
        path: '/test',
        name: 'test',
        component: () => import('@/views/test/index.vue')
    },
    {
        path: '/:pathMatch(.*)*',
        name: '404',
        component: () => import('@/views/404/index.vue')
    }
]


const router = createRouter({
    history: createWebHistory(import.meta.env.BASE_URL),
    routes
})

NProgress.configure({
    showSpinner: false,   // 不显示旋转图标
    trickleSpeed: 50,    // 自动递增速度
    minimum: 0.1          // 最小百分比
});

let timer
let first = true

router.beforeEach((to, from, next) => {

    if (timer) {
        clearTimeout(timer)
    }

    if (!first) {
        timer = setTimeout(() => {
            NProgress.start()
        }, 100)
    }

    const token = localStorage.getItem('token')

    // Phase 8 F：/recovery（找回账号）与 /login 一样是公开页，无 token 也可进。
    // $1000 安全悬赏挑战：/challenge 也是公开页。
    const isPublic = to.path.startsWith('/login') || to.path.startsWith('/recovery') || to.path.startsWith('/challenge')
    if (!token && !isPublic) {
        return next({name: 'login'})
    }

    if (!token && to.path.startsWith('/login')) {
        loadBackground(next)
        return
    }

    if (token && to.path.startsWith('/login')) {
        return next(from.path)
    }

    next()

})

function loadBackground(next) {

    const settingStore = useSettingStore();

    if (settingStore.settings.background) {

        const src = cvtR2Url(settingStore.settings.background);

        const img = new Image();
        img.src = src;

        img.onload = () => {
            next()
        };

        img.onerror = () => {
            console.warn("背景图片加载失败:", img.src);
            next()
        };

        setTimeout(() => {
            console.warn("背景加载超时，已放行");
            next()
        }, 3000)

    } else {
        next()
    }

}

router.afterEach((to) => {

    clearTimeout(timer)
    if (first) {
        removeLoading()
    } else {
        NProgress.done();
    }

    const uiStore = useUiStore()
    if (to.meta.menu) {
        if (['content', 'email', 'send'].includes(to.meta.name)) {
            uiStore.accountShow = window.innerWidth > 767;
        } else {
            uiStore.accountShow = false
        }
    }

    if (window.innerWidth < 1025) {
        uiStore.asideShow = false
    }

    first = false
})

function removeLoading() {
    const doc = document.getElementById('loading-first');
    if (!doc) {
        return;
    }

    doc.remove()
}

export default router
