// 跨页锚点跳转（功能搜索经路由 query 传 anchor）：目标页等自己的数据全落定再滚一次。
//
// 为什么不能由顶栏猜时机（两轮失败的教训）：安全中心 onMounted 一次发 10 个请求，
// 数据分波回来、布局不断变长——顶栏在挂载后猜"offsetTop 稳定"会被数据波之间的空隙
// 骗过，滚完迟到的数据又把分区顶出视口。根治办法是把滚动权交给目标页：它知道自己
// 的请求什么时候全回来（Promise.allSettled），等全落定再滚一次，时机天然正确。
//
// 第四轮教训：Promise.allSettled 只保证请求回来了，不保证 Vue 已把表格渲染完。
// 请求 resolve 后 reactive 状态刚改、DOM 还没 flush，滚的是表格撑大之前的位置；
// 随后 Vue flush、el-table 重新布局，上面分区变长，目标被顶出视口。所以 allSettled
// 之后先 await nextTick() 等 Vue 渲染完，再对目标分区做位置稳定采样（连续 3 次
// getBoundingClientRect().top 相差 < 2px 才滚），滚完 600ms 再验一次，漂了就补滚。
// 偏移也改成实测值：之前只算导航栏 height + 8px，漏了 margin-bottom（8px），且
// 布局未稳时量的 height 可能偏大偏小，标题仍被盖一半。
//
// 用法（目标页 onMounted 里）：
//   scrollToQueryAnchor({
//     route, router, routeName: 'security',
//     jobs: [loadSecurity(), loadDeadman(), ...],   // 本页 onMounted 发的那批请求，须 return promise
//     getWrap: () => scrollContainer.value,        // 页面自己的 el-scrollbar wrap
//   })
// 滚完清掉 query 里的 anchor，刷新不再重复滚。

import { nextTick } from 'vue'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 目标滚到导航栏下方的位置：导航栏底部相对滚动容器的位置 + margin-bottom + 12px 余量。
// 导航栏是 sticky 的，实测 bottom 才是它真正盖住的区域；只算 height 会漏掉
// margin-bottom（8px），且布局未稳时量的 height 可能偏大偏小。
function calcOffset(getWrap) {
  const nav = document.querySelector('.section-nav')
  const marginBottom = nav ? parseFloat(getComputedStyle(nav).marginBottom) || 0 : 0
  const wrap = getWrap ? getWrap() : null
  if (wrap) {
    const navBottom = nav ? nav.getBoundingClientRect().bottom - wrap.getBoundingClientRect().top : 0
    return navBottom + marginBottom + 12
  }
  // 无滚动容器：相对视口算，同一偏移逻辑，不依赖 scroll-margin。
  const navBottom = nav ? nav.getBoundingClientRect().bottom : 0
  return navBottom + marginBottom + 12
}

// 目标分区在滚动内容里的位置 − 实测偏移，标题完整露在导航栏下方。
// behavior 'auto' 立即到位，不猜动画时长。
export function scrollToSection(anchor, getWrap) {
  const el = document.getElementById(anchor)
  if (!el) return false
  const offset = calcOffset(getWrap)
  const wrap = getWrap ? getWrap() : null
  if (wrap) {
    const target = wrap.scrollTop + el.getBoundingClientRect().top - wrap.getBoundingClientRect().top - offset
    wrap.scrollTo({ top: Math.max(0, target), behavior: 'auto' })
  } else {
    window.scrollTo({ top: Math.max(0, window.scrollY + el.getBoundingClientRect().top - offset), behavior: 'auto' })
  }
  return true
}

// 等目标分区位置稳定：连续 3 次 getBoundingClientRect().top 相差 < 2px，
// 间隔 200ms，最多等 3 秒。分区不存在时也继续等（v-perm 分区可能晚挂载）。
// 超时返回 false，调用方仍照常滚一次（尽力而为）。
async function waitForStablePosition(anchor, maxMs = 3000) {
  const deadline = Date.now() + maxMs
  let prev = null
  let stableCount = 0
  while (Date.now() < deadline) {
    const el = document.getElementById(anchor)
    if (el) {
      const top = el.getBoundingClientRect().top
      if (prev !== null && Math.abs(top - prev) < 2) {
        stableCount += 1
        if (stableCount >= 2) return true // 连续 3 次采样，两两相差都 < 2px
      } else {
        stableCount = 0
      }
      prev = top
    } else {
      prev = null
      stableCount = 0
    }
    await sleep(200)
  }
  return false
}

// 滚完 600ms 验一次：目标顶部相对滚动容器视口的位置应落在偏移附近（±8px）；
// 漂出（被迟到的数据顶下去 / 顶上来）就补滚一次，最多补 2 次。
async function verifyAndRescroll(anchor, getWrap, route, routeName, maxRescroll = 2) {
  for (let i = 0; i < maxRescroll; i++) {
    await sleep(600)
    // 等待期间用户已离开本页，或 query 已被同页跳转清掉 → 不补滚。
    if (route.name !== routeName || route.query.anchor !== anchor) return
    const el = document.getElementById(anchor)
    if (!el) return
    const offset = calcOffset(getWrap)
    const wrap = getWrap ? getWrap() : null
    const top = wrap
      ? el.getBoundingClientRect().top - wrap.getBoundingClientRect().top
      : el.getBoundingClientRect().top
    if (Math.abs(top - offset) <= 8) return
    scrollToSection(anchor, getWrap)
  }
  // 最后一次补滚后不再验，免得无限循环。
}

export async function scrollToQueryAnchor({ route, router, routeName, jobs, getWrap, timeoutMs = 8000 }) {
  const anchor = route.query.anchor
  if (!anchor || typeof anchor !== 'string') return
  if (route.name !== routeName) return
  // 全部请求落定（成功失败都算），8 秒总超时兜底，防止某个请求挂住一直不滚。
  await Promise.race([
    Promise.allSettled(jobs || []),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ])
  // 等待期间用户已离开本页，或 query 已被同页跳转清掉 → 不滚。
  if (route.name !== routeName || route.query.anchor !== anchor) return
  // 请求回来 ≠ DOM 渲染完：先等 Vue 把表格渲染完（nextTick），再等目标分区位置稳定。
  await nextTick()
  if (route.name !== routeName || route.query.anchor !== anchor) return
  await waitForStablePosition(anchor)
  if (route.name !== routeName || route.query.anchor !== anchor) return
  scrollToSection(anchor, getWrap)
  // 滚完 600ms 验一次，漂了补滚（最多 2 次），再清 anchor。
  await verifyAndRescroll(anchor, getWrap, route, routeName)
  if (route.name !== routeName || route.query.anchor !== anchor) return
  // 滚完清掉 query，刷新不再重复滚。
  const nextQuery = { ...route.query }
  delete nextQuery.anchor
  router.replace({ query: nextQuery })
}
