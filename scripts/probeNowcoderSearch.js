/**
 * One-off probe: how many discuss links appear in search HTML vs page=2.
 * Run: node scripts/probeNowcoderSearch.js kafka
 */
const query = process.argv[2] ?? "kafka";
const headers = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml",
  "Accept-Language": "zh-CN,zh;q=0.9"
};

function countDiscuss(html) {
  const ids = new Set();
  for (const m of html.matchAll(/\/discuss\/(\d+)/g)) ids.add(m[1]);
  return ids.size;
}

async function fetchText(url) {
  const r = await fetch(url, { headers });
  return { status: r.status, html: await r.text() };
}

const base = `https://www.nowcoder.com/search/all?query=${encodeURIComponent(query)}&type=all`;
for (const page of [1, 2, 3]) {
  const url = page === 1 ? base : `${base}&page=${page}`;
  const { status, html } = await fetchText(url);
  console.log("page", page, "status", status, "htmlLen", html.length, "discuss", countDiscuss(html));
}

// Try common gw-c search API patterns from bundled hints
const apiCandidates = [
  {
    name: "search-v2",
    url: "https://gw-c.nowcoder.com/api/sparta/pc/search",
    body: { type: "all", query, page: 1, size: 20 }
  },
  {
    name: "search-discuss",
    url: "https://gw-c.nowcoder.com/api/sparta/discuss/search",
    body: { query, page: 1, pageSize: 20 }
  }
];

for (const c of apiCandidates) {
  try {
    const r = await fetch(c.url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(c.body)
    });
    const text = await r.text();
    console.log(c.name, "status", r.status, "bodyHead", text.slice(0, 200).replace(/\s+/g, " "));
  } catch (err) {
    console.log(c.name, "err", err.message);
  }
}
