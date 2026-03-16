import { useCallback } from "react";

import { apiApproveAdminUserPasswordReset, apiGrantAdminUserRole, apiListAdminUsers, apiRevokeAdminUserRole } from "../../core/adminApi";
import { AdminManagedRole, AdminUserSummary } from "../../core/types";
import { errorMessage } from "../../components/admin-story-generator/utils";

type UseAdminUsersCoordinatorOptions = {
  userKeyword: string;
  userPage: number;
  userPageSize: number;
  userRoleFilter: AdminManagedRole | "";
  setAdminUsers: (users: AdminUserSummary[]) => void;
  setLoadingUsers: (loading: boolean) => void;
  setPasswordResetSubmittingUserId: (userId: string) => void;
  setRoleSubmittingKey: (key: string) => void;
  setUserSummary: (summary: {
    total_users: number;
    guest_users: number;
    admin_users: number;
    pending_reset_users: number;
  }) => void;
  setUserTotal: (total: number) => void;
  setPanelError: (message: string) => void;
  setPanelInfo: (message: string) => void;
};

export function useAdminUsersCoordinator({
  userKeyword,
  userPage,
  userPageSize,
  userRoleFilter,
  setAdminUsers,
  setLoadingUsers,
  setPasswordResetSubmittingUserId,
  setRoleSubmittingKey,
  setUserSummary,
  setUserTotal,
  setPanelError,
  setPanelInfo,
}: UseAdminUsersCoordinatorOptions) {
  const userOffset = Math.max(0, (Math.max(1, Math.floor(userPage || 1)) - 1) * Math.max(1, Math.floor(userPageSize || 10)));

  const loadAdminUsers = useCallback(async (): Promise<void> => {
    setLoadingUsers(true);

    try {
      const response = await apiListAdminUsers({
        keyword: userKeyword.trim() || undefined,
        role: userRoleFilter || undefined,
        limit: userPageSize,
        page: userPage,
        offset: userOffset,
      });
      setAdminUsers(response.users || []);
      setUserTotal(Number(response.total || 0));
      const summary = response.summary;
      setUserSummary({
        total_users: Number(summary?.total_users || 0),
        guest_users: Number(summary?.guest_users || 0),
        admin_users: Number(summary?.admin_users || 0),
        pending_reset_users: Number(summary?.pending_reset_users || 0),
      });
    } catch (err) {
      setPanelError(errorMessage(err));
    } finally {
      setLoadingUsers(false);
    }
  }, [
    setAdminUsers,
    setLoadingUsers,
    setPanelError,
    setUserSummary,
    setUserTotal,
    userKeyword,
    userOffset,
    userPage,
    userPageSize,
    userRoleFilter,
  ]);

  const handleRoleToggle = useCallback(async (targetUser: AdminUserSummary, role: AdminManagedRole): Promise<void> => {
    const hasRole = targetUser.roles.includes(role);
    const actionKey = `${targetUser.id}:${role}:${hasRole ? "revoke" : "grant"}`;

    setRoleSubmittingKey(actionKey);
    setPanelError("");
    setPanelInfo("");

    try {
      if (hasRole) {
        await apiRevokeAdminUserRole(targetUser.id, role);
        setPanelInfo(`已移除 ${targetUser.username} 的 ${role} 角色`);
      } else {
        await apiGrantAdminUserRole(targetUser.id, role, "granted via admin panel");
        setPanelInfo(`已授予 ${targetUser.username} 的 ${role} 角色`);
      }
      await loadAdminUsers();
    } catch (err) {
      setPanelError(errorMessage(err));
    } finally {
      setRoleSubmittingKey("");
    }
  }, [
    loadAdminUsers,
    setPanelError,
    setPanelInfo,
    setRoleSubmittingKey,
  ]);

  const handleApprovePasswordReset = useCallback(async (targetUser: AdminUserSummary): Promise<void> => {
    const actionUserId = String(targetUser.id);

    setPasswordResetSubmittingUserId(actionUserId);
    setPanelError("");
    setPanelInfo("");

    try {
      await apiApproveAdminUserPasswordReset(targetUser.id, "approved via admin panel");
      setPanelInfo(`已审批 ${targetUser.username} 的密码重置申请`);
      await loadAdminUsers();
    } catch (err) {
      setPanelError(errorMessage(err));
    } finally {
      setPasswordResetSubmittingUserId("");
    }
  }, [
    loadAdminUsers,
    setPanelError,
    setPanelInfo,
    setPasswordResetSubmittingUserId,
  ]);

  return {
    handleApprovePasswordReset,
    handleRoleToggle,
    loadAdminUsers,
  };
}
