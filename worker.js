// Cloudflare Worker untuk PyApp
// Secret/Variable yang harus diset: GH_TOKEN, REPO (contoh "yogacihuy/pyapp-builds"),
// FIREBASE_API_KEY, ALLOWED_ORIGIN (contoh "https://yogacihuy.github.io")

const gh = (env, path, init = {}) =>
  fetch('https://api.github.com/repos/' + env.REPO + path, {
    ...init,
    headers: {
      Authorization: 'Bearer ' + env.GH_TOKEN,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'pyapp-worker',
      ...(init.headers || {}),
    },
  });

function cors(env, res) {
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', env.ALLOWED_ORIGIN);
  h.set('Access-Control-Allow-Headers', 'Authorization');
  h.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  return new Response(res.body, { status: res.status, headers: h });
}

async function verify(env, request) {
  const token = (request.headers.get('Authorization') || '').replace('Bearer ', '');
  if (!token) return null;
  const r = await fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + env.FIREBASE_API_KEY,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: token }) }
  );
  if (!r.ok) return null;
  return (await r.json()).users?.[0]?.localId || null;
}

function toBase64(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

async function handle(request, env) {
  const url = new URL(request.url);

  if (request.method === 'POST' && url.pathname === '/build') {
    if (!(await verify(env, request))) return new Response('Belum login', { status: 401 });
    const fd = await request.formData();
    const zip = fd.get('zip');
    const entry = String(fd.get('entry') || '');
    const target = fd.get('target') === 'apk' ? 'apk' : 'exe';
    if (!zip || !/^[\w\-./]+\.py$/.test(entry) || entry.includes('..'))
      return new Response('Data tidak valid', { status: 400 });
    const id = crypto.randomUUID().slice(0, 8);

    const put = await gh(env, `/contents/jobs/${id}/src.zip`, {
      method: 'PUT',
      body: JSON.stringify({ message: 'job ' + id, content: toBase64(await zip.arrayBuffer()) }),
    });
    if (!put.ok) return new Response('Gagal menyimpan ke repo', { status: 502 });

    const run = await gh(env, '/actions/workflows/build.yml/dispatches', {
      method: 'POST',
      body: JSON.stringify({ ref: 'main', inputs: { id, entry, target } }),
    });
    if (!run.ok) return new Response('Gagal memulai build', { status: 502 });
    return Response.json({ id });
  }

  const m = url.pathname.match(/^\/status\/([a-f0-9-]{8})$/);
  if (request.method === 'GET' && m) {
    const id = m[1];
    const ok = await gh(env, '/releases/tags/job-' + id);
    if (ok.ok) {
      const rel = await ok.json();
      const asset = rel.assets?.find((a) => /^app\.(exe|apk)$/.test(a.name));
      if (asset) return Response.json({ state: 'done', url: asset.browser_download_url });
    }
    const bad = await gh(env, '/releases/tags/fail-' + id);
    if (bad.ok) return Response.json({ state: 'failed', reason: (await bad.json()).body || '' });
    return Response.json({ state: 'building' });
  }

  return new Response('Not found', { status: 404 });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return cors(env, new Response(null, { status: 204 }));
    try {
      return cors(env, await handle(request, env));
    } catch (e) {
      return cors(env, new Response('Error server', { status: 500 }));
    }
  },
};
