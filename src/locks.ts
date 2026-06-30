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
  // 新操作挂到队列尾
  // 保留原始 promise 返回给调用方，让调用方能感知错误
  // 链上 catch 防止锁队列断裂（一个操作失败不阻塞后续操作）
  const current = prev.then(fn);
  const next = current.catch(() => {}); // 静默吞掉，让队列继续走
  editQueues.set(remotePath, next);
  return current; // 返回原始 promise，让调用方 await 到真实的 resolve/reject
}

/** 清理某个路径的锁（可选，用于测试或紧急解锁） */
export function clearLock(remotePath: string): void {
  editQueues.delete(remotePath);
}
