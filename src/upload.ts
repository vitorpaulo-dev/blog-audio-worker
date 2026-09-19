export async function uploadToPresignedUrl(
  url: string,
  body: Buffer,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(url, {
    method: "PUT",
    headers: {
      "Content-Type": "audio/mpeg",
      "Content-Length": String(body.length),
    },
    body: body,
  });
  if (!response.ok) {
    const detail = await safeText(response);
    throw new Error(`Upload to presigned URL failed: ${response.status} ${detail}`);
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 300);
  } catch {
    return "<unreadable>";
  }
}
