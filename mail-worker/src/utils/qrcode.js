// Phase 8 B · vendored QR 编码器（零新增依赖，无第三方代码）。
// 按 ISO/IEC 18004 公开规范手写：byte 模式、纠错等级 M、版本 1–10 自动选最小版、
// 8 种掩码按罚分规则择优。输入为 UTF-8 字符串，输出 { version, size, modules }，
// modules 为按行拼成的 '0'/'1' 字符串数组（不含 quiet zone，渲染时外留 4 模块静区）。
// 用途：TOTP 设置页的 otpauth URL 二维码——密钥只在本地编码，绝不发给任何外部二维码服务。
// 校验：与 npm `qrcode`（qrcode-generator 系）逐模块比对过（见 PHASE8-B.md §QR 校验）；
// vitest 内另有结构断言（尺寸、定位图案、确定性）与 golden 矩阵回归。
const ECC_CODEWORDS_PER_BLOCK_M = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const NUM_EC_BLOCKS_M = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const TOTAL_CODEWORDS = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
const ALIGNMENT_POSITIONS = [
	[],
	[],
	[6, 18],
	[6, 22],
	[6, 26],
	[6, 30],
	[6, 34],
	[6, 22, 38],
	[6, 24, 42],
	[6, 26, 46],
	[6, 28, 50]
];
const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

// ---- GF(256)，生成多项式 x^8 + x^4 + x^3 + x^2 + 1 (0x11D) ----
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
	let x = 1;
	for (let i = 0; i < 255; i++) {
		EXP[i] = x;
		LOG[x] = i;
		x <<= 1;
		if (x & 0x100) {
			x ^= 0x11D;
		}
	}
	for (let i = 255; i < 512; i++) {
		EXP[i] = EXP[i - 255];
	}
}

function gfMul(a, b) {
	if (a === 0 || b === 0) {
		return 0;
	}
	return EXP[LOG[a] + LOG[b]];
}

// Reed-Solomon 生成多项式 g(x) = ∏(x + α^i)：降幂系数数组，首项为 1。
function reedSolomonDivisor(degree) {
	let result = [1];
	for (let i = 0; i < degree; i++) {
		const next = new Array(result.length + 1).fill(0);
		for (let j = 0; j < result.length; j++) {
			next[j] ^= result[j];
			next[j + 1] ^= gfMul(result[j], EXP[i]);
		}
		result = next;
	}
	return result;
}

// 余式：data(x)·x^degree mod g(x)，降幂长除法；返回 degree 个纠错码字（降幂顺序）。
function reedSolomonRemainder(data, divisor) {
	const rem = [...data, ...new Array(divisor.length - 1).fill(0)];
	for (let i = 0; i <= rem.length - divisor.length; i++) {
		const coef = rem[i];
		if (coef !== 0) {
			for (let j = 1; j < divisor.length; j++) {
				rem[i + j] ^= gfMul(divisor[j], coef);
			}
		}
	}
	return rem.slice(rem.length - (divisor.length - 1));
}

function getBit(value, i) {
	return ((value >>> i) & 1) !== 0;
}

// 格式信息 15 位：5 位数据（纠错等级 M=00 + 掩码 3 位）经 BCH(15,5) + 掩码 0x5412。
function formatBits(eclBits, mask) {
	let data = (eclBits << 3) | mask;
	let rem = data;
	for (let i = 0; i < 10; i++) {
		rem = (rem << 1) ^ ((rem >> 9) * 0x537);
	}
	return ((data << 10) | rem) ^ 0x5412;
}

// 版本信息 18 位（仅版本 ≥ 7）：BCH(18,6)。
function versionBits(version) {
	let rem = version;
	for (let i = 0; i < 12; i++) {
		rem = (rem << 1) ^ ((rem >> 11) * 0x1F25);
	}
	return (version << 12) | rem;
}

function maskCondition(mask, r, c) {
	switch (mask) {
		case 0: return (r + c) % 2 === 0;
		case 1: return r % 2 === 0;
		case 2: return c % 3 === 0;
		case 3: return (r + c) % 3 === 0;
		case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
		case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
		case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
		case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
		default: throw new Error('invalid mask');
	}
}

