---
title: '发送队列为什么搬回 PostgreSQL'
description: '批量邮件要从客户本机的 Agent 走 SMTP 发出，这个约束让我把最关键的发送队列从消息中间件搬回了数据库：行锁领取、幂等回传、心跳监控，以及一个宁可人工也不自动重发的决定。'
pubDate: 2026-10-26
tags: ['PostgreSQL', 'Django', '任务队列']
---

这个模块的需求说出来不复杂：导入联系人，AI 按销售意图批量生成草稿，人工逐封审核，整包发送。麻烦出在一个约束上：邮件不能从服务器群发，必须从业务员自己电脑上的本地客户端（我们叫它 Mail Agent）走他本人的 SMTP 发出去。服务器统一发出的营销邮件会被拦，从"这个人平时常用的机器"发出的才像正常邮件。

于是队列的消费者成了一台台装在客户电脑上的 Agent：轮询云端拉任务，本地发送，回传结果。这个形态影响了后面所有的选型。

## 为什么不用 Celery

项目里 Celery 一直都在，AI 草稿批量生成跑得好好的。但发送链路从一开始就没打算走它。

直接的原因是运营要看得到每一封邮件。她的问题很具体："这封现在到哪了？"答案是一条 `SELECT * FROM recipients WHERE id = 23`，`queued`、`sending`、`sent`、`send_failed` 一查便知，任务和业务数据在同一张表里，要 join 什么都有。任务进了消息队列，这个问题就得靠另一套工具回答，而那套工具通常没人维护。

取消也一样。审核完进了队列，老板突然说要撤回，数据库里就是一条 `UPDATE`，还能带条件：只撤还没被 Agent 拉走的。消息出了进程，收不回来了。

再往深一层是一致性。"确认发送"这个动作把审核通过的收件人置为 `queued`、任务置为 `sending`，一个事务提交。走消息队列就总有那么一瞬，业务库提交了、消息还没投出去，两边对不上。客户的服务器资源本来就紧，多一个 broker 还多一份要盯的东西。PostgreSQL 反正要在那儿。

## 队列就是一张表

![邮件发送队列的链路示意](/diagrams/email-queue.svg)

队列本体是收件人表，`status = 'queued'` 就是在队列里。领取就是把 `queued` 原子地改成 `sending`。

Mail Agent 拉任务，每个业务员只拉自己的，事务里锁定再改状态：

```python
with transaction.atomic():
    recipients = list(
        EmailTaskRecipient.objects.select_for_update()
        .select_related('task', 'contact')
        .filter(
            task__created_by=request.user,      # 租户隔离：只拉自己的
            task__status='sending',
            status='queued',
        )
        .order_by('created_at', 'id')[:limit]   # 一次拿一批
    )
    ids = [r.id for r in recipients]
    if ids:
        EmailTaskRecipient.objects.filter(id__in=ids).update(status='sending')
```

返回给 Agent 的每个条目带 `idempotency_key = f'email-recipient-{id}'` 和内容摘要 `payload_hash`，Agent 端靠这两个字段做本地去重，网络重试时不会把同一封发两遍。

另一个场景在云端：AI 意向分析的 worker，多个进程消费同一个待处理池。这里行锁要换成 `SKIP LOCKED`：几个 worker 同时执行同一条查询，被别人锁住的行自动跳过，各自领到不重叠的任务，谁也不等谁：

```python
with transaction.atomic():
    summary = (
        EmailAISummary.objects.select_for_update(skip_locked=True)
        .filter(is_active=True, intent_status='pending')
        .order_by('updated_at', 'id')
        .first()
    )
    if summary is None:
        return {'processed': 0}          # 队列空了，正常退出
    summary.intent_status = 'processing'
    summary.save(update_fields=['intent_status', 'updated_at'])
# 事务外面才做慢操作（调 LLM），做完回写终态
```

这里踩过一个坑：领取的事务必须短。事务里只做"占坑"这一个动作，慢操作放在事务外。事务拖得越长，锁就持得越久，worker 一多就互相卡。

## 卡住的任务怎么办

worker 拉走了任务，进程崩了，任务就永远悬在中间态。得有人收：

