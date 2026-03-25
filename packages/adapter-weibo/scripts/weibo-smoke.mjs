import { chromium } from "playwright";

const browserUrl = process.env.BROWSER_URL ?? "http://127.0.0.1:9222";
const query = process.env.WEIBO_QUERY ?? "OpenAI";
const uid = process.env.WEIBO_UID ?? "1648815335";
const postId = process.env.WEIBO_POST_ID ?? "5279584255214211";
const authorUid = process.env.WEIBO_POST_AUTHOR_UID ?? "2155926845";

function summarizeTimelineItem(item) {
  return {
    id: item?.idstr || item?.mid || item?.id || null,
    text: typeof item?.text_raw === "string"
      ? item.text_raw.slice(0, 80)
      : typeof item?.text === "string"
        ? item.text.slice(0, 80)
        : "",
  };
}

const browser = await chromium.connectOverCDP(browserUrl);
const context = browser.contexts()[0];
const page = context.pages()[0];

const result = {
  browserUrl,
  query,
  uid,
  postId,
  checks: {},
};

await page.goto("https://weibo.com/", { waitUntil: "domcontentloaded" }).catch(() => {});
await page.waitForTimeout(1500);

result.checks.timeline = await page.evaluate(async () => {
  const response = await fetch(
    "https://weibo.com/ajax/feed/unreadfriendstimeline?list_id=100011648815335&refresh=4&since_id=0&count=3",
    { credentials: "include" },
  );
  const json = await response.json();
  return {
    status: response.status,
    ok: response.ok,
    keys: Object.keys(json).slice(0, 10),
    count: Array.isArray(json?.statuses) ? json.statuses.length : 0,
    nextCursor: json?.max_id_str || json?.since_id_str || null,
    sample: Array.isArray(json?.statuses) ? json.statuses.slice(0, 2).map((item) => ({
      id: item?.idstr || item?.mid || item?.id || null,
      text: typeof item?.text_raw === "string" ? item.text_raw.slice(0, 80) : typeof item?.text === "string" ? item.text.slice(0, 80) : "",
    })) : [],
  };
});

result.checks.post = await page.evaluate(async (input) => {
  const response = await fetch(
    `https://weibo.com/ajax/statuses/show?id=${encodeURIComponent(input.postId)}&locale=en-US&isGetLongText=true`,
    { credentials: "include" },
  );
  const json = await response.json();
  return {
    status: response.status,
    ok: response.ok,
    keys: Object.keys(json).slice(0, 10),
    sample: {
      id: json?.idstr || json?.mid || json?.id || null,
      text: typeof json?.text_raw === "string" ? json.text_raw.slice(0, 120) : typeof json?.text === "string" ? json.text.slice(0, 120) : "",
    },
  };
}, { postId });

result.checks.user = await page.evaluate(async (input) => {
  const response = await fetch(
    `https://weibo.com/ajax/profile/info?uid=${encodeURIComponent(input.uid)}&scene=profile`,
    { credentials: "include" },
  );
  const json = await response.json();
  const user = json?.data?.user ?? {};
  return {
    status: response.status,
    ok: response.ok,
    keys: Object.keys(json).slice(0, 10),
    sample: {
      id: user?.idstr || user?.id || null,
      screenName: user?.screen_name || null,
    },
  };
}, { uid });

result.checks.userPosts = await page.evaluate(async (input) => {
  const response = await fetch(
    `https://weibo.com/ajax/statuses/mymblog?uid=${encodeURIComponent(input.uid)}&page=1&feature=0`,
    { credentials: "include" },
  );
  const json = await response.json();
  const list = Array.isArray(json?.data?.list) ? json.data.list : [];
  return {
    status: response.status,
    ok: response.ok,
    count: list.length,
    sample: list.slice(0, 2).map((item) => ({
      id: item?.idstr || item?.mid || item?.id || null,
      text: typeof item?.text_raw === "string" ? item.text_raw.slice(0, 80) : typeof item?.text === "string" ? item.text.slice(0, 80) : "",
    })),
  };
}, { uid });

result.checks.replies = await page.evaluate(async (input) => {
  const response = await fetch(
    `https://weibo.com/ajax/statuses/buildComments?is_reload=1&id=${encodeURIComponent(input.postId)}&is_show_bulletin=2&is_mix=0&count=10&uid=${encodeURIComponent(input.authorUid)}&fetch_level=0&locale=en-US`,
    { credentials: "include" },
  );
  const json = await response.json();
  return {
    status: response.status,
    ok: response.ok,
    count: Array.isArray(json?.data) ? json.data.length : 0,
    nextCursor: json?.max_id ?? null,
  };
}, { postId, authorUid });

result.checks.reposts = await page.evaluate(async (input) => {
  const response = await fetch(
    `https://weibo.com/ajax/statuses/repostTimeline?id=${encodeURIComponent(input.postId)}&page=1`,
    { credentials: "include" },
  );
  const json = await response.json();
  return {
    status: response.status,
    ok: response.ok,
    count: Array.isArray(json?.data) ? json.data.length : 0,
    nextCursor: json?.next_cursor ?? null,
    maxPage: json?.max_page ?? null,
  };
}, { postId });

await page.goto(`https://s.weibo.com/weibo?q=${encodeURIComponent(query)}&Refer=weibo_weibo`, {
  waitUntil: "domcontentloaded",
}).catch(() => {});
await page.waitForTimeout(1500);

result.checks.searchWeibo = await page.evaluate(() => {
  const cards = Array.from(document.querySelectorAll(".card-wrap[mid], .card-wrap")).slice(0, 3).map((card) => ({
    id: card.getAttribute("mid") || card.getAttribute("data-mid"),
    text:
      card.querySelector(".txt[node-type='feed_list_content_full']")?.textContent?.replace(/\s+/g, " ").trim().slice(0, 120) ||
      card.querySelector(".txt")?.textContent?.replace(/\s+/g, " ").trim().slice(0, 120) ||
      "",
  }));
  const next = document.querySelector(".m-page a.next[href]");
  return {
    href: location.href,
    count: cards.length,
    nextCursor: next instanceof HTMLAnchorElement ? new URL(next.href).searchParams.get("page") : null,
    sample: cards,
  };
});

await page.goto(`https://s.weibo.com/aisearch?q=${encodeURIComponent(query)}&Refer=weibo_aisearch`, {
  waitUntil: "domcontentloaded",
}).catch(() => {});
await page.waitForTimeout(2500);

result.checks.searchAi = await page.evaluate(async (input) => {
  const response = await fetch(
    `https://ai.s.weibo.com/api/llm/analysis_demo_result.json?query=${encodeURIComponent(input.query)}&search_source=default_init&appversion=1.0.90&sid=pc_search`,
    { credentials: "include" },
  );
  const json = await response.json();
  return {
    status: response.status,
    ok: response.ok,
    displayQuery: json?.display_query ?? null,
    msgFormat: json?.msg_format ?? null,
    hasSummary: typeof json?.msg === "string" && json.msg.trim().length > 0,
    summaryPreview: typeof json?.msg === "string" ? json.msg.replace(/\s+/g, " ").trim().slice(0, 120) : "",
  };
}, { query });

console.log(JSON.stringify(result, null, 2));

await browser.close();
