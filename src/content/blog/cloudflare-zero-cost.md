---
title: '零预算把个人网站全栈跑起来：Cloudflare 踩坑实录'
description: '一个域名、零服务器预算，跑起主页、博客、表单后端和数据库，全程免费。记录真实踩过的坑：CNAME 指向 workers.dev 得到 522、Add Domain 不好使、A 记录占位加路由的正确姿势、表单的两个前端 bug。'
pubDate: 2026-10-28
tags: ['Cloudflare', 'DNS', 'Workers', '个人网站']
---

起因很简单：手里有个闲置域名，不想为它买服务器，又想要主页、博客、能收留言的表单和一个小数据库。五天下来这套东西全部上线，账单是零。这篇文章记录真实踩过的坑，每一个都来自操作现场，不是文档复述。

先看最终架构，三个子域名各司其职：

```
vorluna.top        → 主页（静态托管，单页应用）
blog.vorluna.top   → 博客（静态托管，Astro 构建）
api.vorluna.top    → 联系表单后端（Worker + D1 数据库）
```

全部跑在 Cloudflare 免费额度上：静态站无限流量，Worker 每天 10 万次请求，D1 免费 5GB。个人用途碰不到这些天花板。

## 坑一：CNAME 指向 workers.dev，得到 522

给 Worker 绑子域名，我的第一反应是加一条 CNAME：`api` 指向 `vorluna-contact.xxx.workers.dev`，橙色云开启。结果访问返回 522，页面说"Cloudflare 与源站服务器连接超时"。

翻明白之后才发现这里的机制：橙色云开启后，流量先进 Cloudflare 边缘，Cloudflare 要决定这个请求交给谁。有路由规则就交给 Worker；没有规则就走默认剧本，反向代理去连接你填的目标。而 workers.dev 不是一台可以"被连接"的源站，它是 Cloudflare 自己的路由层，从边缘去"回源"它，直接超时。522 就是这么来的。

正确姿势是两步：

1. DNS 加一条 **A 记录**：`api` 指向 `192.0.2.1`（测试网段的占位 IP，Cloudflare 官方文档的标准做法），橙色云开启；
2. Worker 的 Settings → Domains & Routes → Add **route**，规则 `api.vorluna.top/*` 绑到这个 Worker。

占位 IP 全程没人碰它：请求进边缘之后，路由规则在"连接源站"之前就把流量截给 Worker 了。这套叫 Workers Routes，比 Add Domain 干脆，原因见坑二。

## 坑二：Add Domain 弹窗和它的证书

Cloudflare 还提供另一条路：Worker 的 Add Custom Domain。理论上更省事，实际遇到两个问题。一是弹窗有时点了确认毫无反应，列表里也不出现（原因没查明白，界面问题不排除）；二是它要给域名单独签证书，状态 Pending 期间访问直接连接被切断，等起来没数。

Routes 方式没这两个毛病：它用 Zone 的通用证书，就是域名 NS 迁进 Cloudflare 那天自动签发、覆盖 `*.vorluna.top` 全部子域名、自动续期的那张。所以路由规则一加，HTTPS 立即生效。

顺带说一个界面上容易懵的点：Add Route 弹窗里要选 Zone，下拉列表里列的是**域名**（你接入 Cloudflare 的网站），不是项目。开始我在里面找 Worker 项目名，当然找不到。还有，路由规则绑定的 Worker 就是你当前所在项目的页面，从 A 项目的页面进去加路由，规则就绑给 A，和填什么 pattern 无关。我就这么把博客的流量错绑到了表单 Worker 上，症状特别好认：博客打开显示 `{"error":"not found"}`，因为那是表单 Worker 的 404 响应。

## 坑三：表单的两个前端 bug

后端 Worker 一百三十行：校验、蜜罐字段防机器人、同 IP 限流、写 D1。真正费了两个回合的是前端。

第一个：提交时永远提示"请填写称呼"，明明填了。原因是 JavaScript 里 `form.name` 拿到的不是那个叫 name 的输入框，是表单元素自带的 name 属性（浏览器内置属性优先级高于同名控件），值是空字符串。`form.action`、`form.method` 是同款坑。改用 `getElementById` 直接拿元素，顺手给所有输入框都配上 id。

第二个更隐蔽：中文输入法打字时控制台连环报错。挂在 document 上的键盘监听器（页面有个 Konami 秘籍彩蛋）直接读了 `ev.key.length`，而输入法组合状态下的按键事件，`ev.key` 可能是 undefined。修复两行：组合中直接 return（`ev.isComposing`），读之前加空值兜底。

```javascript
document.addEventListener("keydown", function (ev) {
  if (ev.isComposing) return;   // 输入法组合期间的按键不处理
  var k = (ev.key || "").length === 1 ? ev.key.toLowerCase() : ev.key;
  // ...
});
```

中文互联网环境里，凡全局键盘监听都必须过这道坎。我的博客项目里其实早就写过同样的守卫，主页写的时候漏了，同一个坑摔两次，记一笔。

## 这套东西的边界

免费不等于无限。Worker 单次执行默认 10ms CPU，跑不了重计算；D1 是 SQLite 规格，不适合当业务主库压性能；静态站没有服务端渲染。对个人主页、作品集、博客、轻量 API 这些场景，够用且绰绰有余。真到需要常驻进程那天，再买服务器，DNS 上改条记录就迁移了，这些代码一行不用动。

五天下来最实际的收获倒不是省钱。是把 DNS 记录、边缘路由、证书、serverless、数据库这一整条链路亲手摸了一遍，每个环节为什么存在、断了会是什么症状，都见过实物了。
