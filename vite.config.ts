import react from '@vitejs/plugin-react';
import { defineConfig, type Connect, type Plugin } from 'vite';

const FETCH_PROXY_PATH = '/__fetch';
const DEFAULT_PROXY_TIMEOUT_MS = 12_000;

function createFetchProxyMiddleware(): Connect.NextHandleFunction {
  return async (req, res, next) => {
    if (!req.url) {
      next();
      return;
    }

    const requestUrl = new URL(req.url, 'http://localhost');
    if (requestUrl.pathname !== FETCH_PROXY_PATH) {
      next();
      return;
    }

    if (req.method !== 'GET') {
      res.statusCode = 405;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    const targetUrl = requestUrl.searchParams.get('url')?.trim();
    const timeoutParam = Number(requestUrl.searchParams.get('timeoutMs') ?? '');
    const timeoutMs = Number.isFinite(timeoutParam) && timeoutParam > 0
      ? Math.min(timeoutParam, 30_000)
      : DEFAULT_PROXY_TIMEOUT_MS;

    if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'A valid http(s) url query param is required.' }));
      return;
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(new Error('Proxy timed out')), timeoutMs);

    try {
      const upstream = await fetch(targetUrl, {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,text/plain;q=0.7,*/*;q=0.5',
          'accept-language': 'en-US,en;q=0.9',
          'cache-control': 'no-cache',
          pragma: 'no-cache',
        },
      });

      const body = await upstream.text();
      res.statusCode = upstream.status;
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Codex-Fetch-Proxy', 'vite');
      res.setHeader('X-Proxied-Url', targetUrl);
      res.setHeader('X-Final-Url', upstream.url);

      const contentType = upstream.headers.get('content-type');
      if (contentType) {
        res.setHeader('Content-Type', contentType);
      } else {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      }

      res.end(body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: message, url: targetUrl }));
    } finally {
      clearTimeout(timeoutHandle);
    }
  };
}

function localFetchProxyPlugin(): Plugin {
  const middleware = createFetchProxyMiddleware();
  return {
    name: 'local-fetch-proxy',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

export default defineConfig({
  plugins: [react(), localFetchProxyPlugin()],
  assetsInclude: ['**/*.md'],
});
