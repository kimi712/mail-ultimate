import {createApp} from 'vue';
// 动态 chunk 加载失败自动刷新一次（部署后旧 index.html 引用的 chunk 已不存在，
// 浏览器会报 Failed to fetch dynamically imported module；此时刷新拿新版即可）。
// 用 sessionStorage 记一次，避免死循环。
const CHUNK_RELOAD_KEY = 'mail_chunk_reload_once';
function isChunkLoadError(msg) {
  if (!msg) return false;
  return /Failed to fetch dynamically imported module|Loading chunk [\w-]+ failed|ChunkLoadError|Importing a module script failed/i.test(msg);
}
function reloadOnceForChunk() {
  try {
    if (sessionStorage.getItem(CHUNK_RELOAD_KEY) === '1') return;
    sessionStorage.setItem(CHUNK_RELOAD_KEY, '1');
  } catch (_) { /* ignore */ }
  window.location.reload();
}
window.addEventListener('error', (e) => {
  if (isChunkLoadError(e && e.message)) reloadOnceForChunk();
}, true);
window.addEventListener('unhandledrejection', (e) => {
  const msg = (e && e.reason && (e.reason.message || String(e.reason))) || '';
  if (isChunkLoadError(msg)) reloadOnceForChunk();
});
import App from './App.vue';
import router from './router';
import './style.css';
import { init } from '@/init/init.js';
import { createPinia } from 'pinia';
import piniaPersistedState from 'pinia-plugin-persistedstate';
import 'element-plus/theme-chalk/dark/css-vars.css';
import 'nprogress/nprogress.css';
import perm from "@/perm/perm.js";
const pinia = createPinia().use(piniaPersistedState)
import i18n from "@/i18n/index.js";
const app = createApp(App).use(pinia)
await init()
app.use(router).use(i18n).directive('perm',perm)
app.config.devtools = true;

app.mount('#app');
