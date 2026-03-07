import { useState } from "react";

import { AdminUserSummary } from "../../core/types";

export function useAdminUserPermissionState() {
  const [adminUsers, setAdminUsers] = useState<AdminUserSummary[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [userKeyword, setUserKeyword] = useState("");
  const [roleSubmittingKey, setRoleSubmittingKey] = useState("");

  return {
    adminUsers,
    loadingUsers,
    roleSubmittingKey,
    setAdminUsers,
    setLoadingUsers,
    setRoleSubmittingKey,
    setUserKeyword,
    userKeyword,
  };
}
