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

	async function fetchWithRetry(url, options, retries = 2, delay = 1000) {
		for (let i = 0; i <= retries; i++) {
			try {
				const response = await fetch(url, options);
				if (!response.ok) {
					throw new Error(`HTTP ${response.status}: ${response.statusText}`);
				}
				return response;
			} catch (error) {
				if (i === retries) throw error;
				await new Promise(resolve => setTimeout(resolve, delay));
			}
		}
	}

	async function fetchCompanyInfo(name, captcha) {
		try {
			// 初始化请求，获取 session cookie
			const headers = {
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
				'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
				'Accept-Language': 'zh-CN,zh;q=0.9',
				'Connection': 'keep-alive',
				'Cookie': '',
			};

			// 首次请求，获取 cookie
			const initUrl = 'https://www.qichacha.com';
			const initResponse = await fetchWithRetry(initUrl, { headers });
			const cookies = initResponse.headers.get('set-cookie') || '';
			headers.Cookie = cookies;

			// 搜索公司
			const searchUrl = `https://www.qichacha.com/search?key=${encodeURIComponent(name)}`;
			const searchResponse = await fetchWithRetry(searchUrl, { headers });
			const searchText = await searchResponse.text();

			// 调试：记录响应状态和内容长度
			console.log(`QiChaCha search status: ${searchResponse.status}, text length: ${searchText.length}`);

			// 检测验证码或错误
			if (searchResponse.status !== 200) {
				return {
					captchaRequired: true,
					captchaImage: '',
					message: `企查查返回错误状态码 ${searchResponse.status}，可能是服务器限制或需要验证。请手动验证。`,
				};
			}

			if (searchText.includes('验证码') || searchText.includes('验证') || searchText.includes('slider') || searchText.includes('validate')) {
				const captchaImageMatch = searchText.match(/<img[^>]+src=["'](.*?)["']/i);
				return {
					captchaRequired: true,
					captchaImage: captchaImageMatch ? `https://www.qichacha.com${captchaImageMatch[1]}` : '',
					message: searchText.includes('slider') || searchText.includes('validate') ? '检测到滑动验证或复杂验证，请在企查查官网手动完成验证后输入验证码。' : '请输入验证码。',
				};
			}

			// 检测空数据或错误页面
			if (searchText.includes('无结果') || searchText.includes('错误') || searchText.length < 1000) {
				return {
					captchaRequired: false,
					message: '企查查返回空数据或错误页面，可能是查询无结果或服务器限制。',
				};
			}

			// 提取公司详情链接
			const detailMatch = searchText.match(/href="\/firm_([a-z0-9]+)\.html"/i);
			if (!detailMatch) {
				return {
					captchaRequired: false,
					message: '未找到公司详情页面，可能是搜索结果为空。',
				};
			}

			// 访问详情页面
			const detailUrl = `https://www.qichacha.com/firm_${detailMatch[1]}.html`;
			const detailResponse = await fetchWithRetry(detailUrl, { headers });
			const detailText = await detailResponse.text();

			// 解析工商信息
			const nameMatch = detailText.match(/<h1[^>]*>(.+?)<\/h1>/) || [null, name];
			const regNumberMatch = detailText.match(/统一社会信用代码[：:]\s*([\w-]+)/) || [null, '未知'];
			const legalRepMatch = detailText.match(/法定代表人[：:]\s*<a[^>]+>(.+?)<\/a>/) || [null, '未知'];
			const capitalMatch = detailText.match(/注册资本[：:]\s*([^<]+)/) || [null, '未知'];
			const establishedMatch = detailText.match(/成立日期[：:]\s*([\d-]+(?:\s*至\s*[\d-]*)*)/) || [null, '未知'];

			const result = {
				name: nameMatch[1]?.trim(),
				regNumber: regNumberMatch[1]?.trim(),
				legalRep: legalRepMatch[1]?.trim(),
				capital: capitalMatch[1]?.trim(),
				established: establishedMatch[1]?.trim(),
				timestamp: new Date().toISOString(),
			};

			// 保存到 KV
			const key = `query_${Date.now()}_${result.regNumber}`;
			await BUSINESS_KV.put(key, JSON.stringify(result));

			return result;
		} catch (error) {
			console.error(`Fetch error for ${name}: ${error.message}`);
			return {
				captchaRequired: true,
				captchaImage: '',
				message: `查询失败: ${error.message}。可能是服务器限制或需要验证，请手动验证。`,
			};
		}
	}

	if (path === '/api/query' && request.method === 'POST') {
		try {
			const { companies, captcha } = await request.json();
			const results = [];
			for (const name of companies) {
				const result = await fetchCompanyInfo(name, captcha);
				if (result.captchaRequired || result.message) {
					return new Response(JSON.stringify(result), {
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
			console.error('Query endpoint error:', error.message);
			return new Response(JSON.stringify({ error: '查询失败: ' + error.message }), {
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
			console.error('History endpoint error:', error.message);
			return new Response(JSON.stringify({ error: '获取历史记录失败: ' + error.message }), {
				status: 500,
				headers: { 'Content-Type': 'application/json', ...corsHeaders },
			});
		}
	}

	return new Response('Not Found', { status: 404 });
}