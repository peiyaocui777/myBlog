# aria 的博客（blog.vorluna.top）

基于 Astro 的静态博客。仓库：https://github.com/peiyaocui777/myBlog

## 日常写作流程（git 自动部署版）

1. 在 `src/content/blog/` 新建 `文章名.md`（文件名即 URL，英文短横线）；
2. front matter 模板：

```yaml
---
title: '文章标题'
description: '一句话摘要'
pubDate: 2026-11-01
tags: ['标签1', '标签2']
draft: true    # 写完删掉这行才发布
---
```

3. 本地预览：`npm run dev` → http://localhost:4321；
4. 发布三连：

```bash
git add -A
git commit -m "发布：文章标题"
git push
```

Cloudflare 检测到 push 会自动构建并上线（前提：Workers & Pages 已 Connect to Git 连上本仓库）。

## 手动部署（备用，git 未接通时）

`npm run build` 后把 `blog\dist` 文件夹拖到 Cloudflare 控制台 vorluna-blog 项目的 Create deployment。

## 目录结构

```
blog/
├── src/
│   ├── content/blog/     ← 文章都放这里（Markdown）
│   ├── layouts/          ← 全站模板（设计在 BaseLayout.astro 的 <style> 里）
│   └── pages/            ← 首页/归档/关于/RSS
├── public/               ← 静态资源（favicon、diagrams/ 示意图）
└── astro.config.mjs      ← 站点配置（域名、代码高亮主题）
```

## 待办

- [ ] 首篇之前的旧待办已完成；现有 7 篇全部发布
- [ ] Cloudflare Connect to Git 连接本仓库后，删除此节的"手动部署"说明
- [ ] 关于页里的 aria@vorluna.top 邮箱：Email Routing 开通后删掉 Gmail 兜底那行
