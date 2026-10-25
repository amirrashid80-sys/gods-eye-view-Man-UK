import { createTransitService } from '../../src/sources/transitService.js';
import { TRANSIT_BYOK_FEEDS } from '../../src/data/transitFeeds.js';
export { fetchTransitFeed } from '../../src/sources/transitService.js';

/**
 * BYOK catalog entries whose env key is actually configured, in exactly
 * `publicTransitCatalog()`'s shape (src/data/transitFeeds.js) — never a
 * `url` or `headers`, same rule the keyless catalog follows. A feed is only
 * offered here when its `/api/transit-bods/vehicles/<id>`-style route would
 * actually answer with data rather than 503 `no_key`, so this list and what
 * a caller can successfully poll stay in sync. All three BODS regions share
 * one key; a future non-BODS BYOK provider would need its own id-prefixed
 * gate here rather than reusing this one.
 * @returns {object[]}
 */
function configuredByokFeeds() {
  if (!String(process.env.BODS_API_KEY || '').trim()) return [];
  return TRANSIT_BYOK_FEEDS.filter((feed) => feed.id.startsWith('bods-')).map(
    (feed) => ({
      id: feed.id,
      name: feed.name,
      operator: feed.operator,
      region: feed.region,
      center: { ...feed.center },
      loadRadiusKm: feed.loadRadiusKm,
      license: feed.license,
      licenseUrl: feed.licenseUrl,
      attribution: feed.attribution,
      historyRetention: feed.historyRetention === true,
    }),
  );
}

/** Connect the reusable transit request service to development and preview. */
export function transitProxy(options = {}) {
  const service = createTransitService(options);
  function install(server) {
    server.middlewares.use('/api/transit', async (req, res) => {
      const response = await service.handle({
        url: `http://localhost/api/transit${req.url || '/'}`,
        method: req.method,
      });
      const isFeedsRoute = /^\/feeds\/?(?:\?|$)/.test(req.url || '/');
      if (isFeedsRoute && response.status === 200) {
        const byok = configuredByokFeeds();
        if (byok.length) {
          const body = JSON.parse(await response.text());
          body.feeds = [...(body.feeds || []), ...byok];
          res.writeHead(response.status, Object.fromEntries(response.headers));
          res.end(JSON.stringify(body));
          return;
        }
      }
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
    });
    server.httpServer?.once('close', service.close);
  }
  return {
    name: 'transit-proxy',
    closeBundle: service.close,
    configureServer: install,
    configurePreviewServer: install,
  };
}
