import { useState } from "react";

import { AdminUserSummary } from "../../core/types";

export function useAdminUserPermissionState() {
  const [adminUsers, setAdminUsers] = useState<AdminUserSummary[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [userKeyword, setUserKeyword] = useState("");
  const [roleSubmittingKey, setRoleSubmittingKey] = useState("");
  const [passwordResetSubmittingUserId, setPasswordResetSubmittingUserId] = useState("");

  return {
    adminUsers,
    loadingUsers,
    passwordResetSubmittingUserId,
    roleSubmittingKey,
    setAdminUsers,
    setLoadingUsers,
    setPasswordResetSubmittingUserId,
    setRoleSubmittingKey,
    setUserKeyword,
    userKeyword,
  };
}
