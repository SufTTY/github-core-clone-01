// The forge's HTTP surface: git smart HTTP, REST v3, GraphQL v4 and MCP, all on one store.
//
//   GET  /healthz                     the env's boot probe
//   GET  /api/v3/...                  GitHub REST v3
//   POST /api/graphql                 GitHub GraphQL v4
//   POST /mcp                         Model Context Protocol (streamable HTTP)
//   *    /{owner}/{repo}.git/...      git smart HTTP (upload-pack v2/v0, receive-pack v0)
//
// Every REST reply is JSON with an X-GitHub-Request-Id; a missing or wrong bearer token is 401 and
// a repository belongs to the token's login, so another owner's name is 404.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, VIEWER_LOGIN } from './src/store.ts';
import { handleRest, type Reply } from './src/rest.ts';
import { handleGraphQL } from './src/gql.ts';
import { handleMcp } from './src/mcp.ts';
import { handleGitRequest, parseGitPath } from './src/githttp.ts';

const store = new Store();

function send(res: ServerResponse, status: number, contentType: string, body: Buffer | string, headers: Readonly<Record<string, string>> = {}): void {
  const payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': payload.length,
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function sendRest(res: ServerResponse, reply: Reply): void {
  if (reply.empty || reply.body === null) {
    res.writeHead(reply.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(reply.headers ?? {}) });
    res.end();
    return;
  }
  send(res, reply.status, 'application/json; charset=utf-8', `${JSON.stringify(reply.body)}\n`, reply.headers);
}

function readBody(req: IncomingMessage, limit = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function tokenOf(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : undefined;
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://forge');
      } catch {
        send(res, 400, 'application/json; charset=utf-8', '{"message":"Problems parsing JSON"}');
        return;
      }
      const method = req.method ?? 'GET';
      const path = url.pathname;
      const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
      const presented = tokenOf(req);
      const authed = expectedToken === '' ? presented !== undefined : presented === expectedToken;

      // The env's boot probe: no auth.
      if (method === 'GET' && (path === '/healthz' || path === '/healthz/')) {
        send(res, 200, 'application/json; charset=utf-8', '{"ok":true}');
        return;
      }

      // Git smart HTTP.
      const git = parseGitPath(path);
      if (git) {
        const suffix = path.slice(`/${git.owner}/${git.repo}.git`.length) || '/';
        let body = Buffer.alloc(0);
        if (method === 'POST') {
          try {
            body = await readBody(req);
          } catch {
            send(res, 400, 'application/json; charset=utf-8', '{"message":"Problems reading the request body"}');
            return;
          }
        }
        if (!authed) {
          send(res, 401, 'application/json; charset=utf-8', '{"message":"Requires authentication"}', { 'www-authenticate': 'Basic realm="forge"' });
          return;
        }
        const reply = handleGitRequest(store, git, method, suffix, url.searchParams, req.headers['git-protocol'] as string | null ?? null, body);
        send(res, reply.status, reply.contentType, reply.body, reply.headers ?? {});
        return;
      }

      // GraphQL.
      if (path === '/api/graphql' || path === '/api/graphql/') {
        if (method !== 'POST') {
          send(res, 404, 'application/json; charset=utf-8', '{"message":"Not Found"}', { 'x-github-request-id': '1' });
          return;
        }
        let raw = '';
        try {
          raw = (await readBody(req)).toString('utf8');
        } catch {
          raw = '';
        }
        const result = handleGraphQL(store, raw, authed);
        send(res, result.status, 'application/json; charset=utf-8', JSON.stringify(result.body), { 'x-github-request-id': '1' });
        return;
      }

      // MCP.
      if (path === '/mcp' || path === '/mcp/') {
        if (method === 'GET') {
          send(res, 405, 'application/json; charset=utf-8', '{"message":"Method Not Allowed"}');
          return;
        }
        let raw = '';
        try {
          raw = (await readBody(req)).toString('utf8');
        } catch {
          raw = '';
        }
        const hasAuthHeader = typeof req.headers.authorization === 'string';
        const reply = handleMcp(store, raw, authed, hasAuthHeader);
        send(res, reply.status, reply.contentType, reply.body);
        return;
      }

      // REST v3.
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        let raw: string | undefined;
        if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
          try {
            raw = (await readBody(req)).toString('utf8');
          } catch {
            raw = '';
          }
        }
        const origin = `${(req.headers['x-forwarded-proto'] as string | undefined) ?? 'http'}://${req.headers.host ?? 'localhost'}`;
        const reply = handleRest(store, url, method, raw, authed, origin);
        sendRest(res, reply);
        return;
      }

      send(res, 404, 'application/json; charset=utf-8', '{"message":"Not Found"}');
    })().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      try {
        if (!res.headersSent) send(res, 500, 'application/json; charset=utf-8', JSON.stringify({ message: `internal error: ${message}` }));
      } catch {
        // the socket is already gone
      }
    });
  });
}