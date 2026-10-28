---
title: 'AI 客服答非所问：三个并发竞态'
description: '线上 AI 客服偶尔"串台"：A 的窗口里出现回给 B 的内容，或者回复的是两条消息之前的旧问题。这个缺陷背后是三个并发竞态：同会话双连接、AI 轮次抢跑、半开连接丢消息。记录定位过程和三层修复。'
pubDate: 2026-10-26
tags: ['并发', 'WebSocket', 'Django', 'AI 客服']
---

缺陷是从客户那里传过来的：官网上的 AI 客服偶尔答非所问。截图里，访客问的是 A 产品的价格，AI 回的是刚才 B 话题的延续；还有更怪的，回复明显在回答用户两条消息之前的那个问题。

偶发，难复现，测试环境跑不出来。日志翻了很久才注意到一个规律：出问题的会话，前后总有密集的连接事件。并发，而且是"同一个会话的并发"。

顺着这个方向，最后挖出来三个竞态。一个都不起眼，叠在一起就是客户眼里的"AI 抽风"。

![三条竞态路径的示意](/diagrams/race-conditions.svg)

## 竞态一：刷新页面，会话里同时有两条连接

用户刷新页面的时候，旧的 WebSocket 还没来得及走 `disconnect`，新的已经连上来了。接下来的几秒钟里，一个会话挂着两条活连接，各自都能收消息、各自都能触发一轮 AI 回复。回复推给哪条连接，取决于谁先算完。

同一个访客在两个标签页里打开网站也是一样的效果。

修法是连接级的互斥：一个 `session_code` 同时只允许一条 WebSocket 连接，用 Redis 的 `cache.add` 抢占，键里存的是当前连接的 channel 名：

```python
self._conn_key = f"ai:ws:conn:{self.session_code}"
acquired = False
for _ in range(MUTEX_RETRY_COUNT):
    acquired = await cache.add(self._conn_key, self.channel_name,
                               timeout=CONN_MUTEX_TTL)
    if acquired:
        break
    await asyncio.sleep(MUTEX_RETRY_INTERVAL_S)
```

抢不到就重试几次再放弃。重试不是多余的，它专门吸收"刷新页面"那个窗口：旧连接马上要释放了，稍等一下就能拿到，没必要把用户拒之门外。重试完还被占着，多半是进程崩溃留下的僵尸锁，这时直接删掉重抢；再不行才回 `4009`，告诉前端"该会话已在另一个窗口中打开"。

## 竞态二：AI 还没回完，用户又发了两条

第二个竞态在轮次层面。用户连着发消息，售前场景里太常见了，一句话拆成三四条发。上一轮 AI 还在生成，新一轮已经进来了。两轮并发读写同一份会话状态（Agent 的会话仓库），后端历史写乱，回复的顺序也乱。

处理锁加在会话级：同一会话同一时刻只跑一轮 AI。关键是抢不到锁时不能报错把用户顶回去，而是排队：

```python
lock = await self._acquire_processing_lock()
if not lock:
    buf = await push_buffered_message(self.session_code, user_message)
    await self.send_json({
        'type': 'message_buffered',
        'position': buf['position'],
        'message': '上一条仍在处理，本条已排队，将合并理解后回复。',
    })
    return
try:
    await self._execute_ai_turn(user_message, ...)
finally:
    await self._release_processing_lock(lock)
    await self._drain_turn_buffer_if_any()   # 当前轮结束后，把排队的合并成下一轮
```

排队消息在下一轮开始前合并成一条——"用户连续发送了以下消息，请合并理解后统一回复：1. … 2. …"。对模型来说这比拆成两问两答自然得多。前端也做了同款缓冲，用户连发时先攒在本地，AI 空闲再一起发；后端的 turn_buffer 是兜底，两边格式对齐，谁先触发都一样。

这一层做完，"回复旧问题"的现象从结构上消失了：同一会话永远只有一轮在跑，晚到的消息必然进入下一轮，不存在两条回复赛跑。

## 竞态三：半开连接，消息发了个寂寞

第三个不好发现。移动网络下 TCP 半开：前端 `send()` 成功返回，服务端根本没收到。用户看到消息发出去了、AI 不理人，重连机制自动重发。如果服务端没有去重，这条消息就处理两次，两条回复先后到达，后一条又"答非所问"了。

解法是把"收到"变成显式的协议。前端给每条消息生成 `client_msg_id`，发出去就记在待确认表里；服务端收到先回 `message_ack`。重连成功后，把所有没等到 ack 的消息原样重发：

```typescript
/** 重连成功后重发未 ack 的消息（服务端按 client_msg_id 幂等去重）。 */
#resendPendingAcks(): void {
  if (this.#pendingAcks.size === 0 || !this.#ws?.isOpen()) return
  for (const [clientMsgId, pending] of this.#pendingAcks) {
    this.#dispatchUserTurn(pending.text, { clientMsgId, ... })
  }
}
```

服务端按 `session_code + client_msg_id` 去重，15 分钟内重复到达的消息回一个带 `duplicate` 标记的 ack，不再处理：

```python
client_msg_id = str(content.get('client_msg_id') or '').strip()[:64]
if client_msg_id:
    dup_key = f'ws:msg_ack:{self.session_code}:{client_msg_id}'
    if await cache.get(dup_key):
        await self.send_json({'type': 'message_ack',
                              'client_msg_id': client_msg_id, 'duplicate': True})
        return
    await cache.set(dup_key, 1, timeout=900)
await self.send_json({'type': 'message_ack', 'client_msg_id': client_msg_id})
```

收到 duplicate ack 的含义值得多说一句：说明这条消息其实早就送达了，回复可能已经在断线期间生成，但推给了那条已经死掉的连接。这时前端不去猜、不拿缓存里的旧响应凑数，直接拉一次服务端历史对齐。以服务端为准，比任何客户端的推断都可靠。

## 第四把锁：Agent 会话仓库的写入

上面三层之外还有一把独立的锁。Agent 框架自带的会话仓库不是并发安全的，两个轮次同时写，历史会交错损坏。所以写仓库的临界区套了一个带令牌的分布式锁：释放前先比对 Redis 里的值是不是自己写的令牌，防止 TTL 过期后误删别人的锁；等待 30 秒还拿不到就记一条警告，不锁继续跑。

最后这个"不锁继续跑"是权衡过的：这把锁防的是低概率的写交错，拿它当硬门槛，可用性的损失比偶发错乱更伤。前两层的互斥已经把并发窗口压到很小，这把锁算第三层保险。

## 修完之后

三层修复上线后，"答非所问"的反馈归零。

回头看，定位阶段有一条经验最管用：先在日志里找规律，再反推竞态窗口。"出问题的会话前后总有密集连接事件"这一行观察，比对着代码空想三天管用。修复的三层也都不复杂，互斥、排队、确认重传，操作系统课本里都有；花时间的是发现"这里缺一个互斥"，以及把"锁拿不到的时候怎么办"一条条想清楚。
