// Example Agent Canvas plugin. Copy this folder to ~/.agent-canvas/plugins/,
// click Reload on the Plugins page, and turn it on. See docs/plugins.md.

async function headers(ctx) {
  const token = await ctx.secret('token');
  return { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

function toItem(repo, r) {
  return {
    id: String(r.id),
    kind: 'article',
    title: `${repo} ${r.name || r.tag_name}`,
    text: r.body || undefined,
    url: r.html_url,
    author: r.author && r.author.login,
    publishedAt: r.published_at,
    metrics: { likes: r.reactions ? r.reactions.total_count : undefined },
    tags: r.prerelease ? ['pre-release'] : [],
    extra: { repo, tag: r.tag_name },
  };
}

module.exports = {
  sources: {
    // config: the values of the fields in plugin.json; ctx: fetch helpers, secrets, log, state.
    async releases(config, ctx) {
      const items = [];
      for (const repo of config.repos) {
        try {
          const list = await ctx.json(`https://api.github.com/repos/${repo}/releases?per_page=20`, { headers: await headers(ctx) });
          for (const r of list) if (!r.draft && (config.prereleases || !r.prerelease)) items.push(toItem(repo, r));
        } catch (err) {
          ctx.log(`${repo}: ${err.message}`); // shown in the run log; other repos still count
        }
      }
      return { items };
    },
  },
  tools: {
    async github_latest_release(args, ctx) {
      const r = await ctx.json(`https://api.github.com/repos/${args.repo}/releases/latest`, { headers: await headers(ctx) });
      return `${args.repo} ${r.tag_name} (${String(r.published_at).slice(0, 10)})\n${r.html_url}\n\n${(r.body || '').slice(0, 4000)}`;
    },
  },
  async test(ctx) {
    const r = await ctx.json('https://api.github.com/rate_limit', { headers: await headers(ctx) });
    return `GitHub works: ${r.rate.remaining}/${r.rate.limit} requests left this hour.`;
  },
};
