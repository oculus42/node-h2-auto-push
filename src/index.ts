import * as express from 'express';
import * as fs from 'fs';
import * as http2 from 'http2';
import * as path from 'path';

import {AssetCache, AssetCacheConfig} from './asset-cache';

export {AssetCacheConfig} from './asset-cache';

type Request = express.Request&http2.Http2ServerRequest;
type Response = express.Response&http2.Http2ServerResponse;

// TODO(jinwoo): Tune these default parameters.
const DEFAULT_CACHE_CONFIG: AssetCacheConfig = {
  warmupDuration: 500,
  promotionRatio: 0.8,
  demotionRatio: 0.2,
  minimumRequests: 1,
};

export class AutoPush {
  private readonly assetCache: AssetCache;

  constructor(cacheConfig: AssetCacheConfig = DEFAULT_CACHE_CONFIG) {
    this.assetCache = new AssetCache(cacheConfig);
  }

  static(root: string): express.RequestHandler {
    return (req: Request, res: Response, next: express.NextFunction): void => {
      const reqPath = req.path;
      const stream = req.stream;
      stream.respondWithFile(path.join(root, reqPath), undefined, {
        statCheck: (stats, headers) => {
          // Piggy-back on statCheck() to record this path as a static
          // resource.
          this.assetCache.recordRequestPath(stream.session, reqPath, true);

          const ifModifiedSinceHeader = req.headers['if-modified-since'];
          const ifModifiedSince = typeof ifModifiedSinceHeader === 'string' ?
              Date.parse(ifModifiedSinceHeader) :
              null;
          if (ifModifiedSince !== null &&
              stats.mtime.getTime() <= ifModifiedSince) {
            stream.respond({':status': 304});
            return false;
          }
          headers['cache-control'] = 'public, max-age=0';
          headers['last-modified'] = stats.mtime.toUTCString();
          return true;
        },
        onError: (err) => {
          // Not a valid file. Record this path as a non-static resource.
          this.assetCache.recordRequestPath(stream.session, reqPath, false);
          next();
        },
      });

      if (!stream.pushAllowed) return;

      ////// Auto-push related assets.

      // Do not auto-push more than the TCP congestion window (cwnd) size.
      // effectiveLocalWindowSize doesn't seem to reflect the actual network
      // status. But at least it gives some reasonable value we can use.
      // FIXME: The response size of the original request must also be
      // considered but there's no easy way to know that. Ignore for now.
      const windowSize = stream.session.state.effectiveLocalWindowSize;
      let pushedSize = 0;
      for (const asset of this.assetCache.getAssetsForPath(reqPath)) {
        if (windowSize && pushedSize > windowSize) break;
        stream.pushStream({':path': asset}, pushStream => {
          pushStream.respondWithFile(path.join(root, asset), undefined, {
            statCheck: (stats) => {
              if (windowSize && pushedSize + stats.size > windowSize) {
                pushStream.rstWithCancel();
                return false;
              }
              pushedSize += stats.size;
              return true;
            },
            onError: (err) => console.log(err),
          });
        });
      }
    };
  }
}
