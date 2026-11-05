// GIF search for Watchroom. Holds the GIPHY key as a secret, so it never ships inside the app.
const HEADERS = { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=300' };
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const bare = (url) => String(url || '').split('?')[0];

export default {
  async fetch(request, env) {
    if (!env.GIPHY_KEY) return reply({ error: 'not-configured' }, 503);
    const q = new URL(request.url).searchParams.get('q')?.trim().slice(0, 80);
    const params = new URLSearchParams({ api_key: env.GIPHY_KEY, limit: '24', rating: 'pg-13' });
    if (q) params.set('q', q);
    const res = await fetch(`https://api.giphy.com/v1/gifs/${q ? 'search' : 'trending'}?${params}`);
    if (!res.ok) return reply({ error: 'upstream' }, 502);
    const { data = [] } = await res.json();
    return reply({
      gifs: data.map((g) => ({
        url: bare(g.images?.fixed_width?.url),
        preview: bare(g.images?.fixed_width_small?.url || g.images?.fixed_width?.url),
        title: String(g.title || 'GIF').slice(0, 80),
      })),
    });
  },
};
