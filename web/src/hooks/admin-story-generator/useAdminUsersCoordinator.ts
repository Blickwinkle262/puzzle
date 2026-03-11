import { useCallback } from "react";

import { apiApproveAdminUserPasswordReset, apiGrantAdminUserRole, apiListAdminUsers, apiRevokeAdminUserRole } from "../../core/adminApi";
import { AdminManagedRole, AdminUserSummary } from "../../core/types";
import { errorMessage } from "../../components/admin-story-generator/utils";

type UseAdminUsersCoordinatorOptions = {
  userKeyword: string;
  setAdminUsers: (users: AdminUserSummary[]) => void;
  setLoadingUsers: (loading: boolean) => void;
  setPasswordResetSubmittingUserId: (userId: string) => void;
  setRoleSubmittingKey: (key: string) => void;
  setPanelError: (message: string) => void;
  setPanelInfo: (message: string) => void;
};

export function useAdminUsersCoordinator({
  userKeyword,
  setAdminUsers,
  setLoadingUsers,
  setPasswordResetSubmittingUserId,
  setRoleSubmittingKey,
  setPanelError,
  setPanelInfo,
}: UseAdminUsersCoordinatorOptions) {
  const loadAdminUsers = useCallback(async (): Promise<void> => {
    setLoadingUsers(true);

    try {
      const response = await apiListAdminUsers({
        keyword: userKeyword.trim() || undefined,
        limit: 120,
      });
      setAdminUsers(response.users || []);
    } catch (err) {
      setPanelError(errorMessage(err));
    } finally {
      setLoadingUsers(false);
    }
  }, [setAdminUsers, setLoadingUsers, setPanelError, userKeyword]);

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
