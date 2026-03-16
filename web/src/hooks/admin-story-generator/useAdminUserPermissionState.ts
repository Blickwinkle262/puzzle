import { useState } from "react";

import { AdminManagedRole, AdminUsersResponse, AdminUserSummary } from "../../core/types";

const EMPTY_USER_SUMMARY: AdminUsersResponse["summary"] = {
  total_users: 0,
  guest_users: 0,
  admin_users: 0,
  pending_reset_users: 0,
};

export function useAdminUserPermissionState() {
  const [adminUsers, setAdminUsers] = useState<AdminUserSummary[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [userKeyword, setUserKeyword] = useState("");
  const [userRoleFilter, setUserRoleFilter] = useState<AdminManagedRole | "">("");
  const [userPage, setUserPage] = useState(1);
  const [userPageSize, setUserPageSize] = useState(10);
  const [userTotal, setUserTotal] = useState(0);
  const [userSummary, setUserSummary] = useState<AdminUsersResponse["summary"]>(EMPTY_USER_SUMMARY);
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
    setUserPage,
    setUserPageSize,
    setRoleSubmittingKey,
    setUserRoleFilter,
    setUserSummary,
    setUserTotal,
    setUserKeyword,
    userPage,
    userPageSize,
    userRoleFilter,
    userSummary,
    userTotal,
    userKeyword,
  };
}
