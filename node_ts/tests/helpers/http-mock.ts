/**
 * HTTP-Mock-Server für Tests, die echte API-Calls simulieren.
 *
 * Verwendung:
 *   const mock = await startMockServer();
 *   mock.enqueue({ status: 201, body: { id: 1 } });
 *   // ... Test, der gegen mock.baseUrl postet
 *   await mock.stop();
 *
 * Features:
 *   - Queue für sequentielle Antworten (z. B. erst 500, dann 201)
 *   - Request-Log mit Method, URL, Headers, Body
 *   - Default-Antwort, falls Queue leer ist
 *   - `stop()` schließt Server und gibt Port frei
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Geloggter Request (das, was der Server empfangen hat).
 */
export interface LoggedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

/**
 * Geplante Antwort.
 */
export interface QueuedResponse {
  status: number;
  body?: object | string;
  headers?: Record<string, string>;
}

/**
 * Handle für den laufenden Mock-Server.
 */
export interface MockServer {
  /** Basis-URL inkl. Port, z. B. `http://127.0.0.1:12345` */
  baseUrl: string;
  /** Alle bisher empfangenen Requests in Reihenfolge */
  requests: LoggedRequest[];
  /** Plant eine zukünftige Antwort (wird beim nächsten Request konsumiert) */
  enqueue(response: QueuedResponse): void;
  /** Setzt die Default-Antwort für leere Queue (sonst 200 ohne Body) */
  setDefault(response: QueuedResponse): void;
  /** Schließt den Server */
  stop(): Promise<void>;
}

/**
 * Liest den kompletten Request-Body als String.
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/**
 * Startet einen lokalen HTTP-Mock-Server auf einem freien Port.
 */
export async function startMockServer(): Promise<MockServer> {
  const responseQueue: QueuedResponse[] = [];
  let defaultResponse: QueuedResponse = { status: 200, body: {} };
  const requests: LoggedRequest[] = [];

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const rawBody = await readBody(req);
    let parsedBody: unknown = rawBody;
    try {
      if (rawBody.length > 0) parsedBody = JSON.parse(rawBody);
    } catch {
      // nicht-JSON Body ist erlaubt; bleibt als String
    }

    requests.push({
      method: req.method ?? 'GET',
      url: req.url ?? '',
      headers: req.headers,
      body: parsedBody,
    });

    const response = responseQueue.shift() ?? defaultResponse;
    res.statusCode = response.status;
    res.setHeader('Content-Type', 'application/json');
    for (const [k, v] of Object.entries(response.headers ?? {})) {
      res.setHeader(k, v);
    }
    const responseBody =
      typeof response.body === 'string' ? response.body : JSON.stringify(response.body ?? {});
    res.end(responseBody);
  });

  // unref(), damit der Server das Test-Prozess-Ende nicht blockiert
  server.unref();

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    requests,
    enqueue(response) {
      responseQueue.push(response);
    },
    setDefault(response) {
      defaultResponse = response;
    },
    stop() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
