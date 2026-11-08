// 前端 smoke 测试（第六阶段 C 路）：node 直接跑，无需浏览器与构建。
// 覆盖 utils/e2ee.js（PBKDF2 派生 + AES-GCM 往返、错误密钥解密失败、
// 内存密钥不落盘）与 utils/webauthn.js（base64url 往返、options 转换）。
// 运行：mail-vue 下 node test/e2ee.smoke.mjs（退出码 0 = 通过）。
// 注意：与后端接口的联调不在此覆盖——B 路接口尚未落地，见汇报。
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

// ---------- localStorage 桩：记录一切写入调用 ----------
const setCalls = [];
globalThis.localStorage = {
	getItem: () => null,
	setItem: (k, v) => setCalls.push([String(k), String(v)]),
	removeItem: () => {}
};

const e2ee = await import('../src/utils/e2ee.js');
const webauthn = await import('../src/utils/webauthn.js');

let passed = 0;
async function check(name, fn) {
	await fn();
	passed++;
	console.log('ok -', name);
}

const PASSWORD = 'correct horse battery staple';
const WRONG_PASSWORD = 'wrong horse battery staple';
const SALT = e2ee.generateSalt();
const PLAINTEXT = 'Hello, E2EE 世界！<b>html</b>';

// ---------- e2ee.js ----------
await check('PBKDF2 + AES-GCM 往返：同一密码派生可解密', async () => {
	const key = await e2ee.deriveKey(PASSWORD, SALT);
	const envelope = await e2ee.encryptText(PLAINTEXT, key);
	assert.ok(e2ee.isE2eeEnvelope(envelope), '应为 e2ee:v1: 信封');
	assert.notEqual(envelope, PLAINTEXT);
	assert.equal(await e2ee.decryptText(envelope, key), PLAINTEXT);
});

await check('PBKDF2 + AES-GCM 往返：encryptEmailParts/decryptEmailParts（text + content）', async () => {
	const key = await e2ee.deriveKey(PASSWORD, SALT);
	const parts = await e2ee.encryptEmailParts(
		{text: 'plain text 正文', content: '<p>html 正文</p>'},
		key
	);
	assert.ok(e2ee.isE2eeEnvelope(parts.text));
	assert.ok(e2ee.isE2eeEnvelope(parts.content));
	assert.notEqual(parts.text, parts.content, 'text 与 content 应各自独立 IV');
	const back = await e2ee.decryptEmailParts(parts, key);
	assert.equal(back.text, 'plain text 正文');
	assert.equal(back.content, '<p>html 正文</p>');
});

await check('错误密钥解密失败：错密码派生的密钥解不开', async () => {
	const key = await e2ee.deriveKey(PASSWORD, SALT);
	const wrongKey = await e2ee.deriveKey(WRONG_PASSWORD, SALT);
	const envelope = await e2ee.encryptText(PLAINTEXT, key);
	await assert.rejects(() => e2ee.decryptText(envelope, wrongKey));
});

await check('篡改密文解密失败：改一位即认证失败', async () => {
	const key = await e2ee.deriveKey(PASSWORD, SALT);
	const envelope = await e2ee.encryptText(PLAINTEXT, key);
	const tampered = envelope.slice(0, -2) + (envelope.endsWith('A') ? 'BB' : 'AA');
	assert.notEqual(tampered, envelope);
	await assert.rejects(() => e2ee.decryptText(tampered, key));
});

await check('非信封值解密抛错、明文原样判断', async () => {
	const key = await e2ee.deriveKey(PASSWORD, SALT);
	assert.equal(e2ee.isE2eeEnvelope('plain text'), false);
	assert.equal(e2ee.isE2eeEnvelope(''), false);
	assert.equal(e2ee.isE2eeEnvelope(null), false);
	await assert.rejects(() => e2ee.decryptText('plain text', key));
	const back = await e2ee.decryptEmailParts({text: 'plain', content: ''}, key);
	assert.equal(back.text, 'plain');
});

