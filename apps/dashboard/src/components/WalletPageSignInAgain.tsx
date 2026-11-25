import { ConnectWallet, SignInAgainButton } from "./ConnectWallet.js";
import { useAuth } from "../hooks/use-auth.js";
import { useAuthStore } from "../stores/auth-store.js";

export function WalletPageSignInAgain({ attempted, pagePending, failedBeforeMint, signIn }: {
  attempted: boolean;
  pagePending: boolean;
  failedBeforeMint: boolean;
  signIn: (login: () => Promise<void>) => Promise<void>;
}) {
  const { address, isConnected, error, authNotice, isVerifying, login } = useAuth();
  const guardedLogin = () => signIn(login);
  return (
    <div className="space-y-3">
      {!isConnected || !address ? (
        <>
          <p>Connect your wallet to sign in again.</p>
          <ConnectWallet showNotice={false} />
        </>
      ) : <SignInAgainButton login={guardedLogin} isVerifying={pagePending || isVerifying} />}
      {attempted && error !== null && <p role="alert">{error}</p>}
      {attempted && !pagePending && !failedBeforeMint && authNotice !== null && !useAuthStore.getState().isAuthenticated && <p role="status">{authNotice}</p>}
    </div>
  );
}

