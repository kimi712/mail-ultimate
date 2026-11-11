// 斯诺登第二批（v3_15DB）：v2 加密信的客户端解密共享逻辑（读信页 + 邮件列表共用）。
// v2 信封：正文用一次性密钥 CEK 加密，CEK 按收件人包裹在 email.cekWrapped 里
// （cekAlg='mlkem768' 为抗量子包裹，'sym' 为 KEK 对称包裹）；发件人用 CEK 密封
// 在 email.sealedSender 里（`sealed:v1:` 信封）。
// 注意：本模块只在 E2EE 已解锁（内存有 KEK）后调用；ML-KEM 私钥取回后只放内存。
import { getMemoryKey, importCek, unwrapCekSym, isSealedSender, unsealSender } from './e2ee.js'
import {
  unwrapCekMlKem, decryptMlkemPrivateKey,
  getMemoryMlkemPrivateKey, setMemoryMlkemPrivateKey
} from './pqkem.js'
import { getMlkemPrivate } from '@/request/security.js'

// 解出某封 v2 信的 CEK（CryptoKey）。cekWrapped 缺失、算法未知、私钥未生成时抛错。
export async function resolveMailCek(mail) {
  if (!mail.cekWrapped) {
    throw new Error('missing cek wrap')
  }
  const kek = getMemoryKey()
  if (!kek) {
    throw new Error('no key')
  }
  if (mail.cekAlg === 'mlkem768') {
    let priv = getMemoryMlkemPrivateKey()
    if (!priv) {
      const res = await getMlkemPrivate()
      const privEnc = res?.privEnc || ''
      if (!privEnc) {
        throw new Error('no mlkem private key')
      }
      priv = await decryptMlkemPrivateKey(privEnc, kek)
      setMemoryMlkemPrivateKey(priv)
    }
    const raw = await unwrapCekMlKem(mail.cekWrapped, priv)
    return importCek(raw)
  }
  const raw = await unwrapCekSym(mail.cekWrapped, kek)
  return importCek(raw)
}

// 解出某封密封信的发件人 {email, name}。非密封信返回 null；解密失败抛错。
export async function decryptSealedSender(mail) {
  if (!isSealedSender(mail.sealedSender)) {
    return null
  }
  const cekKey = await resolveMailCek(mail)
  return unsealSender(mail.sealedSender, cekKey)
}