```python
def reclaim_stale(*, stale_minutes=10) -> int:
    """卡在 processing 超过 10 分钟的任务，重新排队。"""
    cutoff = timezone.now() - timedelta(minutes=stale_minutes)
    return EmailAISummary.objects.filter(
        intent_status='processing', updated_at__lt=cutoff,
    ).update(intent_status='pending', intent_error='处理超时，已重新排队')
```

每次 worker 开始轮询前先跑一遍回收，再领新任务。失败要计数，三次之后置为 `failed` 交给人。重试不设上限的队列，故障的时候就是放大器。

## 回传会来两次

Agent 发完邮件回传结果，网络一重试，同一封的结果就来了两次。处理原则是以数据库的状态为准：已经终态（`sent` 或 `send_failed`）的，结果一致就当没发生，返回幂等成功；结果对不上，返回 409，宁可让运维看一眼也不悄悄覆盖。

```python
with transaction.atomic():
    recipient = EmailTaskRecipient.objects.select_for_update().get(id=pk)

    if recipient.status in ('sent', 'send_failed'):
        if same_result(success, smtp_message_id, error_message):
            return Response({'status': 'ok', 'deduplicated': True})
        raise ConflictError(f'already finalized as {recipient.status}')

    if recipient.status != 'sending':
        raise ValidationError('only sending items can report result')

    # 唯一合法路径：sending → sent / send_failed
```

整个状态机用显式的转移表约束（`queued → sending → sent | send_failed`），不符合转移的更新直接抛错。靠约定不行，得靠校验。

## 拉走的邮件，不自动回收

本地 Agent 拉走邮件后电脑死机了呢？上面的超时回收对 AI 分析任务会自动重排，但对 `sending` 状态的邮件，我们什么都不做。不重排，不超时，等 Agent 恢复后回传；悬太久就转人工核对。

这不是偷懒。AI 分析重跑一次没有副作用，多跑几遍结果一样。SMTP 发送不行，邮件发出去就没有任何协议能撤回。自动重排意味着客户收到两封一模一样的营销邮件——这比一封邮件晚到半天严重得多。

所以领取侧用行锁保证一封邮件只会被一个 Agent 拿走，这一侧的幂等是可靠的；执行侧宁可保守，卡住交给人。队列惯常的"至少一次执行"和邮件场景要的"至多一次发送"是拧着的，光靠更聪明的重试策略解不开，只能把决定权收回来。

配套的是 Agent 心跳：每台 Agent 按间隔（默认 60 秒）上报，云端用 `max(间隔×3, 间隔+180秒)` 判定离线。运营界面能看到哪台 Agent 掉了线、哪些邮件悬在 `sending`——真要人工介入的时候，信息是全的。

## Celery 没有被换掉

得说清楚：Celery 还在这个项目里，AI 草稿生成、意向分析的链式触发都在上面跑。这类任务可重跑、没有对外副作用、不需要逐条人工干预，Celery 够用也好用。

真正的分界线是任务的性质。有副作用的、要逐条看得见的、要能随时撤的，放进数据库，让每次状态转移都留痕；可重跑的批处理，留在 Celery，没必要为了"纯净"自研。

## 这么做的边界

最后是这套做法的适用范围，不然它就成万金油了。

量级是第一道坎。每秒几千上万任务、亚秒延迟，数据库行锁的开销会先到天花板，该上 RabbitMQ / Redis Streams 就上。我们的是"万封邮件分批、分钟级完成"，PostgreSQL 毫无压力。`SKIP LOCKED` 靠频繁短事务竞争，worker 十几台以内很好，成百上千时连接数先撑不住。另外如果业务数据和队列注定在不同存储里，"队列即表"的一致性就没了意义；执行侧真幂等的任务，用消息队列的 at-least-once 反而省心。

回到开头那个约束：邮件要从客户本机发出，队列的消费端必须长在数据库够得着的地方。上线之后这套路子跑了很久没出过事故，偶尔翻起 `sending` 悬挂的记录，运营按心跳和 PayPal 侧的信息也能自己判断。对一个要长期跑在客户服务器上的系统，这种"谁都能看懂、出事能兜住"的朴素，比什么都值钱。
