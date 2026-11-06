// 管理员身份（P1-1b）。
// 唯一来源是服务端 /api/auth/me 下发的 isAdmin（由后端白名单 / User.role 判定）。
// 客户端即使用 DevTools 改这个值为 true 也只是让测试菜单显示出来，
// 真正能不能写入异常数值仍由后端风控裁决，伪造无效。
import { useEffect, useState } from "react";
import { api } from "./api";

/** 当前登录账号是否管理员；请求失败（含被封号 403）一律按非管理员处理。 */
export function useIsAdmin(): boolean {
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .me()
      .then((u) => {
        if (alive) setIsAdmin(u?.isAdmin === true);
      })
      .catch(() => {
        if (alive) setIsAdmin(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  return isAdmin;
}
