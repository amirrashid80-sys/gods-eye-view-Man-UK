import {
  TransitFeedShapeError,
  buildTransitSnapshot,
  transitResponseHeaders,
} from '../../src/data/transitProxy.js';

/**
 * Bus Open Data Service (BODS) GTFS-Realtime proxy — England-wide bus AVL,
 * bounded to a Greater Manchester box.
 *
 * Upstream: https://data.bus-data.dft.gov.uk/api/v1/gtfsrtdatafeed/
 *   ?api_key=<BODS_API_KEY>&boundingBox=minLon,minLat,maxLon,maxLat
 *
 * Deliberately NOT a `src/data/transitFeeds.js` entry: that registry is
 * bundled into the browser (its own docstring: "imported by the browser
 * layer") and its admission rule is "no key, token, or registration
 * required" — enforced by transitFeeds.test.mjs, which greps every URL for
 * `key=`. BODS's key is a query parameter, so it must never reach that file,
 * and must never be logged — every warning below carries only the endpoint
 * path, never the querystring.
 *
 * FULL_DATASET confirmed by hand against the real feed (2026-09-20, ~235 KB
 * / ~1550 vehicles for the Greater Manchester box) before this proxy was
 * written; `buildTransitSnapshot` (shared with the keyless registry's proxy)
 * still checks it on every fetch and refuses a differential feed rather than
 * render one as if it were complete.
 *
 * The bounding box is a server-side constant, not a request parameter: the
 * browser never supplies an upstream URL or any part of one (SECURITY.md).
 *
 * Routes:
 *   GET /api/transit-bods/vehicles → decoded snapshot as JSON (same shape as
 *     the keyless transit proxy's per-feed snapshot)
 *   GET /api/transit-bods/status   → {hasKey, lastFetch, count, stale, ttlMs}
 *
 * Keyless (no BODS_API_KEY): both routes answer without contacting BODS —
 * vehicles 503s {error:'no_key'}, status reports {hasKey:false}.
 *
 * Also reachable from the voice/LLM mobility tool (src/tools/queries/
 * mobility.js): server/providers/transit.js appends this feed's catalog
 * entry to `/api/transit/feeds` whenever BODS_API_KEY is configured, so
 * `getFeeds()` → `requestSnapshot()` finds it the same way it finds any
 * registry feed.
 *
 * @returns {import('vite').Plugin}
 */
export function bodsTransitProxy() {
  const FEED_ID = 'bods-greater-manchester';
  const FEED_NAME = 'Bus Open Data Service — Greater Manchester';
  const TTL_MS = 15_000;
  const STALE_MAX_MS = 10 * 60_000;
  const TIMEOUT_MS = 20_000;
  const MAX_BODY_BYTES = 4 * 1024 * 1024;
  const BODS_URL = 'https://data.bus-data.dft.gov.uk/api/v1/gtfsrtdatafeed/';
  // minLon,minLat,maxLon,maxLat — Wigan/Bolton/Bury/Rochdale/Oldham/
  // Tameside/Stockport/Trafford, with a small buffer past each edge.
  const GREATER_MANCHESTER_BBOX = '-2.80,53.30,-1.90,53.70';

  /** @type {?{at:number, body:string}} */
  let cache = null;
  /** @type {?Promise<{at:number, body:string}>} */
  let inflight = null;

  const apiKey = () => String(process.env.BODS_API_KEY || '').trim();
  // buildTransitSnapshot only reads `feed.id`/`feed.name` — passing this
  // literal inherits its differential-feed refusal and timestamp repair for
  // free, same guards the keyless registry's feeds get.
  const FEED_LITERAL = Object.freeze({ id: FEED_ID, name: FEED_NAME });

  async function refresh(key) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const url = `${BODS_URL}?api_key=${encodeURIComponent(key)}&boundingBox=${GREATER_MANCHESTER_BBOX}`;
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent':
            'gods-eye-view-transit-proxy/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)',
        },
      });
      // Never interpolate `url` into a log line — it carries the API key.
      if (!res.ok) throw new Error(`upstream HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_BODY_BYTES) {
        throw new Error(`upstream body too large (${buf.byteLength} bytes)`);
      }
      const now = Date.now();
      const snapshot = buildTransitSnapshot(
        FEED_LITERAL,
        new Uint8Array(buf),
        now,
      );
      const entry = { at: now, body: JSON.stringify(snapshot) };
      cache = entry;
      return entry;
    } finally {
      clearTimeout(timeout);
    }
  }

  // Safe to expose — no key, just the upstream's hostname (the same thing
  // the keyless transit proxy puts in X-Transit-Upstream for every feed).
  const UPSTREAM_HOST = 'data.bus-data.dft.gov.uk';

  const installMiddleware = (server) => {
    server.middlewares.use('/api/transit-bods', async (req, res) => {
      const sendJson = (status, obj) => {
        if (res.headersSent) return;
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(obj));
      };
      const sendSnapshot = (cacheState, body, contactedAt) => {
        if (res.headersSent) return;
        res.writeHead(
          200,
          transitResponseHeaders(cacheState, UPSTREAM_HOST, contactedAt),
        );
        res.end(body);
      };
      try {
        const subPath = String(req.url || '').split('?')[0];
        const key = apiKey();

        if (subPath === '/status' || subPath === '/status/') {
          sendJson(200, {
            hasKey: Boolean(key),
            lastFetch: cache ? cache.at : null,
            stale: cache ? Date.now() - cache.at >= TTL_MS : false,
            ttlMs: TTL_MS,
          });
          return;
        }

        if (subPath !== '/vehicles' && subPath !== '/vehicles/') {
          sendJson(404, { error: 'Unknown transit-bods route' });
          return;
        }

        if (!key) {
          sendJson(503, { error: 'no_key' });
          return;
        }

        const now = Date.now();
        if (cache && now - cache.at < TTL_MS) {
          sendSnapshot('HIT', cache.body, cache.at);
          return;
        }

        if (!inflight) {
          inflight = refresh(key)
            .catch((err) => {
              const differential = err instanceof TransitFeedShapeError;
              if (differential) cache = null; // shape fault condemns any cached copy
              console.warn(
                `[transit-bods-proxy] refresh failed: ${err?.message || err}`,
              );
              return null;
            })
            .finally(() => {
              inflight = null;
            });
        }
        const fresh = await inflight;
        if (fresh) {
          sendSnapshot('MISS', fresh.body, fresh.at);
          return;
        }
        if (cache && now - cache.at < STALE_MAX_MS) {
          sendSnapshot('STALE-ERROR', cache.body, cache.at);
          return;
        }
        sendJson(502, {
          error: 'Transit feed unavailable',
          feedId: FEED_ID,
          retryInSec: Math.ceil(TTL_MS / 1000),
        });
      } catch (err) {
        console.warn('[transit-bods-proxy] error:', err?.message || err);
        sendJson(500, { error: 'transit-bods proxy error' });
      }
    });
  };

  return {
    name: 'transit-bods-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
