// One HTTP front door for the whole forge: git smart HTTP, REST v3, GraphQL v4 and MCP.
//
//   GET  /healthz                     the environment's boot probe
//   GET  /api/v3/...                  GitHub REST v3
//   POST /api/graphql                 GitHub GraphQL v4
//   POST /mcp                         Model Context Protocol (streamable HTTP)
//   *    /{owner}/{repo}.git/...      git smart HTTP (upload-pack v2/v0, receive-pack v0)
//
// Every REST reply is JSON carrying X-GitHub-Request-Id; a missing or wrong bearer token is 401
// and a repository belongs to the token's login, so another owner's name is 404.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, VIEWER_LOGIN } from './src/store.ts';
import { handleRest, type Reply } from './src/rest.ts';
import { handleGraphQL } from './src/gql.ts';
import { handleMcp } from './src/mcp.ts';
import { handleGitRequest, parseGitPath } from './src/githttp.ts';

const store = new Store();

/** Ship a reply: the caller picks the content type, no-store is always set. */
function emit(res: ServerResponse, status: number, contentType: string, body: Buffer | string, headers: Readonly<Record<string, string>> = {}): void {
  const payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': payload.length,
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

/** REST replies are either empty (204) or JSON with one trailing newline. */
function emitRest(res: ServerResponse, reply: Reply): void {
  if (reply.empty || reply.body === null) {
    res.writeHead(reply.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(reply.headers ?? {}) });
    res.end();
    return;
  }
  emit(res, reply.status, 'application/json; charset=utf-8', `${JSON.stringify(reply.body)}\n`, reply.headers);
}

/** Read a request body, refusing anything larger than `limit` bytes. */
function collectBody(req: IncomingMessage, limit = 64 * 1024 * 1024): Promise<Buffer> {
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

/** The bearer token of an Authorization header, when the header has that shape. */
function bearerOf(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : undefined;
}

/** Everything a route needs: the request, its parsed URL and the auth verdict. */
interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
  pathname: string;
  authed: boolean;
}

/** A route: does it claim this request, and how does it answer it? */
interface Route {
  matches(method: string, pathname: string): boolean;
  serve(): Promise<void>;
}

/** The router, in dispatch order: the first match answers, and the last one always matches. */
function routes(ctx: Ctx): Route[] {
  const { req, res, url, method, pathname, authed } = ctx;
  return [
    {
      matches: (m, p) => m === 'GET' && (p === '/healthz' || p === '/healthz/'),
      serve: async () => { emit(res, 200, 'application/json; charset=utf-8', '{"ok":true}'); },
    },
    {
      matches: (_m, p) => parseGitPath(p) !== undefined,
      serve: async () => {
        const git = parseGitPath(pathname)!;
        const suffix = pathname.slice(`/${git.owner}/${git.repo}.git`.length) || '/';
        let body = Buffer.alloc(0);
        if (method === 'POST') {
          try {
            body = await collectBody(req);
          } catch {
            emit(res, 400, 'application/json; charset=utf-8', '{"message":"Problems reading the request body"}');
            return;
          }
        }
        if (!authed) {
          emit(res, 401, 'application/json; charset=utf-8', '{"message":"Requires authentication"}', { 'www-authenticate': 'Basic realm="forge"' });
          return;
        }
        const reply = handleGitRequest(store, git, method, suffix, url.searchParams, req.headers['git-protocol'] as string | null ?? null, body);
        emit(res, reply.status, reply.contentType, reply.body, reply.headers ?? {});
      },
    },
    {
      matches: (_m, p) => p === '/api/graphql' || p === '/api/graphql/',
      serve: async () => {
        if (method !== 'POST') {
          emit(res, 404, 'application/json; charset=utf-8', '{"message":"Not Found"}', { 'x-github-request-id': '1' });
          return;
        }
        let raw = '';
        try {
          raw = (await collectBody(req)).toString('utf8');
        } catch {
          raw = '';
        }
        const result = handleGraphQL(store, raw, authed);
        emit(res, result.status, 'application/json; charset=utf-8', JSON.stringify(result.body), { 'x-github-request-id': '1' });
      },
    },
    {
      matches: (_m, p) => p === '/mcp' || p === '/mcp/',
      serve: async () => {
        if (method === 'GET') {
          emit(res, 405, 'application/json; charset=utf-8', '{"message":"Method Not Allowed"}');
          return;
        }
        let raw = '';
        try {
          raw = (await collectBody(req)).toString('utf8');
        } catch {
          raw = '';
        }
        const hasAuthHeader = typeof req.headers.authorization === 'string';
        const reply = handleMcp(store, raw, authed, hasAuthHeader);
        emit(res, reply.status, reply.contentType, reply.body);
      },
    },
    {
      matches: (_m, p) => p === '/api/v3' || p.startsWith('/api/v3/'),
      serve: async () => {
        let raw: string | undefined;
        if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
          try {
            raw = (await collectBody(req)).toString('utf8');
          } catch {
            raw = '';
          }
        }
        const origin = `${(req.headers['x-forwarded-proto'] as string | undefined) ?? 'http'}://${req.headers.host ?? 'localhost'}`;
        const reply = handleRest(store, url, method, raw, authed, origin);
        emitRest(res, reply);
      },
    },
    {
      matches: () => true,
      serve: async () => { emit(res, 404, 'application/json; charset=utf-8', '{"message":"Not Found"}'); },
    },
  ];
}

export function createApp(): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.socket.setNoDelay(true);
    void (async () => {
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://forge');
      } catch {
        emit(res, 400, 'application/json; charset=utf-8', '{"message":"Problems parsing JSON"}');
        return;
      }
      const method = req.method ?? 'GET';
      const pathname = url.pathname;
      const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
      const presented = bearerOf(req);
      const authed = expectedToken === '' ? presented !== undefined : presented === expectedToken;
      for (const route of routes({ req, res, url, method, pathname, authed })) {
        if (route.matches(method, pathname)) {
          await route.serve();
          return;
        }
      }
    })().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      try {
        if (!res.headersSent) emit(res, 500, 'application/json; charset=utf-8', JSON.stringify({ message: `internal error: ${message}` }));
      } catch {
        // the socket is already gone
      }
    });
  });
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  return server;
}
