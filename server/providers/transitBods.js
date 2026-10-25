import {
  TransitFeedShapeError,
  buildTransitSnapshot,
  transitResponseHeaders,
} from '../../src/data/transitProxy.js';

/**
 * Bus Open Data Service (BODS) GTFS-Realtime proxy — England-wide bus AVL,
 * served per metro area rather than as one nationwide feed.
 *
 * Upstream: https://data.bus-data.dft.gov.uk/api/v1/gtfsrtdatafeed/
 *   ?api_key=<BODS_API_KEY>&boundingBox=minLon,minLat,maxLon,maxLat
 *
 * One nationwide bbox was measured (2026-10-25) at ~21,000 vehicles — over
 * `MAX_VEHICLES_TOTAL` (15,000, src/layers/transit/policy.js), the app's
 * GLOBAL vehicle-rendering cap shared by every active transit feed at once.
 * Past that cap `ingestion.js` silently drops whatever vehicle didn't fit,
 * in arrival order, not by distance to camera — not a usable feature. REGIONS
 * below are per-metro boxes instead (same model the keyless registry already
 * uses for every other feed: one coverage circle per city, not one circle
 * for a whole country), each comfortably within the cap on its own and all
 * three together.
 *
 * Deliberately NOT `src/data/transitFeeds.js` entries: that registry is
 * bundled into the browser (its own docstring: "imported by the browser
 * layer") and its admission rule is "no key, token, or registration
 * required" — enforced by transitFeeds.test.mjs, which greps every URL for
 * `key=`. BODS's key is a query parameter, so it must never reach that file,
 * and must never be logged — every warning below carries only the endpoint
 * path, never the querystring.
 *
 * FULL_DATASET confirmed by hand against the real feed for all three boxes
 * (2026-09-20 Manchester, 2026-10-25 Birmingham/Leeds) before this proxy was
 * written; `buildTransitSnapshot` (shared with the keyless registry's proxy)
 * still checks it on every fetch and refuses a differential feed rather than
 * render one as if it were complete.
 *
 * Each bounding box is a server-side constant, not a request parameter: the
 * browser never supplies an upstream URL or any part of one (SECURITY.md).
 *
 * Routes:
 *   GET /api/transit-bods/vehicles/<regionId> → decoded snapshot as JSON
 *     (same shape as the keyless transit proxy's per-feed snapshot)
 *   GET /api/transit-bods/status → {hasKey, regions:[{id,lastFetch,stale,ttlMs}]}
 *
 * Keyless (no BODS_API_KEY): vehicles 503s {error:'no_key'} for every
 * region; status reports {hasKey:false}.
 *
 * Also reachable from the voice/LLM mobility tool (src/tools/queries/
 * mobility.js): server/providers/transit.js appends each region's catalog
 * entry to `/api/transit/feeds` whenever BODS_API_KEY is configured, so
 * `getFeeds()` → `requestSnapshot()` finds them the same way it finds any
 * registry feed.
 *
 * @returns {import('vite').Plugin}
 */
export function bodsTransitProxy() {
  const TTL_MS = 15_000;
  const STALE_MAX_MS = 10 * 60_000;
  const TIMEOUT_MS = 20_000;
  const MAX_BODY_BYTES = 8 * 1024 * 1024;
  const BODS_URL = 'https://data.bus-data.dft.gov.uk/api/v1/gtfsrtdatafeed/';

  /**
   * One entry per metro area. `id` matches the `TRANSIT_BYOK_FEEDS` entry
   * in src/data/transitFeeds.js — keep the two in sync by hand; there is no
   * shared source because that file is browser-bundled and must never carry
   * these bounding boxes' significance as "the real upstream query", only
   * client-safe coverage metadata.
   */
  const REGIONS = Object.freeze([
    {
      id: 'bods-greater-manchester',
      name: 'Bus Open Data Service — Greater Manchester',
      // minLon,minLat,maxLon,maxLat — Wigan/Bolton/Bury/Rochdale/Oldham/
      // Tameside/Stockport/Trafford, with a small buffer past each edge.
      bbox: '-2.80,53.30,-1.90,53.70',
    },
    {
      id: 'bods-birmingham',
      name: 'Bus Open Data Service — Birmingham',
      // Wolverhampton/Walsall/Dudley/Solihull, to the Coventry edge.
      bbox: '-2.30,52.30,-1.40,52.70',
    },
    {
      id: 'bods-leeds',
      name: 'Bus Open Data Service — Leeds',
      // Bradford/Wakefield/Huddersfield.
      bbox: '-2.00,53.60,-1.10,53.95',
    },
  ]);
  const REGION_BY_ID = new Map(REGIONS.map((region) => [region.id, region]));

  /** @type {Map<string, {at:number, body:string}>} regionId → cache entry */
  const cache = new Map();
  /** @type {Map<string, Promise<{at:number, body:string}>>} regionId → in-flight refresh */
  const inflight = new Map();

  const apiKey = () => String(process.env.BODS_API_KEY || '').trim();

  async function refresh(region, key) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const url = `${BODS_URL}?api_key=${encodeURIComponent(key)}&boundingBox=${region.bbox}`;
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
      // buildTransitSnapshot only reads `feed.id`/`feed.name` — passing this
      // literal inherits its differential-feed refusal and timestamp repair
      // for free, same guards the keyless registry's feeds get.
      const snapshot = buildTransitSnapshot(
        { id: region.id, name: region.name },
        new Uint8Array(buf),
        now,
      );
      const entry = { at: now, body: JSON.stringify(snapshot) };
      cache.set(region.id, entry);
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
          const now = Date.now();
          sendJson(200, {
            hasKey: Boolean(key),
            ttlMs: TTL_MS,
            regions: REGIONS.map((region) => {
              const entry = cache.get(region.id);
              return {
                id: region.id,
                lastFetch: entry ? entry.at : null,
                stale: entry ? now - entry.at >= TTL_MS : false,
              };
            }),
          });
          return;
        }

        const match = /^\/vehicles\/([^/]+)\/?$/.exec(subPath);
        const region = match ? REGION_BY_ID.get(match[1]) : null;
        if (!region) {
          sendJson(404, { error: 'Unknown transit-bods route' });
          return;
        }

        if (!key) {
          sendJson(503, { error: 'no_key' });
          return;
        }

        const now = Date.now();
        const cached = cache.get(region.id);
        if (cached && now - cached.at < TTL_MS) {
          sendSnapshot('HIT', cached.body, cached.at);
          return;
        }

        let pending = inflight.get(region.id);
        if (!pending) {
          pending = refresh(region, key)
            .catch((err) => {
              const differential = err instanceof TransitFeedShapeError;
              if (differential) cache.delete(region.id); // shape fault condemns any cached copy
              console.warn(
                `[transit-bods-proxy] ${region.id} refresh failed: ${err?.message || err}`,
              );
              return null;
            })
            .finally(() => {
              inflight.delete(region.id);
            });
          inflight.set(region.id, pending);
        }
        const fresh = await pending;
        if (fresh) {
          sendSnapshot('MISS', fresh.body, fresh.at);
          return;
        }
        const stillCached = cache.get(region.id);
        if (stillCached && now - stillCached.at < STALE_MAX_MS) {
          sendSnapshot('STALE-ERROR', stillCached.body, stillCached.at);
          return;
        }
        sendJson(502, {
          error: 'Transit feed unavailable',
          feedId: region.id,
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
