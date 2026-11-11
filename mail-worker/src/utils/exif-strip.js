// 斯诺登第四批 P0-1：附件 EXIF 元数据剥离（纯函数，零依赖，同构实现）。
// 前端写信页在上传附件前调 stripExifMetadata()：JPEG 删 APP1 Exif 段、
// PNG 删 tEXt/zTXt/iTXt/eXIf 块、WebP 删 EXIF 块；其余字节原样保留，
// 绝不重编码图片（不改画质、不改尺寸）。剥掉的是 GPS 定位、相机型号、
// 拍摄时间、软件名等元数据；图片本身像素数据不动。
// 本文件是服务端版（供服务端二次校验 + vitest 测试）；前端版在
// mail-vue/src/utils/exif-strip.js，算法同源、测试用同一批 fixture。
// 非图片 / 无法识别的输入：原样返回，stripped=false，永不抛错。

const JPEG_SOI = [0xff, 0xd8];
// 有长度字段的 JPEG 段 marker（不含 SOI/EOI/RSTn/TEM 这些独立 marker）。
const JPEG_STANDALONE = new Set([0xd8, 0xd9, 0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7]);

function toBytes(input) {
	if (input instanceof Uint8Array) return input;
	if (input instanceof ArrayBuffer) return new Uint8Array(input);
	if (input && typeof input === 'object' && typeof input.byteLength === 'number') {
		try { return new Uint8Array(input); } catch (e) { return null; }
	}
	return null;
}

function detectFormat(bytes) {
	if (!bytes || bytes.length < 12) return '';
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
	if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
	if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
		&& bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'webp';
	return '';
}

function stripJpeg(bytes) {
	const removed = [];
	const out = [];
	let pos = 0;
	// SOI 原样保留。
	out.push(bytes[0], bytes[1]);
	pos = 2;
	while (pos + 4 <= bytes.length) {
		if (bytes[pos] !== 0xff) break; // 非法结构：剩余部分原样保留，不破坏文件。
		const marker = bytes[pos + 1];
		if (JPEG_STANDALONE.has(marker)) {
			out.push(bytes[pos], bytes[pos + 1]);
			pos += 2;
			continue;
		}
		if (marker === 0xda) break; // SOS：扫描数据开始，之后无元数据段，剩余原样保留。
		const segLen = (bytes[pos + 2] << 8) | bytes[pos + 3];
		if (segLen < 2 || pos + 2 + segLen > bytes.length) break;
		const segData = bytes.subarray(pos + 4, pos + 2 + segLen);
		const isExifApp1 = marker === 0xe1
			&& segData.length >= 6
			&& segData[0] === 0x45 && segData[1] === 0x78 && segData[2] === 0x69 && segData[3] === 0x66
			&& segData[4] === 0x00 && segData[5] === 0x00;
		if (isExifApp1) {
			removed.push('jpeg:APP1/Exif');
		} else {
			for (let i = pos; i < pos + 2 + segLen; i++) out.push(bytes[i]);
		}
		pos += 2 + segLen;
	}
	for (let i = pos; i < bytes.length; i++) out.push(bytes[i]);
	return { data: Uint8Array.from(out), removed };
}

const PNG_TEXT_CHUNKS = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf']);

function stripPng(bytes) {
	const removed = [];
	const out = [];
	for (let i = 0; i < 8; i++) out.push(bytes[i]); // PNG 签名
	let pos = 8;
	while (pos + 12 <= bytes.length) {
		const len = ((bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]) >>> 0;
		const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
		const total = 12 + len;
		if (pos + total > bytes.length) break; // 截断文件：剩余原样保留
		if (PNG_TEXT_CHUNKS.has(type)) {
			removed.push(`png:${type}`);
		} else {
			for (let i = pos; i < pos + total; i++) out.push(bytes[i]);
		}
		pos += total;
		if (type === 'IEND') break;
	}
	for (let i = pos; i < bytes.length; i++) out.push(bytes[i]);
	return { data: Uint8Array.from(out), removed };
}

function stripWebp(bytes) {
	const removed = [];
	const chunks = [];
	let pos = 12;
	while (pos + 8 <= bytes.length) {
		const tag = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
		const size = (bytes[pos + 4] | (bytes[pos + 5] << 8) | (bytes[pos + 6] << 16) | (bytes[pos + 7] << 24)) >>> 0;
		const total = 8 + size + (size % 2);
		if (pos + total > bytes.length) break;
		if (tag === 'EXIF') {
			removed.push('webp:EXIF');
		} else {
			chunks.push(bytes.subarray(pos, pos + total));
		}
		pos += total;
	}
	if (!removed.length) return { data: bytes, removed };
	const bodyLen = chunks.reduce((n, c) => n + c.length, 0);
	const out = new Uint8Array(12 + bodyLen);
	out.set(bytes.subarray(0, 12), 0);
	out[4] = (bodyLen + 4) & 0xff;
	out[5] = ((bodyLen + 4) >> 8) & 0xff;
	out[6] = ((bodyLen + 4) >> 16) & 0xff;
	out[7] = ((bodyLen + 4) >> 24) & 0xff;
	let off = 12;
	for (const c of chunks) { out.set(c, off); off += c.length; }
	return { data: out, removed };
}

export function detectImageFormat(input) {
	return detectFormat(toBytes(input));
}

export function hasExifMetadata(input) {
	try {
		const bytes = toBytes(input);
		if (!bytes) return false;
		return stripExifMetadata(bytes).removed.length > 0;
	} catch (e) {
		return false;
	}
}

export function stripExifMetadata(input) {
	const bytes = toBytes(input);
	if (!bytes) return { data: input, format: '', stripped: false, removed: [] };
	const format = detectFormat(bytes);
	try {
		if (format === 'jpeg') {
			const r = stripJpeg(bytes);
			return { data: r.data, format, stripped: r.removed.length > 0, removed: r.removed };
		}
		if (format === 'png') {
			const r = stripPng(bytes);
			return { data: r.data, format, stripped: r.removed.length > 0, removed: r.removed };
		}
		if (format === 'webp') {
			const r = stripWebp(bytes);
			return { data: r.data, format, stripped: r.removed.length > 0, removed: r.removed };
		}
	} catch (e) {
		// 解析失败：原样返回，绝不损坏附件。
		return { data: bytes, format, stripped: false, removed: [] };
	}
	return { data: bytes, format, stripped: false, removed: [] };
}

export default { stripExifMetadata, hasExifMetadata, detectImageFormat };
