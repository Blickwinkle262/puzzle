import { useCallback, useState } from "react";

import { UserProfile } from "../core/types";

export type Screen = "auth" | "stories" | "story" | "play";
export type AuthMode = "login" | "register";

export function useAuthSession() {
  const [screen, setScreen] = useState<Screen>("auth");
  const [hasSession, setHasSession] = useState(false);
  const [userName, setUserName] = useState<string>("");
  const [loadingText, setLoadingText] = useState<string>("正在恢复登录状态...");
  const [error, setError] = useState<string>("");
  const [info, setInfo] = useState<string>("");
  const [isGuest, setIsGuest] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [showAdminGenerator, setShowAdminGenerator] = useState(false);

  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [usernameInput, setUsernameInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [forgotUsernameInput, setForgotUsernameInput] = useState("");
  const [resetTokenInput, setResetTokenInput] = useState("");
  const [resetPasswordInput, setResetPasswordInput] = useState("");
  const [showGuestUpgrade, setShowGuestUpgrade] = useState(false);
  const [upgradeUsernameInput, setUpgradeUsernameInput] = useState("");
  const [upgradePasswordInput, setUpgradePasswordInput] = useState("");
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [currentPasswordInput, setCurrentPasswordInput] = useState("");
  const [nextPasswordInput, setNextPasswordInput] = useState("");

  const applyAuthUser = useCallback((user: UserProfile) => {
    setHasSession(true);
    setUserName(user.username);
    setIsGuest(Boolean(user.is_guest));
    setIsAdmin(Boolean(user.is_admin));
    if (!user.is_admin) {
      setShowAdminGenerator(false);
    }
  }, []);

  const clearAccountPanels = useCallback(() => {
    setShowGuestUpgrade(false);
    setShowChangePassword(false);
    setUpgradeUsernameInput("");
    setUpgradePasswordInput("");
    setCurrentPasswordInput("");
    setNextPasswordInput("");
  }, []);

  return {
    applyAuthUser,
    authMode,
    clearAccountPanels,
    currentPasswordInput,
    error,
    forgotUsernameInput,
    hasSession,
    info,
    isAdmin,
    isGuest,
    loadingText,
    nextPasswordInput,
    passwordInput,
    resetPasswordInput,
    resetTokenInput,
    screen,
    setAuthMode,
    setCurrentPasswordInput,
    setError,
    setForgotUsernameInput,
    setHasSession,
    setInfo,
    setIsAdmin,
    setIsGuest,
    setLoadingText,
    setNextPasswordInput,
    setPasswordInput,
    setResetPasswordInput,
    setResetTokenInput,
    setScreen,
    setShowAdminGenerator,
    setShowChangePassword,
    setShowGuestUpgrade,
    setUpgradePasswordInput,
    setUpgradeUsernameInput,
    setUserName,
    setUsernameInput,
    showAdminGenerator,
    showChangePassword,
    showGuestUpgrade,
    upgradePasswordInput,
    upgradeUsernameInput,
    userName,
    usernameInput,
  };
}