// 掩码罚分（N1 连续同色、N2 2×2 同色块、N3 类定位图案、N4 深浅比例）。
function penaltyScore(modules, size) {
	let result = 0;
	// N1：行与列的连续同色段，长度 ≥ 5 时 3 + (len - 5)。
	for (let y = 0; y < size; y++) {
		let runColor = -1;
		let runLen = 0;
		for (let x = 0; x < size; x++) {
			const color = modules[y][x] ? 1 : 0;
			if (color === runColor) {
				runLen++;
			} else {
				if (runLen >= 5) {
					result += PENALTY_N1 + (runLen - 5);
				}
				runColor = color;
				runLen = 1;
			}
		}
		if (runLen >= 5) {
			result += PENALTY_N1 + (runLen - 5);
		}
	}
	for (let x = 0; x < size; x++) {
		let runColor = -1;
		let runLen = 0;
		for (let y = 0; y < size; y++) {
			const color = modules[y][x] ? 1 : 0;
			if (color === runColor) {
				runLen++;
			} else {
				if (runLen >= 5) {
					result += PENALTY_N1 + (runLen - 5);
				}
				runColor = color;
				runLen = 1;
			}
		}
		if (runLen >= 5) {
			result += PENALTY_N1 + (runLen - 5);
		}
	}
	// N2：2×2 同色块。
	for (let y = 0; y < size - 1; y++) {
		for (let x = 0; x < size - 1; x++) {
			const c = modules[y][x];
			if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) {
				result += PENALTY_N2;
			}
		}
	}
	// N3：形如 1011101 且一侧有 4 个浅色模块的 11 位图案（行与列）。
	const finderLike = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
	const finderLikeRev = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
	function matchAt(get, start) {
		let ok1 = true;
		let ok2 = true;
		for (let i = 0; i < 11; i++) {
			if (get(start + i) !== finderLike[i]) {
				ok1 = false;
			}
			if (get(start + i) !== finderLikeRev[i]) {
				ok2 = false;
			}
		}
		return ok1 || ok2;
	}
	for (let y = 0; y < size; y++) {
		for (let x = 0; x <= size - 11; x++) {
			if (matchAt(i => (modules[y][x + i] ? 1 : 0), 0)) {
				result += PENALTY_N3;
			}
		}
	}
	for (let x = 0; x < size; x++) {
		for (let y = 0; y <= size - 11; y++) {
			if (matchAt(i => (modules[y + i][x] ? 1 : 0), 0)) {
				result += PENALTY_N3;
			}
		}
	}
	// N4：深色模块比例偏离 50% 的程度。
	let dark = 0;
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			if (modules[y][x]) {
				dark++;
			}
		}
	}
	const total = size * size;
	const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
	result += k * PENALTY_N4;
	return result;
}

