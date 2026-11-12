-- P5-1 W1 停机回填：把原先藏在 authority JSON 里的 revision 提到 Save.revision 独立列。
-- 执行时机：migrate deploy 之后、应用重新上线之前，只跑一次。
-- 口径：原值照搬，**不重编号、不 +1**；authority 为 NULL / 非 JSON / 缺 revision /
-- revision 非数字 → 0。新库为空库时本语句影响 0 行，属正常。
-- 用 regexp_match 而不是 (authority::jsonb->>'revision')::int：坏 JSON 直接 cast 会让
-- 整条回填事务报错停机；正则取不到就给 0，保证迁移对脏数据也能一次跑完。
-- WHERE "revision" = 0 保证幂等：重跑不会把已回填的非 0 值改回 0。
UPDATE "Save"
SET "revision" = COALESCE(
  (regexp_match(COALESCE("authority", ''), '"revision"\s*:\s*([0-9]+)'))[1]::integer,
  0
)
WHERE "revision" = 0;
