import safeServe from '../utils/safe-serve';
import constant from '../const/constant';

// 纵深防御：KV 对象层只认 attachments/、static/、wallpapers/ 三个前缀
// （见 constant.js）。运营键（会话 auth-uid:、设置 setting:、公共 token
// public_key: 等）绝不走 kv-obj-service；这里硬拦，免得以后有调用方
// 误把运营键当对象键读/写。getObj 挡掉返回 null（404），putObj 直接抛错。
function assertObjectKey(key) {
	if (typeof key !== 'string' || !constant.OBJECT_KEY_PREFIXES.some(p => key.startsWith(p))) {
		throw new Error('kv-obj: key 不是合法对象键: ' + String(key));
	}
}

const kvObjService = {

	async putObj(c, key, content, metadata) {
		assertObjectKey(key);
		await c.env.kv.put(key, content, { metadata: metadata });
	},

	async deleteObj(c, keys) {

		if (typeof keys === 'string') {
			keys = [keys];
		}

		if (keys.length === 0) {
			return;
		}

		// 白帽反馈 #4：只删对象键（attachments/、static/、wallpapers/），
		// 非对象键直接跳过，免得误删运营键。
		keys = keys.filter(key => typeof key === 'string' && constant.OBJECT_KEY_PREFIXES.some(p => key.startsWith(p)));
		if (keys.length === 0) {
			return;
		}

		await Promise.all(keys.map( key => c.env.kv.delete(key)));
	},

	async getObj(c, key) {
		if (typeof key !== 'string' || !constant.OBJECT_KEY_PREFIXES.some(p => key.startsWith(p))) {
			return null;
		}
		const obj = await c.env.kv.getWithMetadata(key, { type: "arrayBuffer"});
		if (!obj.value) {
			return null;
		}

		const { safeServeHeaders } = safeServe;
		return new Response(obj.value, {
			headers: safeServeHeaders(obj.metadata || {})
		});
	},

	async toObjResp(c, key) {

		return await this.getObj(c, key);

	}

};

export default kvObjService;
