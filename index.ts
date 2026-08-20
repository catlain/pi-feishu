/**
 * pi-feishu — 飞书桥扩展（薄入口）
 *
 * 出站播报：follow 会话的 agent_end 回复推群，ask-user 挂起提醒
 * 入站遥控：群里 @bot <会话名> <指令> 注入对应会话（steer / triggerTurn 分流）
 */

import { createFeishuExtension } from "./lib/extension";

export default createFeishuExtension;
