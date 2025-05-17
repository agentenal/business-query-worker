addEventListener('fetch', event => {
	event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
	const url = new URL(request.url);
	const path = url.pathname;

	const corsHeaders = {
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type',
	};

	if (request.method === 'OPTIONS') {
		return new Response(null, { headers: corsHeaders });
	}

	async function fetchCompanyInfo(name, captcha) {
		try {
			const searchUrl = `http://www.gsxt.gov.cn/corp-query-entprise-info-xx.html?key=${encodeURIComponent(name)}&captcha=${captcha || ''}`;
			const response = await fetch(searchUrl, {
				headers: {
					'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
				},
			});
			const text = await response.text();

			if (text.includes('验证码')) {
				return { captchaRequired: true };
			}

			// 简单解析HTML（实际需根据GSXT页面结构调整）
			const nameMatch = text.match(/<h1 class="company-name">(.+?)<\/h1>/);
			const regNumberMatch = text.match(/统一社会信用代码：(.+?)<\/span>/);
			const legalRepMatch = text.match(/法定代表人：(.+?)<\/span>/);
			const capitalMatch = text.match(/注册资本：(.+?)<\/span>/);
			const establishedMatch = text.match(/成立日期：(.+?)<\/span>/);

			if (!nameMatch) {
				return null;
			}

			const result = {
				name: nameMatch[1] || name,
				regNumber: regNumberMatch ? regNumberMatch[1] : '未知',
				legalRep: legalRepMatch ? legalRepMatch[1] : '未知',
				capital: capitalMatch ? capitalMatch[1] : '未知',
				established: establishedMatch ? establishedMatch[1] : '未知',
				timestamp: new Date().toISOString(),
			};

			// 保存到KV
			const key = `query_${Date.now()}_${result.regNumber}`;
			await BUSINESS_KV.put(key, JSON.stringify(result));

			return result;
		} catch (error) {
			return null;
		}
	}

	if (path === '/api/query' && request.method === 'POST') {
		try {
			const { companies, captcha } = await request.json();
			const results = [];
			for (const name of companies) {
				const result = await fetchCompanyInfo(name, captcha);
				if (result && result.captchaRequired) {
					return new Response(JSON.stringify({ captchaRequired: true }), {
						headers: { 'Content-Type': 'application/json', ...corsHeaders },
					});
				}
				if (result) {
					results.push(result);
				}
			}
			return new Response(JSON.stringify({ results }), {
				headers: { 'Content-Type': 'application/json', ...corsHeaders },
			});
		} catch (error) {
			return new Response(JSON.stringify({ error: '查询失败' }), {
				status: 500,
				headers: { 'Content-Type': 'application/json', ...corsHeaders },
			});
		}
	}

	if (path === '/api/history' && request.method === 'GET') {
		try {
			const list = await BUSINESS_KV.list();
			const history = [];
			for (const key of list.keys) {
				const value = await BUSINESS_KV.get(key.name);
				history.push(JSON.parse(value));
			}
			history.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
			return new Response(JSON.stringify(history.slice(0, 50)), {
				headers: { 'Content-Type': 'application/json', ...corsHeaders },
			});
		} catch (error) {
			return new Response(JSON.stringify({ error: '获取历史记录失败' }), {
				status: 500,
				headers: { 'Content-Type': 'application/json', ...corsHeaders },
			});
		}
	}

	return new Response('Not Found', { status: 404 });
}