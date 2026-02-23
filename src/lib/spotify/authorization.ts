import { browser } from '$app/environment';
import { resolve } from '$app/paths';
import { PUBLIC_SPOTIFY_CLIENT_ID } from '$env/static/public';
import type { MakeRequest } from './request';

const CONFIG = {
	client_id: PUBLIC_SPOTIFY_CLIENT_ID,
	redirect_endpoint: resolve('/callback')
};

const LOCAL_STORAGE_PREFIX = 'setlists:';

export const login = async (scopes: string[]): Promise<void> => {
	const code_verifier = generateRandomString(64);
	toLocalStorage('code_verifier', code_verifier);
	const hashed = await sha256(code_verifier);
	const code_challenge = base64Encode(hashed);
	const params = {
		response_type: 'code',
		client_id: CONFIG.client_id,
		scope: scopes.join(' '),
		code_challenge_method: 'S256',
		code_challenge: code_challenge,
		redirect_uri: window.location.origin + CONFIG.redirect_endpoint
	};
	const auth_url = new URL('https://accounts.spotify.com/authorize');
	auth_url.search = new URLSearchParams(params).toString();
	toLocalStorage('redirect_uri', window.location.href);
	window.location.replace(auth_url.toString());
};

export const handleCallback = async () => {
	let code_verifier = fromLocalStorage('code_verifier');
	if (!code_verifier) {
		throw new Error('No code verifier');
	}
	const url = new URL(window.location.href);
	if (url.searchParams.has('error')) {
		window.location.replace(fromLocalStorage('redirect_uri') || '/');
		return;
	}
	const code = url.searchParams.get('code');
	if (!code) {
		throw new Error('No code');
	}
	const response = await fetch('https://accounts.spotify.com/api/token', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded'
		},
		body: new URLSearchParams({
			client_id: CONFIG.client_id,
			grant_type: 'authorization_code',
			code: code,
			redirect_uri: window.location.origin + CONFIG.redirect_endpoint,
			code_verifier: code_verifier
		})
	});
	const body = await response.json();
	if (response.status != 200) {
		throw new Error('Failed to fetch access token');
	}
	const access_token = body.access_token;
	const refresh_token = body.refresh_token;
	const scope = body.scope;
	if (!access_token || !refresh_token || !scope) {
		throw new Error('Reponse did not contain access token, refresh or scope token');
	}
	const expires_at = Date.now() + 1000 * body.expires_in;
	const scopes = scope.split(' ');
	toLocalStorage('access_token', access_token);
	toLocalStorage('expires_at', expires_at.toString());
	toLocalStorage('refresh_token', refresh_token);
	toLocalStorage('scopes', JSON.stringify(scopes));
	window.location.replace(fromLocalStorage('redirect_uri') || '/');
};

export const isLoggedIn = async (): Promise<boolean> => {
	return (await getAccessToken()) !== null;
};

export class AuthorizationError extends Error {
	constructor(message: string) {
		super(message);
	}
}

export class RateLimitError extends Error {
	constructor(message: string) {
		super(message);
	}
}

export const authorizedRequest: MakeRequest = async <T>(
	url: string,
	method: 'GET' | 'POST' | 'PUT' | 'DELETE',
	handle_response: (response: Response) => Promise<T>,
	content_type?: string,
	body?: string
): Promise<T> => {
	const access_token = await getAccessToken();
	if (!access_token) {
		throw new AuthorizationError('no access token');
	}
	let headers: { Authorization: string; 'Content-Type'?: string } = {
		Authorization: `Bearer ${access_token}`
	};
	if (content_type) {
		headers['Content-Type'] = content_type;
	}
	const response = await fetch(url, {
		method: method,
		headers: headers,
		body: body
	});
	if (response.status == 429) {
		const retry_after = Number(response.headers.get('Retry-After'));
		if (retry_after && retry_after < 60) {
			await new Promise((resolve) => setTimeout(resolve, retry_after * 1000));
			return await authorizedRequest(url, method, handle_response, content_type, body);
		} else {
			throw new RateLimitError('Rate limit exceeded');
		}
	}
	return await handle_response(response);
};

const getAccessToken = async (): Promise<string | null> => {
	const access_token = fromLocalStorage('access_token');
	const expires_at = fromLocalStorage('expires_at');
	if (access_token && expires_at && Date.now() < Number(expires_at)) {
		return access_token;
	}
	return await refreshAccessToken();
};

export const getScopes = (): string[] => {
	const scopes = fromLocalStorage('scopes');
	if (!scopes) {
		return [];
	}
	return JSON.parse(scopes);
};

export const logout = () => {
	removeFromLocalStorage('access_token');
	removeFromLocalStorage('expires_at');
	removeFromLocalStorage('refresh_token');
	removeFromLocalStorage('scopes');
	removeFromLocalStorage('code_verifier');
	removeFromLocalStorage('redirect_uri');
};

const toLocalStorage = (key: string, value: string) => {
	if (!browser) {
		return;
	}
	localStorage.setItem(LOCAL_STORAGE_PREFIX + key, value);
};

const fromLocalStorage = (key: string): string | null => {
	if (!browser) {
		return null;
	}
	return localStorage.getItem(LOCAL_STORAGE_PREFIX + key);
};

const removeFromLocalStorage = (key: string) => {
	if (!browser) {
		return;
	}
	localStorage.removeItem(LOCAL_STORAGE_PREFIX + key);
};

const generateRandomString = (length: number) => {
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	const values = crypto.getRandomValues(new Uint8Array(length));
	return values.reduce((acc, x) => acc + possible[x % possible.length], '');
};

const sha256 = async (plain: string): Promise<ArrayBuffer> => {
	const encoder = new TextEncoder();
	const data = encoder.encode(plain);
	return crypto.subtle.digest('SHA-256', data);
};

const base64Encode = (input: ArrayBuffer) => {
	return btoa(String.fromCharCode(...new Uint8Array(input)))
		.replace(/=/g, '')
		.replace(/\+/g, '-')
		.replace(/\//g, '_');
};

const refreshAccessToken = async (): Promise<string | null> => {
	const refresh_token = fromLocalStorage('refresh_token') as string;
	if (!refresh_token) {
		return null;
	}
	const url = 'https://accounts.spotify.com/api/token';
	const payload = {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded'
		},
		body: new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: refresh_token,
			client_id: CONFIG.client_id
		})
	};
	const response = await fetch(url, payload);
	if (response.status != 200) {
		return null;
	}
	const body = await response.json();
	const expires_at = Date.now() + 1000 * body.expires_in;
	toLocalStorage('access_token', body.access_token);
	toLocalStorage('expires_at', expires_at.toString());
	if (body.refresh_token) {
		toLocalStorage('refresh_token', body.refresh_token);
	}
	return body.access_token;
};
