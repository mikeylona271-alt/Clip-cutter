const COMMANDS = [{
  name: 'clip', description: 'YouTube clip banao', type: 1,
  options: [
    {name:'link', description:'YouTube link', type:3, required:true},
    {name:'start', description:'Start time, jaise 10:00', type:3, required:true},
    {name:'end', description:'End time, jaise 11:00', type:3, required:true},
    {name:'quality', description:'Quality', type:3, required:false,
      choices:[{name:'720p',value:'720'},{name:'1080p',value:'1080'},{name:'1440p (2K)',value:'1440'},{name:'2160p (4K)',value:'2160'}]},
    {name:'short', description:'9:16 Short banao?', type:3, required:false,
      choices:[{name:'No',value:'no'},{name:'Yes',value:'yes'}]}
  ]
}];

const hex = h => new Uint8Array(h.match(/../g).map(b => parseInt(b, 16)));
const json = o => new Response(JSON.stringify(o), {headers:{'Content-Type':'application/json'}});

async function verify(req, body, env) {
  const sig = req.headers.get('x-signature-ed25519');
  const ts = req.headers.get('x-signature-timestamp');
  if (!sig || !ts) return false;
  const pk = (env.DISCORD_PUBLIC_KEY || '').trim();
  const data = new TextEncoder().encode(ts + body);
  for (const alg of [{name:'Ed25519'}, {name:'NODE-ED25519', namedCurve:'NODE-ED25519'}]) {
    try {
      const key = await crypto.subtle.importKey('raw', hex(pk), alg, false, ['verify']);
      return await crypto.subtle.verify(alg, key, hex(sig), data);
    } catch (e) {}
  }
  return false;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    if (url.pathname === '/debug') {
      return new Response('keylen=' + (env.DISCORD_PUBLIC_KEY || '').length);
    }

    if (req.method === 'GET' && url.pathname === '/register') {
      if (url.searchParams.get('k') !== env.REGISTER_KEY) return new Response('no', {status:403});
      const r = await fetch(`https://discord.com/api/v10/applications/${env.DISCORD_APP_ID}/commands`, {
        method:'PUT',
        headers:{Authorization:`Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type':'application/json'},
        body: JSON.stringify(COMMANDS)
      });
      return new Response(`Discord: ${r.status}\n` + await r.text());
    }

    if (req.method !== 'POST') return new Response('ok');
    const body = await req.text();
    if (!(await verify(req, body, env))) return new Response('bad signature', {status:401});

    const i = JSON.parse(body);
    if (i.type === 1) return json({type:1});

    if (i.type === 2 && i.data.name === 'clip') {
      const o = {};
      for (const x of (i.data.options || [])) o[x.name] = String(x.value).trim();
      ctx.waitUntil(fetch(`https://api.github.com/repos/${env.GH_REPO}/actions/workflows/clip.yml/dispatches`, {
        method:'POST',
        headers:{
          Authorization:`Bearer ${env.GH_TOKEN}`,
          Accept:'application/vnd.github+json',
          'User-Agent':'clip-cutter-worker',
          'X-GitHub-Api-Version':'2022-11-28'
        },
        body: JSON.stringify({ref:'main', inputs:{
          url:o.link, start:o.start, end:o.end,
          quality:o.quality || '1080', short:o.short || 'no',
          channel_id:i.channel_id
        }})
      }));
      return json({type:4, data:{content:'⏳ Clip ban rahi hai, 2-5 min me link yahin aayega.'}});
    }
    return new Response('unknown', {status:400});
  }
};
