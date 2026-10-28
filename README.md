# aria 的博客（blog.vorluna.top）

基于 Astro 的静态博客。写作 → 构建 → 部署，全程免费。

## 日常写作流程

1. 在 `src/content/blog/` 新建 `文章名.md`（文件名即 URL，用英文短横线，如 `pg-task-queue.md` → `/posts/pg-task-queue/`）；
2. 文件头部 front matter：

```yaml
---
title: '文章标题'
description: '一句话摘要，会显示在列表和 RSS 里'
pubDate: 2026-11-01
tags: ['PostgreSQL', '架构']   # 可选
draft: true                     # 写完删掉这行才发布
---
```

3. 正文 Markdown，代码块用 \`\`\` 围栏（自动语法高亮）；
4. 本地预览：`npm run dev` → http://localhost:4321；
5. 发布三步：
   - 删掉 `draft: true`
   - `npm run build`（产物在 `dist/`）
   - Cloudflare 控制台 → vorluna-blog 项目 → Create deployment → 拖入 `dist` 文件夹

## 首次部署（还没做过时）

1. Cloudflare 控制台 → Workers & Pages → Create → Pages → Upload assets；
2. 项目名填 `vorluna-blog` → 拖入 `dist` 文件夹 → Deploy；
3. 项目 → Domains → Add domain → `blog.vorluna.top`（自动配记录，几分钟生效）。

## 目录结构

```
blog/
├── src/
│   ├── content/blog/     ← 文章都放这里（Markdown）
│   ├── layouts/          ← 全站模板（设计在 BaseLayout.astro 的 <style> 里）
│   └── pages/            ← 首页/归档/关于/RSS
├── public/               ← 静态资源（favicon 等；文章配图也放这里，引用 /xxx.png）
└── astro.config.mjs      ← 站点配置（域名、代码高亮主题）
```

## 待办

- [ ] 首篇文章 `pg-task-queue.md` 目前是 draft 骨架，填完【待补】内容后删除 draft 行发布
- [ ] 关于页里的 aria@vorluna.top 邮箱：Email Routing 开通后删掉 Gmail 兜底那行
- [ ] 主页（vorluna.top）HUD 导航已有 BLOG 入口，上线后确认链接可用
