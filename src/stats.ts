// 全局调用计数器，供 warpgate_deps_check 和启动日志使用
let callsTotal = 0;
let callsFailed = 0;
const startTime = Date.now();

export function createStats() {
  callsTotal = 0;
  callsFailed = 0;
  return {
    incCalls: () => { callsTotal++; },
    incFailed: () => { callsFailed++; },
    getStats: () => ({ callsTotal, callsFailed, startTime }),
    getStartTime: () => startTime,
  };
}

export type Stats = ReturnType<typeof createStats>;
