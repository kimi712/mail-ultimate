// 壁纸系统（Phase 7）：选择 / 喜好标签 / 自定义上传 / 背景应用。
// 存储：localStorage mail-wallpaper（当前壁纸值）+ mail-wallpaper-tags（喜好标签）
// + mail-wallpaper-custom（自定义上传列表）；后端 user.wallpaper / user.wallpaper_tags
//（v3_10DB）登录后同步，机制复用 user.locale 那套（见 syncWallpaperWithServer）。
// 壁纸值：预置为清单 id（如 snowden-vista），自定义为上传返回的 /oss/wallpapers/... URL，
// 空 = 默认 snowden-vista。预置图在 public/wallpapers/ 下，文件名为 id + '.jpg'。
// 本模块的纯函数（resolve/allTags/recommend/存储读写）不依赖 store，可直接单测；
// currentWallpaper 用 Vue ref 导出（供 App.vue / layout 响应式读取），
// 故裸 node import 需先去掉 vue 导入行（构建与浏览器环境不受影响）。
import { ref } from 'vue';

export const WALLPAPER_KEY = 'mail-wallpaper';
export const WALLPAPER_TAGS_KEY = 'mail-wallpaper-tags';
export const WALLPAPER_CUSTOM_KEY = 'mail-wallpaper-custom';
export const DEFAULT_WALLPAPER_ID = 'snowden-vista';
export const MAX_UPLOAD_SIZE = 2 * 1024 * 1024;
export const ALLOWED_UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// 当前生效壁纸（供 App.vue / layout 响应式读取，如 has-wallpaper class）。
export const currentWallpaper = ref({ value: '', url: '' });

function read(key) {
	try {
		return localStorage.getItem(key);
	} catch (e) {
		return null;
	}
}

function write(key, value) {
	try {
		localStorage.setItem(key, value);
	} catch (e) {
		// 隐私模式等写失败时静默，界面偏好仍已生效
	}
}

export function loadStoredWallpaper() {
	return read(WALLPAPER_KEY) || '';
}

export function saveStoredWallpaper(value) {
	write(WALLPAPER_KEY, value || '');
}

export function loadStoredTags() {
	try {
		const parsed = JSON.parse(read(WALLPAPER_TAGS_KEY) || '[]');
		return Array.isArray(parsed) ? parsed.filter((t) => typeof t === 'string') : [];
	} catch (e) {
		return [];
	}
}

export function saveStoredTags(tags) {
	write(WALLPAPER_TAGS_KEY, JSON.stringify(tags || []));
}

export function loadCustomWallpapers() {
	try {
		const parsed = JSON.parse(read(WALLPAPER_CUSTOM_KEY) || '[]');
		return Array.isArray(parsed) ? parsed.filter((w) => w && typeof w.url === 'string') : [];
	} catch (e) {
		return [];
	}
}

export function saveCustomWallpapers(list) {
	write(WALLPAPER_CUSTOM_KEY, JSON.stringify(list || []));
}

// 壁纸值解析为可访问 URL：自定义（/ 或 http 开头）直接用；预置 id 查清单取 file，
// 清单未加载时按 id + '.jpg' 约定拼（15 张预置图全部符合该约定）；空值回落默认。
export function resolveWallpaperUrl(value, list) {
	const id = value || DEFAULT_WALLPAPER_ID;
	if (id.startsWith('/') || id.startsWith('http://') || id.startsWith('https://')) {
		return id;
	}
	const found = Array.isArray(list) ? list.find((w) => w.id === id) : null;
	if (found && found.file) {
		return `/wallpapers/${found.file}`;
	}
	return `/wallpapers/${id}.jpg`;
}

// 应用背景：写 documentElement 的 data-wallpaper / --wallpaper-url / data-wallpaper-dark，
// 背景层、遮罩与深色压暗见 style.css 的 html[data-wallpaper] 规则；
// 登录页与邮箱布局共用同一层，登录页表单卡片本身保持不透明以保证文字可读。
export function applyWallpaper(value, list, isDark) {
	const url = resolveWallpaperUrl(value, list);
	try {
		const root = document.documentElement;
		root.dataset.wallpaper = '1';
		root.dataset.wallpaperDark = isDark ? '1' : '0';
		root.style.setProperty('--wallpaper-url', `url("${url}")`);
	} catch (e) {
		// 非浏览器环境忽略
	}
	currentWallpaper.value = { value: value || '', url };
	return url;
}

export function clearWallpaper() {
	try {
		const root = document.documentElement;
		delete root.dataset.wallpaper;
		delete root.dataset.wallpaperDark;
		root.style.removeProperty('--wallpaper-url');
	} catch (e) {
		// 非浏览器环境忽略
	}
	currentWallpaper.value = { value: '', url: '' };
}

// 清单里全部风格标签（去重、保序），供筛选 chips 用。
export function allTags(list) {
	const seen = new Set();
	const tags = [];
	(Array.isArray(list) ? list : []).forEach((w) => {
		(Array.isArray(w.tags) ? w.tags : []).forEach((tag) => {
			if (!seen.has(tag)) {
				seen.add(tag);
				tags.push(tag);
			}
		});
	});
	return tags;
}

// 按喜好推荐：命中喜好标签数越多越靠前（0 命中不推荐），同分保持清单原序。
export function recommendWallpapers(list, likedTags, limit = 3) {
	const liked = Array.isArray(likedTags) ? likedTags : [];
	if (!liked.length) {
		return [];
	}
	return (Array.isArray(list) ? list : [])
		.map((w, index) => ({
			item: w,
			index,
			score: (Array.isArray(w.tags) ? w.tags : []).filter((tag) => liked.includes(tag)).length
		}))
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.slice(0, limit)
		.map((entry) => entry.item);
}

// 登录后同步：后端有值 → 以后端为准回写本地；后端为空 → 把本地值写到后端。
// getWallpaper/setWallpaper 由调用方从 request/my.js 传入（本模块不 import request，避免循环依赖）。
// 全程 best-effort，失败只记日志，不阻断登录流程。
export async function syncWallpaperWithServer({ getWallpaper, setWallpaper, list, isDark }) {
	try {
		const res = await getWallpaper();
		const serverValue = res?.wallpaper || '';
		const serverTags = Array.isArray(res?.wallpaperTags) ? res.wallpaperTags : [];
		if (serverValue || serverTags.length) {
			saveStoredWallpaper(serverValue);
			saveStoredTags(serverTags);
			applyWallpaper(serverValue, list, isDark);
			return { wallpaper: serverValue, wallpaperTags: serverTags };
		}
		const localValue = loadStoredWallpaper();
		const localTags = loadStoredTags();
		if (localValue || localTags.length) {
			await setWallpaper(localValue, localTags);
		}
		applyWallpaper(localValue, list, isDark);
		return { wallpaper: localValue, wallpaperTags: localTags };
	} catch (e) {
		console.error('同步壁纸偏好失败:', e);
		return null;
	}
}