await check('内存密钥：unlockWithPassword 只放内存，clear 后加密抛错', async () => {
	assert.equal(e2ee.hasMemoryKey(), false);
	await e2ee.unlockWithPassword(PASSWORD, SALT);
	assert.equal(e2ee.hasMemoryKey(), true);
	const envelope = await e2ee.encryptText(PLAINTEXT);
	assert.equal(await e2ee.decryptText(envelope), PLAINTEXT);
	e2ee.clearMemoryKey();
	assert.equal(e2ee.hasMemoryKey(), false);
	await assert.rejects(() => e2ee.encryptText(PLAINTEXT));
	await assert.rejects(() => e2ee.decryptText(envelope));
});

await check('内存密钥不落盘：e2ee.js 源码无 localStorage/sessionStorage，运行期零写入', async () => {
	const here = dirname(fileURLToPath(import.meta.url));
	const src = readFileSync(join(here, '../src/utils/e2ee.js'), 'utf8');
	assert.ok(!src.includes('localStorage'), 'e2ee.js 不得出现 localStorage');
	assert.ok(!src.includes('sessionStorage'), 'e2ee.js 不得出现 sessionStorage');
	assert.ok(!src.includes('document.cookie'), 'e2ee.js 不得写 cookie');
	assert.equal(setCalls.length, 0, '派生/加解密全程不得写 localStorage');
});

await check('isInternalEmail：站内域名才放行，域名表为空一律判站外', () => {
	assert.equal(e2ee.isInternalEmail('a@aevorynthtech.com', ['aevorynthtech.com']), true);
	assert.equal(e2ee.isInternalEmail('A@AEVORYNTHtech.com', ['aevorynthtech.com']), true);
	assert.equal(e2ee.isInternalEmail('a@gmail.com', ['aevorynthtech.com']), false);
	assert.equal(e2ee.isInternalEmail('a@aevorynthtech.com', []), false);
	assert.equal(e2ee.isInternalEmail('not-an-email', ['aevorynthtech.com']), false);
	assert.equal(e2ee.isInternalEmail('a@evil-aevorynthtech.com', ['aevorynthtech.com']), false);
});

await check('generateSalt：每次不同，16 字节 base64', () => {
	assert.notEqual(e2ee.generateSalt(), e2ee.generateSalt());
	assert.equal(e2ee.b64ToBuf(e2ee.generateSalt()).length, 16);
});

// ---------- webauthn.js ----------
await check('webauthn base64url 往返', () => {
	const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 255]);
	const encoded = webauthn.bufToB64url(bytes);
	assert.ok(!/[+/=]/.test(encoded), 'base64url 不得含 + / =');
	assert.deepEqual([...webauthn.b64urlToBuf(encoded)], [...bytes]);
	assert.deepEqual([...webauthn.b64urlToBuf('AAEC')], [0, 1, 2]);
});

await check('webauthn options 转换：challenge/user.id/excludeCredentials 进 ArrayBuffer，出 JSON 回 base64url', () => {
	const challengeB64 = webauthn.bufToB64url(new Uint8Array([1, 2, 3, 4]));
	const userIdB64 = webauthn.bufToB64url(new Uint8Array([9, 9, 9]));
	const args = webauthn.optionsToCreateArgs({
		challenge: challengeB64,
		rp: {name: 'Test', id: 'aevorynthtech.com'},
		user: {id: userIdB64, name: 'a@aevorynthtech.com', displayName: 'a'},
		pubKeyCredParams: [{type: 'public-key', alg: -7}],
		excludeCredentials: [{type: 'public-key', id: challengeB64}]
	});
	assert.ok(args.publicKey.challenge instanceof ArrayBuffer);
	assert.ok(args.publicKey.user.id instanceof ArrayBuffer);
	assert.ok(args.publicKey.excludeCredentials[0].id instanceof ArrayBuffer);
	const fakeCredential = {
		id: 'cred-id',
		rawId: new Uint8Array([5, 6, 7]).buffer,
		type: 'public-key',
		response: {
			attestationObject: new Uint8Array([1, 2]).buffer,
			clientDataJSON: new Uint8Array([3, 4]).buffer,
			getTransports: () => ['usb']
		}
	};
	const json = webauthn.credentialToJson(fakeCredential);
	assert.equal(json.rawId, webauthn.bufToB64url(new Uint8Array([5, 6, 7])));
	assert.deepEqual(json.response.transports, ['usb']);
	assert.equal(typeof json.response.attestationObject, 'string');
});

console.log(`\nSMOKE PASS: ${passed} 项全部通过`);
