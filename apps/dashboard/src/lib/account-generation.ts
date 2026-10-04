/**
 * Which account this browser is on, as every tab sees it (astra 19f, 19g).
 *
 * The API key and the gateway's SIWE cookie belong to the browser, not to a
 * tab, and so does the account generation: a token that moves with every
 * login and logout. It lives in the key's own record (lib/authorized-fetch.ts,
 * DECISIONS 05:04), written in the same write as the key, so no tab can see
 * the next key without its generation, or one without the other (astra 19g,
 * 19l). A SIWE sign-in carries the generation it began under, and it is
 * refused once the generation has moved (lib/wallet-session.ts).
 *
 * A second slot records the last generation for which a teardown confirmed
 * that the previous wallet session ended. Until the two agree, a teardown is
 * pending for the whole browser: no request carries a key, and a page that
 * loads then finishes it before it mounts anything (App.tsx). Only a teardown
 * holding the wallet-session lock writes that record, and only for the
 * generation it saw. A later change leaves the two different, so no tab can
 * mark another tab's change finished.
 *
 * Both live in the key's owner, which reads the record; this module names
 * them for the wallet session and App.
 */
export { accountGeneration, confirmWalletSessionEnded, walletSessionEnding } from "./authorized-fetch.js";