// byte 模式编码：返回 { version, size, modules }；超长（版本 10 也装不下）抛错。
export function encodeQr(text) {
	const data = new TextEncoder().encode(String(text ?? ''));
	let version = -1;
	for (let v = 1; v <= 10; v++) {
		// 数据容量 = 数据码字数（总码字 − 纠错码字），不是总码字数。
		const dataCodewords = TOTAL_CODEWORDS[v]
			- ECC_CODEWORDS_PER_BLOCK_M[v] * NUM_EC_BLOCKS_M[v];
		const ccBits = v <= 9 ? 8 : 16;
		if (4 + ccBits + data.length * 8 + 4 <= dataCodewords * 8) {
			version = v;
			break;
		}
	}
	if (version === -1) {
		throw new Error('qr data too long (max version 10, EC level M)');
	}
	const size = version * 4 + 17;
	const ccBits = version <= 9 ? 8 : 16;
	const dataLen = TOTAL_CODEWORDS[version]
		- ECC_CODEWORDS_PER_BLOCK_M[version] * NUM_EC_BLOCKS_M[version];

	// ---- 数据码字：模式 0100 + 字符数 + 数据 + 终止符 + 补 0 + 0xEC/0x11 填充 ----
	const bits = [];
	const pushBits = (value, len) => {
		for (let i = len - 1; i >= 0; i--) {
			bits.push((value >>> i) & 1);
		}
	};
	pushBits(0b0100, 4);
	pushBits(data.length, ccBits);
	for (const b of data) {
		pushBits(b, 8);
	}
	const dataCapacity = TOTAL_CODEWORDS[version] * 8;
	const terminator = Math.min(4, dataCapacity - bits.length);
	for (let i = 0; i < terminator; i++) {
		bits.push(0);
	}
	while (bits.length % 8 !== 0) {
		bits.push(0);
	}
	const dataCodewords = [];
	for (let i = 0; i < bits.length; i += 8) {
		let byte = 0;
		for (let j = 0; j < 8; j++) {
			byte = (byte << 1) | bits[i + j];
		}
		dataCodewords.push(byte);
	}
	for (let pad = 0xEC; dataCodewords.length < dataLen; pad ^= 0xEC ^ 0x11) {
		dataCodewords.push(pad);
	}

	// ---- 纠错码字 + 块交错 ----
	// 分块：短块在前、长块在后（规范分组顺序；长块在前会导致多块版本的码流错位）。
	const eccLen = ECC_CODEWORDS_PER_BLOCK_M[version];
	const numBlocks = NUM_EC_BLOCKS_M[version];
	const divisor = reedSolomonDivisor(eccLen);
	const blocks = [];
	const shortBlockLen = Math.floor(dataLen / numBlocks);
	const numLongBlocks = dataLen % numBlocks;
	const numShortBlocks = numBlocks - numLongBlocks;
	const maxDataLen = shortBlockLen + (numLongBlocks > 0 ? 1 : 0);
	let offset = 0;
	for (let i = 0; i < numBlocks; i++) {
		const len = shortBlockLen + (i >= numShortBlocks ? 1 : 0);
		const blockData = dataCodewords.slice(offset, offset + len);
		offset += len;
		blocks.push({ data: blockData, ecc: reedSolomonRemainder(blockData, divisor) });
	}
	const allCodewords = [];
	for (let i = 0; i < maxDataLen; i++) {
		for (const b of blocks) {
			if (i < b.data.length) {
				allCodewords.push(b.data[i]);
			}
		}
	}
	for (let i = 0; i < eccLen; i++) {
		for (const b of blocks) {
			allCodewords.push(b.ecc[i]);
		}
	}
	const finalBits = [];
	for (const byte of allCodewords) {
		for (let i = 7; i >= 0; i--) {
			finalBits.push((byte >>> i) & 1);
		}
	}

	// ---- 功能模块 ----
	const modules = Array.from({ length: size }, () => new Array(size).fill(false));
	const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));
	const setFunction = (x, y, value) => {
		modules[y][x] = value;
		isFunction[y][x] = true;
	};
	// 时序图案（先画，定位图案后画会覆盖交叉处）。
	for (let i = 0; i < size; i++) {
		setFunction(6, i, i % 2 === 0);
		setFunction(i, 6, i % 2 === 0);
	}
	// 三个定位图案（含 1 模块分隔区）。
	for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
		for (let dy = -4; dy <= 4; dy++) {
			for (let dx = -4; dx <= 4; dx++) {
				const dist = Math.max(Math.abs(dx), Math.abs(dy));
				const xx = cx + dx;
				const yy = cy + dy;
				if (xx >= 0 && xx < size && yy >= 0 && yy < size) {
					setFunction(xx, yy, dist !== 2 && dist !== 4);
				}
			}
		}
	}
	// 校正图案（跳过与定位图案重叠的）。
	const aligns = ALIGNMENT_POSITIONS[version];
	const finderRects = [
		[0, 0, 8, 8],
		[size - 9, 0, size - 1, 8],
		[0, size - 9, 8, size - 1]
	];
	for (const ay of aligns) {
		for (const ax of aligns) {
			const overlaps = finderRects.some(([x0, y0, x1, y1]) =>
				ax + 2 >= x0 && ax - 2 <= x1 && ay + 2 >= y0 && ay - 2 <= y1);
			if (overlaps) {
				continue;
			}
			for (let dy = -2; dy <= 2; dy++) {
				for (let dx = -2; dx <= 2; dx++) {
					setFunction(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
				}
			}
		}
	}

	// ---- 数据区之前：先把格式信息、版本信息与暗模块的位置预留为功能模块 ----
	// （否则数据位会写进这些格子、随后又被格式位覆盖，码流移位。）
	const reserve = (x, y) => { isFunction[y][x] = true; };
	for (let i = 0; i <= 5; i++) {
		reserve(8, i);
		reserve(i, 8);
	}
	reserve(8, 7);
	reserve(8, 8);
	reserve(7, 8);
	for (let i = 9; i < 15; i++) {
		reserve(14 - i, 8);
		reserve(8, size - 15 + i);
	}
	for (let i = 0; i < 8; i++) {
		reserve(size - 1 - i, 8);
	}
	reserve(8, size - 8); // 暗模块（x=8, y=size-8）
	if (version >= 7) {
		for (let i = 0; i < 18; i++) {
			const a = size - 11 + (i % 3);
			const b = Math.floor(i / 3);
			reserve(a, b);
			reserve(b, a);
		}
	}

	// ---- 数据区：蛇形填入（跳过第 6 列），掩码择优后再画格式信息 ----
	const baseModules = modules.map(row => row.slice());
	let bestMask = 0;
	let bestPenalty = Infinity;
	let bestModules = null;
	for (let mask = 0; mask < 8; mask++) {
		const trial = baseModules.map(row => row.slice());
		let bitIndex = 0;
		for (let right = size - 1; right >= 1; right -= 2) {
			if (right === 6) {
				right = 5;
			}
			for (let vert = 0; vert < size; vert++) {
				for (let j = 0; j < 2; j++) {
					const x = right - j;
					const upward = ((right + 1) & 2) === 0;
					const y = upward ? size - 1 - vert : vert;
					if (!isFunction[y][x] && bitIndex < finalBits.length) {
						let bit = finalBits[bitIndex];
						bitIndex++;
						if (maskCondition(mask, y, x)) {
							bit ^= 1;
						}
						trial[y][x] = bit === 1;
					}
				}
			}
		}
		const penalty = penaltyScore(trial, size);
		if (penalty < bestPenalty) {
			bestPenalty = penalty;
			bestMask = mask;
			bestModules = trial;
		}
	}
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			modules[y][x] = bestModules[y][x];
		}
	}
	// 格式信息（两份）与暗模块；版本 ≥ 7 加版本信息。
	const fmt = formatBits(0, bestMask); // 纠错等级 M 对应 00
	for (let i = 0; i <= 5; i++) {
		setFunction(8, i, getBit(fmt, i));
	}
	setFunction(8, 7, getBit(fmt, 6));
	setFunction(8, 8, getBit(fmt, 7));
	setFunction(7, 8, getBit(fmt, 8));
	for (let i = 9; i < 15; i++) {
		setFunction(14 - i, 8, getBit(fmt, i));
	}
	for (let i = 0; i < 8; i++) {
		setFunction(size - 1 - i, 8, getBit(fmt, i));
	}
	for (let i = 8; i < 15; i++) {
		setFunction(8, size - 15 + i, getBit(fmt, i));
	}
	setFunction(8, size - 8, true); // 暗模块（x=8, y=size-8）
	if (version >= 7) {
		const ver = versionBits(version);
		for (let i = 0; i < 18; i++) {
			const bit = getBit(ver, i);
			const a = size - 11 + (i % 3);
			const b = Math.floor(i / 3);
			setFunction(a, b, bit);
			setFunction(b, a, bit);
		}
	}
	return {
		version,
		size,
		mask: bestMask,
		modules: modules.map(row => row.map(v => (v ? '1' : '0')).join(''))
	};
}

export default { encodeQr };
