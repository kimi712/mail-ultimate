import { parseHTML } from 'linkedom';

const emailUtils = {

	getDomain(email) {
		if (typeof email !== 'string') return '';
		const parts = email.split('@');
		return parts.length === 2 ? parts[1] : '';
	},

	getName(email) {
		if (typeof email !== 'string') return '';
		const parts = email.trim().split('@');
		return parts.length === 2 ? parts[0] : '';
	},

	getBaseEmail(email) {
		const parts = email.split('@');
		if (parts.length !== 2) return '';
		const localPart = parts[0].split('+')[0];
		return localPart + '@' + parts[1];
	},

	// 纯文本归一化：先把 HTML 实体解码（历史邮件正文里被 i18next 转义器
	// 写入的 &#x2F;、&amp; 等），再做空白处理。解码只认完整实体
	// `&name;` / `&#123;` / `&#x2F;`，普通 & 不动；调用方再转义时仍安全。
	decodeHtmlEntities(text) {
		if (!text || !String(text).includes('&')) return text || ''
		const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
		return String(text).replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, code) => {
			if (code[0] === '#') {
				const n = (code[1] === 'x' || code[1] === 'X')
					? parseInt(code.slice(2), 16)
					: parseInt(code.slice(1), 10);
				if (Number.isFinite(n) && n > 0 && n <= 0x10FFFF) {
					try { return String.fromCodePoint(n); } catch (e) { return m; }
				}
				return m;
			}
			return named[code] !== undefined ? named[code] : m;
		});
	},

	formatText(text) {
		if (!text) return ''
		return this.decodeHtmlEntities(text)
			.split('\n')
			.map(line => {
				return line.replace(/[\u200B-\u200F\uFEFF\u034F\u200B-\u200F\u00A0\u3000\u00AD]/g, '')
					.replace(/\s+/g, ' ')
					.trim();
			})
			.join('\n')
			.replace(/\n{3,}/g, '\n')
			.trim();
	},

	htmlToText(content) {
		if (!content) return ''
		try {
			const wrappedContent = content.includes('<body')
				? content
				: `<!DOCTYPE html><html><body>${content}</body></html>`;
			const { document } = parseHTML(wrappedContent);
			document.querySelectorAll('style, script, title').forEach(el => el.remove());
			let text = document.body.innerText;
			return this.formatText(text);
		} catch (e) {
			console.error(e)
			return ''
		}
	}
};

export default emailUtils;
