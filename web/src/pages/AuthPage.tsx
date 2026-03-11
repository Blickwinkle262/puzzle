import { FormEvent } from "react";

type AuthMode = "login" | "register";

type AuthPageProps = {
  authMode: AuthMode;
  error: string;
  forgotUsernameInput: string;
  info: string;
  passwordInput: string;
  resetPasswordInput: string;
  usernameInput: string;
  onForgotPassword: () => void;
  onForgotUsernameInputChange: (value: string) => void;
  onGuestLogin: () => void;
  onPasswordInputChange: (value: string) => void;
  onResetPasswordInputChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onToggleAuthMode: () => void;
  onUsernameInputChange: (value: string) => void;
};

export function AuthPage({
  authMode,
  error,
  forgotUsernameInput,
  info,
  passwordInput,
  resetPasswordInput,
  usernameInput,
  onForgotPassword,
  onForgotUsernameInputChange,
  onGuestLogin,
  onPasswordInputChange,
  onResetPasswordInputChange,
  onSubmit,
  onToggleAuthMode,
  onUsernameInputChange,
}: AuthPageProps): JSX.Element {
  return (
    <div className="auth-shell">
      <div className="auth-stack">
        <form className="auth-card" onSubmit={onSubmit}>
          <h1>拼图故事</h1>
          <p>登录后可保存关卡进度与故事线完成状态</p>

          <label className="form-field">
            用户名
            <input
              value={usernameInput}
              onChange={(event) => onUsernameInputChange(event.currentTarget.value)}
              placeholder="至少 3 个字符"
              autoComplete="username"
            />
          </label>

          <label className="form-field">
            密码
            <input
              type="password"
              value={passwordInput}
              onChange={(event) => onPasswordInputChange(event.currentTarget.value)}
              placeholder="至少 6 位"
              autoComplete={authMode === "login" ? "current-password" : "new-password"}
            />
          </label>

          {error && <div className="form-error">{error}</div>}
          {info && <div className="form-info">{info}</div>}

          <button className="primary-btn" type="submit">
            {authMode === "login" ? "登录" : "注册并登录"}
          </button>

          <button type="button" className="link-btn" onClick={onToggleAuthMode}>
            {authMode === "login" ? "没有账号？去注册" : "已有账号？去登录"}
          </button>

          <button type="button" className="nav-btn" onClick={onGuestLogin}>
            游客试玩（可稍后升级账号）
          </button>
        </form>

        <section className="auth-card auth-subcard">
          <h2>忘记密码</h2>
          <p>输入用户名和新密码，提交管理员审批。</p>

          <label className="form-field">
            用户名
            <input
              value={forgotUsernameInput}
              onChange={(event) => onForgotUsernameInputChange(event.currentTarget.value)}
              placeholder="要找回的用户名"
              autoComplete="username"
            />
          </label>

          <label className="form-field">
            新密码
            <input
              type="password"
              value={resetPasswordInput}
              onChange={(event) => onResetPasswordInputChange(event.currentTarget.value)}
              placeholder="至少 6 位"
              autoComplete="new-password"
            />
          </label>

          <div className="inline-actions">
            <button type="button" className="primary-btn" onClick={onForgotPassword}>
              提交改密申请
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
