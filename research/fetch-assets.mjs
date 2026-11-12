import { writeFileSync, mkdirSync } from 'node:fs';

const base = 'https://embed.tawk.to';
const headers = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'referer': 'https://www.tawk.to/',
  'accept': '*/*',
  'accept-language': 'en-US,en;q=0.9',
};

const files = {
  'loader.js': `${base}/521727297ca1334016000005/18nms7gql`,
  'twk-main.js': `${base}/_s/v4/app/6af164091d5/js/twk-main.js`,
};

mkdirSync('widget', { recursive: true });
for (const [name, url] of Object.entries(files)) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  writeFileSync(`widget/${name}`, text);
  console.log(name, res.status, text.length);
}

// pull chunk list from main bundle
const main = (await import('node:fs')).readFileSync('widget/twk-main.js', 'utf8');
const chunks = [...new Set([...main.matchAll(/"\/_s\/v4\/app\/[^"]+?\.js"|_s\/v4\/app\/[a-z0-9]+\/js\/[A-Za-z0-9._-]+\.js/g)].map(m => m[0].replace(/"/g, '')))];
console.log('chunks found', chunks.length);
for (const c of chunks) {
  const url = `${base}/${c.replace(/^\//, '')}`;
  const res = await fetch(url, { headers });
  const text = await res.text();
  const name = c.split('/').pop();
  writeFileSync(`widget/${name}`, text);
  console.log(name, res.status, text.length);
}
