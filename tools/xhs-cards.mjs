// 小红书图文卡片生成器
// 用法：node xhs-cards.mjs <文章slug 或 md文件路径>
// 输出：out/<slug>/01.png ~ NN.png（1080x1440，3:4 竖版）
import sharp from "sharp";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "out");

const C = {
  paper: "#FAFAF7", ink: "#1A1A1E", muted: "#6E6E78", faint: "#9B9BA4",
  accent: "#B4532A", line: "#E8E5DE", gold: "#FFD24A", codeBg: "#F4F2ED",
};

// ---------- 文章解析 ----------
function parsePost(target) {
  const mdPath = target.endsWith(".md")
    ? join(process.cwd(), target)
    : join(ROOT, "src", "content", "blog", `${target}.md`);
  const raw = readFileSync(mdPath, "utf-8");

  const fm = raw.match(/^---\n([\s\S]*?)\n---/);
  const meta = {};
  if (fm) {
    for (const line of fm[1].split("\n")) {
      const m = line.match(/^(\w+):\s*'?(.*?)'?\s*$/);
      if (m) meta[m[1]] = m[2];
    }
  }
  const body = raw.slice((fm ? fm[0].length : 0));

  // 取 h2 小节：标题 + 该节第一段纯文本
  const sections = [];
  const parts = body.split(/\n(?=## )/);
  for (const part of parts.slice(1)) {
    const h2 = part.match(/^## (.+)$/m);
    if (!h2) continue;
    const paras = part.split(/\n\n+/).slice(1)
      .map((p) => p.replace(/[#>*`\-!\[\]()]/g, "").replace(/\s+/g, " ").trim())
      .filter((p) => p.length > 20);
    if (paras.length) sections.push({ title: h2[1].trim(), para: paras[0] });
  }
  return { slug: basename(mdPath, ".md"), meta, sections };
}

// ---------- 文本排版 ----------
// 估算行宽：CJK/全角≈1em，其余≈0.56em
function visualWidth(s) {
  let w = 0;
  for (const ch of s) w += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F]/.test(ch) ? 1 : 0.56;
  return w;
}
function wrap(text, maxEm) {
  const lines = [];
  let cur = "";
  for (const ch of text) {
    if (visualWidth(cur + ch) > maxEm) { lines.push(cur); cur = ch === " " ? "" : ch; }
    else cur += ch;
  }
  if (cur.trim()) lines.push(cur);
  return lines;
}
function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
const textNode = (x, y, str, size, fill, opts = {}) => {
  const family = opts.mono ? "Consolas, Microsoft YaHei" : "Microsoft YaHei, PingFang SC";
  return `<text x="${x}" y="${y}" font-family="${family}" font-size="${size}" fill="${fill}"${opts.weight ? ` font-weight="${opts.weight}"` : ""}${opts.anchor ? ` text-anchor="${opts.anchor}"` : ""}>${esc(str)}</text>`;
};

// ---------- 卡片模板 ----------
const W = 1080, H = 1440;

function coverCard(post) {
  const titleLines = wrap(post.meta.title || post.slug, 9).slice(0, 3);
  const descLines = wrap(post.meta.description || "", 23).slice(0, 3);
  let y = 520;
  let svg = base();
  svg += `<rect x="72" y="96" width="64" height="8" fill="${C.accent}"/>`;
  svg += textNode(72, 176, "ARIA · 后端与 AI 应用工程", 30, C.faint);
  titleLines.forEach((l, i) => {
    svg += textNode(72, y, l, 96, C.ink, { weight: "bold" });
    y += 124;
  });
  y += 36;
  svg += `<line x1="72" y1="${y}" x2="300" y2="${y}" stroke="${C.line}" stroke-width="3"/>`;
  y += 64;
  descLines.forEach((l) => {
    svg += textNode(72, y, l, 38, C.muted);
    y += 60;
  });
  svg += footer();
  return svg;
}

function sectionCard(post, sec, idx, total) {
  const titleLines = wrap(sec.title, 12).slice(0, 2);
  const paraLines = wrap(sec.para, 18).slice(0, 8);
  let y = 330;
  let svg = base();
  svg += `<rect x="72" y="112" width="72" height="72" fill="none" stroke="${C.ink}" stroke-width="4"/>`;
  svg += textNode(108, 164, String(idx).padStart(2, "0"), 40, C.accent, { weight: "bold", mono: true });
  titleLines.forEach((l) => {
    svg += textNode(200, y, l, 62, C.ink, { weight: "bold" });
    y += 82;
  });
  y += 20;
  svg += `<line x1="200" y1="${y}" x2="420" y2="${y}" stroke="${C.accent}" stroke-width="3"/>`;
  y += 78;
  paraLines.forEach((l) => {
    svg += textNode(200, y, l, 44, "#3A3A44");
    y += 72;
  });
  svg += footer();
  return svg;
}

function endCard(post) {
  let svg = base();
  svg += textNode(540, 460, "完整内容", 80, C.faint, { anchor: "middle" });
  svg += textNode(540, 620, "看博客全文", 88, C.ink, { anchor: "middle", weight: "bold" });
  svg += `<rect x="370" y="700" width="340" height="96" fill="none" stroke="${C.ink}" stroke-width="4"/>`;
  svg += textNode(540, 762, "blog.vorluna.top", 42, C.accent, { anchor: "middle", mono: true, weight: "bold" });
  svg += textNode(540, 940, `/posts/${post.slug}/`, 30, C.muted, { anchor: "middle", mono: true });
  svg += footer();
  return svg;
}

function base() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="${W}" height="${H}" fill="${C.paper}"/>
    <rect x="0" y="${H - 10}" width="${W}" height="10" fill="${C.accent}"/>`;
}
function footer() {
  return textNode(72, H - 62, "aria · 后端与 AI 应用工程", 28, C.faint)
    + textNode(W - 72, H - 62, "vorluna.top", 28, C.faint, { anchor: "end", mono: true }) + `</svg>`;
}

// ---------- 主流程 ----------
const target = process.argv[2];
if (!target) {
  console.error("用法：node xhs-cards.mjs <文章slug 或 md路径>");
  process.exit(1);
}
const post = parsePost(target);
const secs = post.sections.slice(0, 6);
const outDir = join(OUT_ROOT, post.slug);
mkdirSync(outDir, { recursive: true });

const cards = [coverCard(post), ...secs.map((s, i) => sectionCard(post, s, i + 1, secs.length)), endCard(post)];
for (let i = 0; i < cards.length; i++) {
  const file = join(outDir, `${String(i + 1).padStart(2, "0")}.png`);
  await sharp(Buffer.from(cards[i])).png().toFile(file);
  console.log("生成", file);
}
console.log(`\n完成：${cards.length} 张卡片（封面 + ${secs.length} 内容 + 尾卡）→ ${outDir}`);
