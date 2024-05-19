interface Env {
	CORS_ALLOW_ORIGIN: string;
	HELIUS_API_KEY: string;
	RATE_LIMIT_NAMESPACE: KVNamespace;
	RATE_LIMIT_MAX_REQUESTS: string;
	RATE_LIMIT_TIME_WINDOW: string;
	WHITELISTED_IPS: string;
}

export default {
	async fetch(request: Request, env: Env) {
		// Parse the allowed origins from the environment variable
		const supportedDomains = env.CORS_ALLOW_ORIGIN ? env.CORS_ALLOW_ORIGIN.split(',') : undefined;
		const corsHeaders: Record<string, string> = {
			"Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, OPTIONS",
			"Access-Control-Allow-Headers": "*",
		};

		// Handle CORS
		if (supportedDomains) {
			const origin = request.headers.get('Origin');
			if (origin) {
				const isWhitelisted = supportedDomains.some((domain) => {
					// Convert domain pattern to a regex pattern string
					const domainPattern = domain
						.replace(/\./g, '\\.')        // Escape dots
						.replace(/\*/g, '[a-zA-Z0-9-]+'); // Replace * with valid subdomain pattern
				
					const regexPattern = `^${domainPattern}$`;
					const regex = new RegExp(regexPattern);
					return regex.test(origin);
				});

				if (isWhitelisted) {
					corsHeaders['Access-Control-Allow-Origin'] = origin;
				}
			}
		} else {
			corsHeaders['Access-Control-Allow-Origin'] = '*';
		}

		// Respond to OPTIONS requests with CORS headers
		if (request.method === "OPTIONS") {
			return new Response(null, {
				status: 200,
				headers: corsHeaders,
			});
		}

		// Extract client identifier (e.g., IP address)
		const clientIdentifier = request.headers.get('CF-Connecting-IP') || 'unknown';

		// Check if the client IP is whitelisted
		const whitelistedIps = env.WHITELISTED_IPS ? env.WHITELISTED_IPS.split(',') : [];
		if (whitelistedIps.includes(clientIdentifier)) {
			return handleRequest(request, env, corsHeaders); // Proceed without rate limiting
		}

		// Rate limiting logic
		const RATE_LIMIT_MAX_REQUESTS = parseInt(env.RATE_LIMIT_MAX_REQUESTS) || 50;
		const RATE_LIMIT_TIME_WINDOW = parseInt(env.RATE_LIMIT_TIME_WINDOW) || 1;
		const currentTime = Math.floor(Date.now() / (RATE_LIMIT_TIME_WINDOW * 1000)); // current time in the specified intervals
		const windowKey = `${clientIdentifier}:${currentTime}`; // Unique key for the time window

		let requestCount = await env.RATE_LIMIT_NAMESPACE.get(windowKey); // Retrieve the request count from KV
		let count = requestCount ? parseInt(requestCount) : 0;

		if (count >= RATE_LIMIT_MAX_REQUESTS) {
			return new Response('Rate limit exceeded', {
				status: 429,
				headers: corsHeaders,
			});
		}

		// Increment request count and update KV store
		count += 1;
		await env.RATE_LIMIT_NAMESPACE.put(windowKey, count.toString(), { expirationTtl: 60 });

		return handleRequest(request, env, corsHeaders);
	},
};

async function handleRequest(request: Request, env: Env, corsHeaders: Record<string, string>) {
	const { pathname, search, searchParams } = new URL(request.url);
	const CLUSTER = searchParams.get('cluster') || 'mainnet';
	const upgradeHeader = request.headers.get('Upgrade');

	// Handle WebSocket requests
	if (upgradeHeader || upgradeHeader === 'websocket') {
		return await fetch(`https://${CLUSTER}.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`, request);
	}

	// Handle regular requests
	const payload = await request.text();
	const proxyRequest = new Request(`https://${pathname === '/' ? `${CLUSTER}.helius-rpc.com` : 'api.helius.xyz'}${pathname}?api-key=${env.HELIUS_API_KEY}${search ? `&${search.slice(1)}` : ''}`, {
		method: request.method,
		body: payload || null,
		headers: {
			'Content-Type': 'application/json',
			'X-Helius-Cloudflare-Proxy': 'true',
		}
	});

	return await fetch(proxyRequest).then(res => {
		return new Response(res.body, {
			status: res.status,
			headers: corsHeaders
		});
	});
}
