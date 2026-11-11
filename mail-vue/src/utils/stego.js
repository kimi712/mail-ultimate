// 斯诺登第三批（v3_16DB）：隐写术（仅站内）。
// 把短文本藏进图片 RGB 最低有效位（LSB）：每像素 3 个通道各藏 1 位。
// 载体：PNG（无损，LSB 不会被改写）。格式：4 字节大端长度 + UTF-8 文本。
// 容量：(宽×高×3 - 32) / 8 字节；文本超过容量时抛错。
// 提取：读前 32 位得长度，再读对应位数还原文本。
// 诚实边界：仅站内有效——对外经 SMTP 转码/压缩（尤其 JPEG）会改写 LSB，
// 藏入内容大概率丢失；界面必须明确说明这一点。隐写不是加密，
// 文本本身是明文藏入（须保密请先用 E2EE 加密再藏）。
// 实现：纯 Canvas 2D（不依赖第三方库），在浏览器里跑。

// 文本 → 比特数组（4 字节大端长度 + UTF-8）。
function textToBits(text) {
	const bytes = new TextEncoder().encode(text);
	const len = bytes.length;
	const out = new Uint8Array(4 + len);
	out[0] = (len >>> 24) & 0xff;
	out[1] = (len >>> 16) & 0xff;
	out[2] = (len >>> 8) & 0xff;
	out[3] = len & 0xff;
	out.set(bytes, 4);
	const bits = new Uint8Array(out.length * 8);
	for (let i = 0; i < out.length; i++) {
		for (let b = 0; b < 8; b++) {
			bits[i * 8 + b] = (out[i] >> (7 - b)) & 1;
		}
	}
	return bits;
}

// 最大可藏文本字节数（按图片像素数）。
export function stegoCapacityBytes(width, height) {
	const totalBits = width * height * 3;
	if (totalBits <= 32) return 0;
	return Math.floor((totalBits - 32) / 8);
}

// 藏入：imageFile（PNG，File/Blob）+ text → 新的 PNG Blob。
// 载体须为 PNG（JPEG 有损压缩会破坏 LSB，拒绝）；文本超容量时抛错。
export async function embedText(imageFile, text) {
	if (!imageFile || imageFile.type !== 'image/png') {
		throw new Error('carrier must be PNG');
	}
	const str = String(text || '');
	if (!str) {
		throw new Error('empty text');
	}
	const bits = textToBits(str);
	const bitmap = await createImageBitmap(imageFile);
	const width = bitmap.width;
	const height = bitmap.height;
	if (bits.length > width * height * 3) {
		throw new Error('text too long for this image');
	}
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext('2d');
	ctx.drawImage(bitmap, 0, 0);
	const img = ctx.getImageData(0, 0, width, height);
	const data = img.data;
	let bitIdx = 0;
	for (let i = 0; i < data.length && bitIdx < bits.length; i += 4) {
		for (let ch = 0; ch < 3 && bitIdx < bits.length; ch++) {
			data[i + ch] = (data[i + ch] & 0xfe) | bits[bitIdx];
			bitIdx++;
		}
	}
	ctx.putImageData(img, 0, 0);
	return new Promise((resolve, reject) => {
		canvas.toBlob((blob) => {
			if (blob) resolve(blob);
			else reject(new Error('encode failed'));
		}, 'image/png');
	});
}

// 提取：imageFile（PNG）→ 藏入的文本；无藏入内容时返回 ''。
export async function extractText(imageFile) {
	if (!imageFile) return '';
	const bitmap = await createImageBitmap(imageFile);
	const width = bitmap.width;
	const height = bitmap.height;
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext('2d');
	ctx.drawImage(bitmap, 0, 0);
	const img = ctx.getImageData(0, 0, width, height);
	const data = img.data;
	const readBit = (idx) => {
		const px = Math.floor(idx / 3);
		const ch = idx % 3;
		return data[px * 4 + ch] & 1;
	};
	// 前 32 位：长度。
	let len = 0;
	for (let i = 0; i < 32; i++) {
		len = (len << 1) | readBit(i);
	}
	if (len <= 0) return '';
	const maxLen = Math.floor((width * height * 3 - 32) / 8);
	if (len > maxLen) return '';
	const bytes = new Uint8Array(len);
	for (let i = 0; i < len; i++) {
		let b = 0;
		for (let j = 0; j < 8; j++) {
			b = (b << 1) | readBit(32 + i * 8 + j);
		}
		bytes[i] = b;
	}
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch (e) {
		return '';
	}
}

// 快速判断一张图片是否可能含藏入内容（只读前 32 位长度是否合理）。
export async function hasStego(imageFile) {
	try {
		const text = await extractText(imageFile);
		return text.length > 0;
	} catch (e) {
		return false;
	}
}
