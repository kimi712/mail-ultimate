import BizError from '../error/biz-error';
import settingService from './setting-service';
import { t } from '../i18n/i18n'

const turnstileService = {

	async verify(c, token) {

		if (!token) {
			throw new BizError(t('emptyBotToken'),400);
		}

		const settingRow = await settingService.query(c)

		if (!settingRow.secretKey) {
			throw new BizError(t('turnstileNotConfigured'), 400);
		}

		let result;
		try {
			const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded'
				},
				body: new URLSearchParams({
					secret: settingRow.secretKey,
					response: token,
					remoteip: c.req.header('cf-connecting-ip')
				})
			});

			result = await res.json();
		} catch (e) {
			throw new BizError(t('botVerifyFail'), 400);
		}

		if (!result || !result.success) {
			throw new BizError(t('botVerifyFail'),400)
		}
	}
};

export default turnstileService;
