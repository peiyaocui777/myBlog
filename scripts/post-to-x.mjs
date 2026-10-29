/**
 * 新文章发布通知：X (Twitter) + Telegram（可选）。
 * 由 GitHub Actions 在 push 到 main 后调用：node scripts/post-to-x.mjs <slug> [url]
 * 未配置 Secrets 时打印提示并正常退出（exit 0），不会阻塞 CI。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHmac } from "node:crypto";

const slug = process.argv[2];
const url = process.argv[3] || `https://blog.vorluna.top/posts/${slug}/`;

if (!slug) {
  console.error("usage: node post-to-x.mjs <slug> [url]");
  process.exit(1);
}

// ---- 解析文章 frontmatter ----
const file = join(process.cwd(), "src/content/blog", `${slug}.md`);
const md = readFileSync(file, "utf8");
const fm = md.split("---")[1] || "";
const meta = Object.fromEntries(
  fm.split("\n")
    .filter((l) => l.includes(":"))
    .map((l) => {
      const i = l.indexOf(":");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    })
);
const title = meta.title || slug;

// ---- 组装推文（X 限制 280 字符，中文按 2 计权） ----
function weightedLen(s) {
  let n = 0;
  for (const ch of s) n += ch.codePointAt(0) > 0x2e7f ? 2 : 1;
  return n;
}
const tags = "#后端开发 #AI工程";
const base = `博客更新：${title}\n${url}`;
let status = `${base}\n${tags}`;
if (weightedLen(status) > 280) status = base;

// ---- X API v2（OAuth 1.0a）----
async function postX() {
  const { X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET } = process.env;
  if (![X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET].every(Boolean)) {
    console.log("X secrets 未配置，跳过 X 发布。");
    return false;
  }
  const oauth1Header = (url, method) => {
    const nonce = crypto.randomUUID().replace(/-/g, "");
    const ts = Math.floor(Date.now() / 1000).toString();
    const params = {
      oauth_consumer_key: X_API_KEY,
      oauth_nonce: nonce,
      oauth_signature_method: "HMAC-SHA1",
      oauth_timestamp: ts,
      oauth_token: X_ACCESS_TOKEN,
      oauth_version: "1.0",
    };
    const sigBase =
      [method.toUpperCase(), url, Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).sort().join("&")]
        .map(encodeURIComponent).join("&");
    const signKey = `${encodeURIComponent(X_API_SECRET)}&${encodeURIComponent(X_ACCESS_SECRET)}`;
    const sig = createHmac("sha1", signKey).update(sigBase).digest("base64");
    return `OAuth ${Object.entries({ ...params, oauth_signature: sig })
      .map(([k, v]) => `${k}="${encodeURIComponent(v)}"`).join(", ")}`;
  };
  const res = await fetch("https://api.twitter.com/2/tweets", {
    method: "POST",
    headers: { Authorization: oauth1Header("https://api.twitter.com/2/tweets", "POST"), "Content-Type": "application/json" },
    body: JSON.stringify({ text: status }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`X API ${res.status}: ${body}`);
  console.log("X 发布成功：", body);
  return true;
}

// ---- Telegram Bot（免费备选）----
async function postTelegram() {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("Telegram secrets 未配置，跳过。");
    return false;
  }
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: status }),
  });
  if (!res.ok) throw new Error(`Telegram API ${res.status}: ${await res.text()}`);
  console.log("Telegram 发送成功。");
  return true;
}

for (const fn of [postX, postTelegram]) {
  try {
    await fn();
  } catch (e) {
    console.error(e.message); // 单渠道失败不影响其他渠道，也不阻塞 CI
  }
}
