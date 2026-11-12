import s3Service from './s3-service';
import settingService from './setting-service';
import kvObjService from './kv-obj-service';
import safeServe from '../utils/safe-serve';
import constant from '../const/constant';

// 对象键只认 attachments/、static/、wallpapers/ 三个前缀（见 constant.js）。
// 本站实际跑在 KV 上，KV 里还放着会话、设置缓存等运营键；/oss/<key> 无鉴权，
// 前缀之外的一律按“不存在”处理（404，不透露键是否存在）。
function isObjectKey(key) {
	if (typeof key !== 'string' || key === '') return false;
	return constant.OBJECT_KEY_PREFIXES.some(p => key.startsWith(p));
}

const r2Service = {

	async storageType(c) {

		const setting = await settingService.query(c);
		const { bucket, endpoint, s3AccessKey, s3SecretKey } = setting;

		if (!!(bucket && endpoint && s3AccessKey && s3SecretKey)) {
			return 'S3';
		}

		if (c.env.r2) {
			return 'R2';
		}

		return 'KV';
	},

	async putObj(c, key, content, metadata) {

		const storageType = await this.storageType(c);

		if (storageType === 'KV') {
			await kvObjService.putObj(c, key, content, metadata);
		}

		if (storageType === 'R2') {
			await c.env.r2.put(key, content, {
				httpMetadata: { ...metadata }
			});
		}

		if (storageType === 'S3') {
			await s3Service.putObj(c, key, content, metadata);
		}

	},

	async getObj(c, key) {
		const storageType = await this.storageType(c);

		if (storageType === 'KV') {
			return await kvObjService.getObj(c, key);
		}

		if (storageType === 'R2') {
			return await c.env.r2.get(key);
		}

		if (storageType === 'S3') {
			return await s3Service.getObj(c, key);
		}
	},

	/**
	 * Always returns a Response (or null if missing) so HTTP handlers
	 * can serve KV / R2 / S3 the same way.
	 */
	async toObjResp(c, key) {
		try {
			// 白帽反馈 #4：非对象键一律 404（不调用底层存储，不透露键是否存在）。
			if (!isObjectKey(key)) {
				return null;
			}
			const storageType = await this.storageType(c);

			if (storageType === 'KV') {
				return await kvObjService.getObj(c, key);
			}

			if (storageType === 'R2') {
				const obj = await c.env.r2.get(key);
				if (!obj) {
					return null;
				}
				// 白帽反馈 #1：绝不原样回吐存下来的 Content-Type/Disposition——
				// 附件的 mimeType 是发件人自带的，text/html、image/svg+xml
				// 同源 serve 会当文档执行。用 safeServeHeaders 统一重算。
				return new Response(obj.body, {
					headers: safeServeHeaders(obj.httpMetadata || {})
				});
			}

			if (storageType === 'S3') {
				return await s3Service.getObj(c, key);
			}

			return null;
		} catch (e) {
			const status = e?.$metadata?.httpStatusCode;
			const code = e?.name || e?.Code || e?.code;
			if (status === 404 || code === 'NoSuchKey' || code === 'NotFound') {
				return null;
			}
			throw e;
		}
	},

	async delete(c, key) {

		const storageType = await this.storageType(c);

		if (storageType === 'KV') {
			await kvObjService.deleteObj(c, key);
		}

		if (storageType === 'R2') {
			await c.env.r2.delete(key);
		}

		if (storageType === 'S3'){
			await s3Service.deleteObj(c, key);
		}

	}

};
export default r2Service;
