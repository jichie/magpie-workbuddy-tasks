// tests/accountio-fixture.mjs —— 账号导入/导出测试共用工具。
// 9 条目 plugin-auth.json 同构 fixture：键名与用户 NAS 真实文件逐字一致
// （workbuddy、workbuddy#3592pb、workbuddy-ai、workbuddy-ai#75352q、workbuddy-ai#ztdceq、
//   qoder、qoder-cn、qwenwork、qwenwork#ed8f2r），**值全部假造**——绝不复制真实凭据。

const b64urlJson = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

export const CN_ISS = "https://www.workbuddy.cn/oauth";
export const INTL_ISS = "https://www.workbuddy.ai/oauth";

// 三段式假 JWT（本插件与 hub 一样只解 payload，不验签名）
export function makeJwt({ sub, iss = CN_ISS, expSec = 0 }) {
  return `${b64urlJson({ alg: "HS256", typ: "JWT" })}.${b64urlJson({
    sub,
    iss,
    exp: expSec,
    iat: Math.floor(expSec / 1000) || 1700000000,
  })}.${"s".repeat(27)}`;
}

const DAY_MS = 86400000;

// 与真实文件同构的 9 条目（全部假数据）。expires 为毫秒（magpie 官方口径）。
export function nineEntryAuth({ nowMs }) {
  const futureMs = nowMs + 30 * DAY_MS; // 全部未过期
  const oauth = (uid, accountId, domain, accessIss) => ({
    type: "oauth",
    access: makeJwt({ sub: uid, iss: accessIss, expSec: Math.floor(futureMs / 1000) }),
    refresh: `rt-${uid}`,
    expires: futureMs,
    accountId,
    uid,
    domain,
    refreshExpiresAt: futureMs + 90 * DAY_MS,
    tokenType: "Bearer",
  });
  return {
    "workbuddy-ai": oauth("intl-uid-a", "GlobalA", "www.workbuddy.ai", INTL_ISS),
    workbuddy: oauth("cn-uid-a", "阿猫", "copilot.tencent.com", CN_ISS),
    "workbuddy#3592pb": oauth("cn-uid-b", "阿狗", "workbuddy.cn", CN_ISS),
    "workbuddy-ai#75352q": oauth("intl-uid-b", "GlobalB", "www.workbuddy.ai", INTL_ISS),
    "workbuddy-ai#ztdceq": oauth("intl-uid-c", "GlobalC", "www.workbuddy.ai", INTL_ISS),
    // 非 workbuddy 系：带未知字段，验证导入绝不碰它们（逐字节保留）
    qoder: { type: "oauth", access: "qoder-access", refresh: "qoder-refresh", expires: futureMs, accountId: "Q", uid: "q-1", extraNote: "别动我", labels: ["x"] },
    "qoder-cn": { type: "oauth", access: "qodercn-access", refresh: "qodercn-refresh", expires: futureMs, accountId: "QC", uid: "q-2" },
    qwenwork: { type: "oauth", access: "qw-access", refresh: "qw-refresh", expires: futureMs, accountId: "QW", uid: "qw-1", nested: { keep: true } },
    "qwenwork#ed8f2r": { type: "oauth", access: "qw2-access", refresh: "qw2-refresh", expires: futureMs, accountId: "QW2", uid: "qw-2" },
  };
}

// 供导入文档用的国内版行（hub 导出行字段名）
export function cnRow({ uid, nickname = "导入号", expSec, refresh = `rt-${uid}`, domain = "copilot.tencent.com" }) {
  return {
    uid,
    nickname,
    domain,
    realm: "cn",
    platform: "CLI",
    product: "workbuddy",
    enterpriseId: "",
    accessToken: makeJwt({ sub: uid, iss: CN_ISS, expSec }),
    refreshToken: refresh,
    expiresAt: expSec, // hub 单位：秒
    source: "import",
    apiKey: false,
    enabled: true,
    tasksEnabled: true,
  };
}
