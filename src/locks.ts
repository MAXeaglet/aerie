/**
 * 文件级并发锁（队列锁模式）
 * 每个 remotePath 一把队列，相同路径的 edit 排队执行，不同路径的 edit 并行
 */
const editQueues = new Map<string, Promise<void>>();

export async function withEditLock(
  remotePath: string,
  fn: () => Promise<void>
): Promise<void> {
  // 等待当前队列尾
  const prev = editQueues.get(remotePath) ?? Promise.resolve();
  // 新操作挂到队列尾，即使失败也要 catch 防止死锁
  const next = prev.then(fn).catch(() => {});
  editQueues.set(remotePath, next);
  // 不 await next 在这里 — 由调用方 await
  return next;
}

/** 清理某个路径的锁（可选，用于测试或紧急解锁） */
export function clearLock(remotePath: string): void {
  editQueues.delete(remotePath);
}
