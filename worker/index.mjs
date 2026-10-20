// Watchroom relay login service, deployed on Cloudflare Workers.
// The app asks this service for short-lived TURN logins when it joins a room.
// The TURN key and its token stay here, in Cloudflare's secret storage. Nothing secret goes into the app.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Each login lasts one hour. The app asks again every time it joins a room.
const LOGIN_SECONDS = 3600;

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'GET') return new Response('Not found', { status: 404, headers: CORS });

    const response = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.TURN_KEY_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: LOGIN_SECONDS }),
      },
    );
    if (!response.ok) return new Response('Relay logins are unavailable', { status: 502, headers: CORS });

    const data = await response.json();
    return new Response(JSON.stringify({ iceServers: data.iceServers }), {
      headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  },
};
