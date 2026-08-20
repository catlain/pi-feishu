/**
 * stdio 隔离 — SDK logger 注入 + stdout/stderr noop 兜底（防 EPIPE）
 *
 * 网关 detached 启动后父进程管道即死，任何 console 写入都会 EPIPE uncaught。
 * - SDK 日志通过构造参数 logger 注入到文件流（createSdkLogger）
 * - 其他三方库的 console 写入由 noopStdio 兜底吞掉
 */

export interface SdkLogger {
	debug: (msg: string) => void;
	info: (msg: string) => void;
	warn: (msg: string) => void;
	error: (msg: string) => void;
}

/** 构造注入 WSClient 的 logger：SDK 全部日志 → logStream 文件流 */
export function createSdkLogger(
	write: (line: string) => void,
): SdkLogger {
	const emit = (level: string, msg: string): void =>
		write(`[${new Date().toISOString()}] [sdk:${level}] ${String(msg)}`);
	return {
		debug: (m) => emit("debug", m),
		info: (m) => emit("info", m),
		warn: (m) => emit("warn", m),
		error: (m) => emit("error", m),
	};
}

/** stdout/stderr write noop 兜底（console.* 全部吞掉，日志只走文件流） */
export function noopStdio(): void {
	const noop = () => {};
	for (const stream of [process.stdout, process.stderr]) {
		if (stream && typeof stream.write === "function") {
			try {
				stream.write = noop as typeof stream.write;
			} catch {
				// write 只读（罕见）则放弃，EPIPE 由 uncaughtException 记录兜底
			}
		}
	}
}
