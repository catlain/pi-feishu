/**
 * WS 连接健康观测 — diag 快照（5 分钟节流常驻）与 watchdog 参数可见性
 *
 * T4 转正：30s 诊断期临时代码收敛为常驻观测。判断逻辑不在本模块
 * （判活见 ws-keeper：SDK 快照优先 + 旧 SDK 水位回退），这里只做观测。
 */

import type { WSClient } from "@larksuiteoapi/node-sdk";

/** liveness watchdog 超时（秒）：须 > 服务端 pingInterval（默认 120s）+余量，倒挂会静默期周期性误杀 */
export const WS_PING_TIMEOUT_S = 240;

/** diag 快照节流周期（T4.1：诊断期 30s 临时值转正常 5 分钟节奏） */
const DIAG_INTERVAL_MS = 300_000;

/** 快照采样状态（WsKeeper 内部状态的只读投影） */
export interface DiagState {
	terminal: boolean;
	lastFrameAt: number;
	lastOutboundAt: number | null;
	startCount: number;
	ws: WSClient | null;
}

/** 读服务端下发的 pingInterval（秒）；wsConfig 不可达（旧 SDK）返回 null。
 * T4.3：SDK 无 pong 钩子，从 wsConfig 读取（毫秒→秒；初始默认 120s，
 * 收到服务端配置帧后 updateWs 更新）。 */
export function readServerPingIntervalS(ws: unknown): number | null {
	const wsConfig = (ws as { wsConfig?: { getWS?: () => { pingInterval?: number } } })?.wsConfig;
	const ms = wsConfig?.getWS?.()?.pingInterval;
	return typeof ms === "number" && ms > 0 ? Math.round(ms / 1000) : null;
}

/** 健康快照输出器：连接状态/水位/start 次数/watchdog 参数（节流 + 参数倒挂 warn） */
export class DiagReporter {
	private lastAt = 0;

	constructor(private readonly log: (m: string) => void) {}

	snapshot(state: DiagState, now: number = Date.now()): void {
		if (now - this.lastAt < DIAG_INTERVAL_MS) return;
		this.lastAt = now;
		const status = (state.ws as { getConnectionStatus?: () => { state?: string } })
			?.getConnectionStatus?.();
		const pingIntervalS = readServerPingIntervalS(state.ws);
		this.log(
			`[diag] 健康快照: sdkState=${status?.state ?? "?"} terminal=${state.terminal} 距上次入帧=${Math.round((now - state.lastFrameAt) / 1000)}s 距上次出站=${state.lastOutboundAt ? Math.round((now - state.lastOutboundAt) / 1000) : "-"}s start次数=${state.startCount} pingTimeout=${WS_PING_TIMEOUT_S}s 服务端pingInterval=${pingIntervalS ?? "?"}s`,
		);
		if (pingIntervalS !== null && pingIntervalS >= WS_PING_TIMEOUT_S) {
			this.log(
				`⚠️ 服务端 pingInterval=${pingIntervalS}s ≥ watchdog pingTimeout=${WS_PING_TIMEOUT_S}s（参数倒挂）：静默期会被周期性误杀，请上调 pingTimeout`,
			);
		}
	}
}
