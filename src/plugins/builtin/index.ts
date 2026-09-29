import { BuiltinPlugin } from '../api';
import { apifyPlugin } from './apify';
import { gtrendsPlugin } from './gtrends';
import { hackernewsPlugin } from './hackernews';
import { httpPlugin } from './http';
import { metaPlugin } from './meta';
import { redditPlugin } from './reddit';
import { rssPlugin } from './rss';
import { tiktokPlugin } from './tiktok';
import { webwatchPlugin } from './webwatch';
import { xPlugin } from './x';
import { youtubePlugin } from './youtube';

/** Shipped with the app, in palette order. */
export const BUILTIN_PLUGINS: BuiltinPlugin[] = [
  rssPlugin,
  gtrendsPlugin,
  redditPlugin,
  hackernewsPlugin,
  youtubePlugin,
  metaPlugin,
  tiktokPlugin,
  xPlugin,
  webwatchPlugin,
  httpPlugin,
  apifyPlugin,
];
