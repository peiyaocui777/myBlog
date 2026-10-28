---
title: '客户付了钱，系统却不知道'
description: '订单停在 pending，钱在 PayPal 账户里躺着，系统没收到回调、权限也没开通。回调当通知用、对账任务兜底、查询失败不臆断，记录这套支付链路的修法。'
pubDate: 2026-10-26
tags: ['PayPal', '支付', 'Java', '对账']
---

接手这条支付链路的时候，它已经能跑通主流程：创建订单、跳转 PayPal、付款、回调、开通权限。难受的问题藏在边上：偶尔有订单永远停在 pending。

用户那边的体验是这样的：在 PayPal 付了款，回到我们的系统，权限没开。找客服，客服在后台看到一条 pending 的记录，钱呢？去 PayPal 商户后台一查，确实到账了。钱付了，系统不知道。

这种单子不多，但每一单都意味着一个付了钱拿不到东西的客户。这就是"订单滞留"。

## 根子：把回调当成了账本

最初的实现是事件驱动的：权限开通完全依赖 `PAYMENT.CAPTURE.COMPLETED` 这个 webhook。回调到了，落权；回调没到，什么都不发生。

问题在于 webhook 的送达语义是"至少一次、尽力而为"，不是"恰好一次"：

- 会**丢**。网络抖动、服务重启的窗口、PayPal 那边的抖动，任何一环都能让一条回调消失。
- 会**重**。PayPal 收不到 200 会重试，重试周期长达 72 小时，同一次支付的事件可能到达两次。
- 会**乱**。订阅类事件和扣款类事件的先后没有保证。

把状态机的推进完全押在这样一条通道上，丢一条消息就滞留一单。回调只能当"尽快通知"用，账本必须另有出处。后面所有修改，都是从这句话出发的。

![收款闭环的两道防线](/diagrams/paypal-two-lanes.svg)

## 第一道：把回调管道本身做扎实

回调该做的还是要做，而且要做对。分发器现在长这样：

```java
public void dispatch(String rawBody, String transmissionId, ...) {
    // 1. 验签：PayPal-Transmission-* 头 + 原始请求体，防伪造回调
    boolean valid = paypalClient.verifyWebhookSignature(
            transmissionId, transmissionTime, certUrl, authAlgo, transmissionSig, rawBody);
    if (!valid) throw new TWTException("Webhook 签名验证失败");

    // 2. 幂等去重：eventId 进 Redis，7 天窗口盖住 PayPal 的 72 小时重试
    String dedupKey = "vc:paypal:event:" + eventId;
    if (Boolean.TRUE.equals(RedisUtils.hasKey(dedupKey))) {
        webhookLogService.log(eventId, eventType, "ignored", "duplicate event");
        return;
    }

    // 3. 按事件类型路由到对应 Handler
    PaypalEventHandler handler = handlerRegistry.get(eventType);
    ...
}
```

几个细节值得记一下。去重窗口是 7 天，不是随手写的：PayPal 的重试周期最长 72 小时，窗口要盖住它再留余量。验签用 PayPal 的 Transmission 头加原始请求体，不能验解析后的 JSON，中间任何一步重新序列化都可能改变内容。还有一类容易漏的：不支持的事件类型也要标记已处理并返回 200，不然 PayPal 会为一条你根本不关心的事件重试 72 小时。

事件按类型路由到各自的 handler：扣款完成、扣款拒绝、订阅激活、订阅扣款成功、订阅扣款失败、订阅取消。每个 handler 只管自己那一种状态转移，谁也不碰别人的状态。

## 第二道：对账任务，账本以 PayPal 为准

管道再扎实，丢消息的概率也只能降低，不能归零。所以有了对账任务：每 15 分钟扫一遍超过 15 分钟还是 pending 的记录，逐条去 PayPal 的 Orders API 问真实状态。

```java
return switch (paypalStatus) {
    case "COMPLETED" -> {
        // Webhook 漏发：重放 CaptureCompletedHandler 的落权逻辑，自动补权
        switch (captureCompletedHandler.recoverFromOrderDetails(orderId, orderDetails)) {
            case RECOVERED -> log.warn("[Reconcile] Webhook 漏发，已自动补权：orderId={}", orderId);
            case ALREADY_SETTLED -> payRecordMapper.updateStatus(transactionId, "failed",
                    "RECONCILE_DUPLICATE: capture 已由其他流水结算，本记录为重复 pending");
            case NOT_APPLICABLE -> payRecordMapper.updateStatus(transactionId, "failed",
                    "RECONCILE_WEBHOOK_MISSED: 请运营核查");
        }
        yield "completed";
    }
    case "VOIDED", "EXPIRED" -> {
        payRecordMapper.updateStatus(transactionId, "failed", "RECONCILE_ORDER_" + paypalStatus);
        yield "voided";
    }
    case "APPROVED", "PAYER_ACTION_REQUIRED", "CREATED" -> {
        yield "waiting";   // 用户还没付，继续等
    }
    default -> yield "error";
};
```

<div class="callout warn">
<span class="callout-t">一条纪律</span>
查询失败不臆断结果。PayPal 的接口调不通，这一轮就跳过，等下一轮，绝不能"查不到就当没付"。把已付款的会话标成未付款，比一单晚开通十几分钟严重得多。宁可慢，不可错。
</div>

另外两处设计。补权不另写一套逻辑，直接重放 `CaptureCompletedHandler` 的落权路径：同一份代码，webhook 到了走它，对账补权也走它，两条路径的行为不会分叉。写入用 CAS（`UPDATE ... WHERE status='pending'`，影响行数为零就当已被处理），多实例同时跑这个任务也不会互相踩。

`ALREADY_SETTLED` 这个分支也是真实场景教的：webhook 其实到了、另一条流水已经结算，这条 pending 只是残留的重复记录。收口标失败，防止它每 15 分钟被扫出来一次。

## 顺手把会话也收了口

支付还有一种滞留：用户点进付款页，没付，关掉走人。这类会话不收口，运营后台的 pending 会越积越多。同一个对账任务里加了会话收口：过期未付的会话，先问一次 PayPal 真实状态（同样的原则，查不到不臆断），确实没付的按"未付款超时"归类落库。机构端的倒计时和预检是实时的，这个任务只是把状态落下来，给运营看真实的失败归类。

## 修完之后

滞留单从"偶发、要人工对账"变成了三种自动去向：webhook 正常到达的即时开通；漏发的，最迟十几分钟由对账补权；真没付的，自动归类收口。运营那边只剩 `WEBHOOK_MISSED` 标记的极少数记录需要人工看一眼。

再回头看这套结构，其实就干了两件事：webhook 管体验，对账管正确性，落权逻辑两边共用一份。回调只能当通知用，钱的真话要主动去问。这个学费，一单滞留的订单就交够了。
