// 抗量子加密（斯诺登第二批，v3_15DB）：ML-KEM-768（FIPS 203）。
// 实现：@noble/post-quantum 0.7.1 的 ml_kem768（Paul Miller，MIT 许可证，
// "Auditable & minimal JS implementation of post-quantum cryptography: FIPS 203,
// 204, 205, Falcon"）。已发表、可审计的实现，绝不自己造算法；由 Vite 打包进
// 应用（构建产物内含该代码，运行时无外部调用）。
// 密钥尺寸（FIPS 203）：封装公钥 1184 字节，解封私钥 2400 字节，密文 1088 字节，
// 共享秘密 32 字节。公钥以 base64 存后端（可公开）；私钥经用户 KEK 加密后以
// `e2ee:v1:` 信封存后端（服务端无法解密）。
// CEK 包裹信封 `pq:v1:<base64(kemCt(1088B) || iv(12B) || aesCt(48B))>`：
// ML-KEM 封装出 32 字节共享秘密，直接作 AES-GCM-256 密钥加密 32 字节 CEK。
// 解封时 ML-KEM 解封永不抛错（错密文只会得到不同的共享秘密），AES-GCM 解密
// 会抛错——篡改密文必被发现。
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js'

export const MLKEM_PUBLIC_KEY_BYTES = 1184
export const MLKEM_PRIVATE_KEY_BYTES = 2400
export const MLKEM_CIPHERTEXT_BYTES = 1088
export const MLKEM_SHARED_SECRET_BYTES = 32
export const PQ_WRAP_PREFIX = 'pq:v1:'

function b64encode(bytes) {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

function b64decode(str) {
  const bin = atob(str)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

// 生成 ML-KEM-768 密钥对。返回 { publicKeyB64, privateKeyBytes }。
export function generateMlKemKeypair() {
  const { publicKey, secretKey } = ml_kem768.keygen()
  return { publicKeyB64: b64encode(publicKey), privateKeyBytes: secretKey }
}

// 用收件人公钥（base64）封装 32 字节 CEK。返回 `pq:v1:` 信封。
export async function wrapCekMlKem(cekBytes, publicKeyB64) {
  const publicKey = b64decode(publicKeyB64)
  if (publicKey.length !== MLKEM_PUBLIC_KEY_BYTES) {
    throw new Error('mlkem-invalid-public-key')
  }
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(publicKey)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await crypto.subtle.importKey('raw', sharedSecret, 'AES-GCM', false, ['encrypt'])
  const aesCt = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, cekBytes))
  const packed = new Uint8Array(MLKEM_CIPHERTEXT_BYTES + 12 + aesCt.length)
  packed.set(cipherText, 0)
  packed.set(iv, MLKEM_CIPHERTEXT_BYTES)
  packed.set(aesCt, MLKEM_CIPHERTEXT_BYTES + 12)
  return PQ_WRAP_PREFIX + b64encode(packed)
}

// 用自己的私钥（2400 字节）解封 CEK。返回 32 字节 CEK；信封被篡改时抛错。
export async function unwrapCekMlKem(wrapped, privateKeyBytes) {
  if (!wrapped || !wrapped.startsWith(PQ_WRAP_PREFIX)) {
    throw new Error('mlkem-invalid-wrap')
  }
  const packed = b64decode(wrapped.slice(PQ_WRAP_PREFIX.length))
  if (packed.length !== MLKEM_CIPHERTEXT_BYTES + 12 + 48) {
    throw new Error('mlkem-invalid-wrap')
  }
  if (privateKeyBytes.length !== MLKEM_PRIVATE_KEY_BYTES) {
    throw new Error('mlkem-invalid-private-key')
  }
  const cipherText = packed.slice(0, MLKEM_CIPHERTEXT_BYTES)
  const iv = packed.slice(MLKEM_CIPHERTEXT_BYTES, MLKEM_CIPHERTEXT_BYTES + 12)
  const aesCt = packed.slice(MLKEM_CIPHERTEXT_BYTES + 12)
  const sharedSecret = ml_kem768.decapsulate(cipherText, privateKeyBytes)
  const key = await crypto.subtle.importKey('raw', sharedSecret, 'AES-GCM', false, ['decrypt'])
  const cek = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, aesCt)
  return new Uint8Array(cek)
}

// 自检：密钥生成 → 封装 → 解封往返 + 篡改密文必失败。
// 供前端自测脚本与安全中心“验证抗量子密钥”按钮调用。
export async function selfTestMlKem() {
  const { publicKeyB64, privateKeyBytes } = generateMlKemKeypair()
  const cek = crypto.getRandomValues(new Uint8Array(32))
  const wrapped = await wrapCekMlKem(cek, publicKeyB64)
  const cek2 = await unwrapCekMlKem(wrapped, privateKeyBytes)
  if (cek2.length !== 32 || !cek.every((b, i) => b === cek2[i])) {
    throw new Error('mlkem-selftest-roundtrip-failed')
  }
  // 篡改密文：把 pq 信封中间改一位，解封必须抛错（AES-GCM 认证失败）。
  const tampered = wrapped.slice(0, 20) + (wrapped[20] === 'A' ? 'B' : 'A') + wrapped.slice(21)
  let threw = false
  try {
    await unwrapCekMlKem(tampered, privateKeyBytes)
  } catch (e) {
    threw = true
  }
  if (!threw) throw new Error('mlkem-selftest-tamper-not-detected')
  return true
}

// ---------------------------------------------------------------------------
// 私钥存放：解封私钥（2400 字节）经用户 KEK（加密密码派生密钥）加密后以
// `e2ee:v1:` 信封存后端，服务端无法解密。解密后的私钥只放本模块内存，
// 绝不写入任何持久化存储；锁定时随 KEK 一起清掉。
import { encryptBytes, decryptBytes } from './e2ee.js'

let memoryMlkemPrivateKey = null

export function hasMemoryMlkemPrivateKey() {
  return !!memoryMlkemPrivateKey
}

export function getMemoryMlkemPrivateKey() {
  return memoryMlkemPrivateKey
}

export function setMemoryMlkemPrivateKey(bytes) {
  memoryMlkemPrivateKey = bytes || null
  return memoryMlkemPrivateKey
}

export function clearMemoryMlkemPrivateKey() {
  memoryMlkemPrivateKey = null
}

export async function encryptMlkemPrivateKey(privateKeyBytes, kek) {
  if (privateKeyBytes.length !== MLKEM_PRIVATE_KEY_BYTES) {
    throw new Error('mlkem-invalid-private-key')
  }
  return encryptBytes(privateKeyBytes, kek)
}

export async function decryptMlkemPrivateKey(privEnc, kek) {
  const raw = await decryptBytes(privEnc, kek)
  if (raw.length !== MLKEM_PRIVATE_KEY_BYTES) {
    throw new Error('mlkem-invalid-private-key')
  }
  return raw
}
