import { test } from "node:test";
import assert from "node:assert/strict";

import { MACHINE_SALT, SESSION_SALT, deriveId, sessionKey, uuidHex } from "../engine/fingerprint.mjs";

const UUID4_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/;

test("deriveId 与 python hashlib 逐字节一致（固定向量）", () => {
  // 以下向量用 python hashlib.md5 对同一公式算出并钉死：
  //   md5(f"{salt}:{uid or 'anonymous'}")，h[12]='4'，h[16]='a'，8-4-4-4-12
  assert.equal(deriveId("u-12345678", "machine"), "9185f149-a07f-403b-a180-be192c013525");
  assert.equal(deriveId("u-12345678", "session"), "b5aa6d73-6865-4624-aff8-21dce3dc2b1c");
  assert.equal(deriveId("acct-B", "machine"), "1c04acbd-f5ef-414e-a4a7-62339e64d502");
  assert.equal(deriveId("acct-B", "session"), "2e4941db-916e-4e2f-a8d2-994a00c22cf3");
  // 空 uid → 'anonymous'（wb_fingerprint: uid or 'anonymous'）
  assert.equal(deriveId("", "machine"), "fc1f3f60-3c8b-4dc0-a839-42ea0169ab1e");
  assert.equal(deriveId(undefined, "machine"), "fc1f3f60-3c8b-4dc0-a839-42ea0169ab1e");
});

test("deriveId 输出恒为 UUIDv4 形状（版本位 4、变体位 a）", () => {
  for (const uid of ["", "u-12345678", "acct-B", "someone-with-long-id"]) {
    for (const salt of ["machine", "session"]) {
      assert.match(deriveId(uid, salt), UUID4_SHAPE, `${uid}/${salt}`);
    }
  }
});

test("同一账号幂等；machine ≠ session；不同账号互不相同", () => {
  assert.equal(deriveId("u-12345678", "machine"), deriveId("u-12345678", "machine"));
  assert.notEqual(deriveId("u-12345678", "machine"), deriveId("u-12345678", "session"));
  assert.notEqual(deriveId("u-12345678", "machine"), deriveId("acct-B", "machine"));
  // sessionKey 即 session 盐的快捷方式
  assert.equal(sessionKey("u-12345678"), deriveId("u-12345678", SESSION_SALT));
  assert.equal(MACHINE_SALT, "machine");
});

test("uuidHex 是 32 位无连字符 hex 且随机", () => {
  const a = uuidHex();
  const b = uuidHex();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.equal(a, a.toLowerCase());
  assert.notEqual(a, b);
});
