// Shared request helpers for the Worker.

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function body(request) {
  try {
    const data = await request.json();
    if (data && typeof data === "object" && !Array.isArray(data)) return data;
  } catch {}
  throw new HttpError(400, "Request body must be a JSON object.");
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
