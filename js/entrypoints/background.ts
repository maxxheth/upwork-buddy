import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import type { ApiProxyRequestMessage, ApiProxyResponseMessage } from '../src/api';

function isApiProxyRequest(message: unknown): message is ApiProxyRequestMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as Partial<ApiProxyRequestMessage>).type === 'API_PROXY_REQUEST' &&
    typeof (message as Partial<ApiProxyRequestMessage>).url === 'string'
  );
}

function encodeBytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function handleApiProxyRequest(
  req: ApiProxyRequestMessage,
): Promise<ApiProxyResponseMessage> {
  try {
    const response = await fetch(req.url, {
      method: req.method || 'GET',
      headers: req.headers,
      body: req.body,
    });
    const contentType = response.headers.get('content-type') ?? undefined;
    const buffer = await response.arrayBuffer();
    const bodyBase64 = buffer.byteLength > 0 ? encodeBytesToBase64(new Uint8Array(buffer)) : '';

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      contentType,
      bodyBase64,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      statusText: 'Network Error',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isApiProxyRequest(message)) {
      return undefined;
    }

    handleApiProxyRequest(message)
      .then((result) => sendResponse(result))
      .catch((error: unknown) => {
        sendResponse({
          ok: false,
          status: 0,
          statusText: 'Proxy Error',
          error: error instanceof Error ? error.message : String(error),
        } satisfies ApiProxyResponseMessage);
      });

    return true;
  });
});
