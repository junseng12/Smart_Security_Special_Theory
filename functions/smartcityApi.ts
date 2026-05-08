export default async function handler(req: Request): Promise<Response> {
  const BACKEND = "https://smartcity-payment-backend-production.up.railway.app";

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  let reqBody: any = {};
  try {
    reqBody = await req.json();
  } catch {}

  const { path, method = "GET", body } = reqBody;

  if (!path) {
    return new Response(JSON.stringify({ error: "path is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  const targetUrl = `${BACKEND}${path}`;

  try {
    const res = await fetch(targetUrl, {
      method,
      headers: { "Content-Type": "application/json" },
      body: method !== "GET" && body ? JSON.stringify(body) : undefined,
    });

    const data = await res.text();
    return new Response(data, {
      status: res.status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
}
