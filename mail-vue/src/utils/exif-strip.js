// 斯诺登第四批 P0-1：附件 EXIF 元数据剥离（前端浏览器版）。
// 与 mail-worker/src/utils/exif-strip.js 同源算法（纯函数，零依赖，
// 可直接在浏览器跑）：JPEG 删 APP1 Exif 段、PNG 删 tEXt/zTXt/iTXt/eXIf
// 块、WebP 删 EXIF 块，其余字节原样保留，不重编码图片。
// 写信页接线（layout/write/index.vue 审计员文件中，本批不碰，补丁见报告）：
//   在附件入队处调 stripExifFromFile(file) 再 push 到 form.attachments，
//   并用 components/exif-strip-notice 展示“已剥离位置与设备信息”。

const JPEG_STANDALONE = new Set([0xd8, 0xd9, 0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7]);

function toBytes(input) {
	if (input instanceof Uint8Array) return input;
	if (input instanceof ArrayBuffer) return new Uint8Array(input);
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
	out.push(bytes[0], bytes[1]);
	let pos = 2;
	while (pos + 4 <= bytes.length) {
		if (bytes[pos] !== 0xff) break;
		const marker = bytes[pos + 1];
		if (JPEG_STANDALONE.has(marker)) {
			out.push(bytes[pos], bytes[pos + 1]);
			pos += 2;
			continue;
		}
		if (marker === 0xda) break;
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
	for (let i = 0; i < 8; i++) out.push(bytes[i]);
	let pos = 8;
	while (pos + 12 <= bytes.length) {
		const len = ((bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]) >>> 0;
		const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
		const total = 12 + len;
		if (pos + total > bytes.length) break;
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

// 主入口：输入 ArrayBuffer/Uint8Array，返回 { data, format, stripped, removed }。
// 解析失败时原样返回，绝不损坏附件。
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
		return { data: bytes, format, stripped: false, removed: [] };
	}
	return { data: bytes, format, stripped: false, removed: [] };
}

// 写信页直接用：输入 File/Blob，返回剥离后的新 File（原 File 不动）。
// 非图片或无 EXIF 时返回原 File 与 stripped=false。
export async function stripExifFromFile(file) {
	try {
		if (!file || typeof file.arrayBuffer !== 'function') return { file, stripped: false, removed: [] };
		if (!/^image\/(jpeg|png|webp)$/.test(file.type || '')) return { file, stripped: false, removed: [] };
		const buf = await file.arrayBuffer();
		const result = stripExifMetadata(buf);
		if (!result.stripped) return { file, stripped: false, removed: [] };
		const clean = new File([result.data], file.name, { type: file.type, lastModified: file.lastModified });
		return { file: clean, stripped: true, removed: result.removed, format: result.format };
	} catch (e) {
		// 剥离失败：返回原文件，宁可不剥离也不损坏附件。
		return { file, stripped: false, removed: [] };
	}
}

export default { stripExifMetadata, stripExifFromFile, hasExifMetadata, detectImageFormat };
