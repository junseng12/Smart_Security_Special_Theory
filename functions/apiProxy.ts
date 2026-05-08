/**
 * SmartCity Payment API Proxy
 * Base44 프론트 → 이 함수 → Railway 백엔드 API
 * 
 * 사용법: POST /functions/apiProxy
 * body: { path: "/api/v1/sessions/start", method: "POST", body: {...} }
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const BACKEND_URL = Deno.env.get('SMARTCITY_BACKEND_URL') || '';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!BACKEND_URL) {
      return Response.json({ error: 'SMARTCITY_BACKEND_URL not configured' }, { status: 500 });
    }

    const { path, method = 'GET', body } = await req.json().catch(() => ({}));

    if (!path) {
      return Response.json({ error: 'path is required' }, { status: 400 });
    }

    const targetUrl = `${BACKEND_URL}${path}`;

    const fetchOptions: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-User-Address': user.email || '',
        'X-Base44-User-Id': user.id || '',
      },
    };

    if (body && method !== 'GET') {
      fetchOptions.body = JSON.stringify(body);
    }

    const response = await fetch(targetUrl, fetchOptions);
    const data = await response.json().catch(() => ({}));

    return Response.json(data, { status: response.status });

  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
