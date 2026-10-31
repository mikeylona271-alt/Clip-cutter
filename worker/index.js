const COMMANDS = [{
  name: 'clip',
  description: 'YouTube clip banao',
  type: 1,
  options: [
    {
      name: 'link',
      description: 'YouTube link',
      type: 3,
      required: true
    },
    {
      name: 'start',
      description: 'Start time: MM:SS ya HH:MM:SS',
      type: 3,
      required: true
    },
    {
      name: 'end',
      description: 'End time: MM:SS ya HH:MM:SS',
      type: 3,
      required: true
    },
    {
      name: 'quality',
      description: 'Quality',
      type: 3,
      required: false,
      choices: [
        { name: '720p', value: '720' },
        { name: '1080p', value: '1080' },
        { name: '1440p (2K)', value: '1440' },
        { name: '2160p (4K)', value: '2160' }
      ]
    },
    {
      name: 'short',
      description: '9:16 Short banao?',
      type: 3,
      required: false,
      choices: [
        { name: 'No', value: 'no' },
        { name: 'Yes', value: 'yes' }
      ]
    }
  ]
}];

const hex = h =>
  new Uint8Array(h.match(/../g).map(b => parseInt(b, 16)));

const json = o => new Response(JSON.stringify(o), {
  headers: { 'Content-Type': 'application/json' }
});

// Accept MM:SS or HH:MM:SS.
// Examples: 10:00, 01:11:23, 1:05:30
function parseTime(value) {
  const parts = value.split(':');

  if (parts.some(p => !/^\d+$/.test(p))) return null;

  let seconds;

  if (parts.length === 2) {
    const [minutes, secs] = parts.map(Number);

    if (secs > 59) return null;
    seconds = minutes * 60 + secs;
  } else if (parts.length === 3) {
    const [hours, minutes, secs] = parts.map(Number);

    if (minutes > 59 || secs > 59) return null;
    seconds = hours * 3600 + minutes * 60 + secs;
  } else {
    return null;
  }

  if (!Number.isSafeInteger(seconds) || seconds < 0) return null;

  return seconds;
}

async function verify(req, body, env) {
  const sig = req.headers.get('x-signature-ed25519');
  const ts = req.headers.get('x-signature-timestamp');

  if (!sig || !ts) return false;

  const pk = (env.DISCORD_PUBLIC_KEY || '').trim();

  try {
    if (!/^[0-9a-fA-F]{128}$/.test(sig)) return false;
    if (!/^[0-9a-fA-F]{64}$/.test(pk)) return false;

    const data = new TextEncoder().encode(ts + body);

    for (const alg of [
      { name: 'Ed25519' },
      { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' }
    ]) {
      try {
        const key = await crypto.subtle.importKey(
          'raw', hex(pk), alg, false, ['verify']
        );

        return await crypto.subtle.verify(alg, key, hex(sig), data);
      } catch (e) {}
    }
  } catch (e) {}

  return false;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    if (url.pathname === '/debug') {
      return new Response(
        'keylen=' + (env.DISCORD_PUBLIC_KEY || '').length
      );
    }

    if (req.method === 'GET' && url.pathname === '/register') {
      if (!env.REGISTER_KEY ||
          url.searchParams.get('k') !== env.REGISTER_KEY) {
        return new Response('no', { status: 403 });
      }

      const r = await fetch(
        `https://discord.com/api/v10/applications/${env.DISCORD_APP_ID}/commands`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(COMMANDS)
        }
      );

      return new Response(`Discord: ${r.status}\n` + await r.text());
    }

    if (req.method !== 'POST') {
      return new Response('ok');
    }

    const body = await req.text();

    if (!(await verify(req, body, env))) {
      return new Response('bad signature', { status: 401 });
    }

    let i;

    try {
      i = JSON.parse(body);
    } catch (e) {
      return new Response('invalid JSON', { status: 400 });
    }

    if (i.type === 1) {
      return json({ type: 1 });
    }

    if (i.type === 2 && i.data.name === 'clip') {
      const o = {};

      for (const x of (i.data.options || [])) {
        o[x.name] = String(x.value).trim();
      }

      const startSeconds = parseTime(o.start || '');
      const endSeconds = parseTime(o.end || '');

      if (startSeconds === null || endSeconds === null) {
        return json({
          type: 4,
          data: {
            content:
              '❌ Invalid time format. Use MM:SS (10:00) or HH:MM:SS (01:11:23).'
          }
        });
      }

      if (endSeconds <= startSeconds) {
        return json({
          type: 4,
          data: {
            content: '❌ End time must be later than start time.'
          }
        });
      }

      if (!/^https:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\//.test(o.link || '')) {
        return json({
          type: 4,
          data: { content: '❌ Please provide a valid YouTube link.' }
        });
      }

      if (!env.GH_REPO || !env.GH_TOKEN) {
        return json({
          type: 4,
          data: { content: '❌ GitHub configuration is missing.' }
        });
      }

      const response = await fetch(
        `https://api.github.com/repos/${env.GH_REPO}/actions/workflows/clip.yml/dispatches`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.GH_TOKEN}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'clip-cutter-worker',
            'X-GitHub-Api-Version': '2022-11-28'
          },
          body: JSON.stringify({
            ref: 'main',
            inputs: {
              url: o.link,
              start: o.start,
              end: o.end,
              quality: o.quality || '1080',
              short: o.short || 'no',
              channel_id: i.channel_id
            }
          })
        }
      );

      if (!response.ok) {
        console.error(
          'GitHub dispatch failed:',
          response.status,
          await response.text()
        );

        return json({
          type: 4,
          data: {
            content:
              '❌ GitHub workflow start nahi hua. Please try again later.'
          }
        });
      }

      return json({
        type: 4,
        data: {
          content:
            '⏳ Clip ban rahi hai! HH:MM:SS timestamps supported hain. Link yahin aayega.'
        }
      });
    }

    return new Response('unknown', { status: 400 });
  }
};
